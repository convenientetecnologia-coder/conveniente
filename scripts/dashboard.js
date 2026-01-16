"use strict";

// scripts/dashboard.js

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger.js');
const fotos = require('./fotos.js'); // ADICIONADO

const httpPort = parseInt(process.env.PORT || '8088', 10);
const INTERVAL_MS = parseInt(process.env.DASHBOARD_INTERVAL_MS || '30000', 10); // 30s recomendado
const STATUS_PATH = path.join(__dirname, '..', 'dados', 'status.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');

// Endpoint fixo do notificador na nuvem via ngrok
function resolveEndpoints() {
  return [
    'https://c0nv3n13nt3t3cn0l0g14jesus.sa.ngrok.io/report'
  ];
}

let timer = null;
let inFlight = false;
let lastWarnAt = 0;

// ===== ALTERAÇÃO INÍCIO: adicionado hostIdCache ===========
let hostIdCache = null;
// ===== ALTERAÇÃO FIM =====================================

function now() { return Date.now(); }
function debounceWarn(msg, ms = 60000) {
  const t = now();
  if ((t - lastWarnAt) >= ms) {
    lastWarnAt = t;
    logger.warn('[DASHBOARD] ' + msg);
  }
}

function ensureDirSync(p) {
  try { fsSync.mkdirSync(p, { recursive: true }); } catch {}
}

function randId() {
  try { return require('crypto').randomUUID(); }
  catch {
    const b = require('crypto').randomBytes(16);
    return [...b].map(x => x.toString(16).padStart(2,'0')).join('');
  }
}

async function getOrCreateHostId() {
  try {
    if (fsSync.existsSync(HOSTID_PATH)) {
      const v = fsSync.readFileSync(HOSTID_PATH, 'utf8').trim();
      if (v) return v;
    }
  } catch {}
  try {
    ensureDirSync(path.dirname(HOSTID_PATH));
    const id = randId();
    fsSync.writeFileSync(HOSTID_PATH, id, 'utf8');
    return id;
  } catch {
    return randId();
  }
}

// Função utilitária de fetch com timeout (NOVO)
function timeoutFetch(url, { timeoutMs = 3000, ...opt } = {}) {
  const ac = new (global.AbortController || require('node-abort-controller'))();
  const id = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  return fetch(url, { ...opt, signal: ac.signal }).finally(() => clearTimeout(id));
}

// Nova função: vê API, fallback para arquivos locais - PATCH CIRÚRGICO!
async function readAggregatedStatus() {
  // NOVO: HTTP local COM TIMEOUT aumentado para 15s (multi-node precisa de mais tempo)
  try {
    const res = await timeoutFetch(`http://127.0.0.1:${httpPort}/api/status`, { timeoutMs: 15000 });
    if (res && res.ok) {
      const st = await res.json();
      if (st && typeof st === 'object') return st;
    }
  } catch {
    logger && logger.warn && logger.warn('[DASH][TICK] api/status timeout (15s), using fallback');
  }
  // (2) Local status.json
  try {
    const raw = await fs.readFile(STATUS_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch {}
  // (3) Fallback: agrega todos os status_node_*.json
  try {
    const dir = path.join(__dirname, '..', 'dados');
    const files = fsSync.readdirSync(dir).filter(n => /^status_node_\d+.json$/i.test(n));
    const basePerfisArr = (() => {
      try { return JSON.parse(fsSync.readFileSync(path.join(dir, 'perfis.json'), 'utf8')) || []; }
      catch { return []; }
    })();
    const baseMap = new Map(basePerfisArr.map(p => [p.nome, {
      nome: p.nome,
      label: p.label || null,
      cidade: p.cidade,
      uaPresetId: p.uaPresetId,
      active: false, trabalhando: false, configurando: false, humanControl: false, issuesCount: 0,
      ramMB: null, cpuPercent: null, numPages: null, robeEstado: null, robeCooldownSec: null,
      robeFrozenUntil: null, frozenReason: null, frozenAt: null, frozenSetBy: null,
      activationHeldUntil: null, reopenAt: null, openBackoffMs: null, lastSwapAt: null, lastSwapPeer: null,
      swapCooldown: null, whyNotOpen: null, manifestStatus: null, closingReason: null
    }]));
    let combinedRobes = {};
    let combinedQueue = [];
    let sysPick = null;
    for (const f of files) {
      try {
        const j = JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || typeof j !== 'object') continue;
        const perf = Array.isArray(j.perfis) ? j.perfis : [];
        for (const o of perf) {
          const dst = baseMap.get(o && o.nome);
          if (!dst) continue;
          const ramBefore = dst.ramMB;
          const cpuBefore = dst.cpuPercent;
          Object.assign(dst, o);
          // Se o overlay atual não trouxe número, mantenha o valor numérico já presente
          if (typeof o.ramMB !== 'number' && typeof ramBefore === 'number') dst.ramMB = ramBefore;
          if (typeof o.cpuPercent !== 'number' && typeof cpuBefore === 'number') dst.cpuPercent = cpuBefore;
        }
        if (j.robes && typeof j.robes === 'object') {
          combinedRobes = Object.assign(combinedRobes, j.robes);
        }
        if (Array.isArray(j.robeQueue)) {
          combinedQueue.push(...j.robeQueue);
        }
        if (!sysPick && j.sys) sysPick = j.sys;
      } catch {}
    }
    if (combinedQueue.length) {
      const seen = new Set();
      combinedQueue = combinedQueue.filter(n => {
        if (!n || seen.has(n)) return false;
        seen.add(n); return true;
      });
    }
    return {
      perfis: Array.from(baseMap.values()),
      robes: combinedRobes,
      robeQueue: combinedQueue,
      sys: sysPick || {
        freeMB: Math.round(os.freemem()/(1024*1024)),
        totalMB: Math.round(os.totalmem()/(1024*1024)),
        cores: (os.cpus()||[]).length
      },
      ts: Date.now()
    };
  } catch (e) {
    return { perfis: [], robes: {}, robeQueue: [], ts: Date.now(), error: 'sem snapshot' };
  }
}

// Helper para verificar se é imagem
function isImage(name) { return /\.(jpe?g|png)$/i.test(String(name||'')); }

function buildQuickSnapshot(status) {
  const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
  const perfisCount = perfis.length;
  const activeCount = perfis.filter(p => p && p.active).length;
  const workingCount = perfis.filter(p => p && p.trabalhando).length;
  const sys = (status && status.sys) ? status.sys : {
    freeMB: Math.round(os.freemem() / (1024*1024)),
    totalMB: Math.round(os.totalmem() / (1024*1024)),
    cores: (os.cpus() || []).length
  };
  const risk = {
    memLow: typeof sys.freeMB === 'number' ? (sys.freeMB < 512) : false,
    cpuHigh: typeof sys.cpuApprox === 'number' ? (sys.cpuApprox >= 90) : false
  };

  // Identidade humana (hostname, username, operador customizável)
  const username = (os.userInfo && os.userInfo().username) || process.env.USER || process.env.USERNAME || 'user';
  const computerName = process.env.COMPUTERNAME || os.hostname();
  const displayName = process.env.OPERATOR_NAME || '';
  const avatarUrl = process.env.OPERATOR_AVATAR || '';
  const humanId = `${username}@${computerName}`;

  // NOVO: fotosCount — leitura do diretório de fotos
  let fotosCount = 0;
  try {
    const dir = fotos.resolveFotosDir();
    const list = fsSync.readdirSync(dir, { withFileTypes: true });
    fotosCount = list.filter(ent => ent.isFile() && isImage(ent.name)).length;
  } catch {}

  return {
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: os.uptime()
    },
    human: {
      username,
      computerName,
      humanId,
      displayName,
      avatarUrl
    },
    perfisCount,
    activeCount,
    workingCount,
    sys,
    risk,
    ts: now(),
    fotosCount // NOVO CAMPO
  };
}

async function postPayload(url, payload) {
  let bodyStr;
  let body = null;
  try {
    bodyStr = JSON.stringify(payload);
  } catch (e) {
    throw new Error('payload_stringify_failed: ' + (e && e.message || e));
  }

  // Nunca gzip!
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const bodyBuf = Buffer.from(bodyStr, 'utf8');

  const Aborter = global.AbortController || require('node-abort-controller');
  const ac = new Aborter();
  const timeoutMs = parseInt(process.env.DASHBOARD_TIMEOUT_MS || '8000', 10);
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyBuf,
      signal: ac.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}: ${txt}`);
      err.status = resp.status;
      err.text = txt;
      throw err;
    }
    try { body = await resp.json(); } catch { body = { ok: true }; }
    if (process.env.DASHBOARD_DEBUG === '1') {
      logger.info('[DASHBOARD] enviado com sucesso para ' + url);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function tryAllEndpoints(payload) {
  const endpoints = resolveEndpoints();
  let lastErr = null;
  for (const u of endpoints) {
    try {
      const body = await postPayload(u, payload);
      return body || { ok:true };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return { ok:false };
}

// === Helpers/execução de comandos remotos (inserido acima de tick()) ===
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function httpJson(path, { method='GET', body=null, headers=null, rawBody=null } = {}) {
  const hasBody = !(rawBody == null) || !(body == null);
  const h = Object.assign({}, (headers && typeof headers === 'object') ? headers : {});
  const sendBody = (rawBody != null) ? rawBody : (body != null ? JSON.stringify(body) : null);
  if (hasBody && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
    method,
    headers: Object.keys(h).length ? h : undefined,
    body: sendBody
  });
  return res.json();
}
async function ensureFreeMB(minMB = 3072) {
  while (true) {
    try {
      const m = await httpJson('/api/sys');
      const free = (m && m.mem && m.mem.freeMB) || 0;
      const cpu  = (m && m.cpu && typeof m.cpu.percent === 'number') ? m.cpu.percent : 0;
      if (free >= minMB && (cpu === 0 || cpu <= 90)) return;
    } catch {}
    await sleep(1200);
  }
}
async function execCloseAll() {
  try {
    const st = await httpJson('/api/status');
    const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    for (const p of perfis) {
      try { await httpJson(`/api/perfis/${encodeURIComponent(p.nome)}/deactivate`, { method:'POST' }); } catch {}
    }
  } catch {}
}
// ===== INÍCIO ALTERAÇÃO =====
async function execOpenAll24h() {
  try {
    // Agora chamamos o handler canônico do backend
    await httpJson('/api/perfis/open-all-24h', { method: 'POST' });
  } catch (e) {
    // silencioso — o ACK/erro já será refletido no notificador
  }
}
// ===== FIM ALTERAÇÃO =====
async function execRobePauseAll() {
  try { await httpJson('/api/robes/pause-24h-all', { method:'POST' }); } catch {}
}
async function execRobeReleaseAll() {
  try { await httpJson('/api/robes/release-all', { method:'POST' }); } catch {}
}

function migrationsLogAppend(obj) {
  try {
    const p = path.join(__dirname, '..', 'dados', 'migrations.jsonl');
    fsSync.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
  } catch {}
}

async function execMigrateProfiles(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const batchId = String(payload.batchId || '').trim();
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (!batchId) throw new Error('missing_batchId');
  if (!actions.length) throw new Error('missing_actions');

  // Idempotência: não repetir um batch já aplicado automaticamente
  const appliedPath = path.join(__dirname, '..', 'dados', `.migrations_applied_${batchId}`);
  if (fsSync.existsSync(appliedPath)) {
    migrationsLogAppend({ event: 'migrate_skip_already_applied', batchId, cmdId: cmd && cmd.id });
    return;
  }

  // Snapshot atual para validar fromCity exato
  let st = null;
  try { st = await httpJson('/api/status'); } catch {}
  const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
  const byName = new Map(perfis.map(p => [String(p && p.nome || '').trim(), p]));

  const results = [];
  for (const a of actions) {
    const nome = String(a && a.nome || '').trim();
    const fromCity = String(a && a.fromCity || '').trim();
    const toCity = String(a && a.toCity || '').trim();
    if (!nome || !fromCity || !toCity) {
      results.push({ nome, ok: false, error: 'missing_fields' });
      continue;
    }
    const cur = byName.get(nome) || null;
    const curCity = cur ? String(cur.cidade || '') : '';
    if (!cur || !curCity) {
      results.push({ nome, ok: false, error: 'profile_not_found' });
      continue;
    }
    if (curCity !== fromCity) {
      results.push({ nome, ok: false, error: 'from_mismatch', curCity, fromCity });
      migrationsLogAppend({ event: 'migrate_action_skip', batchId, nome, error: 'from_mismatch', curCity, fromCity });
      continue;
    }
    try {
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/cidade`, {
        method: 'PATCH',
        headers: { 'x-operator': 'contas-facebook-auto' },
        body: { novaCidade: toCity }
      });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'api_failed');
      results.push({ nome, ok: true, fromCity, toCity });
      migrationsLogAppend({ event: 'migrate_action_ok', batchId, nome, fromCity, toCity });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      results.push({ nome, ok: false, error: msg, fromCity, toCity });
      migrationsLogAppend({ event: 'migrate_action_fail', batchId, nome, fromCity, toCity, error: msg });
    }
  }

  try { fsSync.writeFileSync(appliedPath, `${Date.now()}\n`, 'utf8'); } catch {}

  const okCount = results.filter(r => r && r.ok).length;
  const failCount = results.length - okCount;
  migrationsLogAppend({ event: 'migrate_batch_done', batchId, cmdId: cmd && cmd.id, okCount, failCount });

  if (failCount > 0) throw new Error(`partial_fail ok=${okCount} fail=${failCount}`);
}

// ===== ALTERAÇÃO INÍCIO: add notifierBaseFromEndpoints e ackCommand =====
function notifierBaseFromEndpoints() {
  try {
    const u = resolveEndpoints()[0] || '';
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
}
async function ackCommand(cmdId, ok, errorMsg) {
  try {
    const base = notifierBaseFromEndpoints();
    if (!base || !hostIdCache || !cmdId) return;
    const controller = new (global.AbortController || require('node-abort-controller'))();
    const t = setTimeout(() => { try { controller.abort(); } catch {} }, 3000);
    await fetch(`${base}/api/commands/ack`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ hostId: hostIdCache, id: cmdId, ok: !!ok, error: errorMsg ? String(errorMsg) : null }),
      signal: controller.signal
    }).catch(()=>{});
    clearTimeout(t);
  } catch {}
}
// ===== ALTERAÇÃO FIM ===============================================

// ===== Logs sob demanda (fetch_logs) =====
function logsSecret() {
  return String(process.env.LOG_INGEST_SECRET || '').trim();
}
function logsAllowlist() {
  const base = path.join(__dirname, '..', 'dados');
  return {
    logger: path.join(base, 'logger.log'),
    issues_fallback: path.join(base, 'issues_fallback.log'),
    migrations: path.join(base, 'migrations.jsonl'),
    updates: path.join(base, 'updates.jsonl')
  };
}
function tailFileLines(filePath, maxLines = 2000, maxBytes = 1200_000) {
  try {
    if (!fsSync.existsSync(filePath)) return { ok:false, error:'not_found', filePath };
    const st = fsSync.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    const readBytes = Math.min(maxBytes, size);
    const start = Math.max(0, size - readBytes);
    const buf = Buffer.alloc(readBytes);
    const fd = fsSync.openSync(filePath, 'r');
    try { fsSync.readSync(fd, buf, 0, readBytes, start); }
    finally { try { fsSync.closeSync(fd); } catch {} }
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - maxLines));
    const truncated = (start > 0) || (lines.length > maxLines);
    return { ok:true, filePath, bytes: readBytes, lines: tail.length, truncated, text: tail.join('\n') };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e), filePath };
  }
}
async function postLogsToNotifier({ requestId, items }) {
  const base = notifierBaseFromEndpoints();
  if (!base) throw new Error('notifier_base_unavailable');
  if (!hostIdCache) throw new Error('hostId_unavailable');
  const sec = logsSecret();
  const controller = new (global.AbortController || require('node-abort-controller'))();
  const t = setTimeout(() => { try { controller.abort(); } catch {} }, 8000);
  try {
    await fetch(`${base}/api/logs/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sec ? { 'X-Log-Secret': sec } : {})
      },
      body: JSON.stringify({
        hostId: hostIdCache,
        hostname: (os && os.hostname) ? os.hostname() : '',
        requestId,
        sentAt: Date.now(),
        items
      }),
      signal: controller.signal
    }).catch(()=>{});
  } finally {
    clearTimeout(t);
  }
}
async function execFetchLogs(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const keys = Array.isArray(payload.keys) ? payload.keys.map(x => String(x||'').trim()).filter(Boolean) : [];
  const tailLines = Math.max(50, Math.min(8000, Number(payload.tailLines || 1200) || 1200));
  if (!requestId) throw new Error('missing_requestId');
  if (!keys.length) throw new Error('missing_keys');
  const allow = logsAllowlist();
  const items = [];
  for (const key of keys.slice(0, 8)) {
    const fp = allow[key];
    if (!fp) { items.push({ key, ok:false, error:'not_allowed' }); continue; }
    const r = tailFileLines(fp, tailLines);
    items.push({ key, ...r });
  }
  await postLogsToNotifier({ requestId, items });
}

// ===== Update massivo (self_update = git pull) =====
function updateLogAppend(obj) {
  try {
    const p = path.join(__dirname, '..', 'dados', 'updates.jsonl');
    fsSync.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
  } catch {}
}
async function runGit(args, { cwd } = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    execFile('git', args, { cwd: cwd || path.join(__dirname, '..') }, (err, stdout, stderr) => {
      if (err) return resolve({ ok:false, error: (err && err.message) || String(err), stdout: String(stdout||''), stderr: String(stderr||'') });
      return resolve({ ok:true, stdout: String(stdout||''), stderr: String(stderr||'') });
    });
  });
}
async function execSelfUpdate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim() || (cmd && cmd.id) || 'noid';
  const branch = String(payload.branch || 'main').trim() || 'main';
  const repoDir = path.join(__dirname, '..');

  updateLogAppend({ event: 'self_update_start', requestId, branch });
  const steps = [];
  steps.push({ step: 'rev-parse', ...(await runGit(['rev-parse','--is-inside-work-tree'], { cwd: repoDir })) });
  steps.push({ step: 'fetch', ...(await runGit(['fetch','--all','--prune'], { cwd: repoDir })) });
  steps.push({ step: 'status_before', ...(await runGit(['status','--porcelain'], { cwd: repoDir })) });
  steps.push({ step: 'pull', ...(await runGit(['pull','--ff-only','origin',branch], { cwd: repoDir })) });
  steps.push({ step: 'rev', ...(await runGit(['rev-parse','HEAD'], { cwd: repoDir })) });

  const ok = steps.every(s => s && s.ok);
  updateLogAppend({ event: 'self_update_done', requestId, branch, ok, steps: steps.map(s => ({ step: s.step, ok: s.ok, error: s.error || null })) });
  if (!ok) {
    const err = steps.find(s => !s.ok);
    throw new Error(`self_update_failed:${(err && err.step) || 'unknown'}:${(err && err.error) || 'error'}`);
  }
}

// ===== ALTERAÇÃO INÍCIO: applyCommands para ACK após cada execução =====
async function applyCommands(cmds = []) {
  for (const c of cmds) {
    try {
      if (!c || !c.type) continue;
      if (c.type === 'close_all')             { await execCloseAll(); }
      else if (c.type === 'open_all_24h')     { await execOpenAll24h(); }
      else if (c.type === 'robes_pause_24h_all')  { await execRobePauseAll(); }
      else if (c.type === 'robes_release_all')    { await execRobeReleaseAll(); }
      else if (c.type === 'migrate_profiles') { await execMigrateProfiles(c); }
      else if (c.type === 'fetch_logs')       { await execFetchLogs(c); }
      else if (c.type === 'self_update')      { await execSelfUpdate(c); }
      logger.info('[DASH][CMD] executado: ' + c.type);
      // ACK de sucesso
      try { await ackCommand(c.id, true, null); } catch {}
    } catch (e) {
      logger.warn('[DASH][CMD] falha ao executar ' + (c && c.type), { error: e && e.message || e });
      // ACK de erro
      try { await ackCommand(c && c.id, false, (e && e.message) || String(e)); } catch {}
    }
  }
}
// ===== ALTERAÇÃO FIM ===============================================

async function tick() {
  if (process.env.DASHBOARD_DEBUG === '1') {
    logger.info('[DASH][TICK] start: ' + new Date().toISOString());
  }
  const start = Date.now();

  if (inFlight) return; // anti-overlap
  inFlight = true;
  try {
    // ===== ALTERAÇÃO: obter [status, hostId] e atualizar hostIdCache =====
    const [status, hostId] = await Promise.all([readAggregatedStatus(), getOrCreateHostId()]);
    hostIdCache = hostId;
    // ===== FIM ======
    if (process.env.DASHBOARD_DEBUG === '1') {
      logger.info(`[DASH][TICK] got status in ${Date.now() - start}ms`);
    }

    const quick = buildQuickSnapshot(status);

    const payload = {
      hostname: quick.system.hostname,
      hostId,
      sentAt: now(),
      host: {
        // RAM total do servidor (para capacidade no notificador)
        totalMemGB: (quick && quick.system && typeof quick.system.totalMB === 'number')
          ? Math.max(1, Math.round(quick.system.totalMB / 1024))
          : Math.max(1, Math.round(os.totalmem() / (1024 * 1024 * 1024)))
      },
      status: {
        ...status,
        _dashboard: quick
      }
    };

    const resp = await tryAllEndpoints(payload);
    if (resp && Array.isArray(resp.commands) && resp.commands.length) {
      await applyCommands(resp.commands);
    }
    if (process.env.DASHBOARD_DEBUG === '1') {
      logger.info(`[DASH][TICK] post finish in ${Date.now() - start}ms`);
    }

  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    debounceWarn('Falha ao enviar status: ' + m);
  } finally {
    inFlight = false;
  }
}

function startDashboardMonitor() {
  if (timer) return;
  tick().catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);

  const stop = () => { try { clearInterval(timer); } catch {} timer = null; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
}

module.exports = { startDashboardMonitor };