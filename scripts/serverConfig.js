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
  // Política de RAM (governor + reserva mínima livre para abrir navegador).
  // Valores em MB. Lidas em runtime a cada tick — salvar no dashboard já vale sem restart.
  memory: {
    governorEnterMb: 2048,
    governorExitMb: 2048,
    hostBaseMb: 2048,
    reservePer8GbMb: 768,
    provisionSpikeMb: 1536
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
    cooldownMinMinutes: 60,
    cooldownMaxMinutes: 120,
    workMode: "v2_auto",
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
    cidadesExtrasGlobais: [
      "Anápolis",
      "Aracaju",
      "Balneário Camboriú",
      "Bauru",
      "Belém",
      "Belo Horizonte",
      "Blumenau",
      "Boa Vista",
      "Brasília",
      "Camaçari",
      "Campinas",
      "Campina Grande",
      "Campo Grande",
      "Campos dos Goytacazes",
      "Caruaru",
      "Cascavel",
      "Caxias do Sul",
      "Cuiabá",
      "Curitiba",
      "Duque de Caxias",
      "Florianópolis",
      "Fortaleza",
      "Foz do Iguaçu",
      "Franca",
      "Goiânia",
      "Imperatriz",
      "Indaiatuba",
      "Ipatinga",
      "Joinville",
      "João Pessoa",
      "Juazeiro do Norte",
      "Juiz de Fora",
      "Jundiaí",
      "Limeira",
      "Londrina",
      "Maceió",
      "Macapá",
      "Manaus",
      "Marabá",
      "Maringá",
      "Montes Claros",
      "Mogi das Cruzes",
      "Natal",
      "Novo Hamburgo",
      "Petrolina",
      "Piracicaba",
      "Ponta Grossa",
      "Porto Alegre",
      "Porto Velho",
      "Recife",
      "Ribeirão Preto",
      "Rio Branco",
      "Rio de Janeiro",
      "Rio Verde",
      "Salvador",
      "Santa Maria",
      "Santos",
      "São Bernardo do Campo",
      "São Gonçalo",
      "São José do Rio Preto",
      "São José dos Campos",
      "São Luís",
      "São Paulo",
      "Serra",
      "Sorocaba",
      "Taubaté",
      "Teresina",
      "Uberlândia",
      "Vila Velha",
      "Vitória da Conquista"
    ]
  },
  networkRotation: {
    enabled: true,
    intervalMinMinutes: 300,
    intervalMaxMinutes: 420,
    maxAttemptsPerCycle: 5,
    pauseBeforeRotationSec: 60,
    postRotationStabilizeSec: 30,
    maxWaitDownSec: 120,
    maxWaitUpSec: 300,
    pollSec: 5,
    gatewayHost: "",
    loginUrl: "",
    rebootUrl: "",
    modemUsername: "",
    modemPassword: ""
  },
  dailyWindow: {
    enabled: true,
    executionMode: "window_close_open",
    closeWindowStartHour: 1,
    closeWindowStartMinute: 0,
    closeWindowEndHour: 3,
    closeWindowEndMinute: 0,
    openWindowStartHour: 5,
    openWindowStartMinute: 0,
    openWindowEndHour: 7,
    openWindowEndMinute: 0
  },
  marketplaceRenew: {
    enabled: false,
    windowStartHour: 8,
    windowStartMinute: 0,
    windowEndHour: 0,
    windowEndMinute: 0,
    scrollDaysMin: 7,
    scrollDaysMax: 45
  },
  // Limpeza terminal: INDEPENDENTE do renovar/fechar/abrir.
  // Default off = zero regressão na migração (antes rodava acoplada ao abrir).
  // deleteKinds: o que excluir quando enabled=true (default = legado + id_virtus).
  terminalAccountCleanup: {
    enabled: false,
    windowStartHour: 0,
    windowStartMinute: 0,
    windowEndHour: 1,
    windowEndMinute: 0,
    deleteKinds: {
      banned: true,
      captcha: true,
      two_factor: true,
      marketplace_disabled: true,
      id_virtus: true
    }
  }
});

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hmToMin(h, m) {
  return (Math.max(0, Math.min(23, Math.floor(Number(h) || 0))) * 60) + Math.max(0, Math.min(59, Math.floor(Number(m) || 0)));
}

function windowDurationMinutes(startMin, endMin) {
  const s = Math.max(0, Math.min(1439, Math.floor(Number(startMin) || 0)));
  const e = Math.max(0, Math.min(1439, Math.floor(Number(endMin) || 0)));
  return e > s ? (e - s) : ((1440 - s) + e);
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
  const memRaw = (r.memory && typeof r.memory === "object") ? r.memory : {};
  const robe = (r.robe && typeof r.robe === "object") ? r.robe : {};
  const net = (r.networkRotation && typeof r.networkRotation === "object") ? r.networkRotation : {};
  const daily = (r.dailyWindow && typeof r.dailyWindow === "object") ? r.dailyWindow : {};
  const renew = (r.marketplaceRenew && typeof r.marketplaceRenew === "object") ? r.marketplaceRenew : {};
  const termClean = (r.terminalAccountCleanup && typeof r.terminalAccountCleanup === "object")
    ? r.terminalAccountCleanup
    : {};
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
  const workMode = (workModeRaw === "v3_pmg")
    ? "v3_pmg"
    : ((workModeRaw === "v2_auto") ? "v2_auto" : "v1");
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

  let governorEnterMb = clamp(Math.floor(toNum(memRaw.governorEnterMb, DEFAULTS.memory.governorEnterMb)), 256, 32768);
  let governorExitMb = clamp(Math.floor(toNum(memRaw.governorExitMb, DEFAULTS.memory.governorExitMb)), 256, 32768);
  if (governorExitMb < governorEnterMb) governorExitMb = governorEnterMb;
  const hostBaseMb = clamp(Math.floor(toNum(memRaw.hostBaseMb, DEFAULTS.memory.hostBaseMb)), 256, 16384);
  const reservePer8GbMb = clamp(Math.floor(toNum(memRaw.reservePer8GbMb, DEFAULTS.memory.reservePer8GbMb)), 0, 8192);
  const provisionSpikeMb = clamp(Math.floor(toNum(memRaw.provisionSpikeMb, DEFAULTS.memory.provisionSpikeMb)), 256, 8192);
  const intervalMinRaw = Math.floor(toNum(net.intervalMinMinutes, DEFAULTS.networkRotation.intervalMinMinutes));
  const intervalMaxRaw = Math.floor(toNum(net.intervalMaxMinutes, DEFAULTS.networkRotation.intervalMaxMinutes));
  const intervalMinMinutes = clamp(Math.min(intervalMinRaw, intervalMaxRaw), 10, 24 * 60);
  const intervalMaxMinutes = clamp(Math.max(intervalMinRaw, intervalMaxRaw), intervalMinMinutes, 24 * 60);
  const maxAttemptsPerCycle = clamp(Math.floor(toNum(net.maxAttemptsPerCycle, DEFAULTS.networkRotation.maxAttemptsPerCycle)), 1, 5);
  const pauseBeforeRotationSec = clamp(Math.floor(toNum(net.pauseBeforeRotationSec, DEFAULTS.networkRotation.pauseBeforeRotationSec)), 5, 300);
  const postRotationStabilizeSec = clamp(Math.floor(toNum(net.postRotationStabilizeSec, DEFAULTS.networkRotation.postRotationStabilizeSec)), 5, 180);
  const maxWaitDownSec = clamp(Math.floor(toNum(net.maxWaitDownSec, DEFAULTS.networkRotation.maxWaitDownSec)), 10, 300);
  const maxWaitUpSec = clamp(Math.floor(toNum(net.maxWaitUpSec, DEFAULTS.networkRotation.maxWaitUpSec)), 20, 900);
  const pollSec = clamp(Math.floor(toNum(net.pollSec, DEFAULTS.networkRotation.pollSec)), 2, 20);
  const gatewayHost = String(net.gatewayHost || DEFAULTS.networkRotation.gatewayHost).trim().slice(0, 120);
  const loginUrl = String(net.loginUrl || DEFAULTS.networkRotation.loginUrl).trim().slice(0, 240);
  const rebootUrl = String(net.rebootUrl || DEFAULTS.networkRotation.rebootUrl).trim().slice(0, 240);
  const modemUsername = String(net.modemUsername || DEFAULTS.networkRotation.modemUsername).trim().slice(0, 120);
  const modemPassword = String(net.modemPassword || DEFAULTS.networkRotation.modemPassword).trim().slice(0, 180);
  const closeWindowStartHour = clamp(Math.floor(toNum(
    daily.closeWindowStartHour,
    (daily.closeHour !== undefined ? daily.closeHour : DEFAULTS.dailyWindow.closeWindowStartHour)
  )), 0, 23);
  const closeWindowStartMinute = clamp(Math.floor(toNum(
    daily.closeWindowStartMinute,
    (daily.closeMinute !== undefined ? daily.closeMinute : DEFAULTS.dailyWindow.closeWindowStartMinute)
  )), 0, 59);
  const closeWindowEndHour = clamp(Math.floor(toNum(daily.closeWindowEndHour, DEFAULTS.dailyWindow.closeWindowEndHour)), 0, 23);
  const closeWindowEndMinute = clamp(Math.floor(toNum(daily.closeWindowEndMinute, DEFAULTS.dailyWindow.closeWindowEndMinute)), 0, 59);
  const openWindowStartHour = clamp(Math.floor(toNum(
    daily.openWindowStartHour,
    (daily.openHour !== undefined ? daily.openHour : DEFAULTS.dailyWindow.openWindowStartHour)
  )), 0, 23);
  const openWindowStartMinute = clamp(Math.floor(toNum(
    daily.openWindowStartMinute,
    (daily.openMinute !== undefined ? daily.openMinute : DEFAULTS.dailyWindow.openWindowStartMinute)
  )), 0, 59);
  const openWindowEndHour = clamp(Math.floor(toNum(daily.openWindowEndHour, DEFAULTS.dailyWindow.openWindowEndHour)), 0, 23);
  const openWindowEndMinute = clamp(Math.floor(toNum(daily.openWindowEndMinute, DEFAULTS.dailyWindow.openWindowEndMinute)), 0, 59);
  const executionModeRaw = String(daily.executionMode || "").trim().toLowerCase();
  let executionMode = "always_on_24h";
  // Migração: renew_window_close_open vira window_close_open (renovação agora é config própria).
  if (executionModeRaw === "window_close_open" || executionModeRaw === "renew_window_close_open") {
    executionMode = "window_close_open";
  }
  const renewScrollDaysMinRaw = clamp(Math.floor(toNum(renew.scrollDaysMin, DEFAULTS.marketplaceRenew.scrollDaysMin)), 1, 120);
  const renewScrollDaysMaxRaw = clamp(Math.floor(toNum(renew.scrollDaysMax, DEFAULTS.marketplaceRenew.scrollDaysMax)), 1, 120);
  const renewScrollDaysMin = Math.min(renewScrollDaysMinRaw, renewScrollDaysMaxRaw);
  const renewScrollDaysMax = Math.max(renewScrollDaysMinRaw, renewScrollDaysMaxRaw);

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
    memory: {
      governorEnterMb,
      governorExitMb,
      hostBaseMb,
      reservePer8GbMb,
      provisionSpikeMb
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
    },
    networkRotation: {
      enabled: net.enabled === true,
      intervalMinMinutes,
      intervalMaxMinutes,
      maxAttemptsPerCycle,
      pauseBeforeRotationSec,
      postRotationStabilizeSec,
      maxWaitDownSec,
      maxWaitUpSec,
      pollSec,
      gatewayHost,
      loginUrl,
      rebootUrl,
      modemUsername,
      modemPassword
    },
    dailyWindow: {
      enabled: daily.enabled === true || executionMode === "window_close_open",
      executionMode,
      closeWindowStartHour,
      closeWindowStartMinute,
      closeWindowEndHour,
      closeWindowEndMinute,
      openWindowStartHour,
      openWindowStartMinute,
      openWindowEndHour,
      openWindowEndMinute
    },
    marketplaceRenew: {
      enabled: renew.enabled === true,
      windowStartHour: clamp(Math.floor(toNum(
        renew.windowStartHour,
        DEFAULTS.marketplaceRenew.windowStartHour
      )), 0, 23),
      windowStartMinute: clamp(Math.floor(toNum(
        renew.windowStartMinute,
        DEFAULTS.marketplaceRenew.windowStartMinute
      )), 0, 59),
      windowEndHour: clamp(Math.floor(toNum(
        renew.windowEndHour,
        DEFAULTS.marketplaceRenew.windowEndHour
      )), 0, 23),
      windowEndMinute: clamp(Math.floor(toNum(
        renew.windowEndMinute,
        DEFAULTS.marketplaceRenew.windowEndMinute
      )), 0, 59),
      scrollDaysMin: renewScrollDaysMin,
      scrollDaysMax: renewScrollDaysMax
    },
    terminalAccountCleanup: (() => {
      const defKinds = DEFAULTS.terminalAccountCleanup.deleteKinds || {};
      const rawKinds = (termClean.deleteKinds && typeof termClean.deleteKinds === "object")
        ? termClean.deleteKinds
        : null;
      // Config antiga sem deleteKinds → defaults (legado + id_virtus).
      const deleteKinds = rawKinds
        ? {
          banned: rawKinds.banned === true,
          captcha: rawKinds.captcha === true,
          two_factor: rawKinds.two_factor === true,
          marketplace_disabled: rawKinds.marketplace_disabled === true,
          id_virtus: rawKinds.id_virtus === true
        }
        : {
          banned: defKinds.banned !== false,
          captcha: defKinds.captcha !== false,
          two_factor: defKinds.two_factor !== false,
          marketplace_disabled: defKinds.marketplace_disabled !== false,
          id_virtus: defKinds.id_virtus !== false
        };
      return {
        enabled: termClean.enabled === true,
        windowStartHour: clamp(Math.floor(toNum(
          termClean.windowStartHour,
          DEFAULTS.terminalAccountCleanup.windowStartHour
        )), 0, 23),
        windowStartMinute: clamp(Math.floor(toNum(
          termClean.windowStartMinute,
          DEFAULTS.terminalAccountCleanup.windowStartMinute
        )), 0, 59),
        windowEndHour: clamp(Math.floor(toNum(
          termClean.windowEndHour,
          DEFAULTS.terminalAccountCleanup.windowEndHour
        )), 0, 23),
        windowEndMinute: clamp(Math.floor(toNum(
          termClean.windowEndMinute,
          DEFAULTS.terminalAccountCleanup.windowEndMinute
        )), 0, 59),
        deleteKinds
      };
    })()
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
  const mem = (p.memory && typeof p.memory === "object") ? p.memory : null;
  const net = (p.networkRotation && typeof p.networkRotation === "object") ? p.networkRotation : null;
  const daily = (p.dailyWindow && typeof p.dailyWindow === "object") ? p.dailyWindow : null;
  const renew = (p.marketplaceRenew && typeof p.marketplaceRenew === "object") ? p.marketplaceRenew : null;
  const termClean = (p.terminalAccountCleanup && typeof p.terminalAccountCleanup === "object")
    ? p.terminalAccountCleanup
    : null;
  if (!cap && !robe && !mem && !net && !daily && !renew && !termClean) {
    return { ok: false, error: "payload_sem_campos_reconhecidos" };
  }

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
      if (!["v1", "v2_auto", "v3_pmg"].includes(wm)) {
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
  if (mem) {
    const intFields = ["governorEnterMb", "governorExitMb", "hostBaseMb", "reservePer8GbMb", "provisionSpikeMb"];
    for (const f of intFields) {
      if (mem[f] !== undefined) {
        const n = toNum(mem[f], NaN);
        if (!Number.isFinite(n)) errors.push(`memory.${f}_invalido`);
      }
    }
  }
  if (net) {
    const intFields = ["intervalMinMinutes", "intervalMaxMinutes", "maxAttemptsPerCycle", "pauseBeforeRotationSec", "postRotationStabilizeSec", "maxWaitDownSec", "maxWaitUpSec", "pollSec"];
    for (const f of intFields) {
      if (net[f] !== undefined) {
        const n = toNum(net[f], NaN);
        if (!Number.isFinite(n)) errors.push(`networkRotation.${f}_invalido`);
      }
    }
    if (net.enabled !== undefined && typeof net.enabled !== "boolean") {
      errors.push("networkRotation.enabled_invalido");
    }
    const urlFields = ["loginUrl", "rebootUrl"];
    for (const f of urlFields) {
      if (net[f] !== undefined) {
        const v = String(net[f] || "").trim();
        if (v && !/^https?:\/\//i.test(v)) errors.push(`networkRotation.${f}_url_invalido`);
      }
    }
    const strFields = ["gatewayHost", "modemUsername", "modemPassword"];
    for (const f of strFields) {
      if (net[f] !== undefined && typeof net[f] !== "string") {
        errors.push(`networkRotation.${f}_invalido`);
      }
    }
  }
  if (daily) {
    if (daily.enabled !== undefined && typeof daily.enabled !== "boolean") {
      errors.push("dailyWindow.enabled_invalido");
    }
    if (daily.executionMode !== undefined) {
      const mode = String(daily.executionMode || "").trim().toLowerCase();
      // renew_window_close_open: legado aceito só para migrar → window_close_open (sem fused renew).
      if (!["always_on_24h", "window_close_open", "renew_window_close_open"].includes(mode)) {
        errors.push("dailyWindow.executionMode_invalido");
      }
    }
    const intFields = [
      "closeWindowStartHour", "closeWindowStartMinute", "closeWindowEndHour", "closeWindowEndMinute",
      "openWindowStartHour", "openWindowStartMinute", "openWindowEndHour", "openWindowEndMinute",
      // legado
      "closeHour", "closeMinute", "openHour", "openMinute"
    ];
    for (const f of intFields) {
      if (daily[f] !== undefined) {
        const n = toNum(daily[f], NaN);
        if (!Number.isFinite(n)) errors.push(`dailyWindow.${f}_invalido`);
      }
    }
  }
  if (renew) {
    if (renew.enabled !== undefined && typeof renew.enabled !== "boolean") {
      errors.push("marketplaceRenew.enabled_invalido");
    }
    const intFields = [
      "windowStartHour",
      "windowStartMinute",
      "windowEndHour",
      "windowEndMinute",
      "scrollDaysMin",
      "scrollDaysMax"
    ];
    for (const f of intFields) {
      if (renew[f] !== undefined) {
        const n = toNum(renew[f], NaN);
        if (!Number.isFinite(n)) errors.push(`marketplaceRenew.${f}_invalido`);
      }
    }
  }
  if (termClean) {
    if (termClean.enabled !== undefined && typeof termClean.enabled !== "boolean") {
      errors.push("terminalAccountCleanup.enabled_invalido");
    }
    const intFields = [
      "windowStartHour", "windowStartMinute", "windowEndHour", "windowEndMinute"
    ];
    for (const f of intFields) {
      if (termClean[f] !== undefined) {
        const n = toNum(termClean[f], NaN);
        if (!Number.isFinite(n)) errors.push(`terminalAccountCleanup.${f}_invalido`);
      }
    }
    if (termClean.deleteKinds !== undefined) {
      if (!termClean.deleteKinds || typeof termClean.deleteKinds !== "object") {
        errors.push("terminalAccountCleanup.deleteKinds_invalido");
      } else {
        for (const k of ["banned", "captcha", "two_factor", "marketplace_disabled", "id_virtus"]) {
          if (termClean.deleteKinds[k] !== undefined && typeof termClean.deleteKinds[k] !== "boolean") {
            errors.push(`terminalAccountCleanup.deleteKinds.${k}_invalido`);
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
    robe: { ...DEFAULTS.robe, ...((readServerConfigRaw() || {}).robe || {}), ...(robe || {}) },
    memory: { ...DEFAULTS.memory, ...((readServerConfigRaw() || {}).memory || {}), ...(mem || {}) },
    networkRotation: { ...DEFAULTS.networkRotation, ...((readServerConfigRaw() || {}).networkRotation || {}), ...(net || {}) },
    dailyWindow: { ...DEFAULTS.dailyWindow, ...((readServerConfigRaw() || {}).dailyWindow || {}), ...(daily || {}) },
    marketplaceRenew: {
      ...DEFAULTS.marketplaceRenew,
      ...((readServerConfigRaw() || {}).marketplaceRenew || {}),
      ...(renew || {})
    },
    terminalAccountCleanup: {
      ...DEFAULTS.terminalAccountCleanup,
      ...((readServerConfigRaw() || {}).terminalAccountCleanup || {}),
      ...(termClean || {})
    }
  };
  const normalized = buildNormalizedConfig(merged, { source: "file" });
  if (normalized.robe.windowEndMin <= normalized.robe.windowStartMin) {
    return { ok: false, error: "validation_failed", details: ["robe.window_intervalo_invalido"] };
  }
  const closeStartMin = hmToMin(normalized.dailyWindow.closeWindowStartHour, normalized.dailyWindow.closeWindowStartMinute);
  const closeEndMin = hmToMin(normalized.dailyWindow.closeWindowEndHour, normalized.dailyWindow.closeWindowEndMinute);
  const openStartMin = hmToMin(normalized.dailyWindow.openWindowStartHour, normalized.dailyWindow.openWindowStartMinute);
  const openEndMin = hmToMin(normalized.dailyWindow.openWindowEndHour, normalized.dailyWindow.openWindowEndMinute);
  const closeDur = windowDurationMinutes(closeStartMin, closeEndMin);
  const openDur = windowDurationMinutes(openStartMin, openEndMin);
  if (closeDur < 1 || closeDur > 720) {
    return { ok: false, error: "validation_failed", details: ["dailyWindow.close_window_invalida"] };
  }
  if (openDur < 1 || openDur > 720) {
    return { ok: false, error: "validation_failed", details: ["dailyWindow.open_window_invalida"] };
  }
  const renewStart = hmToMin(
    normalized.marketplaceRenew.windowStartHour,
    normalized.marketplaceRenew.windowStartMinute
  );
  const renewEnd = hmToMin(
    normalized.marketplaceRenew.windowEndHour,
    normalized.marketplaceRenew.windowEndMinute
  );
  const renewDur = windowDurationMinutes(renewStart, renewEnd);
  if (renewDur < 1 || renewDur >= 1440) {
    return { ok: false, error: "validation_failed", details: ["marketplaceRenew.window_invalida"] };
  }
  const tcStart = hmToMin(
    normalized.terminalAccountCleanup.windowStartHour,
    normalized.terminalAccountCleanup.windowStartMinute
  );
  const tcEnd = hmToMin(
    normalized.terminalAccountCleanup.windowEndHour,
    normalized.terminalAccountCleanup.windowEndMinute
  );
  const tcDur = windowDurationMinutes(tcStart, tcEnd);
  if (tcDur < 1 || tcDur > 720) {
    return { ok: false, error: "validation_failed", details: ["terminalAccountCleanup.window_invalida"] };
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
    memory: {
      governorEnterMb: v.normalized.memory.governorEnterMb,
      governorExitMb: v.normalized.memory.governorExitMb,
      hostBaseMb: v.normalized.memory.hostBaseMb,
      reservePer8GbMb: v.normalized.memory.reservePer8GbMb,
      provisionSpikeMb: v.normalized.memory.provisionSpikeMb
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
    },
    networkRotation: {
      enabled: v.normalized.networkRotation.enabled,
      intervalMinMinutes: v.normalized.networkRotation.intervalMinMinutes,
      intervalMaxMinutes: v.normalized.networkRotation.intervalMaxMinutes,
      maxAttemptsPerCycle: v.normalized.networkRotation.maxAttemptsPerCycle,
      pauseBeforeRotationSec: v.normalized.networkRotation.pauseBeforeRotationSec,
      postRotationStabilizeSec: v.normalized.networkRotation.postRotationStabilizeSec,
      maxWaitDownSec: v.normalized.networkRotation.maxWaitDownSec,
      maxWaitUpSec: v.normalized.networkRotation.maxWaitUpSec,
      pollSec: v.normalized.networkRotation.pollSec,
      gatewayHost: v.normalized.networkRotation.gatewayHost,
      loginUrl: v.normalized.networkRotation.loginUrl,
      rebootUrl: v.normalized.networkRotation.rebootUrl,
      modemUsername: v.normalized.networkRotation.modemUsername,
      modemPassword: v.normalized.networkRotation.modemPassword
    },
    dailyWindow: {
      enabled: v.normalized.dailyWindow.enabled,
      executionMode: v.normalized.dailyWindow.executionMode,
      closeWindowStartHour: v.normalized.dailyWindow.closeWindowStartHour,
      closeWindowStartMinute: v.normalized.dailyWindow.closeWindowStartMinute,
      closeWindowEndHour: v.normalized.dailyWindow.closeWindowEndHour,
      closeWindowEndMinute: v.normalized.dailyWindow.closeWindowEndMinute,
      openWindowStartHour: v.normalized.dailyWindow.openWindowStartHour,
      openWindowStartMinute: v.normalized.dailyWindow.openWindowStartMinute,
      openWindowEndHour: v.normalized.dailyWindow.openWindowEndHour,
      openWindowEndMinute: v.normalized.dailyWindow.openWindowEndMinute
    },
    marketplaceRenew: {
      enabled: v.normalized.marketplaceRenew.enabled === true,
      windowStartHour: v.normalized.marketplaceRenew.windowStartHour,
      windowStartMinute: v.normalized.marketplaceRenew.windowStartMinute,
      windowEndHour: v.normalized.marketplaceRenew.windowEndHour,
      windowEndMinute: v.normalized.marketplaceRenew.windowEndMinute,
      scrollDaysMin: v.normalized.marketplaceRenew.scrollDaysMin,
      scrollDaysMax: v.normalized.marketplaceRenew.scrollDaysMax
    },
    terminalAccountCleanup: {
      enabled: v.normalized.terminalAccountCleanup.enabled === true,
      windowStartHour: v.normalized.terminalAccountCleanup.windowStartHour,
      windowStartMinute: v.normalized.terminalAccountCleanup.windowStartMinute,
      windowEndHour: v.normalized.terminalAccountCleanup.windowEndHour,
      windowEndMinute: v.normalized.terminalAccountCleanup.windowEndMinute,
      deleteKinds: (() => {
        const dk = (v.normalized.terminalAccountCleanup
          && v.normalized.terminalAccountCleanup.deleteKinds
          && typeof v.normalized.terminalAccountCleanup.deleteKinds === 'object')
          ? v.normalized.terminalAccountCleanup.deleteKinds
          : (DEFAULTS.terminalAccountCleanup.deleteKinds || {});
        return {
          banned: dk.banned === true,
          captcha: dk.captcha === true,
          two_factor: dk.two_factor === true,
          marketplace_disabled: dk.marketplace_disabled === true,
          id_virtus: dk.id_virtus === true
        };
      })()
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

