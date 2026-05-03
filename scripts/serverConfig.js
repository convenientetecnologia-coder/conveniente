"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const utils = require("./utils.js");

const CONFIG_PATH = path.join(__dirname, "..", "dados", "server_runtime_config.json");
const CONFIG_VERSION = 1;

const DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  updatedAt: 0,
  updatedBy: "default",
  capacity: {
    mode: "per_8gb",
    accountsPer8Gb: 15,
    maxAccountsOverride: null
  },
  robe: {
    windowStartMin: 360,
    windowEndMin: 1380,
    dailyHoursMin: 1,
    dailyHoursMax: 14,
    priorityBandMinHour: 6,
    priorityBandMaxHour: 12,
    priorityBandRatio: 0.6,
    postsPerHourMin: 2.2,
    postsPerHourMax: 3.4,
    cooldownMinMinutes: 25,
    cooldownMaxMinutes: 50,
    workMode: "v1",
    v2Tuning: {
      alpha: 0.10,
      beta: 1.0,
      minBoost: 0.35,
      maxBoost: 3.0,
      noDriversFactor: 0.06,
      lowDriversMinFactor: 0.22,
      lowDriversGamma: 0.70,
      driverBonusGamma: 0.25,
      driverBonusCap: 1.25,
      antiStreakPenalty: 0.35,
      statsWindowDays: 3,
      prefetchRatio: 0.10,
      prefetchMin: 5,
      prefetchMax: 20
    },
    photoDeletePolicy: "after_all_working_posted",
    cidadesExtrasGlobais: []
  }
});

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function cityNormKey(v) {
  return String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function normalizeCityList(input, { max = 200 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(input) ? input : [])) {
    const v = String(raw || "").trim();
    if (!v) continue;
    const k = cityNormKey(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function writeJsonAtomic(fp, obj) {
  ensureDirSync(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, fp);
}

function readServerConfigRaw() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : null;
  } catch {
    return null;
  }
}

function getTotalMemMB() {
  try { return Math.round(os.totalmem() / (1024 * 1024)); } catch { return 0; }
}

function calcMaxAccountsEffective({ mode, accountsPer8Gb, maxAccountsOverride, totalMemMB }) {
  const totalGB = Math.max(1, toNum(totalMemMB, getTotalMemMB()) / 1024);
  const per8 = Math.max(1, Math.floor(toNum(accountsPer8Gb, 15)));
  const override = toNum(maxAccountsOverride, 0);
  if (String(mode) === "absolute" && override > 0) return Math.max(1, Math.floor(override));
  if (String(mode) === "auto_by_ram") return Math.max(1, Math.floor(totalGB * (30 / 16)));
  return Math.max(1, Math.floor(totalGB * (per8 / 8)));
}

function buildNormalizedConfig(raw, { totalMemMB = getTotalMemMB(), source = "default" } = {}) {
  const r = (raw && typeof raw === "object") ? raw : {};
  const cap = (r.capacity && typeof r.capacity === "object") ? r.capacity : {};
  const robe = (r.robe && typeof r.robe === "object") ? r.robe : {};
  const v2 = (robe.v2Tuning && typeof robe.v2Tuning === "object") ? robe.v2Tuning : {};

  let mode = String(cap.mode || DEFAULTS.capacity.mode).trim().toLowerCase();
  if (!["auto_by_ram", "per_8gb", "absolute"].includes(mode)) mode = DEFAULTS.capacity.mode;

  const accountsPer8Gb = clamp(Math.floor(toNum(cap.accountsPer8Gb, DEFAULTS.capacity.accountsPer8Gb)), 1, 40);
  const maxAccountsOverrideRaw = toNum(cap.maxAccountsOverride, 0);
  const maxAccountsOverride = maxAccountsOverrideRaw > 0 ? clamp(Math.floor(maxAccountsOverrideRaw), 1, 500) : null;

  const windowStartMin = clamp(Math.floor(toNum(robe.windowStartMin, DEFAULTS.robe.windowStartMin)), 0, 1439);
  const windowEndMin = clamp(Math.floor(toNum(robe.windowEndMin, DEFAULTS.robe.windowEndMin)), 1, 1440);
  const dailyHoursMin = clamp(Math.floor(toNum(robe.dailyHoursMin, DEFAULTS.robe.dailyHoursMin)), 1, 24);
  const dailyHoursMax = clamp(Math.floor(toNum(robe.dailyHoursMax, DEFAULTS.robe.dailyHoursMax)), 1, 24);
  const dailyHoursMinNorm = Math.min(dailyHoursMin, dailyHoursMax);
  const dailyHoursMaxNorm = Math.max(dailyHoursMin, dailyHoursMax);
  const priorityBandMinRaw = clamp(Math.floor(toNum(robe.priorityBandMinHour, DEFAULTS.robe.priorityBandMinHour)), 1, 24);
  const priorityBandMaxRaw = clamp(Math.floor(toNum(robe.priorityBandMaxHour, DEFAULTS.robe.priorityBandMaxHour)), 1, 24);
  const priorityBandMinSorted = Math.min(priorityBandMinRaw, priorityBandMaxRaw);
  const priorityBandMaxSorted = Math.max(priorityBandMinRaw, priorityBandMaxRaw);
  const priorityBandMinHour = clamp(priorityBandMinSorted, dailyHoursMinNorm, dailyHoursMaxNorm);
  const priorityBandMaxHour = clamp(priorityBandMaxSorted, priorityBandMinHour, dailyHoursMaxNorm);
  const priorityBandRatio = Number(clamp(toNum(robe.priorityBandRatio, DEFAULTS.robe.priorityBandRatio), 0, 1).toFixed(4));
  const postsPerHourMin = clamp(toNum(robe.postsPerHourMin, DEFAULTS.robe.postsPerHourMin), 0.1, 12.0);
  const postsPerHourMax = clamp(toNum(robe.postsPerHourMax, DEFAULTS.robe.postsPerHourMax), 0.1, 12.0);
  const cooldownMinMinutesRaw = Math.floor(toNum(robe.cooldownMinMinutes, DEFAULTS.robe.cooldownMinMinutes));
  const cooldownMaxMinutesRaw = Math.floor(toNum(robe.cooldownMaxMinutes, DEFAULTS.robe.cooldownMaxMinutes));
  const cooldownMinMinutes = clamp(Math.min(cooldownMinMinutesRaw, cooldownMaxMinutesRaw), 1, 24 * 60);
  const cooldownMaxMinutes = clamp(Math.max(cooldownMinMinutesRaw, cooldownMaxMinutesRaw), cooldownMinMinutes, 24 * 60);
  const workModeRaw = String(robe.workMode || DEFAULTS.robe.workMode).trim().toLowerCase();
  const workMode = (workModeRaw === "v2_auto") ? "v2_auto" : "v1";
  const v2Alpha = Number(clamp(toNum(v2.alpha, DEFAULTS.robe.v2Tuning.alpha), 0, 0.6).toFixed(4));
  const v2Beta = Number(clamp(toNum(v2.beta, DEFAULTS.robe.v2Tuning.beta), 0.05, 6.0).toFixed(4));
  const v2MinBoost = Number(clamp(toNum(v2.minBoost, DEFAULTS.robe.v2Tuning.minBoost), 0.01, 2.0).toFixed(4));
  const v2MaxBoost = Number(clamp(toNum(v2.maxBoost, DEFAULTS.robe.v2Tuning.maxBoost), 1.0, 20.0).toFixed(4));
  const v2NoDriversFactor = Number(clamp(toNum(v2.noDriversFactor, DEFAULTS.robe.v2Tuning.noDriversFactor), 0, 1).toFixed(4));
  const v2LowDriversMinFactor = Number(clamp(toNum(v2.lowDriversMinFactor, DEFAULTS.robe.v2Tuning.lowDriversMinFactor), 0, 1).toFixed(4));
  const v2LowDriversGamma = Number(clamp(toNum(v2.lowDriversGamma, DEFAULTS.robe.v2Tuning.lowDriversGamma), 0.05, 6.0).toFixed(4));
  const v2DriverBonusGamma = Number(clamp(toNum(v2.driverBonusGamma, DEFAULTS.robe.v2Tuning.driverBonusGamma), 0, 2.0).toFixed(4));
  const v2DriverBonusCap = Number(clamp(toNum(v2.driverBonusCap, DEFAULTS.robe.v2Tuning.driverBonusCap), 1.0, 3.0).toFixed(4));
  const v2AntiStreakPenalty = Number(clamp(toNum(v2.antiStreakPenalty, DEFAULTS.robe.v2Tuning.antiStreakPenalty), 0.01, 1).toFixed(4));
  const v2StatsWindowDays = clamp(Math.floor(toNum(v2.statsWindowDays, DEFAULTS.robe.v2Tuning.statsWindowDays)), 1, 10);
  const v2PrefetchRatio = Number(clamp(toNum(v2.prefetchRatio, DEFAULTS.robe.v2Tuning.prefetchRatio), 0.01, 0.8).toFixed(4));
  const v2PrefetchMinRaw = clamp(Math.floor(toNum(v2.prefetchMin, DEFAULTS.robe.v2Tuning.prefetchMin)), 1, 200);
  const v2PrefetchMaxRaw = clamp(Math.floor(toNum(v2.prefetchMax, DEFAULTS.robe.v2Tuning.prefetchMax)), 1, 500);
  const v2PrefetchMin = Math.min(v2PrefetchMinRaw, v2PrefetchMaxRaw);
  const v2PrefetchMax = Math.max(v2PrefetchMinRaw, v2PrefetchMaxRaw);
  const cidadesExtrasGlobais = normalizeCityList(robe.cidadesExtrasGlobais, { max: 200 });
  const photoDeletePolicyRaw = String(robe.photoDeletePolicy || DEFAULTS.robe.photoDeletePolicy).trim().toLowerCase();
  const photoDeletePolicy = (photoDeletePolicyRaw === "after_first_confirmed_post")
    ? "after_first_confirmed_post"
    : "after_all_working_posted";

  const normalized = {
    version: CONFIG_VERSION,
    updatedAt: Math.max(0, Math.floor(toNum(r.updatedAt, 0))),
    updatedBy: String(r.updatedBy || "unknown").slice(0, 180),
    source,
    capacity: {
      mode,
      accountsPer8Gb,
      maxAccountsOverride,
      maxAccountsEffective: 0
    },
    robe: {
      windowStartMin,
      windowEndMin,
      dailyHoursMin: dailyHoursMinNorm,
      dailyHoursMax: dailyHoursMaxNorm,
      priorityBandMinHour,
      priorityBandMaxHour,
      priorityBandRatio,
      postsPerHourMin: Number(Math.min(postsPerHourMin, postsPerHourMax).toFixed(3)),
      postsPerHourMax: Number(Math.max(postsPerHourMin, postsPerHourMax).toFixed(3)),
      cooldownMinMinutes,
      cooldownMaxMinutes,
      workMode,
      v2Tuning: {
        alpha: v2Alpha,
        beta: v2Beta,
        minBoost: Math.min(v2MinBoost, v2MaxBoost),
        maxBoost: Math.max(v2MinBoost, v2MaxBoost),
        noDriversFactor: v2NoDriversFactor,
        lowDriversMinFactor: v2LowDriversMinFactor,
        lowDriversGamma: v2LowDriversGamma,
        driverBonusGamma: v2DriverBonusGamma,
        driverBonusCap: v2DriverBonusCap,
        antiStreakPenalty: v2AntiStreakPenalty,
        statsWindowDays: v2StatsWindowDays,
        prefetchRatio: v2PrefetchRatio,
        prefetchMin: v2PrefetchMin,
        prefetchMax: v2PrefetchMax
      },
      photoDeletePolicy,
      cidadesExtrasGlobais
    }
  };

  normalized.capacity.maxAccountsEffective = calcMaxAccountsEffective({
    mode: normalized.capacity.mode,
    accountsPer8Gb: normalized.capacity.accountsPer8Gb,
    maxAccountsOverride: normalized.capacity.maxAccountsOverride,
    totalMemMB
  });
  return normalized;
}

function validateServerConfigPayload(payload) {
  const p = (payload && typeof payload === "object") ? payload : {};
  const cap = (p.capacity && typeof p.capacity === "object") ? p.capacity : null;
  const robe = (p.robe && typeof p.robe === "object") ? p.robe : null;
  if (!cap && !robe) return { ok: false, error: "payload_sem_campos_reconhecidos" };

  const errors = [];
  if (cap) {
    if (cap.mode !== undefined) {
      const mode = String(cap.mode || "").trim().toLowerCase();
      if (!["auto_by_ram", "per_8gb", "absolute"].includes(mode)) errors.push("capacity.mode_invalido");
    }
    if (cap.accountsPer8Gb !== undefined) {
      const n = toNum(cap.accountsPer8Gb, NaN);
      if (!Number.isFinite(n) || n < 1 || n > 40) errors.push("capacity.accountsPer8Gb_invalido");
    }
    if (cap.maxAccountsOverride !== undefined && cap.maxAccountsOverride !== null) {
      const n = toNum(cap.maxAccountsOverride, NaN);
      if (!Number.isFinite(n) || n < 1 || n > 500) errors.push("capacity.maxAccountsOverride_invalido");
    }
  }
  if (robe) {
    const iFields = ["windowStartMin", "windowEndMin", "dailyHoursMin", "dailyHoursMax", "priorityBandMinHour", "priorityBandMaxHour", "cooldownMinMinutes", "cooldownMaxMinutes"];
    for (const f of iFields) {
      if (robe[f] !== undefined) {
        const n = toNum(robe[f], NaN);
        if (!Number.isFinite(n)) errors.push(`robe.${f}_invalido`);
      }
    }
    const fFields = ["postsPerHourMin", "postsPerHourMax", "priorityBandRatio"];
    for (const f of fFields) {
      if (robe[f] !== undefined) {
        const n = toNum(robe[f], NaN);
        if (!Number.isFinite(n)) errors.push(`robe.${f}_invalido`);
      }
    }
    if (robe.photoDeletePolicy !== undefined) {
      const p = String(robe.photoDeletePolicy || "").trim().toLowerCase();
      if (!["after_all_working_posted", "after_first_confirmed_post"].includes(p)) {
        errors.push("robe.photoDeletePolicy_invalido");
      }
    }
    if (robe.workMode !== undefined) {
      const wm = String(robe.workMode || "").trim().toLowerCase();
      if (!["v1", "v2_auto"].includes(wm)) {
        errors.push("robe.workMode_invalido");
      }
    }
    if (robe.cidadesExtrasGlobais !== undefined) {
      if (!Array.isArray(robe.cidadesExtrasGlobais)) {
        errors.push("robe.cidadesExtrasGlobais_invalido");
      } else {
        const normalized = normalizeCityList(robe.cidadesExtrasGlobais, { max: 201 });
        if (normalized.length > 200) errors.push("robe.cidadesExtrasGlobais_limite_excedido");
        for (const c of normalized) {
          const coords = utils.getCoords(c);
          if (!coords || !coords.latitude || !coords.longitude) {
            errors.push(`robe.cidadesExtrasGlobais_sem_coordenadas:${c}`);
            break;
          }
        }
      }
    }
    if (robe.v2Tuning !== undefined) {
      if (robe.v2Tuning === null || typeof robe.v2Tuning !== "object" || Array.isArray(robe.v2Tuning)) {
        errors.push("robe.v2Tuning_invalido");
      } else {
        const t = robe.v2Tuning;
        const numFields = ["alpha","beta","minBoost","maxBoost","noDriversFactor","lowDriversMinFactor","lowDriversGamma","driverBonusGamma","driverBonusCap","antiStreakPenalty","prefetchRatio"];
        for (const f of numFields) {
          if (t[f] !== undefined) {
            const n = toNum(t[f], NaN);
            if (!Number.isFinite(n)) errors.push(`robe.v2Tuning.${f}_invalido`);
          }
        }
        const intFields = ["statsWindowDays","prefetchMin","prefetchMax"];
        for (const f of intFields) {
          if (t[f] !== undefined) {
            const n = toNum(t[f], NaN);
            if (!Number.isFinite(n)) errors.push(`robe.v2Tuning.${f}_invalido`);
          }
        }
      }
    }
  }
  if (errors.length) return { ok: false, error: "validation_failed", details: errors };

  const merged = {
    ...DEFAULTS,
    ...(readServerConfigRaw() || {}),
    capacity: { ...DEFAULTS.capacity, ...((readServerConfigRaw() || {}).capacity || {}), ...(cap || {}) },
    robe: { ...DEFAULTS.robe, ...((readServerConfigRaw() || {}).robe || {}), ...(robe || {}) }
  };
  const normalized = buildNormalizedConfig(merged, { source: "file" });
  if (normalized.robe.windowEndMin <= normalized.robe.windowStartMin) {
    return { ok: false, error: "validation_failed", details: ["robe.window_intervalo_invalido"] };
  }
  return { ok: true, normalized };
}

function writeServerConfigAtomic({ payload, updatedBy = "unknown" } = {}) {
  const v = validateServerConfigPayload(payload || {});
  if (!v.ok) return v;
  const next = {
    version: CONFIG_VERSION,
    updatedAt: Date.now(),
    updatedBy: String(updatedBy || "unknown").slice(0, 180),
    capacity: {
      mode: v.normalized.capacity.mode,
      accountsPer8Gb: v.normalized.capacity.accountsPer8Gb,
      maxAccountsOverride: v.normalized.capacity.maxAccountsOverride
    },
    robe: {
      windowStartMin: v.normalized.robe.windowStartMin,
      windowEndMin: v.normalized.robe.windowEndMin,
      dailyHoursMin: v.normalized.robe.dailyHoursMin,
      dailyHoursMax: v.normalized.robe.dailyHoursMax,
      priorityBandMinHour: v.normalized.robe.priorityBandMinHour,
      priorityBandMaxHour: v.normalized.robe.priorityBandMaxHour,
      priorityBandRatio: v.normalized.robe.priorityBandRatio,
      postsPerHourMin: v.normalized.robe.postsPerHourMin,
      postsPerHourMax: v.normalized.robe.postsPerHourMax,
      cooldownMinMinutes: v.normalized.robe.cooldownMinMinutes,
      cooldownMaxMinutes: v.normalized.robe.cooldownMaxMinutes,
      workMode: v.normalized.robe.workMode,
      v2Tuning: v.normalized.robe.v2Tuning,
      photoDeletePolicy: v.normalized.robe.photoDeletePolicy,
      cidadesExtrasGlobais: v.normalized.robe.cidadesExtrasGlobais
    }
  };
  try {
    writeJsonAtomic(CONFIG_PATH, next);
    return { ok: true, saved: next };
  } catch (e) {
    return { ok: false, error: "write_failed", details: (e && e.message) || String(e) };
  }
}

function readServerConfigEffective({ totalMemMB = getTotalMemMB() } = {}) {
  const raw = readServerConfigRaw();
  const source = raw ? "file" : "default";
  const base = raw || DEFAULTS;
  return buildNormalizedConfig(base, { totalMemMB, source });
}

module.exports = {
  CONFIG_PATH,
  DEFAULTS,
  getTotalMemMB,
  readServerConfigRaw,
  readServerConfigEffective,
  validateServerConfigPayload,
  writeServerConfigAtomic,
  calcMaxAccountsEffective
};

