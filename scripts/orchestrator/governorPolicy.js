"use strict";

function intFromEnv(env, name, fallback) {
  return parseInt(env[name] || String(fallback), 10) || fallback;
}

function buildConfig(env = process.env) {
  return {
    MEM_ENTER_MB: Math.max(256, intFromEnv(env, "CT_GOV_MEM_ENTER_MB", 2048)),
    MEM_EXIT_MB: Math.max(256, intFromEnv(env, "CT_GOV_MEM_EXIT_MB", 2048)),
    CPU_ENTER: 85,
    CPU_EXIT: 70,
    EMA_ALPHA_CPU: 0.30,
    EMA_ALPHA_MEM: 0.20,
    HOT_TICKS: 3,
    COOL_TICKS: 3,
    MIN_HOLD_MS: 45_000,
    ROBE_LIGHT_MIN_SPACING_MS: Math.max(10_000, intFromEnv(env, "CT_GOV_ROBE_LIGHT_MIN_SPACING_MS", 60_000)),
    ROBE_LIGHT_MAX_ENQUEUE_PER_TICK: Math.max(0, intFromEnv(env, "CT_GOV_ROBE_LIGHT_MAX_ENQUEUE_PER_TICK", 1)),
    ENTER_CONFIRM_MS: Math.max(10_000, intFromEnv(env, "CT_GOV_ENTER_CONFIRM_MS", 5 * 60 * 1000)),
    EXIT_CONFIRM_MS: Math.max(10_000, intFromEnv(env, "CT_GOV_EXIT_CONFIRM_MS", 5 * 60 * 1000)),
    LOOPLAG_ENTER_MS: intFromEnv(env, "CT_LOOPLAG_ENTER_MS", 400),
    LOOPLAG_EXIT_MS: intFromEnv(env, "CT_LOOPLAG_EXIT_MS", 200),
    LOOPLAG_MAX_ENTER_MS: intFromEnv(env, "CT_LOOPLAG_MAX_ENTER_MS", 2000),
    LOOPLAG_MAX_EXIT_MS: intFromEnv(env, "CT_LOOPLAG_MAX_EXIT_MS", 900),
    GOVERNOR_TICK_MS: intFromEnv(env, "CT_GOVERNOR_TICK_MS", 2000)
  };
}

function ema(prev, value, alpha) {
  return prev == null ? value : (alpha * value + ((1 - alpha) * prev));
}

function normalizeMemoryThresholds({ cfg, serverMemory } = {}) {
  let memEnterMb = cfg.MEM_ENTER_MB;
  let memExitMb = cfg.MEM_EXIT_MB;
  const m = serverMemory || null;
  if (m) {
    memEnterMb = Math.max(256, Math.floor(Number(m.governorEnterMb) || memEnterMb));
    memExitMb = Math.max(256, Math.floor(Number(m.governorExitMb) || memEnterMb));
    if (memExitMb < memEnterMb) memExitMb = memEnterMb;
  }
  return { memEnterMb, memExitMb };
}

function evaluateGovernorMode({ state, cfg, now = Date.now(), freeMB, lag, serverMemory } = {}) {
  const autoMode = state || {};
  const thresholds = normalizeMemoryThresholds({ cfg, serverMemory });
  const next = {
    eventLoopLagMs: lag && typeof lag.meanMs === "number" ? lag.meanMs : 0,
    eventLoopLagMaxMs: lag && typeof lag.maxMs === "number" ? lag.maxMs : 0,
    freeEmaMB: ema(autoMode.freeEmaMB, freeMB, cfg.EMA_ALPHA_MEM),
    pressureSince: Number(autoMode.pressureSince || 0) || 0,
    recoveredSince: Number(autoMode.recoveredSince || 0) || 0
  };

  const memLow = (freeMB > 0 && freeMB < thresholds.memEnterMb);
  const memHigh = (freeMB > 0 && freeMB >= thresholds.memExitMb);
  if (memLow) {
    if (!next.pressureSince) next.pressureSince = now;
  } else {
    next.pressureSince = 0;
  }
  if (memHigh) {
    if (!next.recoveredSince) next.recoveredSince = now;
  } else {
    next.recoveredSince = 0;
  }

  const canSwitch = (now - Number(autoMode.since || now)) >= cfg.MIN_HOLD_MS;
  let transition = null;
  if (autoMode.mode === "full") {
    if (next.pressureSince && (now - next.pressureSince) >= cfg.ENTER_CONFIRM_MS && canSwitch) {
      transition = { mode: "light", reason: "mem_low", logEvent: "enter_slow" };
    }
  } else if (next.recoveredSince && (now - next.recoveredSince) >= cfg.EXIT_CONFIRM_MS && canSwitch) {
    transition = { mode: "full", reason: "recovered", logEvent: "exit_slow", resetWindows: true };
  }

  return {
    next,
    transition,
    pressureNow: memLow,
    recoveredNow: memHigh,
    memEnterMb: thresholds.memEnterMb,
    memExitMb: thresholds.memExitMb
  };
}

module.exports = {
  buildConfig,
  ema,
  evaluateGovernorMode,
  normalizeMemoryThresholds
};
