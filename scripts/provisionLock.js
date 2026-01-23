// scripts/provisionLock.js
// Lock global (cross-process) para isolamento durante stock_provision.
// Implementação via arquivo com TTL: tolera crash e evita "lock infinito".

"use strict";

const fs = require("fs");
const path = require("path");

const LOCK_PATH = path.join(__dirname, "..", "dados", "provision_lock.json");

function now() { return Date.now(); }

function _readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function _writeJsonAtomic(p, obj) {
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = `${p}.${process.pid}.${now()}.tmp`;
  const txt = JSON.stringify(obj, null, 2);
  fs.writeFileSync(tmp, txt, "utf8");
  fs.renameSync(tmp, p);
}

function get() {
  const cur = _readJsonSafe(LOCK_PATH);
  if (!cur) return { active: false, lock: null };
  const until = Number(cur.untilMs || 0) || 0;
  if (until > 0 && until <= now()) {
    // expirado: limpa
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    return { active: false, lock: null };
  }
  return { active: true, lock: cur };
}

function isActive() {
  return get().active;
}

function tryAcquire({ owner, ttlMs = 9 * 60 * 1000, meta } = {}) {
  const o = String(owner || "").trim();
  if (!o) return { ok: false, error: "missing_owner" };
  const cur = get();
  if (cur.active) return { ok: false, error: "busy", lock: cur.lock };
  const t = Math.max(10_000, Number(ttlMs) || 0);
  const lock = {
    owner: o,
    sinceMs: now(),
    untilMs: now() + t,
    meta: (meta && typeof meta === "object") ? meta : null
  };
  try {
    _writeJsonAtomic(LOCK_PATH, lock);
    return { ok: true, lock };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

function release({ owner, force = false } = {}) {
  const cur = get();
  if (!cur.active) return { ok: true, released: false };
  const o = String(owner || "").trim();
  if (!force && o && cur.lock && cur.lock.owner && String(cur.lock.owner) !== o) {
    return { ok: false, error: "not_owner", lock: cur.lock };
  }
  try { fs.unlinkSync(LOCK_PATH); } catch {}
  return { ok: true, released: true };
}

module.exports = {
  LOCK_PATH,
  get,
  isActive,
  tryAcquire,
  release
};

