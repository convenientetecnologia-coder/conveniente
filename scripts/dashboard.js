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

// Endpoint do notificador (centralizado)
const { resolveEndpoints } = require('./notifierEndpoints');

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
  // NÃO engolir erro: se o servidor estiver desatualizado (sem endpoint canônico),
  // o ACK precisa refletir falha para o notificador mostrar claramente.
  const r = await httpJson('/api/perfis/close-all', { method: 'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'close_all_failed');
}
// ===== INÍCIO ALTERAÇÃO =====
async function execOpenAll24h() {
  const r = await httpJson('/api/perfis/open-all-24h', { method: 'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'open_all_24h_failed');
}
// ===== FIM ALTERAÇÃO =====
async function execRobePauseAll() {
  const r = await httpJson('/api/robes/pause-24h-all', { method:'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'robes_pause_24h_all_failed');
}
async function execRobeReleaseAll() {
  const r = await httpJson('/api/robes/release-all', { method:'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'robes_release_all_failed');
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
  const out = {
    ok: failCount === 0,
    batchId,
    okCount,
    failCount,
    results
  };
  return out;
}

async function execStockProvision(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const batchId = String(payload.batchId || '').trim() || String(cmd && cmd.id || '').trim();
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (!batchId) throw new Error('missing_batchId');
  if (!actions.length) throw new Error('missing_actions');

  // Serializa por ação (segurança) e retorna detalhes por etapa
  const results = [];
  for (const a of actions) {
    const startedAt = Date.now();
    const city = String(a && (a.city || a.cidade || a.toCity || a.city_uf) || '').trim();
    const cookies = a && a.cookies;
    const label = String(a && a.label || '').trim();
    const stockAccountId = (a && (a.stockAccountId || a.stock_account_id)) ? Number(a.stockAccountId || a.stock_account_id) : null;
    const category = String(a && a.category || '').trim().toLowerCase();
    const robeMode = (category === 'veiculos') ? 'veiculos' : 'itens';

    const out = { ok: false, batchId, stockAccountId, city, label, steps: [], profileName: null, robeMode };
    try {
      // 1) criar perfil
      out.steps.push({ step: 'create_profile', at: Date.now() });
      const created = await httpJson('/api/perfis', { method:'POST', headers:{ 'x-operator':'stock_provision' }, body: { cidade: city, cookies } });
      if (!created || created.ok === false) throw new Error((created && created.error) ? String(created.error) : 'create_profile_failed');
      const nome = created?.perfil?.nome ? String(created.perfil.nome) : '';
      if (!nome) throw new Error('create_profile_missing_name');
      out.profileName = nome;

      // 2) set label (interno)
      if (label) {
        out.steps.push({ step: 'set_label', at: Date.now() });
        const r2 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/label`, { method:'PATCH', headers:{ 'x-operator':'stock_provision' }, body: { novoLabel: label } });
        if (!r2 || r2.ok === false) throw new Error((r2 && r2.error) ? String(r2.error) : 'set_label_failed');
      }

      // 3) set robe mode (categoria)
      out.steps.push({ step: 'set_robe_mode', at: Date.now() });
      const r3 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/robe-mode`, { method:'POST', body: { mode: robeMode } });
      if (!r3 || r3.ok === false) throw new Error((r3 && r3.error) ? String(r3.error) : 'set_robe_mode_failed');

      // 4) activate
      out.steps.push({ step: 'activate', at: Date.now() });
      const r4 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/activate`, { method:'POST', headers:{ 'x-operator':'stock_provision' }, body: {} });
      if (!r4 || r4.ok === false) throw new Error((r4 && r4.error) ? String(r4.error) : 'activate_failed');

      // 5) configure (inject cookies etc)
      out.steps.push({ step: 'configure', at: Date.now() });
      const r5 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/configure`, { method:'POST', headers:{ 'x-operator':'stock_provision' }, body: {} });
      if (!r5 || r5.ok === false) throw new Error((r5 && r5.error) ? String(r5.error) : 'configure_failed');

      // 6) start work
      out.steps.push({ step: 'start_work', at: Date.now() });
      const r6 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/start-work`, { method:'POST', headers:{ 'x-operator':'stock_provision' }, body: {} });
      if (!r6 || r6.ok === false) throw new Error((r6 && r6.error) ? String(r6.error) : 'start_work_failed');

      out.ok = true;
      out.finishedAt = Date.now();
      out.durationMs = out.finishedAt - startedAt;
      results.push(out);
    } catch (e) {
      out.ok = false;
      out.error = (e && e.message) ? e.message : String(e);
      out.finishedAt = Date.now();
      out.durationMs = out.finishedAt - startedAt;
      results.push(out);
    }
  }

  const okCount = results.filter(r => r && r.ok).length;
  const failCount = results.length - okCount;
  return {
    ok: failCount === 0,
    batchId,
    okCount,
    failCount,
    results
  };
}

// ===== ALTERAÇÃO INÍCIO: add notifierBaseFromEndpoints e ackCommand =====
function notifierBaseFromEndpoints() {
  try {
    const u = resolveEndpoints()[0] || '';
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
}
async function ackCommand(cmdId, ok, errorMsg, details) {
  try {
    const base = notifierBaseFromEndpoints();
    if (!base || !hostIdCache || !cmdId) return;
    const controller = new (global.AbortController || require('node-abort-controller'))();
    const t = setTimeout(() => { try { controller.abort(); } catch {} }, 3000);
    await fetch(`${base}/api/commands/ack`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        hostId: hostIdCache,
        id: cmdId,
        ok: !!ok,
        error: errorMsg ? String(errorMsg) : null,
        details: (details && typeof details === 'object') ? details : null
      }),
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
    login_required_events: path.join(base, 'login_required_events.jsonl'),
    migrations: path.join(base, 'migrations.jsonl'),
    updates: path.join(base, 'updates.jsonl'),
    // útil para auditoria do canal de comandos
    commands: path.join(base, 'commands.log'),
    // logs do serviço (quando NSSM estiver configurado)
    service_stdout: path.join(base, 'service_stdout.log'),
    service_stderr: path.join(base, 'service_stderr.log')
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

async function execLogsManifest(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  if (!requestId) throw new Error('missing_requestId');
  const allow = logsAllowlist();
  const items = [];
  for (const key of Object.keys(allow)) {
    const fp = allow[key];
    try {
      if (!fp || !fsSync.existsSync(fp)) {
        items.push({ key, ok:false, error:'not_found', filePath: fp || null, bytes: 0, mtimeMs: null });
        continue;
      }
      const st = fsSync.statSync(fp);
      items.push({ key, ok:true, filePath: fp, bytes: Number(st.size || 0) || 0, mtimeMs: Number(st.mtimeMs || 0) || null });
    } catch (e) {
      items.push({ key, ok:false, error: (e && e.message) || String(e), filePath: fp || null, bytes: 0, mtimeMs: null });
    }
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

// ===== NOVO: Exportar perfis para o estoque =====
async function execStockExportProfiles(cmd) {
  try {
    const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
    const wantedNames = Array.isArray(payload.profileNames) ? payload.profileNames.map(x => String(x || '').trim()).filter(Boolean) : [];

    // Busca lista de perfis do snapshot/status
    let st = null;
    try { st = await httpJson('/api/status'); } catch {}
    let perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    if (wantedNames.length) {
      const want = new Set(wantedNames);
      perfis = perfis.filter(p => p && want.has(String(p.nome || '').trim()));
    }
    
    const results = [];
    const BATCH_SIZE = 20; // Limite para não estourar payload
    const batches = [];
    for (let i = 0; i < perfis.length; i += BATCH_SIZE) {
      batches.push(perfis.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      for (const p of batch) {
        const nome = String(p && p.nome || '').trim();
        if (!nome) continue;

        const result = {
          profile_name: nome,
          city: String(p.cidade || '').trim() || null,
          label: String(p.label || '').trim() || null,
          active: !!(p.active),
          working: !!(p.trabalhando),
          cookies: null,
          cookie_fp: null
        };

        // Busca manifest (com cookies) se disponível
        try {
          const manifest = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/manifest`);
          if (manifest && manifest.manifest && manifest.manifest.cookies) {
            result.cookies = Array.isArray(manifest.manifest.cookies) ? manifest.manifest.cookies : [];
            // Calcula fingerprint se cookies existirem
            if (result.cookies.length) {
              // Fingerprint padrão (mesmo critério do CT: c_user + xs + datr)
              try {
                const crypto = require('crypto');
                const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');
                const byName = new Map(result.cookies.map(c => [String(c?.name || '').trim(), String(c?.value || '')]));
                const cUser = byName.get('c_user') || '';
                const xs = byName.get('xs') || '';
                const datr = byName.get('datr') || '';
                if (cUser && xs) result.cookie_fp = sha1(`c_user=${cUser};xs=${xs};datr=${datr}`);
              } catch {}
            }
          }
        } catch (e) {
          // Se não conseguir manifest, continua sem cookies
        }

        results.push(result);
      }
      // Pequeno delay entre batches para não estourar
      if (batches.length > 1) await sleep(500);
    }

    return {
      ok: true,
      profilesCount: results.length,
      results
    };
  } catch (e) {
    return {
      ok: false,
      error: (e && e.message) || String(e),
      profilesCount: 0,
      results: []
    };
  }
}

// ===== NOVO: Push de atualização do Estoque para um perfil existente =====
async function execStockPushAccountUpdate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const profileName = String(payload.profileName || '').trim();
  if (!profileName) throw new Error('missing_profileName');
  const body = {
    label: payload.label ?? null,
    login: payload.login ?? null,
    password: payload.password ?? null,
    cookies: Array.isArray(payload.cookies) ? payload.cookies : null
  };
  const r = await httpJson(`/api/perfis/${encodeURIComponent(profileName)}/stock-update`, {
    method: 'POST',
    headers: { 'x-operator': 'stock_push' },
    body
  });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'stock_update_failed');
  return r;
}

// ===== ALTERAÇÃO INÍCIO: applyCommands para ACK após cada execução =====
async function applyCommands(cmds = []) {
  for (const c of cmds) {
    try {
      if (!c || !c.type) continue;
      let ackDetails = null;
      if (c.type === 'close_all')             { await execCloseAll(); }
      else if (c.type === 'open_all_24h')     { await execOpenAll24h(); }
      else if (c.type === 'robes_pause_24h_all')  { await execRobePauseAll(); }
      else if (c.type === 'robes_release_all')    { await execRobeReleaseAll(); }
      else if (c.type === 'migrate_profiles') { ackDetails = await execMigrateProfiles(c); }
      else if (c.type === 'stock_provision') { ackDetails = await execStockProvision(c); }
      else if (c.type === 'stock_export_profiles') { ackDetails = await execStockExportProfiles(c); }
      else if (c.type === 'stock_push_account_update') { ackDetails = await execStockPushAccountUpdate(c); }
      else if (c.type === 'fetch_logs')       { await execFetchLogs(c); }
      else if (c.type === 'logs_manifest')    { await execLogsManifest(c); }
      else if (c.type === 'self_update')      { await execSelfUpdate(c); }
      else { throw new Error('unknown_command:' + String(c.type)); }
      logger.info('[DASH][CMD] executado: ' + c.type);
      // ACK de sucesso
      if ((c.type === 'migrate_profiles' || c.type === 'stock_provision' || c.type === 'stock_export_profiles') && ackDetails && ackDetails.ok === false) {
        // Migração/export pode falhar parcialmente; ACK precisa carregar detalhes para auditoria.
        try { 
          const msg = ackDetails.profilesCount !== undefined 
            ? `partial_fail profiles=${ackDetails.profilesCount}` 
            : `partial_fail ok=${ackDetails.okCount} fail=${ackDetails.failCount}`;
          await ackCommand(c.id, false, msg, ackDetails); 
        } catch {}
      } else {
        try { await ackCommand(c.id, true, null, ackDetails); } catch {}
      }
    } catch (e) {
      logger.warn('[DASH][CMD] falha ao executar ' + (c && c.type), { error: e && e.message || e });
      // ACK de erro
      try { await ackCommand(c && c.id, false, (e && e.message) || String(e), null); } catch {}
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