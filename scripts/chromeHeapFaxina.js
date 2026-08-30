"use strict";

/**
 * Faxina de heap do renderer (CDP) + higiene de listeners.
 * Nunca fecha browser, nunca desloga, nunca dá process.exit.
 * GC é individual, sequencial (mutex global) e com cooldown por conta.
 * NÃO chama page.removeAllListeners() sem nome de evento — isso deixa o robô surdo.
 */

const SAFE_MAX_LISTENERS = 32;
const DEFAULT_COOLDOWN_MS = Math.max(
  20_000,
  Number(process.env.OXY_FAXINA_COOLDOWN_MS || 60_000) || 60_000
);
const GC_TIMEOUT_MS = Math.max(
  1500,
  Math.min(8000, Number(process.env.OXY_FAXINA_TIMEOUT_MS || 4000) || 4000)
);

const lastFaxinaAtByNome = new Map();
let faxinaTail = Promise.resolve();

function elevateMaxListeners(emitter, ceiling = SAFE_MAX_LISTENERS) {
  if (!emitter || typeof emitter.setMaxListeners !== "function") return false;
  try {
    const cur = typeof emitter.getMaxListeners === "function"
      ? Number(emitter.getMaxListeners())
      : 10;
    if (!Number.isFinite(cur)) return false;
    if (cur === 0 || cur >= ceiling) return true;
    emitter.setMaxListeners(ceiling);
    return true;
  } catch {
    return false;
  }
}

function sanitizeListenCycle(emitter, eventNames) {
  if (!emitter || typeof emitter.removeAllListeners !== "function") return 0;
  const names = Array.isArray(eventNames) ? eventNames : [];
  let n = 0;
  for (const ev of names) {
    const key = String(ev || "").trim();
    if (!key) continue;
    try {
      emitter.removeAllListeners(key);
      n += 1;
    } catch {}
  }
  return n;
}

function resolveCdpClient(page) {
  try {
    if (page && typeof page._client === "function") {
      const c = page._client();
      if (c && typeof c.send === "function") return { client: c, via: "page._client()" };
    }
  } catch {}
  try {
    if (page && page._client && typeof page._client.send === "function") {
      return { client: page._client, via: "page._client.send" };
    }
  } catch {}
  return null;
}

function pageIsUsable(page) {
  try {
    if (!page) return false;
    if (typeof page.isClosed === "function" && page.isClosed()) return false;
  } catch {
    return false;
  }
  try {
    if (page.__virtusDeltaReplyInFlight) return false;
    if (page.__oxyCrashed) return false;
  } catch {}
  return true;
}

async function sendCollectGarbage(page) {
  const resolved = resolveCdpClient(page);
  if (resolved) {
    await resolved.client.send("HeapProfiler.collectGarbage");
    return { via: resolved.via };
  }
  if (!page || typeof page.createCDPSession !== "function") {
    throw new Error("no_cdp_client");
  }
  const session = await page.createCDPSession();
  try {
    await session.send("HeapProfiler.collectGarbage");
    return { via: "createCDPSession" };
  } finally {
    try {
      if (session && typeof session.detach === "function") await session.detach();
    } catch {}
  }
}

function enqueueSerial(fn) {
  const run = faxinaTail.then(fn, fn);
  faxinaTail = run.then(() => {}, () => {});
  return run;
}

async function collectPageGarbage(page, opts = {}) {
  const nome = String((opts && opts.nome) || "").trim();
  const reason = String((opts && opts.reason) || "").trim() || "cycle";
  const now = Date.now();
  if (!pageIsUsable(page)) return { ok: false, skipped: true, reason: "page_busy_or_closed", nome };
  if (nome) {
    const last = Number(lastFaxinaAtByNome.get(nome) || 0) || 0;
    if (last && (now - last) < DEFAULT_COOLDOWN_MS) {
      return { ok: false, skipped: true, reason: "cooldown", nome };
    }
  }

  return enqueueSerial(async () => {
    if (!pageIsUsable(page)) return { ok: false, skipped: true, reason: "page_busy_or_closed", nome };
    try {
      const raced = await Promise.race([
        sendCollectGarbage(page),
        new Promise((_, rej) => {
          setTimeout(() => rej(new Error("gc_timeout")), GC_TIMEOUT_MS);
        })
      ]);
      if (nome) lastFaxinaAtByNome.set(nome, Date.now());
      return { ok: true, via: raced && raced.via, nome, reason };
    } catch (e) {
      return {
        ok: false,
        error: String((e && e.message) || e || "gc_fail").slice(0, 180),
        nome,
        reason
      };
    }
  });
}

function logFaxinaOk(nome) {
  const who = String(nome || "").trim() || "?";
  try {
    console.log(`[OXY-LOG] [FAXINA-CDP] Garbage Collector executado com sucesso na conta ${who}`);
  } catch {}
}

function attachErrorSink(page) {
  if (!page || page.__oxyErrorSinkAttached) return false;
  try {
    page.__oxyErrorSinkAttached = true;
    elevateMaxListeners(page);
    page.on("error", () => {
      try { page.__oxyCrashed = true; } catch {}
    });
    return true;
  } catch {
    return false;
  }
}

function _resetForTests() {
  lastFaxinaAtByNome.clear();
  faxinaTail = Promise.resolve();
}

module.exports = {
  SAFE_MAX_LISTENERS,
  DEFAULT_COOLDOWN_MS,
  elevateMaxListeners,
  sanitizeListenCycle,
  resolveCdpClient,
  pageIsUsable,
  collectPageGarbage,
  logFaxinaOk,
  attachErrorSink,
  _resetForTests
};
