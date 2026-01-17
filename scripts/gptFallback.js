"use strict";

const fs = require("fs");
const path = require("path");

const { notifierBaseFromEndpoints } = require("./notifierEndpoints");

const DATA_DIR = path.join(__dirname, "..", "dados");
const HOSTID_PATH = path.join(DATA_DIR, ".telemetry_hostid");

const limiter = new Map(); // key -> lastTs

function readHostId() {
  try {
    if (fs.existsSync(HOSTID_PATH)) {
      const v = fs.readFileSync(HOSTID_PATH, "utf8").trim();
      if (v) return v;
    }
  } catch {}
  return null;
}

function redactHtml(html) {
  let s = String(html || "");
  if (!s) return "";
  // remove scripts (reduz risco e tokens)
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "<script>[redacted]</script>");
  // remove data URLs grandes
  s = s.replace(/data:[^\"']{0,40};base64,[A-Za-z0-9+/=]{200,}/g, "data:[redacted]");
  // emails
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  // telefones / long numbers
  s = s.replace(/\b\d{7,}\b/g, "[#]");
  // tokens comuns em querystring
  s = s.replace(/(access_token|captcha_challenge_hash|captcha_challenge_code)=([^&\"']+)/gi, "$1=[redacted]");
  // limita tamanho
  if (s.length > 18000) s = s.slice(0, 18000);
  return s;
}

async function ingestFbGpt({ perfil, url, title, html, reason, source } = {}) {
  const secret = String(process.env.LOG_INGEST_SECRET || "").trim();
  if (!secret) return { ok: false, skipped: true, reason: "LOG_INGEST_SECRET_not_configured" };

  const base = notifierBaseFromEndpoints();
  if (!base) return { ok: false, skipped: true, reason: "notifier_base_unavailable" };

  const hostId = readHostId();
  const hostname = (() => { try { return require("os").hostname(); } catch { return ""; } })();
  const p = String(perfil || "").trim();
  if (!p) return { ok: false, skipped: true, reason: "missing_perfil" };

  const key = `${hostId || "nohost"}::${p}::${String(reason || "noreason")}`;
  const now = Date.now();
  const last = Number(limiter.get(key) || 0) || 0;
  if (last && (now - last) < (30 * 60 * 1000)) {
    return { ok: true, skipped: true, reason: "rate_limited" };
  }
  limiter.set(key, now);

  const body = {
    hostId,
    hostname,
    perfil: p,
    url: String(url || "").slice(0, 600),
    title: String(title || "").slice(0, 200),
    html: redactHtml(html),
    reason: reason ? String(reason).slice(0, 120) : null,
    source: source ? String(source).slice(0, 80) : "conveniente"
  };

  const ac = new (global.AbortController || require("node-abort-controller"))();
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, 8000);
  try {
    const r = await fetch(`${base}/api/fb_gpt/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Log-Secret": secret
      },
      body: JSON.stringify(body),
      signal: ac.signal
    }).catch(() => null);
    if (!r) return { ok: false, error: "network_failed" };
    const j = await r.json().catch(() => null);
    return j || { ok: false, error: `http_${r.status}` };
  } finally {
    clearTimeout(t);
  }
}

module.exports = { ingestFbGpt };

