'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BACKOFFS = [5000, 15000, 30000, 60000, 120000, 300000, 600000]; // 5s,15s,30s,1m,2m,5m,10m
const workers = new Map(); // perfil -> { running: boolean, options }

function sha1(str) {
  const crypto = require('crypto');
  return crypto.createHash('sha1').update(String(str), 'utf8').digest('hex');
}

function outboxDirFor(perfil) {
  return path.join(__dirname, '..', 'dados', 'perfis', String(perfil), 'outbox');
}

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function jobIdFor(kind, payload) {
  // idempotência forte por chat e payload
  const base = `${kind}-${payload.chat_id || payload.chatId || 'na'}`;
  const h = sha1(JSON.stringify(payload));
  return `${base}-${h}`;
}

function jobFile(perfil, id) {
  return path.join(outboxDirFor(perfil), `${id}.json`);
}

function writeAtomic(file, obj) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

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
      if (opts.logger && opts.logger.info) {
        opts.logger.info('[NOTIFIER_QUEUE] ok', { perfil, kind: job.kind, id: job.id, attempts });
      }
      if (opts.stepLog) {
        try {
          opts.stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_ok', kind: job.kind, id: job.id, attempts, ts: Date.now() });
        } catch {}
      }
      return;
    }
    // Falha HTTP
    const backoff = DEFAULT_BACKOFFS[Math.min(attempts, DEFAULT_BACKOFFS.length - 1)];
    const nextAttemptAt = Date.now() + backoff;
    const upd = Object.assign({}, job, { attempts: attempts + 1, nextAttemptAt, lastStatus: status, lastResp: (data && JSON.stringify(data).slice(0,300)) || String(text||'').slice(0,300) });
    writeAtomic(file, upd);
    if (opts.logger && opts.logger.error) {
      opts.logger.error('[NOTIFIER_QUEUE] http_fail', { perfil, kind: job.kind, id: job.id, status, attempts: upd.attempts });
    }
    if (opts.stepLog) {
      try {
        opts.stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_fail', kind: job.kind, id: job.id, status, attempts: upd.attempts, ts: Date.now() });
      } catch {}
    }
  } catch (e) {
    const backoff = DEFAULT_BACKOFFS[Math.min(attempts, DEFAULT_BACKOFFS.length - 1)];
    const nextAttemptAt = Date.now() + backoff;
    const upd = Object.assign({}, job, { attempts: attempts + 1, nextAttemptAt, lastError: (e && e.message) || String(e) });
    writeAtomic(file, upd);
    if (opts.logger && opts.logger.error) {
      opts.logger.error('[NOTIFIER_QUEUE] net_fail', { perfil, kind: job.kind, id: job.id, attempts: upd.attempts, error: (e && e.message) || e });
    }
    if (opts.stepLog) {
      try {
        opts.stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_fail', kind: job.kind, id: job.id, attempts: upd.attempts, error: (e && e.message)||String(e), ts: Date.now() });
      } catch {}
    }
  }
}

function ensureWorker(perfil, options) {
  if (workers.has(perfil)) return;
  const opts = Object.assign({}, options || {});
  workers.set(perfil, { running: true, options: opts });

  const tick = async () => {
    try {
      const files = listJobs(perfil).sort((a, b) => {
        try {
          const sa = fs.statSync(a).mtimeMs, sb = fs.statSync(b).mtimeMs;
          return sa - sb;
        } catch { return 0; }
      });
      for (const f of files) {
        await processOne(perfil, opts, f);
      }
    } catch {}
  };

  setInterval(tick, 2000);
}

function enqueue(perfil, kind, payload) {
  const id = jobIdFor(kind, payload);
  const file = jobFile(perfil, id);
  if (fs.existsSync(file)) return { ok: true, id, status: 'exists' };
  const job = {
    id,
    kind,
    payload,
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: Date.now()
  };
  writeAtomic(file, job);
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

module.exports = { ensureWorker, enqueuePedido, enqueueChat };
