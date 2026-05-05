"use strict";

const orchestratorAudit = require("./orchestratorAudit.js");
const actionFingerprint = require("./actionFingerprint.js");
const actionGate = require("./actionGate.js");

function audit(event, data = {}) {
  try { orchestratorAudit.append(event, data); } catch {}
}

function actorBegin(actor, data = {}) {
  try { return orchestratorAudit.begin(actor, data); } catch { return { end() {} }; }
}

function actionRequested(profileId, actionKind, data = {}) {
  try {
    const key = actionFingerprint.actionKey({
      profileId,
      actionKind,
      reason: data.reason || data.error || "",
      source: data.source || data.operator || ""
    });
    orchestratorAudit.append("critical_action_requested", {
      profileId: String(profileId || ""),
      actionKind: String(actionKind || ""),
      actionKey: key,
      ...data
    });
  } catch {}
}

function actionDone(profileId, actionKind, result = {}) {
  try {
    orchestratorAudit.append("critical_action_done", {
      profileId: String(profileId || ""),
      actionKind: String(actionKind || ""),
      ...result
    });
  } catch {}
}

function gateBegin(profileId, actionKind, data = {}) {
  try {
    return actionGate.beginAction({
      profileId,
      actionKind,
      reason: data.reason || data.error || "",
      source: data.source || data.operator || "",
      ttlMs: data.ttlMs,
      dedupeMs: data.dedupeMs,
      priority: data.priority
    });
  } catch {
    return { allow: true, noop: true, profileId: String(profileId || ""), actionKind: String(actionKind || "") };
  }
}

function gateEnd(ticket, result = {}) {
  try { actionGate.endAction(ticket, result); } catch {}
}

function gateRetryAfterMs(ticket, fallbackMs = 30_000) {
  try {
    const now = Date.now();
    const candidates = [];
    const conflictExpiresAt = Number(ticket && ticket.conflictActive && ticket.conflictActive.expiresAt || 0) || 0;
    if (conflictExpiresAt > now) candidates.push(conflictExpiresAt - now);
    const recentExpiresAt = Number(ticket && ticket.recent && ticket.recent.expiresAt || 0) || 0;
    if (recentExpiresAt > now) candidates.push(recentExpiresAt - now);
    if (Number(ticket && ticket.ttlMs || 0) > 0) candidates.push(Math.min(Number(ticket.ttlMs || 0), fallbackMs));
    const ms = candidates.length ? Math.max(...candidates) : fallbackMs;
    return Math.max(5_000, Math.min(10 * 60_000, Number(ms || fallbackMs) || fallbackMs));
  } catch {
    return fallbackMs;
  }
}

function gateDeniedResult(ticket, { ok = true, error = "orchestrator_duplicate_action" } = {}) {
  return {
    ok,
    skipped: true,
    deduped: true,
    error,
    gateReason: ticket && ticket.deniedReason ? String(ticket.deniedReason) : "denied",
    gateGroup: ticket && ticket.group ? String(ticket.group) : "",
    gateConflictAction: ticket && ticket.conflictActive && ticket.conflictActive.actionKind ? String(ticket.conflictActive.actionKind) : "",
    gateConflictGroup: ticket && ticket.conflictActive && ticket.conflictActive.group ? String(ticket.conflictActive.group) : "",
    gateRetryAfterMs: gateRetryAfterMs(ticket)
  };
}

function gateSnapshot() {
  try { return actionGate.snapshot(); } catch { return null; }
}

module.exports = {
  audit,
  actorBegin,
  actionRequested,
  actionDone,
  gateBegin,
  gateEnd,
  gateRetryAfterMs,
  gateDeniedResult,
  gateSnapshot
};
