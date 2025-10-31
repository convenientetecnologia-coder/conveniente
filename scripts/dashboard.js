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
  // (1) HTTP local COM TIMEOUT (3s)
  try {
    const res = await timeoutFetch(`http://127.0.0.1:${httpPort}/api/status`, { timeoutMs: 3000 });
    if (res && res.ok) {
      const st = await res.json();
      if (st && typeof st === 'object') return st;
    }
  } catch {
    logger && logger.warn && logger.warn('[DASH][TICK] api/status timeout, using fallback');
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
          if (dst) Object.assign(dst, o);
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
    logger.info('[DASHBOARD] enviado com sucesso para ' + url);
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
async function httpJson(path, { method='GET', body=null } = {}) {
  const res = await fetch(`http://127.0.0.1:${httpPort}${path}`, {
    method,
    headers: body ? { 'Content-Type':'application/json' } : undefined,
    body: body ? JSON.stringify(body) : null
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
async function execOpenAll24h() {
  try {
    const lp = await httpJson('/api/perfis');
    const perfis = (lp && lp.ok && Array.isArray(lp.perfis)) ? lp.perfis : [];
    for (const p of perfis) {
      await ensureFreeMB(3072);
      try { await httpJson(`/api/perfis/${encodeURIComponent(p.nome)}/start-work`, { method:'POST' }); } catch {}
      await sleep(800);
    }
  } catch {}
}
async function execRobePauseAll() {
  try { await httpJson('/api/robes/pause-24h-all', { method:'POST' }); } catch {}
}
async function execRobeReleaseAll() {
  try { await httpJson('/api/robes/release-all', { method:'POST' }); } catch {}
}
async function applyCommands(cmds = []) {
  for (const c of cmds) {
    try {
      if (!c || !c.type) continue;
      if (c.type === 'close_all')             { await execCloseAll(); }
      else if (c.type === 'open_all_24h')     { await execOpenAll24h(); }
      else if (c.type === 'robes_pause_24h_all')  { await execRobePauseAll(); }
      else if (c.type === 'robes_release_all')    { await execRobeReleaseAll(); }
      logger.info('[DASH][CMD] executado: ' + c.type);
    } catch (e) {
      logger.warn('[DASH][CMD] falha ao executar ' + (c && c.type), { error: e && e.message || e });
    }
  }
}

async function tick() {
  logger.info('[DASH][TICK] start: ' + new Date().toISOString());
  const start = Date.now();

  if (inFlight) return; // anti-overlap
  inFlight = true;
  try {
    const [status, hostId] = await Promise.all([readAggregatedStatus(), getOrCreateHostId()]);
    logger.info(`[DASH][TICK] got status in ${Date.now() - start}ms`);

    const quick = buildQuickSnapshot(status);

    const payload = {
      hostname: quick.system.hostname,
      hostId,
      sentAt: now(),
      status: {
        ...status,
        _dashboard: quick
      }
    };

    const resp = await tryAllEndpoints(payload);
    if (resp && Array.isArray(resp.commands) && resp.commands.length) {
      await applyCommands(resp.commands);
    }
    logger.info(`[DASH][TICK] post finish in ${Date.now() - start}ms`);

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