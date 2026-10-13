"use strict";

const fs = require("fs");
const path = require("path");

const CT_CONFIG_PATH = path.join(__dirname, "..", "dados", "ct_config.json");
const NGROK_HOST_RE = /(?:^|\.)ngrok(?:-free)?\.(?:io|app)$/i;
const CT_CANONICAL_API_BASE = "https://api.convenientetecnologia.com";

function canonicalCtApiBase() {
  const raw = String(
    process.env.CT_CANONICAL_API_BASE ||
    process.env.CT_DEFAULT_BASE_URL ||
    CT_CANONICAL_API_BASE
  ).trim();
  const normalized = normalizeCtBaseUrl(raw);
  return normalized || CT_CANONICAL_API_BASE;
}

function resolveCtApiBase(rawValue) {
  const normalized = normalizeCtBaseUrl(rawValue || "");
  return normalized || canonicalCtApiBase();
}

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
      ctBaseUrl: canonicalCtApiBase(),
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
  let ctBaseUrl = normalizeCtBaseUrl(rawCtBaseUrl || "");
  if (!ctBaseUrl && rawCtBaseUrl && isNgrokCtBaseUrl(rawCtBaseUrl) && !allowLegacyNgrokCtBase()) {
    selfHealBlockedNgrokCtBase(rawCtBaseUrl);
    ctBaseUrl = canonicalCtApiBase();
  }
  const logIngestSecret = String(j.logIngestSecret || "").trim();
  const textVerifiedApiKey = String(j.textVerifiedApiKey || "").trim();
  const textVerifiedApiUsername = String(j.textVerifiedApiUsername || "").trim();
  const textVerifiedBaseUrl = String(j.textVerifiedBaseUrl || "").trim();
  const textVerifiedServiceName = String(j.textVerifiedServiceName || "").trim();
  const textVerifiedServiceNotListedName = String(j.textVerifiedServiceNotListedName || "").trim();
  const textVerifiedMaxPrice = (j.textVerifiedMaxPrice == null || j.textVerifiedMaxPrice === "") ? null : Number(j.textVerifiedMaxPrice);
  const antiCaptchaApiKey = String(j.antiCaptchaApiKey || "").trim();
  const antiCaptchaBaseUrl = String(j.antiCaptchaBaseUrl || "").trim();
  return {
    ok: true,
    path: CT_CONFIG_PATH,
    ctBaseUrl: ctBaseUrl || "",
    logIngestSecret: logIngestSecret || "",
    textVerifiedApiKey: textVerifiedApiKey || "",
    textVerifiedApiUsername: textVerifiedApiUsername || "",
    textVerifiedBaseUrl: textVerifiedBaseUrl || "",
    textVerifiedServiceName: textVerifiedServiceName || "",
    textVerifiedServiceNotListedName: textVerifiedServiceNotListedName || "",
    textVerifiedMaxPrice: Number.isFinite(textVerifiedMaxPrice) ? Number(textVerifiedMaxPrice) : null,
    antiCaptchaApiKey: antiCaptchaApiKey || "",
    antiCaptchaBaseUrl: antiCaptchaBaseUrl || ""
  };
}

function pickInboundCtConfig(src) {
  if (!src || typeof src !== "object") return null;
  const text = (value) => String(value == null ? "" : value).trim();
  const patch = {};
  const base = text(src.ctBaseUrl);
  if (base) patch.ctBaseUrl = base;
  const apiKey = text(src.textVerifiedApiKey);
  if (apiKey) patch.textVerifiedApiKey = apiKey;
  const apiUsername = text(src.textVerifiedApiUsername);
  if (apiUsername) patch.textVerifiedApiUsername = apiUsername;
  const baseUrl = text(src.textVerifiedBaseUrl);
  if (baseUrl) patch.textVerifiedBaseUrl = baseUrl;
  const serviceName = text(src.textVerifiedServiceName);
  if (serviceName) patch.textVerifiedServiceName = serviceName;
  const serviceNotListedName = text(src.textVerifiedServiceNotListedName);
  if (serviceNotListedName) patch.textVerifiedServiceNotListedName = serviceNotListedName;
  if (src.textVerifiedMaxPrice != null && src.textVerifiedMaxPrice !== "") {
    const maxPrice = Number(src.textVerifiedMaxPrice);
    if (Number.isFinite(maxPrice) && maxPrice > 0) patch.textVerifiedMaxPrice = maxPrice;
  }
  const antiCaptchaApiKey = text(src.antiCaptchaApiKey);
  if (antiCaptchaApiKey) patch.antiCaptchaApiKey = antiCaptchaApiKey;
  const antiCaptchaBaseUrl = text(src.antiCaptchaBaseUrl);
  if (antiCaptchaBaseUrl) patch.antiCaptchaBaseUrl = antiCaptchaBaseUrl;
  return Object.keys(patch).length ? patch : null;
}

function ctConfigIsComplete(cfg) {
  return !!(
    cfg &&
    String(cfg.ctBaseUrl || "").trim() &&
    String(cfg.textVerifiedApiKey || "").trim() &&
    String(cfg.textVerifiedApiUsername || "").trim() &&
    String(cfg.antiCaptchaApiKey || "").trim()
  );
}

function applyInboundCtConfig(src) {
  const patch = pickInboundCtConfig(src);
  if (!patch) return { ok: false, complete: false, error: "ct_config_reply_empty" };
  const wr = writeCtConfig(patch);
  if (!wr || wr.ok !== true) {
    return { ok: false, complete: false, error: (wr && wr.error) || "write_ct_config_failed" };
  }
  const confirmed = readCtConfig();
  const hasBase = !!String(confirmed.ctBaseUrl || "").trim();
  const hasTextVerifiedKey = !!String(confirmed.textVerifiedApiKey || "").trim();
  const hasTextVerifiedUsername = !!String(confirmed.textVerifiedApiUsername || "").trim();
  const hasAntiCaptchaKey = !!String(confirmed.antiCaptchaApiKey || "").trim();
  return {
    ok: true,
    complete: ctConfigIsComplete(confirmed),
    hasBase,
    hasTextVerifiedKey,
    hasTextVerifiedUsername,
    hasAntiCaptchaKey
  };
}

function writeCtConfig({
  ctBaseUrl,
  logIngestSecret,
  textVerifiedApiKey,
  textVerifiedApiUsername,
  textVerifiedBaseUrl,
  textVerifiedServiceName,
  textVerifiedServiceNotListedName,
  textVerifiedMaxPrice,
  antiCaptchaApiKey,
  antiCaptchaBaseUrl
} = {}) {
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
      textVerifiedApiKey: (textVerifiedApiKey !== undefined) ? String(textVerifiedApiKey || "").trim() : (cur.textVerifiedApiKey || ""),
      textVerifiedApiUsername: (textVerifiedApiUsername !== undefined) ? String(textVerifiedApiUsername || "").trim() : (cur.textVerifiedApiUsername || ""),
      textVerifiedBaseUrl: (textVerifiedBaseUrl !== undefined) ? String(textVerifiedBaseUrl || "").trim() : (cur.textVerifiedBaseUrl || ""),
      textVerifiedServiceName: (textVerifiedServiceName !== undefined) ? String(textVerifiedServiceName || "").trim() : (cur.textVerifiedServiceName || ""),
      textVerifiedServiceNotListedName: (textVerifiedServiceNotListedName !== undefined)
        ? String(textVerifiedServiceNotListedName || "").trim()
        : (cur.textVerifiedServiceNotListedName || ""),
      textVerifiedMaxPrice: (textVerifiedMaxPrice !== undefined)
        ? (() => {
          const n = Number(textVerifiedMaxPrice);
          return Number.isFinite(n) && n > 0 ? n : null;
        })()
        : cur.textVerifiedMaxPrice,
      antiCaptchaApiKey: (antiCaptchaApiKey !== undefined) ? String(antiCaptchaApiKey || "").trim() : (cur.antiCaptchaApiKey || ""),
      antiCaptchaBaseUrl: (antiCaptchaBaseUrl !== undefined) ? String(antiCaptchaBaseUrl || "").trim() : (cur.antiCaptchaBaseUrl || ""),
      updatedAt: now
    };
    if (!next.ctBaseUrl && ctBaseRaw && isNgrokCtBaseUrl(ctBaseRaw) && !allowLegacyNgrokCtBase()) {
      next.ctBaseUrl = canonicalCtApiBase();
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
  CT_CANONICAL_API_BASE,
  canonicalCtApiBase,
  resolveCtApiBase,
  readCtConfig,
  writeCtConfig,
  pickInboundCtConfig,
  ctConfigIsComplete,
  applyInboundCtConfig,
  normalizeCtBaseUrl,
  isNgrokCtBaseUrl
};

