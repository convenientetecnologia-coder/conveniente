'use strict';

// ATENÇÃO: NÃO existe mais polling inbound. Consuma SSE via notifierInboundSSE.js (novo script) para receber respostas externas.

const fs = require('fs');
const path = require('path');
const logger = require('./logger.js');
const stepLog = require('./stepLog.js');
const audit = stepLog.audit;

const DEFAULT_BACKOFFS = [5000, 15000, 30000, 60000, 120000, 300000, 600000]; // 5s,15s,30s,1m,2m,5m,10m
const workers = new Map(); // perfil -> { running: boolean, options, intervalId }

function sha1(str) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(str), 'utf8').digest('hex');
}

function outboxDirFor(perfil) {
  return path.join(__dirname, '..', 'dados', 'perfis', String(perfil), 'outbox');
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function moveToDeadletter(perfil, file) {
  try {
    const dir = path.join(outboxDirFor(perfil), 'dead');
    ensureDir(dir);
    const base = path.basename(file);
    const dest = path.join(dir, base);
    fs.renameSync(file, dest);
    return dest;
  } catch { return null; }
}

function isDeterministicConfigError(respText) {
  return /VIRTUS_SHEET_RANGE/i.test(String(respText || '')) || /Unable to parse range/i.test(String(respText || ''));
}

function jobIdFor(kind, payload) {
  // idempotência forte por chat e payload
  const base = `${kind}-${payload.chat_id || payload.chatId || 'na'}`;
  const h = sha1(JSON.stringify(payload));
  return `${base}-${h}`;
}

function jobFile(perfil, id) {
  return path.join(outboxDirFor(perfil), `${id}.json`);
}

function writeAtomicFsync(file, obj) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  const json = JSON.stringify(obj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, json, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  // fsync do diretório para garantir persistência do rename
  try {
    const dirfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); }
  } catch {}
}

// function writeAtomic(file, obj) {
//   const dir = path.dirname(file);
//   ensureDir(dir);
//   const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
//   fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
//   fs.renameSync(tmp, file);
// }

function readJsonSafe(file, fb = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}

function listJobs(perfil) {
  const dir = outboxDirFor(perfil);
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    return files.map(f => path.join(dir, f));
  } catch { return []; }
}

async function httpPostJson(url, body) {
  audit('GLOBAL', 'virtus', 'debug', 'outbox_http_post', { url, bodyBytes: JSON.stringify(body).length });
  const fetch = global.fetch || require('node-fetch');
  const resp = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify(body)
  });
  const text = await resp.text().catch(()=> '');
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: resp.ok, status: resp.status, data, text };
}

async function processOne(perfil, opts, file) {
  const now = Date.now();
  const job = readJsonSafe(file, null);
  if (!job || typeof job !== 'object') { try { fs.unlinkSync(file); } catch {}; return; }

  const attempts = Number(job.attempts || 0);
  const nextAt  = Number(job.nextAttemptAt || 0);
  if (now < nextAt) return;
  
  audit(perfil, 'virtus', 'info', 'outbox_proc_start', { file, kind: job.kind, attempts });

  // monta request
  const base = opts && opts.url ? String(opts.url) : '';
  const servidor = opts && opts.servidor ? String(opts.servidor) : '';
  const fullBody = Object.assign({}, job.payload, { servidor, perfil });

  let endpoint = null;
  if (job.kind === 'pedido') endpoint = '/api/virtus/pedido';
  else if (job.kind === 'chat') endpoint = '/api/virtus/chat';
  else endpoint = '/api/virtus/chat';

  try {
    const { ok, status, data, text } = await httpPostJson(base + endpoint, fullBody);
    if (ok && data && data.ok === true) {
      // ACK: remove job, callbacks
      if (typeof opts.onJobOk === 'function') {
        try { await opts.onJobOk(perfil, job); } catch {}
      }
      try { fs.unlinkSync(file); } catch {}
      audit(perfil, 'virtus', 'info', 'outbox_proc_ok', { id: job.id, kind: job.kind, attempts });
      return;
    }
    // Falha HTTP
    const backoff = DEFAULT_BACKOFFS[Math.min(attempts, DEFAULT_BACKOFFS.length - 1)];
    const nextAttemptAt = Date.now() + backoff;
    const upd = Object.assign({}, job, { attempts: attempts + 1, nextAttemptAt, lastStatus: status, lastResp: (data && JSON.stringify(data).slice(0,300)) || String(text||'').slice(0,300) });
    const MAX_ATTEMPTS = 5;
    if (isDeterministicConfigError(text) || (attempts + 1) >= MAX_ATTEMPTS) {
      // move to dead-letter e abre issue
      const deadPath = moveToDeadletter(perfil, file);
      audit(perfil, 'virtus', 'error', 'outbox_proc_deadletter', { id: job.id, kind: job.kind, attempts: attempts+1, deadPath });
      try {
        const issues = require('./issues.js');
        if (issues && typeof issues.append === 'function') {
          await issues.append(perfil, 'notifier_config_error', `Outbox movida para dead-letter. Provável range inválido: ${text && text.slice(0,200)}`);
        }
      } catch {}
      return;
    }
    writeAtomicFsync(file, upd);
    audit(perfil, 'virtus', 'warn', 'outbox_proc_retry', { id: job.id, kind: job.kind, attempts: attempts+1, nextAttemptAtISO: new Date(nextAttemptAt).toISOString() });
  } catch (e) {
    const backoff = DEFAULT_BACKOFFS[Math.min(attempts, DEFAULT_BACKOFFS.length - 1)];
    const nextAttemptAt = Date.now() + backoff;
    const upd = Object.assign({}, job, { attempts: attempts + 1, nextAttemptAt, lastError: (e && e.message) || String(e) });
    // Mesmo escalonamento para dead-letter se passar do máximo de tentativas
    const MAX_ATTEMPTS = 5;
    if ((attempts + 1) >= MAX_ATTEMPTS) {
      const deadPath = moveToDeadletter(perfil, file);
      audit(perfil, 'virtus', 'error', 'outbox_proc_deadletter', { id: job.id, kind: job.kind, attempts: attempts+1, deadPath });
      try {
        const issues = require('./issues.js');
        if (issues && typeof issues.append === 'function') {
          await issues.append(perfil, 'notifier_config_error', `Outbox movida para dead-letter após erro persistente (${attempts+1} tentativas). Último erro: ${(e && e.message) || String(e)}`);
        }
      } catch {}
      return;
    }
    writeAtomicFsync(file, upd);
    audit(perfil, 'virtus', 'error', 'outbox_proc_error', { id: job && job.id, kind: job && job.kind, attempts: attempts+1, error: (e && e.message) || String(e) });
  }
}

function ensureWorker(perfil, options) {
  if (workers.has(perfil)) return;
  const opts = Object.assign({}, options || {});

  audit(perfil, 'virtus', 'info', 'outbox_worker_start', { tick: 2000 });

  const tick = async () => {
    try {
      const files = listJobs(perfil).sort((a, b) => {
        try {
          const sa = fs.statSync(a).mtimeMs, sb = fs.statSync(b).mtimeMs;
          return sa - sb;
        } catch { return 0; }
      });
      audit(perfil, 'virtus', 'debug', 'outbox_worker_tick', { jobs: files.length });
      for (const f of files) {
        await processOne(perfil, opts, f);
      }
    } catch {}
  };

  const intervalId = setInterval(tick, 2000);
  workers.set(perfil, { running: true, options: opts, intervalId });
}

function enqueue(perfil, kind, payload) {
  const id = jobIdFor(kind, payload);
  const file = jobFile(perfil, id);
  const exists = fs.existsSync(file);
  if (exists) {
    audit(perfil, 'virtus', 'info', 'outbox_enqueue', { kind, id, status: 'exists' });
    return { ok: true, id, status: 'exists' };
  }
  const job = {
    id,
    kind,
    payload,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now()
  };
  writeAtomicFsync(file, job);
  audit(perfil, 'virtus', 'info', 'outbox_enqueue', { kind, id, status: 'queued' });
  return { ok: true, id, status: 'queued' };
}

function enqueuePedido(perfil, payload) {
  // payload precisa conter [chat_id, whatsapp, item, endereco_saida, endereco_destino]
  return enqueue(perfil, 'pedido', payload);
}

function enqueueChat(perfil, payload) {
  // payload: { chat_id, historico, localizacao, tipo_servico, timestamp, ... }
  return enqueue(perfil, 'chat', payload);
}

function stopWorker(perfil) {
  const worker = workers.get(perfil);
  if (worker) {
    worker.running = false;
    if (worker.intervalId) { try { clearInterval(worker.intervalId); } catch {} }
    workers.delete(perfil);
    audit(perfil, 'virtus', 'info', 'outbox_worker_stop', {});
  }
}

module.exports = { ensureWorker, enqueuePedido, enqueueChat, stopWorker };
