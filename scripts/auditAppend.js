"use strict";

/**
 * Auditoria no caminho quente.
 * Nao e fila em RAM. Uma linha, async, tamanho limitado.
 * Nao le o arquivo. Nao joga se falhar. Fila Delta / desired / PIN clique nao passam daqui.
 */

const fs = require("fs");
const path = require("path");

const MAX_LINE = 8 * 1024;
const MAX_PENDING = 64;
const MAX_KEYS = 16;
const MAX_ARR = 8;
const MAX_STR = 400;
const MAX_DEPTH = 3;

let pending = 0;
const ensured = new Set();

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (ensured.has(dir)) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  ensured.add(dir);
}

function slimValue(v, depth) {
  if (v == null) return v;
  const t = typeof v;
  if (t === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  if (t === "number" || t === "boolean") return v;
  if (t !== "object") return String(v).slice(0, 200);
  if (depth <= 0) return "[maxdepth]";
  if (Array.isArray(v)) {
    const n = Math.min(v.length, MAX_ARR);
    const a = new Array(n);
    for (let i = 0; i < n; i += 1) a[i] = slimValue(v[i], depth - 1);
    if (v.length > n) a.push({ clipped: v.length });
    return a;
  }
  const out = {};
  const keys = Object.keys(v);
  const cap = Math.min(keys.length, MAX_KEYS);
  for (let i = 0; i < cap; i += 1) {
    out[keys[i]] = slimValue(v[keys[i]], depth - 1);
  }
  if (keys.length > cap) out._clipped = keys.length;
  return out;
}

function slim(obj) {
  if (!obj || typeof obj !== "object") return { event: String(obj == null ? "" : obj).slice(0, 200) };
  return slimValue(obj, MAX_DEPTH);
}

function appendLine(filePath, obj) {
  try {
    const fp = String(filePath || "").trim();
    if (!fp) return { ok: false, reason: "nopath" };
    if (pending >= MAX_PENDING) return { ok: false, reason: "backpressure" };
    const body = slim(obj);
    if (body && body.ts == null) body.ts = Date.now();
    let line = JSON.stringify(body);
    if (line.length > MAX_LINE) {
      line = JSON.stringify({
        ts: body.ts || Date.now(),
        event: body.event || "clipped",
        clipped: true,
        bytes: line.length,
        preview: line.slice(0, 400)
      });
    }
    ensureDir(fp);
    pending += 1;
    fs.appendFile(fp, line + "\n", "utf8", () => {
      pending = pending > 0 ? pending - 1 : 0;
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "throw" };
  }
}

module.exports = {
  appendLine,
  slim,
  MAX_LINE,
  MAX_PENDING,
  pendingCount: () => pending
};
