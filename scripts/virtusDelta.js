const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");

// ===================== FORENSIC_EDGE (Caixa-preta Universal) =====================
// Regra rígida: console + arquivo físico, JSON string única:
// console.log(JSON.stringify({ timestamp, account_login, thread_key, flow_stage, details }))
const FORENSIC_EDGE_LOG_PATH = path.join(__dirname, "..", "dados", "forensic_edge.log");
const LEADS_BRUTOS_JSONL_PATH = path.join(__dirname, "..", "dados", "leads_brutos.jsonl");

const FORENSIC_EDGE_ROTATE_MAX_BYTES = 10 * 1024 * 1024; // 10MB hard ceiling (RAM constante)
function __rotateForensicFileIfNeededSync(fp) {
  try {
    const p = String(fp || "").trim();
    if (!p) return false;
    if (!fsSync.existsSync(p)) return false;
    const st = fsSync.statSync(p);
    const size = Number(st && st.size || 0) || 0;
    if (size < FORENSIC_EDGE_ROTATE_MAX_BYTES) return false;

    // Rotação simples: mantém até 3 backups .1 .2 .3 (constante, sem RAM).
    const keep = 3;
    for (let i = keep; i >= 1; i--) {
      const src = `${p}.${i}`;
      const dst = `${p}.${i + 1}`;
      try {
        if (!fsSync.existsSync(src)) continue;
        if (i === keep) {
          try { fsSync.unlinkSync(src); } catch (_) {}
          continue;
        }
        try { fsSync.renameSync(src, dst); } catch (_) {}
      } catch (_) {}
    }
    try { fsSync.renameSync(p, `${p}.1`); } catch (_) {}
    return true;
  } catch (_) {
    return false;
  }
}
function __forensicEmitSync(filePath, obj) {
  try {
    const line = JSON.stringify(obj);
    try { console.log(line); } catch (_) {}
    try {
      const fp = String(filePath || "").trim();
      if (fp) {
        try { fsSync.mkdirSync(path.dirname(fp), { recursive: true }); } catch (_) {}
        try { __rotateForensicFileIfNeededSync(fp); } catch (_) {}
        fsSync.appendFileSync(fp, line + "\n", "utf8");
      }
    } catch (_) {}
  } catch (_) {}
}
function __forensicEdgeEmit({ account_login = null, thread_key = null, flow_stage = "", details = null } = {}) {
  __forensicEmitSync(FORENSIC_EDGE_LOG_PATH, {
    timestamp: Date.now(),
    account_login: account_login == null ? null : String(account_login || "").trim(),
    thread_key: thread_key == null ? null : String(thread_key || "").trim(),
    flow_stage: String(flow_stage || "").trim(),
    details: details
  });
}
function __forensicLeadsEmit({ account_login = null, thread_key = null, flow_stage = "", details = null } = {}) {
  __forensicEmitSync(LEADS_BRUTOS_JSONL_PATH, {
    timestamp: Date.now(),
    account_login: account_login == null ? null : String(account_login || "").trim(),
    thread_key: thread_key == null ? null : String(thread_key || "").trim(),
    flow_stage: String(flow_stage || "").trim(),
    details: details
  });
}

let puppeteer = null;
try {
  const pExtra = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
} catch (_) {
  puppeteer = require("puppeteer");
}

function decodeEscapedText(value) {
  if (typeof value !== "string") return "";
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch (_) {
    return value;
  }
}

function decodeWebSocketPayload(payloadData, opcode) {
  if (typeof payloadData !== "string" || payloadData.length === 0) return "";
  const looksLikeBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(payloadData) && payloadData.length % 4 === 0;
  const shouldDecodeBase64 = opcode === 2 || looksLikeBase64;
  if (!shouldDecodeBase64) return payloadData;
  try {
    const decoded = Buffer.from(payloadData, "base64").toString("utf8");
    const printableCount = (decoded.match(/[\x09\x0A\x0D\x20-\x7E]/g) || []).length;
    const ratio = decoded.length ? printableCount / decoded.length : 0;
    return ratio >= 0.75 ? decoded : payloadData;
  } catch (_) {
    return payloadData;
  }
}

function extractInnerPayload(decoded) {
  if (typeof decoded !== "string" || decoded.length === 0) return "";
  const firstBrace = decoded.indexOf("{");
  if (firstBrace === -1) return decoded;
  const candidate = decoded.slice(firstBrace);
  try {
    const outer = JSON.parse(candidate);
    if (outer && typeof outer.payload === "string") {
      try {
        return JSON.parse(outer.payload);
      } catch (_) {
        return outer.payload;
      }
    }
    return candidate;
  } catch (_) {
    return candidate;
  }
}

function extractThreadAndText(source) {
  const text = typeof source === "string" ? source : (() => {
    try {
      return JSON.stringify(source);
    } catch (_) {
      return String(source || "");
    }
  })();

  const threadMatch =
    text.match(/"thread_key"\s*:\s*"?(?<t1>\d+)"?/i) ||
    text.match(/"thread_id"\s*:\s*"?(?<t2>\d+)"?/i) ||
    text.match(/"thread_fbid"\s*:\s*"?(?<t3>\d+)"?/i);
  const bodyMatch =
    text.match(/"text"\s*:\s*"(?<m1>(?:\\.|[^"\\])*)"/i) ||
    text.match(/"body"\s*:\s*"(?<m2>(?:\\.|[^"\\])*)"/i) ||
    text.match(/"snippet"\s*:\s*"(?<m3>(?:\\.|[^"\\])*)"/i);

  const threadKey = threadMatch?.groups?.t1 || threadMatch?.groups?.t2 || threadMatch?.groups?.t3 || "";
  const rawMessage = bodyMatch?.groups?.m1 || bodyMatch?.groups?.m2 || bodyMatch?.groups?.m3 || "";

  return {
    threadKey,
    text: decodeEscapedText(rawMessage),
  };
}

function extractWsMessageEvents(input, accountUserId = "") {
  const seen = new Set();
  const out = [];
  const pushEvent = (src, operation = "message") => {
    const parsed = extractThreadAndText(src);
    const thread_key = String(parsed.threadKey || "").trim();
    const message_text = String(parsed.text || "").trim();
    if (!thread_key || !message_text) return;
    const k = `${thread_key}|${message_text}|${operation}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({
      operation,
      thread_key,
      message_text,
      sender_id: "",
      account_user_id: String(accountUserId || ""),
      direction: "nao_classificado",
      source_layer: "delta_internal",
    });
  };

  const walk = (node, op = "message") => {
    if (!node) return;
    if (typeof node === "string") {
      pushEvent(node, op);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, op);
      return;
    }
    if (typeof node === "object") {
      pushEvent(node, op);
      const nextOp = String(node.operation || node.operacao_meta || op || "message");
      for (const v of Object.values(node)) walk(v, nextOp);
    }
  };

  walk(input, "message");
  return out;
}

let killChromeProfileProcesses = null;
try {
  killChromeProfileProcesses = require("./browser.js").killChromeProfileProcesses;
} catch (_) {}
let getDeltaCityCollector = null;
try {
  ({ getDeltaCityCollector } = require("./deltaCityCollector.js"));
} catch (_) {}

const LOG_LEVEL = String(process.env.FB_LOG_LEVEL || "info").trim().toLowerCase();

function logInfo(...args) {
  if (LOG_LEVEL === "silent") return;
  console.log(...args);
}

function logDelta(tag, msg, extra = null) {
  try {
    const ts = Date.now();
    const t = String(tag || "").trim().toUpperCase();
    const base = `[DELTA][${t}] ${String(msg || "").trim()} ts=${ts}`;
    if (extra && typeof extra === "object") return logInfo(base, extra);
    return logInfo(base);
  } catch (_) {}
}

function logDebug(...args) {
  if (LOG_LEVEL === "debug") console.log(...args);
}

function attachDeltaNavigationFirewall(page, { profileName = "" } = {}) {
  try {
    if (!page || page.__virtusDeltaNavFirewallAttached) return;
    page.__virtusDeltaNavFirewallAttached = true;
  } catch (_) {
    return;
  }

  const isAllowedNavUrl = (rawUrl) => {
    try {
      const u = new URL(String(rawUrl || ""));
      const host = String(u.hostname || "").toLowerCase();
      if (!(host === "www.facebook.com" || host === "facebook.com")) return false;
      return true;
    } catch {
      return false;
    }
  };

  try {
    page.setRequestInterception(true).catch(() => {});
  } catch (_) {}

  try {
    page.on("request", (request) => {
      try {
        const isNav = !!(request && typeof request.isNavigationRequest === "function" && request.isNavigationRequest());
        if (!isNav) {
          request.continue().catch(() => {});
          return;
        }
        const url = String(request && typeof request.url === "function" ? request.url() : "");
        if (!isAllowedNavUrl(url)) {
          logInfo(
            `[DELTA_GUARD] navigation_blocked profile=${String(profileName || "").trim() || "unknown"} url=${url}`
          );
          request.abort("blockedbyclient").catch(() => {});
          return;
        }
        request.continue().catch(() => {});
      } catch (_) {
        try { request.continue().catch(() => {}); } catch (_) {}
      }
    });
  } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// NOTE (FUSÃO OPERACIONAL):
// - A captura de rede (CDP + Network.webSocketFrameReceived) e a fila/ingest stateless (JSONL+cursor)
//   foram migradas para o `worker.js` (Ouvido).
// - Este arquivo (`virtusDelta.js`) permanece como **MÃOS** (digitação + fila serial).

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Guardrails de timing humano — produção (centenas de VMs). Override via env *_MS_MIN / *_MS_MAX. */
function envMs(minKey, maxKey, defMin, defMax) {
  const min = Math.max(0, Number(process.env[minKey] ?? defMin) || defMin);
  const max = Math.max(min, Number(process.env[maxKey] ?? defMax) || defMax);
  return { min, max };
}

const HUMAN_TIMINGS = {
  /** Pausa perceptiva pós-lead (Fabiana): padrão 3–7s */
  reaction: envMs("VIRTUS_DELTA_REACTION_DELAY_MS_MIN", "VIRTUS_DELTA_REACTION_DELAY_MS_MAX", 3000, 7000),
  /** Antes de clicar no filtro Marketplace */
  preMarketplace: envMs("VIRTUS_DELTA_HUMAN_PRE_MARKETPLACE_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_MARKETPLACE_MS_MAX", 2200, 4200),
  /** Após ativar Marketplace — DOM lateral estabilizar */
  postMarketplace: envMs("VIRTUS_DELTA_HUMAN_POST_MARKETPLACE_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_MARKETPLACE_MS_MAX", 3200, 5800),
  /** Janela extra para carregamento real da UI antes de clicar no Marketplace */
  marketplaceLoad: envMs("VIRTUS_DELTA_HUMAN_MARKETPLACE_LOAD_MS_MIN", "VIRTUS_DELTA_HUMAN_MARKETPLACE_LOAD_MS_MAX", 2600, 5200),
  /** Antes de clicar no card do cliente */
  preThreadClick: envMs("VIRTUS_DELTA_HUMAN_PRE_THREAD_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_THREAD_MS_MAX", 600, 1400),
  /** Após abrir o chat — ler contexto antes de digitar */
  postThreadOpen: envMs("VIRTUS_DELTA_HUMAN_POST_OPEN_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_OPEN_MS_MAX", 1200, 2400),
  /** Antes de focar o composer */
  preComposer: envMs("VIRTUS_DELTA_HUMAN_PRE_COMPOSER_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_COMPOSER_MS_MAX", 400, 850),
  /** Entre foco e primeira tecla */
  preTyping: envMs("VIRTUS_DELTA_HUMAN_PRE_TYPE_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_TYPE_MS_MAX", 500, 1100),
  /** Por caractere */
  char: envMs("VIRTUS_DELTA_HUMAN_CHAR_MS_MIN", "VIRTUS_DELTA_HUMAN_CHAR_MS_MAX", 55, 120),
  /** Após Shift+Enter */
  lineBreak: envMs("VIRTUS_DELTA_HUMAN_LINEBREAK_MS_MIN", "VIRTUS_DELTA_HUMAN_LINEBREAK_MS_MAX", 45, 110),
  /** Antes do Enter final */
  preSend: envMs("VIRTUS_DELTA_HUMAN_PRE_SEND_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_SEND_MS_MAX", 350, 900),
  /** Após envio */
  postSend: envMs("VIRTUS_DELTA_HUMAN_POST_SEND_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_SEND_MS_MAX", 280, 550),
  /** delay do page.click */
  click: envMs("VIRTUS_DELTA_HUMAN_CLICK_MS_MIN", "VIRTUS_DELTA_HUMAN_CLICK_MS_MAX", 180, 360),
  /** Entre scrolls no sidebar */
  scroll: envMs("VIRTUS_DELTA_HUMAN_SCROLL_MS_MIN", "VIRTUS_DELTA_HUMAN_SCROLL_MS_MAX", 200, 380),
  /** Refresh DOM / retries */
  domSettle: envMs("VIRTUS_DELTA_HUMAN_DOM_SETTLE_MS_MIN", "VIRTUS_DELTA_HUMAN_DOM_SETTLE_MS_MAX", 1200, 2600),
};
const NEW_CHAT_WARMUP_DELAY = envMs(
  "VIRTUS_DELTA_NEW_CHAT_DELAY_MS_MIN",
  "VIRTUS_DELTA_NEW_CHAT_DELAY_MS_MAX",
  60_000,
  120_000
);
const CROSS_THREAD_SEND_GAP = envMs(
  "VIRTUS_DELTA_CROSS_THREAD_GAP_MS_MIN",
  "VIRTUS_DELTA_CROSS_THREAD_GAP_MS_MAX",
  5_000,
  15_000
);

const MARKETPLACE_STABILITY_ROUNDS = Math.max(
  2,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_STABILITY_ROUNDS || 3) || 3
);
const MARKETPLACE_STABILITY_GAP_MS = Math.max(
  800,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_STABILITY_GAP_MS || 1800) || 1800
);
const MESSAGES_BOOT_STABILITY_ROUNDS = Math.max(
  2,
  Number(process.env.VIRTUS_DELTA_MESSAGES_BOOT_STABILITY_ROUNDS || 3) || 3
);
const MESSAGES_BOOT_STABILITY_GAP_MS = Math.max(
  900,
  Number(process.env.VIRTUS_DELTA_MESSAGES_BOOT_STABILITY_GAP_MS || 2000) || 2000
);
const DELTA_MARKETPLACE_AUTOFILTER_ENABLED =
  String(process.env.VIRTUS_DELTA_MARKETPLACE_AUTOFILTER || "1").trim() === "1";
const DELTA_MARKETPLACE_ENFORCER_ENABLED =
  String(process.env.VIRTUS_DELTA_MARKETPLACE_ENFORCER || (DELTA_MARKETPLACE_AUTOFILTER_ENABLED ? "1" : "0")).trim() === "1";
const DELTA_MARKETPLACE_ENFORCER_INTERVAL_MS = Math.max(
  6000,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_ENFORCER_INTERVAL_MS || 12000) || 12000
);
const DELTA_MARKETPLACE_RETURN_TO_MESSAGES_MS = Math.max(
  12000,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_RETURN_TO_MESSAGES_MS || 45000) || 45000
);

function clickDelayMs() {
  return randomBetween(HUMAN_TIMINGS.click.min, HUMAN_TIMINGS.click.max);
}

function randomRangeMs(rangeObj, fallbackMin = 0, fallbackMax = 0) {
  const r = rangeObj && typeof rangeObj === "object" ? rangeObj : { min: fallbackMin, max: fallbackMax };
  const min = Math.max(0, Number(r.min || fallbackMin) || fallbackMin);
  const max = Math.max(min, Number(r.max || fallbackMax) || fallbackMax);
  return randomBetween(min, max);
}

async function humanPause(bucket, label) {
  const b = HUMAN_TIMINGS[bucket];
  if (!b) return 0;
  const ms = randomBetween(b.min, b.max);
  if (label) logInfo(`[virtusDelta][human_pause] ${label} ms=${ms}`);
  await sleep(ms);
  return ms;
}

async function humanReactionDelay(fromNetworkLead) {
  const bucket = fromNetworkLead ? "reaction" : "preThreadClick";
  const ms = await humanPause(bucket, fromNetworkLead ? "reaction_post_lead" : "reaction_api_reply");
  if (fromNetworkLead) {
    logDelta("QUEUE", `⏳ Movido para a fila humana. Aguardando delay de segurança...`, { ms });
  }
}

function logHumanTimingsBoot() {
  logInfo(
    `[virtusDelta][boot] human_timings reaction=${HUMAN_TIMINGS.reaction.min}-${HUMAN_TIMINGS.reaction.max}ms post_open=${HUMAN_TIMINGS.postThreadOpen.min}-${HUMAN_TIMINGS.postThreadOpen.max}ms char=${HUMAN_TIMINGS.char.min}-${HUMAN_TIMINGS.char.max}ms`
  );
}

function resolveServerId() {
  const fromStatus = String(process.env.STATUS_FILE_NAME || "").trim();
  if (fromStatus) return fromStatus;
  const fromTag = String(process.env.FB_SERVER_ID || process.env.SERVER_ID || "").trim();
  if (fromTag) return fromTag;
  return "VM_UNK";
}

function resolveAccountLogin() {
  const v = String(process.env.FB_ACCOUNT_LOGIN || process.env.ACCOUNT_LOGIN || "").trim();
  return v || null;
}

function readHostIdSync() {
  // Fonte de verdade do cluster (auditado): dados/.telemetry_hostid
  // - NÃO deriva de hostname/hardware hoje; é UUID persistido.
  try {
    const hostIdPath = path.join(__dirname, "..", "dados", ".telemetry_hostid");
    if (fsSync.existsSync(hostIdPath)) {
      const v = String(fsSync.readFileSync(hostIdPath, "utf8") || "").trim();
      return v || "";
    }
  } catch (_) {}
  return "";
}

function shouldEmitLeadText(textoLimpo) {
  const t = String(textoLimpo || "").trim();
  if (!t) return false;
  if (t.startsWith("mid.")) return false;
  // Bloqueio cirúrgico: tokens fantasmas de status (Meta), sem matar números curtos legítimos (ex.: DDD "48").
  if (/^\d+$/.test(t)) {
    if (t === "32" || t === "38") return false;
    // IDs/ruídos longos (ex.: sender/thread numeric puro) não são texto humano.
    if (t.length >= 6) return false;
  }
  return true;
}

function _pick(arr) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return "";
  return String(a[Math.floor(Math.random() * a.length)] || "").trim();
}

function resolveSaudacaoHorarioToken() {
  const h = new Date().getHours();
  if (h >= 6 && h <= 11) return "bom dia";
  if (h >= 12 && h <= 17) return "boa tarde";
  return "boa noite";
}
function toTitleCaseCityName(raw) {
  return String(raw || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
function normalizeCityToUfPattern(raw) {
  const s0 = String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/^[:\-]\s*/, "")
    .trim()
    .slice(0, 120);
  if (!s0) return "";
  const s = s0
    .replace(/–/g, "-")
    .replace(/—/g, "-")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  const m1 = s.match(/^(.+?)\s*\(\s*([A-Za-z]{2})\s*\)$/);
  if (m1 && m1[1] && m1[2]) {
    return `${toTitleCaseCityName(m1[1].trim())} (${String(m1[2]).toUpperCase()})`.slice(0, 80);
  }
  const m2 = s.match(/^(.+?)\s*[-,\/]\s*([A-Za-z]{2})$/);
  if (m2 && m2[1] && m2[2]) {
    return `${toTitleCaseCityName(m2[1].trim())} (${String(m2[2]).toUpperCase()})`.slice(0, 80);
  }
  return s.slice(0, 80);
}
function sanitizeLeadClientName(rawTitle) {
  const left = String(rawTitle || "").split(" · ")[0] || "";
  return left.replace(/\s+/g, " ").replace(/^[:\-]\s*/, "").trim().slice(0, 90);
}
const FEED_ACTIVE_LEAD_SELECTOR =
  "span.x1lliihq.x6ikm8r.x10wlt62.x1n2onr6.xlyipyv.xuxw1ft";
async function extractLeadClientNameFromFeedDom(page) {
  try {
    if (!page) return null;
    const raw = await page.evaluate((selector) => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const getVisible = (el) => {
        try {
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (st.visibility === "hidden" || st.display === "none") return false;
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        } catch {
          return false;
        }
      };
      // Seletor concreto do snippet do operador.
      const nodes = Array.from(document.querySelectorAll(selector));
      for (const el of nodes) {
        if (!getVisible(el)) continue;
        const t = clean(el.textContent || "");
        if (!t) continue;
        if (t.includes(" · ")) return t;
      }
      // Fallback tolerante para variações de DOM da Meta.
      const fallback = Array.from(document.querySelectorAll("span"))
        .filter((el) => getVisible(el))
        .map((el) => clean(el.textContent || ""))
        .find((t) => t && t.includes(" · "));
      return fallback || "";
    }, FEED_ACTIVE_LEAD_SELECTOR);
    const name = sanitizeLeadClientName(raw);
    try {
      __forensicEdgeEmit({
        account_login: null,
        thread_key: null,
        flow_stage: "dom_automation_tracking",
        details: {
          action: "lead_name_split",
          name_raw: String(raw || "").slice(0, 180),
          name_clean: String(name || "").slice(0, 120)
        }
      });
    } catch (_) {}
    return name || null;
  } catch {
    return null;
  }
}

const ATENDIMENTO_DELTA_PATH = path.join(__dirname, "..", "dados", "atendimentodelta.json");
let _atDeltaCache = { atMs: 0, parsed: null };

function readAtendimentoDeltaConfigSync() {
  const ttlMs = Math.max(2_000, Number(process.env.VIRTUS_DELTA_ATENDIMENTO_CACHE_TTL_MS || 20_000) || 20_000);
  const now = Date.now();
  if (_atDeltaCache.parsed && (now - _atDeltaCache.atMs) < ttlMs) return _atDeltaCache.parsed;
  try {
    const raw = String(fsSync.readFileSync(ATENDIMENTO_DELTA_PATH, "utf8") || "").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    _atDeltaCache = { atMs: now, parsed };
    return parsed;
  } catch {
    _atDeltaCache = { atMs: now, parsed: null };
    return null;
  }
}

function generateDeltaGreeting() {
  try {
    const cfg = readAtendimentoDeltaConfigSync() || {};
    const horario = resolveSaudacaoHorarioToken();
    const bloco1Raw = _pick(cfg.bloco1);
    const bloco1 = String(bloco1Raw || "").replace(/\[saudacao_horario\]/gi, horario).trim();

    const bloco2 = _pick(cfg.bloco2);
    const bloco3 = _pick(cfg.bloco3);
    const bloco4 = _pick(cfg.bloco4);

    const out = [bloco1, bloco2, bloco3, bloco4]
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .join("\n\n");
    return out;
  } catch {
    return [
      "Olá, [saudacao_horario]! Está disponível sim.".replace(/\[saudacao_horario\]/gi, resolveSaudacaoHorarioToken()),
      "Temos atendimento rápido e valores competitivos.",
      "Trabalhamos com fretes de pequeno, médio e grande porte.",
      "Me conta o que você precisa transportar para eu te ajudar agora.",
    ].join("\n\n");
  }
}

async function extractCityFromMarketplaceDom(page) {
  try {
    if (!page) return null;
    const res = await page.evaluate(() => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      // Regex rígida (não-gulosa) para evitar capturar "Message Save Share..."
      // Formato alvo: "Cidade, UF" ou "Cidade - UF" (retornamos normalizado para "Cidade (UF)").
      const GEO_RE = /([A-ZÀ-ÿ][A-ZÀ-ÿ\s]{1,60}?)\s*[,\-]\s*([A-Z]{2})\b/i;
      const out = [];
      const push = (value, source) => {
        const v = clean(value);
        if (!v) return;
        out.push({ value: v, source });
      };

      // Varredura nos mesmos blocos de detalhe/links do painel.
      const nodes = Array.from(document.querySelectorAll("span,div,a")).slice(0, 5500);
      for (const el of nodes) {
        const t = clean(el.textContent || "");
        if (!t) continue;
        const m = t.match(GEO_RE);
        if (!m || !m[1] || !m[2]) continue;
        const city = clean(m[1]);
        const uf = String(m[2] || "").trim().toUpperCase();
        if (!city || !uf) continue;
        push(`${city} (${uf})`, "dom_geo_regex");
      }

      // Fallback no texto total da página para layouts alternativos.
      const body = clean(document.body && document.body.innerText ? document.body.innerText : "");
      const bodyMatch = body.match(GEO_RE);
      if (bodyMatch && bodyMatch[1] && bodyMatch[2]) {
        const city = clean(bodyMatch[1]);
        const uf = String(bodyMatch[2] || "").trim().toUpperCase();
        if (city && uf) push(`${city} (${uf})`, "body_geo_regex");
      }

      if (!out.length) return { ok: false, value: null, source: null };
      return { ok: true, value: out[0].value, source: out[0].source };
    });
    const v = res && res.ok ? String(res.value || "").trim() : "";
    if (!v) return null;
    const normalized = normalizeCityToUfPattern(v);
    try {
      __forensicEdgeEmit({
        account_login: null,
        thread_key: null,
        flow_stage: "dom_automation_tracking",
        details: {
          action: "city_extract_dom",
          city_raw: String(v || "").slice(0, 120),
          city_clean: String(normalized || "").slice(0, 120),
          source: String(res && res.source || "").slice(0, 60) || null
        }
      });
    } catch (_) {}
    // Trava final: só aceita se terminar em (UF). Caso contrário, considera inválido (evita lixo no CT).
    if (!/^[^()]{2,80}\s*\(\s*[A-Z]{2}\s*\)$/.test(String(normalized || "").trim())) return null;
    return normalized;
  } catch {
    return null;
  }
}

async function captureDomForense(page) {
  return await page.evaluate(() => {
    const truncate = (s, max = 2200) => {
      const v = String(s || "");
      return v.length > max ? v.slice(0, max) + "…[trunc]" : v;
    };

    const pickFirstOuter = (selectors) => {
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) return truncate(el.outerHTML || "");
        } catch (_) {}
      }
      return "";
    };

    const composerHtml = pickFirstOuter([
      'div[contenteditable="true"][role="textbox"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label="Mensagem"]',
      'div[aria-label*="mensagem"]',
      'div[contenteditable="true"][aria-label]',
    ]);

    const sendHtml = pickFirstOuter([
      // Botão de enviar (quando há texto)
      '[role="button"][aria-label="Enviar"]',
      '[role="button"][aria-label*="Enviar"]',
      '[role="button"][aria-label="Send"]',
      '[role="button"][aria-label*="Send"]',
      '[role="button"][aria-label="Enviar"]',
      '[role="button"][aria-label*="Enviar"]',
      '[role="button"][aria-label="Send"]',
      '[role="button"][aria-label*="Send"]',
      '[aria-label="Enviar"][role="button"]',
      '[aria-label="Send"][role="button"]',
    ]);

    return {
      composer_outerHTML: composerHtml,
      send_outerHTML: sendHtml,
    };
  });
}

async function postWebhookJson(url, payload, { timeoutMs = 4500, headers = {} } = {}) {
  const u = String(url || "").trim();
  if (!u) return { ok: false, error: "webhook_url_empty" };

  const body = JSON.stringify(payload);

  if (typeof fetch === "function") {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => "");
      return { ok: res.ok, status: res.status, body: text.slice(0, 2000) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      clearTimeout(to);
    }
  }

  return { ok: false, error: "fetch_unavailable" };
}

async function killGhostChromeForProfile(profileDir) {
  const dir = String(profileDir || "").trim();
  if (!dir) return { ok: false, killed: 0 };

  let killedChrome = 0;
  if (typeof killChromeProfileProcesses === "function") {
    try {
      killChromeProfileProcesses(dir);
      killedChrome = 1;
    } catch (_) {}
  }

  // Fallback Windows: matar chrome.exe cujo cmdline contém o user-data-dir
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const norm = dir.replace(/\\/g, "\\\\");
      const ps = [
        "$procs = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction SilentlyContinue",
        "| Where-Object { $_.CommandLine -like '*${norm}*' }",
        "| Select-Object -ExpandProperty ProcessId",
        "foreach ($pid in $procs) { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }",
      ].join(" ");
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "ignore", windowsHide: true });
    } catch (_) {}
  }

  await humanPause("domSettle", "ghost_chrome_settle");
  return { ok: true, killed: killedChrome };
}

async function killGhostVirtusDeltaProcesses({ port, profileDir } = {}) {
  if (process.platform !== "win32") return;
  const ownPid = process.pid;
  const portStr = port ? String(port) : "";
  const dirNorm = String(profileDir || "").replace(/\\/g, "\\\\");

  try {
    const { execSync } = require("child_process");
    const filters = ["$_.Name -eq 'node.exe'", `$_.ProcessId -ne ${ownPid}`];
    if (portStr) filters.push(`$_.CommandLine -like '*VIRTUS_DELTA_PORT=${portStr}*'`);
    if (dirNorm) filters.push(`$_.CommandLine -like '*${dirNorm}*'`);
    const ps = [
      "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue",
      `| Where-Object { ${filters.join(" -and ")} }`,
      "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join(" ");
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "ignore", windowsHide: true });
  } catch (_) {}
  await humanPause("domSettle", "ghost_node_settle");
}

async function isThreadCardVisible(page, threadKey) {
  const t = String(threadKey || "").trim();
  if (!t) return false;
  const selectors = [
    `a[href="/messages/t/${t}/"]`,
    `a[href="/messages/t/${t}"]`,
    `a[href*="/messages/e2ee/t/${t}"]`,
    `a[href*="/messages/t/${t}"]`,
  ];
  for (const sel of selectors) {
    const el = await page.$(sel).catch(() => null);
    if (el) return true;
  }
  return false;
}

async function isMarketplaceFilterActive(page) {
  return Boolean(
    await page
      .evaluate(() => {
        const hrefNow = String(location.href || "").toLowerCase();
        const pathNow = String(location.pathname || "").toLowerCase();
        const searchNow = String(location.search || "").toLowerCase();
        const isThreadView =
          pathNow.includes("/messages/t/") ||
          pathNow.includes("/messages/e2ee/t/");
        if (pathNow.includes("/marketplace/item/")) return false;
        // Thread aberto não é feed de chats do marketplace.
        if (isThreadView && !searchNow.includes("folder=marketplace")) return false;
        if (pathNow.includes("/messages") && searchNow.includes("folder=marketplace")) return true;

        const h1s = Array.from(document.querySelectorAll("h1,[role='heading']"));
        const hasMarketplaceHeading = h1s.some((h) =>
          String(h.textContent || "").trim().toLowerCase() === "marketplace"
        );
        const gridLabels = Array.from(document.querySelectorAll('[role="grid"][aria-label]'));
        const hasMarketplaceGrid = gridLabels.some((g) =>
          String(g.getAttribute("aria-label") || "").trim().toLowerCase().includes("marketplace")
        );
        if (pathNow.includes("/messages") && hasMarketplaceHeading && hasMarketplaceGrid) return true;

        const isSelected = (el) => {
          if (!el) return false;
          if (el.getAttribute("aria-current") === "page") return true;
          if (el.getAttribute("aria-selected") === "true") return true;
          if (el.getAttribute("aria-pressed") === "true") return true;
          if (el.getAttribute("aria-checked") === "true") return true;
          return Boolean(el.closest('[aria-current="page"],[aria-selected="true"]'));
        };
        const mentionsMarketplace = (el) => {
          const txt = String(el.innerText || el.textContent || "").trim().toLowerCase();
          const label = String(el.getAttribute("aria-label") || "").trim().toLowerCase();
          const href = String(el.getAttribute("href") || "").trim().toLowerCase();
          return txt.includes("marketplace") || label.includes("marketplace") || href.includes("marketplace");
        };

        for (const a of document.querySelectorAll('a[href*="/messages/"],a[href*="folder=marketplace"],a[href*="marketplace"]')) {
          if (mentionsMarketplace(a) && isSelected(a)) return true;
        }
        for (const b of document.querySelectorAll('div[data-virtualized="false"] div[role="button"],[role="tab"],[role="button"][aria-label*="Marketplace"]')) {
          if (!mentionsMarketplace(b)) continue;
          if (isSelected(b)) return true;
        }
        return false;
      })
      .catch(() => false)
  );
}

async function waitForMarketplaceUiStable(page, label = "marketplace_ui_stable") {
  let stableRounds = 0;
  let lastSig = "";
  const maxRounds = Math.max(3, MARKETPLACE_STABILITY_ROUNDS * 2);

  for (let i = 0; i < maxRounds; i++) {
    await humanPause("domSettle", null);
    let ok = false;
    let sig = "";
    try {
      const out = await page.evaluate(() => {
        try {
          const ready = document.readyState === "complete" || document.readyState === "interactive";
          const busy = !!document.querySelector('[aria-busy="true"]');
          const controls = Array.from(
            document.querySelectorAll(
              'a[href*="folder=marketplace"],[role="tab"],header [role="button"],nav [role="button"],[role="navigation"] [role="button"]'
            )
          );
          const safeControls = controls.filter((el) => {
            const href = String(el.getAttribute("href") || "").trim().toLowerCase();
            if (href.includes("/messages/t/") || href.includes("/messages/e2ee/t/")) return false;
            if (href.includes("/marketplace/item/")) return false;
            const txt = String(el.textContent || "").trim().toLowerCase();
            const al = String(el.getAttribute("aria-label") || "").trim().toLowerCase();
            return txt.includes("marketplace") || al.includes("marketplace") || href.includes("folder=marketplace");
          });
          const visibleSafeControls = safeControls.filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const href = String(location.href || "").toLowerCase();
          const pathname = String(location.pathname || "").toLowerCase();
          const heading = Array.from(document.querySelectorAll("h1,[role='heading']")).map((h) =>
            String(h.textContent || "").trim().toLowerCase()
          ).join("|");
          const sig0 = `${pathname}|${visibleSafeControls.length}|${heading}|${href.includes("folder=marketplace") ? "fm=1" : "fm=0"}`;
          return {
            ok: ready && !busy && visibleSafeControls.length > 0,
            sig: sig0,
          };
        } catch (_) {
          return { ok: false, sig: "" };
        }
      });
      ok = !!(out && out.ok);
      sig = String((out && out.sig) || "");
    } catch (_) {
      ok = false;
      sig = "";
    }

    if (ok && sig && sig === lastSig) {
      stableRounds += 1;
    } else if (ok && sig) {
      stableRounds = 1;
      lastSig = sig;
    } else {
      stableRounds = 0;
      lastSig = "";
    }

    if (stableRounds >= MARKETPLACE_STABILITY_ROUNDS) break;
    await sleep(MARKETPLACE_STABILITY_GAP_MS);
  }

  await humanPause("marketplaceLoad", `${label}_final_load`);
}

async function waitForMessagesBootStable(page, label = "messages_boot_stable") {
  let stableRounds = 0;
  let lastSig = "";
  const maxRounds = Math.max(4, MESSAGES_BOOT_STABILITY_ROUNDS * 2 + 1);

  for (let i = 0; i < maxRounds; i++) {
    await humanPause("domSettle", `${label}_dom_settle`);
    let ok = false;
    let sig = "";
    try {
      const out = await page.evaluate(() => {
        try {
          const ready = document.readyState === "complete" || document.readyState === "interactive";
          const path = String(location.pathname || "").toLowerCase();
          const isMessages = path.includes("/messages");
          const busy = !!document.querySelector('[aria-busy="true"]');
          const tablist = !!document.querySelector('[role="tablist"]');
          const inboxSearch =
            !!document.querySelector('input[aria-label*="Pesquisar no Messenger"]') ||
            !!document.querySelector('input[aria-label*="Search in Messenger"]');
          const threadCount = Math.min(
            50,
            document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]').length
          );
          const sig0 = `${path}|tabs=${tablist ? 1 : 0}|search=${inboxSearch ? 1 : 0}|threads=${threadCount}`;
          return {
            ok: ready && isMessages && !busy && tablist && (inboxSearch || threadCount > 0),
            sig: sig0,
          };
        } catch (_) {
          return { ok: false, sig: "" };
        }
      });
      ok = !!(out && out.ok);
      sig = String((out && out.sig) || "");
    } catch (_) {
      ok = false;
      sig = "";
    }

    if (ok && sig && sig === lastSig) {
      stableRounds += 1;
    } else if (ok && sig) {
      stableRounds = 1;
      lastSig = sig;
    } else {
      stableRounds = 0;
      lastSig = "";
    }

    if (stableRounds >= MESSAGES_BOOT_STABILITY_ROUNDS) {
      logInfo(`[virtusDelta][boot] ${label}=ok rounds=${stableRounds}`);
      return true;
    }
    await sleep(MESSAGES_BOOT_STABILITY_GAP_MS);
  }

  logInfo(`[virtusDelta][boot] ${label}=timeout rounds=${stableRounds}`);
  return false;
}

async function waitMarketplaceActiveStable(page, { timeoutMs = 35000, rounds = 2 } = {}) {
  const start = Date.now();
  let okRounds = 0;
  while (Date.now() - start < timeoutMs) {
    const active = await isMarketplaceFilterActive(page);
    if (active) {
      okRounds += 1;
      if (okRounds >= Math.max(1, rounds)) return true;
    } else {
      okRounds = 0;
    }
    await sleep(Math.max(700, MARKETPLACE_STABILITY_GAP_MS));
  }
  return false;
}

async function ensureMarketplaceFilterActiveCore(page) {
  const now = Date.now();
  const guard = (page && page.__virtusDeltaMarketplaceGuard) ? page.__virtusDeltaMarketplaceGuard : {};
  const lastClickAt = Number(guard.lastClickAt || 0) || 0;
  const inFlight = Number(guard.inFlightUntil || 0) || 0;
  if (inFlight > now) {
    return { ok: false, skipped: true, reason: "in_flight_guard", active_before: false, active_after: false };
  }

  const activeBefore = await isMarketplaceFilterActive(page);
  if (activeBefore) {
    try { page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: now }; } catch (_) {}
    logInfo("[virtusDelta][marketplace] filter_already_active=sim");
    return { ok: true, already_active: true, active_after: true };
  }

  // Se clicamos há pouco, não reclicar: primeiro aguardar estabilização real do feed.
  if (lastClickAt && now - lastClickAt < 45000) {
    await waitForMarketplaceUiStable(page, "marketplace_recent_click");
    const activeAfterRecent = await waitMarketplaceActiveStable(page, { timeoutMs: 30000, rounds: 2 });
    if (activeAfterRecent) {
      try { page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: Date.now() }; } catch (_) {}
      return { ok: true, already_active: true, guarded_recent_click: true, active_before: activeBefore, active_after: true };
    }
  }

  if (lastClickAt && now - lastClickAt < 15000) {
    await humanPause("domSettle", "marketplace_guard_recheck");
    const activeAfterGuard = await isMarketplaceFilterActive(page);
    if (activeAfterGuard) {
      try { page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: Date.now() }; } catch (_) {}
      return { ok: true, already_active: true, guarded: true, active_before: activeBefore, active_after: true };
    }
  }

  logInfo("[virtusDelta][marketplace] activating_filter...");
  try {
    page.__virtusDeltaMarketplaceGuard = {
      ...guard,
      inFlightUntil: Date.now() + 20000,
    };
  } catch (_) {}
  await waitForMarketplaceUiStable(page, "marketplace_pre_click");
  await humanPause("preMarketplace", "pre_marketplace_click");
  const click = await clickMarketplaceFilterIfPresent(page);
  try {
    page.__virtusDeltaMarketplaceGuard = {
      ...(page.__virtusDeltaMarketplaceGuard || {}),
      inFlightUntil: 0,
      lastClickAt: click && click.changed ? Date.now() : lastClickAt,
    };
  } catch (_) {}
  await humanPause("postMarketplace", "post_marketplace_click");

  // Quando o alvo é o item "Marketplace" dentro da grade de conversas,
  // evitamos esperas longas: aplicamos retorno rápido e deixamos o enforcer manter o estado.
  if (click && click.strategy === "conversation_row_marketplace") {
    const activeQuick = await isMarketplaceFilterActive(page).catch(() => false);
    const activeAfterQuick = Boolean(activeQuick || click.selected_after_click);
    if (activeAfterQuick) {
      try {
        page.__virtusDeltaMarketplaceGuard = {
          ...(page.__virtusDeltaMarketplaceGuard || {}),
          lastStableAt: Date.now(),
        };
      } catch (_) {}
    }
    const quickOut = {
      ...click,
      active_before: activeBefore,
      active_after: activeAfterQuick,
      quick_path: true,
    };
    logInfo(`[virtusDelta][marketplace] activate result=${JSON.stringify(quickOut)}`);
    return quickOut;
  }

  let activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: 35000, rounds: 2 });
  if (!activeAfter && click.changed) {
    await humanPause("domSettle", "marketplace_changed_recheck");
    activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: 22000, rounds: 2 });
  }
  if (!activeAfter && !click.changed) {
    // Retry seguro: revalida carregamento e tenta novamente somente via seletor seguro.
    await waitForMarketplaceUiStable(page, "marketplace_safe_retry");
    const retry = await clickMarketplaceFilterIfPresent(page);
    await humanPause("domSettle", "marketplace_safe_retry_settle");
    activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: 26000, rounds: 2 });
    if (retry && retry.changed) {
      try {
        page.__virtusDeltaMarketplaceGuard = {
          ...(page.__virtusDeltaMarketplaceGuard || {}),
          lastClickAt: Date.now(),
        };
      } catch (_) {}
    }
  }

  if (!activeAfter && click.changed) {
    // Se "entrou e saiu" por re-render/duplo evento, faz um retorno único e validado.
    await waitForMarketplaceUiStable(page, "marketplace_recover");
    await humanPause("domSettle", "marketplace_recover_once");
    const recover = await clickMarketplaceFilterIfPresent(page);
    await humanPause("domSettle", "marketplace_recover_settle");
    activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: 26000, rounds: 2 });
    if (recover && recover.changed) {
      try {
        page.__virtusDeltaMarketplaceGuard = {
          ...(page.__virtusDeltaMarketplaceGuard || {}),
          lastClickAt: Date.now(),
        };
      } catch (_) {}
    }
  }

  let routeFallback = null;
  if (!activeAfter) {
    // Fallback determinístico: manter no feed de chats do marketplace dentro de /messages.
    const fallbackUrl = "https://www.facebook.com/messages/?folder=marketplace";
    try {
      await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await humanPause("domSettle", "marketplace_route_fallback_settle");
      activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: 22000, rounds: 2 });
      routeFallback = { attempted: true, ok: !!activeAfter, url: fallbackUrl };
    } catch (e) {
      routeFallback = {
        attempted: true,
        ok: false,
        url: fallbackUrl,
        error: e && e.message ? String(e.message) : String(e),
      };
    }
  }

  if (activeAfter) {
    try {
      page.__virtusDeltaMarketplaceGuard = {
        ...(page.__virtusDeltaMarketplaceGuard || {}),
        lastStableAt: Date.now(),
      };
    } catch (_) {}
  }

  logInfo(
    `[virtusDelta][marketplace] activate result=${JSON.stringify({ ...click, active_before: activeBefore, active_after: activeAfter, route_fallback: routeFallback })}`
  );
  return { ...click, active_before: activeBefore, active_after: activeAfter, route_fallback: routeFallback };
}

async function ensureMarketplaceFilterActive(page) {
  if (!page) return { ok: false, error: "no_page" };
  const prev = page.__virtusDeltaMarketplaceQueue || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  page.__virtusDeltaMarketplaceQueue = prev
    .catch(() => {})
    .then(() => gate)
    .catch(() => {});

  await prev.catch(() => {});
  try {
    return await ensureMarketplaceFilterActiveCore(page);
  } finally {
    try { release(); } catch (_) {}
  }
}

function startMarketplacePresenceEnforcer(page, { scope = "worker" } = {}) {
  if (!page || !DELTA_MARKETPLACE_ENFORCER_ENABLED) {
    logInfo(
      `[virtusDelta][marketplace_enforcer] scope=${scope} status=skipped reason=enforcer_disabled`
    );
    return { stop: () => {} };
  }

  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (page && page.__virtusDeltaReplyInFlight) {
        return;
      }
      const currentUrl = String(page.url ? page.url() : "").toLowerCase();
      if (!currentUrl.includes("facebook.com")) return;
      const guard = (page && page.__virtusDeltaMarketplaceGuard) ? page.__virtusDeltaMarketplaceGuard : {};
      const now = Date.now();

      if (!currentUrl.includes("facebook.com/messages")) {
        const outsideSince = Number(guard.outsideMessagesSince || 0) || now;
        try {
          page.__virtusDeltaMarketplaceGuard = {
            ...guard,
            outsideMessagesSince: outsideSince,
          };
        } catch (_) {}
        const outsideFor = now - outsideSince;
        if (outsideFor < DELTA_MARKETPLACE_RETURN_TO_MESSAGES_MS) return;
        logInfo(
          `[virtusDelta][marketplace_enforcer] scope=${scope} action=return_messages reason=outside_messages outside_for_ms=${outsideFor} url=${currentUrl}`
        );
        await page.goto("https://www.facebook.com/messages", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await humanPause("domSettle", "marketplace_enforcer_return_messages");
      } else {
        try {
          page.__virtusDeltaMarketplaceGuard = {
            ...guard,
            outsideMessagesSince: 0,
          };
        } catch (_) {}
      }

      const active = await isMarketplaceFilterActive(page);
      if (active) {
        try {
          page.__virtusDeltaMarketplaceGuard = {
            ...((page && page.__virtusDeltaMarketplaceGuard) || {}),
            marketplaceInactiveSince: 0,
          };
        } catch (_) {}
        return;
      }
      // Janela de calma também quando estamos em /messages/t/...:
      // evita "abre/fecha" repetitivo enquanto a thread está aberta.
      const guardNow = (page && page.__virtusDeltaMarketplaceGuard) ? page.__virtusDeltaMarketplaceGuard : {};
      const inactiveSince = Number(guardNow.marketplaceInactiveSince || 0) || now;
      try {
        page.__virtusDeltaMarketplaceGuard = {
          ...guardNow,
          marketplaceInactiveSince: inactiveSince,
        };
      } catch (_) {}
      const inactiveFor = now - inactiveSince;
      if (inactiveFor < DELTA_MARKETPLACE_RETURN_TO_MESSAGES_MS) return;
      logInfo(
        `[virtusDelta][marketplace_enforcer] scope=${scope} action=reactivate reason=marketplace_inactive url=${currentUrl}`
      );
      const out = await ensureMarketplaceFilterActive(page);
      logInfo(`[virtusDelta][marketplace_enforcer] scope=${scope} result=${JSON.stringify(out)}`);
    } catch (e) {
      logInfo(
        `[virtusDelta][marketplace_enforcer] scope=${scope} action=fail err=${e && e.message ? e.message : String(e)}`
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => {});
  }, DELTA_MARKETPLACE_ENFORCER_INTERVAL_MS);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 2500).unref?.();
  logInfo(
    `[virtusDelta][marketplace_enforcer] scope=${scope} status=armed interval_ms=${DELTA_MARKETPLACE_ENFORCER_INTERVAL_MS}`
  );

  return {
    stop: () => {
      stopped = true;
      try { clearInterval(timer); } catch (_) {}
    },
  };
}

async function isMarketplaceFilterVisible(page) {
  const anchors = await page.$$('a[href*="/messages/"]').catch(() => []);
  for (const a of anchors) {
    try {
      const ok = await a.evaluate((el) => {
        const txt = String(el.innerText || el.textContent || "").trim().toLowerCase();
        if (txt.includes("marketplace")) return true;
        return Array.from(el.querySelectorAll("span")).some(
          (s) => String(s.innerText || s.textContent || "").trim().toLowerCase() === "marketplace"
        );
      });
      if (ok) return true;
    } catch (_) {}
  }

  const buttons = await page.$$('div[data-virtualized="false"] div[role="button"]').catch(() => []);
  for (const b of buttons) {
    try {
      const ok = await b.evaluate((el) => {
        if (!el.querySelector("svg")) return false;
        const label = String(el.getAttribute("aria-label") || "").trim().toLowerCase();
        const txt = String(el.innerText || el.textContent || "").trim().toLowerCase();
        return label.includes("marketplace") || txt.includes("marketplace");
      });
      if (ok) return true;
    } catch (_) {}
  }
  return false;
}

async function forceSidebarRefreshByMessagesRoot(page) {
  const before = await page
    .evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll('a[href*="/messages"]'))
        .map((a) => String(a.getAttribute("href") || "").trim())
        .filter(Boolean)
        .slice(0, 16);
      return `${location.pathname}::${hrefs.join("|")}`;
    })
    .catch(() => "");

  const rootSelectors = ['a[href="/messages/"]', 'a[href="/messages"]', 'a[href*="/messages/"][role="link"]'];
  for (const sel of rootSelectors) {
    const els = await page.$$(sel).catch(() => []);
    for (const el of els) {
      try {
        const isNewOnly = await el.evaluate((node) => {
          const h = String(node.getAttribute("href") || "").trim();
          return h === "/messages/" || h === "/messages";
        });
        if (!isNewOnly) continue;
        await el.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("domSettle", "messages_root_click");
        const after = await page
          .evaluate(() => {
            const hrefs = Array.from(document.querySelectorAll('a[href*="/messages"]'))
              .map((a) => String(a.getAttribute("href") || "").trim())
              .filter(Boolean)
              .slice(0, 16);
            return `${location.pathname}::${hrefs.join("|")}`;
          })
          .catch(() => "");
        if (after && after !== before) {
          logInfo(`[virtusDelta][dom_force] messages_root_click changed sidebar`);
          return { ok: true, changed: true, strategy: "messages_root" };
        }
        return { ok: true, changed: false, strategy: "messages_root" };
      } catch (_) {}
    }
  }
  return { ok: false, changed: false, strategy: "messages_root_missing" };
}

async function prepareDomForNetworkLead(page, threadKey) {
  const t = String(threadKey || "").trim();
  logDelta("CITY", `🏙️ Extraindo link do item e coletando a cidade de origem no DOM...`, { threadKey: t });

  // Modo seguro: não forçar Marketplace por padrão para evitar "abre e sai" no passivo.
  const mp = DELTA_MARKETPLACE_AUTOFILTER_ENABLED
    ? await ensureMarketplaceFilterActive(page)
    : { ok: true, skipped: true, reason: "autofilter_disabled", active_after: false };

  let cardVisible = await isThreadCardVisible(page, t);
  logInfo(
    `[virtusDelta][dom_prep] thread_key=${t} card_visible=${cardVisible ? "sim" : "nao"} marketplace_active=${mp.active_after ? "sim" : "nao"}`
  );

  if (!cardVisible) {
    const root = await forceSidebarRefreshByMessagesRoot(page);
    logInfo(`[virtusDelta][dom_force] messages_root result=${JSON.stringify(root)}`);
    await humanPause("domSettle", "dom_prep_root_settle");
    if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED && !(await isMarketplaceFilterActive(page))) {
      await ensureMarketplaceFilterActive(page);
    }
    cardVisible = await isThreadCardVisible(page, t);
  }

  return { ok: true, cardVisible, marketplace: mp };
}

async function clickMarketplaceFilterIfPresent(page) {
  const getSig = () =>
    page
      .evaluate(() => {
        const hrefs = Array.from(document.querySelectorAll('a[href]'))
          .map((a) => String(a.getAttribute("href") || "").trim())
          .filter(Boolean)
          .filter((h) => h.includes("/messages"))
          .slice(0, 14);
        const path = String(location.pathname || "").trim();
        const search = String(location.search || "").trim();
        const hash = String(location.hash || "").trim();
        return `${path}${search}${hash}::${hrefs.join("|")}`;
      })
      .catch(() => "");

  const before = await getSig();

  // 0) alvo principal no Facebook Messages: linha "Marketplace" dentro do grid de conversas.
  const conversationMarketplaceButtons = await page.$$(
    [
      '[role="grid"][aria-label*="Convers"] [role="button"]',
      '[role="grid"][aria-label*="convers"] [role="button"]',
      '[role="grid"][aria-label*="Chat"] [role="button"]',
      '[role="grid"][aria-label*="chat"] [role="button"]',
      '[role="grid"][aria-label*="Conversation"] [role="button"]',
      '[role="grid"][aria-label*="conversation"] [role="button"]',
    ].join(",")
  ).catch(() => []);
  for (const b of conversationMarketplaceButtons) {
    try {
      const probe = await b.evaluate((el) => {
        const norm = (s) =>
          String(s || "")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .trim()
            .toLowerCase();
        const aria = norm(el.getAttribute("aria-label") || "");
        const txt = norm(el.innerText || el.textContent || "");
        if (!txt.includes("marketplace") && !aria.includes("marketplace")) {
          return { ok: false, reason: "no_marketplace_text" };
        }
        if (aria.includes("mais opcoes") || aria.includes("more options")) {
          return { ok: false, reason: "options_button" };
        }
        // Evita botao de tres pontos (acoes por thread).
        const hasMoreIcon = !!el.querySelector('svg path[d*="M2.25 10a1.75"]');
        if (hasMoreIcon) return { ok: false, reason: "more_icon" };
        const hasHouseIcon = !!el.querySelector('svg path[d*="M1.137 2.519"],svg path[d*="A2.131 2.131"]');
        const r = el.getBoundingClientRect();
        const visible = r.width > 8 && r.height > 8;
        const selectedBefore =
          el.getAttribute("aria-current") === "page" ||
          el.getAttribute("aria-selected") === "true" ||
          el.getAttribute("aria-pressed") === "true" ||
          Boolean(el.closest('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'));
        return { ok: true, hasHouseIcon, txt, aria, visible, selectedBefore };
      }).catch(() => ({ ok: false, reason: "eval_fail" }));
      if (!probe || !probe.ok) continue;
      if (!probe.visible) continue;

      await b.evaluate((el) => {
        try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch (_) {}
      }).catch(() => {});
      try {
        const labelPoint = await b.evaluate((el) => {
          const norm = (s) =>
            String(s || "")
              .normalize("NFD")
              .replace(/[\u0300-\u036f]/g, "")
              .trim()
              .toLowerCase();
          const nodes = Array.from(el.querySelectorAll("span,div"));
          const labelNode = nodes.find((n) => norm(n.textContent || "") === "marketplace");
          if (!labelNode) return null;
          const r = labelNode.getBoundingClientRect();
          if (r.width <= 2 || r.height <= 2) return null;
          return { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2) };
        }).catch(() => null);
        if (labelPoint && Number.isFinite(labelPoint.x) && Number.isFinite(labelPoint.y)) {
          await page.mouse.click(labelPoint.x, labelPoint.y, { delay: clickDelayMs() });
        }
      } catch (_) {}
      try {
        const bb = await b.boundingBox();
        if (bb && bb.width > 8 && bb.height > 8) {
          await page.mouse.click(
            Math.floor(bb.x + bb.width / 2),
            Math.floor(bb.y + bb.height / 2),
            { delay: clickDelayMs() }
          );
        }
      } catch (_) {}
      await b.click({ delay: clickDelayMs() }).catch(() => {});
      // Algumas variações do Facebook exigem sequência de ponteiro para efetivar seleção.
      const selectedAfterClick = await b.evaluate((el) => {
        const isSelected = () =>
          el.getAttribute("aria-current") === "page" ||
          el.getAttribute("aria-selected") === "true" ||
          el.getAttribute("aria-pressed") === "true" ||
          Boolean(el.closest('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'));
        if (isSelected()) return true;
        try {
          const r = el.getBoundingClientRect();
          const cx = Math.floor(r.left + r.width / 2);
          const cy = Math.floor(r.top + r.height / 2);
          const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new MouseEvent("mouseup", opts));
          el.dispatchEvent(new MouseEvent("click", opts));
        } catch (_) {}
        return isSelected();
      }).catch(() => false);
      let selectedAfterKeyboard = false;
      if (!selectedAfterClick) {
        try {
          await b.focus().catch(() => {});
          await page.keyboard.press("Enter").catch(() => {});
          selectedAfterKeyboard = await b.evaluate((el) => {
            return (
              el.getAttribute("aria-current") === "page" ||
              el.getAttribute("aria-selected") === "true" ||
              el.getAttribute("aria-pressed") === "true" ||
              Boolean(el.closest('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'))
            );
          }).catch(() => false);
        } catch (_) {}
      }
      let selectedAfterDoubleClick = false;
      if (!selectedAfterClick && !selectedAfterKeyboard) {
        try {
          await b.click({ delay: clickDelayMs() }).catch(() => {});
          await b.click({ delay: clickDelayMs() }).catch(() => {});
          selectedAfterDoubleClick = await b.evaluate((el) => {
            return (
              el.getAttribute("aria-current") === "page" ||
              el.getAttribute("aria-selected") === "true" ||
              el.getAttribute("aria-pressed") === "true" ||
              Boolean(el.closest('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'))
            );
          }).catch(() => false);
        } catch (_) {}
      }
      await humanPause("domSettle", "marketplace_conversation_row_click");
      const after = await getSig();
      const activeAfter = await isMarketplaceFilterActive(page);
      if (selectedAfterClick || selectedAfterKeyboard || selectedAfterDoubleClick || (after && after !== before) || activeAfter) {
        return {
          ok: true,
          changed: true,
          strategy: "conversation_row_marketplace",
          has_house_icon: !!probe.hasHouseIcon,
          selected_after_click: !!selectedAfterClick,
          selected_after_keyboard: !!selectedAfterKeyboard,
          selected_after_double_click: !!selectedAfterDoubleClick,
        };
      }
    } catch (_) {}
  }

  const isSafeMarketplaceControl = async (h) => {
    return Boolean(
      await h.evaluate((el) => {
        const href = String(el.getAttribute("href") || "").trim().toLowerCase();
        if (href.includes("/messages/t/") || href.includes("/messages/e2ee/t/")) return false;
        if (href.includes("/marketplace/item/")) return false;
        if (href && !href.includes("folder=marketplace") && !href.includes("/messages") && !href.includes("marketplace")) return false;

        const rowAncestor = el.closest('[role="row"],[role="gridcell"],[role="grid"],[role="tabpanel"]');
        if (rowAncestor) return false;

        const txt = String(el.innerText || el.textContent || "").trim().toLowerCase();
        const label = String(el.getAttribute("aria-label") || "").trim().toLowerCase();
        const mentionsMarketplace = txt.includes("marketplace") || label.includes("marketplace") || href.includes("marketplace");
        if (!mentionsMarketplace) return false;

        // Filtro esperado costuma estar em área de navegação/abas/header, não no feed de threads.
        const navAncestor = el.closest('[role="tablist"],header,nav,[role="navigation"]');
        return Boolean(navAncestor || href.includes("folder=marketplace"));
      }).catch(() => false)
    );
  };

  const isSelectedHandle = async (h) => {
    return Boolean(
      await h.evaluate((el) => {
        if (!el) return false;
        if (el.getAttribute("aria-current") === "page") return true;
        if (el.getAttribute("aria-selected") === "true") return true;
        if (el.getAttribute("aria-pressed") === "true") return true;
        if (el.getAttribute("aria-checked") === "true") return true;
        return Boolean(el.closest('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"],[aria-checked="true"]'));
      }).catch(() => false)
    );
  };

  // 1) âncoras contendo label Marketplace (sem depender de notificações)
  const anchors = await page.$$('a[href*="/messages/"],a[href*="marketplace"]').catch(() => []);
  for (const a of anchors) {
    try {
      const safe = await isSafeMarketplaceControl(a);
      if (!safe) continue;
      const selected = await isSelectedHandle(a);
      if (selected) return { ok: true, changed: false, strategy: "anchor_already_selected" };
      const ok = await a.evaluate((el) => {
        const txt = String(el.innerText || el.textContent || '').trim().toLowerCase();
        if (txt.includes('marketplace')) return true;
        const href = String(el.getAttribute("href") || "").trim().toLowerCase();
        if (href.includes("marketplace")) return true;
        const spans = Array.from(el.querySelectorAll('span'));
        return spans.some((s) => String(s.innerText || s.textContent || '').trim().toLowerCase() === 'marketplace');
      });
      if (ok) {
        await a.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("domSettle", "marketplace_anchor_click");
        const after = await getSig();
        const activeAfter = await isMarketplaceFilterActive(page);
        if ((after && after !== before) || activeAfter) return { ok: true, changed: true, strategy: "anchor_label" };
        break;
      }
    } catch (_) {}
  }

  // 2) botões com SVG (assinatura da lojinha) dentro da lateral
  const buttons = await page.$$('[role="tab"],header [role="button"],nav [role="button"],[role="navigation"] [role="button"]').catch(() => []);
  // 2a) tentativa “forte” quando existe texto/aria-label Marketplace
  for (const b of buttons) {
    try {
      const safe = await isSafeMarketplaceControl(b);
      if (!safe) continue;
      const selected = await isSelectedHandle(b);
      if (selected) return { ok: true, changed: false, strategy: "button_already_selected" };
      const ok = await b.evaluate((el) => {
        const label = String(el.getAttribute('aria-label') || '').trim().toLowerCase();
        const txt = String(el.innerText || el.textContent || '').trim().toLowerCase();
        const href = String(el.getAttribute("href") || "").trim().toLowerCase();
        return label.includes('marketplace') || txt === 'marketplace' || txt.includes('marketplace') || href.includes("folder=marketplace");
      });
      if (ok) {
        await b.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("domSettle", "marketplace_button_click");
        const after = await getSig();
        const activeAfter = await isMarketplaceFilterActive(page);
        if ((after && after !== before) || activeAfter) return { ok: true, changed: true, strategy: "button_label" };
        break;
      }
    } catch (_) {}
  }

  // 2b) fallback: em algumas contas o botão Marketplace é SOMENTE ícone (SVG) sem texto.
  // Segurança: não clicar ícones genéricos (3 pontinhos/ações por thread), pois causam saídas acidentais.
  // Só tenta ícones quando estiverem em tablist/header/nav e passarem o filtro de segurança.
  const svgButtons = [];
  for (const b of buttons) {
    try {
      const hasSvg = await b.evaluate((el) => Boolean(el.querySelector("svg")));
      if (!hasSvg) continue;
      const safe = await isSafeMarketplaceControl(b);
      if (safe) svgButtons.push(b);
    } catch (_) {}
  }
  for (const b of svgButtons.slice(0, 2)) {
    try {
      const selected = await isSelectedHandle(b);
      if (selected) return { ok: true, changed: false, strategy: "svg_already_selected" };
      await b.click({ delay: clickDelayMs() }).catch(() => {});
      await humanPause("domSettle", "marketplace_svg_fallback");
      const after = await getSig();
      const activeAfter = await isMarketplaceFilterActive(page);
      if ((after && after !== before) || activeAfter) return { ok: true, changed: true, strategy: "svg_icon_fallback" };
    } catch (_) {}
  }

  const afterFinal = await getSig();
  return { ok: Boolean(afterFinal && afterFinal !== before), changed: Boolean(afterFinal && afterFinal !== before), strategy: "none" };
}

async function extractMarketplaceItemLink(page) {
  const href = await page.evaluate(() => {
    const host = location.origin || '';
    const a =
      document.querySelector('div[class*="x1a8lsjc"] a[href*="/marketplace/item/"]') ||
      document.querySelector('a[href*="/marketplace/item/"]');
    if (!a) return '';
    const h = String(a.getAttribute('href') || '').trim();
    if (!h) return '';
    if (h.startsWith('http')) return h;
    return host + h;
  }).catch(() => "");
  return String(href || "").trim();
}

async function readComposerText(page) {
  return String(
    await page
      .evaluate(() => {
        const el =
          // Regra rígida (Gemini): foco/leitura EXCLUSIVOS do Lexical real.
          document.querySelector('div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]');
        if (!el) return "";
        return String(el.innerText || el.textContent || "").trim();
      })
      .catch(() => "")
  ).trim();
}

async function clickSendButtonIfPresent(page) {
  // Regra rígida (Gemini): redundância de envio deve caçar o botão real por acessibilidade (case-insensitive).
  try {
    const clickedStrict = await page.evaluate(() => {
      const target = 'pressione enter para enviar';
      const norm = (s) => String(s || '').trim().toLowerCase();
      const els = Array.from(document.querySelectorAll('div[role="button"][aria-label]'));
      const hit = els.find((el) => norm(el.getAttribute('aria-label')) === target);
      if (!hit) return false;
      try { hit.click(); } catch (_) {}
      return true;
    }).catch(() => false);
    if (clickedStrict) return true;
  } catch (_) {}

  const sels = [
    // Threads/Messenger moderno costuma expor o botão com este aria-label.
    '[role="button"][aria-label="Pressione Enter para enviar"]',
    '[role="button"][aria-label*="Enter para enviar"]',
    '[role="button"][aria-label*="para enviar"]',
    '[role="button"][aria-label*="Pressione Enter"]',
    '[role="button"][aria-label*="Press Enter"]',
    '[role="button"][aria-label="Enviar"]',
    '[role="button"][aria-label*="Enviar"]',
    '[role="button"][aria-label="Send"]',
    '[role="button"][aria-label*="Send"]',
  ];
  for (const sel of sels) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    const visible = await btn
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .catch(() => false);
    if (!visible) continue;
    await btn.click({ delay: clickDelayMs() }).catch(() => {});
    return true;
  }
  // Fallback: alguns temas/locais escondem o texto no <title> do SVG.
  try {
    const clicked = await page.evaluate(() => {
      const norm = (s) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim()
          .toLowerCase();
      const btns = Array.from(document.querySelectorAll('[role="button"][aria-label]'));
      const b = btns.find((el) => {
        const label = norm(el.getAttribute("aria-label") || "");
        if (!label) return false;
        if (label.includes("enviar")) return true;
        if (label.includes("press enter to send")) return true;
        if (label.includes("enter para enviar")) return true;
        return false;
      });
      if (b) {
        try { b.click(); } catch (_) {}
        return true;
      }
      const titles = Array.from(document.querySelectorAll('[role="button"] svg title'));
      const t = titles.find((n) => {
        const txt = norm(n.textContent || "");
        return txt.includes("enter para enviar") || txt.includes("press enter to send") || txt.includes("enviar");
      });
      const hostBtn = t ? t.closest('[role="button"]') : null;
      if (hostBtn) {
        try { hostBtn.click(); } catch (_) {}
        return true;
      }
      return false;
    });
    if (clicked) return true;
  } catch (_) {}
  return false;
}

async function ensureComposerFocused(page, ctx = {}) {
  const forensicAccountLogin = (ctx && ctx.account_login != null) ? String(ctx.account_login || "").trim() : null;
  const forensicThreadKey = (ctx && ctx.thread_key != null) ? String(ctx.thread_key || "").trim() : null;
  const startedAt = Date.now();
  const sels = [
    // Regra rígida (Gemini): foco EXCLUSIVO no Lexical real.
    'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
  ];

  let handle = null;
  let matched = null;
  for (const sel of sels) {
    handle = await page.$(sel).catch(() => null);
    if (handle) { matched = sel; break; }
  }
  if (!handle) {
    try {
      const current = await page.evaluate(() => String(location.pathname || "")).catch(() => "");
      __forensicEdgeEmit({
        account_login: forensicAccountLogin,
        thread_key: forensicThreadKey,
        flow_stage: "composer_focus_lifecycle",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          phase: "missing",
          thread_key: forensicThreadKey,
          selectors_tried: sels.slice(0, 10),
          current_path: current ? String(current) : null,
          ts_ms: Date.now(),
          elapsed_ms: Date.now() - startedAt,
        }
      });
    } catch (_) {}
    throw new Error("composer_missing");
  }

  try {
    const current = await page.evaluate(() => String(location.pathname || "")).catch(() => "");
    __forensicEdgeEmit({
      account_login: forensicAccountLogin,
      thread_key: forensicThreadKey,
      flow_stage: "composer_focus_lifecycle",
      details: {
        tag: "FORENSIC_DOM_REVERSE",
        phase: "found",
        thread_key: forensicThreadKey,
        matched_selector: matched,
        current_path: current ? String(current) : null,
        ts_ms: Date.now(),
        elapsed_ms: Date.now() - startedAt,
      }
    });
  } catch (_) {}

  await handle.click({ delay: clickDelayMs() }).catch(() => {});
  await humanPause("preComposer", "composer_focus");

  const existing = await readComposerText(page);
  try {
    __forensicEdgeEmit({
      account_login: forensicAccountLogin,
      thread_key: forensicThreadKey,
      flow_stage: "composer_focus_lifecycle",
      details: {
        tag: "FORENSIC_DOM_REVERSE",
        phase: "after_click",
        thread_key: forensicThreadKey,
        matched_selector: matched,
        existing_chars: existing ? String(existing).length : 0,
        had_existing_text: !!(existing && String(existing).trim()),
        ts_ms: Date.now(),
        elapsed_ms: Date.now() - startedAt,
      }
    });
  } catch (_) {}
  if (!existing) return handle;

  const ctrlKey = process.platform === "darwin" ? "Meta" : "Control";
  try {
    await page.keyboard.down(ctrlKey);
    await page.keyboard.press("KeyA");
    await page.keyboard.up(ctrlKey);
  } catch (_) {}
  try {
    await page.keyboard.press("Backspace");
  } catch (_) {}

  return handle;
}

async function typeHumanized(page, textoResposta) {
  const full = String(textoResposta || "").replace(/\r/g, "");
  logDelta("TYPING", `⌨️ Injetando fatiador combinatório do atendimentodelta.json caractere por caractere.`, { chars: full.length });
  for (const ch of full) {
    if (ch === "\n") {
      try {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Enter");
        await page.keyboard.up("Shift");
      } catch (_) {}
      await humanPause("lineBreak", "shift_enter");
      continue;
    }
    try {
      await page.keyboard.sendCharacter(ch);
    } catch (_) {
      try {
        await page.keyboard.type(ch, { delay: 0 });
      } catch (_) {}
    }
    await humanPause("char", null);
  }
}

async function scrollSidebarShort(page) {
  return await page.evaluate(() => {
    const candidates = [];
    const nav = document.querySelector('div[role="navigation"]');
    if (nav) candidates.push(nav);
    const grids = Array.from(document.querySelectorAll('div[role="grid"],div[role="rowgroup"]'));
    candidates.push(...grids);
    const anyScrollable = Array.from(document.querySelectorAll("div"))
      .filter((d) => d && d.scrollHeight > d.clientHeight + 40)
      .slice(0, 12);
    candidates.push(...anyScrollable);

    const uniq = [];
    const seen = new Set();
    for (const c of candidates) {
      if (!c || !c.scrollBy) continue;
      if (seen.has(c)) continue;
      seen.add(c);
      uniq.push(c);
    }
    const target = uniq[0] || document.scrollingElement || document.body;
    try {
      const before = Number(target && target.scrollTop || 0) || 0;
      target.scrollBy(0, 520);
      const after = Number(target && target.scrollTop || 0) || 0;
      const delta = after - before;
      return Number.isFinite(delta) ? delta : 520;
    } catch (_) {}
    return 0;
  });
}

async function openThreadByClick(page, threadKey, { maxScrollSteps = 16, forensicAccountLogin = null } = {}) {
  const t = String(threadKey || "").trim();
  if (!t) throw new Error("thread_key_empty");

  // Espera curta e segura pelo carregamento do sidebar (sem polling agressivo).
  // Objetivo: evitar tentar clicar antes dos cards existirem no DOM.
  try {
    await page.waitForFunction(
      () => {
        const hrefs = Array.from(document.querySelectorAll('a[href*="/messages"]'))
          .map((a) => String(a.getAttribute("href") || ""))
          .filter(Boolean);
        const nonNew = hrefs.filter((h) => !h.includes("/messages/new"));
        return nonNew.length >= 1;
      },
      { timeout: 8000 }
    );
  } catch (_) {}

  const selectors = [
    `a[href="/messages/t/${t}/"]`,
    `a[href="/messages/t/${t}"]`,
    `a[href*="/messages/e2ee/t/${t}"]`,
    `a[href*="/messages/t/${t}"]`,
    `a[href*="${t}"]`,
  ];

  for (let i = 0; i < maxScrollSteps; i++) {
    for (const sel of selectors) {
      const a = await page.$(sel).catch(() => null);
      if (a) {
        // Trava de segurança (Gemini): não clicar se o card já está ativo (aria-current="page").
        try {
          const isCurrentPage = await a
            .evaluate((el) => {
              if (!el) return false;
              if (el.getAttribute("aria-current") === "page") return true;
              return Boolean(el.closest('[aria-current="page"]'));
            })
            .catch(() => false);
          if (isCurrentPage) {
            try {
              const currentPath = await page.evaluate(() => String(location.pathname || "")).catch(() => "");
              __forensicEdgeEmit({
                account_login: forensicAccountLogin,
                thread_key: t,
                flow_stage: "browser_window_state_check",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  selector: sel,
                  scrolled: i,
                  is_already_open: true,
                  aria_current_page: true,
                  skipped_click: true,
                  current_path: currentPath ? String(currentPath) : null,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
            return { ok: true, scrolled: i, matched_selector: sel, already_open: true, skipped_click: true };
          }
        } catch (_) {}

        await humanPause("preThreadClick", "pre_thread_card_click");
        try {
          const st = await page
            .evaluate((threadId) => {
              const p = String(location.pathname || "").trim();
              const is =
                (p.includes("/messages") && p.includes(`/t/${threadId}`)) ||
                (p.includes("/messages") && p.includes(threadId));
              return { current_path: p, is_already_open: !!is };
            }, t)
            .catch(() => ({ current_path: null, is_already_open: false }));
          __forensicEdgeEmit({
            account_login: forensicAccountLogin,
            thread_key: t,
            flow_stage: "browser_window_state_check",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              selector: sel,
              scrolled: i,
              is_already_open: !!(st && st.is_already_open),
              current_path: st && st.current_path ? String(st.current_path) : null,
              ts_ms: Date.now(),
            }
          });
        } catch (_) {}
        try {
          __forensicEdgeEmit({
            account_login: forensicAccountLogin,
            thread_key: t,
            flow_stage: "dom_automation_tracking",
            details: { action: "open_thread_click", selector: sel, scrolled: i }
          });
        } catch (_) {}
        await a.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("postThreadOpen", "post_thread_card_click");
        return { ok: true, scrolled: i, matched_selector: sel };
      }
    }
    const delta = await scrollSidebarShort(page).catch(() => 0);
    try {
      __forensicEdgeEmit({
        account_login: forensicAccountLogin,
        thread_key: t,
        flow_stage: "sidebar_scroll_action",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          attempt: i + 1,
          max_attempts: maxScrollSteps,
          scrolled_pixels: Number(delta || 0) || 0,
          ts_ms: Date.now(),
        }
      });
    } catch (_) {}
    await humanPause("scroll", "sidebar_scroll");
  }

  let hrefPreview = [];
  try {
    hrefPreview = await page.$$eval("a[href]", (els) =>
      els
        .map((e) => String(e.getAttribute("href") || "").trim())
        .filter(Boolean)
        .filter((h) => h.includes("/messages"))
        .slice(0, 25)
    );
  } catch (_) {}

  // Fallback de homologação (sem goto/reload): clicar no chat atualmente aberto.
  // Isso valida o pipeline de acessibilidade mesmo quando o thread_key do barramento
  // não corresponde ao ID que aparece no href do card lateral.
  try {
    const current = String(await page.evaluate(() => location.pathname || "")).trim();
    if (current.includes("/messages/") && current.includes("/t/")) {
      const fallbackSel = `a[href*="${current}"]`;
      const a2 = await page.$(fallbackSel).catch(() => null);
      if (a2) {
        await humanPause("preThreadClick", "pre_thread_fallback_click");
        try {
          const isAlreadyOpen = current.includes(t);
          __forensicEdgeEmit({
            account_login: forensicAccountLogin,
            thread_key: t,
            flow_stage: "browser_window_state_check",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              selector: fallbackSel,
              scrolled: maxScrollSteps,
              is_already_open: !!isAlreadyOpen,
              current_path: current,
              ts_ms: Date.now(),
              fallback: true,
            }
          });
        } catch (_) {}
        try {
          __forensicEdgeEmit({
            account_login: forensicAccountLogin,
            thread_key: t,
            flow_stage: "dom_automation_tracking",
            details: { action: "open_thread_click_fallback", selector: fallbackSel, current_path: current }
          });
        } catch (_) {}
        await a2.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("postThreadOpen", "post_thread_fallback_click");
        return { ok: true, scrolled: maxScrollSteps, fallback_current_thread: true, current_path: current };
      }
    }
  } catch (_) {}

  return { ok: false, error: "thread_card_not_found", href_preview: hrefPreview };
}

async function sendReplyFlow({ page, threadKey, textoResposta, fromNetworkLead = false, onItemLink = null, forensicAccountLogin = null } = {}) {
  const t = String(threadKey || "").trim();
  logInfo(`[virtusDelta][reply] start thread_key=${t} chars=${String(textoResposta || "").length} from_network=${fromNetworkLead ? "sim" : "nao"}`);
  try { if (page) page.__virtusDeltaReplyInFlight = true; } catch (_) {}
  try {
    await humanReactionDelay(fromNetworkLead);

    // Proteção anti-freeze: expurga seleção residual do mouse antes de qualquer automação.
    try {
      await page.evaluate(() => {
        try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
      });
    } catch (_) {}

    const __isAlreadyOpenByUrl = () => {
      try {
        const rawUrl = String(page && page.url ? page.url() : "");
        const m = rawUrl.match(/\/messages\/t\/(\d+)\//i);
        const currentThread = m && m[1] ? String(m[1]) : "";
        if (currentThread && currentThread === String(t)) {
          return { ok: true, current_thread: currentThread, current_path: `/messages/t/${currentThread}/`, url: rawUrl };
        }
        return { ok: false, current_thread: currentThread || null, current_path: m && m[1] ? `/messages/t/${currentThread}/` : null, url: rawUrl };
      } catch {
        return { ok: false, current_thread: null, current_path: null, url: "" };
      }
    };

    if (fromNetworkLead) {
      try {
        await prepareDomForNetworkLead(page, threadKey);
      } catch (e) {
        logInfo(`[virtusDelta][dom_prep] fail thread_key=${t} err=${e && e.message ? e.message : String(e)}`);
      }
    }

    if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED) {
      try {
        const st = __isAlreadyOpenByUrl();
        // Regra rígida de velocidade:
        // Se a conversa já está aberta/selecionada, NÃO rodar ensureMarketplaceFilterActive (custa caro e gera HOL).
        if (st && st.ok === true) {
          try {
            __forensicEdgeEmit({
              account_login: forensicAccountLogin,
              thread_key: t,
              flow_stage: "marketplace_filter_bypass",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                reason: "thread_already_open_url",
                is_already_open: true,
                current_path: st.current_path || null,
                url: st.url ? String(st.url).slice(0, 300) : null,
                ts_ms: Date.now(),
              }
            });
          } catch (_) {}
        } else {
          await ensureMarketplaceFilterActive(page);
        }
      } catch (_) {}
    }

    const open = await openThreadByClick(page, threadKey, { forensicAccountLogin });
    if (!open.ok) {
      if (fromNetworkLead) {
        try {
          logInfo(`[virtusDelta][reply] openThread retry after dom_force thread_key=${t}`);
          await forceSidebarRefreshByMessagesRoot(page);
          await humanPause("domSettle", "open_thread_retry_root");
          if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED) {
            try {
              const st2 = __isAlreadyOpenByUrl();
              if (st2 && st2.ok === true) {
                try {
                  __forensicEdgeEmit({
                    account_login: forensicAccountLogin,
                    thread_key: t,
                    flow_stage: "marketplace_filter_bypass",
                    details: {
                      tag: "FORENSIC_DOM_REVERSE",
                      reason: "thread_already_open_url_retry",
                      is_already_open: true,
                      current_path: st2.current_path || null,
                      url: st2.url ? String(st2.url).slice(0, 300) : null,
                      ts_ms: Date.now(),
                    }
                  });
                } catch (_) {}
              } else {
                await ensureMarketplaceFilterActive(page);
              }
            } catch (_) {
              try { await ensureMarketplaceFilterActive(page); } catch (_) {}
            }
            await humanPause("postMarketplace", "open_thread_retry_marketplace");
          }
        } catch (_) {}
        const open2 = await openThreadByClick(page, threadKey, { maxScrollSteps: 20, forensicAccountLogin });
        if (open2.ok) {
          Object.assign(open, open2);
        }
      }
    }

    if (!open.ok) {
      logInfo(`[virtusDelta][reply] openThread FAIL thread_key=${t} error=${open.error}`);
      if (open.href_preview && open.href_preview.length) {
        logInfo(`[virtusDelta][reply] href_preview=${JSON.stringify(open.href_preview)}`);
      }
      return open;
    }
    logInfo(
      `[virtusDelta][reply] openThread OK thread_key=${t} scrolled=${open.scrolled} selector=${String(open.matched_selector || "")}`
    );

    await humanPause("postThreadOpen", "post_open_read_context");

    // Link do classificado (Coletor 101) - coletado no exato momento de abertura do chat.
    let itemLink = null;
    try {
      itemLink = await extractMarketplaceItemLink(page);
      if (itemLink) {
        logInfo(`[COLETOR_101_LINK] ${itemLink}`);
        if (typeof onItemLink === "function") {
          try { onItemLink(itemLink); } catch (_) {}
        }
      }
    } catch (_) {}

    await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
    await humanPause("preTyping", "pre_typing");
    if (process.env.VIRTUS_DELTA_DUMP_DOM === "1") {
      try {
        const dom = await captureDomForense(page);
        logInfo(`[virtusDelta][DOM] thread_key=${t} composer_outerHTML=${dom.composer_outerHTML}`);
        logInfo(`[virtusDelta][DOM] thread_key=${t} send_outerHTML=${dom.send_outerHTML}`);
      } catch (_) {}
    }
    await typeHumanized(page, textoResposta);
    let composed = await readComposerText(page);
    logInfo(`[virtusDelta][composer] after_type chars=${composed.length} preview="${composed.slice(0, 60)}"`);

    // IMPORTANT: mensagens curtas ("oi", "ok") são válidas; não podemos tratar <3 como "vazio".
    if (!composed || composed.length < 1) {
      logInfo(`[virtusDelta][composer] retry_focus_and_type thread_key=${t}`);
      await humanPause("domSettle", "composer_retry_settle");
      await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
      await humanPause("preTyping", "pre_typing_retry");
      await typeHumanized(page, textoResposta);
      composed = await readComposerText(page);
      logInfo(`[virtusDelta][composer] after_retry chars=${composed.length} preview="${composed.slice(0, 60)}"`);
    }

    if (process.env.VIRTUS_DELTA_DUMP_DOM === "1") {
      try {
        const dom2 = await captureDomForense(page);
        logInfo(`[virtusDelta][DOM] thread_key=${t} after_type_send_outerHTML=${dom2.send_outerHTML}`);
      } catch (_) {}
    }
    await humanPause("preSend", "pre_enter_send");
    // Estratégia enterprise:
    // 1) Enter para enviar
    // 2) Se não limpou o composer, tenta clicar no botão "Pressione Enter para enviar"/Enviar
    // 3) Só considera OK se o composer ficar vazio (confirmação local mínima).
    const initial = String(composed || "").trim();
    if (!initial) {
      const clicked = await clickSendButtonIfPresent(page);
      logInfo(`[virtusDelta][reply] composer_empty thread_key=${t} send_button=${clicked ? "sim" : "nao"}`);
      return clicked ? { ok: true, item_link: itemLink || null } : { ok: false, error: "composer_text_not_registered" };
    }

    try { await page.keyboard.press("Enter"); } catch (_) {}
    logInfo(`[virtusDelta][reply] enter_sent thread_key=${t}`);
    await humanPause("postSend", "post_enter_send");

    let after = await readComposerText(page);
    if (after && after.trim()) {
      const clicked = await clickSendButtonIfPresent(page);
      logInfo(`[virtusDelta][reply] send_button_fallback thread_key=${t} clicked=${clicked ? "sim" : "nao"}`);
      await humanPause("postSend", "post_send_click_fallback");
      after = await readComposerText(page);
    }

    if (after && after.trim()) {
      // Composer ainda tem texto: não confirmou envio.
      return { ok: false, error: "send_not_confirmed_composer_not_empty", composer_preview: after.slice(0, 80) };
    }

    return { ok: true, item_link: itemLink || null };
  } finally {
    try { if (page) page.__virtusDeltaReplyInFlight = false; } catch (_) {}
  }
}

async function openThreadAndExtractItemLink(page, threadKey, { fromNetworkLead = true } = {}) {
  const t = String(threadKey || "").trim();
  if (!t) return { ok: false, error: "missing_thread_key" };
  try {
    if (fromNetworkLead) {
      await prepareDomForNetworkLead(page, threadKey);
    }
  } catch (_) {}

  const open = await openThreadByClick(page, threadKey, { maxScrollSteps: 20, forensicAccountLogin: null });
  if (!open || !open.ok) {
    return { ok: false, error: String((open && open.error) || "thread_open_failed") };
  }

  let itemLink = null;
  try {
    itemLink = await extractMarketplaceItemLink(page);
  } catch (_) {}
  if (!itemLink) {
    return { ok: false, error: "item_link_missing" };
  }
  return { ok: true, item_link: itemLink };
}

async function collectCityFromItemLinkUsingGlobalCollector({ itemLink, threadKey, accountLogin }) {
  if (typeof getDeltaCityCollector !== "function") {
    return { ok: false, error: "delta_city_collector_unavailable" };
  }
  const collector = await getDeltaCityCollector();
  if (!collector || typeof collector.collectCityFromItemLink !== "function") {
    return { ok: false, error: "delta_city_collector_runtime_invalid" };
  }
  const out = await collector.collectCityFromItemLink({
    item_link: itemLink,
    thread_key: threadKey,
    account_login: accountLogin,
  });
  return out && typeof out === "object" ? out : { ok: false, error: "delta_city_collector_unknown_error" };
}

function createSerialQueue() {
  let chain = Promise.resolve();
  let depth = 0;
  let maxDepth = 0;
  let lastEnqueueAt = 0;
  let lastDequeueAt = 0;
  let lastDoneAt = 0;

  const enqueue = (fn) => {
    const enqueuedAt = Date.now();
    depth = Math.max(0, depth + 1);
    maxDepth = Math.max(maxDepth, depth);
    lastEnqueueAt = enqueuedAt;
    chain = chain
      .then(async () => {
        lastDequeueAt = Date.now();
        try {
          return await fn();
        } finally {
          depth = Math.max(0, depth - 1);
          lastDoneAt = Date.now();
        }
      })
      .catch(() => {});
    return chain;
  };
  enqueue.getDepth = () => depth;
  enqueue.getMaxDepth = () => maxDepth;
  enqueue.getMeta = () => ({ depth, maxDepth, lastEnqueueAt, lastDequeueAt, lastDoneAt });
  return enqueue;
}

async function loadCookies(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Arquivo de cookies invalido: esperado array com ao menos 1 cookie.");
  }
  return parsed;
}

async function startVirtusDeltaStandaloneRuntime({
  accountLogin,
  serverId,
  ctIngestUrl,
  deltaSecret,
  expressPort,
  chromeExecutable,
  userDataDir,
  cookiesFile,
  startUrl,
} = {}) {
  const diskServerId = readHostIdSync();
  const SERVER_ID = diskServerId || serverId || resolveServerId();
  const ACCOUNT_LOGIN = accountLogin || resolveAccountLogin();
  const CT_INGEST_URL = String(ctIngestUrl || process.env.VIRTUS_DELTA_CT_INGEST_URL || "").trim();
  const DELTA_SECRET = String(deltaSecret || process.env.VIRTUS_DELTA_SECRET || process.env.VIRTUS_DELTA_X_DELTA_SECRET || "").trim();
  const PORT = Number(expressPort || process.env.VIRTUS_DELTA_PORT || 4000);
  const DUMP_DOM = process.env.VIRTUS_DELTA_DUMP_DOM === "1";

  const executablePath =
    chromeExecutable ||
    process.env.CHROME_PATH ||
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe");
  const profileDir =
    userDataDir ||
    process.env.VIRTUS_DELTA_USER_DATA_DIR ||
    path.join(__dirname, "..", "dados", "chrome-session-virtus-delta");
  const cookieFp =
    cookiesFile ||
    process.env.VIRTUS_DELTA_COOKIES_FILE ||
    path.join(__dirname, "..", "dados", "facebook_test_cookies.local.json");
  const urlInicial = startUrl || process.env.VIRTUS_DELTA_START_URL || "https://www.facebook.com/messages";

  logInfo(
    `[virtusDelta][boot] server_id=${SERVER_ID} account_login=${ACCOUNT_LOGIN || "null"} port=${PORT} url=${urlInicial}`
  );
  logInfo(`[virtusDelta][boot] user_data_dir=${profileDir}`);
  logInfo(`[virtusDelta][boot] cookies_file=${cookieFp}`);
  if (DUMP_DOM) logInfo(`[virtusDelta][boot] dom_dump=enabled`);
  logHumanTimingsBoot();
  // FUSÃO OPERACIONAL (FASE 1/2): ingest/capture removidos deste processo (Ouvido agora é do worker.js).

  await killGhostVirtusDeltaProcesses({ port: PORT, profileDir });
  const ghost = await killGhostChromeForProfile(profileDir);
  logInfo(`[virtusDelta][boot] ghost_chrome_cleanup=${ghost.ok ? "ok" : "skip"}`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: profileDir,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-features=IsolateOrigins,site-per-process"],
    defaultViewport: null,
  });

  // Garantir janela única (evita perda de cache por abas duplicadas)
  const existingPages = await browser.pages().catch(() => []);
  const page = existingPages[0] || (await browser.newPage());
  attachDeltaNavigationFirewall(page, { profileName: ACCOUNT_LOGIN });
  for (const p of existingPages.slice(1)) {
    try {
      await p.close();
    } catch (_) {}
  }
  browser.on("targetcreated", async (target) => {
    try {
      if (target.type() !== "page") return;
      const newPage = await target.page();
      if (!newPage || newPage === page) return;
      const pages = await browser.pages();
      if (pages.length > 1) await newPage.close().catch(() => {});
    } catch (_) {}
  });
  try {
    if (cookieFp && fsSync.existsSync(cookieFp)) {
      const cookies = await loadCookies(cookieFp);
      try {
        await page.setCookie(...cookies);
      } catch (_) {}
    }
  } catch (_) {}

  await page.goto(urlInicial, { waitUntil: "domcontentloaded", timeout: 45000 });
  try {
    await waitForMessagesBootStable(page, "messages_ready_standalone");
  } catch (_) {}
  try {
    const currentUrl = page.url();
    const title = await page.title();
    const facebookCookies = await page.cookies("https://www.facebook.com");
    const fallbackCookies = await page.cookies("https://facebook.com");
    const allCookies = [...facebookCookies, ...fallbackCookies];
    const cUserCookie = allCookies.find((cookie) => cookie.name === "c_user");
    logInfo(`[virtusDelta][boot] page_url=${currentUrl}`);
    logInfo(`[virtusDelta][boot] page_title=${title}`);
    logInfo(`[virtusDelta][boot] cookie_c_user_present=${cUserCookie ? "sim" : "nao"}`);
  } catch (_) {}
  if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED) {
    try {
      const mpBoot = await ensureMarketplaceFilterActive(page);
      logInfo(`[virtusDelta][boot] marketplace_boot=${JSON.stringify(mpBoot)}`);
    } catch (e) {
      logInfo(`[virtusDelta][boot] marketplace_boot_fail err=${e && e.message ? e.message : String(e)}`);
    }
  } else {
    logInfo("[virtusDelta][boot] marketplace_boot=skipped reason=autofilter_disabled");
  }

  // FUSÃO OPERACIONAL (FASE 1):
  // O "Ouvido" (CDP + Network.webSocketFrameReceived) foi removido do virtusDelta e
  // passou a ser propriedade única do worker.js (escuta passiva + fila/ingest).

  let cityCache = { at: 0, value: null };
  let cityTimer = null;
  const marketplaceEnforcer = startMarketplacePresenceEnforcer(page, { scope: "standalone" });
  const updateCityCache = async () => {
    try {
      const v = await extractCityFromMarketplaceDom(page);
      if (v) cityCache = { at: Date.now(), value: v };
    } catch {}
  };
  try {
    await updateCityCache();
    cityTimer = setInterval(() => updateCityCache().catch(() => {}), Math.max(10_000, Number(process.env.VIRTUS_DELTA_CITY_CACHE_MS || 30_000) || 30_000));
    cityTimer.unref?.();
  } catch {}

  // FUSÃO OPERACIONAL (FASE 2):
  // Elimina terminantemente o servidor HTTP individual do virtusDelta.
  // Entrada de comandos agora é exclusivamente via Maestro :8088 + IPC (index.js -> cluster -> worker).
  logInfo(`[virtusDelta][boot] standalone_http=disabled reason=fusion_command_bus_ipc`);

  return {
    ok: true,
    server_id: SERVER_ID,
    account_login: ACCOUNT_LOGIN,
    browser,
    page,
    shutdown: async () => {
      try {
        marketplaceEnforcer.stop();
      } catch (_) {}
      try {
        if (cityTimer) clearInterval(cityTimer);
      } catch (_) {}
      try {
        await browser.close();
      } catch (_) {}
    },
  };
}

async function startVirtusDeltaWorkerRuntime(browser, nome, cfg = {}) {
  const requiredEpoch = Number(cfg && cfg.epoch != null ? cfg.epoch : 0) || 0;
  const restrictTab = (cfg && cfg.restrictTab != null) ? (Number(cfg.restrictTab) || 0) : 0;
  const slowMode = !!(cfg && cfg.slowMode);

  const SERVER_ID = readHostIdSync() || resolveServerId();
  const ACCOUNT_LOGIN = (cfg && cfg.accountLogin) ? String(cfg.accountLogin).trim() : (String(nome || "").trim() || resolveAccountLogin());

  const startUrl = String((cfg && cfg.startUrl) || process.env.VIRTUS_DELTA_START_URL || "https://www.facebook.com/messages").trim();

  let running = true;
  const enqueue = createSerialQueue();
  const autoGreetingEnabled = String(process.env.VIRTUS_DELTA_AUTO_GREETING || "1").trim() === "1";
  const autoGreetingSentThreads = new Set(); // threadKey
  const autoGreetingTimers = new Map(); // threadKey -> Timeout
  const greetingStateByThread = new Map(); // threadKey -> { sentAt, greetingText, itemLink, city, citySource }
  let lastCrossThreadSendAt = 0;
  let lastCrossThreadKey = "";

  // ===================== Delivery Confirm (CT) =====================
  // Objetivo: após envio real (Enter/click) confirmar de forma durável no CT
  // para acender o "balão azul" / veredito final no dashboard.
  const DELIVERY_CONFIRM_DIR = path.join(__dirname, "..", "dados", "delta_delivery_confirm");
  const DELIVERY_CONFIRM_OUTBOX = path.join(DELIVERY_CONFIRM_DIR, "outbox.jsonl");
  const DELIVERY_CONFIRM_CURSOR = path.join(DELIVERY_CONFIRM_DIR, "cursor.json");
  const DELIVERY_CONFIRM_ACK_DIR = path.join(DELIVERY_CONFIRM_DIR, "acked");
  let _deliveryConfirmPumpInFlight = false;
  let _deliveryConfirmPumpBackoffMs = 450;

  function ensureDeliveryConfirmDirsSync() {
    try { fsSync.mkdirSync(DELIVERY_CONFIRM_DIR, { recursive: true }); } catch {}
    try { fsSync.mkdirSync(DELIVERY_CONFIRM_ACK_DIR, { recursive: true }); } catch {}
  }

  function readDeliveryConfirmCursorSync() {
    try {
      if (!fsSync.existsSync(DELIVERY_CONFIRM_CURSOR)) return { offset: 0 };
      const raw = String(fsSync.readFileSync(DELIVERY_CONFIRM_CURSOR, "utf8") || "").trim();
      if (!raw) return { offset: 0 };
      const j = JSON.parse(raw);
      return { offset: Math.max(0, Number(j && j.offset || 0) || 0) };
    } catch {
      return { offset: 0 };
    }
  }

  function writeDeliveryConfirmCursorSync(offset) {
    try {
      ensureDeliveryConfirmDirsSync();
      const tmp = DELIVERY_CONFIRM_CURSOR + ".tmp";
      fsSync.writeFileSync(tmp, JSON.stringify({ offset: Math.max(0, Number(offset || 0) || 0) }), "utf8");
      fsSync.renameSync(tmp, DELIVERY_CONFIRM_CURSOR);
      return true;
    } catch {
      return false;
    }
  }

  function ackFpForDeliveryConfirm(cmdId) {
    const safe = String(cmdId || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "cmd";
    return path.join(DELIVERY_CONFIRM_ACK_DIR, `ack_${safe}.json`);
  }

  function hasDeliveryConfirmAckSync(cmdId) {
    try { return fsSync.existsSync(ackFpForDeliveryConfirm(cmdId)); } catch { return false; }
  }

  function writeDeliveryConfirmAckSync(cmdId, patch = null) {
    try {
      ensureDeliveryConfirmDirsSync();
      const fp = ackFpForDeliveryConfirm(cmdId);
      const tmp = fp + ".tmp";
      fsSync.writeFileSync(tmp, JSON.stringify({
        ok: true,
        cmd_id: String(cmdId || "").trim() || null,
        acked_at: Date.now(),
        ...(patch && typeof patch === "object" ? patch : {})
      }), "utf8");
      fsSync.renameSync(tmp, fp);
      return true;
    } catch {
      return false;
    }
  }

  function resolveCtDeliveryConfirmUrl() {
    const envDirect = String(process.env.VIRTUS_DELTA_CT_DELIVERY_CONFIRM_URL || "").trim();
    if (envDirect) return envDirect;
    const base = String(process.env.CT_BASE_URL || process.env.CT_URL || "").trim();
    if (base) return `${base.replace(/\/+$/, "")}/api/attendance/confirm-delivery`;
    // Regra rígida: sem fallback para produção pública.
    // Se não houver URL explícita de ambiente, falha de forma visível (log forense),
    // mantendo o envio no Facebook desacoplado (fire-and-forget).
    return "";
  }

  function resolveCtDeliveryConfirmSecret() {
    // Header obrigatório: x-delivery-secret.
    // Preferir variáveis explícitas de delivery; permitir fallback para infra secret do CT/Edge
    // (o CT aceita CT_DELTA_DELIVERY_SECRET ou CT_DELTA_INFRA_SECRET).
    return String(
      process.env.VIRTUS_DELTA_DELIVERY_SECRET
      || process.env.CT_DELTA_DELIVERY_SECRET
      || process.env.CT_DELTA_INFRA_SECRET
      || process.env.VIRTUS_DELTA_INFRA_SECRET
      || ""
    ).trim();
  }

  async function postJsonWithTimeout(url, payload, { timeoutMs = 4500, headers = {} } = {}) {
    const u = String(url || "").trim();
    if (!u) return { ok: false, status: 0, error: "empty_url" };
    if (typeof fetch !== "function") return { ok: false, status: 0, error: "fetch_unavailable" };
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs || 4500) || 4500));
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(payload || {}),
        signal: controller.signal
      });
      const st = Number(res.status || 0) || 0;
      if (res.ok) return { ok: true, status: st };
      return { ok: false, status: st, error: `http_${st || 0}` };
    } catch (e) {
      return { ok: false, status: 0, error: (e && e.message) ? String(e.message) : String(e) };
    } finally {
      clearTimeout(to);
    }
  }

  function computeFallbackClientMessageId({ account_login, thread_key, texto_resposta } = {}) {
    try {
      const base = JSON.stringify({
        account_login: String(account_login || "").trim(),
        thread_key: String(thread_key || "").trim(),
        texto_resposta: String(texto_resposta || "").replace(/\r/g, "")
      });
      return crypto.createHash("sha1").update(base, "utf8").digest("hex");
    } catch {
      return crypto.randomBytes(12).toString("hex");
    }
  }

  function resolveCtReverseDeliveryStatusUrl() {
    try {
      const confirmUrl = String(resolveCtDeliveryConfirmUrl() || "").trim();
      if (!confirmUrl) return "";
      // Troca apenas o sufixo do endpoint.
      if (/\/api\/attendance\/confirm-delivery\/?$/i.test(confirmUrl)) {
        return confirmUrl.replace(/\/api\/attendance\/confirm-delivery\/?$/i, "/api/attendance/reverse-delivery-status");
      }
      // Fallback seguro: mesma base + endpoint.
      try {
        const u = new URL(confirmUrl);
        return `${u.protocol}//${u.host}/api/attendance/reverse-delivery-status`;
      } catch {
        return "";
      }
    } catch {
      return "";
    }
  }

  function kickReverseDeliveryStatus({ client_message_id, thread_key, status, error } = {}) {
    try {
      const cid = String(client_message_id || "").trim();
      if (!cid) return;
      const url = resolveCtReverseDeliveryStatusUrl();
      const sec = resolveCtDeliveryConfirmSecret();
      if (!url || !sec) return;
      const payload = {
        server_id: SERVER_ID,
        account_login: ACCOUNT_LOGIN,
        thread_key: String(thread_key || "").trim() || null,
        client_message_id: cid,
        status: String(status || "error_failed_to_send").trim() || "error_failed_to_send",
        error: String(error || "").slice(0, 500) || null,
      };
      const headers = { "x-delivery-secret": sec };
      try {
        setTimeout(() => {
          (async () => {
            try {
              __forensicEdgeEmit({
                account_login: ACCOUNT_LOGIN,
                thread_key: payload.thread_key,
                flow_stage: "reverse_delivery_post_attempt",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  url,
                  client_message_id: cid,
                  status: payload.status,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
            const r = await postJsonWithTimeout(url, payload, { timeoutMs: 4500, headers }).catch((e) => ({
              ok: false,
              status: 0,
              error: (e && e.message) ? String(e.message) : String(e),
            }));
            if (r && r.ok) {
              try {
                __forensicEdgeEmit({
                  account_login: ACCOUNT_LOGIN,
                  thread_key: payload.thread_key,
                  flow_stage: "reverse_delivery_post_ok",
                  details: {
                    tag: "FORENSIC_DOM_REVERSE",
                    url,
                    http_status: Number(r.status || 0) || 0,
                    client_message_id: cid,
                    ts_ms: Date.now(),
                  }
                });
              } catch (_) {}
              return;
            }
            try {
              __forensicEdgeEmit({
                account_login: ACCOUNT_LOGIN,
                thread_key: payload.thread_key,
                flow_stage: "reverse_delivery_fail",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  message: `[FORENSIC_REVERSE_FAIL] url: ${url} status: ${Number(r && r.status || 0) || 0} error: ${String((r && r.error) || "reverse_failed")}`,
                  url,
                  status: Number(r && r.status || 0) || 0,
                  error: String((r && r.error) || "reverse_failed"),
                  client_message_id: cid,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
          })().catch(() => {});
        }, 0).unref?.();
      } catch (_) {}
    } catch (_) {}
  }

  function enqueueDeliveryConfirmToDiskSync({ cmdId, thread_key, status } = {}) {
    ensureDeliveryConfirmDirsSync();
    const cid = String(cmdId || "").trim() || crypto.randomBytes(12).toString("hex");
    const rec = {
      ts: Date.now(),
      id: cid,
      server_id: SERVER_ID,
      account_login: ACCOUNT_LOGIN,
      thread_key: String(thread_key || "").trim(),
      status: String(status || "").trim() || "sent_to_facebook"
    };
    try { fsSync.appendFileSync(DELIVERY_CONFIRM_OUTBOX, JSON.stringify(rec) + "\n", "utf8"); } catch {}
    try {
      __forensicEdgeEmit({
        account_login: ACCOUNT_LOGIN,
        thread_key: String(thread_key || "").trim() || null,
        flow_stage: "reverse_command_bus",
        details: { stage: "delivery_confirm_enqueued", client_message_id: cid, status: rec.status }
      });
    } catch (_) {}
    return cid;
  }

  function kickDeliveryConfirmPump() {
    try { setTimeout(() => { runDeliveryConfirmPump().catch(() => {}); }, 0).unref?.(); } catch {}
  }

  async function runDeliveryConfirmPump() {
    if (_deliveryConfirmPumpInFlight) return;
    _deliveryConfirmPumpInFlight = true;
    try {
      ensureDeliveryConfirmDirsSync();
      let url = resolveCtDeliveryConfirmUrl();
      const sec = resolveCtDeliveryConfirmSecret();

      // Pré-condições (fail-fast, sem falha muda)
      if (!url) {
        try {
          __forensicEdgeEmit({
            account_login: ACCOUNT_LOGIN,
            thread_key: null,
            flow_stage: "confirm_delivery_fail",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              message: "[FORENSIC_CONFIRM_FAIL] url: (empty) status: 0 error: confirm_url_missing",
              url: "",
              status: 0,
              error: "confirm_url_missing",
              ts_ms: Date.now(),
            }
          });
        } catch (_) {}
        _deliveryConfirmPumpBackoffMs = Math.min(60_000, Math.max(1500, Math.floor(_deliveryConfirmPumpBackoffMs * 1.7)));
        try { setTimeout(() => kickDeliveryConfirmPump(), _deliveryConfirmPumpBackoffMs).unref?.(); } catch {}
        return;
      }
      if (!sec) {
        try {
          __forensicEdgeEmit({
            account_login: ACCOUNT_LOGIN,
            thread_key: null,
            flow_stage: "confirm_delivery_fail",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              message: `[FORENSIC_CONFIRM_FAIL] url: ${url} status: 0 error: delivery_secret_missing`,
              url,
              status: 0,
              error: "delivery_secret_missing",
              ts_ms: Date.now(),
            }
          });
        } catch (_) {}
        _deliveryConfirmPumpBackoffMs = Math.min(60_000, Math.max(1500, Math.floor(_deliveryConfirmPumpBackoffMs * 1.7)));
        try { setTimeout(() => kickDeliveryConfirmPump(), _deliveryConfirmPumpBackoffMs).unref?.(); } catch {}
        return;
      }

      function __deriveCtConfirmUrlFromServerId(serverId) {
        try {
          const sid = String(serverId || "").trim();
          if (!sid) return "";
          // Heurística segura: em RM6, server_id é o subdomínio do ambiente ativo.
          // Ex.: https://<server_id>.convenientetecnologia.com
          return `https://${sid}.convenientetecnologia.com/api/attendance/confirm-delivery`;
        } catch {
          return "";
        }
      }
      function __isPermanentConfirmError(r) {
        try {
          const st = Number(r && r.status || 0) || 0;
          if (st === 400 || st === 401 || st === 403 || st === 404) return true;
          return false;
        } catch {
          return false;
        }
      }

      while (true) {
        if (!fsSync.existsSync(DELIVERY_CONFIRM_OUTBOX)) break;
        const cur = readDeliveryConfirmCursorSync();
        const off = Math.max(0, Number(cur && cur.offset || 0) || 0);

        let fd = null;
        try {
          fd = fsSync.openSync(DELIVERY_CONFIRM_OUTBOX, "r");
          const st = fsSync.fstatSync(fd);
          const size = Number(st && st.size || 0) || 0;
          if (off >= size) break;
          const maxChunk = 64 * 1024;
          const toRead = Math.min(maxChunk, size - off);
          const buf = Buffer.allocUnsafe(toRead);
          const bytes = fsSync.readSync(fd, buf, 0, toRead, off);
          const txt = buf.slice(0, bytes).toString("utf8");
          const nl = txt.indexOf("\n");
          if (nl === -1) break;
          const line = txt.slice(0, nl).trim();
          const nextOff = off + Buffer.byteLength(txt.slice(0, nl + 1), "utf8");
          if (!line) { writeDeliveryConfirmCursorSync(nextOff); continue; }

          let rec = null;
          try { rec = JSON.parse(line); } catch { rec = null; }
          if (!rec) { writeDeliveryConfirmCursorSync(nextOff); continue; }
          const cmdId = String(rec.id || "").trim();
          if (!cmdId) { writeDeliveryConfirmCursorSync(nextOff); continue; }
          if (hasDeliveryConfirmAckSync(cmdId)) { writeDeliveryConfirmCursorSync(nextOff); continue; }

          const payload = {
            server_id: String(rec.server_id || SERVER_ID || "").trim(),
            account_login: String(rec.account_login || ACCOUNT_LOGIN || "").trim(),
            thread_key: String(rec.thread_key || "").trim(),
            status: String(rec.status || "sent_to_facebook").trim(),
            // Extra para correlação sem ambiguidades (best-effort).
            client_message_id: cmdId
          };
          const headers = sec ? { "x-delivery-secret": sec } : {};
          try {
            try {
              __forensicEdgeEmit({
                account_login: payload.account_login || ACCOUNT_LOGIN || null,
                thread_key: payload.thread_key || null,
                flow_stage: "confirm_delivery_post_attempt",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  url,
                  status: payload.status,
                  client_message_id: cmdId,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
          } catch (_) {}

          let r = null;
          try {
            r = await postJsonWithTimeout(url, payload, { timeoutMs: 4500, headers });
          } catch (e) {
            r = { ok: false, status: 0, error: (e && e.message) ? String(e.message) : String(e) };
          }

          if (r && r.ok) {
            writeDeliveryConfirmAckSync(cmdId, { status: r.status, url });
            writeDeliveryConfirmCursorSync(nextOff);
            _deliveryConfirmPumpBackoffMs = 450;
            try {
              __forensicEdgeEmit({
                account_login: payload.account_login || ACCOUNT_LOGIN || null,
                thread_key: payload.thread_key || null,
                flow_stage: "confirm_delivery_post_ok",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  url,
                  http_status: Number(r.status || 0) || 0,
                  client_message_id: cmdId,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
            continue;
          }

          // Auto-cura de roteamento (caso clássico: url aponta para api.* e retorna 404)
          // Tenta uma única vez o endpoint do CT local (subdomínio do server_id) antes de dead-letter.
          try {
            const stTry = Number(r && r.status || 0) || 0;
            const is404 = stTry === 404 || String(r && r.error || "").includes("http_404");
            const looksLikeApi = /:\/\/api\.convenientetecnologia\.com\/?/i.test(String(url || ""));
            if (is404 && looksLikeApi) {
              const alt = __deriveCtConfirmUrlFromServerId(payload && payload.server_id);
              if (alt && alt !== url) {
                const prevUrl = String(url || "");
                try {
                  __forensicEdgeEmit({
                    account_login: payload.account_login || ACCOUNT_LOGIN || null,
                    thread_key: payload.thread_key || null,
                    flow_stage: "confirm_delivery_reroute_attempt",
                    details: {
                      tag: "FORENSIC_DOM_REVERSE",
                      from_url: prevUrl,
                      to_url: alt,
                      client_message_id: cmdId,
                      ts_ms: Date.now(),
                    }
                  });
                } catch (_) {}
                const r2 = await postJsonWithTimeout(alt, payload, { timeoutMs: 4500, headers }).catch((e) => ({
                  ok: false,
                  status: 0,
                  error: (e && e.message) ? String(e.message) : String(e),
                }));
                if (r2 && r2.ok) {
                  url = alt; // fixa para o restante do pump
                  writeDeliveryConfirmAckSync(cmdId, { status: r2.status, url: alt, rerouted_from: prevUrl });
                  writeDeliveryConfirmCursorSync(nextOff);
                  _deliveryConfirmPumpBackoffMs = 450;
                  try {
                    __forensicEdgeEmit({
                      account_login: payload.account_login || ACCOUNT_LOGIN || null,
                      thread_key: payload.thread_key || null,
                      flow_stage: "confirm_delivery_post_ok",
                      details: {
                        tag: "FORENSIC_DOM_REVERSE",
                        url: alt,
                        http_status: Number(r2.status || 0) || 0,
                        client_message_id: cmdId,
                        ts_ms: Date.now(),
                        rerouted: true,
                      }
                    });
                  } catch (_) {}
                  continue;
                }
              }
            }
          } catch (_) {}

          try {
            const st0 = Number(r && r.status || 0) || 0;
            const err0 = String((r && r.error) || "confirm_delivery_failed");
            __forensicEdgeEmit({
              account_login: payload.account_login || ACCOUNT_LOGIN || null,
              thread_key: payload.thread_key || null,
              flow_stage: "confirm_delivery_fail",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                message: `[FORENSIC_CONFIRM_FAIL] url: ${url} status: ${st0} error: ${err0}`,
                url,
                status: st0,
                error: err0,
                client_message_id: cmdId,
                ts_ms: Date.now(),
              }
            });
          } catch (_) {}

          // Dead-letter guard (sem piedade): erros permanentes não podem congelar a fila.
          // Avança cursor imediatamente e segue para o próximo registro.
          if (__isPermanentConfirmError(r)) {
            try {
              writeDeliveryConfirmAckSync(cmdId, {
                dead_letter: true,
                url,
                http_status: Number(r && r.status || 0) || 0,
                error: String((r && r.error) || "permanent_error"),
              });
            } catch (_) {}
            try {
              __forensicEdgeEmit({
                account_login: payload.account_login || ACCOUNT_LOGIN || null,
                thread_key: payload.thread_key || null,
                flow_stage: "confirm_delivery_dead_letter",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  url,
                  http_status: Number(r && r.status || 0) || 0,
                  error: String((r && r.error) || "permanent_error"),
                  client_message_id: cmdId,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
            writeDeliveryConfirmCursorSync(nextOff);
            _deliveryConfirmPumpBackoffMs = 450;
            continue;
          }

          _deliveryConfirmPumpBackoffMs = Math.min(60_000, Math.max(800, Math.floor(_deliveryConfirmPumpBackoffMs * 1.7)));
          try { setTimeout(() => kickDeliveryConfirmPump(), _deliveryConfirmPumpBackoffMs).unref?.(); } catch {}
          break;
        } finally {
          try { if (fd) fsSync.closeSync(fd); } catch {}
        }
      }
    } finally {
      _deliveryConfirmPumpInFlight = false;
    }
  }

  function epochOk() {
    try {
      if (browser && browser._fenceEpochMap && typeof browser._fenceEpochMap[nome] !== "undefined") {
        return browser._fenceEpochMap[nome] === requiredEpoch;
      }
      return true;
    } catch {
      return false;
    }
  }

  const pages = await browser.pages().catch(() => []);
  const page = pages[restrictTab] || pages[0] || (await browser.newPage());
  attachDeltaNavigationFirewall(page, { profileName: ACCOUNT_LOGIN || nome });

  // Boot minimal: garantir que estamos em /messages (permitido no boot; proibição é no reply flow).
  try {
    const u0 = String(page.url ? page.url() : "");
    if (!/facebook\.com\/messages/i.test(u0)) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
  } catch (_) {}
  try {
    await waitForMessagesBootStable(page, "messages_ready_worker");
  } catch (_) {}
  if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED) {
    try {
      const mpBoot = await ensureMarketplaceFilterActive(page);
      logInfo(`[virtusDelta][boot][worker] marketplace_boot=${JSON.stringify(mpBoot)}`);
    } catch (e) {
      logInfo(
        `[virtusDelta][boot][worker] marketplace_boot_fail err=${e && e.message ? e.message : String(e)}`
      );
    }
  } else {
    logInfo("[virtusDelta][boot][worker] marketplace_boot=skipped reason=autofilter_disabled");
  }

  logInfo(`[virtusDelta][boot][worker] nome=${String(nome || "")} engine=delta epoch=${requiredEpoch} slowMode=${slowMode ? "sim" : "nao"} url=${String(page.url ? page.url() : "")}`);

  // FUSÃO OPERACIONAL (FASE 1):
  // Este runtime NÃO possui mais o "Ouvido" (CDP Network.webSocketFrameReceived).
  // A escuta de rede + fila/ingest stateless são responsabilidade exclusiva do `worker.js`.

  let cityCache = { at: 0, value: null };
  let cityTimer = null;
  const marketplaceEnforcer = startMarketplacePresenceEnforcer(page, { scope: `worker:${String(nome || "")}` });
  const updateCityCache = async () => {
    try {
      if (!running || !epochOk()) return;
      const v = await extractCityFromMarketplaceDom(page);
      if (v) cityCache = { at: Date.now(), value: v };
    } catch {}
  };
  try {
    await updateCityCache();
    cityTimer = setInterval(() => updateCityCache().catch(() => {}), Math.max(10_000, Number(process.env.VIRTUS_DELTA_CITY_CACHE_MS || 30_000) || 30_000));
    cityTimer.unref?.();
  } catch {}

  function deltaCooldownKey(accountLogin) {
    const key = String(accountLogin || ACCOUNT_LOGIN || nome || "").trim().toLowerCase();
    return key || "__unknown_account__";
  }
  function readLastDeltaSendTimestamp(accountLogin) {
    try {
      const bag = global.__deltaLastSendTsByAccount;
      if (!bag || typeof bag !== "object") return 0;
      const k = deltaCooldownKey(accountLogin);
      return Number(bag[k] || 0) || 0;
    } catch {
      return 0;
    }
  }
  function writeLastDeltaSendTimestamp(accountLogin, ts) {
    try {
      if (!global.__deltaLastSendTsByAccount || typeof global.__deltaLastSendTsByAccount !== "object") {
        global.__deltaLastSendTsByAccount = Object.create(null);
      }
      const k = deltaCooldownKey(accountLogin);
      global.__deltaLastSendTsByAccount[k] = Number(ts || Date.now()) || Date.now();
    } catch (_) {}
  }

  async function enforceGlobalDeltaCooldown(accountLogin = ACCOUNT_LOGIN) {
    const minMs = 5_000;
    const maxMs = 15_000;
    const delayMs = randomBetween(minMs, maxMs);
    const last = readLastDeltaSendTimestamp(accountLogin);
    const now = Date.now();
    const elapsed = now - last;
    if (!last || elapsed >= delayMs) return { waitedMs: 0, delayMs, elapsedMs: elapsed };

    const remainMs = Math.max(0, delayMs - elapsed);
    const endAt = now + remainMs;
    try {
      __forensicEdgeEmit({
        account_login: String(accountLogin || ACCOUNT_LOGIN || "").trim() || null,
        thread_key: null,
        flow_stage: "cooldown_execution_wait",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          phase: "begin",
          account_login: String(accountLogin || ACCOUNT_LOGIN || "").trim() || null,
          min_ms: minMs,
          max_ms: maxMs,
          delay_ms: delayMs,
          last_send_ts: last || 0,
          enter_ts: now,
          elapsed_ms: elapsed,
          remain_ms: remainMs,
          end_at_ts: endAt,
        }
      });
    } catch (_) {}

    let lastLoggedSec = null;
    while (true) {
      const leftMs = endAt - Date.now();
      if (leftMs <= 0) break;
      const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
      if (leftSec !== lastLoggedSec) {
        lastLoggedSec = leftSec;
        logInfo(`⏳ [DELTA_TIMER] Conta em cooldown. Pronto para o próximo envio em ${leftSec} segundos...`);
      }
      await sleep(Math.min(1000, leftMs));
    }
    try {
      __forensicEdgeEmit({
        account_login: String(accountLogin || ACCOUNT_LOGIN || "").trim() || null,
        thread_key: null,
        flow_stage: "cooldown_execution_wait",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          phase: "end",
          account_login: String(accountLogin || ACCOUNT_LOGIN || "").trim() || null,
          delay_ms: delayMs,
          last_send_ts: last || 0,
          enter_ts: now,
          exit_ts: Date.now(),
          waited_ms: remainMs,
        }
      });
    } catch (_) {}
    return { waitedMs: remainMs, delayMs, elapsedMs: elapsed };
  }

  async function sendDeltaReplyNow({ threadKey, textoResposta, clientMessageId = null }) {
    if (!running || !epochOk()) return { ok: false, error: "delta_runtime_not_ready" };
    const t = String(threadKey || "").trim();
    const msg = String(textoResposta || "").replace(/\r/g, "");
    const cmid = String(clientMessageId || "").trim() || null;
    if (!t || !msg) return { ok: false, error: "missing_thread_key_or_texto_resposta" };

    // Relógio Sentinela por conta (5–15s), isolado por ACCOUNT_LOGIN.
    await enforceGlobalDeltaCooldown(ACCOUNT_LOGIN);

    const maxRetries = 3; // 3 retries locais rápidos além da tentativa inicial
    let lastOut = null;
    let lastErr = "delta_reply_unknown_error";

    for (let attempt = 1; attempt <= (maxRetries + 1); attempt++) {
      if (attempt > 1) {
        const retryWaitMs = randomBetween(3_000, 5_000);
        logInfo(
          `[virtusDelta][reply] retry_visual attempt=${attempt - 1}/${maxRetries} thread_key=${t} wait_ms=${retryWaitMs}`
        );
        await sleep(retryWaitMs);
      }

      try {
        const r = await sendReplyFlow({ page, threadKey: t, textoResposta: msg, fromNetworkLead: false, forensicAccountLogin: ACCOUNT_LOGIN });
        lastOut = r && typeof r === "object" ? r : { ok: true };
        if (lastOut && lastOut.ok) {
          const nowTs = Date.now();
          writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
          lastCrossThreadKey = String(t);
          lastCrossThreadSendAt = nowTs;
          // Confirmação durável (best-effort + outbox local): acende veredito final no CT.
          try {
            const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: t, texto_resposta: msg });
            enqueueDeliveryConfirmToDiskSync({ cmdId: cid, thread_key: t, status: "sent_to_facebook" });
            kickDeliveryConfirmPump();
          } catch (_) {}
          return lastOut;
        }
        lastErr = String((lastOut && lastOut.error) || "send_reply_flow_failed");
      } catch (e) {
        lastErr = e && e.message ? String(e.message) : String(e);
        lastOut = { ok: false, error: lastErr };
      }
    }

    return {
      ok: false,
      error: String(lastErr || "send_reply_failed_after_retries"),
      retries: maxRetries,
      attempts: maxRetries + 1,
      last_result: lastOut && typeof lastOut === "object" ? lastOut : null,
    };
  }

  async function sendDeltaGreetingNow({ threadKey, mensagensCliente }) {
    if (!running || !epochOk()) return { ok: false, error: "delta_runtime_not_ready" };
    const t = String(threadKey || "").trim();
    if (!t) return { ok: false, error: "missing_thread_key" };

    const mensagensConcatenadas = String(mensagensCliente || "").replace(/\r/g, "").trim();

    // Mantém o mesmo sentinela global para evitar padrões robóticos.
    await enforceGlobalDeltaCooldown(ACCOUNT_LOGIN);

    const prior = greetingStateByThread.get(t) || null;
    const greetingAlreadySent = !!(prior && prior.sentAt);
    const greetingText = String((prior && prior.greetingText) || generateDeltaGreeting() || "").trim();

    let itemLinkResolved = false;
    let itemLinkResolver = null;
    const itemLinkPromise = new Promise((resolve) => {
      itemLinkResolver = resolve;
    });
    const resolveItemLink = (link) => {
      if (itemLinkResolved) return;
      itemLinkResolved = true;
      itemLinkResolver(String(link || "").trim() || null);
    };

    const cityCollectionPromise = (async () => {
      const preferredLink = String((prior && prior.itemLink) || "").trim() || null;
      const itemLink = preferredLink || (await itemLinkPromise);
      if (!itemLink) return { ok: false, error: "item_link_missing" };
      return await collectCityFromItemLinkUsingGlobalCollector({
        itemLink,
        threadKey: t,
        accountLogin: ACCOUNT_LOGIN,
      });
    })();

    let sendOut = null;
    if (!greetingAlreadySent) {
      sendOut = await sendReplyFlow({
        page,
        threadKey: t,
        textoResposta: greetingText,
        fromNetworkLead: true,
        onItemLink: (link) => resolveItemLink(link),
      });
      if (sendOut && sendOut.item_link) {
        resolveItemLink(sendOut.item_link);
      } else {
        resolveItemLink(null);
      }
      if (!sendOut || !sendOut.ok) {
        return {
          ok: false,
          error: String((sendOut && sendOut.error) || "hands_send_failed"),
        };
      }
    } else {
      // Retry de cidade não reenvia saudação: somente reabre o thread para recuperar link, se necessário.
      if (!(prior && prior.itemLink)) {
        const openOut = await openThreadAndExtractItemLink(page, t, { fromNetworkLead: true });
        if (openOut && openOut.ok && openOut.item_link) {
          resolveItemLink(openOut.item_link);
        } else {
          resolveItemLink(null);
        }
      } else {
        resolveItemLink(prior.itemLink);
      }
      sendOut = { ok: true, item_link: (prior && prior.itemLink) || null };
    }

    const cityOut = await cityCollectionPromise;
    if (!cityOut || cityOut.ok !== true || !String(cityOut.cidade || "").trim()) {
      const itemLinkToKeep = String(
        (sendOut && sendOut.item_link) ||
        (prior && prior.itemLink) ||
        ""
      ).trim() || null;
      greetingStateByThread.set(t, {
        sentAt: Number((prior && prior.sentAt) || Date.now()),
        greetingText,
        itemLink: itemLinkToKeep,
        city: null,
        citySource: null,
      });
      return {
        ok: false,
        error: String((cityOut && cityOut.error) || "city_collect_failed"),
        greeting_already_sent: true,
        greeting_text: greetingText,
      };
    }

    const cityCandidate = String(cityOut.cidade || "").trim();
    const citySource = String(cityOut.city_source || "collector_listing_page").trim();
    const itemLinkFinal = String(
      (sendOut && sendOut.item_link) ||
      (prior && prior.itemLink) ||
      ""
    ).trim() || null;

    greetingStateByThread.set(t, {
      sentAt: Number((prior && prior.sentAt) || Date.now()),
      greetingText,
      itemLink: itemLinkFinal,
      city: cityCandidate,
      citySource,
    });
    try {
      __forensicEdgeEmit({
        account_login: ACCOUNT_LOGIN,
        thread_key: t,
        flow_stage: "dom_automation_tracking",
        details: {
          action: "city_collected",
          city_clean: cityCandidate,
          city_source: citySource,
          item_link: itemLinkFinal
        }
      });
    } catch (_) {}

    let profileUrl = null;
    try {
      const u = String(page && page.url ? page.url() : "").trim();
      if (u) profileUrl = u;
    } catch (_) {}
    let nomeClienteLimpo = null;
    try {
      nomeClienteLimpo = await extractLeadClientNameFromFeedDom(page);
    } catch (_) {}
    try {
      __forensicEdgeEmit({
        account_login: ACCOUNT_LOGIN,
        thread_key: t,
        flow_stage: "dom_automation_tracking",
        details: {
          action: "lead_name_extracted",
          name_clean: nomeClienteLimpo || null
        }
      });
    } catch (_) {}

    const nowTs = Date.now();
    writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
    lastCrossThreadKey = String(t);
    lastCrossThreadSendAt = nowTs;

    return {
      ok: true,
      cidade: cityCandidate || null,
      city_source: citySource,
      profile_url: profileUrl,
      greeting_text: greetingText,
      mensagens_cliente: mensagensConcatenadas,
      nome_cliente_limpo: nomeClienteLimpo,
      customer_name: nomeClienteLimpo,
    };
  }

  const enqueueDeltaReply = ({ thread_key, texto_resposta, client_message_id, _requeue_count = 0 } = {}) => {
    return enqueue(async () => {
      try {
        const tk = String(thread_key || "").trim();
        const tr = String(texto_resposta || "").replace(/\r/g, "");
        const cmid = String(client_message_id || "").trim() || null;
        const out = await sendDeltaReplyNow({ threadKey: tk, textoResposta: tr, clientMessageId: cmid });

        // Estratégia "fila sem travar": se for erro típico de seletor/DOM, re-enfileira no fim
        // (sem dormir aqui), para não segurar a fila em retries longos.
        try {
          const ok = !!(out && out.ok);
          const err = String(out && out.error || "").trim();
          const isSelectorLike =
            err === "composer_missing" ||
            err === "thread_card_not_found" ||
            err === "send_not_confirmed_composer_not_empty" ||
            err === "composer_text_not_registered";
          const tries = Math.max(0, Number(_requeue_count || 0) || 0);
          if (!ok && isSelectorLike && tries < 2) {
            const nextCount = tries + 1;
            const delayMs = randomBetween(1200, 2400);
            try {
              __forensicEdgeEmit({
                account_login: ACCOUNT_LOGIN,
                thread_key: tk || null,
                flow_stage: "delta_reply_selector_requeued",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  error: err,
                  requeue_in_ms: delayMs,
                  requeue_attempt: nextCount,
                  client_message_id: cmid,
                  ts_ms: Date.now(),
                }
              });
            } catch (_) {}
            try {
              setTimeout(() => {
                enqueueDeltaReply({ thread_key: tk, texto_resposta: tr, client_message_id: cmid, _requeue_count: nextCount })
                  .catch(() => {});
              }, delayMs).unref?.();
            } catch (_) {}
          }
        } catch (_) {}

        // Protocolo de reversão de ACK: após exaurir tentativas locais, marca falha no CT (visível na tela).
        try {
          const ok = !!(out && out.ok);
          if (!ok) {
            const err = String(out && out.error || "").trim() || "send_failed";
            const isSelectorLike =
              err === "composer_missing" ||
              err === "thread_card_not_found" ||
              err === "send_not_confirmed_composer_not_empty" ||
              err === "composer_text_not_registered";
            const tries = Math.max(0, Number(_requeue_count || 0) || 0);
            const exhausted = isSelectorLike ? (tries >= 2) : true;
            if (exhausted) {
              const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: tk, texto_resposta: tr });
              kickReverseDeliveryStatus({ client_message_id: cid, thread_key: tk, status: "error_failed_to_send", error: err });
            }
          }
        } catch (_) {}

        return out;
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    });
  };

  const enqueueDeltaGreetingFlow = ({ thread_key, mensagens_cliente }) => {
    return enqueue(async () => {
      try {
        return await sendDeltaGreetingNow({
          threadKey: thread_key,
          mensagensCliente: mensagens_cliente,
        });
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    });
  };

  return {
    ok: true,
    engine: "delta",
    server_id: SERVER_ID,
    account_login: ACCOUNT_LOGIN,
    page,
    getQueueDepth: () => {
      try { return (typeof enqueue.getDepth === "function") ? enqueue.getDepth() : null; } catch (_) { return null; }
    },
    getQueueMaxDepth: () => {
      try { return (typeof enqueue.getMaxDepth === "function") ? enqueue.getMaxDepth() : null; } catch (_) { return null; }
    },
    enqueueDeltaReply,
    enqueueDeltaGreetingFlow,
    stop: async () => {
      running = false;
      try { marketplaceEnforcer.stop(); } catch (_) {}
      try { if (cityTimer) clearInterval(cityTimer); } catch (_) {}
      try {
        for (const t of autoGreetingTimers.values()) { try { clearTimeout(t); } catch (_) {} }
        autoGreetingTimers.clear();
      } catch (_) {}
    },
  };
}

async function startVirtusDeltaRuntime() {
  // Overload:
  // - (browser, nome, cfg) => runtime acoplado ao worker (retorna { stop() })
  // - ({...opts})         => runtime standalone (retorna { shutdown() })
  const a0 = arguments[0];
  const a1 = arguments[1];
  const a2 = arguments[2];
  const looksLikeBrowser = a0 && typeof a0.pages === "function";
  if (looksLikeBrowser) return await startVirtusDeltaWorkerRuntime(a0, a1, a2 || {});
  return await startVirtusDeltaStandaloneRuntime((a0 && typeof a0 === "object") ? a0 : {});
}

module.exports = {
  startVirtusDeltaRuntime,
  startVirtusDeltaStandaloneRuntime,
  startVirtusDeltaWorkerRuntime,
  killGhostChromeForProfile,
  killGhostVirtusDeltaProcesses,
  generateDeltaGreeting,
  extractCityFromMarketplaceDom,
  prepareDomForNetworkLead,
  forceSidebarRefreshByMessagesRoot,
  ensureMarketplaceFilterActive,
  isMarketplaceFilterActive,
  HUMAN_TIMINGS,
  humanPause,
};

if (require.main === module) {
  startVirtusDeltaStandaloneRuntime()
    .then((r) => {
      if (!r || r.ok !== true) process.exit(1);
      process.on("SIGINT", () => r.shutdown().finally(() => process.exit(0)));
      process.on("SIGTERM", () => r.shutdown().finally(() => process.exit(0)));
    })
    .catch((e) => {
      console.error("[virtusDelta][fatal]", e && e.stack ? e.stack : e);
      process.exit(1);
    });
}

