"use strict";

/**
 * Faxina de heap do renderer (CDP) + higiene de listeners.
 * Nunca fecha browser, nunca desloga, nunca dá process.exit.
 * GC é individual, sequencial (mutex global) e com cooldown por conta.
 * NÃO chama removeAllListeners sem nome de evento — isso deixa o robô surdo.
 * GC usa sessão CDP efêmera (createCDPSession) para não enfileirar no _client() primário.
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

async function openGcSession(page) {
  if (page && typeof page.createCDPSession === "function") {
    const session = await page.createCDPSession();
    return { session, via: "createCDPSession", ephemeral: true };
  }
  const resolved = resolveCdpClient(page);
  if (resolved) return { session: resolved.client, via: resolved.via, ephemeral: false };
  throw new Error("no_cdp_client");
}

function makeDeadlineTimer(ms, label) {
  let timer = null;
  let settled = false;
  const p = new Promise((_, rej) => {
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rej(new Error(label || "gc_timeout"));
    }, Math.max(50, ms));
  });
  p.catch(() => {});
  p.clear = () => {
    settled = true;
    try { clearTimeout(timer); } catch {}
  };
  return p;
}

function detachLater(openP) {
  Promise.resolve(openP)
    .then((opened) => {
      try {
        if (opened && opened.ephemeral && opened.session && typeof opened.session.detach === "function") {
          return opened.session.detach();
        }
      } catch {}
      return null;
    })
    .catch(() => {});
}

function shouldRecoverCrashedPage({ isMain, alreadyClosed, browserConnected } = {}) {
  if (!isMain) return alreadyClosed ? "none" : "close_tab";
  if (alreadyClosed && !browserConnected) return "none";
  return "annihilate";
}

function isPuppeteerPageCrash(err) {
  return /page crashed/i.test(String((err && err.message) || err || ""));
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
    if (nome) {
      const last = Number(lastFaxinaAtByNome.get(nome) || 0) || 0;
      if (last && (Date.now() - last) < DEFAULT_COOLDOWN_MS) {
        return { ok: false, skipped: true, reason: "cooldown", nome };
      }
    }
    let session = null;
    let ephemeral = false;
    let via = null;
    const deadline = Date.now() + GC_TIMEOUT_MS;
    const leftMs = () => Math.max(50, deadline - Date.now());
    const openP = openGcSession(page);
    const openT = makeDeadlineTimer(leftMs(), "gc_session_timeout");
    let sendT = null;
    try {
      const opened = await Promise.race([openP, openT]);
      openT.clear();
      session = opened.session;
      ephemeral = !!opened.ephemeral;
      via = opened.via;
      if (!session || typeof session.send !== "function") throw new Error("no_cdp_client");
      const sendP = session.send("HeapProfiler.collectGarbage");
      sendP.catch(() => {});
      sendT = makeDeadlineTimer(leftMs(), "gc_timeout");
      await Promise.race([sendP, sendT]);
      sendT.clear();
      if (nome) lastFaxinaAtByNome.set(nome, Date.now());
      return { ok: true, via, nome, reason };
    } catch (e) {
      if (!session) detachLater(openP);
      return {
        ok: false,
        error: String((e && e.message) || e || "gc_fail").slice(0, 180),
        nome,
        reason
      };
    } finally {
      try { openT.clear(); } catch {}
      try { if (sendT) sendT.clear(); } catch {}
      if (ephemeral && session && typeof session.detach === "function") {
        try { await session.detach(); } catch {}
      }
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
  shouldRecoverCrashedPage,
  isPuppeteerPageCrash,
  _resetForTests
};
