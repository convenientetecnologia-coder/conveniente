"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readCtConfig, writeCtConfig } = require("./ctConfig.js");

const DEFAULT_BASE_URL = "https://www.textverified.com";
const AUTH_SKEW_MS = 30 * 1000;
const AUTH_TIMEOUT_MS = 20 * 1000;
const DEFAULT_TIMEOUT_MS = 45 * 1000;
const SERVICES_CACHE_MS = 10 * 60 * 1000;

const authState = {
  key: "",
  username: "",
  baseUrl: "",
  token: "",
  expiresAtMs: 0
};

const servicesState = {
  baseUrl: "",
  at: 0,
  services: []
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0) || 0)));
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function maskLast4(value) {
  const d = digitsOnly(value);
  return d.length > 4 ? `***${d.slice(-4)}` : d;
}

function maskIdTail(value) {
  const s = String(value || "").trim();
  return s.length > 6 ? s.slice(-6) : s;
}

function readHostIdSafe() {
  try {
    const fp = path.join(__dirname, "..", "dados", ".telemetry_hostid");
    return String(fs.readFileSync(fp, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function resolveConfig() {
  const cfg = (() => {
    try { return readCtConfig(); } catch { return null; }
  })();
  const maxPriceRaw =
    process.env.TEXTVERIFIED_MAX_PRICE ||
    ((cfg && cfg.textVerifiedMaxPrice != null) ? String(cfg.textVerifiedMaxPrice) : "");
  const maxPriceNum = Number(maxPriceRaw);
  return {
    baseUrl: String(process.env.TEXTVERIFIED_BASE_URL || (cfg && cfg.textVerifiedBaseUrl) || DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
    apiKey: String(process.env.TEXTVERIFIED_API_KEY || (cfg && cfg.textVerifiedApiKey) || "").trim(),
    apiUsername: String(process.env.TEXTVERIFIED_API_USERNAME || (cfg && cfg.textVerifiedApiUsername) || "").trim(),
    serviceName: String(process.env.TEXTVERIFIED_FACEBOOK_SERVICE || (cfg && cfg.textVerifiedServiceName) || "auto").trim(),
    serviceNotListedName: String(process.env.TEXTVERIFIED_SERVICE_NOT_LISTED_NAME || (cfg && cfg.textVerifiedServiceNotListedName) || "Facebook Marketplace").trim(),
    maxPrice: Number.isFinite(maxPriceNum) && maxPriceNum > 0 ? Number(maxPriceNum) : null
  };
}

async function refreshConfigFromCT() {
  const cfg = resolveConfig();
  if (cfg.apiKey && cfg.apiUsername) return { ok: true, config: cfg, refreshed: false };
  const ct = (() => {
    try { return readCtConfig(); } catch { return null; }
  })();
  const base = String(ct && ct.ctBaseUrl || "").trim().replace(/\/+$/, "");
  const secret = String(ct && ct.logIngestSecret || "").trim();
  const hostId = readHostIdSafe();
  if (!base || !hostId) return { ok: false, error: "textverified_ct_config_missing" };

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, AUTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/marketplace/textverified_config_secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(secret ? { "X-Log-Secret": secret } : {})
      },
      body: JSON.stringify({
        hostId,
        hostname: os.hostname(),
        ts: Date.now()
      }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, error: data && data.error ? String(data.error) : `http_${res.status}` };
    }
    const payload = data.config && typeof data.config === "object" ? data.config : {};
    const wr = writeCtConfig({
      textVerifiedApiKey: payload.apiKey != null ? String(payload.apiKey || "") : undefined,
      textVerifiedApiUsername: payload.apiUsername != null ? String(payload.apiUsername || "") : undefined,
      textVerifiedBaseUrl: payload.baseUrl != null ? String(payload.baseUrl || "") : undefined,
      textVerifiedServiceName: payload.serviceName != null ? String(payload.serviceName || "") : undefined,
      textVerifiedServiceNotListedName: payload.serviceNotListedName != null ? String(payload.serviceNotListedName || "") : undefined,
      textVerifiedMaxPrice: payload.maxPrice != null ? payload.maxPrice : undefined
    });
    if (!wr || wr.ok !== true) return { ok: false, error: (wr && wr.error) || "textverified_write_failed" };
    const next = resolveConfig();
    if (!next.apiKey || !next.apiUsername) return { ok: false, error: "textverified_config_incomplete" };
    return { ok: true, config: next, refreshed: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e || "textverified_refresh_failed") };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureConfig() {
  let cfg = resolveConfig();
  if (cfg.apiKey && cfg.apiUsername) return { ok: true, config: cfg };
  const pulled = await refreshConfigFromCT();
  if (!pulled.ok) return pulled;
  cfg = pulled.config || resolveConfig();
  if (!cfg.apiKey || !cfg.apiUsername) return { ok: false, error: "textverified_config_missing" };
  return { ok: true, config: cfg };
}

function isTokenValid(cfg) {
  return (
    authState.token &&
    authState.expiresAtMs > (Date.now() + AUTH_SKEW_MS) &&
    authState.key === cfg.apiKey &&
    authState.username === cfg.apiUsername &&
    authState.baseUrl === cfg.baseUrl
  );
}

function parseExpiresAtMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function isNoBalanceError(status, data, fallbackText = "") {
  const joined = [
    String(fallbackText || ""),
    String(data && data.errorDescription || ""),
    String(data && data.error_description || ""),
    String(data && data.message || ""),
    String(data && data.error || "")
  ].join(" ").toLowerCase();
  return status === 402 || joined.includes("insufficient balance") || joined.includes("saldo insuficiente");
}

async function auth(cfg, { retries = 3 } = {}) {
  if (isTokenValid(cfg)) {
    return { ok: true, token: authState.token, expiresAtMs: authState.expiresAtMs };
  }
  let lastError = "auth_failed";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch {}
    }, AUTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.baseUrl}/api/pub/v2/auth`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "X-API-KEY": cfg.apiKey,
          "X-API-USERNAME": cfg.apiUsername
        },
        signal: controller.signal
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        lastError = data && (data.errorDescription || data.error_description || data.message || data.error)
          ? String(data.errorDescription || data.error_description || data.message || data.error)
          : `auth_http_${res.status}`;
      } else {
        const token = String(data && data.token || "").trim();
        const expiresAtMs = parseExpiresAtMs(data && data.expiresAt);
        if (token && expiresAtMs > Date.now()) {
          authState.key = cfg.apiKey;
          authState.username = cfg.apiUsername;
          authState.baseUrl = cfg.baseUrl;
          authState.token = token;
          authState.expiresAtMs = expiresAtMs;
          return { ok: true, token, expiresAtMs };
        }
        lastError = "auth_token_missing";
      }
    } catch (e) {
      lastError = String((e && e.message) || e || "auth_failed");
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(1200 * attempt);
  }
  return { ok: false, error: lastError };
}

async function requestJson(method, hrefOrPath, {
  cfg,
  authRequired = true,
  query = null,
  body = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const c = cfg || (await ensureConfig()).config;
  if (!c) return { ok: false, error: "textverified_config_missing" };
  let token = "";
  if (authRequired) {
    const ar = await auth(c);
    if (!ar.ok) return ar;
    token = ar.token;
  }

  const url = hrefOrPath.startsWith("http")
    ? new URL(hrefOrPath)
    : new URL(`${c.baseUrl}${hrefOrPath.startsWith("/") ? hrefOrPath : `/${hrefOrPath}`}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers = { "Accept": "application/json" };
  if (authRequired) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, Math.max(1000, Number(timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text().catch(() => "");
    const data = text ? (() => {
      try { return JSON.parse(text); } catch { return null; }
    })() : null;
    if (!res.ok) {
      return {
        ok: false,
        status: Number(res.status || 0) || 0,
        error: data && (data.errorDescription || data.error_description || data.message || data.error)
          ? String(data.errorDescription || data.error_description || data.message || data.error)
          : `http_${res.status}`,
        noBalance: isNoBalanceError(res.status, data, text),
        data
      };
    }
    return { ok: true, data, status: Number(res.status || 0) || 200 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e || "network_error") };
  } finally {
    clearTimeout(timer);
  }
}

function extractArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

function normalizeVerification(raw) {
  const numberRaw = String(
    (raw && (raw.number || raw.phoneNumber || raw.phone_number || raw.toNumber || raw.to_number)) || ""
  ).trim();
  return {
    id: String((raw && raw.id) || "").trim(),
    numberRaw,
    numberDigits: digitsOnly(numberRaw),
    state: String((raw && raw.state) || "").trim(),
    serviceName: String((raw && (raw.serviceName || raw.service_name)) || "").trim(),
    totalCost: Number((raw && (raw.totalCost || raw.total_cost)) || 0) || 0,
    createdAt: String((raw && (raw.createdAt || raw.created_at)) || "").trim(),
    endsAt: String((raw && (raw.endsAt || raw.ends_at)) || "").trim(),
    raw
  };
}

function normalizeSms(raw) {
  const parsed = digitsOnly(raw && (raw.parsedCode || raw.parsed_code) || "");
  const content = String((raw && (raw.smsContent || raw.sms_content || raw.content)) || "").trim();
  const contentCode = (() => {
    const near =
      content.match(/(?:code|codigo|facebook)[^\d]{0,24}(\d{6})/i) ||
      content.match(/(^|[^\d])(\d{6})([^\d]|$)/);
    if (!near) return "";
    return digitsOnly(near[1] || near[2] || "");
  })();
  const code = parsed.length === 6 ? parsed : (contentCode.length === 6 ? contentCode : "");
  const createdAtRaw = String((raw && (raw.createdAt || raw.created_at)) || "").trim();
  const createdAtMs = Date.parse(createdAtRaw);
  return {
    id: String((raw && raw.id) || "").trim(),
    code,
    content,
    encrypted: !!(raw && raw.encrypted),
    createdAtRaw,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    raw
  };
}

async function getAccount() {
  const ensured = await ensureConfig();
  if (!ensured.ok) return ensured;
  const r = await requestJson("GET", "/api/pub/v2/account/me", { cfg: ensured.config, timeoutMs: 20000 });
  if (!r.ok) return r;
  const data = r.data && typeof r.data === "object" ? r.data : {};
  const currentBalance = Number(data.currentBalance != null ? data.currentBalance : data.current_balance) || 0;
  return { ok: true, currentBalance, username: String(data.username || "").trim(), raw: data, config: ensured.config };
}

async function listServices(cfg) {
  const ensured = cfg ? { ok: true, config: cfg } : await ensureConfig();
  if (!ensured.ok) return ensured;
  const c = ensured.config;
  if (servicesState.baseUrl === c.baseUrl && servicesState.at > 0 && (Date.now() - servicesState.at) < SERVICES_CACHE_MS && Array.isArray(servicesState.services) && servicesState.services.length) {
    return { ok: true, services: servicesState.services, cached: true, config: c };
  }
  const r = await requestJson("GET", "/api/pub/v2/services", {
    cfg: c,
    query: { numberType: "mobile", reservationType: "verification" },
    timeoutMs: 20000
  });
  if (!r.ok) return r;
  const services = extractArray(r.data);
  servicesState.baseUrl = c.baseUrl;
  servicesState.at = Date.now();
  servicesState.services = services;
  return { ok: true, services, cached: false, config: c };
}

function chooseService(services, cfg) {
  const configured = String(cfg && cfg.serviceName || "").trim().toLowerCase();
  if (configured && configured !== "auto") {
    return {
      serviceName: configured,
      serviceNotListedName: configured === "servicenotlisted" ? (cfg.serviceNotListedName || "Facebook Marketplace") : ""
    };
  }
  const list = Array.isArray(services) ? services : [];
  const exact = list.find((s) => {
    const name = String((s && (s.serviceName || s.service_name || s.name)) || "").trim().toLowerCase();
    return name === "facebook" || name === "facebook marketplace";
  });
  if (exact) {
    return { serviceName: String(exact.serviceName || exact.service_name || exact.name || "facebook").trim(), serviceNotListedName: "" };
  }
  return {
    serviceName: "servicenotlisted",
    serviceNotListedName: cfg.serviceNotListedName || "Facebook Marketplace"
  };
}

async function createVerification({ maxPrice = null } = {}) {
  const acct = await getAccount();
  if (!acct.ok) return acct;
  const servicesRes = await listServices(acct.config);
  const chosen = servicesRes.ok
    ? chooseService(servicesRes.services, acct.config)
    : {
      serviceName: (acct.config.serviceName && acct.config.serviceName !== 'auto')
        ? acct.config.serviceName
        : 'facebook',
      serviceNotListedName: acct.config.serviceNotListedName || 'Facebook Marketplace'
    };
  const body = {
    serviceName: chosen.serviceName,
    capability: "sms"
  };
  if (chosen.serviceName === "servicenotlisted" && chosen.serviceNotListedName) {
    body.serviceNotListedName = chosen.serviceNotListedName;
  }
  const ceiling = Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0
    ? Number(maxPrice)
    : acct.config.maxPrice;
  if (Number.isFinite(ceiling) && ceiling > 0) body.maxPrice = ceiling;

  const created = await requestJson("POST", "/api/pub/v2/verifications", {
    cfg: acct.config,
    body,
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
  if (!created.ok) return created;
  let raw = created.data;
  if (raw && typeof raw === "object" && raw.href) {
    const followed = await requestJson(String(raw.method || "GET").toUpperCase(), String(raw.href), {
      cfg: acct.config,
      timeoutMs: 20000
    });
    if (!followed.ok) return followed;
    raw = followed.data;
  }
  const verification = normalizeVerification(raw);
  if (!verification.id) return { ok: false, error: "textverified_verification_missing_id" };
  if (!verification.numberDigits) {
    const det = await requestJson("GET", `/api/pub/v2/verifications/${encodeURIComponent(verification.id)}`, {
      cfg: acct.config,
      timeoutMs: 20000
    });
    if (!det.ok) return det;
    return { ok: true, verification: normalizeVerification(det.data), config: acct.config };
  }
  return { ok: true, verification, config: acct.config };
}

async function getVerificationDetails(verificationId, cfg = null) {
  const ensured = cfg ? { ok: true, config: cfg } : await ensureConfig();
  if (!ensured.ok) return ensured;
  const r = await requestJson("GET", `/api/pub/v2/verifications/${encodeURIComponent(String(verificationId || "").trim())}`, {
    cfg: ensured.config,
    timeoutMs: 20000
  });
  if (!r.ok) return r;
  return { ok: true, verification: normalizeVerification(r.data), config: ensured.config };
}

async function listVerifications({ pages = 3 } = {}) {
  const ensured = await ensureConfig();
  if (!ensured.ok) return ensured;
  const out = [];
  let next = "/api/pub/v2/verifications";
  let page = 0;
  while (next && page < Math.max(1, Math.min(3, Number(pages || 3) || 3))) {
    const r = await requestJson("GET", next, { cfg: ensured.config, timeoutMs: 20000 });
    if (!r.ok) return r;
    const list = extractArray(r.data);
    for (const item of list) out.push(normalizeVerification(item));
    const links = r.data && r.data.links && typeof r.data.links === "object" ? r.data.links : {};
    next = links.next ? String(links.next).trim() : "";
    page += 1;
  }
  return { ok: true, verifications: out, config: ensured.config };
}

async function listSms({ toNumber }) {
  const ensured = await ensureConfig();
  if (!ensured.ok) return ensured;
  const digits = digitsOnly(toNumber);
  if (!digits) return { ok: false, error: "sms_to_missing" };
  const r = await requestJson("GET", "/api/pub/v2/sms", {
    cfg: ensured.config,
    query: { to: digits, reservationType: "verification" },
    timeoutMs: 20000
  });
  if (!r.ok) return r;
  return { ok: true, messages: extractArray(r.data).map(normalizeSms), config: ensured.config };
}

async function waitForNewCode({
  toNumber,
  knownMessageIds = [],
  sinceMs = 0,
  timeoutMs = 120000,
  pollMs = 5000,
  rejectedCodes = []
} = {}) {
  const seen = new Set((knownMessageIds || []).map((x) => String(x || "").trim()).filter(Boolean));
  const rejected = new Set((rejectedCodes || []).map((x) => digitsOnly(x)).filter((x) => x.length === 6));
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs || 120000) || 120000);
  while (Date.now() < deadline) {
    const r = await listSms({ toNumber });
    if (r.ok) {
      for (const msg of (r.messages || [])) {
        if (!msg || !msg.id || seen.has(msg.id)) continue;
        if (sinceMs && msg.createdAtMs && msg.createdAtMs < (sinceMs - 30000)) continue;
        if (msg.code && msg.code.length === 6 && !rejected.has(msg.code)) {
          return { ok: true, code: msg.code, messageId: msg.id, sms: msg };
        }
      }
    }
    await sleep(Math.max(1000, Number(pollMs || 5000) || 5000));
  }
  return { ok: false, error: "sms_timeout" };
}

async function cancelVerification(verificationId) {
  const ensured = await ensureConfig();
  if (!ensured.ok) return ensured;
  const id = String(verificationId || "").trim();
  if (!id) return { ok: false, error: "verification_id_missing" };
  const r = await requestJson("POST", `/api/pub/v2/verifications/${encodeURIComponent(id)}/cancel`, {
    cfg: ensured.config,
    timeoutMs: 20000
  });
  return r.ok ? { ok: true } : r;
}

async function reportVerification(verificationId) {
  const ensured = await ensureConfig();
  if (!ensured.ok) return ensured;
  const id = String(verificationId || "").trim();
  if (!id) return { ok: false, error: "verification_id_missing" };
  const r = await requestJson("POST", `/api/pub/v2/verifications/${encodeURIComponent(id)}/report`, {
    cfg: ensured.config,
    timeoutMs: 20000
  });
  return r.ok ? { ok: true } : r;
}

module.exports = {
  AUTH_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ensureConfig,
  getAccount,
  listServices,
  createVerification,
  getVerificationDetails,
  listVerifications,
  listSms,
  waitForNewCode,
  cancelVerification,
  reportVerification,
  maskLast4,
  maskIdTail,
  digitsOnly
};
