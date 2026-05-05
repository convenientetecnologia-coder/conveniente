"use strict";

const actionFingerprint = require("./actionFingerprint.js");
const audit = require("./orchestratorAudit.js");

const activeByKey = new Map();
const activeByProfileKind = new Map();
const activeByProfileGroup = new Map();
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
    OPEN_BROWSER: { ttlMs: 180000, dedupeMs: 12000, priority: 30, group: "lifecycle" },
    CLOSE_BROWSER: { ttlMs: 180000, dedupeMs: 12000, priority: 50, group: "lifecycle" },
    START_WORK: { ttlMs: 120000, dedupeMs: 15000, priority: 40, group: "work" },
    STOP_VIRTUS: { ttlMs: 60000, dedupeMs: 5000, priority: 45, group: "work" },
    RUN_CAPTCHA_FLOW: { ttlMs: 420000, dedupeMs: 45000, priority: 75, group: "remediation" },
    RUN_IDENTITY_FLOW: { ttlMs: 420000, dedupeMs: 45000, priority: 75, group: "remediation" },
    INVOKE_HUMAN: { ttlMs: 300000, dedupeMs: 20000, priority: 90, group: "human" },
    ENTER_HUMAN_MODE: { ttlMs: 300000, dedupeMs: 20000, priority: 90, group: "human" },
    HUMAN_RESUME: { ttlMs: 300000, dedupeMs: 20000, priority: 85, group: "human" },
    LOGIN_REMEDIATE: { ttlMs: 900000, dedupeMs: 60000, priority: 80, group: "remediation" },
    ROBE_POST_QUEUE: { ttlMs: 1800000, dedupeMs: 30000, priority: 35, group: "work" }
  };
  return table[k] || { ttlMs: 120000, dedupeMs: 10000, priority: 10, group: "misc" };
}

function conflictGroups(group) {
  const g = String(group || "misc");
  const table = {
    lifecycle: ["lifecycle", "remediation", "work"],
    remediation: ["lifecycle", "work"],
    work: ["lifecycle", "remediation"],
    human: ["lifecycle", "remediation", "work", "human"],
    misc: []
  };
  return table[g] || [];
}

function canPreempt({ incomingGroup, incomingPriority, active }) {
  if (!active) return false;
  const g = String(incomingGroup || "");
  if (g !== "human") return false;
  return Number(incomingPriority || 0) > Number(active.priority || 0);
}

function cleanup(now = Date.now()) {
  for (const [key, row] of activeByKey.entries()) {
    if (!row || Number(row.expiresAt || 0) <= now) activeByKey.delete(key);
  }
  for (const [key, row] of activeByProfileKind.entries()) {
    if (!row || Number(row.expiresAt || 0) <= now) activeByProfileKind.delete(key);
  }
  for (const [key, row] of activeByProfileGroup.entries()) {
    if (!row || Number(row.expiresAt || 0) <= now) activeByProfileGroup.delete(key);
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
  const group = String(defaults.group || "misc");
  const actionKey = actionFingerprint.actionKey({ profileId, actionKind, reason, source });
  const profile = String(profileId || "");
  const kindKey = `${String(profileId || "")}|${String(actionKind || "").toUpperCase()}`;
  const groupKey = `${profile}|${group}`;
  const exactActive = activeByKey.get(actionKey) || null;
  const sameKindActive = activeByProfileKind.get(kindKey) || null;
  const recent = recentByKey.get(actionKey) || null;
  let conflictActive = null;
  let conflictKey = "";
  for (const cg of conflictGroups(group)) {
    const ck = `${profile}|${cg}`;
    const row = activeByProfileGroup.get(ck) || null;
    if (!row || Number(row.expiresAt || 0) <= now) continue;
    if (canPreempt({ incomingGroup: group, incomingPriority: prio, active: row })) continue;
    conflictActive = row;
    conflictKey = ck;
    break;
  }
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
    } else if (conflictActive) {
      allow = false;
      deniedReason = "conflict_group_active";
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
    groupKey,
    group,
    conflictKey,
    conflictActive: conflictActive ? {
      actionKind: conflictActive.actionKind,
      group: conflictActive.group,
      priority: conflictActive.priority,
      startedAt: conflictActive.startedAt,
      expiresAt: conflictActive.expiresAt
    } : null,
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
  activeByProfileGroup.set(groupKey, {
    token,
    actionKey,
    profileId: String(profileId || ""),
    actionKind: String(actionKind || ""),
    group,
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
    const curGroup = ticket.groupKey ? activeByProfileGroup.get(ticket.groupKey) : null;
    if (curGroup && curGroup.token === ticket.token) activeByProfileGroup.delete(ticket.groupKey);
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
    activeGroups: Array.from(activeByProfileGroup.values()),
    recentCount: recentByKey.size
  };
}

module.exports = {
  beginAction,
  endAction,
  snapshot
};
