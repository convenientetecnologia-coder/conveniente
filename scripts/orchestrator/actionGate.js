"use strict";

const actionFingerprint = require("./actionFingerprint.js");
const audit = require("./orchestratorAudit.js");

const activeByKey = new Map();
const activeByProfileKind = new Map();
const recentByKey = new Map();

function envFlag(name, defaultValue) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return !!defaultValue;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return !!defaultValue;
}

function enabled() {
  return envFlag("WORKER_ORCH_GATE", true);
}

function enforceEnabled() {
  return envFlag("WORKER_ORCH_GATE_ENFORCE", true);
}

function actionDefaults(actionKind) {
  const k = String(actionKind || "").toUpperCase();
  const table = {
    OPEN_BROWSER: { ttlMs: 180000, dedupeMs: 12000, priority: 30 },
    CLOSE_BROWSER: { ttlMs: 180000, dedupeMs: 12000, priority: 50 },
    START_WORK: { ttlMs: 120000, dedupeMs: 15000, priority: 40 },
    INVOKE_HUMAN: { ttlMs: 300000, dedupeMs: 20000, priority: 90 },
    HUMAN_RESUME: { ttlMs: 300000, dedupeMs: 20000, priority: 85 },
    LOGIN_REMEDIATE: { ttlMs: 900000, dedupeMs: 60000, priority: 80 },
    ROBE_POST_QUEUE: { ttlMs: 1800000, dedupeMs: 30000, priority: 35 }
  };
  return table[k] || { ttlMs: 120000, dedupeMs: 10000, priority: 10 };
}

function cleanup(now = Date.now()) {
  for (const [key, row] of activeByKey.entries()) {
    if (!row || Number(row.expiresAt || 0) <= now) activeByKey.delete(key);
  }
  for (const [key, row] of activeByProfileKind.entries()) {
    if (!row || Number(row.expiresAt || 0) <= now) activeByProfileKind.delete(key);
  }
  for (const [key, row] of recentByKey.entries()) {
    if (!row || Number(row.expiresAt || 0) <= now) recentByKey.delete(key);
  }
}

function beginAction({ profileId, actionKind, reason = "", source = "", ttlMs, dedupeMs, priority } = {}) {
  const now = Date.now();
  cleanup(now);
  const defaults = actionDefaults(actionKind);
  const ttl = Math.max(1000, Number(ttlMs || defaults.ttlMs) || defaults.ttlMs);
  const dedupe = Math.max(0, Number(dedupeMs == null ? defaults.dedupeMs : dedupeMs) || 0);
  const prio = Number(priority == null ? defaults.priority : priority) || defaults.priority;
  const actionKey = actionFingerprint.actionKey({ profileId, actionKind, reason, source });
  const kindKey = `${String(profileId || "")}|${String(actionKind || "").toUpperCase()}`;
  const exactActive = activeByKey.get(actionKey) || null;
  const sameKindActive = activeByProfileKind.get(kindKey) || null;
  const recent = recentByKey.get(actionKey) || null;
  const enforce = enabled() && enforceEnabled();
  const token = `${actionKey}:${now}:${Math.random().toString(16).slice(2)}`;

  let allow = true;
  let deniedReason = "";
  if (enabled()) {
    if (exactActive && Number(exactActive.expiresAt || 0) > now) {
      allow = false;
      deniedReason = "same_action_active";
    } else if (sameKindActive && Number(sameKindActive.expiresAt || 0) > now) {
      allow = false;
      deniedReason = "same_kind_active";
    } else if (recent && Number(recent.expiresAt || 0) > now) {
      allow = false;
      deniedReason = "recent_duplicate";
    }
  }

  if (!enforce) {
    allow = true;
    if (deniedReason) deniedReason = `shadow_${deniedReason}`;
  }

  const decision = {
    allow,
    deniedReason,
    profileId: String(profileId || ""),
    actionKind: String(actionKind || ""),
    actionKey,
    kindKey,
    token,
    priority: prio,
    ttlMs: ttl,
    dedupeMs: dedupe,
    enforce,
    enabled: enabled()
  };

  audit.append("action_gate_decision", decision);
  if (!allow) return decision;

  activeByKey.set(actionKey, {
    token,
    profileId: String(profileId || ""),
    actionKind: String(actionKind || ""),
    priority: prio,
    startedAt: now,
    expiresAt: now + ttl
  });
  activeByProfileKind.set(kindKey, {
    token,
    actionKey,
    profileId: String(profileId || ""),
    actionKind: String(actionKind || ""),
    priority: prio,
    startedAt: now,
    expiresAt: now + ttl
  });
  return decision;
}

function endAction(ticket, result = {}) {
  try {
    if (!ticket || !ticket.actionKey) return false;
    const cur = activeByKey.get(ticket.actionKey);
    if (cur && cur.token === ticket.token) activeByKey.delete(ticket.actionKey);
    const curKind = ticket.kindKey ? activeByProfileKind.get(ticket.kindKey) : null;
    if (curKind && curKind.token === ticket.token) activeByProfileKind.delete(ticket.kindKey);
    const dedupe = Math.max(0, Number(ticket.dedupeMs || 0) || 0);
    if (dedupe > 0) {
      recentByKey.set(ticket.actionKey, {
        endedAt: Date.now(),
        expiresAt: Date.now() + dedupe,
        result: result && typeof result === "object" ? {
          ok: result.ok == null ? null : !!result.ok,
          error: result.error ? String(result.error).slice(0, 160) : null
        } : null
      });
    }
    audit.append("action_gate_release", {
      profileId: ticket.profileId,
      actionKind: ticket.actionKind,
      actionKey: ticket.actionKey,
      token: ticket.token,
      result
    });
    cleanup();
    return true;
  } catch {
    return false;
  }
}

function snapshot() {
  cleanup();
  return {
    enabled: enabled(),
    enforce: enforceEnabled(),
    active: Array.from(activeByKey.values()),
    activeKinds: Array.from(activeByProfileKind.values()),
    recentCount: recentByKey.size
  };
}

module.exports = {
  beginAction,
  endAction,
  snapshot
};
