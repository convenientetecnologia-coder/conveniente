"use strict";

const fs = require("fs");
const path = require("path");
const utils = require("./utils.js");
const { readCtConfig } = require("./ctConfig.js");

const EXCLUDED_BASE_DIR = String(process.env.EXCLUDED_BASE_DIR || "C:/excluidas");

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function formatDateBr(ts = Date.now()) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd}.${mm}.${yyyy}`;
}

function toSafeFileName(v, fallback = "conta") {
  const raw = String(v || "").trim();
  const cleaned = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function toCityFolderName(cidade) {
  const s = String(cidade || "").trim();
  if (!s) return "sem-cidade";
  const slug = String(utils.slugify(s) || "").trim();
  return slug || toSafeFileName(s, "sem-cidade").toLocaleLowerCase("pt-BR");
}

function normalizeCookiesForFile(cookies) {
  if (typeof cookies === "string") return cookies.trim();
  if (Array.isArray(cookies) || (cookies && typeof cookies === "object")) {
    try { return JSON.stringify(cookies, null, 2); } catch {}
  }
  return "";
}

function buildTxtContent({ login, password, cookies }) {
  const loginStr = String(login || "").trim();
  const passStr = String(password || "").trim();
  const cookiesStr = normalizeCookiesForFile(cookies);
  return [
    "login",
    loginStr,
    "",
    "senha",
    passStr,
    "",
    "cookies",
    cookiesStr,
    ""
  ].join("\n");
}

function writeExcludedAccountLocal({
  nome,
  cidade,
  login,
  password,
  cookies
} = {}) {
  const dateFolder = formatDateBr(Date.now());
  const cityFolder = toCityFolderName(cidade);
  const outDir = path.join(EXCLUDED_BASE_DIR, dateFolder, cityFolder);
  ensureDirSync(outDir);

  const baseName = toSafeFileName(nome, "conta");
  let outFile = path.join(outDir, `${baseName}.txt`);
  if (fs.existsSync(outFile)) {
    outFile = path.join(outDir, `${baseName}_${Date.now()}.txt`);
  }

  fs.writeFileSync(outFile, buildTxtContent({ login, password, cookies }), "utf8");
  return { ok: true, filePath: outFile, baseDir: EXCLUDED_BASE_DIR, dateFolder, cityFolder };
}

function getCtTarget() {
  try {
    const cfg = readCtConfig();
    const base = String((cfg && cfg.ctBaseUrl) || process.env.CT_BASE_URL || process.env.CT_URL || "").trim().replace(/\/+$/, "");
    const secret = String((cfg && cfg.logIngestSecret) || process.env.LOG_INGEST_SECRET || "").trim();
    return { base, secret };
  } catch {
    return { base: "", secret: "" };
  }
}

async function postExcludedToCt({ nome, cidade, login, password, cookies } = {}) {
  const target = getCtTarget();
  if (!target.base || !target.secret) return { ok: false, skipped: true, error: "ct_target_missing" };
  const payload = {
    nome: String(nome || "").trim(),
    cidade: String(cidade || "").trim(),
    login: String(login || "").trim(),
    password: String(password || ""),
    cookies: cookies || []
  };
  if (!payload.nome) return { ok: false, error: "nome_ausente" };

  const controller = (global.AbortController ? new AbortController() : null);
  let timeout = null;
  try {
    if (controller) timeout = setTimeout(() => { try { controller.abort(); } catch {} }, 12000);
    const resp = await fetch(`${target.base}/api/excluded/archive_secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Log-Secret": target.secret
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).catch((e) => ({ ok: false, _err: e }));
    if (timeout) clearTimeout(timeout);
    if (!resp || resp.ok !== true) {
      const err = (resp && resp._err && resp._err.message) ? String(resp._err.message) : `http_${resp && resp.status ? resp.status : 0}`;
      return { ok: false, error: err };
    }
    const j = await resp.json().catch(() => null);
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) ? String(j.error) : "ct_archive_failed" };
    return { ok: true, mode: "ct", filePath: j.filePath || null };
  } catch (e) {
    if (timeout) clearTimeout(timeout);
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function archiveExcludedAccount({
  nome,
  cidade,
  login,
  password,
  cookies
} = {}) {
  try {
    const target = getCtTarget();
    if (target.base && target.secret) {
      return await postExcludedToCt({ nome, cidade, login, password, cookies });
    }
    // Fallback local: CT sem config (ou uso local dev)
    return writeExcludedAccountLocal({ nome, cidade, login, password, cookies });
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

module.exports = {
  EXCLUDED_BASE_DIR,
  archiveExcludedAccount,
  writeExcludedAccountLocal
};

