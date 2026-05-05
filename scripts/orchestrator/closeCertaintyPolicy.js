"use strict";

const DEFAULT_REASONS = ["health_no_progress", "virtus_block", "nurse_zombie", "phantom_reopen"];

function intFromEnv(env, name, fallback) {
  return parseInt(env[name] || String(fallback), 10) || fallback;
}

function buildConfig(env = process.env) {
  return {
    WINDOW_MS: Math.max(20_000, intFromEnv(env, "CLOSE_CERTAINTY_WINDOW_MS", 120_000)),
    MIN_HITS: Math.max(1, intFromEnv(env, "CLOSE_CERTAINTY_MIN_HITS", 3)),
    MIN_SPAN_MS: Math.max(0, intFromEnv(env, "CLOSE_CERTAINTY_MIN_SPAN_MS", 25_000)),
    PENDING_HOLD_MS: Math.max(5_000, intFromEnv(env, "CLOSE_CERTAINTY_PENDING_HOLD_MS", 45_000)),
    PRESSURE_EXTRA_HITS: Math.max(0, intFromEnv(env, "CLOSE_CERTAINTY_PRESSURE_EXTRA_HITS", 1)),
    PRESSURE_EXTRA_SPAN_MS: Math.max(0, intFromEnv(env, "CLOSE_CERTAINTY_PRESSURE_EXTRA_SPAN_MS", 20_000)),
    REASONS: new Set(DEFAULT_REASONS)
  };
}

function normalizeReason(reason) {
  return String(reason || "").trim().toLowerCase();
}

function isGuardReason(reason, cfg) {
  const reasons = (cfg && cfg.REASONS) || new Set(DEFAULT_REASONS);
  return reasons.has(normalizeReason(reason));
}

function isPressureNow(autoMode) {
  try {
    const mode = String((autoMode && autoMode.mode) || "").toLowerCase();
    if (mode === "light") return true;
    const lagMean = Number((autoMode && autoMode.eventLoopLagMs) || 0) || 0;
    const lagMax = Number((autoMode && autoMode.eventLoopLagMaxMs) || 0) || 0;
    if (lagMean >= 900 || lagMax >= 1800) return true;
  } catch {}
  return false;
}

function resetState(prev = {}, { source = "ok_signal", now = Date.now() } = {}) {
  return {
    reason: "",
    firstAt: 0,
    lastAt: 0,
    hits: 0,
    lastSignal: "",
    lastPressure: false,
    lastDecisionAt: now,
    lastAllow: null,
    lastScore: 0,
    lastRequiredHits: 0,
    lastRequiredSpanMs: 0,
    lastResetAt: now,
    lastResetSource: String(source || "unknown"),
    prevReason: String(prev.reason || ""),
    prevHits: Number(prev.hits || 0) || 0
  };
}

function evaluate({ previousState, reason, signal = "", pressure = false, cfg, now = Date.now() } = {}) {
  const key = normalizeReason(reason);
  if (!isGuardReason(key, cfg)) {
    return {
      state: previousState || null,
      result: {
        guarded: false,
        allow: true,
        reason: key,
        hits: 0,
        spanMs: 0,
        requiredHits: 0,
        requiredSpanMs: 0,
        pressure: false,
        score: 1
      }
    };
  }

  const state = previousState || { reason: "", firstAt: 0, lastAt: 0, hits: 0 };
  const outOfWindow = state.lastAt > 0 && (now - state.lastAt) > cfg.WINDOW_MS;
  if (state.reason !== key || outOfWindow || !state.firstAt) {
    state.reason = key;
    state.firstAt = now;
    state.lastAt = now;
    state.hits = 0;
  }

  state.hits = (Number(state.hits || 0) || 0) + 1;
  state.lastAt = now;
  state.lastSignal = String(signal || "");

  const requiredHits = cfg.MIN_HITS + (pressure ? cfg.PRESSURE_EXTRA_HITS : 0);
  const requiredSpanMs = cfg.MIN_SPAN_MS + (pressure ? cfg.PRESSURE_EXTRA_SPAN_MS : 0);
  const spanMs = Math.max(0, now - (Number(state.firstAt || now) || now));
  const allow = state.hits >= requiredHits && spanMs >= requiredSpanMs;
  const scoreByHits = Math.min(1, state.hits / Math.max(1, requiredHits));
  const scoreBySpan = Math.min(1, spanMs / Math.max(1, requiredSpanMs));
  const score = Math.round(((scoreByHits * 0.6) + (scoreBySpan * 0.4)) * 1000) / 1000;

  state.lastPressure = pressure;
  state.lastDecisionAt = now;
  state.lastAllow = allow;
  state.lastScore = score;
  state.lastRequiredHits = requiredHits;
  state.lastRequiredSpanMs = requiredSpanMs;

  return {
    state,
    result: {
      guarded: true,
      allow,
      reason: key,
      hits: state.hits,
      spanMs,
      requiredHits,
      requiredSpanMs,
      pressure,
      score
    }
  };
}

module.exports = {
  buildConfig,
  evaluate,
  isGuardReason,
  isPressureNow,
  normalizeReason,
  resetState
};
