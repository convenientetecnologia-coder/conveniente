"use strict";

// scripts/dashboard.js

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger.js');
const fotos = require('./fotos.js'); // ADICIONADO
const provisionLock = require('./provisionLock.js');
const ramPolicy = require('./ramPolicy.js');
const provisionAudit = require('./provisionAudit.js');

const httpPort = parseInt(process.env.PORT || '8088', 10);
const INTERVAL_MS = parseInt(process.env.DASHBOARD_INTERVAL_MS || '30000', 10); // 30s recomendado
const STATUS_PATH = path.join(__dirname, '..', 'dados', 'status.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');

// Endpoint do notificador (centralizado)
const { resolveEndpoints } = require('./notifierEndpoints');
const { readCtConfig } = require('./ctConfig');

let timer = null;
let inFlight = false;
let lastWarnAt = 0;

// ===== ALTERAÇÃO INÍCIO: adicionado hostIdCache ===========
let hostIdCache = null;
// ===== ALTERAÇÃO FIM =====================================

// ===== Guardrail: close_all durante provision =====
// Regras:
// - Se provision_lock ativo:
//   - close_all humano (UI): DEFERIR (não ACK até terminar a provisão; executa depois)
//   - close_all não-humano (deploy/script): BLOQUEAR (ACK erro imediato)
let deferredCloseAllCmdId = null;
let deferredCloseAllPayload = null;
let deferredCloseAllEnqueuedAt = 0;
function isHumanCloseAll(cmd) {
  const p = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : null;
  if (p && String(p.origin || '').toLowerCase() === 'ui') return true;
  if (p && String(p.origin || '').trim() && String(p.origin || '').toLowerCase() !== 'ui') return false;
  if (p && (p.human === true || p.manual === true)) return true;
  const reqId = p ? String(p.requestId || '') : '';
  if (/^(deploy_|deployall_|deploy_close_all_|deploy_all_close_|close_before_restart_|stabilize_)/i.test(reqId)) return false;
  // Compatibilidade: payload ausente normalmente é UI antiga → tratar como humano
  if (!p) return true;
  // Sem evidência de automação → tratar como humano (mais seguro: deferir do que executar no meio da provisão)
  return true;
}

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

// ===== NOVO: profiles_cleanup (limpeza cirúrgica enterprise) =====
// Objetivo: desfazer “lixo de testes” sem close_all.
// - Desativa uma lista de perfis via /api/perfis/:nome/deactivate (isso também zera desired.active por padrão).
// - Sem loops infinitos: limites e small-jitter.
async function execProfilesCleanup(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const names = Array.isArray(payload.profileNames)
    ? payload.profileNames
    : (Array.isArray(payload.names) ? payload.names : []);
  const list = names.map(x => String(x || '').trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(30, Number(payload.limit || 30) || 30));
  const targets = list.slice(0, limit);
  if (!targets.length) return { ok: false, error: 'missing_profileNames' };

  const operator = `profiles_cleanup:${String(cmd && cmd.id || '').trim() || Date.now()}`;
  const results = [];
  for (const nome of targets) {
    try {
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, {
        method: 'POST',
        headers: { 'x-operator': operator },
        body: {}
      });
      if (!r || r.ok === false) {
        results.push({ nome, ok: false, error: (r && r.error) ? String(r.error) : 'deactivate_failed' });
      } else {
        results.push({ nome, ok: true });
      }
    } catch (e) {
      results.push({ nome, ok: false, error: (e && e.message) || String(e) });
    }
    await sleep(250);
  }
  const okCount = results.filter(x => x && x.ok).length;
  const failCount = results.length - okCount;
  return { ok: failCount === 0, okCount, failCount, results };
}

// ===== NOVO: login_remediate (teste/controlado via comando remoto) =====
async function execLoginRemediate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const nome = String(payload.profileName || payload.nome || '').trim();
  if (!nome) throw new Error('missing_profileName');
  const operator = `login_remediate:${String(cmd && cmd.id || '').trim() || Date.now()}`;
  const timeoutMs = Math.max(30_000, Number(payload.timeoutMs || 0) || (8 * 60 * 1000));

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'login_remediate_cmd_begin',
      cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
      nome,
      operator,
      timeoutMs
    });
  } catch {}

  // Enterprise: após restart, pode haver race onde o worker ainda está subindo.
  // Retry curto e controlado (sem loop infinito) para evitar "falso fail".
  const isTransient = (err) => {
    const m = String(err || '').toLowerCase();
    return m.includes('worker off') || m.includes('queue_timeout') || m.includes('timeout') || m.includes('supervisor_unreachable');
  };
  let r = null;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // IMPORTANT: cluster-safe path (single source of truth):
    // chama endpoint local, que por sua vez chama workerClient do CLUSTER (clusterMaster),
    // evitando abrir browsers em um "worker paralelo" fora do cluster.
    r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/login-remediate`, {
      method: 'POST',
      headers: { 'x-operator': operator },
      body: { options: (payload && payload.options ? payload.options : {}), timeoutMs }
    }).catch(() => null);

    if (r && r.ok !== false) break;
    const err = (r && r.error) ? String(r.error) : 'login_remediate_failed';
    if (!isTransient(err) || attempt >= maxAttempts) break;
    try { provisionAudit.append({ ts: Date.now(), event: 'login_remediate_retry', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, nome, operator, attempt, error: err }); } catch {}
    await sleep(2500);
  }
  if (!r || r.ok === false) {
    const err = (r && r.error) ? String(r.error) : 'login_remediate_failed';
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'login_remediate_cmd_fail',
        cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
        nome,
        operator,
        error: err,
        details: (r && typeof r === 'object') ? r : null
      });
    } catch {}
    return { ok: false, nome, error: err, details: r || null };
  }

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'login_remediate_cmd_done',
      cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
      nome,
      operator,
      result: r
    });
  } catch {}

  return Object.assign({ ok: true, nome }, r);
}

// ===== NOVO: Deletar perfis remotamente (para limpeza de duplicados) =====
async function execDeletePerfis(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const one = String(payload.profileName || payload.nome || '').trim();
  const many = Array.isArray(payload.profileNames) ? payload.profileNames.map(x => String(x || '').trim()).filter(Boolean) : [];
  const list = one ? [one] : many;
  if (!list.length) throw new Error('missing_profileNames');

  const results = [];
  for (const nome of list) {
    try {
      // Ultra enterprise: se o perfil já não existe no perfis.json local,
      // não precisa nem chamar a rota HTTP (evita log poluído e loops "assustadores").
      // Ainda assim consideramos sucesso para o CT parar de reenfileirar.
      try {
        const fileStore = require('./fileStore.js');
        const perfis = fileStore && fileStore.loadPerfisJson ? (fileStore.loadPerfisJson() || []) : [];
        const exists = Array.isArray(perfis) && perfis.some(p => p && p.nome === nome);
        if (!exists) {
          try { fileStore.writeTombstone && fileStore.writeTombstone(nome, { reason: 'delete_missing_cmd', stage: 'skip_http' }); } catch {}
          results.push({ nome, profileName: nome, ok: true, alreadyMissing: true });
          continue;
        }
      } catch {}
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}`, { method: 'DELETE' });
      if (!r || r.ok === false) {
        results.push({ nome, ok: false, error: (r && r.error) ? String(r.error) : 'delete_failed' });
      } else {
        results.push({ nome, profileName: nome, ok: true, alreadyDeleted: !!r.alreadyDeleted });
      }
    } catch (e) {
      results.push({ nome, ok: false, error: (e && e.message) || String(e) });
    }
  }
  const okCount = results.filter(x => x && x.ok).length;
  const failCount = results.length - okCount;
  return { ok: failCount === 0, okCount, failCount, results };
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

  // Hardening: lock global com TTL para isolamento total durante provisão.
  // Evita concorrência (already_opening / slot storms) e permite hard-recovery com segurança.
  const budgetMs = Math.max(30_000, Number(process.env.STOCK_PROVISION_BUDGET_MS || (8 * 60 * 1000)) || (8 * 60 * 1000));
  const lockOwner = `stock_provision:${batchId}`;
  const lk = provisionLock.tryAcquire({
    owner: lockOwner,
    ttlMs: Math.max(9 * 60 * 1000, budgetMs + (2 * 60 * 1000)),
    meta: { batchId, cmdId: String(cmd && cmd.id || '') || null }
  });
  if (!lk || !lk.ok) {
    const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
    throw new Error(`provision_lock_busy${curOwner ? ` owner=${curOwner}` : ''}`);
  }

  const tBatch0 = Date.now();
  // Política ultra enterprise:
  // - durante provisão, o 1GB/node é "emprestável" (Robe/Virtus ficam controlados)
  // - então o headroom mínimo vira: 2GB (host) + pico de cookies (~1.5GB)
  const snapPolicy = ramPolicy.snapshotPolicy();
  const minFreeEnv = Math.max(0, Number(process.env.STOCK_PROVISION_MIN_FREE_MB || 0) || 0);
  const minFreeMB = minFreeEnv > 0 ? minFreeEnv : snapPolicy.reserveProvisionMB;
  const maxHardDeactivations = Math.max(0, Number(process.env.STOCK_PROVISION_MAX_HARD_DEACTIVATIONS || 4) || 4);
  try {
    provisionAudit.append({
      event: 'stock_provision_begin',
      cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
      batchId,
      actionsCount: actions.length,
      minFreeMB,
      maxHardDeactivations,
      lockOwner,
      lockUntilMs: (lk && lk.lock && lk.lock.untilMs) ? lk.lock.untilMs : null
    });
  } catch {}

  const budgetLeftMs = () => Math.max(0, budgetMs - (Date.now() - tBatch0));
  const jitter = (n) => Math.floor(Math.random() * Math.max(1, n));
  const backoffMs = (attempt) => {
    const base = [2000, 5000, 10000, 15000, 20000][Math.min(4, Math.max(0, attempt - 1))];
    return base + jitter(700);
  };

  const normalizeErr = (e) => {
    const msg = (e && e.message) ? String(e.message) : String(e || '');
    return msg.trim().slice(0, 500);
  };
  const isTransient = (msg) => {
    const m = String(msg || '').toLowerCase();
    return (
      m.includes('timeout') ||
      m.includes('already_opening') ||
      m.includes('supervisor_denied:slots') ||
      m.includes('supervisor_denied:ram_low') ||
      m.includes('supervisor_denied:maintenance_provision') ||
      m.includes('maintenance_provision') ||
      m.includes('ram_insuficiente_para_ativar') ||
      m.includes('impossível abrir nova conta por falta de ram') ||
      m.includes('supervisor_unreachable')
    );
  };

  async function getSysSnapshot() {
    try { return await httpJson('/api/sys'); } catch { return null; }
  }
  async function getFreeMB() {
    const s = await getSysSnapshot();
    return Number(s && s.mem && s.mem.freeMB || 0) || 0;
  }
  async function getStatusSnapshot() {
    try { return await httpJson('/api/status'); } catch { return null; }
  }

  function computeQuiesceSnapshot(st) {
    const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    const active = perfis.filter(p => p && p.nome && p.active === true);
    const busy = active.filter(p => (p.sendLockActive === true) || (p.robeEmExecucao === true));
    const pauseableVirtus = active.filter(p =>
      p.virtusOnline === true &&
      p.humanControl !== true &&
      p.configurando !== true &&
      p.sendLockActive !== true &&
      p.robeEmExecucao !== true
    );
    const virtusOnline = active.filter(p => p.virtusOnline === true);
    return {
      activeCount: active.length,
      busyCount: busy.length,
      busyNames: busy.map(p => String(p.nome)).slice(0, 40),
      pauseableVirtusCount: pauseableVirtus.length,
      pauseableVirtusNames: pauseableVirtus.map(p => String(p.nome)).slice(0, 40),
      virtusOnlineCount: virtusOnline.length
    };
  }

  async function waitForQuiesce({ out, phaseBudgetMs, waitBusyMs, waitPauseMs }) {
    const startedAt = Date.now();
    const maxTotal = Math.max(0, Number(phaseBudgetMs) || 0);
    const maxBusy = Math.max(0, Number(waitBusyMs) || 0);
    const maxPause = Math.max(0, Number(waitPauseMs) || 0);

    const push = (obj) => { try { out.steps.push({ ...obj, at: Date.now() }); } catch {} };
    const audit = (obj) => { try { provisionAudit.append({ ts: Date.now(), cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, ...obj }); } catch {} };

    push({ step: 'quiesce_begin', waitBusyMs: maxBusy, waitPauseMs: maxPause });
    audit({ event: 'stock_provision_quiesce_begin', waitBusyMs: maxBusy, waitPauseMs: maxPause });

    // (A) Espera busy finalizar (respostas/postagens em andamento)
    if (maxBusy > 0) {
      const t0 = Date.now();
      let last = null;
      while ((Date.now() - t0) < maxBusy && (Date.now() - startedAt) < maxTotal) {
        const st = await getStatusSnapshot();
        const snap = computeQuiesceSnapshot(st);
        last = snap;
        if (snap.busyCount <= 0) break;
        await sleep(1200);
      }
      const st2 = await getStatusSnapshot();
      const snap2 = computeQuiesceSnapshot(st2);
      push({ step: 'quiesce_busy_done', ok: snap2.busyCount <= 0, busyCount: snap2.busyCount, busyNames: snap2.busyNames });
      audit({ event: 'stock_provision_quiesce_busy_done', ok: snap2.busyCount <= 0, busyCount: snap2.busyCount, busyNames: snap2.busyNames });
      if (snap2.busyCount > 0) {
        // Regra enterprise: NÃO prosseguir se não conseguiu garantir quiescência.
        throw new Error(`busy_timeout count=${snap2.busyCount}`);
      }
    }

    // (B) Espera Virtus pausado (exceto humano/config/ocupado)
    if (maxPause > 0) {
      const t1 = Date.now();
      while ((Date.now() - t1) < maxPause && (Date.now() - startedAt) < maxTotal) {
        const st = await getStatusSnapshot();
        const snap = computeQuiesceSnapshot(st);
        if (snap.pauseableVirtusCount <= 0) break;
        await sleep(900);
      }
      const st3 = await getStatusSnapshot();
      const snap3 = computeQuiesceSnapshot(st3);
      push({ step: 'quiesce_pause_done', ok: snap3.pauseableVirtusCount <= 0, pauseableVirtusCount: snap3.pauseableVirtusCount, pauseableVirtusNames: snap3.pauseableVirtusNames, virtusOnlineCount: snap3.virtusOnlineCount });
      audit({ event: 'stock_provision_quiesce_pause_done', ok: snap3.pauseableVirtusCount <= 0, pauseableVirtusCount: snap3.pauseableVirtusCount, pauseableVirtusNames: snap3.pauseableVirtusNames, virtusOnlineCount: snap3.virtusOnlineCount });
      if (snap3.pauseableVirtusCount > 0) {
        // Regra enterprise: NÃO prosseguir se não conseguiu pausar Virtus "pausáveis".
        throw new Error(`pause_timeout count=${snap3.pauseableVirtusCount}`);
      }
    }

    push({ step: 'quiesce_done', elapsedMs: Date.now() - startedAt });
    audit({ event: 'stock_provision_quiesce_done', elapsedMs: Date.now() - startedAt });
    return { ok: true, elapsedMs: Date.now() - startedAt };
  }
  async function ensureFreeMBWithin(minMB, maxWaitMs) {
    const t0 = Date.now();
    let last = 0;
    while ((Date.now() - t0) < Math.max(0, Number(maxWaitMs) || 0)) {
      try { last = await getFreeMB(); } catch { last = 0; }
      if (last >= minMB) return { ok: true, freeMB: last, waitedMs: Date.now() - t0 };
      await sleep(1200);
    }
    try { last = await getFreeMB(); } catch {}
    return { ok: false, freeMB: last, waitedMs: Date.now() - t0 };
  }
  async function hardRecoverRam({ out, minMB }) {
    const hard = { ok: true, attempts: 0, deactivated: 0, names: [] };
    while (hard.deactivated < maxHardDeactivations && budgetLeftMs() > 5000) {
      const free0 = await getFreeMB().catch(()=>0);
      if (free0 >= minMB) break;
      hard.attempts++;
      out.steps.push({ step: 'hard_ram_recover_check', at: Date.now(), freeMB: free0, minFreeMB: minMB });
      try {
        provisionAudit.append({ event: 'hard_ram_recover_check', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, attempt: hard.attempts, freeMB: free0, minFreeMB: minMB });
      } catch {}
      let st = null;
      try { st = await httpJson('/api/status'); } catch {}
      const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
      const actives = perfis
        .filter(p => p && p.nome && p.active === true && p.humanControl !== true && p.configurando !== true)
        .map(p => ({ nome: String(p.nome), ramMB: (typeof p.ramMB === 'number' ? p.ramMB : 0), trabalhando: !!p.trabalhando }))
        // preferir liberar o que está "menos crítico" primeiro: não trabalhando, depois maior RAM
        .sort((a, b) => {
          if (a.trabalhando !== b.trabalhando) return (a.trabalhando ? 1 : -1) - (b.trabalhando ? 1 : -1);
          return (Number(b.ramMB || 0) || 0) - (Number(a.ramMB || 0) || 0);
        });
      const pick = actives[0];
      if (!pick || !pick.nome) break;
      const nome = pick.nome;
      out.steps.push({ step: 'hard_ram_recover_deactivate', at: Date.now(), nome });
      try {
        provisionAudit.append({ event: 'hard_ram_recover_deactivate', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, nome, freeMB_before: free0 });
      } catch {}
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, {
        method: 'POST',
        headers: { 'x-operator': lockOwner },
        body: { policy: 'preserveDesired', reason: 'ramKill' }
      });
      if (!r || r.ok === false) {
        out.steps.push({ step: 'hard_ram_recover_deactivate_fail', at: Date.now(), nome, error: (r && r.error) ? String(r.error) : 'deactivate_failed' });
        try {
          provisionAudit.append({ event: 'hard_ram_recover_deactivate_fail', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, nome, error: (r && r.error) ? String(r.error) : 'deactivate_failed' });
        } catch {}
        break;
      }
      hard.deactivated++;
      hard.names.push(nome);
      // aguarda o SO liberar RAM
      await sleep(2000 + jitter(800));
    }
    try {
      provisionAudit.append({ event: 'hard_ram_recover_done', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, deactivated: hard.deactivated, names: hard.names.slice(0, 200) });
    } catch {}
    return hard;
  }

  // Serializa por ação (segurança) e retorna detalhes por etapa
  const results = [];
  try {
    for (const a of actions) {
      const startedAt = Date.now();
      const city = String(a && (a.city || a.cidade || a.toCity || a.city_uf) || '').trim();
      const cookies = a && a.cookies;
      const label = String(a && a.label || '').trim();
      const stockAccountId = (a && (a.stockAccountId || a.stock_account_id)) ? Number(a.stockAccountId || a.stock_account_id) : null;
      // Credenciais podem vir do CT Stock payload (não logar).
      const login = String(a && (a.login || a.user || a.email || a.username) || '').trim();
      const password = String(a && (a.password || a.pass) || '').trim();
      const category = String(a && a.category || '').trim().toLowerCase();
      const robeMode = (category === 'veiculos') ? 'veiculos' : 'itens';

      const out = {
        ok: false,
        batchId,
        stockAccountId,
        city,
        label,
        steps: [],
        profileName: null,
        robeMode,
        maintenanceMode: true,
        lockOwner,
        lockUntilMs: lk && lk.lock && lk.lock.untilMs || null,
        budgetMs,
        minFreeMB,
        retries: []
      };

      const runStep = async (step, fn) => {
        const maxAttempts = 20;
        let attempt = 0;
        while (true) {
          attempt++;
          const freeBefore = await getFreeMB().catch(()=>0);
          out.steps.push({ step, at: Date.now(), attempt, freeMB_before: freeBefore });
          try {
            const r = await fn();
            const freeAfter = await getFreeMB().catch(()=>0);
            out.steps.push({ step: `${step}_ok`, at: Date.now(), attempt, freeMB_after: freeAfter });
            return r;
          } catch (e) {
            const msg = normalizeErr(e);
            out.retries.push({ step, attempt, at: Date.now(), error: msg, budgetLeftMs: budgetLeftMs() });
            out.steps.push({ step: `${step}_fail`, at: Date.now(), attempt, error: msg });
            if (!isTransient(msg) || attempt >= maxAttempts || budgetLeftMs() <= 0) {
              throw new Error(msg || `${step}_failed`);
            }
            const waitMs = Math.min(backoffMs(attempt), Math.max(1000, budgetLeftMs() - 500));
            await sleep(waitMs);
            continue;
          }
        }
      };

      try {
        // 0) baseline telemetria
        out.steps.push({ step: 'lock_acquired', at: Date.now(), lockOwner, lockUntilMs: out.lockUntilMs });

        // 0.5) Ultra enterprise: quiescência determinística antes de mexer em cookies/config
        // - espera envios/postagens ativos terminarem
        // - garante Virtus pausado para os demais perfis (mínimo impacto)
        {
          const waitBusyMs = Math.max(0, Number(process.env.STOCK_PROVISION_WAIT_BUSY_MS || 120000) || 120000);
          const waitPauseMs = Math.max(0, Number(process.env.STOCK_PROVISION_WAIT_PAUSE_MS || 45000) || 45000);
          const phaseBudgetMs = Math.min(budgetLeftMs(), Math.max(20_000, waitBusyMs + waitPauseMs + 10_000));
          await waitForQuiesce({ out, phaseBudgetMs, waitBusyMs, waitPauseMs });
        }

        // 1) criar perfil
        const created = await runStep('create_profile', async () => {
          const r = await httpJson('/api/perfis', {
            method: 'POST',
            headers: { 'x-operator': lockOwner },
            // Ultra enterprise: persiste login/senha no manifest já na criação, para permitir fluxo
            // automático "cookies -> login+senha" sem depender de clique em "retomar trabalho".
            body: { cidade: city, cookies, login, password, stockAccountId }
          });
          if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'create_profile_failed');
          return r;
        });
        const nome = created?.perfil?.nome ? String(created.perfil.nome) : '';
        if (!nome) throw new Error('create_profile_missing_name');
        out.profileName = nome;
        try {
          provisionAudit.append({ event: 'stock_provision_profile_created', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, profileName: nome });
        } catch {}

        // 2) set label (interno)
        if (label) {
          await runStep('set_label', async () => {
            const r2 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/label`, { method: 'PATCH', headers: { 'x-operator': lockOwner }, body: { novoLabel: label } });
            if (!r2 || r2.ok === false) throw new Error((r2 && r2.error) ? String(r2.error) : 'set_label_failed');
            return r2;
          });
        }

        // 3) set robe mode (categoria)
        await runStep('set_robe_mode', async () => {
          const r3 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/robe-mode`, { method: 'POST', body: { mode: robeMode } });
          if (!r3 || r3.ok === false) throw new Error((r3 && r3.error) ? String(r3.error) : 'set_robe_mode_failed');
          return r3;
        });

        // 3.5) garantir headroom antes de abrir browser
        const free0 = await getFreeMB().catch(()=>0);
        out.steps.push({ step: 'pre_activate_headroom', at: Date.now(), freeMB: free0, minFreeMB });
        if (free0 < minFreeMB) {
          const hard = await hardRecoverRam({ out, minMB: minFreeMB });
          out.steps.push({ step: 'hard_ram_recover_done', at: Date.now(), ...hard });
          const remain = Math.min(budgetLeftMs(), 90_000);
          const ensured = await ensureFreeMBWithin(minFreeMB, remain);
          out.steps.push({ step: 'ensure_free_mb', at: Date.now(), ...ensured, minFreeMB });
          if (!ensured.ok) throw new Error(`ram_low_wait_timeout freeMB=${ensured.freeMB} min=${minFreeMB}`);
        }

        // 4) activate
        await runStep('activate', async () => {
          const r4 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/activate`, { method: 'POST', headers: { 'x-operator': lockOwner }, body: {} });
          if (!r4 || r4.ok === false) throw new Error((r4 && r4.error) ? String(r4.error) : 'activate_failed');
          return r4;
        });

        // 5) Procedimento enterprise unificado:
        // Em vez de "configure + fechar/reabrir + start_work", usamos o MESMO motor do login_required:
        // login_remediate = cookies -> login/senha -> detecção -> (sucesso) desired active+virtus on
        // Isso elimina divergência de comportamento e o ciclo "fechou/reabriu" observado.
        await runStep('login_remediate', async () => {
          const r5 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/login-remediate`, {
            method: 'POST',
            headers: { 'x-operator': lockOwner },
            body: {
              // defaults do worker já são bons; só garantimos pós-sucesso: startAfterSuccess=true
              totalTimeoutMs: 8 * 60 * 1000,
              closeAfterSuccess: true,
              startAfterSuccess: true,
              reopenClosedForRam: true
            }
          });
          if (!r5 || r5.ok === false) throw new Error((r5 && r5.error) ? String(r5.error) : 'login_remediate_failed');
          // Se result.ok=false, consideramos falha (o worker já terá feito hold/ban/2fa conforme regra).
          if (!r5.result || r5.result.ok !== true) throw new Error((r5.result && r5.result.error) ? String(r5.result.error) : 'login_remediate_failed');
          return r5;
        });

        out.ok = true;
        out.finishedAt = Date.now();
        out.durationMs = out.finishedAt - startedAt;
        results.push(out);
      } catch (e) {
        out.ok = false;
        out.error = normalizeErr(e);
        out.finishedAt = Date.now();
        out.durationMs = out.finishedAt - startedAt;
        results.push(out);
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'stock_provision_action_fail',
            cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
            batchId,
            profileName: out.profileName || null,
            city,
            label: label || null,
            error: out.error
          });
        } catch {}
      }
    }
  } finally {
    // Sempre libera lock global.
    try { provisionLock.release({ owner: lockOwner }); } catch {}
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
  try {
    const { readCtConfig } = require('./ctConfig');
    const cfg = readCtConfig();
    const fromCfg = String(cfg && cfg.logIngestSecret || '').trim();
    if (fromCfg) return fromCfg;
  } catch {
    // ignore
  }
  // Fallback: permite env var, mas ct_config tem prioridade (permite correção remota via set_ct_config)
  const env = String(process.env.LOG_INGEST_SECRET || '').trim();
  if (env) return env;
  return '';
}
function logsAllowlist() {
  const base = path.join(__dirname, '..', 'dados');
  const repo = path.join(__dirname, '..');
  return {
    logger: path.join(base, 'logger.log'),
    issues_fallback: path.join(base, 'issues_fallback.log'),
    // Auditoria de estado (enterprise): permite verificar “sobras” de desired/perfis/status
    desired: path.join(base, 'desired.json'),
    perfis: path.join(base, 'perfis.json'),
    status: path.join(base, 'status.json'),
    status_node_1: path.join(base, 'status_node_1.json'),
    status_node_2: path.join(base, 'status_node_2.json'),
    status_node_3: path.join(base, 'status_node_3.json'),
    status_node_4: path.join(base, 'status_node_4.json'),
    status_node_5: path.join(base, 'status_node_5.json'),
    status_node_6: path.join(base, 'status_node_6.json'),
    provision_audit: path.join(base, 'provision_audit.jsonl'),
    login_required_events: path.join(base, 'login_required_events.jsonl'),
    login_remediate_evidence: path.join(base, 'login_remediate_evidence.jsonl'),
    messenger_pin: path.join(base, 'messenger_pin.jsonl'),
    migrations: path.join(base, 'migrations.jsonl'),
    updates: path.join(base, 'updates.jsonl'),
    // Evidência de versão (para auditoria E2E): prova qual commit está no disco
    git_head: path.join(repo, '.git', 'HEAD'),
    git_main_ref: path.join(repo, '.git', 'refs', 'heads', 'main'),
    // Auditoria enterprise: lock de provisão (para diagnosticar maintenance_provision/locks presos)
    provision_lock: path.join(base, 'provision_lock.json'),
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

function tailFileGrep(filePath, { patterns = [], maxBytes = 10_000_000, maxMatches = 600 } = {}) {
  try {
    if (!fsSync.existsSync(filePath)) return { ok:false, error:'not_found', filePath };
    const st = fsSync.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    const readBytes = Math.min(Math.max(0, Number(maxBytes || 0) || 0), size);
    const start = Math.max(0, size - readBytes);
    const buf = Buffer.alloc(readBytes);
    const fd = fsSync.openSync(filePath, 'r');
    try { fsSync.readSync(fd, buf, 0, readBytes, start); }
    finally { try { fsSync.closeSync(fd); } catch {} }
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    const pats = Array.isArray(patterns) ? patterns.map(x => String(x||'').trim()).filter(Boolean) : [];
    if (!pats.length) return { ok:false, error:'missing_patterns', filePath };
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      let hit = false;
      for (const p of pats) {
        if (line.includes(p)) { hit = true; break; }
      }
      if (!hit) continue;
      out.push(line);
      if (out.length >= maxMatches) break;
    }
    const truncated = (start > 0) || (out.length >= maxMatches);
    return { ok:true, filePath, bytes: readBytes, lines: out.length, truncated, text: out.join('\n') };
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

async function execFetchLogsQuery(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const key = String(payload.key || '').trim();
  const patterns = Array.isArray(payload.patterns) ? payload.patterns : [];
  const maxBytes = Math.max(500_000, Math.min(50_000_000, Number(payload.maxBytes || 10_000_000) || 10_000_000));
  const maxMatches = Math.max(10, Math.min(5000, Number(payload.maxMatches || 600) || 600));
  if (!requestId) throw new Error('missing_requestId');
  if (!key) throw new Error('missing_key');
  const allow = logsAllowlist();
  const fp = allow[key];
  if (!fp) throw new Error('not_allowed');
  const r = tailFileGrep(fp, { patterns, maxBytes, maxMatches });
  const items = [{
    key: `query_${key}`,
    ...r,
    meta: { key, patterns: patterns.map(x => String(x||'').slice(0, 120)), maxBytes, maxMatches }
  }];
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
    // Ultra enterprise: nunca permitir prompt interativo (evita self_update travar em inflight).
    // - GIT_TERMINAL_PROMPT=0: desabilita prompts
    // - GCM_INTERACTIVE=Never: bloqueia Git Credential Manager UI
    // - timeout: evita pendurar indefinidamente em fetch/pull (rede/credencial)
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
    execFile('git', args, {
      cwd: cwd || path.join(__dirname, '..'),
      env,
      timeout: Math.max(15_000, Number(process.env.SELF_UPDATE_GIT_TIMEOUT_MS || 120_000) || 120_000)
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok:false, error: (err && err.message) || String(err), stdout: String(stdout||''), stderr: String(stderr||'') });
      return resolve({ ok:true, stdout: String(stdout||''), stderr: String(stderr||'') });
    });
  });
}
async function execSelfUpdate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim() || (cmd && cmd.id) || 'noid';
  const branch = String(payload.branch || 'main').trim() || 'main';
  // Segurança enterprise: por padrão NÃO derruba o processo.
  // Restart automático só é permitido se o operador habilitar explicitamente via env.
  const restartRequested = (payload.restart === true || payload.restart === 1 || payload.restart === '1' || String(payload.restart || '').toLowerCase() === 'true');
  const restartAllowed = String(process.env.ALLOW_SELF_UPDATE_RESTART || '').trim() === '1';
  const restart = restartRequested && restartAllowed;
  const repoDir = path.join(__dirname, '..');

  updateLogAppend({ event: 'self_update_start', requestId, branch, restart });
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

  // Reinício opcional: somente se explicitamente permitido.
  // Agendado após o retorno para não interromper o ACK em trânsito.
  if (restart) {
    try { updateLogAppend({ event: 'self_update_restart_scheduled', requestId, at: Date.now() }); } catch {}
    setTimeout(() => {
      try { logger.info('[DASH][SELF_UPDATE] restart=1 -> saindo do processo para o gerenciador reiniciar'); } catch {}
      try { process.exit(0); } catch {}
    }, 2500);
  } else if (restartRequested && !restartAllowed) {
    try { updateLogAppend({ event: 'self_update_restart_blocked', requestId, reason: 'ALLOW_SELF_UPDATE_RESTART!=1' }); } catch {}
  }
}

// ===== NOVO: Configurar CT_BASE_URL + LOG_INGEST_SECRET via comando (persistente) =====
async function execSetCtConfig(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const ctBaseUrl = (payload.ctBaseUrl !== undefined) ? String(payload.ctBaseUrl || '').trim() : undefined;
  const logIngestSecret = (payload.logIngestSecret !== undefined) ? String(payload.logIngestSecret || '').trim() : undefined;
  const { writeCtConfig } = require('./ctConfig');
  const r = writeCtConfig({ ctBaseUrl, logIngestSecret });
  if (!r || r.ok !== true) throw new Error('set_ct_config_failed');
  return { ok: true };
}

// ===== NOVO: Exportar perfis para o estoque =====
async function execStockExportProfiles(cmd) {
  try {
    const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
    const wantedNames = Array.isArray(payload.profileNames) ? payload.profileNames.map(x => String(x || '').trim()).filter(Boolean) : [];
    const includeCookies = payload.includeCookies === true || payload.includeCookies === 1 || String(payload.includeCookies || '').trim() === '1';

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
          uaPresetId: null,
          fp_summary_json: null,
          cookies: null,
          cookie_fp: null
        };

        // Busca manifest (com cookies) se disponível.
        // Regra enterprise: por padrão NÃO envia cookies no export (payload grande).
        // Quando includeCookies=1 (ação manual no CT), aí sim envia cookies.
        try {
          const manifest = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/manifest`);
          if (manifest && manifest.manifest && manifest.manifest.cookies) {
            const cookiesArr = Array.isArray(manifest.manifest.cookies) ? manifest.manifest.cookies : [];
            try {
              const uaPresetId = manifest && manifest.manifest && manifest.manifest.uaPresetId ? String(manifest.manifest.uaPresetId).trim() : '';
              if (uaPresetId) result.uaPresetId = uaPresetId;
              const fp = (manifest && manifest.manifest && manifest.manifest.fp && typeof manifest.manifest.fp === 'object') ? manifest.manifest.fp : null;
              const uaString = manifest && manifest.manifest && manifest.manifest.uaString ? String(manifest.manifest.uaString) : '';
              // fp_summary_json é usado no CT para drilldown humano (sem poluir a tabela principal)
              const fpSummary = {
                viewport: fp && fp.viewport ? fp.viewport : null,
                dpr: fp && (fp.dpr !== undefined) ? fp.dpr : null,
                hardwareConcurrency: fp && (fp.hardwareConcurrency !== undefined) ? fp.hardwareConcurrency : null,
                uaString: uaString ? uaString.slice(0, 260) : null
              };
              result.fp_summary_json = JSON.stringify(fpSummary);
            } catch {}
            // Calcula fingerprint (sempre, se possível)
            if (cookiesArr.length) {
              try {
                const crypto = require('crypto');
                const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');
                const byName = new Map(cookiesArr.map(c => [String(c?.name || '').trim(), String(c?.value || '')]));
                const cUser = byName.get('c_user') || '';
                const xs = byName.get('xs') || '';
                const datr = byName.get('datr') || '';
                if (cUser && xs) result.cookie_fp = sha1(`c_user=${cUser};xs=${xs};datr=${datr}`);
              } catch {}
            }
            if (includeCookies) {
              result.cookies = cookiesArr;
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
    cookies: Array.isArray(payload.cookies) ? payload.cookies : null,
    // default enterprise: store only (não reinjeta automaticamente)
    applyCookies: (payload.applyCookies === true || payload.applyCookies === 1 || String(payload.applyCookies || '').trim() === '1') ? 1 : 0
  };
  const r = await httpJson(`/api/perfis/${encodeURIComponent(profileName)}/stock-update`, {
    method: 'POST',
    headers: { 'x-operator': 'stock_push' },
    body
  });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'stock_update_failed');
  return r;
}

// ===== NOVO: Unlock do lock global de provisão (safe recovery) =====
async function execProvisionUnlock(cmd) {
  const before = (() => {
    try { return provisionLock.get(); } catch { return null; }
  })();
  const wasActive = !!(before && before.active);
  const lock = before && before.lock ? before.lock : null;
  const released = (() => {
    try { return provisionLock.release({ force: true }); } catch { return { ok: false, released: false }; }
  })();
  return {
    ok: true,
    wasActive,
    lock,
    released: !!(released && released.ok && released.released)
  };
}

// ===== ALTERAÇÃO INÍCIO: applyCommands para ACK após cada execução =====
async function applyCommands(cmds = []) {
  for (const c of cmds) {
    try {
      if (!c || !c.type) continue;
      let ackDetails = null;
      if (c.type === 'close_all')             {
        // Ultra enterprise: close_all só pode ser executado quando explicitamente humano (UI / operador).
        // Qualquer close_all “automático” (deploy/script) é bloqueado para evitar side-effects e instabilidade.
        if (!isHumanCloseAll(c)) {
          try { await ackCommand(c.id, false, 'close_all_blocked_not_human', { blocked: true }); } catch {}
          continue;
        }
        // Guardrail: nunca executar close_all automaticamente no meio de provisão.
        if (provisionLock.isActive()) {
          if (isHumanCloseAll(c)) {
            // Deferir: não ACK agora (mantém pendente no CT); executa automaticamente após provisão.
            if (!deferredCloseAllCmdId) {
              deferredCloseAllCmdId = String(c.id || '').trim() || null;
              deferredCloseAllPayload = (c && c.payload && typeof c.payload === 'object') ? c.payload : null;
              deferredCloseAllEnqueuedAt = Date.now();
              logger.warn('[DASH][CMD] close_all deferido (provision_lock ativo)', { cmdId: deferredCloseAllCmdId });
            } else {
              // Já existe um deferido; para evitar “fila infinita” de close_all durante provisão.
              try { await ackCommand(c.id, false, 'close_all_deferred_already_exists', { deferredExistingCmdId: deferredCloseAllCmdId }); } catch {}
            }
            continue;
          }
          // Não-humano: bloqueia e ACK erro imediato (não pode existir close_all “surpresa”)
          try { await ackCommand(c.id, false, 'close_all_blocked_due_provision', { blocked: true, reason: 'provision_lock' }); } catch {}
          continue;
        }
        await execCloseAll(c);
        if (deferredCloseAllCmdId && String(c.id || '').trim() === deferredCloseAllCmdId) {
          deferredCloseAllCmdId = null;
          deferredCloseAllPayload = null;
          deferredCloseAllEnqueuedAt = 0;
        }
      }
      else if (c.type === 'open_all_24h')     { await execOpenAll24h(); }
      else if (c.type === 'robes_pause_24h_all')  { await execRobePauseAll(); }
      else if (c.type === 'robes_release_all')    { await execRobeReleaseAll(); }
      else if (c.type === 'delete_perfis')    { ackDetails = await execDeletePerfis(c); }
      else if (c.type === 'migrate_profiles') { ackDetails = await execMigrateProfiles(c); }
      else if (c.type === 'stock_provision') { ackDetails = await execStockProvision(c); }
      else if (c.type === 'login_remediate') { ackDetails = await execLoginRemediate(c); }
      else if (c.type === 'profiles_cleanup') { ackDetails = await execProfilesCleanup(c); }
      else if (c.type === 'provision_unlock') { ackDetails = await execProvisionUnlock(c); }
      else if (c.type === 'stock_export_profiles') { ackDetails = await execStockExportProfiles(c); }
      else if (c.type === 'stock_push_account_update') { ackDetails = await execStockPushAccountUpdate(c); }
      else if (c.type === 'fetch_logs')       { await execFetchLogs(c); }
      else if (c.type === 'fetch_logs_query') { await execFetchLogsQuery(c); }
      else if (c.type === 'logs_manifest')    { await execLogsManifest(c); }
      else if (c.type === 'set_ct_config')    { ackDetails = await execSetCtConfig(c); }
      else if (c.type === 'self_update')      { await execSelfUpdate(c); }
      else { throw new Error('unknown_command:' + String(c.type)); }
      logger.info('[DASH][CMD] executado: ' + c.type);
      // ACK enterprise: se o handler retornou {ok:false}, refletir falha no CT + carregar detalhes.
      if (ackDetails && ackDetails.ok === false) {
        try {
          const msg =
            ackDetails.profilesCount !== undefined
              ? `fail profiles=${ackDetails.profilesCount}`
              : (ackDetails.okCount !== undefined || ackDetails.failCount !== undefined)
              ? `fail ok=${ackDetails.okCount} fail=${ackDetails.failCount}`
              : (ackDetails.error ? String(ackDetails.error) : 'fail');
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

    // Verifica se precisa solicitar config (ctBaseUrl ou logIngestSecret ausentes)
    const cfg = readCtConfig();
    const needsConfig = !cfg.ctBaseUrl || !cfg.logIngestSecret;

    const payload = {
      hostname: quick.system.hostname,
      hostId,
      sentAt: now(),
      needsConfig: needsConfig, // Flag para CT saber que precisa enviar set_ct_config
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