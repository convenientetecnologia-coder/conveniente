"use strict";

// Centraliza a origem do endpoint do notificador (sitechatbot).
const { readCtConfig, normalizeCtBaseUrl } = require("./ctConfig");

function isNgrokTarget(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return false;
  try {
    const host = String(new URL(value).hostname || "").toLowerCase();
    return /(?:^|\.)ngrok(?:-free)?\.(?:io|app)$/.test(host);
  } catch {
    return /ngrok/i.test(value);
  }
}

function normalizeBase(rawBase) {
  const base = normalizeCtBaseUrl(rawBase || "");
  if (!base || isNgrokTarget(base)) return "";
  return base;
}

function resolveEndpoints() {
  // Preferência máxima: CT_BASE_URL/CT_URL (base do CT).
  const envBase = normalizeBase(process.env.CT_BASE_URL || process.env.CT_URL || "");
  if (envBase) return [`${envBase}/report`];

  // Fallback enterprise: config persistido em arquivo (para quando o node roda sem env).
  try {
    const cfg = readCtConfig();
    const cfgBase = normalizeBase(cfg && cfg.ctBaseUrl);
    if (cfgBase) return [`${cfgBase}/report`];
  } catch {}

  // Override explícito para URL completa.
  const env = String(process.env.CT_NOTIFIER_REPORT_URL || process.env.NOTIFIER_REPORT_URL || "").trim();
  if (env && !isNgrokTarget(env)) return [env];

  // Último fallback oficial (domínio próprio).
  const defaultBase = normalizeBase(process.env.CT_DEFAULT_BASE_URL || "https://api.convenientetecnologia.com");
  if (defaultBase) return [`${defaultBase}/report`];

  // Fail-closed: sem endpoint válido não tenta ngrok.
  return [];
}

function notifierBaseFromEndpoints() {
  try {
    const u = resolveEndpoints()[0] || "";
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

module.exports = { resolveEndpoints, notifierBaseFromEndpoints };

