// scripts/api_stock.js
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const logger = require("./logger.js");
const { resolveEndpoints, notifierBaseFromEndpoints } = require("./notifierEndpoints");
const { readCtConfig } = require("./ctConfig");

const HOSTID_PATH = path.join(__dirname, "..", "dados", ".telemetry_hostid");

function ensureDirSync(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function randId() {
  try { return crypto.randomUUID(); }
  catch {
    const b = crypto.randomBytes(16);
    return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  }
}

function getOrCreateHostId() {
  try {
    if (fs.existsSync(HOSTID_PATH)) {
      const v = fs.readFileSync(HOSTID_PATH, "utf8").trim();
      if (v) return v;
    }
  } catch {}
  try {
    ensureDirSync(path.dirname(HOSTID_PATH));
    const id = randId();
    fs.writeFileSync(HOSTID_PATH, id, "utf8");
    return id;
  } catch {
    return randId();
  }
}

function stockSecret() {
  // Legado opcional: arquivo persistido tem prioridade sobre env.
  try {
    const cfg = readCtConfig();
    const s = String(cfg && cfg.logIngestSecret || "").trim();
    if (s) return s;
  } catch {}
  return String(process.env.LOG_INGEST_SECRET || "").trim();
}

function requestRaw(url, { method = "GET", headers = {}, body = null, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(String(url || "")); } catch (e) { return reject(new Error("invalid_url")); }
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: `${u.pathname || ""}${u.search || ""}`,
      method,
      headers
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          status: Number(res.statusCode || 0) || 0,
          headers: res.headers || {},
          body: data
        });
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error("timeout")); } catch {}
    });

    if (body != null) req.write(body);
    req.end();
  });
}

async function requestJson(url, { method = "GET", headers = {}, bodyObj = null, timeoutMs = 12000 } = {}) {
  const hasBody = bodyObj != null && method !== "GET" && method !== "HEAD";
  const body = hasBody ? JSON.stringify(bodyObj) : null;
  const h = { ...headers };
  if (hasBody && !h["Content-Type"] && !h["content-type"]) h["Content-Type"] = "application/json";

  const raw = await requestRaw(url, { method, headers: h, body, timeoutMs });
  let json = null;
  try { json = JSON.parse(String(raw.body || "")); } catch {}
  return { ...raw, json };
}

function unique(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function candidateCtBases() {
  const bases = [];
  try {
    const eps = resolveEndpoints();
    for (const e of eps || []) {
      try {
        const u = new URL(String(e || ""));
        bases.push(`${u.protocol}//${u.host}`);
      } catch {}
    }
  } catch {}
  // fallback: comportamento antigo
  const base1 = notifierBaseFromEndpoints();
  if (base1) bases.push(base1);
  return unique(bases);
}

async function getAvailableFromCt({ limit, secret } = {}) {
  const bases = candidateCtBases();
  let last = null;
  for (const base of bases) {
    const url = `${base}/api/stock/available_secret?limit=${encodeURIComponent(String(limit))}`;
    try {
      const r = await requestJson(url, {
        method: "GET",
        timeoutMs: 15000,
        headers: secret ? { "X-Log-Secret": secret } : {}
      });
      if (!r.json) {
        const preview = String(r.body || "").slice(0, 240);
        last = { base, error: "ct_non_json", status: r.status, bodyPreview: preview };
        continue;
      }
      if (r.json.ok !== true) {
        last = { base, error: String(r.json.error || "ct_failed"), status: r.status, ct: r.json };
        continue;
      }
      return { ok: true, baseUsed: base, accounts: Array.isArray(r.json.accounts) ? r.json.accounts : [] };
    } catch (e) {
      last = { base, error: (e && e.message) || String(e) };
    }
  }
  return { ok: false, error: (last && last.error) ? last.error : "ct_failed", details: { triedBases: bases, last } };
}

module.exports = (app) => {
  // Debug enterprise (não expõe secret): ajuda a diagnosticar “falha ao carregar contas”.
  app.get("/api/stock/debug", async (req, res) => {
    try {
      const base = notifierBaseFromEndpoints();
      const bases = candidateCtBases();
      const sec = stockSecret();
      return res.json({
        ok: true,
        ctBase: base || null,
        ctBases: bases,
        hasSecret: !!sec,
        secretLen: sec ? String(sec).length : 0,
        env: {
          CT_BASE_URL: String(process.env.CT_BASE_URL || "").trim() ? "[set]" : "",
          CT_URL: String(process.env.CT_URL || "").trim() ? "[set]" : "",
          CT_NOTIFIER_REPORT_URL: String(process.env.CT_NOTIFIER_REPORT_URL || "").trim() ? "[set]" : "",
          NOTIFIER_REPORT_URL: String(process.env.NOTIFIER_REPORT_URL || "").trim() ? "[set]" : ""
        }
      });
    } catch (e) {
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // Lista contas disponíveis do Estoque (via CT) para o operador escolher manualmente.
  app.get("/api/stock/available", async (req, res) => {
    try {
      const base = notifierBaseFromEndpoints();
      if (!base) return res.json({ ok: false, error: "ct_base_unavailable", details: { hint: "configure CT_BASE_URL/CT_URL ou CT_NOTIFIER_REPORT_URL", hasSecret: !!stockSecret(), triedBases: candidateCtBases() } });
      const sec = stockSecret();
      const limit = Math.max(20, Math.min(800, Number(req.query?.limit || 250) || 250));

      const r = await getAvailableFromCt({ limit, secret: sec });
      if (!r.ok) return res.json({ ok: false, error: r.error, details: r.details || null });
      return res.json({ ok: true, accounts: r.accounts, baseUsed: r.baseUsed });
    } catch (e) {
      logger.warn("[api_stock] available falhou", { error: e && e.message || e });
      return res.json({ ok: false, error: (e && e.message) || String(e), details: { hint: "verifique CT_BASE_URL/CT_URL e conectividade", hasSecret: !!stockSecret() } });
    }
  });

  // Provisionar manualmente no servidor usando uma conta do Estoque (sem cookies no UI).
  app.post("/api/stock/provision_from_stock", async (req, res) => {
    try {
      const { city, category, stockAccountId } = req.body || {};
      const c = String(city || "").trim();
      const cat = String(category || "").trim().toLowerCase() || "fretes";
      const accId = Number(stockAccountId || 0) || 0;
      if (!c) return res.json({ ok: false, error: "missing_city" });
      if (!accId) return res.json({ ok: false, error: "missing_stockAccountId" });
      if (cat !== "fretes" && cat !== "veiculos") return res.json({ ok: false, error: "invalid_category" });

      const base = notifierBaseFromEndpoints();
      if (!base) return res.json({ ok: false, error: "ct_base_unavailable", details: { hint: "configure CT_BASE_URL/CT_URL ou CT_NOTIFIER_REPORT_URL", hasSecret: !!stockSecret() } });
      const sec = stockSecret();

      const hostId = getOrCreateHostId();
      const url = `${base}/api/stock/provision/from_account_secret`;
      const r = await requestJson(url, {
        method: "POST",
        timeoutMs: 20000,
        headers: sec ? { "X-Log-Secret": sec } : {},
        bodyObj: {
        hostId,
        city: c,
        category: cat,
        stockAccountId: accId
        }
      });

      if (!r.json) {
        const preview = String(r.body || "").slice(0, 240);
        return res.json({ ok: false, error: "ct_non_json", details: { base, status: r.status, bodyPreview: preview } });
      }
      if (r.json.ok !== true) {
        return res.json({ ok: false, error: String(r.json.error || "ct_failed"), details: { base, status: r.status, ct: r.json } });
      }
      return res.json(r.json);
    } catch (e) {
      logger.warn("[api_stock] provision_from_stock falhou", { error: e && e.message || e });
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });
};

