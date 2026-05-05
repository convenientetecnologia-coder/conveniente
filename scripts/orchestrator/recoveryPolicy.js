"use strict";

const INTERNAL_REASONS = new Set([
  "ramKill",
  "cpuKill",
  "manifest_missing",
  "manifest_incomplete",
  "panic",
  "open_headroom"
]);

const EXTERNAL_REASONS = new Set([
  "disconnected",
  "no_pages",
  "zombie",
  "network",
  "fb_dom",
  "messenger_temp_block",
  "blocked"
]);

const FREEZE_REASONS = new Set(["manifest_missing", "manifest_incomplete"]);

function intFromEnv(env, name, fallback) {
  const value = parseInt(env[name] || String(fallback), 10);
  return Number.isFinite(value) ? value : fallback;
}

function envMs(env, name, fallback) {
  return Math.max(0, Number(env[name] || fallback) || fallback);
}

function buildConfig(env = process.env) {
  return {
    MAX_RELOADS: 2,
    RELOAD_TIMEOUT_MS: 10_000,
    RELOAD_POST_WAIT_MS: 250,
    REOPEN_DELAY_SHORT_MS: Math.max(5_000, intFromEnv(env, "REOPEN_DELAY_SHORT_MS", 60_000) || 60_000),
    REOPEN_DELAY_RAMCPU_MS: 60_000,
    FAIL_WINDOW_MS: 3 * 60 * 60 * 1000,
    FAIL_FREEZE_AFTER: 5,
    FAIL_FREEZE_MS: 2 * 60 * 60 * 1000,
    REOPEN_DELAY_VIRTUS_BLOCK_MS: 2 * 60 * 60 * 1000
  };
}

function classifyReason(reason, fallback) {
  if (INTERNAL_REASONS.has(reason)) return "internal";
  if (EXTERNAL_REASONS.has(reason)) return "external";
  return fallback || "unknown";
}

function normalizeRecord(rec) {
  return {
    internal: Array.isArray(rec && rec.internal) ? rec.internal : [],
    external: Array.isArray(rec && rec.external) ? rec.external : [],
    unknown: Array.isArray(rec && rec.unknown) ? rec.unknown : []
  };
}

function pruneRecord(rec, windowMs, now = Date.now()) {
  const current = normalizeRecord(rec);
  return {
    internal: current.internal.filter((ts) => (now - ts) < windowMs),
    external: current.external.filter((ts) => (now - ts) < windowMs),
    unknown: current.unknown.filter((ts) => (now - ts) < windowMs)
  };
}

function countFailures(profileFailures, nome, { cfg = buildConfig(), now = Date.now() } = {}) {
  const pruned = pruneRecord(profileFailures.get(nome), cfg.FAIL_WINDOW_MS, now);
  profileFailures.set(nome, pruned);
  return {
    internal: pruned.internal.length,
    external: pruned.external.length,
    unknown: pruned.unknown.length
  };
}

function recordFailure(profileFailures, nome, reason, {
  classification,
  cfg = buildConfig(),
  now = Date.now()
} = {}) {
  const cls = classification || classifyReason(reason, "unknown");
  const rec = pruneRecord(profileFailures.get(nome), cfg.FAIL_WINDOW_MS, now);

  if (cls === "internal") rec.internal.push(now);
  else if (cls === "external") rec.external.push(now);
  else rec.unknown.push(now);

  profileFailures.set(nome, rec);

  const counts = {
    internal: rec.internal.length,
    external: rec.external.length,
    unknown: rec.unknown.length
  };

  return {
    classification: cls,
    counts,
    freeze: FREEZE_REASONS.has(reason)
      ? { enabled: true, reason, ms: 12 * 60 * 60 * 1000, setBy: "system" }
      : { enabled: false }
  };
}

function getControlledReopenDelayMs(reason = "", {
  cfg = buildConfig(),
  env = process.env,
  random = Math.random
} = {}) {
  const r = String(reason || "").toLowerCase();
  const controlled = String(env.CONTROLLED_REOPEN_ENABLED || "1").trim() !== "0";
  if (!controlled) return cfg.REOPEN_DELAY_SHORT_MS;
  if (r === "ramkill" || r === "cpukill") {
    return cfg.REOPEN_DELAY_RAMCPU_MS + Math.floor(random() * 120_000);
  }
  if (r === "virtus_block") {
    return cfg.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(random() * 21 + 5) * 60 * 1000;
  }
  const minMs = envMs(env, "REOPEN_NON_RAM_MIN_MS", 5 * 60 * 1000);
  const maxMs = Math.max(minMs, envMs(env, "REOPEN_NON_RAM_MAX_MS", 15 * 60 * 1000));
  return minMs + Math.floor(random() * (maxMs - minMs + 1));
}

module.exports = {
  buildConfig,
  classifyReason,
  countFailures,
  getControlledReopenDelayMs,
  pruneRecord,
  recordFailure
};
