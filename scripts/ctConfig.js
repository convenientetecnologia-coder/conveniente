"use strict";

const fs = require("fs");
const path = require("path");

const CT_CONFIG_PATH = path.join(__dirname, "..", "dados", "ct_config.json");
const NGROK_HOST_RE = /(?:^|\.)ngrok(?:-free)?\.(?:io|app)$/i;

function allowLegacyNgrokCtBase() {
  const raw = String(
    process.env.CT_ALLOW_NGROK_URL ||
    process.env.CT_ALLOW_LEGACY_TUNNELS ||
    ""
  ).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function isNgrokCtBaseUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return false;
  try {
    const host = String(new URL(raw).hostname || "").toLowerCase();
    if (!host) return false;
    if (NGROK_HOST_RE.test(host)) return true;
    return host.includes(".ngrok.");
  } catch {
    const value = raw.toLowerCase();
    return (
      value.includes(".ngrok.io") ||
      value.includes(".ngrok-free.app") ||
      value.includes(".ngrok.app")
    );
  }
}

function normalizeCtBaseUrl(rawValue, { allowLegacyNgrok = allowLegacyNgrokCtBase() } = {}) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const pathname = String(u.pathname || "").replace(/\/+$/, "");
    const normalizedPath = /^\/api$/i.test(pathname) ? "" : pathname;
    const out = `${u.protocol}//${u.host}${normalizedPath}`.replace(/\/+$/, "");
    if (!allowLegacyNgrok && isNgrokCtBaseUrl(out)) return "";
    return out;
  } catch {
    // Mantém comportamento compatível para valores legacy não-URL,
    // mas remove sufixo "/api" para evitar /api/api em runtime.
    const out = raw.replace(/\/+$/, "").replace(/\/api$/i, "");
    if (!allowLegacyNgrok && isNgrokCtBaseUrl(out)) return "";
    return out;
  }
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!String(raw || "").trim()) return null;
    const j = JSON.parse(raw);
    return (j && typeof j === "object") ? j : null;
  } catch {
    return null;
  }
}

function selfHealBlockedNgrokCtBase(rawCtBaseUrl) {
  try {
    if (allowLegacyNgrokCtBase()) return;
    const blocked = normalizeCtBaseUrl(rawCtBaseUrl, { allowLegacyNgrok: true });
    if (!blocked || !isNgrokCtBaseUrl(blocked)) return;

    const cur = safeReadJson(CT_CONFIG_PATH) || {};
    const currentBase = normalizeCtBaseUrl(cur && cur.ctBaseUrl, { allowLegacyNgrok: true });
    if (!currentBase || !isNgrokCtBaseUrl(currentBase)) return;

    const now = Date.now();
    const next = {
      ...(cur && typeof cur === "object" ? cur : {}),
      ctBaseUrl: "",
      legacyCtBaseUrl: blocked,
      legacyCtBaseBlockedAt: Number(cur && cur.legacyCtBaseBlockedAt) || now,
      legacyCtBaseReason: "blocked_ngrok_ct_base",
      updatedAt: now
    };

    fs.mkdirSync(path.dirname(CT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CT_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  } catch {
    // fail-safe: nunca quebra o fluxo por tentativa de auto-cura.
  }
}

function readCtConfig() {
  const j = safeReadJson(CT_CONFIG_PATH) || {};
  const rawCtBaseUrl = normalizeCtBaseUrl(j.ctBaseUrl || "", { allowLegacyNgrok: true });
  const ctBaseUrl = normalizeCtBaseUrl(rawCtBaseUrl || "");
  if (!ctBaseUrl && rawCtBaseUrl && isNgrokCtBaseUrl(rawCtBaseUrl) && !allowLegacyNgrokCtBase()) {
    selfHealBlockedNgrokCtBase(rawCtBaseUrl);
  }
  const logIngestSecret = String(j.logIngestSecret || "").trim();
  return {
    ok: true,
    path: CT_CONFIG_PATH,
    ctBaseUrl: ctBaseUrl || "",
    logIngestSecret: logIngestSecret || ""
  };
}

function writeCtConfig({ ctBaseUrl, logIngestSecret } = {}) {
  try {
    const curRaw = safeReadJson(CT_CONFIG_PATH) || {};
    const cur = readCtConfig();
    const ctBaseRaw = (ctBaseUrl !== undefined)
      ? normalizeCtBaseUrl(ctBaseUrl || "", { allowLegacyNgrok: true })
      : normalizeCtBaseUrl((curRaw && curRaw.ctBaseUrl) || (cur.ctBaseUrl || ""), { allowLegacyNgrok: true });
    const ctBaseSanitized = normalizeCtBaseUrl(ctBaseRaw || "");
    const now = Date.now();
    const next = {
      ...(curRaw && typeof curRaw === "object" ? curRaw : {}),
      ctBaseUrl: ctBaseSanitized || "",
      logIngestSecret: (logIngestSecret !== undefined) ? String(logIngestSecret || "").trim() : (cur.logIngestSecret || ""),
      updatedAt: now
    };
    if (!next.ctBaseUrl && ctBaseRaw && isNgrokCtBaseUrl(ctBaseRaw) && !allowLegacyNgrokCtBase()) {
      next.legacyCtBaseUrl = ctBaseRaw;
      next.legacyCtBaseBlockedAt = Number(next.legacyCtBaseBlockedAt || now) || now;
      next.legacyCtBaseReason = "blocked_ngrok_ct_base";
    } else if (next.ctBaseUrl) {
      try { delete next.legacyCtBaseUrl; } catch {}
      try { delete next.legacyCtBaseBlockedAt; } catch {}
      try { delete next.legacyCtBaseReason; } catch {}
    }
    fs.mkdirSync(path.dirname(CT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CT_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
    return { ok: true, path: CT_CONFIG_PATH };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = {
  CT_CONFIG_PATH,
  readCtConfig,
  writeCtConfig,
  normalizeCtBaseUrl,
  isNgrokCtBaseUrl
};

