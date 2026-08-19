"use strict";

/**
 * Faixa única de navegação pesada no HOST (todos os workers).
 *
 * Liga com gateway proxy (5G), arquivo armed, ou CONNECT_LANE=1.
 * No modem (gateway off e sem proxy) é no-op.
 *
 * Mutex = arquivo dados/connect_lane.lock (wx). Não é DOM do Facebook.
 * O que entra: cold-start de Chrome, goto Messages inicial, newPage+goto
 * create/selling/vehicle. O que NÃO entra: Virtus, preencher, Publicar,
 * GraphQL/WS em página já carregada.
 *
 * Um CONNECT HTTP no proxy = túnel TCP novo até host:443.
 * Depois o Chrome reusa HTTP/2. Clique/mensagem quase nunca abre túnel novo.
 * Serializamos a RAJADA de túneis, não o trabalho em página viva.
 */

const fs = require("fs");
const path = require("path");
const gatewayProxy = require("./gatewayProxy.js");

const DADOS_DIR = path.join(__dirname, "..", "dados");
const LOCK_PATH = path.join(DADOS_DIR, "connect_lane.lock");
const EVENTS_PATH = path.join(DADOS_DIR, "connect_lane_events.jsonl");
const ARMED_PATH = path.join(DADOS_DIR, "connect_lane.armed.json");
const FAIL_PATH = path.join(DADOS_DIR, "connect_lane_fail.json");
const GATEWAY_STATE_PATH = path.join(DADOS_DIR, "gateway_proxy_state.json");

// 40 Chromes * ~20s de boot serial ≈ 13 min. Folga para 5G lento + Robe intercalado.
function envNum(name, fallback, min, max) {
  const raw = process.env[name];
  let n = fallback;
  if (raw !== undefined && String(raw).trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (Number.isFinite(min)) n = Math.max(min, n);
  if (Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

const ACQUIRE_MS = envNum("CONNECT_LANE_ACQUIRE_MS", 1_500_000, 60_000, null);
const STALE_MS = envNum("CONNECT_LANE_STALE_MS", 480_000, 120_000, null);
const POLL_MS = envNum("CONNECT_LANE_POLL_MS", 80, 40, null);
const BASE_GAP_MS = envNum("CONNECT_LANE_GAP_MS", 800, 0, null);
const FAIL_GAP_MS = Math.max(BASE_GAP_MS, envNum("CONNECT_LANE_FAIL_GAP_MS", 4000, 0, null));
const FAIL_WINDOW_MS = envNum("CONNECT_LANE_FAIL_WINDOW_MS", 300_000, 60_000, null);
const FAIL_STREAK = envNum("CONNECT_LANE_FAIL_STREAK", 2, 1, null);
const BOOT_SETTLE_MS = envNum("CONNECT_LANE_BOOT_SETTLE_MS", 14_000, 5_000, 25_000);

let _held = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function audit(payload) {
  try {
    const provisionAudit = require("./provisionAudit.js");
    provisionAudit.append({ ts: Date.now(), ...payload });
  } catch {}
}

function appendEvent(row) {
  try {
    fs.mkdirSync(DADOS_DIR, { recursive: true });
    fs.appendFileSync(EVENTS_PATH, JSON.stringify({ ts: Date.now(), ...row }) + "\n", "utf8");
  } catch {}
}

function gatewayStateFileExists() {
  try {
    return fs.existsSync(GATEWAY_STATE_PATH);
  } catch {
    return false;
  }
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(String(raw || "{}"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

function writeJsonSafe(filePath, obj) {
  try {
    fs.mkdirSync(DADOS_DIR, { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    try {
      fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

function isArmed() {
  const j = readJsonSafe(ARMED_PATH);
  return !!(j && j.armed === true);
}

function markArmed(on, reason) {
  const armed = on === true;
  const rec = {
    armed,
    reason: String(reason || "").slice(0, 80),
    at: Date.now(),
    pid: process.pid
  };
  writeJsonSafe(ARMED_PATH, rec);
  appendEvent({ type: armed ? "armed" : "disarmed", reason: rec.reason });
  return rec;
}

function syncFromGatewayState() {
  try {
    if (!gatewayStateFileExists()) return { skipped: true, reason: "no_gateway_file" };
    if (gatewayProxy.isStrictProxyRequired() === true) {
      markArmed(true, "gateway_on");
      return { armed: true };
    }
    markArmed(false, "gateway_off");
    return { armed: false };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 80) };
  }
}

function isEnabled() {
  const env = String(process.env.CONNECT_LANE || "").trim();
  if (env === "0") return false;
  if (env === "1") return true;
  try {
    if (gatewayProxy.isStrictProxyRequired() === true) return true;
  } catch {}
  return isArmed();
}

function loadFailTs() {
  const now = Date.now();
  const j = readJsonSafe(FAIL_PATH);
  const arr = j && Array.isArray(j.ts) ? j.ts : [];
  return arr.map(Number).filter((t) => t > 0 && (now - t) <= FAIL_WINDOW_MS);
}

function noteFailure(reason) {
  const now = Date.now();
  const arr = loadFailTs();
  arr.push(now);
  writeJsonSafe(FAIL_PATH, {
    ts: arr,
    lastReason: String(reason || "").slice(0, 160),
    lastAt: now
  });
  appendEvent({ type: "fail", reason: String(reason || "").slice(0, 160) });
}

function recentFailCount() {
  return loadFailTs().length;
}

function gapMsNow() {
  return recentFailCount() >= FAIL_STREAK ? FAIL_GAP_MS : BASE_GAP_MS;
}

function readLockMeta() {
  return readJsonSafe(LOCK_PATH);
}

function processAlive(pid) {
  const n = Number(pid || 0) || 0;
  if (n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function recoverStale() {
  try {
    if (!fs.existsSync(LOCK_PATH)) return false;
    const st = fs.statSync(LOCK_PATH);
    const age = Date.now() - Number(st.mtimeMs || 0);
    const meta = readLockMeta();
    const pid = meta && meta.pid;
    if (pid && processAlive(pid) && age < STALE_MS) return false;
    if (!pid && age < STALE_MS) return false;
    try {
      fs.unlinkSync(LOCK_PATH);
      appendEvent({ type: "stale_recovered", ageMs: age, pid: pid || null });
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function isHeld() {
  if (_held && !_held.skipped && !_held.released) return true;
  recoverStale();
  try {
    return fs.existsSync(LOCK_PATH);
  } catch {
    return false;
  }
}

async function acquire(meta = {}) {
  if (!isEnabled()) return { skipped: true };
  if (_held && !_held.skipped && !_held.released) {
    _held.depth = (_held.depth || 1) + 1;
    return _held;
  }
  const kind = String(meta.kind || "heavy_nav").slice(0, 40);
  const nome = String(meta.nome || "").slice(0, 120);
  const t0 = Date.now();
  while ((Date.now() - t0) < ACQUIRE_MS) {
    recoverStale();
    try {
      fs.mkdirSync(DADOS_DIR, { recursive: true });
      const fd = fs.openSync(LOCK_PATH, "wx");
      const rec = {
        pid: process.pid,
        ts: Date.now(),
        kind,
        nome,
        shard: String(process.env.WORKER_SHARD_INDEX || "")
      };
      try {
        fs.writeFileSync(fd, JSON.stringify(rec), "utf8");
        try { fs.fsyncSync(fd); } catch {}
      } catch {}
      try { fs.closeSync(fd); } catch {}
      const check = readLockMeta();
      if (!check || Number(check.ts) !== rec.ts || Number(check.pid) !== process.pid) {
        try { fs.unlinkSync(LOCK_PATH); } catch {}
        await sleep(POLL_MS);
        continue;
      }
      _held = { token: rec.ts, kind, nome, depth: 1 };
      audit({
        event: "connect_lane_acquire",
        kind,
        nome,
        waitMs: Date.now() - t0,
        failWindow: recentFailCount()
      });
      appendEvent({ type: "acquire", kind, nome, waitMs: Date.now() - t0 });
      return _held;
    } catch {
      await sleep(POLL_MS);
    }
  }
  audit({ event: "connect_lane_acquire_timeout", kind, nome, waitMs: Date.now() - t0 });
  appendEvent({ type: "acquire_timeout", kind, nome, waitMs: Date.now() - t0 });
  throw new Error("connect_lane_acquire_timeout");
}

async function release(handle) {
  const h = handle || _held;
  if (!h || h.skipped) return;
  if (h.depth && h.depth > 1) {
    h.depth -= 1;
    return;
  }
  if (h.released) return;
  h.released = true;
  const gap = gapMsNow();
  if (!_held || !handle || handle === _held || handle.token === _held.token) {
    _held = null;
  }
  try {
    const meta = readLockMeta();
    if (meta && Number(meta.pid) === process.pid && Number(meta.ts) === Number(h.token)) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {}
  audit({
    event: "connect_lane_release",
    kind: String(h.kind || ""),
    nome: String(h.nome || ""),
    gapMs: gap,
    failWindow: recentFailCount()
  });
  appendEvent({ type: "release", kind: String(h.kind || ""), nome: String(h.nome || ""), gapMs: gap });
  if (gap > 0) await sleep(gap);
}

async function withHeavyNav(meta, fn) {
  if (typeof fn !== "function") throw new Error("connect_lane_fn");
  if (!isEnabled()) return await fn();
  const h = await acquire(meta || {});
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|connect_lane_acquire_timeout/i.test(msg)) {
      noteFailure(msg.slice(0, 160));
    }
    throw e;
  } finally {
    await release(h);
  }
}

function bootSettleMs() {
  return BOOT_SETTLE_MS;
}

function bootSnapshot() {
  let strict = false;
  try { strict = gatewayProxy.isStrictProxyRequired() === true; } catch {}
  return {
    enabled: isEnabled(),
    armed: isArmed(),
    strictProxy: strict,
    gatewayFile: gatewayStateFileExists(),
    env: String(process.env.CONNECT_LANE || ""),
    acquireMs: ACQUIRE_MS,
    staleMs: STALE_MS,
    bootSettleMs: BOOT_SETTLE_MS,
    held: isHeld(),
    failWindow: recentFailCount()
  };
}

module.exports = {
  isEnabled,
  isArmed,
  isHeld,
  acquire,
  release,
  withHeavyNav,
  noteFailure,
  recentFailCount,
  markArmed,
  syncFromGatewayState,
  bootSnapshot,
  bootSettleMs
};
