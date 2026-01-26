// scripts/provisionLock.js
// Lock global (cross-process) para isolamento durante stock_provision.
// Implementação via arquivo com TTL: tolera crash e evita "lock infinito".

"use strict";

const fs = require("fs");
const path = require("path");

const LOCK_PATH = path.join(__dirname, "..", "dados", "provision_lock.json");
// Hard safety: mesmo que alguém grave um lock inválido (sem untilMs),
// não pode virar "lock infinito" e bloquear Robe/Virtus por horas.
const HARD_MAX_TTL_MS = 60 * 60 * 1000; // 60min
// Hardening: lock pode incluir pid (auto-recover pós-crash).
// IMPORTANTE: compat com lock antigo (sem pid) DEVE ser mantida para evitar "desencontro" entre versões
// (um lado cria lock sem pid e o outro invalidaria e liberaria no meio do provision).
// Portanto, por padrão NÃO exigimos pid; apenas usamos pid quando existir.
const REQUIRE_PID = String(process.env.PROVISION_LOCK_REQUIRE_PID || '0').trim() !== '0';

function now() { return Date.now(); }

function _isPidAlive(pid) {
  try {
    const n = Number(pid || 0) || 0;
    if (!n || !Number.isFinite(n)) return false;
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

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
  const n = now();
  const owner = String(cur.owner || '').trim();
  const since = Number(cur.sinceMs || 0) || 0;
  const until = Number(cur.untilMs || 0) || 0;
  const pid = Number(cur.pid || (cur.meta && cur.meta.pid) || 0) || 0;

  // Se o arquivo existe, mas está inválido/corrompido (ex.: sem untilMs),
  // trate como expirado e limpe imediatamente.
  const invalid =
    !owner ||
    since <= 0 ||
    until <= 0 ||
    until <= since ||
    (until - since) > HARD_MAX_TTL_MS ||
    (REQUIRE_PID && (!pid || pid <= 0));

  // Auto-recover: se tem pid mas o processo morreu (crash), não pode bloquear o sistema.
  // Se não há pid, NUNCA faça auto-unlock por esse critério (compat entre versões).
  if (!invalid && pid > 0 && !_isPidAlive(pid)) {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    return { active: false, lock: null };
  }

  if (invalid || until <= n) {
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    return { active: false, lock: null };
  }

  return { active: true, lock: cur };
}

function isActive() {
  return get().active;
}

function ownerMatchesOperator(lock, operator) {
  try {
    const op = String(operator || '').trim();
    if (!op) return false;
    const owner = String(lock && lock.owner || '').trim();
    if (!owner) return false;
    return owner === op;
  } catch { return false; }
}

// Regra enterprise: somente o DONO do lock passa. Todo o resto recebe maintenance_provision.
function shouldBlock(operator) {
  const cur = get();
  if (!cur || !cur.active) return { block: false, lock: null };
  if (ownerMatchesOperator(cur.lock, operator)) return { block: false, lock: cur.lock };
  return { block: true, lock: cur.lock };
}

function tryAcquire({ owner, ttlMs = 9 * 60 * 1000, meta } = {}) {
  const o = String(owner || "").trim();
  if (!o) return { ok: false, error: "missing_owner" };
  const cur = get();
  if (cur.active) {
    // Enterprise: permitir reentrância por "token" (owner string) entre processos.
    // Ex.: dashboard (stock_provision:<batchId>) segura o lock e o worker (login_remediate) deve poder rodar
    // sob o MESMO owner sem "busy", evitando fechar/reabrir e divergência de fluxos.
    if (ownerMatchesOperator(cur.lock, o)) {
      // Opcional: estender TTL se solicitado (evita expirar no meio do pipeline).
      try {
        const wantTtl = Math.max(10_000, Number(ttlMs) || 0);
        const wantUntil = now() + wantTtl;
        const curUntil = Number(cur.lock && cur.lock.untilMs || 0) || 0;
        if (wantUntil > curUntil) {
          const next = { ...(cur.lock || {}) };
          next.untilMs = wantUntil;
          // hard safety (não permite TTL infinito)
          if (next.sinceMs && next.untilMs && (next.untilMs - next.sinceMs) > HARD_MAX_TTL_MS) {
            next.untilMs = next.sinceMs + HARD_MAX_TTL_MS;
          }
          _writeJsonAtomic(LOCK_PATH, next);
          return { ok: true, lock: next, reentrant: true, extended: true };
        }
      } catch {}
      return { ok: true, lock: cur.lock, reentrant: true, extended: false };
    }
    return { ok: false, error: "busy", lock: cur.lock };
  }
  const t = Math.max(10_000, Number(ttlMs) || 0);
  const lock = {
    owner: o,
    sinceMs: now(),
    untilMs: now() + t,
    // pid do processo que adquiriu o lock (auto-recover pós-crash)
    pid: process.pid,
    meta: (meta && typeof meta === "object") ? { ...meta, pid: process.pid } : { pid: process.pid }
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
  ownerMatchesOperator,
  shouldBlock,
  tryAcquire,
  release
};

