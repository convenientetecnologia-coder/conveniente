const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");

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

const LOG_LEVEL = String(process.env.FB_LOG_LEVEL || "info").trim().toLowerCase();

function logInfo(...args) {
  if (LOG_LEVEL === "silent") return;
  console.log(...args);
}

function logDebug(...args) {
  if (LOG_LEVEL === "debug") console.log(...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================
// DELTA: Fila em disco (JSONL) + loop HTTP stateless (sem WebSocket)
// =========================

const DELTA_QUEUE_PATH = path.join(__dirname, "..", "dados", "mensagens_pendentes.jsonl");
const DELTA_CURSOR_PATH = path.join(__dirname, "..", "dados", "mensagens_pendentes.cursor.json");
const DELTA_COMPACT_LOCK_PATH = path.join(__dirname, "..", "dados", "mensagens_pendentes.compact.lock");

function safeJsonParse(str) {
  try {
    return JSON.parse(String(str || ""));
  } catch {
    return null;
  }
}

function readCursorOffsetSync() {
  try {
    if (!fsSync.existsSync(DELTA_CURSOR_PATH)) return 0;
    const raw = String(fsSync.readFileSync(DELTA_CURSOR_PATH, "utf8") || "").trim();
    const parsed = safeJsonParse(raw) || {};
    const off = Number(parsed.byteOffset || 0) || 0;
    return off >= 0 ? off : 0;
  } catch {
    return 0;
  }
}

function writeCursorOffsetSync(byteOffset) {
  const off = Math.max(0, Number(byteOffset || 0) || 0);
  const tmp = `${DELTA_CURSOR_PATH}.tmp`;
  try {
    fsSync.mkdirSync(path.dirname(DELTA_CURSOR_PATH), { recursive: true });
  } catch (_) {}
  fsSync.writeFileSync(tmp, JSON.stringify({ byteOffset: off, updatedAt: Date.now() }) + "\n", "utf8");
  fsSync.renameSync(tmp, DELTA_CURSOR_PATH);
}

function computeIdempotencyKey(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const base = [
    String(p.server_id || ""),
    String(p.account_login || ""),
    String(p.thread_key || ""),
    String(p.texto_limpo || ""),
    String(p.operacao_meta || p.operation || ""),
  ].join("|");
  return crypto.createHash("sha1").update(base).digest("hex");
}

function appendPendingJsonlSync(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  const line = JSON.stringify({
    ts: Date.now(),
    event: "lead_capturado",
    idempotency_key: computeIdempotencyKey(p),
    ...p,
  });
  try {
    fsSync.mkdirSync(path.dirname(DELTA_QUEUE_PATH), { recursive: true });
  } catch (_) {}
  fsSync.appendFileSync(DELTA_QUEUE_PATH, line + "\n", "utf8");
  // RAM free: desreferenciar e (se possível) sugerir GC.
  try {
    // eslint-disable-next-line no-global-assign
    payload = null;
  } catch (_) {}
  try {
    if (typeof global.gc === "function") global.gc();
  } catch (_) {}
}

function readNextJsonlLineByOffsetSync(filePath, offsetBytes, { chunkBytes = 64 * 1024, maxLineBytes = 2 * 1024 * 1024 } = {}) {
  const off = Math.max(0, Number(offsetBytes || 0) || 0);
  if (!fsSync.existsSync(filePath)) return { ok: true, eof: true, offset: off };
  const stat = fsSync.statSync(filePath);
  const size = Number(stat.size || 0) || 0;
  if (off >= size) return { ok: true, eof: true, offset: off };

  const fd = fsSync.openSync(filePath, "r");
  try {
    let cursor = off;
    let acc = Buffer.alloc(0);
    let foundNl = -1;
    while (cursor < size) {
      const remain = size - cursor;
      const toRead = Math.max(1, Math.min(remain, chunkBytes));
      const buf = Buffer.allocUnsafe(toRead);
      const n = fsSync.readSync(fd, buf, 0, toRead, cursor);
      if (!n) break;
      const slice = buf.subarray(0, n);
      acc = Buffer.concat([acc, slice], acc.length + slice.length);
      if (acc.length > maxLineBytes) return { ok: false, error: "line_too_large", offset: off };
      foundNl = acc.indexOf(0x0a); // \n
      if (foundNl >= 0) break;
      cursor += n;
    }

    if (foundNl < 0) {
      // última linha sem newline
      const line = acc.toString("utf8").replace(/\r$/, "");
      return { ok: true, eof: false, line, nextOffset: size, offset: off, newline: false };
    }

    const lineBuf = acc.subarray(0, foundNl);
    const line = lineBuf.toString("utf8").replace(/\r$/, "");
    const nextOffset = off + foundNl + 1;
    return { ok: true, eof: false, line, nextOffset, offset: off, newline: true };
  } finally {
    try { fsSync.closeSync(fd); } catch (_) {}
  }
}

function tryAcquireCompactLock() {
  try {
    const fd = fsSync.openSync(DELTA_COMPACT_LOCK_PATH, "wx");
    try { fsSync.writeFileSync(fd, String(Date.now()), "utf8"); } catch (_) {}
    try { fsSync.closeSync(fd); } catch (_) {}
    return true;
  } catch {
    return false;
  }
}

function releaseCompactLock() {
  try { fsSync.unlinkSync(DELTA_COMPACT_LOCK_PATH); } catch (_) {}
}

function compactQueueFileIfNeededSync(currentOffsetBytes) {
  const off = Math.max(0, Number(currentOffsetBytes || 0) || 0);
  const COMPACT_THRESHOLD = 10 * 1024 * 1024; // 10MB
  if (off < COMPACT_THRESHOLD) return { ok: true, skipped: true, reason: "offset_below_threshold" };
  if (!fsSync.existsSync(DELTA_QUEUE_PATH)) return { ok: true, skipped: true, reason: "queue_missing" };
  if (!tryAcquireCompactLock()) return { ok: true, skipped: true, reason: "lock_busy" };

  try {
    const stat = fsSync.statSync(DELTA_QUEUE_PATH);
    const size = Number(stat.size || 0) || 0;
    if (off >= size) {
      // tudo consumido: zera com truncamento simples
      fsSync.writeFileSync(DELTA_QUEUE_PATH, "", "utf8");
      writeCursorOffsetSync(0);
      return { ok: true, compacted: true, truncated: true };
    }

    const tmp = `${DELTA_QUEUE_PATH}.tmp`;
    const fd = fsSync.openSync(DELTA_QUEUE_PATH, "r");
    const outFd = fsSync.openSync(tmp, "w");
    try {
      const CHUNK = 256 * 1024;
      let pos = off;
      while (pos < size) {
        const remain = size - pos;
        const toRead = Math.max(1, Math.min(remain, CHUNK));
        const buf = Buffer.allocUnsafe(toRead);
        const n = fsSync.readSync(fd, buf, 0, toRead, pos);
        if (!n) break;
        fsSync.writeSync(outFd, buf, 0, n);
        pos += n;
      }
    } finally {
      try { fsSync.closeSync(outFd); } catch (_) {}
      try { fsSync.closeSync(fd); } catch (_) {}
    }

    fsSync.renameSync(tmp, DELTA_QUEUE_PATH);
    writeCursorOffsetSync(0);
    return { ok: true, compacted: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    releaseCompactLock();
  }
}

let __deltaIngestLoopRunning = false;
let __deltaIngestBackoffMs = 900;
let __deltaIngestKickRequested = false;

async function deltaIngestTick({ ctIngestUrl, deltaSecret } = {}) {
  if (__deltaIngestLoopRunning) return;
  __deltaIngestLoopRunning = true;
  try {
    const ingestUrl = String(ctIngestUrl || process.env.VIRTUS_DELTA_CT_INGEST_URL || "https://convenientetecnologia.com/api/messenger-delta/ingest").trim();
    const secret = String(deltaSecret || process.env.VIRTUS_DELTA_SECRET || process.env.VIRTUS_DELTA_X_DELTA_SECRET || "").trim();
    if (!ingestUrl) return;

    let offset = readCursorOffsetSync();
    const lineRes = readNextJsonlLineByOffsetSync(DELTA_QUEUE_PATH, offset);
    if (!lineRes.ok) {
      __deltaIngestBackoffMs = Math.min(60_000, Math.max(1500, Math.floor(__deltaIngestBackoffMs * 1.6)));
      return;
    }
    if (lineRes.eof) {
      __deltaIngestBackoffMs = 1200;
      return;
    }
    const line = String(lineRes.line || "").trim();
    const nextOffset = Number(lineRes.nextOffset || offset) || offset;
    if (!line) {
      writeCursorOffsetSync(nextOffset);
      __deltaIngestBackoffMs = 900;
      return;
    }
    const payload = safeJsonParse(line);
    if (!payload) {
      // linha corrompida: pula para não travar
      writeCursorOffsetSync(nextOffset);
      __deltaIngestBackoffMs = 1500;
      return;
    }

    const headers = { "content-type": "application/json" };
    if (secret) headers["x-delta-secret"] = secret;
    if (payload.idempotency_key) headers["x-idempotency-key"] = String(payload.idempotency_key);

    const res = await postWebhookJson(ingestUrl, payload, { timeoutMs: 4500, headers });
    if (res && res.status === 200) {
      writeCursorOffsetSync(nextOffset);
      try { compactQueueFileIfNeededSync(nextOffset); } catch (_) {}
      __deltaIngestBackoffMs = 650;
      return;
    }

    __deltaIngestBackoffMs = Math.min(60_000, Math.max(1200, Math.floor(__deltaIngestBackoffMs * 1.7)));
  } finally {
    __deltaIngestLoopRunning = false;
  }
}

function startDeltaIngestLoopOnce({ ctIngestUrl, deltaSecret } = {}) {
  if (startDeltaIngestLoopOnce._started) return;
  startDeltaIngestLoopOnce._started = true;

  const loop = async () => {
    __deltaIngestKickRequested = false;
    try { await deltaIngestTick({ ctIngestUrl, deltaSecret }); } catch (_) {}
    const jitter = Math.floor(Math.random() * 220);
    const waitMs = __deltaIngestKickRequested ? 100 : (__deltaIngestBackoffMs + jitter);
    setTimeout(loop, waitMs).unref?.();
  };

  setTimeout(loop, 300).unref?.();
}

function kickDeltaIngestLoop() {
  __deltaIngestKickRequested = true;
}

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
  preMarketplace: envMs("VIRTUS_DELTA_HUMAN_PRE_MARKETPLACE_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_MARKETPLACE_MS_MAX", 450, 950),
  /** Após ativar Marketplace — DOM lateral estabilizar */
  postMarketplace: envMs("VIRTUS_DELTA_HUMAN_POST_MARKETPLACE_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_MARKETPLACE_MS_MAX", 900, 1800),
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
  click: envMs("VIRTUS_DELTA_HUMAN_CLICK_MS_MIN", "VIRTUS_DELTA_HUMAN_CLICK_MS_MAX", 60, 140),
  /** Entre scrolls no sidebar */
  scroll: envMs("VIRTUS_DELTA_HUMAN_SCROLL_MS_MIN", "VIRTUS_DELTA_HUMAN_SCROLL_MS_MAX", 200, 380),
  /** Refresh DOM / retries */
  domSettle: envMs("VIRTUS_DELTA_HUMAN_DOM_SETTLE_MS_MIN", "VIRTUS_DELTA_HUMAN_DOM_SETTLE_MS_MAX", 250, 500),
};

function clickDelayMs() {
  return randomBetween(HUMAN_TIMINGS.click.min, HUMAN_TIMINGS.click.max);
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
  await humanPause(bucket, fromNetworkLead ? "reaction_post_lead" : "reaction_api_reply");
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

function _normCityKey(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function _pick(arr) {
  const a = Array.isArray(arr) ? arr : [];
  if (!a.length) return "";
  return String(a[Math.floor(Math.random() * a.length)] || "").trim();
}

function _parseShortRoutesFromEnv() {
  const raw = String(process.env.VIRTUS_DELTA_ROTAS_CURTAS || "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;\n]/g)
      .map((s) => _normCityKey(s))
      .filter(Boolean)
  );
}

const _SHORT_ROUTES = _parseShortRoutesFromEnv();

function _routeKindFromCity(cidade) {
  const c = String(cidade || "").trim();
  if (!c) return "pendente";
  const key = _normCityKey(c);
  if (_SHORT_ROUTES.size && _SHORT_ROUTES.has(key)) return "curta";
  return "longa";
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

function generateDeltaGreeting({ cidade } = {}) {
  try {
    const cfg = readAtendimentoDeltaConfigSync() || {};
    const h = new Date().getHours();
    const bloco1 =
      (h >= 6 && h <= 11) ? _pick(cfg.bloco1_bom_dia) :
      (h >= 12 && h <= 17) ? _pick(cfg.bloco1_boa_tarde) :
      _pick(cfg.bloco1_boa_noite);

    const bloco2 = _pick(cfg.bloco2_comercial);
    const bloco3 = _pick(cfg.bloco3_frota);

    const rk = _routeKindFromCity(cidade);
    const bloco4 =
      (rk === "curta") ? _pick(cfg.bloco4_gatilho_ab) :
      (rk === "longa") ? _pick(cfg.bloco4_gatilho_abc) :
      _pick(cfg.bloco4_gatilho_pendente);

    const out = [bloco1, bloco2, bloco3, bloco4].map((s) => String(s || "").trim()).filter(Boolean).join("\n");
    return out;
  } catch {
    return "Olá! Está disponível sim.\nPode me passar seu WhatsApp com DDD para eu te chamar por lá e agilizar?";
  }
}

async function extractCityFromMarketplaceDom(page) {
  try {
    if (!page) return null;
    const res = await page.evaluate(() => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const norm = (s) =>
        clean(s)
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase();

      const nodes = Array.from(document.querySelectorAll("span,div,a")).slice(0, 4500);
      for (const el of nodes) {
        const t = clean(el.textContent || "");
        if (!t) continue;
        const nt = norm(t);
        const has = nt.includes("anunciado em") || nt.includes("listed in");
        if (!has) continue;

        // Caso 1: o próprio texto já contém "Anunciado em X"
        const m = t.match(/anunciado em\s*(.+)$/i) || t.match(/listed in\s*(.+)$/i);
        if (m && m[1]) {
          const v = clean(m[1]).replace(/^[:\-]\s*/, "");
          if (v) return { ok: true, value: v, source: "inline_text" };
        }

        // Caso 2: existe um <a> dentro ou próximo do label
        const cand =
          (el.querySelector && el.querySelector("a")) ||
          (el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector("a")) ||
          (el.nextElementSibling && (el.nextElementSibling.closest ? el.nextElementSibling.closest("a") : null)) ||
          null;

        if (cand) {
          const v = clean(cand.textContent || "");
          if (v) return { ok: true, value: v, source: "near_anchor" };
        }
      }
      return { ok: false, value: null };
    });
    const v = res && res.ok ? String(res.value || "").trim() : "";
    if (!v) return null;
    // Hardening: limite e higienização
    return v.replace(/\s+/g, " ").trim().slice(0, 80);
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
        if (hrefNow.includes("marketplace")) return true;
        if (hrefNow.includes("/messages") && hrefNow.includes("folder=marketplace")) return true;

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

        for (const a of document.querySelectorAll('a[href*="/messages/"],a[href*="marketplace"]')) {
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

async function ensureMarketplaceFilterActive(page) {
  const activeBefore = await isMarketplaceFilterActive(page);
  if (activeBefore) {
    logInfo("[virtusDelta][marketplace] filter_already_active=sim");
    return { ok: true, already_active: true, active_after: true };
  }

  logInfo("[virtusDelta][marketplace] activating_filter...");
  await humanPause("preMarketplace", "pre_marketplace_click");
  const click = await clickMarketplaceFilterIfPresent(page);
  await humanPause("postMarketplace", "post_marketplace_click");

  let activeAfter = await isMarketplaceFilterActive(page);
  if (!activeAfter && click.changed) {
    await humanPause("domSettle", "marketplace_changed_recheck");
    activeAfter = await isMarketplaceFilterActive(page);
  }
  if (!activeAfter && !click.changed) {
    // Segunda tentativa (ícone SVG sem label) — bounded
    const buttons = await page.$$('div[data-virtualized="false"] div[role="button"]').catch(() => []);
    for (const b of buttons.slice(0, 8)) {
      try {
        const hasSvg = await b.evaluate((el) => Boolean(el.querySelector("svg")));
        if (!hasSvg) continue;
        await b.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("domSettle", "marketplace_icon_retry");
        activeAfter = await isMarketplaceFilterActive(page);
        if (activeAfter || click.changed) break;
      } catch (_) {}
    }
  }

  logInfo(
    `[virtusDelta][marketplace] activate result=${JSON.stringify({ ...click, active_before: activeBefore, active_after: activeAfter })}`
  );
  return { ...click, active_before: activeBefore, active_after: activeAfter };
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

  // SEMPRE ativar o filtro Marketplace (existir no DOM ≠ estar selecionado).
  const mp = await ensureMarketplaceFilterActive(page);

  let cardVisible = await isThreadCardVisible(page, t);
  logInfo(
    `[virtusDelta][dom_prep] thread_key=${t} card_visible=${cardVisible ? "sim" : "nao"} marketplace_active=${mp.active_after ? "sim" : "nao"}`
  );

  if (!cardVisible) {
    const root = await forceSidebarRefreshByMessagesRoot(page);
    logInfo(`[virtusDelta][dom_force] messages_root result=${JSON.stringify(root)}`);
    await humanPause("domSettle", "dom_prep_root_settle");
    if (!(await isMarketplaceFilterActive(page))) {
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

  // 1) âncoras contendo label Marketplace (sem depender de notificações)
  const anchors = await page.$$('a[href*="/messages/"],a[href*="marketplace"]').catch(() => []);
  for (const a of anchors) {
    try {
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
  const buttons = await page.$$('div[data-virtualized="false"] div[role="button"],[role="tab"],[role="button"]').catch(() => []);
  // 2a) tentativa “forte” quando existe texto/aria-label Marketplace
  for (const b of buttons) {
    try {
      const ok = await b.evaluate((el) => {
        if (!el.querySelector('svg')) return false;
        const label = String(el.getAttribute('aria-label') || '').trim().toLowerCase();
        const txt = String(el.innerText || el.textContent || '').trim().toLowerCase();
        return label.includes('marketplace') || txt === 'marketplace' || txt.includes('marketplace');
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
  // Tentamos clique bounded (máx 6 botões) e validamos por mudança do sidebar/rota.
  const svgButtons = [];
  for (const b of buttons) {
    try {
      const hasSvg = await b.evaluate((el) => Boolean(el.querySelector("svg")));
      if (hasSvg) svgButtons.push(b);
    } catch (_) {}
  }
  for (const b of svgButtons.slice(0, 6)) {
    try {
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
          document.querySelector('div[role="textbox"][contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]');
        if (!el) return "";
        return String(el.innerText || el.textContent || "").trim();
      })
      .catch(() => "")
  ).trim();
}

async function clickSendButtonIfPresent(page) {
  const sels = [
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
  return false;
}

async function ensureComposerFocused(page) {
  const sels = [
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label="Mensagem"]',
    'div[aria-label*="mensagem"]',
    'div[role="textbox"][contenteditable="true"]',
  ];

  let handle = null;
  for (const sel of sels) {
    handle = await page.$(sel).catch(() => null);
    if (handle) break;
  }
  if (!handle) throw new Error("composer_missing");

  await handle.click({ delay: clickDelayMs() }).catch(() => {});
  await humanPause("preComposer", "composer_focus");

  const existing = await readComposerText(page);
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
  await page.evaluate(() => {
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
      target.scrollBy(0, 520);
    } catch (_) {}
  });
}

async function openThreadByClick(page, threadKey, { maxScrollSteps = 16 } = {}) {
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
        await humanPause("preThreadClick", "pre_thread_card_click");
        await a.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("postThreadOpen", "post_thread_card_click");
        return { ok: true, scrolled: i, matched_selector: sel };
      }
    }
    await scrollSidebarShort(page).catch(() => {});
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
        await a2.click({ delay: clickDelayMs() }).catch(() => {});
        await humanPause("postThreadOpen", "post_thread_fallback_click");
        return { ok: true, scrolled: maxScrollSteps, fallback_current_thread: true, current_path: current };
      }
    }
  } catch (_) {}

  return { ok: false, error: "thread_card_not_found", href_preview: hrefPreview };
}

async function sendReplyFlow({ page, threadKey, textoResposta, fromNetworkLead = false } = {}) {
  const t = String(threadKey || "").trim();
  logInfo(`[virtusDelta][reply] start thread_key=${t} chars=${String(textoResposta || "").length} from_network=${fromNetworkLead ? "sim" : "nao"}`);

  await humanReactionDelay(fromNetworkLead);

  if (fromNetworkLead) {
    try {
      await prepareDomForNetworkLead(page, threadKey);
    } catch (e) {
      logInfo(`[virtusDelta][dom_prep] fail thread_key=${t} err=${e && e.message ? e.message : String(e)}`);
    }
  }

  try {
    await ensureMarketplaceFilterActive(page);
  } catch (_) {}

  const open = await openThreadByClick(page, threadKey);
  if (!open.ok) {
    if (fromNetworkLead) {
      try {
        logInfo(`[virtusDelta][reply] openThread retry after dom_force thread_key=${t}`);
        await forceSidebarRefreshByMessagesRoot(page);
        await humanPause("domSettle", "open_thread_retry_root");
        await ensureMarketplaceFilterActive(page);
        await humanPause("postMarketplace", "open_thread_retry_marketplace");
      } catch (_) {}
      const open2 = await openThreadByClick(page, threadKey, { maxScrollSteps: 20 });
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

  // Link do classificado (Coletor 101)
  try {
    const itemLink = await extractMarketplaceItemLink(page);
    if (itemLink) logInfo(`[COLETOR_101_LINK] ${itemLink}`);
  } catch (_) {}

  await ensureComposerFocused(page);
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

  if (!composed || composed.length < 3) {
    logInfo(`[virtusDelta][composer] retry_focus_and_type thread_key=${t}`);
    await humanPause("domSettle", "composer_retry_settle");
    await ensureComposerFocused(page);
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
  if (composed && composed.length >= 3) {
    await page.keyboard.press("Enter");
    logInfo(`[virtusDelta][reply] enter_sent thread_key=${t}`);
    await humanPause("postSend", "post_enter_send");
    const afterEnter = await readComposerText(page);
    if (afterEnter && afterEnter.length >= 3) {
      const clicked = await clickSendButtonIfPresent(page);
      logInfo(`[virtusDelta][reply] send_button_fallback thread_key=${t} clicked=${clicked ? "sim" : "nao"}`);
    }
  } else {
    const clicked = await clickSendButtonIfPresent(page);
    logInfo(`[virtusDelta][reply] composer_empty thread_key=${t} send_button=${clicked ? "sim" : "nao"}`);
    if (!clicked) return { ok: false, error: "composer_text_not_registered" };
  }
  return { ok: true };
}

function createSerialQueue() {
  let chain = Promise.resolve();
  return (fn) => {
    chain = chain.then(fn).catch(() => {});
    return chain;
  };
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
  startDeltaIngestLoopOnce({ ctIngestUrl: CT_INGEST_URL, deltaSecret: DELTA_SECRET });

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
  try {
    const mpBoot = await ensureMarketplaceFilterActive(page);
    logInfo(`[virtusDelta][boot] marketplace_boot=${JSON.stringify(mpBoot)}`);
  } catch (e) {
    logInfo(`[virtusDelta][boot] marketplace_boot_fail err=${e && e.message ? e.message : String(e)}`);
  }

  const cdpSession = await page.target().createCDPSession();
  await cdpSession.send("Network.enable");
  logInfo(`[virtusDelta][boot] CDP Network.enable ok`);

  const seenKeys = new Set();
  const autoReplyText = String(process.env.VIRTUS_DELTA_AUTO_REPLY_TEXT || "").replace(/\r/g, "");
  const autoGreetingEnabled = String(process.env.VIRTUS_DELTA_AUTO_GREETING || "").trim() === "1";
  const autoReplyThreads = new Map(); // threadKey -> tsMs
  const autoReplyMinIntervalMs = Math.max(
    5_000,
    Number(process.env.VIRTUS_DELTA_AUTO_REPLY_MIN_INTERVAL_MS || 60_000) || 60_000
  );
  let cityCache = { at: 0, value: null };
  let cityTimer = null;
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

  const enqueue = createSerialQueue();

  cdpSession.on("Network.webSocketFrameReceived", (event) => {
    try {
      const response = event?.response || {};
      const opcode = Number(response?.opcode ?? -1);
      const payloadData = response?.payloadData || "";
      const decoded = decodeWebSocketPayload(payloadData, opcode);
      const inner = extractInnerPayload(decoded);

      let events = [];
      try {
        events = extractWsMessageEvents(inner, "");
      } catch (_) {
        events = [];
      }

      for (const ev of events) {
        const threadKey = String(ev?.thread_key || "").trim();
        const texto = decodeEscapedText(String(ev?.message_text || "")).trim();
        if (!threadKey) continue;
        if (!shouldEmitLeadText(texto)) continue;

        const key = `${ACCOUNT_LOGIN || ""}|${threadKey}|${texto}|${String(ev?.operacao_meta || ev?.operation || "")}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (seenKeys.size > 8000) {
          const first = seenKeys.values().next().value;
          if (first) seenKeys.delete(first);
        }

        const payload = {
          server_id: SERVER_ID,
          account_login: ACCOUNT_LOGIN,
          thread_key: threadKey,
          texto_limpo: texto,
          cidade: cityCache && cityCache.value ? cityCache.value : null,
          operacao_meta: String(ev?.operacao_meta || ev?.operation || ""),
        };
        // Barramento do "Vai" (novo): persiste em disco e deixa o loop HTTP entregar com ACK 200.
        try {
          appendPendingJsonlSync(payload);
          kickDeltaIngestLoop();
        } catch (_) {}

        logInfo(
          `[virtusDelta][network_impact] account=${ACCOUNT_LOGIN || ""} thread_key=${threadKey} texto="${texto.slice(0, 120)}" op=${String(ev?.operacao_meta || ev?.operation || "")}`
        );

        const autoMsg = autoReplyText ? autoReplyText : (autoGreetingEnabled ? generateDeltaGreeting({ cidade: cityCache && cityCache.value ? cityCache.value : null }) : "");
        if (autoMsg) {
          const last = Number(autoReplyThreads.get(threadKey) || 0);
          const now = Date.now();
          if (!last || now - last >= autoReplyMinIntervalMs) {
            autoReplyThreads.set(threadKey, now);
            enqueue(async () => {
              try {
                await sendReplyFlow({
                  page,
                  threadKey,
                  textoResposta: autoMsg,
                  fromNetworkLead: true,
                });
                logInfo(`[virtusDelta][reply] done thread_key=${threadKey} ok=sim (network_lead)`);
              } catch (e) {
                logInfo(
                  `[virtusDelta][reply] crash thread_key=${threadKey} err=${e && e.message ? e.message : String(e)}`
                );
              }
            });
          }
        }
      }
    } catch (_) {
      // nunca crashar por frame corrompido
    }
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const INFRA_SECRET = String(process.env.VIRTUS_DELTA_INFRA_SECRET || process.env.INFRA_SECRET || "").trim();
  const infraAuthOk = (req) => {
    if (!INFRA_SECRET) return false;
    const got = String(req.headers["x-infra-secret"] || "").trim();
    return got && got === INFRA_SECRET;
  };

  // Novo contrato (push HTTP direto): CT -> VM
  // Payload: { thread_key, texto_resposta }
  app.post("/api/infra/command", (req, res) => {
    try {
      if (!INFRA_SECRET) return res.status(500).json({ ok: false, error: "infra_secret_not_configured" });
      if (!infraAuthOk(req)) return res.status(403).json({ ok: false, error: "forbidden" });

      const thread_key = String(req.body?.thread_key || "").trim();
      const texto_resposta = String(req.body?.texto_resposta || "").replace(/\r/g, "");
      if (!thread_key || !texto_resposta) {
        return res.status(400).json({ ok: false, error: "missing_thread_key_or_texto_resposta" });
      }

      enqueue(async () => {
        try {
          const r = await sendReplyFlow({ page, threadKey: thread_key, textoResposta: texto_resposta, fromNetworkLead: false });
          logInfo(`[virtusDelta][infra_cmd] done thread_key=${String(thread_key)} ok=${r && r.ok === true ? "sim" : "nao"}`);
        } catch (e) {
          logInfo(`[virtusDelta][infra_cmd] crash thread_key=${String(thread_key)} err=${e && e.message ? e.message : String(e)}`);
        }
      });

      return res.json({ ok: true, queued: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // Compat legado local (sem segredo): útil em debug/ops local.
  app.post("/api/enviar-resposta", (req, res) => {
    try {
      const thread_key = String(req.body?.thread_key || "").trim();
      const texto_resposta = String(req.body?.texto_resposta || "").replace(/\r/g, "");
      if (!thread_key || !texto_resposta) {
        return res.status(400).json({ ok: false, error: "missing_thread_key_or_texto_resposta" });
      }

      enqueue(async () => {
        try {
          const r = await sendReplyFlow({ page, threadKey: thread_key, textoResposta: texto_resposta });
          logInfo(`[virtusDelta][reply] done thread_key=${String(thread_key)} ok=${r && r.ok === true ? "sim" : "nao"}`);
        } catch (e) {
          logInfo(
            `[virtusDelta][reply] crash thread_key=${String(thread_key)} err=${e && e.message ? e.message : String(e)}`
          );
        }
      });

      return res.json({ ok: true, queued: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, "127.0.0.1", () => resolve(s));
  });
  logInfo(`[virtusDelta][boot] express_listening=http://127.0.0.1:${PORT}`);
  logInfo(`[virtusDelta][boot] mode=passive_listening auto_reply=${autoReplyText ? "enabled" : "disabled"}`);

  return {
    ok: true,
    server_id: SERVER_ID,
    account_login: ACCOUNT_LOGIN,
    express_port: PORT,
    browser,
    page,
    shutdown: async () => {
      try {
        await new Promise((r) => server.close(() => r()));
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
  const autoGreetingEnabled = String(process.env.VIRTUS_DELTA_AUTO_GREETING || "").trim() === "1";
  const autoReplyMinIntervalMs = Math.max(
    5_000,
    Number(process.env.VIRTUS_DELTA_AUTO_REPLY_MIN_INTERVAL_MS || 60_000) || 60_000
  );
  const autoReplyThreads = new Map();

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

  // Boot minimal: garantir que estamos em /messages (permitido no boot; proibição é no reply flow).
  try {
    const u0 = String(page.url ? page.url() : "");
    if (!/facebook\.com\/messages/i.test(u0)) {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    }
  } catch (_) {}
  try {
    const mpBoot = await ensureMarketplaceFilterActive(page);
    logInfo(`[virtusDelta][boot][worker] marketplace_boot=${JSON.stringify(mpBoot)}`);
  } catch (e) {
    logInfo(
      `[virtusDelta][boot][worker] marketplace_boot_fail err=${e && e.message ? e.message : String(e)}`
    );
  }

  logInfo(`[virtusDelta][boot][worker] nome=${String(nome || "")} engine=delta epoch=${requiredEpoch} slowMode=${slowMode ? "sim" : "nao"} url=${String(page.url ? page.url() : "")}`);

  let cdpSession = null;
  try {
    cdpSession = await page.target().createCDPSession();
    await cdpSession.send("Network.enable");
  } catch (e) {
    return {
      stop: async () => {},
      ok: false,
      error: e && e.message ? e.message : String(e),
    };
  }
  // Ingest loop (HTTP): roda em background e consome a fila JSONL.
  startDeltaIngestLoopOnce({});

  const seenKeys = new Set();
  let cityCache = { at: 0, value: null };
  let cityTimer = null;
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

  const onFrame = (event) => {
    try {
      if (!running || !epochOk()) return;
      const response = event?.response || {};
      const opcode = Number(response?.opcode ?? -1);
      const payloadData = response?.payloadData || "";
      const decoded = decodeWebSocketPayload(payloadData, opcode);
      const inner = extractInnerPayload(decoded);

      let events = [];
      try {
        events = extractWsMessageEvents(inner, "");
      } catch (_) {
        events = [];
      }

      for (const ev of events) {
        const threadKey = String(ev?.thread_key || "").trim();
        const texto = decodeEscapedText(String(ev?.message_text || "")).trim();
        if (!threadKey) continue;
        if (!shouldEmitLeadText(texto)) continue;

        const key = `${ACCOUNT_LOGIN || ""}|${threadKey}|${texto}|${String(ev?.operacao_meta || ev?.operation || "")}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (seenKeys.size > 8000) {
          const first = seenKeys.values().next().value;
          if (first) seenKeys.delete(first);
        }

        const payload = {
          server_id: SERVER_ID,
          account_login: ACCOUNT_LOGIN,
          thread_key: threadKey,
          texto_limpo: texto,
          cidade: cityCache && cityCache.value ? cityCache.value : null,
          operacao_meta: String(ev?.operacao_meta || ev?.operation || ""),
        };
        try {
          appendPendingJsonlSync(payload);
          kickDeltaIngestLoop();
        } catch (_) {}

        // Primeiro atendimento automático (opcional, produção OFF por default).
        if (autoGreetingEnabled) {
          const last = Number(autoReplyThreads.get(threadKey) || 0);
          const now = Date.now();
          if (!last || now - last >= autoReplyMinIntervalMs) {
            autoReplyThreads.set(threadKey, now);
            const textoResposta = generateDeltaGreeting({ cidade: cityCache && cityCache.value ? cityCache.value : null });
            if (textoResposta) {
              enqueue(async () => {
                try {
                  if (!running || !epochOk()) return;
                  await sendReplyFlow({ page, threadKey, textoResposta, fromNetworkLead: true });
                } catch (_) {}
              });
            }
          }
        }
      }
    } catch (_) {
      // nunca crashar por frame corrompido
    }
  };

  try {
    cdpSession.on("Network.webSocketFrameReceived", onFrame);
  } catch (_) {}

  return {
    ok: true,
    engine: "delta",
    server_id: SERVER_ID,
    account_login: ACCOUNT_LOGIN,
    page,
    stop: async () => {
      running = false;
      try {
        if (cityTimer) clearInterval(cityTimer);
      } catch (_) {}
      try {
        if (cdpSession && typeof cdpSession.removeListener === "function") {
          cdpSession.removeListener("Network.webSocketFrameReceived", onFrame);
        }
      } catch (_) {}
      try {
        if (cdpSession && typeof cdpSession.detach === "function") await cdpSession.detach();
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

