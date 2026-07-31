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

function todayKeySaoPaulo(ts = Date.now()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ts));
  } catch {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}

function buildDefaultState() {
  return {
    version: 2,
    updatedAt: now(),
    inProgress: false,
    inProgressKind: null, // "close" | "open" | null
    lastCloseAt: 0,
    lastOpenAt: 0,
    // Idempotência diária (America/Sao_Paulo): 1 close/renew e 1 open por dia civil.
    // Claim ANTES da rotina — restart no meio NÃO re-dispara nem re-zera renovados.
    lastCloseDay: null,
    lastOpenDay: null,
    closeClaimedAt: 0,
    openClaimedAt: 0,
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

async function runCloseAllOnly({ origin = "daily_window_close_only" } = {}) {
  const first = await httpJson(
    `http://127.0.0.1:${localPort}/api/perfis/close-all`,
    { origin: String(origin || "daily_window_close_only").slice(0, 80) },
    20 * 60 * 1000
  );
  if (!first || first.ok !== true) {
    return { ok: false, error: (first && first.error) ? String(first.error) : "close_all_failed" };
  }
  let verify = await waitAllClosed({});
  if (!verify.ok) {
    await httpJson(
      `http://127.0.0.1:${localPort}/api/perfis/close-all`,
      { origin: `${String(origin || "daily_window").slice(0, 60)}_retry` },
      20 * 60 * 1000
    );
    verify = await waitAllClosed({});
  }
  if (!verify.ok) {
    return {
      ok: false,
      error: "close_all_not_fully_closed",
      activeRemaining: verify.activeRemaining
    };
  }
  return { ok: true };
}

async function runCloseRoutine({ renewFirst = false } = {}) {
  if (renewFirst) {
    // Renova classificados nos browsers abertos (1 conta/worker), depois fecha.
    // Timeout generoso: FB lento + dezenas/centenas de anúncios por conta.
    const renew = await httpJson(
      `http://127.0.0.1:${localPort}/api/perfis/renew-then-close`,
      {},
      4 * 60 * 60 * 1000
    );
    const renewErr = renew && renew.error ? String(renew.error) : "";
    // Outro renew-then-close ativo: NÃO atropelar com close-all (mataria o ciclo dono do lock).
    if (renewErr && /renew_then_close_lock_busy|lock_busy/i.test(renewErr)) {
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_renew_then_close_result",
          ok: false,
          error: renewErr.slice(0, 180),
          skippedCloseAll: true
        });
      } catch {}
      return { ok: false, error: "renew_then_close_lock_busy", renew };
    }
    if (!renew || renew.ok !== true) {
      // Mesmo se renew falhar parcialmente, ainda tenta fechar tudo (dormir).
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_renew_then_close_result",
          ok: false,
          error: (renew && renew.error) ? String(renew.error) : "renew_then_close_failed",
          renewedOk: Number(renew && renew.renewedOk || 0) || 0,
          renewedFail: Number(renew && renew.renewedFail || 0) || 0,
          renewedNone: Number(renew && renew.renewedNone || 0) || 0
        });
      } catch {}
    } else {
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_renew_then_close_result",
          ok: true,
          renewedOk: Number(renew.renewedOk || 0) || 0,
          renewedFail: Number(renew.renewedFail || 0) || 0,
          renewedNone: Number(renew.renewedNone || 0) || 0,
          closedOk: Number(renew.closedOk || 0) || 0
        });
      } catch {}
    }
    // renew-then-close já dispara close-all no final; ainda assim verificamos.
    let verifyRenew = await waitAllClosed({});
    if (!verifyRenew.ok) {
      await httpJson(`http://127.0.0.1:${localPort}/api/perfis/close-all`, { origin: "daily_window_renew_retry" }, 20 * 60 * 1000);
      verifyRenew = await waitAllClosed({});
    }
    if (!verifyRenew.ok) {
      return {
        ok: false,
        error: "close_all_not_fully_closed_after_renew",
        activeRemaining: verifyRenew.activeRemaining,
        renew
      };
    }
    saveState({ lastCloseAt: now(), lastError: null });
    return { ok: true, renewFirst: true, renew };
  }

  const closeOnly = await runCloseAllOnly({ origin: "daily_window_close" });
  if (!closeOnly.ok) return closeOnly;
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
    const windowModeEnabled =
      (mode === "window_close_open" || mode === "renew_window_close_open") && dw.enabled === true;
    if (!windowModeEnabled) {
      const cur = state || loadState();
      if (Number(cur.nextCloseAt || 0) > 0 || Number(cur.nextOpenAt || 0) > 0 || String(cur.scheduleSignature || "").length) {
        saveState({ nextCloseAt: 0, nextOpenAt: 0, scheduleSignature: "", inProgress: false, inProgressKind: null });
      }
      return;
    }

    const nowTs = now();
    const day = todayKeySaoPaulo(nowTs);
    const meta = getDailyWindowMeta(dw);
    // Sempre relê do disco: restart / outro processo podem ter claimado o dia.
    const cur = loadState();
    state = cur;

    // Migração suave v1→v2: se já fechou/abriu hoje (last*At) mas sem day-key, claima o dia
    // para NÃO re-disparar após deploy/restart no mesmo dia civil SP.
    let migrated = false;
    if (!cur.lastCloseDay && Number(cur.lastCloseAt || 0) > 0) {
      const closeDay = todayKeySaoPaulo(Number(cur.lastCloseAt));
      if (closeDay === day) {
        cur.lastCloseDay = closeDay;
        migrated = true;
      }
    }
    if (!cur.lastOpenDay && Number(cur.lastOpenAt || 0) > 0) {
      const openDay = todayKeySaoPaulo(Number(cur.lastOpenAt));
      if (openDay === day) {
        cur.lastOpenDay = openDay;
        migrated = true;
      }
    }
    if (migrated) {
      saveState({
        lastCloseDay: cur.lastCloseDay || null,
        lastOpenDay: cur.lastOpenDay || null,
        version: 2
      });
    }

    // Crash recovery: inProgress em disco sem processo vivo — limpa flag.
    // NÃO reexecuta close/open do dia se lastCloseDay/lastOpenDay já claimados.
    if (cur.inProgress === true) {
      const hadKind = cur.inProgressKind || null;
      const hadCloseDay = cur.lastCloseDay || null;
      const hadOpenDay = cur.lastOpenDay || null;
      saveState({ inProgress: false, inProgressKind: null });
      cur.inProgress = false;
      cur.inProgressKind = null;
      try {
        provisionAudit.append({
          ts: nowTs,
          event: "daily_window_stale_in_progress_cleared",
          day,
          hadKind,
          lastCloseDay: hadCloseDay,
          lastOpenDay: hadOpenDay
        });
      } catch {}
    }

    const closeDoneToday = String(cur.lastCloseDay || "") === day;
    const openDoneToday = String(cur.lastOpenDay || "") === day;

    const changedSchedule = String(cur.scheduleSignature || "") !== String(meta.signature || "");
    if (changedSchedule) {
      // Mudança de janela na config: reagenda horários, MAS preserva lastCloseDay/lastOpenDay
      // (não pode reabrir o ciclo do dia só porque o operador mexeu 1 minuto na janela).
      cur.nextCloseAt = computeNextRandomAtFromWindow({
        nowTs,
        startMin: meta.closeWindowStartMin,
        endMin: meta.closeWindowEndMin,
        skipCurrentInterval: closeDoneToday
      });
      cur.nextOpenAt = computeNextRandomAtFromWindow({
        nowTs,
        startMin: meta.openWindowStartMin,
        endMin: meta.openWindowEndMin,
        skipCurrentInterval: openDoneToday
      });
      cur.scheduleSignature = meta.signature;
      saveState({
        nextCloseAt: cur.nextCloseAt,
        nextOpenAt: cur.nextOpenAt,
        scheduleSignature: cur.scheduleSignature
      });
    } else {
      // next* no passado: NÃO sortear de novo na mesma janela se o dia já foi claimado
      // (era o buraco do restart do index.js → 2º/3º renew-then-close zerando renovados).
      if (!Number(cur.nextCloseAt) || Number(cur.nextCloseAt) < (nowTs - 60 * 1000)) {
        cur.nextCloseAt = computeNextRandomAtFromWindow({
          nowTs,
          startMin: meta.closeWindowStartMin,
          endMin: meta.closeWindowEndMin,
          skipCurrentInterval: closeDoneToday
        });
        saveState({ nextCloseAt: cur.nextCloseAt });
      }
      if (!Number(cur.nextOpenAt) || Number(cur.nextOpenAt) < (nowTs - 60 * 1000)) {
        cur.nextOpenAt = computeNextRandomAtFromWindow({
          nowTs,
          startMin: meta.openWindowStartMin,
          endMin: meta.openWindowEndMin,
          skipCurrentInterval: openDoneToday
        });
        saveState({ nextOpenAt: cur.nextOpenAt });
      }
    }

    const dueClose = Number(cur.nextCloseAt || 0) > 0 && nowTs >= Number(cur.nextCloseAt || 0);
    const dueOpen = Number(cur.nextOpenAt || 0) > 0 && nowTs >= Number(cur.nextOpenAt || 0);

    if (dueClose) {
      // Já rodou close/renew hoje (claim em disco) → nunca re-zera renovados.
      // Se restou browser aberto (crash no meio), só close-all residual SEM renew/reset.
      if (closeDoneToday) {
        let residual = null;
        try {
          const active = await listActiveNames();
          if (active.length) {
            residual = await runCloseAllOnly({ origin: "daily_window_close_residual_same_day" });
          } else {
            residual = { ok: true, skipped: true };
          }
        } catch (e) {
          residual = { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
        }
        const nextCloseAt = computeNextRandomAtFromWindow({
          nowTs: now(),
          startMin: meta.closeWindowStartMin,
          endMin: meta.closeWindowEndMin,
          skipCurrentInterval: true
        });
        saveState({
          inProgress: false,
          inProgressKind: null,
          nextCloseAt,
          lastError: residual && residual.ok === false
            ? ((residual && residual.error) ? residual.error : "close_residual_failed")
            : null
        });
        try {
          provisionAudit.append({
            ts: now(),
            event: "daily_window_close_skip_already_done",
            day,
            residualOk: !!(residual && residual.ok),
            residualSkipped: !!(residual && residual.skipped),
            residualError: residual && residual.error ? String(residual.error).slice(0, 180) : null,
            nextCloseAt
          });
        } catch {}
        return;
      }

      // Claim 1×/dia ANTES da rotina (espelha daily_terminal_cleanup).
      // Re-check em disco: outro processo pode ter claimado entre o load e aqui.
      {
        const again = loadState();
        if (String(again.lastCloseDay || "") === day) {
          const nextCloseAt = computeNextRandomAtFromWindow({
            nowTs: now(),
            startMin: meta.closeWindowStartMin,
            endMin: meta.closeWindowEndMin,
            skipCurrentInterval: true
          });
          saveState({ nextCloseAt, inProgress: false, inProgressKind: null });
          try {
            provisionAudit.append({
              ts: now(),
              event: "daily_window_close_skip_race_claimed",
              day,
              nextCloseAt
            });
          } catch {}
          return;
        }
      }
      saveState({
        inProgress: true,
        inProgressKind: "close",
        lastCloseDay: day,
        closeClaimedAt: now()
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_close_day_claimed",
          day,
          mode,
          renewFirst: mode === "renew_window_close_open"
        });
      } catch {}

      const renewFirst = mode === "renew_window_close_open";
      const rr = await runCloseRoutine({ renewFirst });
      const nextCloseAt = computeNextRandomAtFromWindow({
        nowTs: now(),
        startMin: meta.closeWindowStartMin,
        endMin: meta.closeWindowEndMin,
        skipCurrentInterval: true
      });
      saveState({
        inProgress: false,
        inProgressKind: null,
        nextCloseAt,
        lastCloseAt: rr && rr.ok === true ? now() : (Number((state || {}).lastCloseAt || 0) || 0),
        lastError: rr && rr.ok === true ? null : ((rr && rr.error) ? rr.error : "close_unknown_error")
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_close",
          ok: !!(rr && rr.ok === true),
          renewFirst: !!renewFirst,
          day,
          error: rr && rr.error ? String(rr.error) : null,
          nextCloseAt
        });
      } catch {}
      if (!rr.ok) logger.warn("[DAILY-WINDOW] close falhou", rr || {});
      return;
    }
    if (dueOpen) {
      if (openDoneToday) {
        const nextOpenAt = computeNextRandomAtFromWindow({
          nowTs: now(),
          startMin: meta.openWindowStartMin,
          endMin: meta.openWindowEndMin,
          skipCurrentInterval: true
        });
        saveState({
          inProgress: false,
          inProgressKind: null,
          nextOpenAt
        });
        try {
          provisionAudit.append({
            ts: now(),
            event: "daily_window_open_skip_already_done",
            day,
            nextOpenAt
          });
        } catch {}
        return;
      }

      {
        const again = loadState();
        if (String(again.lastOpenDay || "") === day) {
          const nextOpenAt = computeNextRandomAtFromWindow({
            nowTs: now(),
            startMin: meta.openWindowStartMin,
            endMin: meta.openWindowEndMin,
            skipCurrentInterval: true
          });
          saveState({ nextOpenAt, inProgress: false, inProgressKind: null });
          try {
            provisionAudit.append({
              ts: now(),
              event: "daily_window_open_skip_race_claimed",
              day,
              nextOpenAt
            });
          } catch {}
          return;
        }
      }
      saveState({
        inProgress: true,
        inProgressKind: "open",
        lastOpenDay: day,
        openClaimedAt: now()
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_open_day_claimed",
          day
        });
      } catch {}

      // Limpeza ban/captcha/2FA NÃO roda mais aqui — ver terminalAccountCleanupScheduler
      // (config própria no Config do Servidor).
      const rr = await runOpenRoutine();
      const nextOpenAt = computeNextRandomAtFromWindow({
        nowTs: now(),
        startMin: meta.openWindowStartMin,
        endMin: meta.openWindowEndMin,
        skipCurrentInterval: true
      });
      saveState({
        inProgress: false,
        inProgressKind: null,
        nextOpenAt,
        lastOpenAt: now(),
        lastError: rr && rr.ok === true ? null : ((rr && rr.error) ? rr.error : "open_unknown_error")
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "daily_window_open",
          ok: !!(rr && rr.ok === true),
          error: rr && rr.error ? String(rr.error) : null,
          day,
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
    try { saveState({ inProgress: false, inProgressKind: null, lastError: (e && e.message) ? String(e.message) : String(e) }); } catch {}
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
  stopDailyWindowScheduler,
  todayKeySaoPaulo
};

