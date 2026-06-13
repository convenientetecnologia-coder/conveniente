"use strict";

const fs = require("fs");
const path = require("path");
const serverConfig = require("./serverConfig.js");
const logger = require("./logger.js");
const provisionAudit = require("./provisionAudit.js");

const LOOP_MS = 30000;
const STATE_PATH = path.join(__dirname, "..", "dados", "daily_window_scheduler_state.json");

let timer = null;
let inFlight = false;
let localPort = Number(process.env.PORT || 8088) || 8088;
let state = null;

function now() { return Date.now(); }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJsonSafe(fp, fallback = null) {
  try { return JSON.parse(String(fs.readFileSync(fp, "utf8") || "")); } catch { return fallback; }
}

function writeJsonAtomic(fp, obj) {
  ensureDirSync(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, fp);
}

function buildDefaultState() {
  return {
    version: 1,
    updatedAt: now(),
    inProgress: false,
    lastCloseAt: 0,
    lastOpenAt: 0,
    lastCloseKey: "",
    lastOpenKey: "",
    lastError: null
  };
}

function loadState() {
  const j = readJsonSafe(STATE_PATH, null);
  return (j && typeof j === "object") ? { ...buildDefaultState(), ...j } : buildDefaultState();
}

function saveState(patch = null) {
  state = { ...(state || buildDefaultState()), ...(patch || {}), updatedAt: now() };
  writeJsonAtomic(STATE_PATH, state);
  return state;
}

async function httpJson(url, body = null, timeoutMs = 180000) {
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "x-operator": "daily_window_scheduler" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    return await r.json().catch(() => null);
  } finally {
    clearTimeout(t);
  }
}

function getNowDateMeta() {
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const minutes = d.getHours() * 60 + d.getMinutes();
  return { key, minutes };
}

async function listActiveNames() {
  const st = await httpJson(`http://127.0.0.1:${localPort}/api/status`, null, 60000);
  const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
  return perfis.filter((p) => p && p.active === true).map((p) => String(p && p.nome || "").trim()).filter(Boolean);
}

async function waitAllClosed({ timeoutMs = 8 * 60 * 1000 } = {}) {
  const t0 = now();
  while ((now() - t0) < timeoutMs) {
    const active = await listActiveNames();
    if (!active.length) return { ok: true, activeRemaining: [] };
    await sleep(1500);
  }
  const activeRemaining = await listActiveNames();
  return { ok: activeRemaining.length === 0, activeRemaining };
}

async function runCloseRoutine({ dayKey }) {
  const first = await httpJson(`http://127.0.0.1:${localPort}/api/perfis/close-all`, {}, 20 * 60 * 1000);
  if (!first || first.ok !== true) {
    return { ok: false, error: (first && first.error) ? String(first.error) : "close_all_failed" };
  }
  let verify = await waitAllClosed({});
  if (!verify.ok) {
    // Segunda passada para contas remanescentes (best-effort robusto).
    await httpJson(`http://127.0.0.1:${localPort}/api/perfis/close-all`, { origin: "daily_window_retry" }, 20 * 60 * 1000);
    verify = await waitAllClosed({});
  }
  if (!verify.ok) {
    return {
      ok: false,
      error: "close_all_not_fully_closed",
      activeRemaining: verify.activeRemaining
    };
  }
  saveState({ lastCloseAt: now(), lastCloseKey: dayKey, lastError: null });
  return { ok: true };
}

async function runOpenRoutine({ dayKey }) {
  const r = await httpJson(`http://127.0.0.1:${localPort}/api/perfis/open-all-24h`, {}, 5 * 60 * 1000);
  if (!r || r.ok !== true) {
    return { ok: false, error: (r && r.error) ? String(r.error) : "open_all_failed" };
  }
  saveState({ lastOpenAt: now(), lastOpenKey: dayKey, lastError: null });
  return { ok: true };
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = serverConfig.readServerConfigEffective({});
    const dw = (cfg && cfg.dailyWindow) ? cfg.dailyWindow : {};
    if (dw.enabled !== true) return;

    const closeTargetMin = (Number(dw.closeHour || 0) * 60) + Number(dw.closeMinute || 0);
    const openTargetMin = (Number(dw.openHour || 0) * 60) + Number(dw.openMinute || 0);
    const meta = getNowDateMeta();
    const cur = state || loadState();
    // Janela diária padrão (aberto no intervalo [open, close), fechado fora dele).
    const inOpenWindow = meta.minutes >= openTargetMin && meta.minutes < closeTargetMin;
    const inCloseWindow = !inOpenWindow;
    const dueClose = inCloseWindow && cur.lastCloseKey !== meta.key;
    const dueOpen = inOpenWindow && cur.lastOpenKey !== meta.key;

    if (dueClose) {
      saveState({ inProgress: true });
      const rr = await runCloseRoutine({ dayKey: meta.key });
      saveState({ inProgress: false, lastError: rr && rr.ok === true ? null : ((rr && rr.error) ? rr.error : "close_unknown_error") });
      try { provisionAudit.append({ ts: now(), event: "daily_window_close", ok: !!(rr && rr.ok === true), error: rr && rr.error ? String(rr.error) : null }); } catch {}
      if (!rr.ok) logger.warn("[DAILY-WINDOW] close falhou", rr || {});
      return;
    }
    if (dueOpen) {
      saveState({ inProgress: true });
      const rr = await runOpenRoutine({ dayKey: meta.key });
      saveState({ inProgress: false, lastError: rr && rr.ok === true ? null : ((rr && rr.error) ? rr.error : "open_unknown_error") });
      try { provisionAudit.append({ ts: now(), event: "daily_window_open", ok: !!(rr && rr.ok === true), error: rr && rr.error ? String(rr.error) : null }); } catch {}
      if (!rr.ok) logger.warn("[DAILY-WINDOW] open falhou", rr || {});
    }
  } catch (e) {
    try { saveState({ inProgress: false, lastError: (e && e.message) ? String(e.message) : String(e) }); } catch {}
  } finally {
    inFlight = false;
  }
}

function startDailyWindowScheduler({ port } = {}) {
  localPort = Number(port || localPort || 8088) || 8088;
  state = loadState();
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, LOOP_MS);
  try { if (typeof timer.unref === "function") timer.unref(); } catch {}
  tick().catch(() => {});
}

function stopDailyWindowScheduler() {
  if (!timer) return;
  try { clearInterval(timer); } catch {}
  timer = null;
}

module.exports = {
  startDailyWindowScheduler,
  stopDailyWindowScheduler
};

