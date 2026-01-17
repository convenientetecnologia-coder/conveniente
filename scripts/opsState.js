// scripts/opsState.js
// Estado em memória (process-local) para operações em massa (ex.: close-all).
// Objetivo: o painel web refletir ações mesmo quando foram disparadas remotamente.

const OPS = new Map(); // key -> { running, startedAt, updatedAt, endedAt, ... }

function now() { return Date.now(); }

function getOps() {
  const out = {};
  for (const [k, v] of OPS.entries()) out[k] = v;
  return out;
}

function begin(key, meta = {}) {
  const k = String(key || '').trim();
  if (!k) return;
  OPS.set(k, { running: true, startedAt: now(), updatedAt: now(), endedAt: null, ...meta });
}

function update(key, patch = {}) {
  const k = String(key || '').trim();
  if (!k) return;
  const cur = OPS.get(k) || { running: true, startedAt: now(), updatedAt: now(), endedAt: null };
  OPS.set(k, { ...cur, ...patch, running: true, updatedAt: now() });
}

function finish(key, patch = {}) {
  const k = String(key || '').trim();
  if (!k) return;
  const cur = OPS.get(k) || { startedAt: now() };
  OPS.set(k, { ...cur, ...patch, running: false, endedAt: now(), updatedAt: now() });
  // Auto-expira depois de 2 minutos (só para UI mostrar "acabou")
  setTimeout(() => {
    try {
      const c = OPS.get(k);
      if (c && c.running === false && (now() - Number(c.endedAt || 0)) > 110000) OPS.delete(k);
    } catch {}
  }, 120000).unref?.();
}

module.exports = { getOps, begin, update, finish };

