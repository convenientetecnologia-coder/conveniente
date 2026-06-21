"use strict";

const fs = require("fs");
const path = require("path");
const serverConfig = require("./serverConfig.js");
const logger = require("./logger.js");
const provisionAudit = require("./provisionAudit.js");

const LOOP_MS = 30000;
const STATE_PATH = path.join(__dirname, "..", "dados", "daily_window_scheduler_state.json");
const OPEN_VERIFY_ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.DAILY_WINDOW_OPEN_VERIFY_ENABLED || "1").trim());
const OPEN_VERIFY_REQUIRE_WORKING = !/^(0|false|no|off)$/i.test(String(process.env.DAILY_WINDOW_OPEN_REQUIRE_WORKING || "1").trim());
const OPEN_VERIFY_TIMEOUT_MS = Math.max(60_000, Number(process.env.DAILY_WINDOW_OPEN_VERIFY_TIMEOUT_MS || (30 * 60 * 1000)) || (30 * 60 * 1000));
const OPEN_VERIFY_POLL_MS = Math.max(1_000, Number(process.env.DAILY_WINDOW_OPEN_VERIFY_POLL_MS || 5_000) || 5_000);
const OPEN_VERIFY_RETRY_MAX = Math.max(1, Number(process.env.DAILY_WINDOW_OPEN_VERIFY_RETRY_MAX || 2) || 2);

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
    nextCloseAt: 0,
    nextOpenAt: 0,
    scheduleSignature: "",
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

function localMidnightTs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hmToMin(h, m) {
  const hh = Math.max(0, Math.min(23, Math.floor(Number(h) || 0)));
  const mm = Math.max(0, Math.min(59, Math.floor(Number(m) || 0)));
  return (hh * 60) + mm;
}

function randomBetweenMs(startMs, endMs) {
  const s = Number(startMs) || 0;
  const e = Number(endMs) || 0;
  if (e <= s) return s;
  const span = e - s;
  return s + Math.floor(Math.random() * (span + 1));
}

function computeNextRandomAtFromWindow({ nowTs, startMin, endMin, skipCurrentInterval = false }) {
  const dayMs = 24 * 60 * 60 * 1000;
  const baseMidnight = localMidnightTs(nowTs);
  const crossesMidnight = endMin <= startMin;
  const intervals = [];
  for (let offset = -1; offset <= 3; offset += 1) {
    const start = baseMidnight + (offset * dayMs) + (startMin * 60000);
    const end = baseMidnight + (offset * dayMs) + (endMin * 60000) + (crossesMidnight ? dayMs : 0);
    intervals.push({ start, end });
  }
  intervals.sort((a, b) => a.start - b.start);
  const leadMs = 5000;
  const minTs = nowTs + leadMs;
  for (const interval of intervals) {
    if (interval.end < minTs) continue;
    if (skipCurrentInterval && interval.start <= minTs && minTs <= interval.end) continue;
    const fromTs = Math.max(interval.start, minTs);
    if (fromTs <= interval.end) return randomBetweenMs(fromTs, interval.end);
  }
  return nowTs + (60 * 60 * 1000);
}

function getDailyWindowMeta(dw) {
  const closeWindowStartMin = hmToMin(dw.closeWindowStartHour, dw.closeWindowStartMinute);
  const closeWindowEndMin = hmToMin(dw.closeWindowEndHour, dw.closeWindowEndMinute);
  const openWindowStartMin = hmToMin(dw.openWindowStartHour, dw.openWindowStartMinute);
  const openWindowEndMin = hmToMin(dw.openWindowEndHour, dw.openWindowEndMinute);
  const signature = [
    closeWindowStartMin, closeWindowEndMin,
    openWindowStartMin, openWindowEndMin
  ].join("|");
  return {
    closeWindowStartMin,
    closeWindowEndMin,
    openWindowStartMin,
    openWindowEndMin,
    signature
  };
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

async function runCloseRoutine() {
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
  saveState({ lastCloseAt: now(), lastError: null });
  return { ok: true };
}

async function runOpenRoutine() {
  const readProgress = async () => {
    const st = await httpJson(`http://127.0.0.1:${localPort}/api/status`, null, 90_000);
    const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    const total = perfis.length;
    const active = perfis.filter((p) => p && p.active === true).length;
    const working = perfis.filter((p) => p && p.trabalhando === true).length;
    const openAll = (st && st.openAll && typeof st.openAll === "object") ? st.openAll : null;
    return { total, active, working, openAll };
  };

  const waitOpenConverged = async ({ targetTotal, requireWorking, timeoutMs, pollMs }) => {
    const t0 = now();
    let peakActive = 0;
    let peakWorking = 0;
    let lastProgressAt = t0;
    let last = null;
    while ((now() - t0) < timeoutMs) {
      const snap = await readProgress();
      last = snap;
      if (snap.active > peakActive || snap.working > peakWorking) {
        peakActive = Math.max(peakActive, snap.active);
        peakWorking = Math.max(peakWorking, snap.working);
        lastProgressAt = now();
      }
      const activeOk = snap.active >= targetTotal;
      const workingOk = !requireWorking || (snap.working >= targetTotal);
      if (activeOk && workingOk) {
        return {
          ok: true,
          total: snap.total,
          active: snap.active,
          working: snap.working,
          peakActive,
          peakWorking,
          elapsedMs: now() - t0
        };
      }
      await sleep(pollMs);
    }
    return {
      ok: false,
      error: "open_all_not_converged",
      total: last ? last.total : 0,
      active: last ? last.active : 0,
      working: last ? last.working : 0,
      peakActive,
      peakWorking,
      elapsedMs: now() - t0,
      stalledMs: Math.max(0, now() - lastProgressAt),
      openAllState: (last && last.openAll) ? {
        active: !!last.openAll.active,
        lastError: last.openAll.lastError ? String(last.openAll.lastError) : null,
        partial: !!last.openAll.partial,
        partialReason: last.openAll.partialReason ? String(last.openAll.partialReason) : null
      } : null
    };
  };

  const verifyEnabled = OPEN_VERIFY_ENABLED;
  const requireWorking = OPEN_VERIFY_REQUIRE_WORKING;
  const attempts = [];
  for (let attempt = 1; attempt <= OPEN_VERIFY_RETRY_MAX; attempt += 1) {
    const r = await httpJson(`http://127.0.0.1:${localPort}/api/perfis/open-all-24h`, {}, 5 * 60 * 1000);
    if (!r || r.ok !== true) {
      return { ok: false, error: (r && r.error) ? String(r.error) : "open_all_failed", attempt };
    }
    const targetTotal = Math.max(0, Number(r && r.total) || 0);
    let verify = {
      ok: true,
      total: targetTotal,
      active: targetTotal,
      working: targetTotal,
      elapsedMs: 0
    };
    if (verifyEnabled) {
      verify = await waitOpenConverged({
        targetTotal,
        requireWorking,
        timeoutMs: OPEN_VERIFY_TIMEOUT_MS,
        pollMs: OPEN_VERIFY_POLL_MS
      });
    }
    attempts.push({ attempt, targetTotal, verify });
    try {
      provisionAudit.append({
        ts: now(),
        event: "daily_window_open_verify_attempt",
        attempt,
        targetTotal,
        verifyOk: !!verify.ok,
        active: Number(verify.active || 0) || 0,
        working: Number(verify.working || 0) || 0,
        elapsedMs: Number(verify.elapsedMs || 0) || 0,
        error: verify && verify.error ? String(verify.error) : null
      });
    } catch {}
    if (verify.ok) {
      saveState({ lastOpenAt: now(), lastError: null });
      return {
        ok: true,
        attempt,
        targetTotal,
        verifyEnabled,
        requireWorking,
        active: Number(verify.active || 0) || 0,
        working: Number(verify.working || 0) || 0,
        elapsedMs: Number(verify.elapsedMs || 0) || 0,
        attempts
      };
    }
    if (attempt < OPEN_VERIFY_RETRY_MAX) {
      await sleep(3_000);
    }
  }
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  return {
    ok: false,
    error: lastAttempt && lastAttempt.verify && lastAttempt.verify.error
      ? String(lastAttempt.verify.error)
      : "open_all_not_converged",
    verifyEnabled,
    requireWorking,
    attempts
  };
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = serverConfig.readServerConfigEffective({});
    const dw = (cfg && cfg.dailyWindow) ? cfg.dailyWindow : {};
    const mode = String(dw.executionMode || "").trim().toLowerCase();
    const windowModeEnabled = (mode === "window_close_open") && dw.enabled === true;
    if (!windowModeEnabled) {
      const cur = state || loadState();
      if (Number(cur.nextCloseAt || 0) > 0 || Number(cur.nextOpenAt || 0) > 0 || String(cur.scheduleSignature || "").length) {
        saveState({ nextCloseAt: 0, nextOpenAt: 0, scheduleSignature: "", inProgress: false });
      }
      return;
    }

    const nowTs = now();
    const meta = getDailyWindowMeta(dw);
    const cur = state || loadState();
    const changedSchedule = String(cur.scheduleSignature || "") !== String(meta.signature || "");
    if (changedSchedule) {
      cur.nextCloseAt = computeNextRandomAtFromWindow({
        nowTs,
        startMin: meta.closeWindowStartMin,
        endMin: meta.closeWindowEndMin
      });
      cur.nextOpenAt = computeNextRandomAtFromWindow({
        nowTs,
        startMin: meta.openWindowStartMin,
        endMin: meta.openWindowEndMin
      });
      cur.scheduleSignature = meta.signature;
      saveState({
        nextCloseAt: cur.nextCloseAt,
        nextOpenAt: cur.nextOpenAt,
        scheduleSignature: cur.scheduleSignature
      });
    } else {
      if (!Number(cur.nextCloseAt) || Number(cur.nextCloseAt) < (nowTs - 60 * 1000)) {
        cur.nextCloseAt = computeNextRandomAtFromWindow({
          nowTs,
          startMin: meta.closeWindowStartMin,
          endMin: meta.closeWindowEndMin
        });
        saveState({ nextCloseAt: cur.nextCloseAt });
      }
      if (!Number(cur.nextOpenAt) || Number(cur.nextOpenAt) < (nowTs - 60 * 1000)) {
        cur.nextOpenAt = computeNextRandomAtFromWindow({
          nowTs,
          startMin: meta.openWindowStartMin,
          endMin: meta.openWindowEndMin
        });
        saveState({ nextOpenAt: cur.nextOpenAt });
      }
    }

    const dueClose = Number(cur.nextCloseAt || 0) > 0 && nowTs >= Number(cur.nextCloseAt || 0);
    const dueOpen = Number(cur.nextOpenAt || 0) > 0 && nowTs >= Number(cur.nextOpenAt || 0);

    if (dueClose) {
      saveState({ inProgress: true });
      const rr = await runCloseRoutine();
      const nextCloseAt = computeNextRandomAtFromWindow({
        nowTs: now(),
        startMin: meta.closeWindowStartMin,
        endMin: meta.closeWindowEndMin,
        skipCurrentInterval: true
      });
      saveState({
        inProgress: false,
        nextCloseAt,
        lastError: rr && rr.ok === true ? null : ((rr && rr.error) ? rr.error : "close_unknown_error")
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_close",
          ok: !!(rr && rr.ok === true),
          error: rr && rr.error ? String(rr.error) : null,
          nextCloseAt
        });
      } catch {}
      if (!rr.ok) logger.warn("[DAILY-WINDOW] close falhou", rr || {});
      return;
    }
    if (dueOpen) {
      saveState({ inProgress: true });
      const rr = await runOpenRoutine();
      const nextOpenAt = computeNextRandomAtFromWindow({
        nowTs: now(),
        startMin: meta.openWindowStartMin,
        endMin: meta.openWindowEndMin,
        skipCurrentInterval: true
      });
      saveState({
        inProgress: false,
        nextOpenAt,
        lastError: rr && rr.ok === true ? null : ((rr && rr.error) ? rr.error : "open_unknown_error")
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_open",
          ok: !!(rr && rr.ok === true),
          error: rr && rr.error ? String(rr.error) : null,
          nextOpenAt,
          verifyEnabled: !!(rr && rr.verifyEnabled),
          requireWorking: !!(rr && rr.requireWorking),
          attempt: Number(rr && rr.attempt || 0) || 0,
          active: Number(rr && rr.active || 0) || 0,
          working: Number(rr && rr.working || 0) || 0,
          elapsedMs: Number(rr && rr.elapsedMs || 0) || 0
        });
      } catch {}
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

