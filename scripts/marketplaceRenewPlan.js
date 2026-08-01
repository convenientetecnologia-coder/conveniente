'use strict';

const crypto = require('crypto');
const manifestStore = require('./manifestStore.js');
const serverConfig = require('./serverConfig.js');

const PLAN_VERSION = 'marketplace_renew_plan_v1';
const PLAN_FIELD = 'marketplaceRenewPlanV1';

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return Math.max(lo, Math.min(hi, Math.floor(Number(fallback) || 0)));
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function todaySaoPaulo(ts = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ts));
  } catch {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function minuteOfDaySaoPaulo(ts = Date.now()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(ts));
    const hh = Number(parts.find((p) => p.type === 'hour')?.value || 0) || 0;
    const mm = Number(parts.find((p) => p.type === 'minute')?.value || 0) || 0;
    return (hh * 60) + mm;
  } catch {
    const d = new Date(ts);
    return (d.getHours() * 60) + d.getMinutes();
  }
}

function hhmm(minuteOfDay) {
  const safe = Math.max(0, Math.min(1439, clampInt(minuteOfDay, 0, 1439, 0)));
  const hh = String(Math.floor(safe / 60)).padStart(2, '0');
  const mm = String(safe % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function hmToMin(h, m) {
  const hh = clampInt(h, 0, 23, 0);
  const mm = clampInt(m, 0, 59, 0);
  return (hh * 60) + mm;
}

function windowDurationMinutes(startMin, endMin) {
  const s = clampInt(startMin, 0, 1439, 0);
  const e = clampInt(endMin, 0, 1439, 0);
  return e > s ? (e - s) : ((1440 - s) + e);
}

function normalizeWindowEndMin(startMin, endMin) {
  void startMin;
  return clampInt(endMin, 0, 1439, 0);
}

function normalizeConfigSnapshot(cfg) {
  const raw = (cfg && cfg.marketplaceRenew && typeof cfg.marketplaceRenew === 'object')
    ? cfg.marketplaceRenew
    : {};
  const startMin = hmToMin(raw.windowStartHour, raw.windowStartMinute);
  const endMin = normalizeWindowEndMin(startMin, hmToMin(raw.windowEndHour, raw.windowEndMinute));
  const scrollDaysMinRaw = clampInt(raw.scrollDaysMin, 1, 120, 7);
  const scrollDaysMaxRaw = clampInt(raw.scrollDaysMax, 1, 120, 45);
  const scrollDaysMin = Math.min(scrollDaysMinRaw, scrollDaysMaxRaw);
  const scrollDaysMax = Math.max(scrollDaysMinRaw, scrollDaysMaxRaw);
  const enabled = raw.enabled === true;
  return {
    enabled,
    windowStartHour: clampInt(raw.windowStartHour, 0, 23, 8),
    windowStartMinute: clampInt(raw.windowStartMinute, 0, 59, 0),
    windowEndHour: clampInt(raw.windowEndHour, 0, 23, 0),
    windowEndMinute: clampInt(raw.windowEndMinute, 0, 59, 0),
    windowStartMin: startMin,
    windowEndMin: endMin,
    scrollDaysMin,
    scrollDaysMax
  };
}

function readConfigSnapshot() {
  return normalizeConfigSnapshot(serverConfig.readServerConfigEffective({}));
}

function windowIsValid(cfg) {
  if (!cfg) return false;
  if (!Number.isFinite(cfg.windowStartMin) || !Number.isFinite(cfg.windowEndMin)) return false;
  const dur = windowDurationMinutes(cfg.windowStartMin, cfg.windowEndMin);
  return dur >= 1 && dur < 1440;
}

function seedIntFrom(seedInput) {
  const seedHex = crypto.createHash('sha256').update(String(seedInput || '')).digest('hex').slice(0, 8);
  return {
    seedHex,
    seedInt: (parseInt(seedHex, 16) >>> 0) || 1
  };
}

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pickDueMinuteInWindow(rng, startMin, endMin) {
  const dur = windowDurationMinutes(startMin, endMin);
  const offset = randInt(rng, 0, Math.max(0, dur - 1));
  return (clampInt(startMin, 0, 1439, 0) + offset) % 1440;
}

function isMinuteInWindow(minute, startMin, endMin) {
  const cur = clampInt(minute, 0, 1439, 0);
  const s = clampInt(startMin, 0, 1439, 0);
  const e = clampInt(endMin, 0, 1439, 0);
  return e > s ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

function buildPlanDeterministic(nome, dateYmd, cfg) {
  const normalized = normalizeConfigSnapshot({ marketplaceRenew: cfg });
  if (!normalized.enabled || !windowIsValid(normalized)) {
    return {
      version: PLAN_VERSION,
      date: String(dateYmd || ''),
      enabled: false,
      windowStartMin: normalized.windowStartMin,
      windowEndMin: normalized.windowEndMin,
      scrollDaysMin: normalized.scrollDaysMin,
      scrollDaysMax: normalized.scrollDaysMax,
      dueMin: null,
      dueLabel: null,
      scrollDays: null,
      seed: null
    };
  }
  const { seedHex, seedInt } = seedIntFrom([
    PLAN_VERSION,
    String(nome || ''),
    String(dateYmd || ''),
    String(normalized.windowStartMin),
    String(normalized.windowEndMin),
    String(normalized.scrollDaysMin),
    String(normalized.scrollDaysMax)
  ].join('|'));
  const rng = mulberry32(seedInt);
  const dueMin = pickDueMinuteInWindow(rng, normalized.windowStartMin, normalized.windowEndMin);
  const scrollDays = randInt(rng, normalized.scrollDaysMin, normalized.scrollDaysMax);
  return {
    version: PLAN_VERSION,
    date: String(dateYmd || ''),
    enabled: true,
    windowStartMin: normalized.windowStartMin,
    windowEndMin: normalized.windowEndMin,
    scrollDaysMin: normalized.scrollDaysMin,
    scrollDaysMax: normalized.scrollDaysMax,
    dueMin,
    dueLabel: hhmm(dueMin),
    scrollDays,
    seed: seedHex
  };
}

function isValidPlan(plan, dateYmd, cfg) {
  if (!plan || typeof plan !== 'object') return false;
  if (String(plan.version || '') !== PLAN_VERSION) return false;
  if (String(plan.date || '') !== String(dateYmd || '')) return false;
  const normalized = normalizeConfigSnapshot({ marketplaceRenew: cfg });
  if (!!plan.enabled !== !!normalized.enabled) return false;
  if (Number(plan.windowStartMin || 0) !== Number(normalized.windowStartMin || 0)) return false;
  if (Number(plan.windowEndMin || 0) !== Number(normalized.windowEndMin || 0)) return false;
  if (Number(plan.scrollDaysMin || 0) !== Number(normalized.scrollDaysMin || 0)) return false;
  if (Number(plan.scrollDaysMax || 0) !== Number(normalized.scrollDaysMax || 0)) return false;
  if (normalized.enabled !== true) return true;
  if (!windowIsValid(normalized)) return false;
  if (!Number.isFinite(Number(plan.dueMin))) return false;
  if (!Number.isFinite(Number(plan.scrollDays))) return false;
  if (!isMinuteInWindow(Number(plan.dueMin || 0), normalized.windowStartMin, normalized.windowEndMin)) return false;
  const sd = Number(plan.scrollDays || 0) || 0;
  if (sd < Number(normalized.scrollDaysMin || 0) || sd > Number(normalized.scrollDaysMax || 0)) return false;
  return true;
}

async function getOrCreatePlanForToday(nome, { nowMs = Date.now(), manifestHint = null, configHint = null } = {}) {
  const profileName = String(nome || '').trim();
  if (!profileName) return { plan: buildPlanDeterministic('', todaySaoPaulo(nowMs), { enabled: false }), config: readConfigSnapshot(), manifest: manifestHint || null };
  const config = normalizeConfigSnapshot({ marketplaceRenew: configHint || readConfigSnapshot() });
  const dateYmd = todaySaoPaulo(nowMs);
  const manifest = manifestHint || await manifestStore.read(profileName).catch(() => null);
  const currentPlan = manifest && manifest[PLAN_FIELD] ? manifest[PLAN_FIELD] : null;
  if (isValidPlan(currentPlan, dateYmd, config)) {
    return { plan: currentPlan, config, manifest };
  }
  const plan = buildPlanDeterministic(profileName, dateYmd, config);
  await manifestStore.update(profileName, (m) => {
    m = m || {};
    m[PLAN_FIELD] = plan;
    return m;
  }).catch(() => {});
  const nextManifest = manifest && typeof manifest === 'object'
    ? { ...manifest, [PLAN_FIELD]: plan }
    : { [PLAN_FIELD]: plan };
  return { plan, config, manifest: nextManifest };
}

async function regeneratePlanForToday(nome, { nowMs = Date.now(), configHint = null } = {}) {
  const profileName = String(nome || '').trim();
  if (!profileName) return { ok: false, error: 'nome_ausente' };
  await manifestStore.update(profileName, (m) => {
    m = m || {};
    if (m[PLAN_FIELD]) delete m[PLAN_FIELD];
    return m;
  }).catch(() => {});
  const out = await getOrCreatePlanForToday(profileName, { nowMs, configHint });
  return { ok: true, plan: out.plan };
}

function isDoneTodayFromDay(doneDay, nowMs = Date.now()) {
  return String(doneDay || '').trim() === todaySaoPaulo(nowMs);
}

function isPlanDue(plan, nowMs = Date.now()) {
  if (!plan || plan.enabled !== true || !Number.isFinite(Number(plan.dueMin))) return false;
  const nowMin = minuteOfDaySaoPaulo(nowMs);
  const dueMin = clampInt(plan.dueMin, 0, 1439, 0);
  const startMin = clampInt(plan.windowStartMin, 0, 1439, 0);
  const endMin = clampInt(plan.windowEndMin, 0, 1439, 0);
  if (!windowIsValid({ windowStartMin: startMin, windowEndMin: endMin })) return false;
  if (endMin > startMin) return nowMin >= dueMin;
  if (dueMin >= startMin) return nowMin >= dueMin;
  return nowMin >= dueMin || nowMin >= endMin;
}

async function shouldAutoRenewAfterPublish(nome, { nowMs = Date.now(), manifestHint = null, configHint = null } = {}) {
  const profileName = String(nome || '').trim();
  const manifest = manifestHint || await manifestStore.read(profileName).catch(() => null);
  const flags = (manifest && manifest.accountFlags) || {};
  const config = normalizeConfigSnapshot({ marketplaceRenew: configHint || readConfigSnapshot() });
  const { plan } = await getOrCreatePlanForToday(profileName, { nowMs, manifestHint: manifest, configHint: config });
  const doneDay = flags.marketplaceRenewDoneDay ? String(flags.marketplaceRenewDoneDay) : null;
  const doneToday = isDoneTodayFromDay(doneDay, nowMs);
  if (config.enabled !== true || plan.enabled !== true) {
    return { ok: true, enabled: false, shouldRun: false, reason: 'disabled', plan, doneToday };
  }
  if (doneToday) {
    return { ok: true, enabled: true, shouldRun: false, reason: 'already_done_today', plan, doneToday };
  }
  if (!isPlanDue(plan, nowMs)) {
    return { ok: true, enabled: true, shouldRun: false, reason: 'before_due_time', plan, doneToday };
  }
  return {
    ok: true,
    enabled: true,
    shouldRun: true,
    reason: 'due',
    plan,
    doneToday,
    scrollDays: Number(plan.scrollDays || 0) || 0
  };
}

function pickManualScrollDays(configHint = null) {
  const config = normalizeConfigSnapshot({ marketplaceRenew: configHint || readConfigSnapshot() });
  const scrollDays = randInt(() => Math.random(), config.scrollDaysMin, config.scrollDaysMax);
  return { config, scrollDays };
}

async function replanAllProfiles({ nowMs = Date.now(), configHint = null, fileStore = null } = {}) {
  const config = normalizeConfigSnapshot({ marketplaceRenew: configHint || readConfigSnapshot() });
  let nomes = [];
  try {
    if (fileStore && typeof fileStore.loadPerfisJson === 'function') {
      const arr = fileStore.loadPerfisJson() || [];
      nomes = (Array.isArray(arr) ? arr : [])
        .map((p) => String(p && p.nome || '').trim())
        .filter(Boolean);
    }
  } catch {
    nomes = [];
  }
  let okCount = 0;
  let failCount = 0;
  for (const nome of nomes) {
    try {
      const r = await regeneratePlanForToday(nome, { nowMs, configHint: config });
      if (r && r.ok) okCount += 1;
      else failCount += 1;
    } catch {
      failCount += 1;
    }
  }
  return {
    ok: true,
    enabled: config.enabled === true,
    total: nomes.length,
    regenerated: okCount,
    failed: failCount
  };
}

async function markDoneToday(nome, { count = 0, source = 'unknown', nowMs = Date.now() } = {}) {
  const profileName = String(nome || '').trim();
  if (!profileName) return { ok: false, error: 'nome_ausente' };
  const safeCount = Math.max(0, clampInt(count, 0, 5000, 0));
  const safeNowMs = Number(nowMs) || Date.now();
  const day = todaySaoPaulo(safeNowMs);
  await manifestStore.update(profileName, (m) => {
    m = m || {};
    m.accountFlags = m.accountFlags || {};
    m.accountFlags.marketplaceRenewDoneDay = day;
    m.accountFlags.marketplaceRenewDoneAt = safeNowMs;
    m.accountFlags.marketplaceRenewLastCount = safeCount;
    m.accountFlags.marketplaceRenewLastSource = String(source || 'unknown').slice(0, 80);
    m.accountFlags.renovadosLastCount = safeCount;
    m.accountFlags.renovadosAt = safeCount > 0 ? safeNowMs : null;
    return m;
  });
  return { ok: true, day, count: safeCount };
}

async function getStatusSnapshot(nome, { nowMs = Date.now(), manifestHint = null, configHint = null } = {}) {
  const profileName = String(nome || '').trim();
  const config = normalizeConfigSnapshot({ marketplaceRenew: configHint || readConfigSnapshot() });
  const manifest = manifestHint || await manifestStore.read(profileName).catch(() => null);
  const flags = (manifest && manifest.accountFlags) || {};
  const { plan } = await getOrCreatePlanForToday(profileName, {
    nowMs,
    manifestHint: manifest,
    configHint: config
  });
  const doneDay = flags.marketplaceRenewDoneDay ? String(flags.marketplaceRenewDoneDay) : null;
  const doneAt = Number(flags.marketplaceRenewDoneAt || 0) || null;
  const doneToday = isDoneTodayFromDay(doneDay, nowMs);
  const lastCountRaw = Math.max(0, Number(flags.marketplaceRenewLastCount || 0) || 0);
  const lastCount = doneToday ? lastCountRaw : 0;
  const dueReached = config.enabled === true && plan.enabled === true ? isPlanDue(plan, nowMs) : false;
  return {
    marketplaceRenewEnabled: config.enabled === true,
    marketplaceRenewDueLabel: config.enabled === true && plan.enabled === true ? String(plan.dueLabel || '') : null,
    marketplaceRenewDueMinute: config.enabled === true && plan.enabled === true ? Number(plan.dueMin || 0) || 0 : null,
    marketplaceRenewDueReached: !!dueReached,
    marketplaceRenewScrollDays: config.enabled === true && plan.enabled === true ? Number(plan.scrollDays || 0) || 0 : null,
    marketplaceRenewPlanDate: config.enabled === true && plan.enabled === true ? String(plan.date || '') : null,
    marketplaceRenewDoneDay: doneDay,
    marketplaceRenewDoneAt: doneAt,
    marketplaceRenewDoneToday: !!doneToday,
    marketplaceRenewLastCount: lastCount
  };
}

module.exports = {
  PLAN_FIELD,
  PLAN_VERSION,
  todaySaoPaulo,
  minuteOfDaySaoPaulo,
  hhmm,
  normalizeConfigSnapshot,
  readConfigSnapshot,
  windowIsValid,
  windowDurationMinutes,
  buildPlanDeterministic,
  getOrCreatePlanForToday,
  regeneratePlanForToday,
  isDoneTodayFromDay,
  isPlanDue,
  shouldAutoRenewAfterPublish,
  pickManualScrollDays,
  markDoneToday,
  getStatusSnapshot,
  replanAllProfiles
};
