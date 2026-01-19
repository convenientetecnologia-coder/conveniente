// scripts/api_stock.js
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("./logger.js");
const { notifierBaseFromEndpoints } = require("./notifierEndpoints");

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
  // Reusa o mesmo secret já usado para logs/ingest
  return String(process.env.LOG_INGEST_SECRET || "").trim();
}

async function postJson(url, body, { timeoutMs = 12000, headers = {} } = {}) {
  const ac = new (global.AbortController || require("node-abort-controller"))();
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body || {}),
      signal: ac.signal
    });
    const j = await res.json().catch(() => null);
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url, { timeoutMs = 12000, headers = {} } = {}) {
  const ac = new (global.AbortController || require("node-abort-controller"))();
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const j = await res.json().catch(() => null);
    return j;
  } finally {
    clearTimeout(t);
  }
}

module.exports = (app) => {
  // Lista contas disponíveis do Estoque (via CT) para o operador escolher manualmente.
  app.get("/api/stock/available", async (req, res) => {
    try {
      const base = notifierBaseFromEndpoints();
      if (!base) return res.json({ ok: false, error: "ct_base_unavailable" });
      const sec = stockSecret();
      if (!sec) return res.json({ ok: false, error: "stock_secret_not_configured" });
      const limit = Math.max(20, Math.min(800, Number(req.query?.limit || 250) || 250));
      const url = `${base}/api/stock/available_secret?limit=${encodeURIComponent(String(limit))}`;
      const r = await getJson(url, { timeoutMs: 15000, headers: { "X-Log-Secret": sec } });
      if (!r || r.ok !== true) return res.json({ ok: false, error: (r && r.error) ? String(r.error) : "ct_failed" });
      return res.json({ ok: true, accounts: Array.isArray(r.accounts) ? r.accounts : [] });
    } catch (e) {
      logger.warn("[api_stock] available falhou", { error: e && e.message || e });
      return res.json({ ok: false, error: (e && e.message) || String(e) });
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
      if (!base) return res.json({ ok: false, error: "ct_base_unavailable" });
      const sec = stockSecret();
      if (!sec) return res.json({ ok: false, error: "stock_secret_not_configured" });

      const hostId = getOrCreateHostId();
      const r = await postJson(`${base}/api/stock/provision/from_account_secret`, {
        hostId,
        city: c,
        category: cat,
        stockAccountId: accId
      }, { timeoutMs: 20000, headers: { "X-Log-Secret": sec } });

      if (!r || r.ok !== true) {
        return res.json({ ok: false, error: (r && r.error) ? String(r.error) : "ct_failed", details: r || null });
      }
      return res.json(r);
    } catch (e) {
      logger.warn("[api_stock] provision_from_stock falhou", { error: e && e.message || e });
      return res.json({ ok: false, error: (e && e.message) || String(e) });
    }
  });
};

