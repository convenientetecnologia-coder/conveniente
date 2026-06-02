"use strict";

const fs = require("fs");
const path = require("path");

const CT_CONFIG_PATH = path.join(__dirname, "..", "dados", "ct_config.json");

function normalizeCtBaseUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const pathname = String(u.pathname || "").replace(/\/+$/, "");
    const normalizedPath = /^\/api$/i.test(pathname) ? "" : pathname;
    const out = `${u.protocol}//${u.host}${normalizedPath}`.replace(/\/+$/, "");
    return out;
  } catch {
    // Mantém comportamento compatível para valores legacy não-URL,
    // mas remove sufixo "/api" para evitar /api/api em runtime.
    return raw.replace(/\/+$/, "").replace(/\/api$/i, "");
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

function readCtConfig() {
  const j = safeReadJson(CT_CONFIG_PATH) || {};
  const ctBaseUrl = normalizeCtBaseUrl(j.ctBaseUrl || "");
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
    const cur = readCtConfig();
    const next = {
      ctBaseUrl: (ctBaseUrl !== undefined) ? normalizeCtBaseUrl(ctBaseUrl || "") : (cur.ctBaseUrl || ""),
      logIngestSecret: (logIngestSecret !== undefined) ? String(logIngestSecret || "").trim() : (cur.logIngestSecret || ""),
      updatedAt: Date.now()
    };
    fs.mkdirSync(path.dirname(CT_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CT_CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
    return { ok: true, path: CT_CONFIG_PATH };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = { CT_CONFIG_PATH, readCtConfig, writeCtConfig, normalizeCtBaseUrl };

