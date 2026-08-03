"use strict";

/**
 * Push event-driven do snapshot de Config Servidor para o CT.
 * - Boot / primeiro tick do processo: manda 1x (mesmo sem mudar config).
 * - Save / mudança de hash: manda de novo.
 * - Sem spam: depois do ack local, só remanda se hash mudar ou force.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const serverConfig = require("./serverConfig.js");

const STATE_PATH = path.join(__dirname, "..", "dados", "server_config_ct_push.json");
const DESIRED_PATH = path.join(__dirname, "..", "dados", "desired.json");

let __pushedThisProcess = false;
let __forceReason = "";
let __forceAt = 0;

function __readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? obj : fallback;
  } catch {
    return fallback;
  }
}

function __writeJsonAtomic(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + "." + process.pid + "." + Date.now() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj || {}, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function readDesiredVirtusEngine() {
  try {
    const desired = __readJsonSafe(DESIRED_PATH, {}) || {};
    const eng =
      (desired && desired._autoMode && desired._autoMode.engine) ||
      (desired && desired.autoMode && desired.autoMode.engine) ||
      (desired && desired.engine) ||
      "";
    const n = String(eng || "").trim().toLowerCase();
    if (n === "legacy") return "legacy";
    return "delta";
  } catch {
    return "delta";
  }
}

function buildConfigMirror() {
  const totalMemMB = (() => {
    try {
      return serverConfig.getTotalMemMB();
    } catch {
      return null;
    }
  })();
  const effective = (() => {
    try {
      return serverConfig.readServerConfigEffective(
        Number.isFinite(Number(totalMemMB)) ? { totalMemMB: Number(totalMemMB) } : {}
      );
    } catch {
      return null;
    }
  })();
  if (!effective || typeof effective !== "object") return null;
  const virtusEngine = readDesiredVirtusEngine();
  // Espelho estável para o CT (sem campos voláteis de runtime).
  return {
    version: effective.version != null ? effective.version : null,
    updatedAt: Number(effective.updatedAt || 0) || 0,
    updatedBy: effective.updatedBy != null ? String(effective.updatedBy) : null,
    source: effective.source != null ? String(effective.source) : null,
    capacity: effective.capacity || null,
    memory: effective.memory || null,
    robe: effective.robe || null,
    networkRotation: effective.networkRotation || null,
    dailyWindow: effective.dailyWindow || null,
    marketplaceRenew: effective.marketplaceRenew || null,
    terminalAccountCleanup: effective.terminalAccountCleanup || null,
    virtusEngine,
    totalMemMB: Number.isFinite(Number(totalMemMB)) ? Number(totalMemMB) : null
  };
}

function hashConfigMirror(mirror) {
  try {
    if (!mirror || typeof mirror !== "object") return "";
    // Hash sem pushedAt (ainda não existe no mirror base).
    return crypto.createHash("sha1").update(JSON.stringify(mirror)).digest("hex");
  } catch {
    return "";
  }
}

function readPushState() {
  const st = __readJsonSafe(STATE_PATH, {}) || {};
  return {
    lastHash: String(st.lastHash || "").trim(),
    lastPushedAt: Number(st.lastPushedAt || 0) || 0,
    lastReason: st.lastReason != null ? String(st.lastReason) : null
  };
}

function requestPush(reason) {
  __forceReason = String(reason || "force").trim() || "force";
  __forceAt = Date.now();
}

function consumeForceRequest() {
  if (!__forceAt) return null;
  const reason = __forceReason || "force";
  __forceAt = 0;
  __forceReason = "";
  return reason;
}

/**
 * Decide se o próximo event bridge deve anexar serverConfig.
 * Boot / 1ª vez no processo / save / hash diferente → sim.
 */
function shouldPushConfig({ reason } = {}) {
  const force = consumeForceRequest();
  if (force) return { need: true, reason: force, hash: hashConfigMirror(buildConfigMirror()) };

  const mirror = buildConfigMirror();
  const hash = hashConfigMirror(mirror);
  if (!hash) return { need: false, reason: "no_config", hash: "" };

  const r = String(reason || "").trim();
  if (r === "boot" || r === "config_save") {
    return { need: true, reason: r, hash, mirror };
  }
  if (!__pushedThisProcess) {
    return { need: true, reason: "process_first", hash, mirror };
  }
  const st = readPushState();
  if (!st.lastHash || st.lastHash !== hash) {
    return { need: true, reason: st.lastHash ? "hash_changed" : "never_acked", hash, mirror };
  }
  return { need: false, reason: "already_pushed", hash, mirror };
}

function markPushed({ hash, reason } = {}) {
  const h = String(hash || "").trim();
  if (!h) return false;
  __pushedThisProcess = true;
  return __writeJsonAtomic(STATE_PATH, {
    lastHash: h,
    lastPushedAt: Date.now(),
    lastReason: String(reason || "").trim() || null
  });
}

function attachPushedMeta(mirror, { hash, reason } = {}) {
  const base = mirror && typeof mirror === "object" ? mirror : buildConfigMirror();
  if (!base) return null;
  return {
    ...base,
    configHash: String(hash || hashConfigMirror(base) || "").trim() || null,
    pushedAt: Date.now(),
    pushReason: String(reason || "").trim() || null
  };
}

module.exports = {
  STATE_PATH,
  buildConfigMirror,
  hashConfigMirror,
  readPushState,
  requestPush,
  shouldPushConfig,
  markPushed,
  attachPushedMeta
};
