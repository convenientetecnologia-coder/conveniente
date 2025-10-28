"use strict";

// scripts/dashboard.js

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger.js');

const INTERVAL_MS = parseInt(process.env.DASHBOARD_INTERVAL_MS || '30000', 10); // 30s recomendado
const STATUS_PATH = path.join(__dirname, '..', 'dados', 'status.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');

// Endpoints configuráveis via env (CSV) com fallback
function resolveEndpoints() {
  const env = (process.env.DASHBOARD_ENDPOINTS || '').trim();
  if (env) {
    return env.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Fallback: local notificador
  return [
    'http://127.0.0.1:3000/report'
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

async function readStatusFile() {
  try {
    const raw = await fs.readFile(STATUS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { erro: 'falha ao ler status.json: ' + (e && e.message || String(e)) };
  }
}

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
    ts: now()
  };
}

async function postPayload(url, payload) {
  let bodyStr;
  try {
    bodyStr = JSON.stringify(payload);
  } catch (e) {
    throw new Error('payload_stringify_failed: ' + (e && e.message || e));
  }

  // Nunca gzip!
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const body = Buffer.from(bodyStr, 'utf8');

  const Aborter = global.AbortController || require('node-abort-controller');
  const ac = new Aborter();
  const timeoutMs = parseInt(process.env.DASHBOARD_TIMEOUT_MS || '8000', 10);
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: ac.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}: ${txt}`);
      err.status = resp.status;
      err.text = txt;
      throw err;
    }
    logger.info('[DASHBOARD] enviado com sucesso para ' + url);
  } finally {
    clearTimeout(t);
  }
}

async function tryAllEndpoints(payload) {
  const endpoints = resolveEndpoints();
  let lastErr = null;
  for (const u of endpoints) {
    try {
      await postPayload(u, payload);
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return false;
}

async function tick() {
  if (inFlight) return; // anti-overlap
  inFlight = true;
  try {
    const [status, hostId] = await Promise.all([readStatusFile(), getOrCreateHostId()]);
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

    await tryAllEndpoints(payload);

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