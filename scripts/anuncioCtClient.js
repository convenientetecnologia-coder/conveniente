"use strict";

const { notifierBaseFromEndpoints } = require("./notifierEndpoints");

function ctBase() {
  return String(notifierBaseFromEndpoints() || "").replace(/\/+$/, "");
}

async function postJson(base, pathname, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    try { ac.abort(); } catch {}
  }, Math.max(1000, Number(timeoutMs) || 20000));
  try {
    const resp = await fetch(`${base}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const data = await resp.json().catch(() => null);
    return { ok: !!(resp.ok && data && data.ok === true), status: resp.status, data: data || null };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: (error && error.message) || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function createClient({ base = ctBase(), timeoutMs = 20000, post = postJson } = {}) {
  async function call(pathname, body) {
    const root = String(base || "").replace(/\/+$/, "");
    if (!root) return { ok: false, error: "ct_indisponivel" };
    let last = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      last = await post(root, pathname, body, timeoutMs);
      if (last && last.ok) return { ok: true, ...(last.data || {}) };
      if (last && last.status && last.status < 500 && last.status !== 0) break;
    }
    return {
      ok: false,
      error: (last && last.data && last.data.erro) || (last && last.error) || "ct_falhou",
      status: last && last.status
    };
  }

  return {
    base: String(base || ""),
    pedir(body) { return call("/api/anuncio/link", body); },
    informar(body) { return call("/api/anuncio/resultado", body); }
  };
}

module.exports = {
  ctBase,
  createClient
};
