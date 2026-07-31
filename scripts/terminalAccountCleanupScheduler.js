'use strict';

/**
 * Scheduler independente: excluir contas terminais (ban / 2FA / captcha bloqueante).
 * - Config: server_runtime_config.terminalAccountCleanup
 * - enabled=false → não faz nada
 * - enabled=true → 1 horário random na janela, 1×/dia (America/Sao_Paulo)
 * - NÃO acoplado a renovar/fechar/abrir
 *
 * Tick leve (30s): só compara nextAt; trabalho pesado só quando due.
 */

const fs = require('fs');
const path = require('path');
const serverConfig = require('./serverConfig.js');
const logger = require('./logger.js');
const provisionAudit = require('./provisionAudit.js');
const fileStore = require('./fileStore.js');
const dailyTerminalCleanup = require('./dailyTerminalCleanup.js');

const LOOP_MS = 30_000;
const SCHED_STATE_PATH = path.join(__dirname, '..', 'dados', 'terminal_account_cleanup_scheduler_state.json');

let timer = null;
let inFlight = false;
let localPort = Number(process.env.PORT || 8088) || 8088;

function now() { return Date.now(); }

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function readJsonSafe(fp, fallback = null) {
  try { return JSON.parse(String(fs.readFileSync(fp, 'utf8') || '')); } catch { return fallback; }
}

function writeJsonAtomic(fp, obj) {
  ensureDirSync(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

function todayKeySaoPaulo(ts = Date.now()) {
  return dailyTerminalCleanup.todayKeySaoPaulo(ts);
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

function buildDefaultState() {
  return {
    version: 1,
    updatedAt: now(),
    nextCleanupAt: 0,
    scheduleSignature: '',
    lastRunDay: null,
    lastRunAt: 0,
    lastError: null,
    inProgress: false
  };
}

function loadState() {
  const j = readJsonSafe(SCHED_STATE_PATH, null);
  return (j && typeof j === 'object') ? { ...buildDefaultState(), ...j } : buildDefaultState();
}

function saveState(patch = null) {
  const cur = loadState();
  const next = { ...cur, ...(patch || {}), updatedAt: now() };
  writeJsonAtomic(SCHED_STATE_PATH, next);
  return next;
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = serverConfig.readServerConfigEffective({});
    const tc = (cfg && cfg.terminalAccountCleanup) ? cfg.terminalAccountCleanup : {};
    const enabled = tc.enabled === true;

    if (!enabled) {
      const cur = loadState();
      if (Number(cur.nextCleanupAt || 0) > 0 || String(cur.scheduleSignature || '').length || cur.inProgress === true) {
        saveState({
          nextCleanupAt: 0,
          scheduleSignature: '',
          inProgress: false,
          lastError: null
        });
      }
      return;
    }

    const nowTs = now();
    const day = todayKeySaoPaulo(nowTs);
    const startMin = hmToMin(tc.windowStartHour, tc.windowStartMinute);
    const endMin = hmToMin(tc.windowEndHour, tc.windowEndMinute);
    const signature = `${startMin}|${endMin}|on`;
    let cur = loadState();

    // Cleanup module claim (lastTerminalCleanupDay) é a fonte de verdade 1×/dia.
    // Espelha no scheduler para pular janela atual após run.
    let doneToday = false;
    try {
      const cleanSt = readJsonSafe(dailyTerminalCleanup.STATE_PATH, {}) || {};
      doneToday = String(cleanSt.lastTerminalCleanupDay || '') === day;
      if (doneToday && String(cur.lastRunDay || '') !== day) {
        cur = saveState({ lastRunDay: day, lastRunAt: Number(cleanSt.lastTerminalCleanupAt || nowTs) || nowTs });
      }
    } catch {}

    if (cur.inProgress === true) {
      saveState({ inProgress: false });
      cur = loadState();
      try {
        provisionAudit.append({
          ts: nowTs,
          event: 'terminal_account_cleanup_stale_in_progress_cleared',
          day
        });
      } catch {}
    }

    const changedSchedule = String(cur.scheduleSignature || '') !== signature;
    if (changedSchedule) {
      const nextCleanupAt = computeNextRandomAtFromWindow({
        nowTs,
        startMin,
        endMin,
        skipCurrentInterval: doneToday
      });
      cur = saveState({
        nextCleanupAt,
        scheduleSignature: signature
      });
      try {
        provisionAudit.append({
          ts: nowTs,
          event: 'terminal_account_cleanup_rescheduled',
          day,
          nextCleanupAt,
          signature,
          skipCurrentInterval: !!doneToday
        });
      } catch {}
    } else if (!Number(cur.nextCleanupAt) || Number(cur.nextCleanupAt) < (nowTs - 60 * 1000)) {
      const nextCleanupAt = computeNextRandomAtFromWindow({
        nowTs,
        startMin,
        endMin,
        skipCurrentInterval: doneToday
      });
      cur = saveState({ nextCleanupAt });
    }

    const due = Number(cur.nextCleanupAt || 0) > 0 && nowTs >= Number(cur.nextCleanupAt || 0);
    if (!due) return;

    if (doneToday) {
      const nextCleanupAt = computeNextRandomAtFromWindow({
        nowTs: now(),
        startMin,
        endMin,
        skipCurrentInterval: true
      });
      saveState({
        nextCleanupAt,
        inProgress: false,
        lastError: null
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: 'terminal_account_cleanup_skip_already_done',
          day,
          nextCleanupAt
        });
      } catch {}
      return;
    }

    saveState({ inProgress: true });
    try {
      provisionAudit.append({
        ts: now(),
        event: 'terminal_account_cleanup_due_begin',
        day,
        scheduledAt: Number(cur.nextCleanupAt || 0) || 0
      });
    } catch {}

    let result = null;
    try {
      result = await dailyTerminalCleanup.runDailyTerminalCleanup({
        fileStore,
        localPort,
        by: 'terminal_account_cleanup_scheduler'
      });
    } catch (e) {
      result = {
        ok: false,
        error: (e && e.message) ? String(e.message) : String(e)
      };
    }

    const nextCleanupAt = computeNextRandomAtFromWindow({
      nowTs: now(),
      startMin,
      endMin,
      skipCurrentInterval: true
    });
    saveState({
      inProgress: false,
      nextCleanupAt,
      lastRunDay: day,
      lastRunAt: now(),
      lastError: (result && result.ok === true)
        ? null
        : String((result && result.error) || 'cleanup_failed').slice(0, 180)
    });

    try {
      provisionAudit.append({
        ts: now(),
        event: 'terminal_account_cleanup_due_done',
        day,
        ok: !!(result && result.ok),
        skipped: !!(result && result.skipped),
        deleted: Number(result && result.deleted || 0) || 0,
        failed: Number(result && result.failed || 0) || 0,
        scanned: Number(result && result.scanned || 0) || 0,
        error: result && result.error ? String(result.error).slice(0, 180) : null,
        nextCleanupAt
      });
    } catch {}

    if (result && result.ok === true) {
      try {
        logger.info('[TERMINAL-CLEANUP-SCHED] done', {
          day,
          skipped: !!result.skipped,
          deleted: Number(result.deleted || 0) || 0,
          failed: Number(result.failed || 0) || 0
        });
      } catch {}
    } else {
      try {
        logger.warn('[TERMINAL-CLEANUP-SCHED] falhou', result || {});
      } catch {}
    }
  } finally {
    inFlight = false;
  }
}

function startTerminalAccountCleanupScheduler({ port } = {}) {
  localPort = Number(port || localPort || 8088) || 8088;
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, LOOP_MS);
  try {
    if (typeof timer.unref === 'function') timer.unref();
  } catch {}
  tick().catch(() => {});
  try {
    logger.info('[TERMINAL-CLEANUP-SCHED] started', { port: localPort, loopMs: LOOP_MS });
  } catch {}
}

module.exports = {
  startTerminalAccountCleanupScheduler,
  SCHED_STATE_PATH
};
