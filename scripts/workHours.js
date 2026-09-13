'use strict';

/**
 * Expediente pelo relógio da config (America/Sao_Paulo), não pelo carimbo lastOpenAt.
 *
 * Fechado (não trabalha): 01:00 → 05:00 (fecha 1h–3h, reboot ~4h, index sobe fechado).
 * Expediente: 05:00 → 01:00 do dia seguinte.
 * Primeira abertura do dia: agenda aleatória 5h–7h. Recuperação não rouba essa janela
 * enquanto lastOpenDay ainda não é hoje.
 *
 * Abrir Tudo automático só se o pedido no disco estiver zerado.
 * Conta já pedida + Chrome fechado = nurse, não o botão.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'dados', 'daily_window_scheduler_state.json');
const RECOVER_DEBOUNCE_MS = 10 * 60 * 1000;

function hmToMin(h, m) {
  const hh = Math.max(0, Math.min(23, Math.floor(Number(h) || 0)));
  const mm = Math.max(0, Math.min(59, Math.floor(Number(m) || 0)));
  return (hh * 60) + mm;
}

function saoPauloDateParts(ts = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(ts));
    const bag = {};
    for (const part of parts) {
      if (part && part.type && part.type !== 'literal') bag[part.type] = part.value;
    }
    const y = Math.max(2000, Math.floor(Number(bag.year) || 0));
    const m = Math.max(1, Math.min(12, Math.floor(Number(bag.month) || 0)));
    const d = Math.max(1, Math.min(31, Math.floor(Number(bag.day) || 0)));
    if (y && m && d) return { y, m, d };
  } catch {}
  const fallback = new Date(ts);
  return {
    y: fallback.getFullYear(),
    m: fallback.getMonth() + 1,
    d: fallback.getDate()
  };
}

function todayKeySaoPaulo(ts = Date.now()) {
  const { y, m, d } = saoPauloDateParts(ts);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function saoPauloMinutesSinceMidnight(ts = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ts));
    const bag = {};
    for (const part of parts) {
      if (part && part.type && part.type !== 'literal') bag[part.type] = part.value;
    }
    let hour = Math.max(0, Math.min(23, Math.floor(Number(bag.hour) || 0)));
    if (String(bag.hour || '') === '24') hour = 0;
    const minute = Math.max(0, Math.min(59, Math.floor(Number(bag.minute) || 0)));
    return (hour * 60) + minute;
  } catch {}
  const fallback = new Date(ts);
  return (fallback.getHours() * 60) + fallback.getMinutes();
}

function windowMinsFromDaily(dw) {
  const d = dw && typeof dw === 'object' ? dw : {};
  return {
    enabled: d.enabled === true,
    mode: String(d.executionMode || '').trim().toLowerCase(),
    closeStartMin: hmToMin(d.closeWindowStartHour, d.closeWindowStartMinute),
    closeEndMin: hmToMin(d.closeWindowEndHour, d.closeWindowEndMinute),
    openStartMin: hmToMin(d.openWindowStartHour, d.openWindowStartMinute),
    openEndMin: hmToMin(d.openWindowEndHour, d.openWindowEndMinute)
  };
}

function isClosedNightClock(nowMin, closeStartMin, openStartMin) {
  const t = Math.max(0, Math.min(24 * 60 - 1, Math.floor(Number(nowMin) || 0)));
  const closeStart = Math.max(0, Math.floor(Number(closeStartMin) || 0));
  const openStart = Math.max(0, Math.floor(Number(openStartMin) || 0));
  if (closeStart === openStart) return false;
  if (closeStart < openStart) return t >= closeStart && t < openStart;
  return t >= closeStart || t < openStart;
}

function shouldWaitForScheduledOpen({ nowMin, day, openStartMin, openEndMin, lastOpenDay } = {}) {
  const t = Math.max(0, Math.min(24 * 60 - 1, Math.floor(Number(nowMin) || 0)));
  const openStart = Math.max(0, Math.floor(Number(openStartMin) || 0));
  const openEnd = Math.max(0, Math.floor(Number(openEndMin) || 0));
  if (t < openStart || t >= openEnd) return false;
  if (String(lastOpenDay || '') === String(day || '')) return false;
  return true;
}

function decideWorkHours({
  nowMin,
  day,
  enabled,
  mode,
  closeStartMin,
  openStartMin,
  openEndMin,
  lastOpenDay
} = {}) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'always_on_24h') {
    return { inWorkHours: true, waitScheduledOpen: false, reason: 'always_on_24h' };
  }
  if (enabled !== true) {
    return { inWorkHours: false, waitScheduledOpen: false, reason: 'daily_window_disabled' };
  }
  if (m !== 'window_close_open') {
    return { inWorkHours: false, waitScheduledOpen: false, reason: 'daily_window_mode_off' };
  }
  if (isClosedNightClock(nowMin, closeStartMin, openStartMin)) {
    return { inWorkHours: false, waitScheduledOpen: false, reason: 'closed_night_clock' };
  }
  const wait = shouldWaitForScheduledOpen({
    nowMin,
    day,
    openStartMin,
    openEndMin,
    lastOpenDay
  });
  if (wait) {
    return { inWorkHours: true, waitScheduledOpen: true, reason: 'wait_scheduled_open' };
  }
  return { inWorkHours: true, waitScheduledOpen: false, reason: 'work_hours_clock' };
}

function readJsonSafe(fp, fallback) {
  try {
    return JSON.parse(String(fs.readFileSync(fp, 'utf8') || '').replace(/^\uFEFF/, '')) || fallback;
  } catch {
    return fallback;
  }
}

function getWorkHoursDecision(ts = Date.now()) {
  let dw = {};
  try {
    const cfg = require('./serverConfig.js').readServerConfigEffective({});
    dw = (cfg && cfg.dailyWindow) ? cfg.dailyWindow : {};
  } catch {}
  const win = windowMinsFromDaily(dw);
  const st = readJsonSafe(STATE_PATH, {}) || {};
  const decided = decideWorkHours({
    nowMin: saoPauloMinutesSinceMidnight(ts),
    day: todayKeySaoPaulo(ts),
    enabled: win.enabled,
    mode: win.mode,
    closeStartMin: win.closeStartMin,
    openStartMin: win.openStartMin,
    openEndMin: win.openEndMin,
    lastOpenDay: st.lastOpenDay || null
  });
  return {
    ...decided,
    lastOpenDay: st.lastOpenDay || null,
    lastCloseDay: st.lastCloseDay || null,
    lastOpenAt: Number(st.lastOpenAt || 0) || 0,
    lastCloseAt: Number(st.lastCloseAt || 0) || 0,
    nextCloseAt: Number(st.nextCloseAt || 0) || 0,
    nextOpenAt: Number(st.nextOpenAt || 0) || 0
  };
}

function countDesiredActive(desired) {
  const perf = desired && desired.perfis && typeof desired.perfis === 'object' ? desired.perfis : {};
  let n = 0;
  for (const key of Object.keys(perf)) {
    if (perf[key] && perf[key].active === true) n += 1;
  }
  return n;
}

function desiredAllOff(desired) {
  return countDesiredActive(desired) === 0;
}

function shouldSkipStartClosedOnPorterBoot({ bootSource, inWorkHours, holdStopWorkers } = {}) {
  if (String(bootSource || '').trim().toLowerCase() !== 'porteiro') return false;
  if (holdStopWorkers === true) return false;
  return inWorkHours === true;
}

function shouldAutoOpenAll({
  bootSource,
  humanHoldActive,
  holdReason,
  holdAt,
  nowTs,
  inWorkHours,
  waitScheduledOpen,
  desiredAllOff: allOff,
  isHumanHoldBlockingOpenAll
} = {}) {
  if (String(bootSource || '').trim().toLowerCase() !== 'porteiro') {
    return { yes: false, reason: 'boot_source_not_porteiro' };
  }
  if (typeof isHumanHoldBlockingOpenAll === 'function') {
    if (isHumanHoldBlockingOpenAll({
      active: humanHoldActive === true,
      reason: holdReason,
      at: holdAt,
      nowTs
    })) {
      return { yes: false, reason: 'human_hold' };
    }
  }
  if (waitScheduledOpen === true) return { yes: false, reason: 'wait_scheduled_open' };
  if (inWorkHours !== true) return { yes: false, reason: 'not_work_hours' };
  if (allOff === false) return { yes: false, reason: 'desired_already_open_nurse' };
  return { yes: true, reason: 'work_hours_desired_off' };
}

module.exports = {
  STATE_PATH,
  RECOVER_DEBOUNCE_MS,
  hmToMin,
  todayKeySaoPaulo,
  saoPauloMinutesSinceMidnight,
  windowMinsFromDaily,
  isClosedNightClock,
  shouldWaitForScheduledOpen,
  decideWorkHours,
  getWorkHoursDecision,
  countDesiredActive,
  desiredAllOff,
  shouldSkipStartClosedOnPorterBoot,
  shouldAutoOpenAll
};
