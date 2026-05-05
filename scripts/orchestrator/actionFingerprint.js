"use strict";

const crypto = require("crypto");

function cleanPart(value, max = 120) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w:.-]+/g, "_")
    .slice(0, max) || "unknown";
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function actionKey({ profileId = "", actionKind = "", reason = "", source = "", targetState = "" } = {}) {
  const raw = [
    cleanPart(profileId, 160),
    cleanPart(actionKind, 80),
    cleanPart(targetState || reason, 120),
    cleanPart(source, 80)
  ].join("|");
  return `${raw}|${shortHash(raw)}`;
}

function signalKey({ profileId = "", kind = "", source = "", semanticKey = "" } = {}) {
  const raw = [
    cleanPart(profileId, 160),
    cleanPart(kind, 100),
    cleanPart(source, 80),
    cleanPart(semanticKey, 160)
  ].join("|");
  return `${raw}|${shortHash(raw)}`;
}

module.exports = {
  actionKey,
  signalKey
};
