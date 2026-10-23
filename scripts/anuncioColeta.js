"use strict";

const KEYWORDS = ["frete", "fretes", "mudanca", "mudancas", "carreto", "carretos"];
const ITEM_RE = /\/marketplace\/item\/(\d+)/g;
const GRADE_INTERVALO_MS = 1000;
const GRADE_ESTAVEL_MS = 5000;
const GRADE_MINIMO_MS = 8000;
const GRADE_VAZIO_MS = 12000;
const GRADE_TETO_MS = 45000;
const ROBE_MAX_MS = 8 * 60 * 1000;

function palavra(query) {
  return String(query || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function pesquisaValida(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== "www.facebook.com" && host !== "web.facebook.com") return false;
  if (!/^\/marketplace\/[^/]+\/search\/?$/.test(parsed.pathname)) return false;
  if (parsed.searchParams.get("exact") !== "false") return false;
  return KEYWORDS.includes(palavra(parsed.searchParams.get("query")));
}

function extrairIds(text) {
  const src = String(text || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/");
  const ids = [];
  const seen = new Set();
  ITEM_RE.lastIndex = 0;
  let match;
  while ((match = ITEM_RE.exec(src))) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    ids.push(match[1]);
    if (ids.length >= 80) break;
  }
  return ids;
}

async function esperarRobe(ocupado, opts = {}) {
  const maxMs = Number(opts.maxMs) > 0 ? Number(opts.maxMs) : ROBE_MAX_MS;
  const passoMs = Number(opts.passoMs) > 0 ? Number(opts.passoMs) : 2000;
  const agora = opts.now || Date.now;
  const dormir = opts.dormir || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const inicio = agora();
  while (ocupado()) {
    if (agora() - inicio >= maxMs) return false;
    await dormir(Math.min(passoMs, Math.max(0, maxMs - (agora() - inicio))));
  }
  return true;
}

async function aguardarGrade(lerIds, opts = {}) {
  const dormir = opts.dormir || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const agora = opts.now || Date.now;
  const inicio = agora();
  let ids = [];
  let ultimo = -1;
  let mudouEm = inicio;
  let primeiroEm = 0;
  while (true) {
    const t = agora();
    ids = await lerIds();
    const n = Array.isArray(ids) ? ids.length : 0;
    if (n > 0 && !primeiroEm) primeiroEm = t;
    if (n !== ultimo) {
      ultimo = n;
      mudouEm = t;
    }
    const quieto = t - mudouEm >= GRADE_ESTAVEL_MS;
    const minimo = primeiroEm > 0 && t - primeiroEm >= GRADE_MINIMO_MS;
    const vazio = n === 0 && t - inicio >= GRADE_VAZIO_MS && quieto;
    if ((n > 0 && quieto && minimo) || vazio || t - inicio >= GRADE_TETO_MS) return Array.isArray(ids) ? ids : [];
    await dormir(Math.min(GRADE_INTERVALO_MS, Math.max(0, GRADE_TETO_MS - (t - inicio))));
  }
}

async function coletar(page, url, deps = {}) {
  const goto = deps.goto;
  const ler = deps.lerIds;
  if (typeof goto !== "function" || typeof ler !== "function") throw new Error("coleta sem pagina");
  await goto(page, url);
  return aguardarGrade(() => ler(page), deps);
}

module.exports = {
  pesquisaValida,
  extrairIds,
  esperarRobe,
  aguardarGrade,
  coletar,
  ROBE_MAX_MS
};
