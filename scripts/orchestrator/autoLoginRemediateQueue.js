"use strict";

function buildConfig(env = process.env) {
  return {
    enabled: !(String(env.AUTO_LOGIN_REMEDIATE || "").trim() === "0"),
    tickMs: Math.max(2000, Number(env.AUTO_LOGIN_REMEDIATE_TICK_MS || 5000) || 5000),
    immediateDelayMs: Math.max(0, Number(env.AUTO_LOGIN_REMEDIATE_IMMEDIATE_DELAY_MS || 1200) || 1200),
    minIntervalPerProfileMs: Math.max(60_000, Number(env.AUTO_LOGIN_REMEDIATE_MIN_INTERVAL_MS || (20 * 60 * 1000)) || (20 * 60 * 1000)),
    maxAttemptsPerProfile24h: Math.max(1, Number(env.AUTO_LOGIN_REMEDIATE_MAX_ATTEMPTS_24H || 4) || 4),
    backoffFailMs: Math.max(60_000, Number(env.AUTO_LOGIN_REMEDIATE_BACKOFF_FAIL_MS || (45 * 60 * 1000)) || (45 * 60 * 1000)),
    totalTimeoutMs: Math.max(60_000, Number(env.AUTO_LOGIN_REMEDIATE_TOTAL_TIMEOUT_MS || (6 * 60 * 1000)) || (6 * 60 * 1000)),
    stageTimeoutMs: {
      activate: Math.max(10_000, Number(env.AUTO_LOGIN_REMEDIATE_STAGE_ACTIVATE_MS || 90_000) || 90_000),
      injectCookies: Math.max(30_000, Number(env.AUTO_LOGIN_REMEDIATE_STAGE_INJECT_MS || 240_000) || 240_000),
      loginFb: Math.max(30_000, Number(env.AUTO_LOGIN_REMEDIATE_STAGE_LOGIN_FB_MS || 120_000) || 120_000),
      loginMsg: Math.max(30_000, Number(env.AUTO_LOGIN_REMEDIATE_STAGE_LOGIN_MSG_MS || 120_000) || 120_000),
      collectCookies: Math.max(10_000, Number(env.AUTO_LOGIN_REMEDIATE_STAGE_COLLECT_MS || 90_000) || 90_000)
    }
  };
}

function pruneWindow(arr, winMs, now = Date.now()) {
  const a = Array.isArray(arr) ? arr : [];
  return a.filter(ts => ts && (now - ts) <= winMs);
}

function isDeferredByGate(resp) {
  try {
    if (!resp || typeof resp !== "object") return false;
    if (resp.deduped !== true) return false;
    const reason = String(resp.gateReason || "").toLowerCase();
    return (
      reason.includes("conflict_group_active") ||
      reason.includes("same_action_active") ||
      reason.includes("same_kind_active") ||
      reason.includes("recent_duplicate")
    );
  } catch {
    return false;
  }
}

function createAutoLoginRemediateQueue({ robeMeta, provisionAudit, issues, env = process.env } = {}) {
  const cfg = buildConfig(env);
  const meta = robeMeta || {};

  function queue(nome, { reason = "", source = "", immediate = false, force = false } = {}) {
    try {
      if (!cfg.enabled) return false;
      if (!nome) return false;
      meta[nome] = meta[nome] || {};
      const st = meta[nome].autoLoginRemediate = (meta[nome].autoLoginRemediate || {});
      const now = Date.now();

      st.attempts24h = pruneWindow(st.attempts24h, 24 * 60 * 60 * 1000, now);
      if ((st.attempts24h || []).length >= cfg.maxAttemptsPerProfile24h) {
        st.queued = false;
        st.nextAt = Math.max(st.nextAt || 0, now + (3 * 60 * 60 * 1000));
        try { if (issues) issues.append(nome, "mil_action", `auto_login_remediate_suppressed: max_attempts_24h=${cfg.maxAttemptsPerProfile24h}`).catch(()=>{}); } catch {}
        return false;
      }

      const last = Number(st.lastStartAt || 0) || 0;
      const earliest = force ? 0 : (last ? (last + cfg.minIntervalPerProfileMs) : 0);
      const when = Math.max(
        now + (immediate ? cfg.immediateDelayMs : 2500),
        earliest,
        force ? 0 : (Number(st.nextAt || 0) || 0)
      );
      const reasonShort = String(reason || "").slice(0, 80);
      const sourceShort = String(source || "").slice(0, 80);
      const prevQueued = !!st.queued;
      const prevNextAt = Number(st.nextAt || 0) || 0;
      const sameSignal = String(st.reason || "") === reasonShort && String(st.source || "") === sourceShort;
      if (prevQueued && sameSignal && prevNextAt && prevNextAt <= when && !force) {
        st.dedupeCount = (Number(st.dedupeCount || 0) || 0) + 1;
        try {
          if (provisionAudit) provisionAudit.append({
            ts: now,
            event: "auto_login_remediate_enqueue_deduped",
            nome: String(nome || ""),
            reason: String(reason || "").slice(0, 120),
            source: sourceShort,
            nextAt: prevNextAt,
            dedupeCount: st.dedupeCount
          });
        } catch {}
        return true;
      }

      st.queued = true;
      st.nextAt = when;
      st.reason = reasonShort;
      st.source = sourceShort;
      st.force = !!force;
      st.enqueuedAt = now;
      try {
        if (provisionAudit) provisionAudit.append({
          ts: now,
          event: "auto_login_remediate_queued",
          nome: String(nome || ""),
          reason: String(reason || "").slice(0, 120),
          source: sourceShort,
          nextAt: when,
          immediate: !!immediate,
          force: !!force
        });
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  async function deferByGate({ nome, st, resp, operator } = {}) {
    const retryMs = Math.max(15_000, Math.min(10 * 60_000, Number(resp && resp.gateRetryAfterMs || 0) || 45_000));
    const retryAt = Date.now() + retryMs;
    try {
      if (Array.isArray(st.attempts24h) && st.attempts24h[st.attempts24h.length - 1] === st.lastStartAt) st.attempts24h.pop();
    } catch {}
    st.queued = true;
    st.inFlight = false;
    st.nextAt = retryAt;
    st.lastDoneAt = Date.now();
    st.lastOk = false;
    st.lastError = resp && resp.error ? String(resp.error).slice(0, 160) : "orchestrator_gate_deferred";
    st.deferredByGateAt = Date.now();
    st.deferredByGateReason = resp && resp.gateReason ? String(resp.gateReason).slice(0, 80) : "";
    try {
      if (provisionAudit) provisionAudit.append({
        ts: Date.now(),
        event: "auto_login_remediate_gate_deferred",
        nome,
        operator,
        retryAt,
        retryMs,
        gateReason: resp && resp.gateReason ? String(resp.gateReason).slice(0, 120) : "",
        gateConflictAction: resp && resp.gateConflictAction ? String(resp.gateConflictAction).slice(0, 80) : "",
        gateConflictGroup: resp && resp.gateConflictGroup ? String(resp.gateConflictGroup).slice(0, 80) : ""
      });
    } catch {}
    try { if (issues) await issues.append(nome, "mil_action", `auto_login_remediate_deferred_by_gate retryMs=${retryMs} reason=${st.deferredByGateReason||""}`); } catch {}
    return { retryAt, retryMs };
  }

  return { cfg, queue, isDeferredByGate, deferByGate, pruneWindow };
}

module.exports = {
  buildConfig,
  createAutoLoginRemediateQueue,
  isDeferredByGate,
  pruneWindow
};
