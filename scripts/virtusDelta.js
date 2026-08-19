const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const VIRTUS_DELTA_BUILD = "2026-07-17-steel-delivery-contract-v1";
try { console.log("[virtusDelta][module] build=" + VIRTUS_DELTA_BUILD); } catch {}
const crypto = require("crypto");

// ===================== FORENSIC_EDGE (Caixa-preta Universal) =====================
// Regra rígida: console + arquivo físico, JSON string única:
// console.log(JSON.stringify({ timestamp, account_login, thread_key, flow_stage, details }))
const FORENSIC_EDGE_LOG_PATH = path.join(__dirname, "..", "dados", "forensic_edge.log");
const LEADS_BRUTOS_JSONL_PATH = path.join(__dirname, "..", "dados", "leads_brutos.jsonl");
const FORENSIC_TRIAGEM_LOG_PATH = path.join(__dirname, "..", "dados", "forensic_triagem.log");

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
const FORENSIC_TRIAGEM_ROTATE_MAX_BYTES = 10 * 1024 * 1024; // 10MB hard ceiling (circular)
function __triagemCircularAppendSync(signature, details = null) {
  try {
    const sig = String(signature || "").trim();
    if (!sig) return false;
    const fp = String(FORENSIC_TRIAGEM_LOG_PATH || "").trim();
    if (!fp) return false;
    const payload = (details && typeof details === "object")
      ? { ...details }
      : { message: String(details || "") };
    const line = `[${sig}] ${JSON.stringify({ timestamp: Date.now(), ...payload })}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    try { fsSync.mkdirSync(path.dirname(fp), { recursive: true }); } catch (_) {}

    let currentSize = 0;
    try {
      if (fsSync.existsSync(fp)) {
        const st = fsSync.statSync(fp);
        currentSize = Number(st && st.size || 0) || 0;
      }
    } catch (_) {}

    if ((currentSize + lineBytes) > FORENSIC_TRIAGEM_ROTATE_MAX_BYTES) {
      const keepBytes = Math.max(0, FORENSIC_TRIAGEM_ROTATE_MAX_BYTES - lineBytes);
      let tail = "";
      if (keepBytes > 0 && currentSize > 0) {
        let fd = null;
        try {
          fd = fsSync.openSync(fp, "r");
          const start = Math.max(0, currentSize - keepBytes);
          const toRead = Math.max(0, currentSize - start);
          if (toRead > 0) {
            const buf = Buffer.allocUnsafe(toRead);
            const got = fsSync.readSync(fd, buf, 0, toRead, start);
            tail = buf.slice(0, Math.max(0, got)).toString("utf8");
          }
        } catch (_) {
          tail = "";
        } finally {
          try { if (fd) fsSync.closeSync(fd); } catch (_) {}
        }
      }
      fsSync.writeFileSync(fp, tail + line, "utf8");
      return true;
    }

    fsSync.appendFileSync(fp, line, "utf8");
    return true;
  } catch (_) {
    return false;
  }
}
function __deltaLogTriagemDom(details = null) {
  return __triagemCircularAppendSync("FORENSIC_TRIAGEM_DOM", details);
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
let detectVirtusIdentityBlock = null;
let newPageDaConta = null;
let blindarPaginaDaConta = null;
try {
  const browserMod = require("./browser.js");
  killChromeProfileProcesses = browserMod.killChromeProfileProcesses;
  detectVirtusIdentityBlock = browserMod.detectVirtusIdentityBlock;
  newPageDaConta = browserMod.newPageDaConta;
  blindarPaginaDaConta = browserMod.blindarPaginaDaConta;
} catch (_) {}

async function probeIdVirtusBlock(page, { account_login = null, thread_key = null, stage = "" } = {}) {
  try {
    if (typeof detectVirtusIdentityBlock !== "function" || !page) return null;
    const iv = await detectVirtusIdentityBlock(page).catch(() => null);
    if (!(iv && iv.blocked === true)) return null;
    try {
      __forensicEdgeEmit({
        account_login: account_login == null ? null : String(account_login || "").trim(),
        thread_key: thread_key == null ? null : String(thread_key || "").trim(),
        flow_stage: "id_virtus_blocked",
        details: {
          stage: String(stage || "").slice(0, 80),
          reason: String(iv.reason || "id_virtus_send_identity").slice(0, 160),
          url: iv.url || null,
          title: iv.title || null,
          evidence: iv.evidence || null,
          ts_ms: Date.now()
        }
      });
    } catch (_) {}
    return {
      ok: false,
      error: "id_virtus_blocked",
      idVirtus: true,
      reason: String(iv.reason || "id_virtus_send_identity"),
      url: iv.url || null,
      title: iv.title || null
    };
  } catch (_) {
    return null;
  }
}
let getDeltaCityCollector = null;
let isCleanCityLabelFn = null;
let isDirtyCityLabelFn = null;
let isWeakCityCandidateSourceFn = null;
try {
  ({
    getDeltaCityCollector,
    isCleanCityLabel: isCleanCityLabelFn,
    isDirtyCityLabel: isDirtyCityLabelFn,
    isWeakCityCandidateSource: isWeakCityCandidateSourceFn,
  } = require("./deltaCityCollector.js"));
} catch (_) {}

function __deltaCityLabelIsClean(raw, source = null) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  try {
    if (typeof isDirtyCityLabelFn === "function" && isDirtyCityLabelFn(s)) return false;
    if (typeof isCleanCityLabelFn === "function" && !isCleanCityLabelFn(s)) return false;
  } catch (_) {
    const compact = s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, "");
    if (/gratis|nintendo|switch|oled|iphone|playstation|xbox/i.test(compact)) return false;
  }
  const src = String(source || "").trim().toLowerCase();
  if (src) {
    try {
      if (typeof isWeakCityCandidateSourceFn === "function" && isWeakCityCandidateSourceFn(src)) {
        return false;
      }
    } catch (_) {
      if (src.startsWith("marketplace_city_link") || src.startsWith("body_")) return false;
    }
  }
  return true;
}

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

/**
 * Contrato de navegação do firewall Delta (request interception).
 * Permite só o que o Messenger/Facebook precisa pra abrir thread clássico e E2EE:
 * - facebook.com / www / web / m / mbasic (Facebook móvel redireciona www→web)
 * - messenger.com / www.messenger.com (landing [/e2ee]/t/)
 * - fbsbx.com / www.fbsbx.com SOMENTE /maw_proxy_page
 *   (XCometMessengerE2EEThreadController / XCometMessengerController)
 *
 * Goto nosso continua www.facebook.com/messages; o host final é o Facebook.
 * Bloquear maw_proxy engessa E2EE: goto /messages/e2ee/t/... redireciona pra
 * fbsbx e o guard abortava → thread_open_hydration_timeout.
 * Continua proibido page.goto(?folder=marketplace) no nosso código (outro contrato).
 */
const facebookNavHosts = require("./facebookNavHosts.js");
function __deltaIsAllowedNavigationUrl(rawUrl) {
  return facebookNavHosts.isAllowedDeltaNavigationUrl(rawUrl);
}

function attachDeltaNavigationFirewall(page, { profileName = "" } = {}) {
  try {
    if (!page || page.__virtusDeltaNavFirewallAttached) return;
    page.__virtusDeltaNavFirewallAttached = true;
  } catch (_) {
    return;
  }

  const isAllowedNavUrl = __deltaIsAllowedNavigationUrl;

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
        const bootInterlock = page && page.__deltaBootInterlock && typeof page.__deltaBootInterlock === "object"
          ? page.__deltaBootInterlock
          : null;
        if (
          bootInterlock &&
          bootInterlock.active === true &&
          bootInterlock.released !== true &&
          typeof bootInterlock.matches === "function" &&
          bootInterlock.matches(url)
        ) {
          if (bootInterlock.requestHeld) return;
          bootInterlock.requestHeld = true;
          const holdMs = Math.max(3000, Number(bootInterlock.holdMs || 3000) || 3000);
          const earReadyFn = (typeof bootInterlock.isEarReady === "function") ? bootInterlock.isEarReady : null;
          const startedAt = Date.now();
          (async () => {
            let earReady = !earReadyFn;
            try {
              // Retenção mínima obrigatória do boot.
              while ((Date.now() - startedAt) < holdMs) {
                if (earReadyFn) {
                  try {
                    const probe = await Promise.resolve(earReadyFn());
                    if (probe === true) { earReady = true; break; }
                  } catch (_) {}
                }
                const remaining = Math.max(0, holdMs - (Date.now() - startedAt));
                if (remaining <= 0) break;
                await sleep(Math.min(120, remaining));
              }
              // Regra rígida: só libera quando ouvido de borda estiver autenticamente pronto.
              if (earReadyFn && !earReady) {
                let lastWaitLogAt = 0;
                while (!earReady) {
                  try { earReady = !!(await Promise.resolve(earReadyFn())); } catch (_) { earReady = false; }
                  if (earReady) break;
                  const now = Date.now();
                  if (!lastWaitLogAt || (now - lastWaitLogAt) >= 5000) {
                    lastWaitLogAt = now;
                    try {
                      logInfo(
                        `[DELTA_BOOT_INTERLOCK] waiting_ear_ready profile=${String(profileName || "").trim() || "unknown"} waited_ms=${Math.max(0, now - startedAt)}`
                      );
                    } catch (_) {}
                  }
                  await sleep(120);
                }
              }
            } catch (_) {}
            if (!earReady) return;
            try { request.continue().catch(() => {}); } catch (_) {}
            bootInterlock.released = true;
            bootInterlock.active = false;
            bootInterlock.releasedAt = Date.now();
            bootInterlock.earReadyAtRelease = !!earReady;
            try {
              logInfo(
                `[DELTA_BOOT_INTERLOCK] release profile=${String(profileName || "").trim() || "unknown"} hold_ms=${Math.max(0, Date.now() - startedAt)} ear_ready=${earReady ? "sim" : "nao"}`
              );
            } catch (_) {}
            if (bootInterlock.disableInterceptionAfterRelease !== false) {
              try { await page.setRequestInterception(false); } catch (_) {}
            }
            try { delete page.__deltaBootInterlock; } catch (_) {}
          })().catch(() => {});
          return;
        }
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

function __isLikelyMessagesBootUrl(rawUrl) {
  return facebookNavHosts.isLikelyMessagesBootUrl(rawUrl);
}

async function __gotoWithBootInterlock(page, targetUrl, {
  timeoutMs = 45000,
  profileName = "",
  bootInterlockEnabled = true,
  bootInterlockHoldMs = 3000,
  bootInterlockBeforeNavigate = null,
  bootInterlockIsEarReady = null,
} = {}) {
  const url = String(targetUrl || "").trim();
  if (!url) throw new Error("boot_interlock_empty_url");
  const enabled = !!bootInterlockEnabled && __isLikelyMessagesBootUrl(url);
  const connectLane = require("./connectLane.js");
  return await connectLane.withHeavyNav(
    { kind: "delta_boot_goto", nome: String(profileName || "").slice(0, 120) },
    async () => {
  if (!enabled) {
    return await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }
  const holdMs = Math.max(3000, Number(bootInterlockHoldMs || 3000) || 3000);
  try {
    if (typeof bootInterlockBeforeNavigate === "function") {
      await Promise.resolve(bootInterlockBeforeNavigate({ page, targetUrl: url, holdMs, profileName }));
    }
  } catch (_) {}
  try {
    page.__deltaBootInterlock = {
      active: true,
      released: false,
      requestHeld: false,
      holdMs,
      isEarReady: (typeof bootInterlockIsEarReady === "function") ? bootInterlockIsEarReady : null,
      disableInterceptionAfterRelease: true,
      matches: (requestUrl) => {
        try {
          if (!__isLikelyMessagesBootUrl(requestUrl)) return false;
          const ru = new URL(String(requestUrl || ""));
          const tu = new URL(url);
          const reqHost = String(ru.hostname || "").toLowerCase();
          const tgtHost = String(tu.hostname || "").toLowerCase();
          if (reqHost !== tgtHost) {
            if (!facebookNavHosts.isOfficialFacebookNavHost(reqHost) || !facebookNavHosts.isOfficialFacebookNavHost(tgtHost)) return false;
          }
          return true;
        } catch {
          return false;
        }
      }
    };
    await page.setRequestInterception(true).catch(() => {});
    logInfo(
      `[DELTA_BOOT_INTERLOCK] armed profile=${String(profileName || "").trim() || "unknown"} hold_ms=${holdMs} url=${url}`
    );
  } catch (_) {}
  try {
    return await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } finally {
    try {
      const state = page && page.__deltaBootInterlock ? page.__deltaBootInterlock : null;
      if (state && state.active === true && state.released !== true) {
        state.active = false;
        state.released = true;
        state.releasedAt = Date.now();
        if (state.requestHeld !== true) {
          try { await page.setRequestInterception(false); } catch (_) {}
          try { delete page.__deltaBootInterlock; } catch (_) {}
        }
      }
    } catch (_) {}
  }
    }
  );
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

// Defaults "ninja": wait-until-condition > sleep paranoico.
// Env vars ainda sobrescrevem se precisar afrouxar/apertar por host.
const HUMAN_TIMINGS = {
  /** Pausa perceptiva pós-lead (Fabiana) */
  reaction: envMs("VIRTUS_DELTA_REACTION_DELAY_MS_MIN", "VIRTUS_DELTA_REACTION_DELAY_MS_MAX", 3000, 7000),
  /** Fila de ação das mãos (dashboard + chat novo) */
  actionDispatch: envMs("VIRTUS_DELTA_ACTION_DELAY_MS_MIN", "VIRTUS_DELTA_ACTION_DELAY_MS_MAX", 2000, 10000),
  /** Antes de clicar no filtro Marketplace */
  preMarketplace: envMs("VIRTUS_DELTA_HUMAN_PRE_MARKETPLACE_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_MARKETPLACE_MS_MAX", 250, 700),
  /** Após ativar Marketplace — DOM lateral */
  postMarketplace: envMs("VIRTUS_DELTA_HUMAN_POST_MARKETPLACE_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_MARKETPLACE_MS_MAX", 300, 800),
  /** Extra após UI Marketplace estável */
  marketplaceLoad: envMs("VIRTUS_DELTA_HUMAN_MARKETPLACE_LOAD_MS_MIN", "VIRTUS_DELTA_HUMAN_MARKETPLACE_LOAD_MS_MAX", 200, 600),
  /** Antes de clicar no card do cliente */
  preThreadClick: envMs("VIRTUS_DELTA_HUMAN_PRE_THREAD_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_THREAD_MS_MAX", 200, 600),
  /** Após abrir o chat — só respiro curto; composer usa waitForSelector */
  postThreadOpen: envMs("VIRTUS_DELTA_HUMAN_POST_OPEN_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_OPEN_MS_MAX", 400, 1200),
  /** Antes de focar o composer */
  preComposer: envMs("VIRTUS_DELTA_HUMAN_PRE_COMPOSER_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_COMPOSER_MS_MAX", 200, 500),
  /** Entre foco e primeira tecla */
  preTyping: envMs("VIRTUS_DELTA_HUMAN_PRE_TYPE_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_TYPE_MS_MAX", 200, 500),
  /** Por caractere */
  char: envMs("VIRTUS_DELTA_HUMAN_CHAR_MS_MIN", "VIRTUS_DELTA_HUMAN_CHAR_MS_MAX", 80, 130),
  /** Após Shift+Enter */
  lineBreak: envMs("VIRTUS_DELTA_HUMAN_LINEBREAK_MS_MIN", "VIRTUS_DELTA_HUMAN_LINEBREAK_MS_MAX", 45, 110),
  /** Antes do Enter final */
  preSend: envMs("VIRTUS_DELTA_HUMAN_PRE_SEND_MS_MIN", "VIRTUS_DELTA_HUMAN_PRE_SEND_MS_MAX", 200, 500),
  /** Após envio */
  postSend: envMs("VIRTUS_DELTA_HUMAN_POST_SEND_MS_MIN", "VIRTUS_DELTA_HUMAN_POST_SEND_MS_MAX", 200, 500),
  /** delay do page.click */
  click: envMs("VIRTUS_DELTA_HUMAN_CLICK_MS_MIN", "VIRTUS_DELTA_HUMAN_CLICK_MS_MAX", 120, 280),
  /** Entre scrolls no sidebar */
  scroll: envMs("VIRTUS_DELTA_HUMAN_SCROLL_MS_MIN", "VIRTUS_DELTA_HUMAN_SCROLL_MS_MAX", 150, 350),
  /** Refresh DOM / retries entre polls */
  domSettle: envMs("VIRTUS_DELTA_HUMAN_DOM_SETTLE_MS_MIN", "VIRTUS_DELTA_HUMAN_DOM_SETTLE_MS_MAX", 120, 350),
};
const NEW_CHAT_WARMUP_DELAY = envMs(
  "VIRTUS_DELTA_NEW_CHAT_DELAY_MS_MIN",
  "VIRTUS_DELTA_NEW_CHAT_DELAY_MS_MAX",
  30_000,
  90_000
);
/** Tempo de “digitação” entre um reply e outro na fila de mãos (abre chat → espera → envia). */
const CROSS_THREAD_SEND_GAP = envMs(
  "VIRTUS_DELTA_CROSS_THREAD_GAP_MS_MIN",
  "VIRTUS_DELTA_CROSS_THREAD_GAP_MS_MAX",
  3_000,
  10_000
);

const MARKETPLACE_STABILITY_ROUNDS = Math.max(
  2,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_STABILITY_ROUNDS || 2) || 2
);
const MARKETPLACE_STABILITY_GAP_MS = Math.max(
  300,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_STABILITY_GAP_MS || 700) || 700
);
const MESSAGES_BOOT_STABILITY_ROUNDS = Math.max(
  2,
  Number(process.env.VIRTUS_DELTA_MESSAGES_BOOT_STABILITY_ROUNDS || 2) || 2
);
const MESSAGES_BOOT_STABILITY_GAP_MS = Math.max(
  300,
  Number(process.env.VIRTUS_DELTA_MESSAGES_BOOT_STABILITY_GAP_MS || 700) || 700
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
/** Após activate falhar (active_after=false), não martelar de novo por este tempo. */
const DELTA_MARKETPLACE_ENFORCER_FAIL_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_ENFORCER_FAIL_COOLDOWN_MS || 300_000) || 300_000
);
/** Orçamento total do activate Marketplace (evita 3–5min por conta no boot). */
const DELTA_MARKETPLACE_ACTIVATE_BUDGET_MS = Math.max(
  12_000,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_ACTIVATE_BUDGET_MS || 45_000) || 45_000
);
/** No boot do worker: não bloquear hands além deste teto (fail-open). */
const DELTA_MARKETPLACE_BOOT_TIMEOUT_MS = Math.max(
  8_000,
  Number(process.env.VIRTUS_DELTA_MARKETPLACE_BOOT_TIMEOUT_MS || 20_000) || 20_000
);

function __marketplaceClickTrusted(click) {
  const c = click && typeof click === "object" ? click : null;
  if (!c) return false;
  return !!(
    c.selected_after_click ||
    c.selected_after_keyboard ||
    c.selected_after_double_click
  );
}

async function __raceMarketplaceActivate(page, { timeoutMs = DELTA_MARKETPLACE_BOOT_TIMEOUT_MS, reason = "boot" } = {}) {
  const budget = Math.max(5_000, Number(timeoutMs || DELTA_MARKETPLACE_BOOT_TIMEOUT_MS) || DELTA_MARKETPLACE_BOOT_TIMEOUT_MS);
  const raceReason = String(reason || "boot");
  const bootFailOpen = /^boot/i.test(raceReason);
  try {
    const out = await Promise.race([
      ensureMarketplaceFilterActive(page).then((r) => ({
        ...(r && typeof r === "object" ? r : { ok: !!r }),
        timed_out: false,
        race_reason: raceReason,
      })),
      sleep(budget).then(() => ({
        ok: bootFailOpen,
        timed_out: true,
        fail_open: true,
        reason: "activate_budget_timeout",
        race_reason: raceReason,
        active_before: false,
        // No boot: libera hands mesmo sem validação DOM (enforcer continua em background).
        active_after: bootFailOpen,
        budget_ms: budget,
      })),
    ]);
    return out && typeof out === "object" ? out : { ok: false, error: "activate_empty" };
  } catch (e) {
    return {
      ok: bootFailOpen,
      fail_open: true,
      error: e && e.message ? String(e.message) : String(e),
      race_reason: raceReason,
      active_after: bootFailOpen,
    };
  }
}

function __isMessengerThreadUrl(urlOrPath) {
  const u = String(urlOrPath || "").toLowerCase();
  return u.includes("/messages/t/") || u.includes("/messages/e2ee/t/");
}

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
  const ms = await humanPause("actionDispatch", fromNetworkLead ? "action_dispatch_new_lead" : "action_dispatch_dashboard");
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
const BR_VALID_UF = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);
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
    .replace(/^anunciado\b.*?\bem\s+/i, "")
    .replace(/^listed\b.*?\bin\s+/i, "")
    .replace(/\s*,\s*/g, ", ")
    .trim();
  if (!s) return "";
  const cityKey = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\b(anunciado|listed)\b/.test(cityKey) && /\b(em|in)\b/.test(cityKey)) return "";
  const m1 = s.match(/^(.+?)\s*\(\s*([A-Za-z]{2})\s*\)$/);
  if (m1 && m1[1] && m1[2]) {
    const uf = String(m1[2]).toUpperCase();
    if (!BR_VALID_UF.has(uf)) return "";
    return `${toTitleCaseCityName(m1[1].trim())} (${uf})`.slice(0, 80);
  }
  const m2 = s.match(/^(.+?)\s*[-,\/]\s*([A-Za-z]{2})$/);
  if (m2 && m2[1] && m2[2]) {
    const uf = String(m2[2]).toUpperCase();
    if (!BR_VALID_UF.has(uf)) return "";
    return `${toTitleCaseCityName(m2[1].trim())} (${uf})`.slice(0, 80);
  }
  return "";
}
function sanitizeLeadClientName(rawTitle) {
  const cleanedSource = String(rawTitle || "")
    .replace(/^conversa intitulada\s+/i, "")
    .replace(/^conversation titled\s+/i, "")
    .replace(/^visto por\s+/i, "")
    .replace(/^seen by\s+/i, "")
    .replace(/^title:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanedSource) return "";
  const left = String(cleanedSource.split(" · ")[0] || cleanedSource)
    .replace(/^[:\-]\s*/, "")
    .replace(/\s*\|\s*marketplace.*$/i, "")
    .replace(/\s*[-–—]\s*marketplace.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!left) return "";
  const low = left.toLowerCase();
  if (
    low === "messenger" ||
    low === "marketplace" ||
    low === "cliente marketplace" ||
    low === "cliente sem nome"
  ) return "";
  if (/^(você|voce|you)\b[:\-]?/i.test(low)) return "";
  if (/^(há|ha)\s+\d+\s*(sem|mins|min|h|dia|dias|week|weeks)/i.test(low)) return "";
  return left.slice(0, 90);
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
      const pickBestConversationTitle = (list) => {
        const isLikelyNoise = (v) => {
          const t = clean(v || "");
          if (!t) return true;
          if (t.length < 2 || t.length > 160) return true;
          const low = t.toLowerCase();
          if (/^(você|voce|you)\b[:\-]?/i.test(low)) return true;
          if (low === "messenger" || low === "marketplace") return true;
          if (low === "cliente marketplace" || low === "cliente sem nome") return true;
          if (/https?:\/\//i.test(low)) return true;
          if (/\b\d{6,}\b/.test(low)) return true;
          if (/^(há|ha)\s+\d+\s*(sem|mins|min|h|dia|dias|week|weeks)/i.test(low)) return true;
          return false;
        };
        const normalizeTitle = (value) => {
          const base = clean(value || "")
            .replace(/^Conversa intitulada\s+/i, "")
            .replace(/^Conversation titled\s+/i, "")
            .replace(/^Visto por\s+/i, "")
            .replace(/^Seen by\s+/i, "")
            .trim();
          if (!base) return "";
          if (!base.includes(" · ")) return base;
          return clean(base.split(" · ")[0] || "");
        };
        for (const raw of list) {
          const t = clean(raw || "");
          if (!t || !t.includes(" · ")) continue;
          const normalized = normalizeTitle(t);
          if (isLikelyNoise(normalized)) continue;
          return t;
        }
        for (const raw of list) {
          const normalized = normalizeTitle(raw);
          if (isLikelyNoise(normalized)) continue;
          return normalized;
        }
        return "";
      };

      // 1) Fonte soberana: aria-label da conversa ativa (mais estável que classes ofuscadas).
      const ariaCandidates = [];
      const titledButtons = Array.from(document.querySelectorAll('[aria-label^="Conversa intitulada "], [aria-label^="Conversation titled "]'));
      for (const el of titledButtons) {
        if (!getVisible(el)) continue;
        const aria = clean(el.getAttribute("aria-label") || "");
        if (!aria) continue;
        ariaCandidates.push(aria.replace(/^Conversa intitulada\s+/i, "").replace(/^Conversation titled\s+/i, ""));
      }
      const fromAria = pickBestConversationTitle(ariaCandidates);
      if (fromAria) return fromAria;

      const seenByCandidates = [];
      const seenByNodes = Array.from(
        document.querySelectorAll('[aria-label^="Visto por "], [aria-label^="Seen by "]')
      );
      for (const el of seenByNodes) {
        if (!getVisible(el)) continue;
        const aria = clean(el.getAttribute("aria-label") || "");
        if (!aria) continue;
        seenByCandidates.push(aria.replace(/^Visto por\s+/i, "").replace(/^Seen by\s+/i, ""));
      }
      const fromSeenBy = pickBestConversationTitle(seenByCandidates);
      if (fromSeenBy) return fromSeenBy;

      // 2) Título semântico na área de cabeçalho da conversa.
      const headingCandidates = Array.from(document.querySelectorAll('h1 span, h2 span, h3 span, [role="heading"] span'))
        .filter((el) => getVisible(el))
        .map((el) => clean(el.textContent || ""));
      const fromHeading = pickBestConversationTitle(headingCandidates);
      if (fromHeading) return fromHeading;

      // 3) Seletor concreto legado do snippet.
      const nodes = Array.from(document.querySelectorAll(selector));
      const fromLegacySelector = pickBestConversationTitle(
        nodes.filter((el) => getVisible(el)).map((el) => clean(el.textContent || ""))
      );
      if (fromLegacySelector) return fromLegacySelector;

      // 4) Fallback controlado (ainda exige padrão "Nome · Título").
      const fallback = pickBestConversationTitle(
        Array.from(document.querySelectorAll("span"))
          .filter((el) => getVisible(el))
          .map((el) => clean(el.textContent || ""))
      );
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
    const maxAttempts = Math.max(
      1,
      Math.min(20, Number(process.env.VIRTUS_DELTA_CITY_DOM_RETRY_ATTEMPTS || 12) || 12)
    );
    const retryIntervalMs = Math.max(
      80,
      Math.min(600, Number(process.env.VIRTUS_DELTA_CITY_DOM_RETRY_INTERVAL_MS || 250) || 250)
    );
    const scanLimit = Math.max(
      50,
      Math.min(500, Number(process.env.VIRTUS_DELTA_CITY_DOM_SCAN_LIMIT || 300) || 300)
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const res = await page.evaluate((maxNodes) => {
        const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
        // Formato alvo: "Cidade, UF" ou "Cidade - UF" (normalizado para "Cidade (UF)").
        const GEO_RE = /([A-ZÀ-ÿ][A-ZÀ-ÿ\s]{1,60}?)\s*[,\-]\s*([A-Z]{2})\b/i;
        const pushFromText = (raw, source) => {
          const txt = clean(raw);
          if (!txt) return null;
          const m = txt.match(GEO_RE);
          if (!m || !m[1] || !m[2]) return null;
          const city = clean(m[1]);
          const uf = String(m[2] || "").trim().toUpperCase();
          if (!city || !uf) return null;
          return { value: `${city} (${uf})`, source };
        };

        // Escopo semântico: links de item + banner de perfil marketplace + spans (até limite quente).
        const nodes = Array.from(
          document.querySelectorAll('a[href*="/marketplace/item/"], div[data-testid="marketplace_profile_banner"], span')
        ).slice(0, Math.max(1, Number(maxNodes || 300) || 300));

        for (const el of nodes) {
          const t0 = clean(el.textContent || "");
          const r0 = pushFromText(t0, "semantic_node_text");
          if (r0) return { ok: true, value: r0.value, source: r0.source };

          const aria = clean(el.getAttribute && el.getAttribute("aria-label"));
          const rAria = pushFromText(aria, "semantic_node_aria_label");
          if (rAria) return { ok: true, value: rAria.value, source: rAria.source };

          const title = clean(el.getAttribute && el.getAttribute("title"));
          const rTitle = pushFromText(title, "semantic_node_title");
          if (rTitle) return { ok: true, value: rTitle.value, source: rTitle.source };

          const testid = clean(el.getAttribute && el.getAttribute("data-testid"));
          const rTest = pushFromText(testid, "semantic_node_data_testid");
          if (rTest) return { ok: true, value: rTest.value, source: rTest.source };
        }

        return { ok: false, value: null, source: null };
      }, scanLimit);

      const v = res && res.ok ? String(res.value || "").trim() : "";
      if (v) {
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
              source: String(res && res.source || "").slice(0, 60) || null,
              attempt: Number(attempt + 1)
            }
          });
        } catch (_) {}
        // Trava final: formato (UF) + nome plausível (nunca título/marketing tipo "Conseguimos Fazer O Frete Em X").
        const normStr = String(normalized || "").trim();
        if (/^[^()]{2,80}\s*\(\s*[A-Z]{2}\s*\)$/.test(normStr)) {
          const cityOnly = normStr.replace(/\s*\(\s*[A-Z]{2}\s*\)\s*$/i, "").trim();
          const cityKey = cityOnly
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();
          const words = cityOnly.split(/\s+/).filter(Boolean);
          const looksLikeAdCopy = /\b(conseguimos|podemos|fazer|frete|transporte|whatsapp|chama|chamar|disposi[cç][aã]o|an[uú]ncio|seminovo|usado|venda|vende|vendo|pre[cç]o|parcelas?|entrada)\b/i.test(
            cityKey
          );
          if (words.length >= 1 && words.length <= 5 && !looksLikeAdCopy) {
            return normalized;
          }
        }
      }

      if (attempt < (maxAttempts - 1)) {
        await new Promise((resolve) => setTimeout(resolve, retryIntervalMs));
      }
    }
    return null;
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
  const classic = [
    `a[href="/messages/t/${t}/"]`,
    `a[href="/messages/t/${t}"]`,
    `a[href*="/messages/t/${t}"]`,
  ];
  const e2ee = [
    `a[href="/messages/e2ee/t/${t}/"]`,
    `a[href="/messages/e2ee/t/${t}"]`,
    `a[href*="/messages/e2ee/t/${t}"]`,
  ];
  const selectors = t.length >= 18 ? [...e2ee, ...classic] : [...classic, ...e2ee];
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
        if (pathNow.includes("/messages") && searchNow.includes("folder=marketplace")) return true;

        // Thread aberto: confiar no chrome Marketplace (h1/grid/botao pressed).
        // Nao exigir folder=marketplace na URL — Messenger frequentemente omite isso.
        if (isThreadView) {
          const h1s = Array.from(document.querySelectorAll("h1,[role='heading']"));
          const hasMarketplaceHeading = h1s.some((h) =>
            String(h.textContent || "").trim().toLowerCase() === "marketplace"
          );
          const gridLabels = Array.from(document.querySelectorAll('[role="grid"][aria-label]'));
          const hasMarketplaceGrid = gridLabels.some((g) =>
            String(g.getAttribute("aria-label") || "").trim().toLowerCase().includes("marketplace")
          );
          if (hasMarketplaceHeading || hasMarketplaceGrid) return true;
          for (const b of document.querySelectorAll('div[role="button"], [role="button"]')) {
            const label = String(b.getAttribute("aria-label") || b.innerText || "").toLowerCase();
            if (!label.includes("marketplace")) continue;
            if (b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-current") === "page") return true;
          }
        }


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
  const maxRounds = Math.max(3, MARKETPLACE_STABILITY_ROUNDS + 2);

  for (let i = 0; i < maxRounds; i++) {
    if (i > 0) await humanPause("domSettle", null);
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

  // Só respiro curto se ainda não estabilizou nas primeiras rodadas.
  if (stableRounds < MARKETPLACE_STABILITY_ROUNDS) {
    await humanPause("marketplaceLoad", `${label}_final_load`);
  } else {
    await humanPause("domSettle", `${label}_ready`);
  }
}

async function waitForMessagesBootStable(page, label = "messages_boot_stable") {
  let stableRounds = 0;
  let lastSig = "";
  const maxRounds = Math.max(MESSAGES_BOOT_STABILITY_ROUNDS + 2, 3);

  for (let i = 0; i < maxRounds; i++) {
    if (i > 0) await humanPause("domSettle", `${label}_dom_settle`);
    let ok = false;
    let sig = "";
    try {
      const out = await page.evaluate(() => {
        try {
          const ready = document.readyState === "complete" || document.readyState === "interactive";
          const path = String(location.pathname || "").toLowerCase();
          const isMessages = path.includes("/messages");
          const inThreadPath = /\/messages\/(?:e2ee\/)?t\//.test(path);
          const busy = !!document.querySelector('[aria-busy="true"]');
          const tablist = !!document.querySelector('[role="tablist"]');
          const inboxSearch =
            !!document.querySelector('input[aria-label*="Pesquisar no Messenger"]') ||
            !!document.querySelector('input[aria-label*="Search in Messenger"]');
          const threadCount = Math.min(
            50,
            document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]').length
          );
          const lexicalEditors = Math.min(5, document.querySelectorAll('div[data-lexical-editor="true"]').length);
          const composerReady = lexicalEditors > 0;
          const hasMessagesSignals = tablist || inboxSearch || threadCount > 0 || composerReady;
          const sig0 = `${path}|tabs=${tablist ? 1 : 0}|search=${inboxSearch ? 1 : 0}|threads=${threadCount}|threadPath=${inThreadPath ? 1 : 0}|composer=${composerReady ? 1 : 0}`;
          return {
            ok: ready && isMessages && !busy && hasMessagesSignals,
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

async function __injectAntiSelectionCss(page, { profileName = null, reason = "" } = {}) {
  try {
    if (!page) return false;
    const ok = await page
      .evaluate(() => {
        try {
          const id = "virtus_antiselect_style_v1";
          if (document.getElementById(id)) return true;
          const style = document.createElement("style");
          style.id = id;
          style.innerHTML =
            "* { user-select: none !important; -webkit-user-select: none !important; -moz-user-select: none !important; -ms-user-select: none !important; }";
          const head = document.head || document.querySelector("head");
          if (head) {
            head.appendChild(style);
            return true;
          }
          (document.documentElement || document.body || document).appendChild(style);
          return true;
        } catch {
          return false;
        }
      })
      .catch(() => false);
    try {
      __forensicEdgeEmit({
        account_login: (profileName != null) ? String(profileName || "").trim() || null : null,
        thread_key: null,
        flow_stage: "selection_css_injected",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          ok: !!ok,
          reason: String(reason || "").slice(0, 80) || null,
          ts_ms: Date.now(),
        },
      });
    } catch (_) {}
    return !!ok;
  } catch {
    return false;
  }
}

async function waitMarketplaceActiveStable(page, { timeoutMs = 60000, rounds = 2 } = {}) {
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
    await sleep(Math.max(350, MARKETPLACE_STABILITY_GAP_MS));
  }
  return false;
}

/**
 * Espera o FEED de chats do Marketplace ficar pronto (filtro ativo + rows/links).
 * Evita clicar no card enquanto a grade ainda está montando.
 */
async function waitForMarketplaceFeedReady(page, { timeoutMs = 70000, minThreadLinks = 1 } = {}) {
  const start = Date.now();
  let lastCount = 0;
  let stableHits = 0;
  const need = Math.max(1, Number(minThreadLinks || 1) || 1);
  while (Date.now() - start < timeoutMs) {
    const snap = await page
      .evaluate((minNeed) => {
        try {
          const ready = document.readyState === "complete" || document.readyState === "interactive";
          const busy = !!document.querySelector('[aria-busy="true"]');
          const path = String(location.pathname || "").toLowerCase();
          const search = String(location.search || "").toLowerCase();
          const isMessages = path.includes("/messages");
          const folderMp = search.includes("folder=marketplace");
          const h1s = Array.from(document.querySelectorAll("h1,[role='heading']"));
          const hasMpHeading = h1s.some((h) =>
            String(h.textContent || "").trim().toLowerCase() === "marketplace"
          );
          const links = Array.from(
            document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]')
          ).filter((a) => {
            const r = a.getBoundingClientRect();
            return r && r.width > 2 && r.height > 2;
          });
          const rows = document.querySelectorAll('[role="row"]').length;
          return {
            ok:
              ready &&
              !busy &&
              isMessages &&
              (folderMp || hasMpHeading) &&
              links.length >= minNeed,
            links: links.length,
            rows,
            folderMp,
            hasMpHeading,
          };
        } catch (_) {
          return { ok: false, links: 0, rows: 0 };
        }
      }, need)
      .catch(() => ({ ok: false, links: 0, rows: 0 }));

    const count = Number(snap && snap.links || 0) || 0;
    if (snap && snap.ok) {
      if (count === lastCount && count >= need) stableHits += 1;
      else stableHits = 1;
      lastCount = count;
      // 1 hit com feed ok já basta — segundo hit era timer engessado.
      if (stableHits >= 1) {
        try {
          logInfo(
            `[virtusDelta][marketplace_feed] ready links=${count} rows=${Number(snap.rows || 0) || 0}`
          );
        } catch (_) {}
        return { ok: true, links: count, rows: Number(snap.rows || 0) || 0 };
      }
    } else {
      stableHits = 0;
      lastCount = count;
    }
    await sleep(Math.max(350, Math.floor(MARKETPLACE_STABILITY_GAP_MS * 0.6)));
  }
  try {
    logInfo(`[virtusDelta][marketplace_feed] timeout links=${lastCount}`);
  } catch (_) {}
  return { ok: false, links: lastCount, timeout: true };
}

/**
 * Pedido de mensagem: botão "Aceitar" bloqueia o composer.
 * Clica Aceitar (nunca Sair/Excluir) e espera o Lexical aparecer.
 */
async function clickAcceptMessageRequestIfPresent(page, ctx = {}) {
  if (!page) return { ok: false, clicked: false, reason: "no_page" };
  const forensicAccountLogin =
    ctx && ctx.account_login != null ? String(ctx.account_login || "").trim() : null;
  const forensicThreadKey =
    ctx && ctx.thread_key != null ? String(ctx.thread_key || "").trim() : null;

  const hasComposer = async () => {
    const h = await page
      .$('div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]')
      .catch(() => null);
    return !!h;
  };

  if (await hasComposer()) {
    return { ok: true, clicked: false, reason: "composer_already_ready" };
  }

  let clicked = false;
  try {
    clicked = await page.evaluate(() => {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const isAcceptLabel = (s) => {
        const t = norm(s);
        return t === "aceitar" || t === "accept" || t === "accept request" || t === "aceitar solicitação";
      };
      const candidates = Array.from(
        document.querySelectorAll('[role="button"][aria-label], [role="button"]')
      );
      for (const el of candidates) {
        const al = el.getAttribute("aria-label") || "";
        const txt = el.innerText || el.textContent || "";
        if (!isAcceptLabel(al) && !isAcceptLabel(txt)) continue;
        // Evita botões vizinhos errados
        const blob = norm(`${al} ${txt}`);
        if (blob.includes("sair") || blob.includes("excluir") || blob.includes("delete") || blob.includes("decline")) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (!(r && r.width > 2 && r.height > 2)) continue;
        try {
          el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        } catch (_) {}
        try {
          el.click();
          return true;
        } catch (_) {
          const host = el.closest('[role="button"]') || el;
          try {
            host.click();
            return true;
          } catch (_) {}
        }
      }
      // Fallback: span "Aceitar" → botão pai
      for (const span of document.querySelectorAll("span")) {
        if (!isAcceptLabel(span.textContent || "")) continue;
        const btn = span.closest('[role="button"]');
        if (!btn) continue;
        const r = btn.getBoundingClientRect();
        if (!(r && r.width > 2 && r.height > 2)) continue;
        try {
          btn.click();
          return true;
        } catch (_) {}
      }
      return false;
    });
  } catch (_) {
    clicked = false;
  }

  try {
    __forensicEdgeEmit({
      account_login: forensicAccountLogin,
      thread_key: forensicThreadKey,
      flow_stage: "message_request_accept",
      details: {
        tag: "FORENSIC_DOM_REVERSE",
        clicked: !!clicked,
        ts_ms: Date.now(),
      },
    });
  } catch (_) {}

  if (!clicked) {
    return { ok: false, clicked: false, reason: "accept_button_not_found" };
  }

  await humanPause("postThreadOpen", "post_accept_message_request");
  try {
    await page.waitForSelector(
      'div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]',
      { timeout: 12000 }
    );
  } catch (_) {}

  const ready = await hasComposer();
  try {
    logInfo(
      `[virtusDelta][accept] clicked=sim composer_ready=${ready ? "sim" : "nao"} thread=${forensicThreadKey || "-"}`
    );
  } catch (_) {}
  return { ok: ready, clicked: true, composer_ready: ready };
}

async function ensureMarketplaceFilterActiveCore(page) {
  const now = Date.now();
  const deadline = now + DELTA_MARKETPLACE_ACTIVATE_BUDGET_MS;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const guard = (page && page.__virtusDeltaMarketplaceGuard) ? page.__virtusDeltaMarketplaceGuard : {};
  const lastClickAt = Number(guard.lastClickAt || 0) || 0;
  const inFlight = Number(guard.inFlightUntil || 0) || 0;
  if (inFlight > now) {
    return { ok: false, skipped: true, reason: "in_flight_guard", active_before: false, active_after: false };
  }

  // Thread aberto (/messages/t/...) NAO e feed. Chrome Marketplace no DOM nao basta:
  // early-return aqui pula o clique e engessa a aba no chat antigo (regressao v4).
  let onThreadView = false;
  try {
    const hrefNow = String(page.url ? page.url() : "");
    onThreadView = __isMessengerThreadUrl(hrefNow);
  } catch (_) {
    onThreadView = false;
  }

  const activeBefore = await isMarketplaceFilterActive(page);
  if (activeBefore && !onThreadView) {
    try { page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: now }; } catch (_) {}
    logInfo("[virtusDelta][marketplace] filter_already_active=sim");
    return { ok: true, already_active: true, active_after: true };
  }
  if (activeBefore && onThreadView) {
    logInfo("[virtusDelta][marketplace] already_active_but_thread_open_force_feed=1");
  }

  // Feed ja aberto (lista, nao thread) sem folder= na URL: nao reclicar / nao goto.
  if (!onThreadView) {
    try {
      const feedOpen = await page.evaluate(() => {
        try {
          const href = String(location.href || '');
          const path = String(location.pathname || '').toLowerCase();
          if (!path.includes('/messages')) return false;
          if (path.includes('/messages/t/') || path.includes('/messages/e2ee/t/')) return false;
          const threads = document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]').length;
          if (threads < 1) return false;
          const h1 = Array.from(document.querySelectorAll('h1')).some((n) =>
            /marketplace/i.test(String(n.textContent || '').trim())
          );
          const grid = !!document.querySelector('[role="grid"][aria-label*="Marketplace" i]');
          const pressed = Array.from(
            document.querySelectorAll('[role="button"][aria-pressed="true"], [role="button"][aria-current="page"]')
          ).some((el) => /marketplace/i.test(String(el.getAttribute('aria-label') || el.textContent || '')));
          return !!(h1 || grid || pressed || /[?&]folder=marketplace\b/i.test(href));
        } catch (_) {
          return false;
        }
      });
      if (feedOpen) {
        try {
          page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: Date.now() };
        } catch (_) {}
        logInfo('[virtusDelta][marketplace] feed_already_open_trust=1');
        return { ok: true, already_active: true, feed_trust: true, active_before: false, active_after: true };
      }
    } catch (_) {}
  }

  // Clique recente: espera curta; se o DOM nao confirmar, fail-open (nao gastar o budget).
  if (lastClickAt && now - lastClickAt < 45000) {
    const recentWait = Math.min(12_000, remainingMs());
    if (recentWait >= 1500) {
      await waitMarketplaceActiveStable(page, { timeoutMs: recentWait, rounds: 2 }).catch(() => false);
    }
    const activeAfterRecent = await isMarketplaceFilterActive(page);
    if (activeAfterRecent) {
      try { page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: Date.now() }; } catch (_) {}
      return { ok: true, already_active: true, guarded_recent_click: true, active_before: activeBefore, active_after: true };
    }
    try { page.__virtusDeltaMarketplaceGuard = { ...guard, lastStableAt: Date.now() }; } catch (_) {}
    logInfo("[virtusDelta][marketplace] recent_click_fail_open=1");
    return {
      ok: true,
      already_active: true,
      guarded_recent_click: true,
      fail_open: true,
      active_before: activeBefore,
      active_after: true,
    };
  }

  if (remainingMs() < 2500) {
    return { ok: false, reason: "activate_budget_exhausted_before_click", active_before: activeBefore, active_after: false };
  }

  logInfo("[virtusDelta][marketplace] activating_filter...");
  try {
    page.__virtusDeltaMarketplaceGuard = {
      ...guard,
      inFlightUntil: Date.now() + Math.min(20_000, Math.max(8_000, remainingMs())),
    };
  } catch (_) {}
  // Nao repetir 5 rounds de Messages boot aqui (ja rodou no worker boot).
  await waitForMarketplaceUiStable(page, "marketplace_pre_click").catch(() => false);
  if (remainingMs() > 4000) {
    await humanPause("preMarketplace", "pre_marketplace_click");
  }
  const click = await clickMarketplaceFilterIfPresent(page);
  const clickTrusted = __marketplaceClickTrusted(click);
  try {
    page.__virtusDeltaMarketplaceGuard = {
      ...(page.__virtusDeltaMarketplaceGuard || {}),
      inFlightUntil: 0,
      lastClickAt: (click && click.changed) || clickTrusted ? Date.now() : lastClickAt,
    };
  } catch (_) {}
  if (remainingMs() > 3500) {
    await humanPause("postMarketplace", "post_marketplace_click");
  }

  let activeAfter = false;
  let trustReason = null;
  // Clique visualmente selecionado = filtro ativo. O detector DOM (aria-*) falha com frequencia.
  if (clickTrusted) {
    activeAfter = true;
    trustReason = "selected_after_click";
    logInfo("[virtusDelta][marketplace] trust_selected_after_click=1");
  } else {
    const waitMs = Math.min(12_000, remainingMs());
    if (waitMs >= 1200) {
      activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: waitMs, rounds: 2 });
    } else {
      activeAfter = await isMarketplaceFilterActive(page);
    }
  }

  // Um retry curto so se ainda houver budget e o primeiro clique nao mudou nada.
  if (!activeAfter && !clickTrusted && !(click && click.changed) && remainingMs() > 10_000) {
    await waitForMarketplaceUiStable(page, "marketplace_safe_retry").catch(() => false);
    const retry = await clickMarketplaceFilterIfPresent(page);
    if (__marketplaceClickTrusted(retry) || (retry && retry.changed)) {
      activeAfter = true;
      trustReason = __marketplaceClickTrusted(retry) ? "retry_selected" : "retry_changed";
      try {
        page.__virtusDeltaMarketplaceGuard = {
          ...(page.__virtusDeltaMarketplaceGuard || {}),
          lastClickAt: Date.now(),
        };
      } catch (_) {}
    } else {
      const retryWait = Math.min(8_000, remainingMs());
      if (retryWait >= 1200) {
        activeAfter = await waitMarketplaceActiveStable(page, { timeoutMs: retryWait, rounds: 2 });
      }
    }
  }

  // Fail-open: clique com mudanca de sidebar / selecao -> libera hands (nao bloqueia reply).
  if (!activeAfter && (clickTrusted || (click && click.changed))) {
    activeAfter = true;
    trustReason = trustReason || "fail_open_click_changed";
    logInfo(`[virtusDelta][marketplace] fail_open_after_click=1 reason=${trustReason}`);
  }

  let routeFallback = null;
  // NUNCA page.goto(?folder=marketplace): causa maw_proxy + reload + engessa hands.

  let feedReady = null;
  if (activeAfter && remainingMs() > 2500) {
    feedReady = await waitForMarketplaceFeedReady(page, {
      timeoutMs: Math.min(18_000, remainingMs()),
      minThreadLinks: 1,
    }).catch(() => null);
    try {
      page.__virtusDeltaMarketplaceGuard = {
        ...(page.__virtusDeltaMarketplaceGuard || {}),
        lastStableAt: Date.now(),
      };
    } catch (_) {}
  }

  logInfo(
    `[virtusDelta][marketplace] activate result=${JSON.stringify({
      ...click,
      active_before: activeBefore,
      active_after: activeAfter,
      trust_reason: trustReason,
      feed_ready: !!(feedReady && feedReady.ok),
      feed_links: Number(feedReady && feedReady.links || 0) || 0,
      route_fallback: routeFallback,
      budget_ms: DELTA_MARKETPLACE_ACTIVATE_BUDGET_MS,
      remaining_ms: remainingMs(),
    })}`
  );
  return {
    ...click,
    ok: !!activeAfter,
    active_before: activeBefore,
    active_after: activeAfter,
    trust_reason: trustReason,
    feed_ready: !!(feedReady && feedReady.ok),
    route_fallback: routeFallback,
  };
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

async function ensureMarketplaceFilterActiveFast(page) {
  // "Fast" legado virou caminho paciente: mesma disciplina do core
  // (boot Messages → UI estável → clique → feed pronto). Sem atropelo.
  if (!page) return { ok: false, error: "no_page", quick_path: false };
  const out = await ensureMarketplaceFilterActive(page);
  return { ...(out && typeof out === "object" ? out : {}), quick_path: false, patient_fast: true };
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
  let kickTimer = null;

  const isHumanBrowserHold = () => {
    try {
      return !!(page && page.__virtusDeltaHumanHold === true);
    } catch (_) {
      return false;
    }
  };

  const clearOutsideTimers = (guard = {}) => {
    try {
      page.__virtusDeltaMarketplaceGuard = {
        ...guard,
        marketplaceInactiveSince: 0,
        outsideMessagesSince: 0,
      };
    } catch (_) {}
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (page && page.__virtusDeltaReplyInFlight) {
        return;
      }
      // Humano invocado: browser é do operador. Nunca puxar de volta para /messages.
      // Flag na page sobrevive a orphan de setInterval se stopVirtus falhar/atrasar.
      if (isHumanBrowserHold()) {
        clearOutsideTimers((page && page.__virtusDeltaMarketplaceGuard) || {});
        return;
      }
      const currentUrl = String(page.url ? page.url() : "").toLowerCase();
      if (!currentUrl.includes("facebook.com")) return;
      const guard = (page && page.__virtusDeltaMarketplaceGuard) ? page.__virtusDeltaMarketplaceGuard : {};
      const now = Date.now();

      // Chat aberto (/messages/t/...) NÃO é "marketplace inativo".
      // Reativar filtro aqui rouba a aba do reply e cria o loop visto nos logs
      // (activate → active_after=false → reactivate em todas as contas).
      if (__isMessengerThreadUrl(currentUrl)) {
        clearOutsideTimers(guard);
        return;
      }

      // Cooldown após activate falho — evita DOS do host com 20 workers em loop.
      const failCooldownUntil = Number(guard.enforcerFailCooldownUntil || 0) || 0;
      if (failCooldownUntil > now) {
        return;
      }

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
        // Re-checa hold imediatamente antes do goto (invoke pode ter armado no meio do tick).
        if (isHumanBrowserHold() || stopped) {
          clearOutsideTimers((page && page.__virtusDeltaMarketplaceGuard) || {});
          return;
        }
        logInfo(
          `[virtusDelta][marketplace_enforcer] scope=${scope} action=return_messages reason=outside_messages outside_for_ms=${outsideFor} url=${currentUrl}`
        );
        try {
          const connectLane = require("./connectLane.js");
          await connectLane.withHeavyNav({ kind: "delta_return_messages", nome: String(scope || "").slice(0, 120) }, async () => {
            await page.goto("https://www.facebook.com/messages", { waitUntil: "domcontentloaded", timeout: 45000 });
          });
        } catch (_) {}
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
            enforcerFailCooldownUntil: 0,
          };
        } catch (_) {}
        return;
      }
      // Janela de calma também quando estamos em /messages (inbox):
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
      if (!(out && out.active_after)) {
        const until = Date.now() + DELTA_MARKETPLACE_ENFORCER_FAIL_COOLDOWN_MS;
        try {
          page.__virtusDeltaMarketplaceGuard = {
            ...((page && page.__virtusDeltaMarketplaceGuard) || {}),
            enforcerFailCooldownUntil: until,
            marketplaceInactiveSince: 0,
          };
        } catch (_) {}
        logInfo(
          `[virtusDelta][marketplace_enforcer] scope=${scope} action=fail_cooldown cooldown_ms=${DELTA_MARKETPLACE_ENFORCER_FAIL_COOLDOWN_MS} until=${until}`
        );
      }
    } catch (e) {
      logInfo(
        `[virtusDelta][marketplace_enforcer] scope=${scope} action=fail err=${e && e.message ? e.message : String(e)}`
      );
      try {
        page.__virtusDeltaMarketplaceGuard = {
          ...((page && page.__virtusDeltaMarketplaceGuard) || {}),
          enforcerFailCooldownUntil: Date.now() + DELTA_MARKETPLACE_ENFORCER_FAIL_COOLDOWN_MS,
          marketplaceInactiveSince: 0,
        };
      } catch (_) {}
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => {});
  }, DELTA_MARKETPLACE_ENFORCER_INTERVAL_MS);
  timer.unref?.();
  kickTimer = setTimeout(() => tick().catch(() => {}), 2500);
  try { kickTimer.unref?.(); } catch (_) {}
  logInfo(
    `[virtusDelta][marketplace_enforcer] scope=${scope} status=armed interval_ms=${DELTA_MARKETPLACE_ENFORCER_INTERVAL_MS} fail_cooldown_ms=${DELTA_MARKETPLACE_ENFORCER_FAIL_COOLDOWN_MS}`
  );

  return {
    stop: () => {
      stopped = true;
      try { clearInterval(timer); } catch (_) {}
      try { if (kickTimer) clearTimeout(kickTimer); } catch (_) {}
      kickTimer = null;
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

async function prepareDomForNetworkLead(page, threadKey, { fastMarketplace = false } = {}) {
  const t = String(threadKey || "").trim();
  logDelta("CITY", `🏙️ Extraindo link do item e coletando a cidade de origem no DOM...`, { threadKey: t });

  // Inteligente: se o card já está no DOM, não martela Marketplace/feed.
  let cardVisible = await isThreadCardVisible(page, t).catch(() => false);
  if (cardVisible) {
    const mpActive = DELTA_MARKETPLACE_AUTOFILTER_ENABLED
      ? await isMarketplaceFilterActive(page).catch(() => false)
      : false;
    logInfo(
      `[virtusDelta][dom_prep] thread_key=${t} card_visible=sim marketplace_active=${mpActive ? "sim" : "nao"} skip_activate=sim`
    );
    return {
      ok: true,
      cardVisible: true,
      marketplace: { ok: true, skipped: true, reason: "card_already_visible", active_after: !!mpActive },
    };
  }

  // Budget curto: reply nao pode esperar 3–5min de Marketplace.
  const mp = DELTA_MARKETPLACE_AUTOFILTER_ENABLED
    ? await __raceMarketplaceActivate(page, {
        timeoutMs: Math.min(
          DELTA_MARKETPLACE_ACTIVATE_BUDGET_MS,
          Number(fastMarketplace ? 12_000 : 20_000) || 20_000
        ),
        reason: fastMarketplace ? "dom_prep_fast" : "dom_prep",
      })
    : { ok: true, skipped: true, reason: "autofilter_disabled", active_after: false };

  if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED && mp && mp.active_after) {
    await waitForMarketplaceFeedReady(page, {
      timeoutMs: fastMarketplace ? 6_000 : 10_000,
      minThreadLinks: 1,
    }).catch(() => null);
  }

  cardVisible = await isThreadCardVisible(page, t);
  logInfo(
    `[virtusDelta][dom_prep] thread_key=${t} card_visible=${cardVisible ? "sim" : "nao"} marketplace_active=${mp.active_after ? "sim" : "nao"} timed_out=${mp.timed_out ? "sim" : "nao"}`
  );

  if (!cardVisible) {
    const root = await forceSidebarRefreshByMessagesRoot(page);
    logInfo(`[virtusDelta][dom_force] messages_root result=${JSON.stringify(root)}`);
    await humanPause("domSettle", "dom_prep_root_settle");
    if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED && !(await isMarketplaceFilterActive(page))) {
      await __raceMarketplaceActivate(page, { timeoutMs: 12_000, reason: "dom_prep_retry" }).catch(() => null);
      await waitForMarketplaceFeedReady(page, { timeoutMs: 6_000, minThreadLinks: 1 }).catch(() => null);
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

function canonicalizeMarketplaceItemLink(raw) {
  const input = String(raw || "").replace(/&amp;/gi, "&").trim();
  if (!input) return "";
  if (/link\s*n[aã]o\s*coletado/i.test(input)) return "";
  // login/?next=%2Fmarketplace%2F sem item → lixo (nunca vira link de anúncio).
  try {
    const parsed = input.startsWith("http")
      ? new URL(input)
      : input.startsWith("/")
        ? new URL(input, "https://www.facebook.com")
        : null;
    if (!parsed) return "";
    const host = String(parsed.hostname || "").toLowerCase();
    if (host && !(host.includes("facebook.com") || host.includes("fb.com") || host.includes("messenger.com"))) {
      return "";
    }
    let pathForItem = String(parsed.pathname || "");
    // Se veio wrapper de login, só aceita quando next= aponta pro item real.
    if (/\/login\b/i.test(pathForItem)) {
      const nextRaw = String(parsed.searchParams.get("next") || "").trim();
      if (!nextRaw) return "";
      let decoded = nextRaw;
      try {
        decoded = decodeURIComponent(nextRaw);
      } catch (_) {}
      try {
        const nextUrl = decoded.startsWith("http")
          ? new URL(decoded)
          : new URL(decoded.startsWith("/") ? decoded : `/${decoded}`, "https://www.facebook.com");
        pathForItem = String(nextUrl.pathname || "");
      } catch (_) {
        return "";
      }
    }
    const m = pathForItem.match(/\/marketplace\/item\/([0-9A-Za-z_-]+)/i);
    if (!m || !m[1]) return "";
    const itemId = String(m[1] || "").trim();
    if (!itemId) return "";
    return `https://www.facebook.com/marketplace/item/${itemId}/`;
  } catch {
    return "";
  }
}

const MARKETPLACE_ITEM_LINK_READY_SELECTOR = [
  'a[aria-label*="Ver detalhes"][href*="/marketplace/item/"]',
  'a[aria-label*="See details"][href*="/marketplace/item/"]',
  'a[aria-label*="Detalhes"][href*="/marketplace/item/"]',
  'a[href*="/marketplace/item/"][href*="referralSurface=messenger_banner"]',
  'a[href*="/marketplace/item/"]',
  'a[data-href*="/marketplace/item/"]',
  '[role="link"][href*="/marketplace/item/"]',
].join(",");

async function probeMarketplaceListingBannerState(page) {
  return page
    .evaluate(() => {
      const q = (sel) => {
        try {
          return Array.from(document.querySelectorAll(sel)).length;
        } catch (_) {
          return 0;
        }
      };
      const details = q(
        'a[aria-label*="Ver detalhes"][href*="/marketplace/item/"],a[aria-label*="See details"][href*="/marketplace/item/"],a[aria-label*="Detalhes"][href*="/marketplace/item/"]'
      );
      const messengerBanner = q('a[href*="/marketplace/item/"][href*="referralSurface=messenger_banner"]');
      const roleLink = q('[role="link"][href*="/marketplace/item/"]');
      const anyItem = q('a[href*="/marketplace/item/"],a[data-href*="/marketplace/item/"]');
      return {
        ready: details > 0 || messengerBanner > 0,
        soft_ready: anyItem > 0 || roleLink > 0,
        details_count: details,
        messenger_banner_count: messengerBanner,
        role_link_count: roleLink,
        any_item_count: anyItem,
      };
    })
    .catch(() => ({
      ready: false,
      soft_ready: false,
      details_count: 0,
      messenger_banner_count: 0,
      role_link_count: 0,
      any_item_count: 0,
    }));
}

async function waitForMarketplaceListingBanner(page, { timeoutMs = 8000 } = {}) {
  const t0 = Date.now();
  const budget = Math.max(1200, Number(timeoutMs || 8000) || 8000);
  const deadline = t0 + budget;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeMarketplaceListingBannerState(page);
    if (last && last.ready) {
      return { ok: true, quality: "banner", elapsed_ms: Date.now() - t0, ...last };
    }
    const remain = deadline - Date.now();
    if (remain <= 40) break;
    try {
      await page.waitForSelector(MARKETPLACE_ITEM_LINK_READY_SELECTOR, {
        timeout: Math.min(1100, Math.max(120, remain)),
      });
    } catch (_) {}
    await sleep(randomBetween(320, 720));
  }
  if (last && last.soft_ready) {
    return { ok: true, quality: "soft", elapsed_ms: Date.now() - t0, ...last };
  }
  return { ok: false, quality: "none", elapsed_ms: Date.now() - t0, ...(last || {}) };
}

async function extractMarketplaceItemLinkDetailed(page) {
  const rawCandidates = await page
    .evaluate(() => {
      const out = [];
      const push = (raw, source) => {
        const h = String(raw || "").trim();
        if (!h || !/\/marketplace\/item\//i.test(h)) return;
        out.push({ raw: h, source: String(source || "").trim() || "unknown" });
      };

      // Prioridade máxima: CTA de detalhe do próprio card do chat.
      const detailAnchors = Array.from(
        document.querySelectorAll(
          'a[aria-label*="Ver detalhes"][href],a[aria-label*="See details"][href],a[aria-label*="Detalhes"][href]'
        )
      );
      for (const a of detailAnchors) {
        try {
          push(a.getAttribute("href"), "details_anchor");
        } catch (_) {}
      }

      // Links com referral do messenger tendem a ser o item correto do thread.
      const messengerAnchors = Array.from(
        document.querySelectorAll('a[href*="/marketplace/item/"][href*="referralSurface=messenger_banner"]')
      );
      for (const a of messengerAnchors) {
        try {
          push(a.getAttribute("href"), "messenger_referral_anchor");
        } catch (_) {}
      }

      const roleLinks = Array.from(document.querySelectorAll('[role="link"][href*="/marketplace/item/"]'));
      for (const a of roleLinks) {
        try {
          push(a.getAttribute("href"), "role_link_href");
        } catch (_) {}
      }

      const anchors = Array.from(
        document.querySelectorAll('a[href*="/marketplace/item/"],a[data-href*="/marketplace/item/"]')
      );
      for (const a of anchors) {
        try {
          push(a.getAttribute("href"), "generic_anchor_href");
          push(a.getAttribute("data-href"), "generic_anchor_data_href");
        } catch (_) {}
      }

      // Banner / attachment containers: sobe até 4 pais e pega âncoras internas.
      try {
        const seeds = Array.from(
          document.querySelectorAll(
            '[aria-label*="Marketplace"],[aria-label*="marketplace"],img[src*="marketplace"],img[alt*="Marketplace"]'
          )
        ).slice(0, 12);
        for (const seed of seeds) {
          let node = seed;
          for (let depth = 0; depth < 4 && node; depth += 1) {
            try {
              const localAnchors = node.querySelectorAll
                ? node.querySelectorAll('a[href*="/marketplace/item/"],a[data-href*="/marketplace/item/"]')
                : [];
              for (const a of Array.from(localAnchors || [])) {
                push(a.getAttribute("href"), "banner_container_anchor");
                push(a.getAttribute("data-href"), "banner_container_data_href");
              }
            } catch (_) {}
            node = node.parentElement;
          }
        }
      } catch (_) {}

      // Quando abre em página de item ou login interstitial, o "next" costuma carregar o item URL.
      const nextInputs = Array.from(document.querySelectorAll('input[name="next"][value*="/marketplace/item/"]'));
      for (const inp of nextInputs) {
        try {
          push(inp.getAttribute("value"), "hidden_next_input");
        } catch (_) {}
      }

      try {
        const hrefNow = String((location && location.href) || "").trim();
        if (/\/marketplace\/item\//i.test(hrefNow)) push(hrefNow, "location_href");
      } catch (_) {}

      const body = String((document.body && document.body.innerText) || "").replace(/\s+/g, " ");
      const bodyHttp =
        body.match(/https?:\/\/(?:www\.)?facebook\.com\/marketplace\/item\/[0-9A-Za-z_-]+[^\s]*/gi) || [];
      for (const h of bodyHttp) push(h, "body_http");
      const bodyRel = body.match(/\/marketplace\/item\/[0-9A-Za-z_-]+[^\s]*/gi) || [];
      for (const h of bodyRel) push(h, "body_relative");

      return out;
    })
    .catch(() => []);

  const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
  const ranked = [];
  const seen = new Set();
  const scoreOf = (raw, source) => {
    const text = String(raw || "").toLowerCase();
    let score = 0;
    if (source === "details_anchor") score += 100;
    if (source === "messenger_referral_anchor") score += 80;
    if (source === "banner_container_anchor" || source === "banner_container_data_href") score += 70;
    if (source === "role_link_href") score += 65;
    if (source === "hidden_next_input") score += 60;
    if (source === "location_href") score += 40;
    if (text.includes("referralsurface=messenger_banner")) score += 20;
    if (text.includes("ref=messenger_banner")) score += 10;
    return score;
  };

  for (const cand of candidates) {
    const raw = String((cand && cand.raw) || "").trim();
    const source = String((cand && cand.source) || "").trim();
    const canonical = canonicalizeMarketplaceItemLink(raw);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    ranked.push({ link: canonical, score: scoreOf(raw, source), source });
  }

  ranked.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const top = ranked[0] || null;
  return {
    link: top ? String(top.link || "").trim() : "",
    candidates_count: ranked.length,
    top_source: top ? String(top.source || "").trim() || null : null,
    top_score: top ? Number(top.score || 0) || 0 : 0,
  };
}

async function extractMarketplaceItemLink(page) {
  const detailed = await extractMarketplaceItemLinkDetailed(page).catch(() => null);
  return String((detailed && detailed.link) || "").trim();
}

async function extractMarketplaceItemLinkWithRetry(
  page,
  {
    attempts = null,
    readinessTimeoutMs = null,
    forensicAccountLogin = null,
    threadKey = null,
    skipReadiness = false,
  } = {}
) {
  const defaultAttempts = Math.max(4, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 8) || 8);
  const maxAttempts = Math.max(2, Math.min(12, Number(attempts != null ? attempts : defaultAttempts) || defaultAttempts));
  const readyBudget = Math.max(
    1500,
    Number(readinessTimeoutMs != null ? readinessTimeoutMs : process.env.VIRTUS_DELTA_LINK_READY_MS || 8000) || 8000
  );
  const t0 = Date.now();
  let ready = { ok: false, quality: "skipped", elapsed_ms: 0 };
  if (!skipReadiness) {
    ready = await waitForMarketplaceListingBanner(page, { timeoutMs: readyBudget });
    try {
      __deltaLogTriagemDom({
        stage: "link_extract_readiness",
        thread_key: threadKey || null,
        account_login: forensicAccountLogin || null,
        banner_ready: !!(ready && ready.ok),
        quality: (ready && ready.quality) || null,
        elapsed_ms: Number((ready && ready.elapsed_ms) || 0) || 0,
        details_count: Number((ready && ready.details_count) || 0) || 0,
        messenger_banner_count: Number((ready && ready.messenger_banner_count) || 0) || 0,
        any_item_count: Number((ready && ready.any_item_count) || 0) || 0,
      });
    } catch (_) {}
    // VM sob pressão: se banner ainda não veio, dá um settle extra antes do loop.
    if (!ready || !ready.ok) {
      await sleep(randomBetween(700, 1400));
    } else if (ready.quality === "soft") {
      await sleep(randomBetween(400, 900));
    }
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const detailed = await extractMarketplaceItemLinkDetailed(page).catch(() => null);
    const link = String((detailed && detailed.link) || "").trim();
    try {
      __deltaLogTriagemDom({
        stage: link ? "link_extract_hit" : "link_extract_miss",
        thread_key: threadKey || null,
        account_login: forensicAccountLogin || null,
        attempt,
        attempts_max: maxAttempts,
        elapsed_ms: Date.now() - t0,
        candidates_count: Number((detailed && detailed.candidates_count) || 0) || 0,
        top_source: (detailed && detailed.top_source) || null,
        top_score: Number((detailed && detailed.top_score) || 0) || 0,
        banner_ready: !!(ready && ready.ok),
        banner_quality: (ready && ready.quality) || null,
        item_link: link || null,
      });
    } catch (_) {}
    try {
      __forensicEdgeEmit({
        account_login: forensicAccountLogin,
        thread_key: threadKey,
        flow_stage: link ? "link_extract_hit" : "link_extract_miss",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          attempt,
          attempts_max: maxAttempts,
          elapsed_ms: Date.now() - t0,
          candidates_count: Number((detailed && detailed.candidates_count) || 0) || 0,
          top_source: (detailed && detailed.top_source) || null,
          banner_ready: !!(ready && ready.ok),
          item_link: link || null,
        },
      });
    } catch (_) {}
    if (link) return link;
    if (attempt < maxAttempts) {
      try {
        await page.waitForSelector(MARKETPLACE_ITEM_LINK_READY_SELECTOR, {
          timeout: Math.min(3600, 1000 + attempt * 450),
        });
      } catch (_) {}
      await sleep(randomBetween(450, 980));
    }
  }
  return "";
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

function normalizeComposerPayload(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function isComposerPayloadMatch(expected, actual) {
  const exp = normalizeComposerPayload(expected);
  const act = normalizeComposerPayload(actual);
  return exp === act;
}

async function waitLexicalComposerEmpty(page, { timeoutMs = 500, pollMs = 50 } = {}) {
  const timeout = Math.max(80, Number(timeoutMs || 0) || 500);
  const poll = Math.max(20, Number(pollMs || 0) || 50);
  const startedAt = Date.now();
  while ((Date.now() - startedAt) <= timeout) {
    const probe = await page.evaluate(() => {
      const el = document.querySelector('div[contenteditable="true"][role="textbox"][data-lexical-editor="true"]');
      if (!el) return { ready: false, empty: false, text: "" };
      const text = String(el.innerText || el.textContent || "").trim();
      return { ready: true, empty: text.length === 0, text: text.slice(0, 160) };
    }).catch(() => ({ ready: false, empty: false, text: "" }));
    if (probe && probe.ready && probe.empty) {
      return {
        ok: true,
        waited_ms: Date.now() - startedAt,
        text_preview: "",
      };
    }
    const elapsed = Date.now() - startedAt;
    const left = timeout - elapsed;
    if (left <= 0) break;
    await sleep(Math.min(poll, left));
  }
  const after = await readComposerText(page).catch(() => "");
  return {
    ok: !(after && after.trim()),
    waited_ms: Date.now() - startedAt,
    text_preview: String(after || "").slice(0, 160),
  };
}

async function clickStrictPhysicalSendButton(page) {
  const strictSelector = 'div[role="button"][aria-label="Pressione Enter para enviar"]';
  const strictBtn = await page.$(strictSelector).catch(() => null);
  if (!strictBtn) return false;
  const visible = await strictBtn
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return !!(r && r.width > 0 && r.height > 0);
    })
    .catch(() => false);
  if (!visible) return false;
  await strictBtn.click({ delay: clickDelayMs() }).catch(() => {});
  return true;
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
  // Pedido de mensagem: sem composer → clicar Aceitar (até 2 tentativas).
  if (!handle) {
    for (let acceptTry = 1; acceptTry <= 2 && !handle; acceptTry++) {
      const acc = await clickAcceptMessageRequestIfPresent(page, {
        account_login: forensicAccountLogin,
        thread_key: forensicThreadKey,
      }).catch(() => null);
      if (acc && acc.clicked) {
        await humanPause("domSettle", `post_accept_try_${acceptTry}`);
      } else {
        await sleep(1200);
      }
      for (const sel of sels) {
        handle = await page.$(sel).catch(() => null);
        if (handle) { matched = sel; break; }
      }
    }
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
          phase: "missing_after_accept_attempts",
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
  if (!full) return { ok: true, mode: "empty", chars: 0 };

  // Caminho primário (blindado): injeção atômica elimina risco de quebra por Shift+Enter
  // em cenários de alta carga de CPU/DOM.
  try {
    await page.keyboard.insertText(full);
    return { ok: true, mode: "insert_text_atomic", chars: full.length };
  } catch (_) {}

  for (const ch of full) {
    const keyDelayMs = randomBetween(70, 120);
    try {
      await page.keyboard.insertText(ch);
    } catch (_) {
      if (ch === "\n") {
        try {
          await page.keyboard.down("Shift");
          await page.keyboard.press("Enter");
          await page.keyboard.up("Shift");
        } catch (_) {}
        await humanPause("lineBreak", "shift_enter_fallback");
        continue;
      }
      try {
        await page.keyboard.type(ch, { delay: keyDelayMs });
      } catch (_) {
        try {
          await page.keyboard.sendCharacter(ch);
        } catch (_) {}
        await sleep(keyDelayMs);
      }
    }
  }
  return { ok: true, mode: "insert_text_char_fallback", chars: full.length };
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

async function computeVisibleThreadCardClickPlan(cardElement) {
  return await cardElement.evaluate((el) => {
    function uniq(nodes) {
      const out = [];
      const seen = new Set();
      for (const n of nodes) {
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
      return out;
    }
    function intersect(rect, vw, vh) {
      const left = Math.max(0, Number(rect.left || 0));
      const top = Math.max(0, Number(rect.top || 0));
      const right = Math.min(Number(vw || 0), Number(rect.right || 0));
      const bottom = Math.min(Number(vh || 0), Number(rect.bottom || 0));
      const width = right - left;
      const height = bottom - top;
      if (!(width > 1 && height > 1)) return null;
      return { left, top, right, bottom, width, height, area: width * height };
    }

    const vw = Math.max(0, Number(window.innerWidth || 0));
    const vh = Math.max(0, Number(window.innerHeight || 0));
    const row = el.closest('div[role="row"]') || el.closest('[role="row"]');
    const rowParent = row && row.parentElement ? row.parentElement : null;
    const targets = uniq([el, row, rowParent, el.parentElement]);

    let best = null;
    for (const target of targets) {
      try {
        const rect = target.getBoundingClientRect();
        const vis = intersect(rect, vw, vh);
        if (!vis) continue;
        if (!best || vis.area > best.visible.area) {
          best = {
            tag: String((target.tagName || '')).toLowerCase(),
            role: String(target.getAttribute('role') || ''),
            class_name: String(target.className || '').slice(0, 240),
            rect: {
              left: Number(rect.left || 0),
              top: Number(rect.top || 0),
              right: Number(rect.right || 0),
              bottom: Number(rect.bottom || 0),
              width: Number(rect.width || 0),
              height: Number(rect.height || 0),
            },
            visible: vis,
          };
        }
      } catch (_) {}
    }

    if (!best) {
      return {
        ok: false,
        reason: 'no_visible_intersection',
        viewport_w: vw,
        viewport_h: vh,
      };
    }

    const cx = best.visible.left + (best.visible.width * 0.5);
    const cy = best.visible.top + (best.visible.height * 0.5);
    const lx = best.visible.left + Math.max(10, Math.min(42, best.visible.width * 0.35));
    const ly = cy;
    return {
      ok: true,
      viewport_w: vw,
      viewport_h: vh,
      target: best,
      points: [
        { kind: 'center', x: Number(cx.toFixed(2)), y: Number(cy.toFixed(2)) },
        { kind: 'left_bias', x: Number(lx.toFixed(2)), y: Number(ly.toFixed(2)) },
      ],
    };
  }).catch(() => ({ ok: false, reason: 'evaluate_failed' }));
}

/**
 * Politica operacional: NAO navegar por gate E2EE automatico.
 * Nao clicar em "Continuar" e nao selecionar contato/nome.
 * Se o gate aparecer, o fluxo deve falhar com guardrails normais.
 */
async function dismissMessengerE2eeInterstitial(_page, {
  forensicAccountLogin = null,
} = {}) {
  try {
    __forensicEdgeEmit({
      account_login: forensicAccountLogin || null,
      thread_key: null,
      flow_stage: "e2ee_gate_policy_skip",
      details: {
        tag: "FORENSIC_DOM_REVERSE",
        policy: "no_auto_continue_no_contact_pick",
        ts_ms: Date.now(),
      },
    });
  } catch (_) {}
  return {
    ok: true,
    skipped: true,
    reason: "policy_skip_no_auto_continue",
    clicked_continuar: false,
    picked: null,
    pick_ok: false,
    pick_reason: "disabled_by_policy",
  };
}

async function runWrongThreadGuard(page, threadKey, { forensicAccountLogin = null, stage = "post_click", requireComposer = true } = {}) {
  const t = String(threadKey || "").trim();
  const expectedTarget = `(?:/messages)?/(?:e2ee/)?t/${t}`;
  const currentUrl = String(page && page.url ? page.url() : "").trim();
  let urlMatches = currentUrl ? __deltaIsThreadKeyPathMatch(currentUrl, t) : false;

  let composerCheck = { ok: true, composer_count: null, active_sidebar_href: null };
  if (requireComposer) {
    composerCheck = await page.evaluate((threadId) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r && r.width > 1 && r.height > 1;
      };

      const composers = Array.from(document.querySelectorAll('div[data-lexical-editor="true"]')).filter(isVisible);
      const active = document.querySelector('a[aria-current="page"][href], [aria-current="page"] a[href]');
      const activeHref = String((active && active.getAttribute("href")) || "").trim();
      const esc = String(threadId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // facebook /messages[/e2ee]/t/ID  OU  messenger.com [/e2ee]/t/ID | /t/ID
      const expectedHrefRe = new RegExp(`(?:/messages/(?:e2ee/)?t/|/e2ee/t/|/t/)${esc}(?:/|$)`, "i");
      const sidebarMatchesThread = !!(activeHref && expectedHrefRe.test(activeHref));
      // Sem aria-current: host já validou URL; composer único basta (layouts E2EE/messenger).
      const sidebarAbsent = !activeHref;
      return {
        ok: composers.length === 1 && (sidebarMatchesThread || sidebarAbsent),
        composer_count: composers.length,
        active_sidebar_href: activeHref || null
      };
    }, t).catch(() => ({ ok: false, composer_count: null, active_sidebar_href: null }));
  }

  if (urlMatches && composerCheck && composerCheck.ok) {
    return {
      ok: true,
      current_url: currentUrl,
      expected_target: expectedTarget,
      composer_count: composerCheck.composer_count
    };
  }

  const reason = !urlMatches
    ? "URL_mismatch_preventing_cross_routing"
    : "composer_signature_mismatch";
  try {
    __forensicEdgeEmit({
      account_login: forensicAccountLogin,
      thread_key: t,
      flow_stage: "wrong_thread_guard_blocked",
      details: {
        tag: "FORENSIC_DOM_REVERSE",
        stage,
        reason,
        current_url: currentUrl || null,
        expected_target: expectedTarget,
        composer_count: Number(composerCheck && composerCheck.composer_count || 0) || 0,
        active_sidebar_href: composerCheck && composerCheck.active_sidebar_href ? String(composerCheck.active_sidebar_href) : null,
        ts_ms: Date.now()
      }
    });
  } catch (_) {}
  return {
    ok: false,
    error: "wrong_thread_guard_blocked",
    reason,
    current_url: currentUrl,
    expected_target: expectedTarget
  };
}

// Path soberano (pathname inteiro):
//  /messages/t/ID | /messages/e2ee/t/ID | /e2ee/t/ID | /t/ID
const __DELTA_THREAD_PATH_PREFIX_RE = "^(?:/messages/(?:e2ee/)?t/|/e2ee/t/|/t/)";

function __deltaIsThreadKeyPathMatch(pathnameOrUrl, threadKey) {
  const t = String(threadKey || "").trim();
  if (!t) return false;
  const raw = String(pathnameOrUrl || "").trim();
  if (!raw) return false;
  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) path = String(new URL(raw).pathname || "");
  } catch (_) {}
  // Normaliza trailing slash único.
  path = String(path || "").replace(/\/+$/, "") || "/";
  const esc = String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${__DELTA_THREAD_PATH_PREFIX_RE}${esc}$`, "i");
  return re.test(path);
}

/** Predicate serializável p/ page.waitForFunction / evaluate (mesmo contrato do host). */
function __deltaBrowserThreadPathMatchPredicate(threadId, pathPrefixRe) {
  const path = String(location.pathname || "").replace(/\/+$/, "") || "/";
  const esc = String(threadId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = String(pathPrefixRe || "^(?:/messages/(?:e2ee/)?t/|/e2ee/t/|/t/)");
  return new RegExp(`${prefix}${esc}$`, "i").test(path);
}

function __deltaBuildThreadGotoUrlCandidates(threadKey) {
  const t = String(threadKey || "").trim();
  // Aceita qualquer thread numérico; prioridade e2ee/classic por tamanho.
  // (Filtro 12–20 fica no despacho/candidates — aqui não pode zerar o fallback.)
  if (!t || !/^\d+$/.test(t)) return [];
  const classic = [
    `https://www.facebook.com/messages/t/${t}/`,
    `https://www.facebook.com/messages/t/${t}`,
    `https://facebook.com/messages/t/${t}/`,
  ];
  const e2ee = [
    `https://www.facebook.com/messages/e2ee/t/${t}/`,
    `https://www.facebook.com/messages/e2ee/t/${t}`,
    `https://facebook.com/messages/e2ee/t/${t}/`,
  ];
  // IDs longos (Marketplace/E2EE ~18–20) priorizam e2ee; curtos priorizam classic.
  // Sempre tenta as duas famílias — sem caminho único burro.
  return t.length >= 18 ? [...e2ee, ...classic] : [...classic, ...e2ee];
}

function __deltaBuildThreadCardSelectors(threadKey) {
  const t = String(threadKey || "").trim();
  if (!t) return [];
  const classic = [
    `div[role="row"] a[href*="/messages/t/${t}"]`,
    `div[role="row"] a[href="/messages/t/${t}/"]`,
    `div[role="row"] a[href="/messages/t/${t}"]`,
  ];
  const e2ee = [
    `div[role="row"] a[href*="/messages/e2ee/t/${t}"]`,
    `div[role="row"] a[href="/messages/e2ee/t/${t}/"]`,
    `div[role="row"] a[href="/messages/e2ee/t/${t}"]`,
  ];
  return t.length >= 18 ? [...e2ee, ...classic] : [...classic, ...e2ee];
}

/** Sinais de página = thread_key errado (pessoal / login estranho). NÃO clica Continuar. */
async function __deltaProbeBadThreadPageSignals(page) {
  return page.evaluate(() => {
    try {
      const url = String(location && location.href || "");
      const path = String(location && location.pathname || "").toLowerCase();
      const loginRedirect =
        /\/login\/?/i.test(path) ||
        /\/login\/?\?/i.test(url) ||
        /\/login\.php/i.test(url);
      const marketplaceLoginNext = /next=.*marketplace/i.test(url);
      // index.php?next=…messages/t/… = sessão/boot quebrado (antes caía em e2ee_gate falso).
      const indexNextMessages =
        /\/index\.php/i.test(path) &&
        /[?&]next=/i.test(url) &&
        /messages(?:%2F|\/)/i.test(url);
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return !!(r && r.width > 1 && r.height > 1);
      };
      let composerVisible = false;
      for (const c of Array.from(document.querySelectorAll('div[data-lexical-editor="true"]'))) {
        if (isVisible(c)) { composerVisible = true; break; }
      }
      let continuarGate = false;
      for (const el of Array.from(document.querySelectorAll('div[role="button"],button,[role="link"],span'))) {
        if (!isVisible(el)) continue;
        const t = String(el.innerText || el.getAttribute("aria-label") || "").trim().toLowerCase();
        if (t === "continuar" || t === "continue") {
          continuarGate = true;
          break;
        }
      }
      return {
        login_redirect: !!(loginRedirect || marketplaceLoginNext || indexNextMessages),
        marketplace_login_next: !!marketplaceLoginNext,
        index_next_messages: !!indexNextMessages,
        continuar_gate: !!(continuarGate && !composerVisible && !indexNextMessages),
        composer_visible: composerVisible,
        url: url.slice(0, 320),
      };
    } catch {
      return null;
    }
  }).catch(() => null);
}

function __deltaIsEpochMsTokenLocal(id) {
  const s = String(id || "").trim();
  if (!/^\d{13}$/.test(s)) return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return false;
  return n >= 1_500_000_000_000 && n <= 2_200_000_000_000;
}
function __deltaIsLikelyFbProfileTokenLocal(id) {
  const s = String(id || "").trim();
  return /^\d{14}$/.test(s) && /^615/.test(s);
}
function __deltaIsGarbageThreadTokenLocal(id) {
  return __deltaIsEpochMsTokenLocal(id) || __deltaIsLikelyFbProfileTokenLocal(id);
}

function __deltaIsLikelyPersonalUserThreadKeyLocal(id) {
  const s = String(id || "").trim();
  return /^\d{15}$/.test(s) && /^1000/.test(s);
}

/** Hop só em thread marketplace clássico/17 — nunca timestamp/perfil/pessoal. */
function __deltaIsHopWorthyThreadKeyLocal(id) {
  const s = String(id || "").trim();
  if (!/^\d{15,17}$/.test(s)) return false;
  if (__deltaIsGarbageThreadTokenLocal(s)) return false;
  if (__deltaIsLikelyPersonalUserThreadKeyLocal(s)) return false;
  return true;
}

/** Mesma ordem do chooser edge: melhor primeiro; pessoal 1000… por último. */
function __deltaRankThreadKeyCandidatesLocal(candidates) {
  const list = [...new Set(
    (Array.isArray(candidates) ? candidates : [])
      .map((v) => String(v || "").trim())
      .filter((v) => /^\d{12,20}$/.test(v) && !__deltaIsGarbageThreadTokenLocal(v))
  )];
  const score = (id) => {
    const len = id.length;
    if (__deltaIsLikelyPersonalUserThreadKeyLocal(id)) return 50;
    if (len >= 15 && len <= 16) return 900;
    if (len === 17) return 850;
    if (len >= 18 && len <= 20) return 200;
    if (len >= 12 && len <= 14) return 300;
    return 10;
  };
  return list
    .map((id, idx) => ({ id, idx, score: score(id) }))
    .sort((a, b) => (b.score - a.score) || (a.idx - b.idx))
    .map((x) => x.id);
}

/** Circuit breaker: impede page.goto em loop quando sessão/boot está quebrado. */
const __deltaGotoCircuitByKey = new Map();
function __deltaGotoCircuitKey(account, thread) {
  return `${String(account || "").trim()}|${String(thread || "").trim()}`;
}
function __deltaGotoCircuitCooldownMs() {
  const n = Number(process.env.VIRTUS_DELTA_GOTO_CIRCUIT_MS || 90_000) || 90_000;
  return Math.max(45_000, Math.min(180_000, n));
}
function __deltaGotoCircuitIsOpen(account, thread) {
  const k = __deltaGotoCircuitKey(account, thread);
  const row = __deltaGotoCircuitByKey.get(k);
  if (!row) return false;
  if (Date.now() >= (Number(row.coolUntil || 0) || 0)) {
    try { __deltaGotoCircuitByKey.delete(k); } catch (_) {}
    return false;
  }
  return true;
}
function __deltaGotoCircuitPeek(account, thread) {
  const k = __deltaGotoCircuitKey(account, thread);
  const row = __deltaGotoCircuitByKey.get(k);
  if (!row) return null;
  if (Date.now() >= (Number(row.coolUntil || 0) || 0)) {
    try { __deltaGotoCircuitByKey.delete(k); } catch (_) {}
    return null;
  }
  return row;
}
function __deltaGotoCircuitClear(account, thread) {
  try { __deltaGotoCircuitByKey.delete(__deltaGotoCircuitKey(account, thread)); } catch (_) {}
}
function __deltaGotoCircuitTrip(account, thread, reason, { immediate = true } = {}) {
  const k = __deltaGotoCircuitKey(account, thread);
  const prev = __deltaGotoCircuitByKey.get(k) || { fails: 0 };
  const fails = (Number(prev.fails || 0) || 0) + 1;
  const shouldCool = immediate || fails >= 2;
  const coolUntil = shouldCool
    ? Date.now() + __deltaGotoCircuitCooldownMs()
    : (Number(prev.coolUntil || 0) || 0);
  const row = {
    coolUntil,
    fails,
    reason: String(reason || "").slice(0, 120),
    lastAt: Date.now(),
    open: shouldCool,
  };
  __deltaGotoCircuitByKey.set(k, row);
  if (shouldCool) {
    try {
      __forensicEdgeEmit({
        account_login: account ? String(account) : null,
        thread_key: thread ? String(thread) : null,
        flow_stage: "goto_circuit_tripped",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          reason: row.reason,
          fails,
          cool_until: coolUntil,
          cooldown_ms: __deltaGotoCircuitCooldownMs(),
          ts_ms: Date.now(),
        },
      });
    } catch (_) {}
  }
  return row;
}

async function __deltaTryOpenThreadByDirectGoto(page, threadKey, { forensicAccountLogin = null, stepAError = null } = {}) {
  const t = String(threadKey || "").trim();
  const acc = forensicAccountLogin ? String(forensicAccountLogin).trim() : "";

  if (__deltaIsGarbageThreadTokenLocal(t)) {
    try {
      __deltaLogTriagemDom({
        stage: "fallback_goto_garbage_token_blocked",
        thread_key: t,
        step_a_error: stepAError || null,
      });
    } catch (_) {}
    return {
      ok: false,
      error: "thread_key_garbage_token",
      opened_via: "direct_goto",
      step_a_error: stepAError || null,
    };
  }

  // Circuit aberto: soft-fail SEM navegar (mensagem segue no outbox; browser não é martelado).
  if (acc && t && __deltaGotoCircuitIsOpen(acc, t)) {
    const peek = __deltaGotoCircuitPeek(acc, t);
    try {
      __deltaLogTriagemDom({
        stage: "fallback_goto_circuit_blocked",
        thread_key: t,
        step_a_error: stepAError || null,
        circuit_reason: peek && peek.reason ? peek.reason : null,
        cool_until: peek && peek.coolUntil ? peek.coolUntil : null,
      });
    } catch (_) {}
    try {
      __forensicEdgeEmit({
        account_login: acc || null,
        thread_key: t,
        flow_stage: "goto_circuit_blocked",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          step_a_error: stepAError || null,
          circuit_reason: peek && peek.reason ? peek.reason : null,
          cool_until: peek && peek.coolUntil ? peek.coolUntil : null,
          ts_ms: Date.now(),
        },
      });
    } catch (_) {}
    return {
      ok: false,
      error: "goto_circuit_open",
      opened_via: "direct_goto",
      step_a_error: stepAError || null,
      circuit_open: true,
      cool_until: peek && peek.coolUntil ? peek.coolUntil : null,
    };
  }

  // Menos pressão: no máximo 2 URLs (classic/e2ee), sem varrer 6 gotos em loop.
  const gotoCandidates = __deltaBuildThreadGotoUrlCandidates(t).slice(0, 2);
  try {
    __deltaLogTriagemDom({
      stage: "fallback_goto_start",
      thread_key: t,
      step_a_error: stepAError || null,
      goto_url: gotoCandidates[0] || null,
      goto_family_order: t.length >= 18 ? "e2ee_then_classic" : "classic_then_e2ee",
      goto_candidates_count: gotoCandidates.length,
    });
  } catch (_) {}
  let lastNavErr = "";
  let hydrationReady = false;
  let hydratedViaUrl = null;
  for (let i = 0; i < gotoCandidates.length; i += 1) {
    const gotoUrl = String(gotoCandidates[i] || "").trim();
    if (!gotoUrl) continue;
    if (i > 0) {
      try { await humanPause("domSettle", "fallback_goto_between_urls"); } catch (_) {
        try { await sleep(randomBetween(1200, 2200)); } catch (_) {}
      }
    }
    try {
      __deltaLogTriagemDom({
        stage: "fallback_goto_attempt",
        thread_key: t,
        step_a_error: stepAError || null,
        goto_url: gotoUrl,
        attempt: i + 1,
        is_e2ee_url: gotoUrl.includes("/messages/e2ee/t/"),
      });
    } catch (_) {}

    try {
      await page.goto(gotoUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      lastNavErr = e && e.message ? String(e.message) : "thread_open_goto_failed";
      try {
        __deltaLogTriagemDom({
          stage: "fallback_goto_navigation_error",
          thread_key: t,
          step_a_error: stepAError || null,
          goto_url: gotoUrl,
          attempt: i + 1,
          error: lastNavErr,
        });
      } catch (_) {}
      continue;
    }

    // Login/?next=marketplace / index.php?next=messages: link podre — aborta sem spam de goto.
    const badSignals = await __deltaProbeBadThreadPageSignals(page);
    if (badSignals && badSignals.login_redirect) {
      try {
        __deltaLogTriagemDom({
          stage: "fallback_goto_login_redirect",
          thread_key: t,
          step_a_error: stepAError || null,
          goto_url: gotoUrl,
          current_url: badSignals.url || null,
          index_next_messages: !!(badSignals.index_next_messages),
          attempt: i + 1,
        });
      } catch (_) {}
      if (acc && t) {
        try {
          __deltaGotoCircuitTrip(
            acc,
            t,
            badSignals.index_next_messages ? "index_next_messages" : "thread_login_redirect",
            { immediate: true }
          );
        } catch (_) {}
      }
      try {
        const connectLane = require("./connectLane.js");
        await connectLane.withHeavyNav({ kind: "delta_login_recover_messages" }, async () => {
          await page.goto("https://www.facebook.com/messages/", { waitUntil: "domcontentloaded", timeout: 45000 });
        });
      } catch (_) {}
      try { await humanPause("domSettle", "fallback_goto_login_recover_messages"); } catch (_) {}
      return {
        ok: false,
        error: "thread_login_redirect",
        opened_via: "direct_goto",
        step_a_error: stepAError || null,
        goto_url_used: gotoUrl,
        current_url: badSignals.url || null,
      };
    }
    if (badSignals && badSignals.continuar_gate) {
      try {
        __deltaLogTriagemDom({
          stage: "fallback_goto_e2ee_gate",
          thread_key: t,
          step_a_error: stepAError || null,
          goto_url: gotoUrl,
          current_url: badSignals.url || null,
          attempt: i + 1,
        });
      } catch (_) {}
      if (acc && t) {
        try { __deltaGotoCircuitTrip(acc, t, "thread_e2ee_gate_blocked", { immediate: true }); } catch (_) {}
      }
      return {
        ok: false,
        error: "thread_e2ee_gate_blocked",
        opened_via: "direct_goto",
        step_a_error: stepAError || null,
        goto_url_used: gotoUrl,
        current_url: badSignals.url || null,
      };
    }

    // Se a URL final não contém o thread alvo, não vale hidratar — próximo candidato.
    // Aceita facebook (/messages[/e2ee]/t/) e messenger.com ([/e2ee]/t/).
    try {
      const cur = String(page && page.url ? page.url() : "").trim();
      const urlOk = __deltaIsThreadKeyPathMatch(cur, t);
      if (!urlOk) {
        try {
          __deltaLogTriagemDom({
            stage: "fallback_goto_url_mismatch",
            thread_key: t,
            step_a_error: stepAError || null,
            goto_url: gotoUrl,
            current_url: cur || null,
            attempt: i + 1,
          });
        } catch (_) {}
        continue;
      }
    } catch (_) {}

    const contentUnavailable = await page.evaluate(() => {
      try {
        const txt = String(document.body && document.body.innerText || "").toLowerCase();
        return (
          txt.includes("este conteúdo não está disponível") ||
          txt.includes("este conteudo nao esta disponivel") ||
          txt.includes("this content isn't available right now")
        );
      } catch {
        return false;
      }
    }).catch(() => false);
    if (contentUnavailable) {
      // Chat excluído / inacessível: NÃO requeue como routing (vira abre-fecha infinito).
      try {
        __deltaLogTriagemDom({
          stage: "fallback_goto_content_unavailable",
          thread_key: t,
          step_a_error: stepAError || null,
          goto_url: gotoUrl,
          attempt: i + 1,
        });
      } catch (_) {}
      try {
        const connectLane = require("./connectLane.js");
        await connectLane.withHeavyNav({ kind: "delta_unavailable_recover_messages" }, async () => {
          await page.goto("https://www.facebook.com/messages/", { waitUntil: "domcontentloaded", timeout: 45000 });
        });
      } catch (_) {}
      try { await humanPause("domSettle", "fallback_goto_messages_bootstrap"); } catch (_) {}
      return {
        ok: false,
        error: "thread_content_unavailable",
        opened_via: "direct_goto",
        nonretryable: true,
        step_a_error: stepAError || null,
        goto_url_used: gotoUrl,
      };
    }

    // Hidratação: 2 tentativas, SEM reload paranoico (reload engessa o browser).
    for (let h = 0; h < 2; h += 1) {
      try {
        await clickAcceptMessageRequestIfPresent(page, {
          account_login: forensicAccountLogin,
          thread_key: t,
        }).catch(() => null);
        const midSignals = await __deltaProbeBadThreadPageSignals(page);
        if (midSignals && (midSignals.login_redirect || midSignals.continuar_gate)) {
          const midErr = midSignals.login_redirect ? "thread_login_redirect" : "thread_e2ee_gate_blocked";
          if (acc && t) {
            try {
              __deltaGotoCircuitTrip(
                acc,
                t,
                midSignals.index_next_messages ? "index_next_messages" : midErr,
                { immediate: true }
              );
            } catch (_) {}
          }
          return {
            ok: false,
            error: midErr,
            opened_via: "direct_goto",
            step_a_error: stepAError || null,
            goto_url_used: gotoUrl,
          };
        }
        await page.waitForSelector('div[data-lexical-editor="true"]', { timeout: 8000 });
        hydrationReady = true;
        hydratedViaUrl = gotoUrl;
        break;
      } catch (_) {
        if (h < 1) {
          try { await humanPause("domSettle", "fallback_goto_hydration_retry"); } catch (_) {}
        }
      }
    }
    if (hydrationReady) break;
  }

  if (!hydrationReady && lastNavErr) {
    if (acc && t && /messages_boot_not_stable/i.test(String(stepAError || ""))) {
      try { __deltaGotoCircuitTrip(acc, t, "goto_failed_after_boot_unstable", { immediate: false }); } catch (_) {}
    }
    return {
      ok: false,
      error: "thread_open_goto_failed",
      error_message: lastNavErr,
      opened_via: "direct_goto",
      step_a_error: stepAError || null
    };
  }
  if (!hydrationReady) {
    try {
      __deltaLogTriagemDom({
        stage: "fallback_goto_hydration_timeout",
        thread_key: t,
        step_a_error: stepAError || null,
      });
    } catch (_) {}
    if (acc && t && /messages_boot_not_stable/i.test(String(stepAError || ""))) {
      try { __deltaGotoCircuitTrip(acc, t, "hydration_timeout_after_boot_unstable", { immediate: false }); } catch (_) {}
    }
    return {
      ok: false,
      error: "thread_open_hydration_timeout",
      opened_via: "direct_goto",
      step_a_error: stepAError || null
    };
  }

  const guard = await runWrongThreadGuard(page, t, {
    forensicAccountLogin,
    stage: "post_goto_route_validation",
    requireComposer: true
  });
  if (!guard.ok) {
    return {
      ...guard,
      opened_via: "direct_goto",
      step_a_error: stepAError || null
    };
  }

  try {
    const urlFinal = String(page && page.url ? page.url() : "").trim() || null;
    __deltaLogTriagemDom({
      stage: "composer_hydration_success",
      thread_key: t,
      selector: "direct_goto",
      url_final: urlFinal,
      goto_url_used: hydratedViaUrl || null,
      is_e2ee_url: String(hydratedViaUrl || "").includes("/messages/e2ee/t/"),
      step_a_error: stepAError || null,
    });
  } catch (_) {}
  if (acc && t) {
    try { __deltaGotoCircuitClear(acc, t); } catch (_) {}
  }
  return {
    ok: true,
    matched_selector: "direct_goto",
    hydrated: true,
    opened_via: "direct_goto",
    fallback_used: true,
    goto_url_used: hydratedViaUrl || null,
    is_e2ee_url: String(hydratedViaUrl || "").includes("/messages/e2ee/t/"),
    step_a_error: stepAError || null
  };
}

async function __deltaEnforceSidebarResetToTop(page, { threadKey = null, forensicAccountLogin = null, reason = "task_success" } = {}) {
  if (!page) return { ok: false, error: "missing_page" };
  const t = String(threadKey || "").trim() || null;
  const out = await page.evaluate(() => {
    const THREAD_LINK_SELECTOR = 'a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]';
    const gridCount = document.querySelectorAll('div[role="grid"]').length;
    const anchorCount = document.querySelectorAll(THREAD_LINK_SELECTOR).length;

    const isScrollable = (el) => {
      if (!el || el === document.body || el === document.documentElement) return false;
      const style = window.getComputedStyle(el);
      const overflowY = String((style && (style.overflowY || style.overflow)) || "");
      if (!/(auto|scroll|overlay)/i.test(overflowY)) return false;
      const ch = Number(el.clientHeight || 0) || 0;
      const sh = Number(el.scrollHeight || 0) || 0;
      if (ch < 80) return false;
      if (sh <= ch + 10) return false;
      return true;
    };

    const scoreCandidate = (el) => {
      let score = 0;
      let threadCount = 0;
      let virtualizedDescCount = 0;
      let directVirtualizedChildren = 0;
      try { threadCount = el.querySelectorAll(THREAD_LINK_SELECTOR).length; } catch (_) {}
      try { virtualizedDescCount = el.querySelectorAll("[data-virtualized]").length; } catch (_) {}
      try { directVirtualizedChildren = el.querySelectorAll(':scope > div[data-virtualized]').length; } catch (_) {}
      if (threadCount < 2) return null;
      score += Math.min(40, threadCount);
      score += Math.min(30, virtualizedDescCount * 6);
      score += Math.min(30, directVirtualizedChildren * 15);
      if (el.querySelector('div[role="row"]')) score += 20;
      if (el.querySelector('a[aria-current="page"]')) score += 15;
      score += Math.min(40, Math.round((Number(el.scrollHeight || 0) - Number(el.clientHeight || 0)) / 120));
      return {
        score,
        thread_count: threadCount,
        virtualized_desc_count: virtualizedDescCount,
        direct_virtualized_children: directVirtualizedChildren
      };
    };

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (el, via) => {
      if (!isScrollable(el)) return;
      if (seen.has(el)) return;
      const scored = scoreCandidate(el);
      if (!scored) return;
      seen.add(el);
      const tag = String((el && el.tagName) || "div").toLowerCase();
      const classNameRaw = String((el && el.className) || "").trim();
      const className = classNameRaw ? classNameRaw.split(/\s+/).slice(0, 6).join(".") : "";
      candidates.push({
        el,
        via,
        score: Number(scored.score || 0) || 0,
        thread_count: Number(scored.thread_count || 0) || 0,
        virtualized_desc_count: Number(scored.virtualized_desc_count || 0) || 0,
        direct_virtualized_children: Number(scored.direct_virtualized_children || 0) || 0,
        target_signature: className ? `${tag}.${className}` : tag
      });
    };

    const anchors = Array.from(document.querySelectorAll(THREAD_LINK_SELECTOR));
    for (const anchor of anchors.slice(0, 80)) {
      let node = anchor;
      let hops = 0;
      while (node && node !== document.body && hops < 16) {
        node = node.parentElement;
        if (!node) break;
        pushCandidate(node, "anchor_ancestor");
        hops += 1;
      }
    }

    const virtualizedNodes = Array.from(document.querySelectorAll("[data-virtualized], div[role='row']"));
    for (const base of virtualizedNodes.slice(0, 160)) {
      let node = base;
      let hops = 0;
      while (node && node !== document.body && hops < 10) {
        node = node.parentElement;
        if (!node) break;
        pushCandidate(node, "virtualized_ancestor");
        hops += 1;
      }
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.direct_virtualized_children !== a.direct_virtualized_children) {
        return b.direct_virtualized_children - a.direct_virtualized_children;
      }
      return b.thread_count - a.thread_count;
    });

    const target = candidates.length ? candidates[0] : null;
    const tryResetTop = (el) => {
      if (!el || !isScrollable(el)) return { applied: false, before: 0, after: 0 };
      const before = Number(el.scrollTop || 0) || 0;
      try { el.scrollTop = 0; } catch (_) {}
      try {
        if (typeof el.scrollTo === "function") {
          el.scrollTo({ top: 0, left: 0, behavior: "instant" });
        }
      } catch (_) {
        try { el.scrollTo(0, 0); } catch (_) {}
      }
      try { el.dispatchEvent(new Event("scroll", { bubbles: true })); } catch (_) {}
      const after = Number(el.scrollTop || 0) || 0;
      return {
        applied: after === 0 || before !== after,
        before,
        after
      };
    };

    const chain = [];
    if (target && target.el) {
      chain.push(target.el);
      let node = target.el.parentElement;
      let hops = 0;
      while (node && node !== document.body && hops < 3) {
        chain.push(node);
        node = node.parentElement;
        hops += 1;
      }
    }
    const outcomes = chain.map((el) => tryResetTop(el));
    const applied = outcomes.find((x) => x && x.applied && x.after === 0) || outcomes.find((x) => x && x.applied) || null;
    if (!target) {
      return {
        ok: false,
        reason: "scroll_container_not_found",
        grid_count: gridCount,
        anchor_count: anchorCount,
        candidate_count: 0
      };
    }
    return {
      ok: !!applied,
      reason: applied ? "scroll_reset_applied" : "scroll_reset_not_applied",
      grid_count: gridCount,
      anchor_count: anchorCount,
      candidate_count: candidates.length,
      selected_via: String(target.via || "unknown"),
      selected_signature: String(target.target_signature || "unknown"),
      selected_score: Number(target.score || 0) || 0,
      scroll_top: Number(applied && applied.after || 0) || 0,
      scroll_top_before: Number(applied && applied.before || 0) || 0
    };
  }).catch(() => ({ ok: false, reason: "evaluate_failed", grid_count: 0, anchor_count: 0, candidate_count: 0 }));
  try {
    __deltaLogTriagemDom({
      stage: "sidebar_reset_to_top",
      thread_key: t,
      reason: String(reason || "task_success"),
      ok: !!(out && out.ok),
      grid_count: Number(out && out.grid_count || 0) || 0,
      anchor_count: Number(out && out.anchor_count || 0) || 0,
      candidate_count: Number(out && out.candidate_count || 0) || 0,
      selected_via: String(out && out.selected_via || "n/a"),
      selected_signature: String(out && out.selected_signature || "n/a"),
      dom_reason: String(out && out.reason || "unknown"),
    });
  } catch (_) {}
  try {
    __forensicEdgeEmit({
      account_login: forensicAccountLogin,
      thread_key: t,
      flow_stage: "sidebar_reset_to_top",
      details: {
        tag: "FORENSIC_DOM_REVERSE",
        reason: String(reason || "task_success"),
        ok: !!(out && out.ok),
        grid_count: Number(out && out.grid_count || 0) || 0,
        anchor_count: Number(out && out.anchor_count || 0) || 0,
        candidate_count: Number(out && out.candidate_count || 0) || 0,
        selected_via: String(out && out.selected_via || "n/a"),
        selected_signature: String(out && out.selected_signature || "n/a"),
        dom_reason: String(out && out.reason || "unknown"),
        ts_ms: Date.now()
      }
    });
  } catch (_) {}
  return out;
}

async function openThreadByClick(page, threadKey, { maxScrollSteps: _maxScrollSteps = 16, forensicAccountLogin = null } = {}) {
  const t = String(threadKey || "").trim();
  if (!t) throw new Error("thread_key_empty");
  try {
    const urlInicial = String(page && page.url ? page.url() : "").trim() || null;
    __deltaLogTriagemDom({
      stage: "automation_start",
      thread_key: t,
      url_inicial: urlInicial,
    });
  } catch (_) {}

  const isStable = await waitForMessagesBootStable(page, "agent_outbox_hydration_check").catch(() => false);
  if (!isStable) {
    try {
      __forensicEdgeEmit({
        account_login: forensicAccountLogin,
        thread_key: t,
        flow_stage: "messages_boot_not_stable",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          reason: "agent_outbox_hydration_check_failed",
          ts_ms: Date.now(),
        }
      });
    } catch (_) {}
    const rescue = await __deltaTryOpenThreadByDirectGoto(page, t, {
      forensicAccountLogin,
      stepAError: "messages_boot_not_stable"
    }).catch(() => null);
    if (rescue && rescue.ok) {
      // Chat aberto via goto: pode pedir Aceitar antes do composer.
      await clickAcceptMessageRequestIfPresent(page, {
        account_login: forensicAccountLogin,
        thread_key: t,
      }).catch(() => null);
      return {
        ...rescue,
        recovered_from_boot_not_stable: true
      };
    }
    return {
      ok: false,
      error: "messages_boot_not_stable",
      fallback_error: String(rescue && rescue.error || "").trim() || null
    };
  }

  // Marketplace só se o card do alvo ainda não aparece — evita activate+feed em todo reply.
  const cardAlreadyVisible = await isThreadCardVisible(page, t).catch(() => false);
  if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED && !cardAlreadyVisible) {
    const mpActive = await isMarketplaceFilterActive(page).catch(() => false);
    if (!mpActive) {
      await __raceMarketplaceActivate(page, { timeoutMs: 12_000, reason: "open_thread_pre" }).catch(() => null);
    } else {
      await waitForMarketplaceFeedReady(page, { timeoutMs: 6_000, minThreadLinks: 1 }).catch(() => null);
    }
  } else if (cardAlreadyVisible) {
    try {
      logInfo(`[virtusDelta][open] skip_marketplace_pre thread_key=${t} card_visible=sim`);
    } catch (_) {}
  }

  try {
    await page.waitForFunction(
      () => {
        const hrefs = Array.from(document.querySelectorAll('a[href*="/messages"]'))
          .map((a) => String(a.getAttribute("href") || ""))
          .filter(Boolean);
        const nonNew = hrefs.filter((h) => !h.includes("/messages/new"));
        return nonNew.length >= 1;
      },
      { timeout: 6000 }
    );
  } catch (_) {}

  const cardSelectors = __deltaBuildThreadCardSelectors(t);
  const primaryCardSelector = cardSelectors[0] || `div[role="row"] a[href*="/messages/t/${t}"]`;

  let stepAError = "thread_card_not_found";
  let stepASelector = null;
  for (let si = 0; si < cardSelectors.length; si += 1) {
    const cardSelector = cardSelectors[si];
    const cardElement = si === 0
      ? await page.waitForSelector(cardSelector, { timeout: 9000 }).catch(() => null)
      : await page.$(cardSelector).catch(() => null);
    if (!cardElement) continue;

    stepASelector = cardSelector;
    try {
      const isCurrentPage = await cardElement
        .evaluate((el) => {
          if (!el) return false;
          if (el.getAttribute("aria-current") === "page") return true;
          return Boolean(el.closest('[aria-current="page"]'));
        })
        .catch(() => false);
      if (isCurrentPage) {
        const guard = await runWrongThreadGuard(page, t, {
          forensicAccountLogin,
          stage: "already_open_prevent_cross_routing",
          requireComposer: true
        });
        if (guard.ok) {
          return {
            ok: true,
            scrolled: 0,
            matched_selector: cardSelector,
            already_open: true,
            skipped_click: true,
            hydrated: true
          };
        }
        stepAError = String(guard.error || "wrong_thread_guard_blocked");
        break;
      }
    } catch (_) {}

    await humanPause("preThreadClick", "pre_thread_card_click");
    try {
      await cardElement.evaluate((el) => {
        try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch (_) {}
      });
    } catch (_) {
      try { await cardElement.scrollIntoViewIfNeeded(); } catch (_) {}
    }

    let clickPlan = null;
    try { clickPlan = await computeVisibleThreadCardClickPlan(cardElement); } catch (_) {}
    const points = (clickPlan && clickPlan.ok && Array.isArray(clickPlan.points)) ? clickPlan.points : [];
    let openedByNavigation = false;
    for (const p of points.slice(0, 2)) {
      const px = Number(p && p.x);
      const py = Number(p && p.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      try {
        await page.mouse.move(px, py, { steps: 6 });
        await page.mouse.click(px, py, { delay: 100 });
      } catch (_) {
        continue;
      }
      try {
        await page.waitForFunction(
          __deltaBrowserThreadPathMatchPredicate,
          { timeout: 5500 },
          t,
          __DELTA_THREAD_PATH_PREFIX_RE
        );
        openedByNavigation = true;
        break;
      } catch (_) {}
    }

    if (!openedByNavigation) {
      stepAError = "thread_card_not_found";
      continue;
    }

    // Wait-until composer — não sleep fixo de 6–12s.
    await humanPause("domSettle", "post_thread_card_click");
    // Pedido de mensagem: Aceitar libera o composer.
    await clickAcceptMessageRequestIfPresent(page, {
      account_login: forensicAccountLogin,
      thread_key: t,
    }).catch(() => null);
    try {
      await page.waitForSelector('div[data-lexical-editor="true"]', { timeout: 8000 });
    } catch (_) {
      // Segunda chance: Aceitar + esperar de novo
      await clickAcceptMessageRequestIfPresent(page, {
        account_login: forensicAccountLogin,
        thread_key: t,
      }).catch(() => null);
      try {
        await page.waitForSelector('div[data-lexical-editor="true"]', { timeout: 6000 });
      } catch (_) {
        stepAError = "thread_open_hydration_timeout";
        break;
      }
    }

    try {
      const urlFinal = String(page && page.url ? page.url() : "").trim() || null;
      __deltaLogTriagemDom({
        stage: "composer_hydration_success",
        thread_key: t,
        selector: cardSelector,
        scrolled: 0,
        url_final: urlFinal,
      });
    } catch (_) {}

    const guard = await runWrongThreadGuard(page, t, {
      forensicAccountLogin,
      stage: "post_click_route_validation",
      requireComposer: true
    });
    if (guard.ok) {
      return { ok: true, scrolled: 0, matched_selector: cardSelector, hydrated: true };
    }
    stepAError = String(guard.error || "wrong_thread_guard_blocked");
    break;
  }

  try {
    __deltaLogTriagemDom({
      stage: "step_a_failed_fallback_goto",
      thread_key: t,
      selector: stepASelector,
      step_a_error: stepAError,
    });
  } catch (_) {}
  const fallback = await __deltaTryOpenThreadByDirectGoto(page, t, {
    forensicAccountLogin,
    stepAError
  });
  if (fallback && fallback.ok) return fallback;

  // Retry paciente na mesma tentativa: inbox pode ainda estar hidratando o card.
  // Sem contingency burra — só paciência + 2ª abertura soberana.
  try {
    __deltaLogTriagemDom({
      stage: "open_thread_patient_retry",
      thread_key: t,
      selector: stepASelector,
      step_a_error: stepAError,
      prior_error: String(fallback && fallback.error || "thread_open_failed"),
    });
  } catch (_) {}
  try {
    await humanPause("domSettle", "open_thread_patient_retry_settle");
  } catch (_) {
    try { await page.waitForTimeout(3200); } catch (_) {}
  }
  try {
    await page.keyboard.press("Home").catch(() => {});
  } catch (_) {}
  try {
    await humanPause("domSettle", "open_thread_patient_retry_scroll_top");
  } catch (_) {}

  const patientCard = await page.$(primaryCardSelector).catch(() => null);
  if (patientCard) {
    try {
      await patientCard.evaluate((el) => {
        try { el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); } catch (_) {}
      });
    } catch (_) {}
    try {
      let clickPlan = null;
      try { clickPlan = await computeVisibleThreadCardClickPlan(patientCard); } catch (_) {}
      const points = (clickPlan && clickPlan.ok && Array.isArray(clickPlan.points)) ? clickPlan.points : [];
      for (const p of points.slice(0, 2)) {
        const px = Number(p && p.x);
        const py = Number(p && p.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        try {
          await page.mouse.move(px, py, { steps: 6 });
          await page.mouse.click(px, py, { delay: 100 });
        } catch (_) {
          continue;
        }
        try {
          await page.waitForFunction(
            __deltaBrowserThreadPathMatchPredicate,
            { timeout: 2500 },
            t,
            __DELTA_THREAD_PATH_PREFIX_RE
          );
          await humanPause("postThreadOpen", "patient_retry_post_click");
          await clickAcceptMessageRequestIfPresent(page, {
            account_login: forensicAccountLogin,
            thread_key: t,
          }).catch(() => null);
          await page.waitForSelector('div[data-lexical-editor="true"]', { timeout: 12000 }).catch(() => null);
          const guard = await runWrongThreadGuard(page, t, {
            forensicAccountLogin,
            stage: "patient_retry_post_click",
            requireComposer: true
          });
          if (guard.ok) {
            return {
              ok: true,
              scrolled: 0,
              matched_selector: primaryCardSelector,
              hydrated: true,
              patient_retry: true,
            };
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  const patientGoto = await __deltaTryOpenThreadByDirectGoto(page, t, {
    forensicAccountLogin,
    stepAError: stepAError || "patient_retry",
  });
  if (patientGoto && patientGoto.ok) {
    return { ...patientGoto, patient_retry: true };
  }

  try {
    __deltaLogTriagemDom({
      stage: "hard_fail_after_fallback",
      thread_key: t,
      selector: stepASelector,
      step_a_error: stepAError,
      final_error: String(
        (patientGoto && patientGoto.error) ||
        (fallback && fallback.error) ||
        "thread_open_failed"
      ),
      patient_retry_attempted: true,
    });
  } catch (_) {}
  return patientGoto || fallback || { ok: false, error: "thread_open_failed", step_a_error: stepAError };
}

async function probeOpenLineContinuity(page, threadKey) {
  const t = String(threadKey || "").trim();
  if (!page || !t) return { is_open_line_ready: false, reason: "missing_page_or_thread" };
  try {
    const out = await page.evaluate((threadId, pathPrefixRe) => {
      const normHref = (href) => String(href || "").trim();
      const path = String(location.pathname || "").replace(/\/+$/, "") || "/";
      const esc = String(threadId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefix = String(pathPrefixRe || "^(?:/messages/(?:e2ee/)?t/|/e2ee/t/|/t/)");
      const pathRe = new RegExp(`${prefix}${esc}$`, "i");
      const hrefRe = new RegExp(`(?:/messages/(?:e2ee/)?t/|/e2ee/t/|/t/)${esc}(?:/|$)`, "i");
      const urlMatchesThread = pathRe.test(path);
      const active = document.querySelector('a[aria-current="page"][href], [aria-current="page"] a[href]');
      const activeHref = normHref(active && active.getAttribute("href"));
      const sidebarMatchesThread = !!(activeHref && hrefRe.test(activeHref));
      const composers = Array.from(document.querySelectorAll('div[data-lexical-editor="true"]')).filter((el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return !!(r && r.width > 1 && r.height > 1);
      });
      return {
        current_path: path || null,
        active_sidebar_href: activeHref || null,
        url_matches_thread: !!urlMatchesThread,
        aria_current_page: !!sidebarMatchesThread,
        composer_ready: composers.length >= 1,
      };
    }, t, __DELTA_THREAD_PATH_PREFIX_RE);
    // URL certa + composer: sidebar aria-current é bônus (layouts E2EE às vezes não trazem).
    const ready = !!(out && out.url_matches_thread && out.composer_ready && (out.aria_current_page || !out.active_sidebar_href));
    return {
      ...out,
      thread_key: t,
      is_open_line_ready: ready,
      reason: ready ? "open_line_ready" : "not_open_line_ready",
      probed_at: Date.now(),
    };
  } catch {
    return { thread_key: t, is_open_line_ready: false, reason: "probe_evaluate_failed", probed_at: Date.now() };
  }
}

async function sendReplyFlow({ page, threadKey, textoResposta, fromNetworkLead = false, onItemLink = null, forensicAccountLogin = null, continuityProbe = null, skipActionDispatch = false } = {}) {
  const t = String(threadKey || "").trim();
  logInfo(`[virtusDelta][reply] start thread_key=${t} chars=${String(textoResposta || "").length} from_network=${fromNetworkLead ? "sim" : "nao"}`);
  try { if (page) page.__virtusDeltaReplyInFlight = true; } catch (_) {}
  try {
    if (!skipActionDispatch) {
      await humanReactionDelay(fromNetworkLead);
    }

    // Proteção anti-freeze: expurga seleção residual do mouse antes de qualquer automação.
    try {
      await page.evaluate(() => {
        try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
      });
    } catch (_) {}

    const __isAlreadyOpenByUrl = () => {
      try {
        const rawUrl = String(page && page.url ? page.url() : "");
        let path = "";
        try { path = String(new URL(rawUrl).pathname || ""); } catch (_) { path = rawUrl; }
        path = String(path || "").replace(/\/+$/, "") || "/";
        const m = path.match(/^(?:\/messages\/(?:e2ee\/)?t\/|\/e2ee\/t\/|\/t\/)(\d+)$/i);
        const currentThread = m && m[1] ? String(m[1]) : "";
        if (currentThread && currentThread === String(t) && __deltaIsThreadKeyPathMatch(rawUrl, t)) {
          return { ok: true, current_thread: currentThread, current_path: path, url: rawUrl };
        }
        return { ok: false, current_thread: currentThread || null, current_path: path || null, url: rawUrl };
      } catch {
        return { ok: false, current_thread: null, current_path: null, url: "" };
      }
    };

    const providedContinuity = (() => {
      if (!continuityProbe || typeof continuityProbe !== "object") return null;
      if (String(continuityProbe.thread_key || "").trim() !== t) return null;
      const ageMs = Date.now() - (Number(continuityProbe.probed_at || 0) || 0);
      if (ageMs > 2500) return null;
      return continuityProbe;
    })();
    const continuity = providedContinuity || await probeOpenLineContinuity(page, t);
    const canUseOpenLineFastPath = !!(continuity && continuity.is_open_line_ready === true);
    // Hands/dashboard: prep rápido (card first). Network lead ainda passa pelo mesmo path.
    if (!canUseOpenLineFastPath) {
      try {
        await prepareDomForNetworkLead(page, threadKey, { fastMarketplace: true });
      } catch (e) {
        logInfo(`[virtusDelta][dom_prep] fail thread_key=${t} err=${e && e.message ? e.message : String(e)}`);
      }
    }
    let open = null;
    if (canUseOpenLineFastPath) {
      try {
        __forensicEdgeEmit({
          account_login: forensicAccountLogin,
          thread_key: t,
          flow_stage: "open_line_fast_path",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            reason: "same_thread_already_open_selected",
            is_already_open: true,
            aria_current_page: !!(continuity && continuity.aria_current_page),
            current_path: continuity && continuity.current_path ? String(continuity.current_path) : null,
            active_sidebar_href: continuity && continuity.active_sidebar_href ? String(continuity.active_sidebar_href) : null,
            ts_ms: Date.now(),
          }
        });
      } catch (_) {}
      open = {
        ok: true,
        scrolled: 0,
        matched_selector: "open_line_fast_path",
        already_open: true,
        skipped_click: true,
        hydrated: true,
        continuity_fast_path: true
      };
    }

    if (!canUseOpenLineFastPath && DELTA_MARKETPLACE_AUTOFILTER_ENABLED) {
      try {
        const st = __isAlreadyOpenByUrl();
        const threadCardVisible = await page.evaluate((threadId) => {
          const selectors = [
            `div[role="row"] a[href*="/messages/t/${threadId}"]`,
            `a[href*="/messages/t/${threadId}"]`,
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r && r.width > 1 && r.height > 1) return true;
          }
          return false;
        }, t).catch(() => false);
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
        } else if (threadCardVisible) {
          try {
            __forensicEdgeEmit({
              account_login: forensicAccountLogin,
              thread_key: t,
              flow_stage: "marketplace_filter_bypass",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                reason: "thread_card_visible_sidebar",
                is_already_open: false,
                ts_ms: Date.now(),
              }
            });
          } catch (_) {}
        }
      } catch (_) {}
    }

    if (!canUseOpenLineFastPath) {
      open = await openThreadByClick(page, threadKey, { forensicAccountLogin });
      if (!open.ok) return open;
    }

    if (!open || !open.ok) {
      logInfo(`[virtusDelta][reply] openThread FAIL thread_key=${t} error=${open && open.error ? open.error : "open_unknown_error"}`);
      if (open && open.href_preview && open.href_preview.length) {
        logInfo(`[virtusDelta][reply] href_preview=${JSON.stringify(open.href_preview)}`);
      }
      return open || { ok: false, error: "thread_open_failed" };
    }
    logInfo(
      `[virtusDelta][reply] openThread OK thread_key=${t} scrolled=${open.scrolled} selector=${String(open.matched_selector || "")}`
    );

    if (canUseOpenLineFastPath) {
      try {
        logInfo(`[virtusDelta][reply] open_line_fast_path thread_key=${t} skip_marketplace_and_reopen=sim`);
      } catch (_) {}
    }

    // Removido post_open_read_context (6–12s duplicado): composer + wrong_thread_guard bastam.
    // LEI: NUNCA await collect de link/cidade ANTES do Enter.
    // Link/cidade rodam DEPOIS do send confirmado (abaixo) + collectMetadataAfterCtReply.
    let itemLink = null;

    // E2EE gate: NÃO clica Continuar (policy). Se o gate estiver presente → link podre / hop.
    try {
      await dismissMessengerE2eeInterstitial(page, {
        forensicAccountLogin: forensicAccountLogin || null,
      });
    } catch (_) {}
    try {
      const gateProbe = await __deltaProbeBadThreadPageSignals(page);
      if (gateProbe && gateProbe.login_redirect) {
        return { ok: false, error: "thread_login_redirect", current_url: gateProbe.url || null };
      }
      if (gateProbe && gateProbe.continuar_gate) {
        return { ok: false, error: "thread_e2ee_gate_blocked", current_url: gateProbe.url || null };
      }
    } catch (_) {}

    // ID Virtus: banner "Confirme sua identidade para enviar mensagens" — antes do composer.
    {
      const ivPre = await probeIdVirtusBlock(page, {
        account_login: forensicAccountLogin,
        thread_key: t,
        stage: "pre_composer"
      });
      if (ivPre) return ivPre;
    }

    try {
      await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
    } catch (compErr) {
      const em = String((compErr && compErr.message) || compErr || "");
      if (em.includes("composer_missing")) {
        // Antes do hop: se for ID Virtus, não tratar como routing.
        {
          const ivMiss = await probeIdVirtusBlock(page, {
            account_login: forensicAccountLogin,
            thread_key: t,
            stage: "composer_missing"
          });
          if (ivMiss) return ivMiss;
        }
        // Uma chance só com Aceitar (Marketplace). Continuar E2EE nunca.
        await clickAcceptMessageRequestIfPresent(page, {
          account_login: forensicAccountLogin,
          thread_key: t,
        }).catch(() => null);
        await humanPause("domSettle", "composer_missing_accept_retry");
        try {
          const again = await __deltaProbeBadThreadPageSignals(page);
          if (again && (again.continuar_gate || again.login_redirect)) {
            return {
              ok: false,
              error: again.login_redirect ? "thread_login_redirect" : "thread_e2ee_gate_blocked",
              current_url: again.url || null,
            };
          }
          await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
        } catch (_) {
          {
            const ivMiss2 = await probeIdVirtusBlock(page, {
              account_login: forensicAccountLogin,
              thread_key: t,
              stage: "composer_missing_after_accept"
            });
            if (ivMiss2) return ivMiss2;
          }
          return { ok: false, error: "composer_missing" };
        }
      } else {
        throw compErr;
      }
    }
    const typingGuard = await runWrongThreadGuard(page, t, {
      forensicAccountLogin,
      stage: "pre_typing_composer_signature",
      requireComposer: true
    });
    if (!typingGuard.ok) return typingGuard;
    await humanPause("preTyping", "pre_typing");
    if (process.env.VIRTUS_DELTA_DUMP_DOM === "1") {
      try {
        const dom = await captureDomForense(page);
        logInfo(`[virtusDelta][DOM] thread_key=${t} composer_outerHTML=${dom.composer_outerHTML}`);
        logInfo(`[virtusDelta][DOM] thread_key=${t} send_outerHTML=${dom.send_outerHTML}`);
      } catch (_) {}
    }
    const expectedComposer = normalizeComposerPayload(textoResposta);
    const typeOut = await typeHumanized(page, textoResposta);
    let composed = await readComposerText(page);
    let composedNorm = normalizeComposerPayload(composed);
    let composerIntegrityOk = isComposerPayloadMatch(expectedComposer, composedNorm);
    logInfo(
      `[virtusDelta][composer] after_type chars=${composedNorm.length} expected_chars=${expectedComposer.length} integrity=${composerIntegrityOk ? "ok" : "mismatch"} mode=${String(typeOut && typeOut.mode || "unknown")} preview="${composedNorm.slice(0, 60)}"`
    );

    // Blindagem estrutural: tenta convergir o payload digitado com o payload de origem.
    // Se não convergir, mantém best-effort operacional (não abandona envio).
    if (!composerIntegrityOk) {
      logInfo(`[virtusDelta][composer] integrity_retry thread_key=${t}`);
      await humanPause("domSettle", "composer_integrity_retry_settle");
      await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
      await humanPause("preTyping", "pre_typing_integrity_retry");
      const retryTypeOut = await typeHumanized(page, textoResposta);
      composed = await readComposerText(page);
      composedNorm = normalizeComposerPayload(composed);
      composerIntegrityOk = isComposerPayloadMatch(expectedComposer, composedNorm);
      logInfo(
        `[virtusDelta][composer] after_integrity_retry chars=${composedNorm.length} expected_chars=${expectedComposer.length} integrity=${composerIntegrityOk ? "ok" : "mismatch"} mode=${String(retryTypeOut && retryTypeOut.mode || "unknown")} preview="${composedNorm.slice(0, 60)}"`
      );
    }
    const composerIntegrityDegraded = !composerIntegrityOk;
    if (composerIntegrityDegraded) {
      // Política operacional: nunca abandonar envio por mismatch de composer.
      // Mantemos best-effort com evidência forense e seguimos para o Enter.
      logInfo(
        `[virtusDelta][composer] integrity_degraded_proceed thread_key=${t} expected_chars=${expectedComposer.length} actual_chars=${composedNorm.length}`
      );
      try {
        __forensicEdgeEmit({
          account_login: forensicAccountLogin,
          thread_key: t,
          flow_stage: "composer_integrity_degraded_proceed",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            expected_chars: expectedComposer.length,
            actual_chars: composedNorm.length,
            composer_preview: composedNorm.slice(0, 120),
            ts_ms: Date.now(),
          }
        });
      } catch (_) {}
    }

    if (process.env.VIRTUS_DELTA_DUMP_DOM === "1") {
      try {
        const dom2 = await captureDomForense(page);
        logInfo(`[virtusDelta][DOM] thread_key=${t} after_type_send_outerHTML=${dom2.send_outerHTML}`);
      } catch (_) {}
    }

    // Typing Flush Guard: garante que o buffer Lexical finalize sílabas finais antes do envio.
    await new Promise((resolve) => setTimeout(resolve, 300));
    logInfo(`[virtusDelta][typing_flush_guard] thread_key=${t} wait_ms=300`);

    await humanPause("preSend", "pre_enter_send");
    // Estratégia enterprise operacional:
    // 1) Enter para enviar
    // 2) Se não confirmar, tentar botão de envio
    // 3) Nunca abandonar envio por falha de confirmação local (best-effort).
    let initial = String(composedNorm || "").trim();
    if (!initial && expectedComposer) {
      // Garantia final: não deixar composer vazio quando há payload esperado.
      try {
        await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
        await typeHumanized(page, textoResposta);
        composed = await readComposerText(page);
        composedNorm = normalizeComposerPayload(composed);
        initial = String(composedNorm || "").trim();
        logInfo(
          `[virtusDelta][composer] final_rehydrate chars=${composedNorm.length} expected_chars=${expectedComposer.length} preview="${composedNorm.slice(0, 60)}"`
        );
      } catch (_) {}
    }
    if (!initial) {
      const clicked = await clickSendButtonIfPresent(page);
      logInfo(`[virtusDelta][reply] composer_empty thread_key=${t} send_button=${clicked ? "sim" : "nao"}`);
      // Contrato de aço: sem texto no composer não há send confirmado → não mentir ok.
      return {
        ok: false,
        error: "composer_text_not_registered",
        item_link: itemLink || null,
        delivery_confidence: "unconfirmed",
        unconfirmed_reason: clicked ? "composer_empty_send_button" : "composer_empty_no_send_control",
      };
    }

    try { await page.keyboard.up("Shift"); } catch (_) {}
    try { await page.keyboard.press("Enter"); } catch (_) {}
    logInfo(`[virtusDelta][reply] enter_sent thread_key=${t}`);
    const emptyAfterEnter = await waitLexicalComposerEmpty(page, { timeoutMs: 2200, pollMs: 80 });
    let after = String(emptyAfterEnter && emptyAfterEnter.text_preview || "").trim();
    if (!(emptyAfterEnter && emptyAfterEnter.ok)) {
      const clickedStrict = await clickStrictPhysicalSendButton(page);
      const clickedFallback = clickedStrict ? true : await clickSendButtonIfPresent(page);
      logInfo(
        `[virtusDelta][reply] send_button_fallback thread_key=${t} origin=${fromNetworkLead ? "network" : "dashboard"} strict=${clickedStrict ? "sim" : "nao"} clicked=${clickedFallback ? "sim" : "nao"}`
      );
      const emptyAfterFallback = await waitLexicalComposerEmpty(page, { timeoutMs: 1800, pollMs: 80 });
      after = String(emptyAfterFallback && emptyAfterFallback.text_preview || "").trim();
    }
    await humanPause("postSend", "post_enter_send");

    if (after && after.trim()) {
      // Composer ainda tem texto: envio NÃO confirmado — falha explícita (sem balão azul falso).
      try {
        __forensicEdgeEmit({
          account_login: forensicAccountLogin,
          thread_key: t,
          flow_stage: "send_not_confirmed_composer_not_empty",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            reason: "composer_not_empty_after_send_attempts",
            composer_preview: after.slice(0, 120),
            ts_ms: Date.now(),
          }
        });
      } catch (_) {}
      return {
        ok: false,
        error: "send_not_confirmed_composer_not_empty",
        item_link: itemLink || null,
        delivery_confidence: "unconfirmed",
        unconfirmed_reason: "composer_not_empty_after_send",
        composer_preview: after.slice(0, 80),
      };
    }

    // Send já confirmado no Messenger. Só agora tenta link (não atrasa Enter).
    if (!canUseOpenLineFastPath || fromNetworkLead || typeof onItemLink === "function") {
      const handsPath = !!skipActionDispatch && !fromNetworkLead;
      const itemLinkAttempts = handsPath
        ? Math.max(1, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 2) || 2)
        : Math.max(2, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 4) || 4);
      const readyMs = handsPath
        ? Math.max(600, Number(process.env.VIRTUS_DELTA_LINK_READY_MS || 1500) || 1500)
        : Math.max(1000, Number(process.env.VIRTUS_DELTA_LINK_READY_MS || 4000) || 4000);
      try {
        itemLink = await extractMarketplaceItemLinkWithRetry(page, {
          attempts: itemLinkAttempts,
          readinessTimeoutMs: readyMs,
          forensicAccountLogin,
          threadKey: t,
        });
        if (itemLink) {
          logInfo(`[COLETOR_101_LINK] ${itemLink}`);
          if (typeof onItemLink === "function") {
            try {
              onItemLink(itemLink);
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    return { ok: true, item_link: itemLink || null, delivery_confidence: "confirmed_local", status: "send_ok" };
  } finally {
    try { if (page) page.__virtusDeltaReplyInFlight = false; } catch (_) {}
  }
}

async function openThreadAndExtractItemLink(
  page,
  threadKey,
  { fromNetworkLead = true, forensicAccountLogin = null } = {}
) {
  const t = String(threadKey || "").trim();
  if (!t) return { ok: false, error: "missing_thread_key" };
  try {
    if (fromNetworkLead) {
      await prepareDomForNetworkLead(page, threadKey, { fastMarketplace: false });
    }
  } catch (_) {}

  const open = await openThreadByClick(page, threadKey, {
    maxScrollSteps: 20,
    forensicAccountLogin: forensicAccountLogin || null,
  });
  if (!open || !open.ok) {
    return { ok: false, error: String((open && open.error) || "thread_open_failed") };
  }

  try {
    await humanPause("postThreadOpen", "post_open_link_recovery");
  } catch (_) {}

  const itemLinkAttempts = Math.max(4, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 8) || 8);
  const readyMs = Math.max(1500, Number(process.env.VIRTUS_DELTA_LINK_READY_MS || 8000) || 8000);
  let itemLink = null;
  try {
    itemLink = await extractMarketplaceItemLinkWithRetry(page, {
      attempts: itemLinkAttempts,
      readinessTimeoutMs: readyMs,
      forensicAccountLogin: forensicAccountLogin || null,
      threadKey: t,
    });
  } catch (_) {}
  if (!itemLink) {
    return { ok: false, error: "item_link_missing" };
  }
  return { ok: true, item_link: itemLink };
}

/** Falha terminal: sem link/runtime — não adianta retry de listing. */
function __deltaIsTerminalCityCollectError(err) {
  const s = String(err || "").trim().toLowerCase();
  if (!s) return false;
  return (
    s === "city_collector_item_link_missing" ||
    s === "item_link_missing" ||
    s === "item_link_missing_after_deferred_recovery" ||
    s === "delta_city_collector_unavailable" ||
    s === "delta_city_collector_runtime_invalid" ||
    // Item errado no nav: não adianta retentar o mesmo link.
    s === "city_collector_nav_wrong_item"
  );
}

/**
 * Com item_link válido: timeout/nav/DOM miss são retryáveis.
 * Pending só depois de esgotar rounds soberanos (ou erro terminal).
 */
function __deltaIsRetryableCityCollectError(err) {
  return !__deltaIsTerminalCityCollectError(err);
}

/**
 * Collector soberano: um único hard-cap (jobTimeoutMs dentro do deltaCityCollector).
 * NÃO usar Promise.race externo aqui — isso gerava city_collect_reply_outer_timeout
 * e abandonava trabalho ainda vivo na fila serial.
 */
async function collectCityFromItemLinkUsingGlobalCollector({
  itemLink,
  threadKey,
  accountLogin,
  timeoutMs,
  attempts,
  page,
}) {
  if (typeof getDeltaCityCollector !== "function") {
    return { ok: false, error: "delta_city_collector_unavailable" };
  }
  try {
    const collector = await getDeltaCityCollector();
    if (!collector || typeof collector.collectCityFromItemLink !== "function") {
      return { ok: false, error: "delta_city_collector_runtime_invalid" };
    }
    let sessionCookies = [];
    try {
      if (page && typeof page.cookies === "function") {
        const cookiesA = await page.cookies("https://www.facebook.com").catch(() => []);
        const cookiesB = await page.cookies("https://facebook.com").catch(() => []);
        sessionCookies = [...cookiesA, ...cookiesB].filter(Boolean);
      }
    } catch (_) {}
    const out = await collector.collectCityFromItemLink({
      item_link: itemLink,
      thread_key: threadKey,
      account_login: accountLogin,
      timeoutMs,
      attempts,
      session_cookies: sessionCookies,
    });
    return out && typeof out === "object" ? out : { ok: false, error: "delta_city_collector_unknown_error" };
  } catch (e) {
    return {
      ok: false,
      error: (e && e.message) ? String(e.message).slice(0, 220) : "delta_city_collector_exception",
    };
  }
}

function createSerialQueue() {
  // Fila de ação canônica (MÃOS):
  // - FIFO estrita por ordem de chegada
  // - sem preferências entre dashboard e chat novo
  // - execução 1 por vez para evitar atropelo de DOM
  const fifoQueue = [];
  let running = false;
  let depth = 0;
  let maxDepth = 0;
  let lastEnqueueAt = 0;
  let lastDequeueAt = 0;
  let lastDoneAt = 0;

  const drain = () => {
    if (running) return;
    const item = fifoQueue.shift();
    if (!item) return;
    running = true;
    lastDequeueAt = Date.now();

    Promise.resolve()
      .then(async () => {
        try {
          return await item.fn();
        } catch {
          return undefined;
        }
      })
      .then((out) => {
        try { item.resolve(out); } catch {}
      })
      .finally(() => {
        depth = Math.max(0, depth - 1);
        lastDoneAt = Date.now();
        running = false;
        drain();
      });
  };

  const enqueue = (fn) => {
    const enqueuedAt = Date.now();
    depth = Math.max(0, depth + 1);
    maxDepth = Math.max(maxDepth, depth);
    lastEnqueueAt = enqueuedAt;
    return new Promise((resolve) => {
      fifoQueue.push({ fn, resolve });
      drain();
    });
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

  await __gotoWithBootInterlock(page, urlInicial, {
    timeoutMs: 45000,
    profileName: ACCOUNT_LOGIN,
    bootInterlockEnabled: true,
    bootInterlockHoldMs: 3000,
  });
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
      const mpBoot = await __raceMarketplaceActivate(page, {
        timeoutMs: DELTA_MARKETPLACE_BOOT_TIMEOUT_MS,
        reason: "boot_standalone",
      });
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
  const replyDispatchStateByClientId = new Map(); // client_message_id -> { state, at, thread_key }
  const REPLY_DISPATCH_ID_TTL_MS = Math.max(
    60_000,
    Number(process.env.VIRTUS_DELTA_REPLY_DISPATCH_ID_TTL_MS || (6 * 60 * 60 * 1000)) || (6 * 60 * 60 * 1000)
  );
  const REPLY_DISPATCH_ID_MAX = Math.max(
    500,
    Number(process.env.VIRTUS_DELTA_REPLY_DISPATCH_ID_MAX || 12_000) || 12_000
  );
  const autoGreetingEnabled = String(process.env.VIRTUS_DELTA_AUTO_GREETING || "1").trim() === "1";
  const autoGreetingSentThreads = new Set(); // threadKey
  const autoGreetingTimers = new Map(); // threadKey -> Timeout
  const greetingStateByThread = new Map(); // threadKey -> { sentAt, greetingText, itemLink, city, citySource, cityStatus, linkStatus }
  // Patch tardio de cidade (collecting → resolved/pending) sem bloquear hands.
  let cityCollectSettledHandler = null;
  // Late-link recovery timers (VM sob pressão: reabre thread depois, sem travar saudação).
  const linkRecoveryTimers = new Map(); // threadKey -> Timeout
  // City collect em background (com link): reply/hands NÃO matam o collector.
  const cityCollectBgTimers = new Map(); // threadKey -> Timeout
  const cityCollectBgInFlight = new Set(); // threadKey
  let lastCrossThreadSendAt = 0;
  let lastCrossThreadKey = "";

  function clearLinkRecoveryTimer(threadKey) {
    const t = String(threadKey || "").trim();
    if (!t) return;
    const h = linkRecoveryTimers.get(t);
    if (h) {
      try { clearTimeout(h); } catch (_) {}
      linkRecoveryTimers.delete(t);
    }
  }

  function clearCityCollectBgTimer(threadKey) {
    const t = String(threadKey || "").trim();
    if (!t) return;
    const h = cityCollectBgTimers.get(t);
    if (h) {
      try { clearTimeout(h); } catch (_) {}
      cityCollectBgTimers.delete(t);
    }
  }

  /**
   * Plano A soberano: com item_link válido, coleta cidade em background com N rounds + waves.
   * - Não bloqueia reply/hands.
   * - Mantém city_status=collecting até resolved ou falha real (waves esgotadas / terminal).
   * - Com link válido: NÃO morre no 1º timeout — retenta em wave extra.
   * - Pending só no fim — nunca por outer-timeout burro do reply.
   */
  function scheduleBackgroundCityCollectFromLink({
    threadKey,
    itemLink,
    customerName = null,
    greetingText = null,
    greetingSentAt = null,
    cityCollectorTimeoutMs,
    cityCollectorAttempts,
    reason = "bg_city_collect",
    force = false,
  } = {}) {
    const t = String(threadKey || "").trim();
    const link = String(itemLink || "").trim();
    if (!t || !link || !running) return { ok: false, scheduled: false, reason: "not_ready" };

    const st0 = greetingStateByThread.get(t) || null;
    if (
      st0 &&
      st0.cityStatus === "resolved" &&
      st0.city &&
      __deltaCityLabelIsClean(st0.city, st0.citySource)
    ) {
      return { ok: true, scheduled: false, deduped: true, reason: "already_resolved" };
    }
    if (cityCollectBgInFlight.has(t)) {
      // Já coletando: se force com mesmo link, só confirma; se link novo, guarda rearm.
      if (force && st0 && String(st0.itemLink || "").trim() !== link) {
        greetingStateByThread.set(t, {
          ...(st0 || {}),
          itemLink: link,
          cityCollectBgPendingRearm: true,
          cityCollectBgPendingRearmReason: String(reason || "link_upgrade").slice(0, 80),
        });
      }
      return { ok: true, scheduled: false, deduped: true, reason: "inflight" };
    }

    const maxRounds = Math.max(
      2,
      Math.min(6, Number(process.env.VIRTUS_DELTA_CITY_COLLECT_BG_ROUNDS || 4) || 4)
    );
    const maxWaves = Math.max(
      1,
      Math.min(3, Number(process.env.VIRTUS_DELTA_CITY_COLLECT_BG_WAVES || 2) || 2)
    );
    const waveGapMin = Math.max(
      8_000,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECT_BG_WAVE_GAP_MIN_MS || 20_000) || 20_000
    );
    const waveGapMax = Math.max(
      waveGapMin,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECT_BG_WAVE_GAP_MAX_MS || 45_000) || 45_000
    );
    const collectorTimeout = Math.max(12000, Number(cityCollectorTimeoutMs || 28000) || 28000);
    const collectorAttempts = Math.max(1, Math.min(5, Number(cityCollectorAttempts || 3) || 3));
    const backoffMin = Math.max(
      2000,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECT_BG_BACKOFF_MIN_MS || 4000) || 4000
    );
    const backoffMax = Math.max(
      backoffMin,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECT_BG_BACKOFF_MAX_MS || 9000) || 9000
    );
    const nomeClienteLimpo = String(customerName || "").trim() || null;
    const waveNow = Math.max(1, Number((st0 && st0.cityCollectBgWave) || 1) || 1);

    const settleToHandler = (payload) => {
      const handler = typeof cityCollectSettledHandler === "function" ? cityCollectSettledHandler : null;
      if (!handler) return Promise.resolve(null);
      return Promise.resolve(handler(payload)).catch(() => {});
    };

    const markCollecting = () => {
      const prior = greetingStateByThread.get(t) || null;
      if (
        prior &&
        prior.cityStatus === "resolved" &&
        prior.city &&
        __deltaCityLabelIsClean(prior.city, prior.citySource)
      ) {
        return;
      }
      greetingStateByThread.set(t, {
        sentAt: Number(greetingSentAt || (prior && prior.sentAt) || Date.now()) || Date.now(),
        greetingText: String(greetingText || (prior && prior.greetingText) || "").trim(),
        itemLink: link,
        city: null,
        citySource: null,
        cityStatus: "collecting",
        linkStatus: "resolved",
        cityCollectBgScheduled: true,
        cityCollectBgWave: waveNow,
        linkRecoveryScheduled: !!(prior && prior.linkRecoveryScheduled),
        linkRecoveryWave: Number((prior && prior.linkRecoveryWave) || 0) || 0,
      });
    };

    const finishInFlight = () => {
      cityCollectBgInFlight.delete(t);
      clearCityCollectBgTimer(t);
    };

    cityCollectBgInFlight.add(t);
    markCollecting();

    const runRound = (round) => {
      if (!running) {
        finishInFlight();
        return false;
      }
      clearCityCollectBgTimer(t);
      const delayMs = round <= 1 ? 0 : randomBetween(backoffMin, backoffMax);
      const timer = setTimeout(() => {
        cityCollectBgTimers.delete(t);
        (async () => {
          try {
            if (!running) return;
            const stNow = greetingStateByThread.get(t) || null;
            if (
              stNow &&
              stNow.cityStatus === "resolved" &&
              stNow.city &&
              __deltaCityLabelIsClean(stNow.city, stNow.citySource)
            ) {
              return;
            }

            markCollecting();
            try {
              __forensicEdgeEmit({
                account_login: ACCOUNT_LOGIN,
                thread_key: t,
                flow_stage: "city_collect_bg_attempt",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  reason: String(reason || "bg_city_collect").slice(0, 80),
                  round,
                  rounds_max: maxRounds,
                  wave: waveNow,
                  waves_max: maxWaves,
                  item_link: link,
                },
              });
            } catch (_) {}

            const cityOut = await collectCityFromItemLinkUsingGlobalCollector({
              itemLink: link,
              threadKey: t,
              accountLogin: ACCOUNT_LOGIN,
              timeoutMs: collectorTimeout,
              attempts: collectorAttempts,
              page,
            }).catch((e) => ({
              ok: false,
              error: (e && e.message) ? String(e.message) : "city_collect_bg_exception",
            }));

            const stAfter = greetingStateByThread.get(t) || null;
            if (
              stAfter &&
              stAfter.cityStatus === "resolved" &&
              stAfter.city &&
              __deltaCityLabelIsClean(stAfter.city, stAfter.citySource)
            ) {
              return;
            }

            const lateCity = String((cityOut && cityOut.ok && cityOut.cidade) || "").trim() || null;
            if (lateCity) {
              const lateSource =
                String((cityOut && cityOut.city_source) || "collector_listing_page").trim() ||
                "collector_listing_page";
              greetingStateByThread.set(t, {
                sentAt: Number((stAfter && stAfter.sentAt) || greetingSentAt || Date.now()) || Date.now(),
                greetingText: String((stAfter && stAfter.greetingText) || greetingText || "").trim(),
                itemLink: link,
                city: lateCity,
                citySource: lateSource,
                cityStatus: "resolved",
                linkStatus: "resolved",
                cityCollectBgScheduled: false,
                cityCollectBgWave: waveNow,
                linkRecoveryScheduled: false,
              });
              try {
                __forensicEdgeEmit({
                  account_login: ACCOUNT_LOGIN,
                  thread_key: t,
                  flow_stage: "city_collect_bg_resolved",
                  details: {
                    tag: "FORENSIC_DOM_REVERSE",
                    reason: String(reason || "").slice(0, 80),
                    round,
                    wave: waveNow,
                    city_clean: lateCity,
                    city_source: lateSource,
                    item_link: link,
                  },
                });
              } catch (_) {}
              await settleToHandler({
                account_login: ACCOUNT_LOGIN,
                thread_key: t,
                item_link: link,
                cidade: lateCity,
                city_source: lateSource,
                city_status: "resolved",
                cityOut: cityOut && typeof cityOut === "object" ? cityOut : null,
                customer_name: nomeClienteLimpo,
                client_name: nomeClienteLimpo,
                nome_cliente_limpo: nomeClienteLimpo,
              });
              return;
            }

            const err =
              String((cityOut && cityOut.error) || "city_collect_failed").trim() ||
              "city_collect_failed";
            const canRetryRound =
              __deltaIsRetryableCityCollectError(err) &&
              round < maxRounds;

            if (canRetryRound) {
              try {
                __forensicEdgeEmit({
                  account_login: ACCOUNT_LOGIN,
                  thread_key: t,
                  flow_stage: "city_collect_bg_retry",
                  details: {
                    tag: "FORENSIC_DOM_REVERSE",
                    reason: String(reason || "").slice(0, 80),
                    round,
                    rounds_max: maxRounds,
                    wave: waveNow,
                    waves_max: maxWaves,
                    collector_error: err.slice(0, 220),
                    item_link: link,
                  },
                });
              } catch (_) {}
              runRound(round + 1);
              return;
            }

            // Wave soberana: com link válido + erro retryável, não aceita "pending com link".
            const canRetryWave =
              __deltaIsRetryableCityCollectError(err) &&
              waveNow < maxWaves;

            if (canRetryWave) {
              const nextWave = waveNow + 1;
              greetingStateByThread.set(t, {
                sentAt: Number((stAfter && stAfter.sentAt) || greetingSentAt || Date.now()) || Date.now(),
                greetingText: String((stAfter && stAfter.greetingText) || greetingText || "").trim(),
                itemLink: link,
                city: null,
                citySource: null,
                cityStatus: "collecting",
                linkStatus: "resolved",
                cityCollectBgScheduled: true,
                cityCollectBgWave: nextWave,
                linkRecoveryScheduled: false,
              });
              await settleToHandler({
                account_login: ACCOUNT_LOGIN,
                thread_key: t,
                item_link: link,
                cidade: null,
                city_source: null,
                city_status: "collecting",
                cityOut: { ok: false, error: err, wave_retry: nextWave },
                customer_name: nomeClienteLimpo,
                client_name: nomeClienteLimpo,
                nome_cliente_limpo: nomeClienteLimpo,
              });
              try {
                __forensicEdgeEmit({
                  account_login: ACCOUNT_LOGIN,
                  thread_key: t,
                  flow_stage: "city_collect_bg_wave_retry",
                  details: {
                    tag: "FORENSIC_DOM_REVERSE",
                    reason: String(reason || "").slice(0, 80),
                    wave: nextWave,
                    waves_max: maxWaves,
                    collector_error: err.slice(0, 220),
                    item_link: link,
                    gap_ms_min: waveGapMin,
                    gap_ms_max: waveGapMax,
                  },
                });
              } catch (_) {}
              cityCollectBgInFlight.delete(t);
              const gapMs = randomBetween(waveGapMin, waveGapMax);
              const waveTimer = setTimeout(() => {
                cityCollectBgTimers.delete(t);
                if (!running) return;
                scheduleBackgroundCityCollectFromLink({
                  threadKey: t,
                  itemLink: link,
                  customerName: nomeClienteLimpo,
                  greetingText: String((stAfter && stAfter.greetingText) || greetingText || "").trim(),
                  greetingSentAt: Number((stAfter && stAfter.sentAt) || greetingSentAt || Date.now()) || Date.now(),
                  cityCollectorTimeoutMs: collectorTimeout,
                  cityCollectorAttempts: collectorAttempts,
                  reason: `city_bg_wave_${nextWave}`,
                  force: true,
                });
              }, gapMs);
              cityCollectBgTimers.set(t, waveTimer);
              return;
            }

            greetingStateByThread.set(t, {
              sentAt: Number((stAfter && stAfter.sentAt) || greetingSentAt || Date.now()) || Date.now(),
              greetingText: String((stAfter && stAfter.greetingText) || greetingText || "").trim(),
              itemLink: link,
              city: null,
              citySource: err,
              cityStatus: "pending",
              linkStatus: "resolved",
              cityCollectBgScheduled: false,
              cityCollectBgWave: waveNow,
              linkRecoveryScheduled: false,
            });
            try {
              __forensicEdgeEmit({
                account_login: ACCOUNT_LOGIN,
                thread_key: t,
                flow_stage: "city_collect_bg_pending",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  reason: String(reason || "").slice(0, 80),
                  round,
                  rounds_max: maxRounds,
                  wave: waveNow,
                  waves_max: maxWaves,
                  collector_error: err.slice(0, 220),
                  item_link: link,
                  terminal: __deltaIsTerminalCityCollectError(err),
                },
              });
            } catch (_) {}
            await settleToHandler({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              item_link: link,
              cidade: null,
              city_source: err,
              city_status: "pending",
              cityOut: cityOut && typeof cityOut === "object"
                ? cityOut
                : { ok: false, error: err },
              customer_name: nomeClienteLimpo,
              client_name: nomeClienteLimpo,
              nome_cliente_limpo: nomeClienteLimpo,
            });
          } finally {
            // Só libera in-flight se não houver próximo round/wave agendado.
            if (!cityCollectBgTimers.has(t)) {
              cityCollectBgInFlight.delete(t);
              // Link novo chegou durante a coleta: rearma na hora.
              try {
                const stEnd = greetingStateByThread.get(t) || null;
                if (
                  stEnd &&
                  stEnd.cityCollectBgPendingRearm &&
                  stEnd.itemLink &&
                  !(stEnd.cityStatus === "resolved" && stEnd.city)
                ) {
                  const rearmLink = String(stEnd.itemLink || "").trim();
                  greetingStateByThread.set(t, {
                    ...stEnd,
                    cityCollectBgPendingRearm: false,
                    cityCollectBgPendingRearmReason: null,
                  });
                  if (rearmLink) {
                    scheduleBackgroundCityCollectFromLink({
                      threadKey: t,
                      itemLink: rearmLink,
                      customerName: nomeClienteLimpo,
                      greetingText: String(stEnd.greetingText || greetingText || "").trim(),
                      greetingSentAt: Number(stEnd.sentAt || greetingSentAt || Date.now()) || Date.now(),
                      cityCollectorTimeoutMs: collectorTimeout,
                      cityCollectorAttempts: collectorAttempts,
                      reason: String(stEnd.cityCollectBgPendingRearmReason || "pending_rearm").slice(0, 80),
                      force: true,
                    });
                  }
                }
              } catch (_) {}
            }
          }
        })().catch(() => {
          cityCollectBgInFlight.delete(t);
        });
      }, delayMs);
      cityCollectBgTimers.set(t, timer);
      return true;
    };

    const started = runRound(1);
    return { ok: !!started, scheduled: !!started, wave: waveNow };
  }

  function scheduleDeferredLinkAndCityRecovery({
    threadKey,
    greetingText,
    greetingSentAt,
    cityCollectorTimeoutMs,
    cityCollectorAttempts,
    force = false,
  } = {}) {
    const t = String(threadKey || "").trim();
    if (!t || !running) return { ok: false, scheduled: false, reason: "not_ready" };
    const prior = greetingStateByThread.get(t) || null;
    if (prior && prior.itemLink && prior.cityStatus === "resolved" && prior.city) {
      return { ok: true, scheduled: false, deduped: true, reason: "already_resolved" };
    }
    // Já tem link: não precisa recovery de link — garante collect de cidade.
    if (prior && prior.itemLink && String(prior.itemLink).includes("marketplace/item/")) {
      const cityOut = scheduleBackgroundCityCollectFromLink({
        threadKey: t,
        itemLink: String(prior.itemLink).trim(),
        greetingText: String(greetingText || (prior && prior.greetingText) || "").trim(),
        greetingSentAt: Number(greetingSentAt || (prior && prior.sentAt) || Date.now()) || Date.now(),
        cityCollectorTimeoutMs,
        cityCollectorAttempts,
        reason: "deferred_already_has_link",
        force: !!force,
      });
      return {
        ok: !!(cityOut && cityOut.ok),
        scheduled: !!(cityOut && cityOut.scheduled),
        redirected_to_city: true,
        city: cityOut,
      };
    }
    if (prior && prior.linkRecoveryScheduled && !force) {
      return { ok: true, scheduled: false, deduped: true, reason: "link_recovery_inflight" };
    }

    const deferAttempts = Math.max(
      1,
      Math.min(6, Number(process.env.VIRTUS_DELTA_LINK_DEFER_ATTEMPTS || 4) || 4)
    );
    const deferMin = Math.max(2500, Number(process.env.VIRTUS_DELTA_LINK_DEFER_MS_MIN || 5000) || 5000);
    const deferMax = Math.max(deferMin, Number(process.env.VIRTUS_DELTA_LINK_DEFER_MS_MAX || 12000) || 12000);
    const maxLinkWaves = Math.max(
      1,
      Math.min(3, Number(process.env.VIRTUS_DELTA_LINK_DEFER_WAVES || 2) || 2)
    );
    const linkWaveGapMin = Math.max(
      10_000,
      Number(process.env.VIRTUS_DELTA_LINK_DEFER_WAVE_GAP_MIN_MS || 25_000) || 25_000
    );
    const linkWaveGapMax = Math.max(
      linkWaveGapMin,
      Number(process.env.VIRTUS_DELTA_LINK_DEFER_WAVE_GAP_MAX_MS || 55_000) || 55_000
    );
    const itemLinkAttempts = Math.max(4, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 8) || 8);
    const readyMs = Math.max(1500, Number(process.env.VIRTUS_DELTA_LINK_READY_MS || 8000) || 8000);
    const collectorTimeout = Math.max(12000, Number(cityCollectorTimeoutMs || 28000) || 28000);
    const collectorAttempts = Math.max(1, Math.min(5, Number(cityCollectorAttempts || 3) || 3));
    const linkWaveNow = Math.max(
      1,
      Number((prior && prior.linkRecoveryWave) || 1) || 1
    );

    greetingStateByThread.set(t, {
      sentAt: Number(greetingSentAt || (prior && prior.sentAt) || Date.now()) || Date.now(),
      greetingText: String(greetingText || (prior && prior.greetingText) || "").trim(),
      itemLink: (prior && prior.itemLink) || null,
      city: null,
      citySource: null,
      cityStatus: "collecting",
      linkStatus: "collecting",
      linkRecoveryScheduled: true,
      linkRecoveryWave: linkWaveNow,
      cityCollectBgWave: Number((prior && prior.cityCollectBgWave) || 0) || 0,
    });

    const settleToHandler = (payload) => {
      const handler = typeof cityCollectSettledHandler === "function" ? cityCollectSettledHandler : null;
      if (!handler) return Promise.resolve(null);
      return Promise.resolve(handler(payload)).catch(() => {});
    };

    const runAttempt = (attempt) => {
      if (!running) return false;
      clearLinkRecoveryTimer(t);
      // Backoff progressivo: tentativas tardias esperam mais (VM sob pressão).
      const attemptFactor = Math.min(3, Math.max(1, attempt));
      const waitMin = Math.floor(deferMin * (0.7 + 0.35 * attemptFactor));
      const waitMax = Math.floor(deferMax * (0.7 + 0.4 * attemptFactor));
      const timer = setTimeout(() => {
        linkRecoveryTimers.delete(t);
        enqueue(async () => {
          if (!running) return;
          const stNow = greetingStateByThread.get(t) || null;
          if (stNow && stNow.cityStatus === "resolved" && stNow.city) return;
          if (stNow && stNow.itemLink && stNow.linkStatus === "resolved" && stNow.cityStatus === "resolved") return;
          // Link surgiu por outro caminho enquanto esperávamos: só cidade.
          if (stNow && stNow.itemLink && String(stNow.itemLink).includes("marketplace/item/")) {
            greetingStateByThread.set(t, {
              ...stNow,
              linkStatus: "resolved",
              linkRecoveryScheduled: false,
              cityStatus: stNow.cityStatus === "resolved" ? "resolved" : "collecting",
            });
            scheduleBackgroundCityCollectFromLink({
              threadKey: t,
              itemLink: String(stNow.itemLink).trim(),
              greetingText: String((stNow && stNow.greetingText) || greetingText || "").trim(),
              greetingSentAt: Number((stNow && stNow.sentAt) || greetingSentAt || Date.now()) || Date.now(),
              cityCollectorTimeoutMs: collectorTimeout,
              cityCollectorAttempts: collectorAttempts,
              reason: "deferred_link_found_external",
              force: true,
            });
            return;
          }

          let recovered = null;
          try {
            const openOut = await openThreadAndExtractItemLink(page, t, {
              fromNetworkLead: false,
              forensicAccountLogin: ACCOUNT_LOGIN,
            });
            if (openOut && openOut.ok && openOut.item_link) {
              recovered = String(openOut.item_link || "").trim() || null;
            }
          } catch (_) {}
          if (!recovered) {
            try {
              recovered = await extractMarketplaceItemLinkWithRetry(page, {
                attempts: itemLinkAttempts,
                readinessTimeoutMs: readyMs,
                forensicAccountLogin: ACCOUNT_LOGIN,
                threadKey: t,
              });
            } catch (_) {}
          }
          recovered = String(recovered || "").trim() || null;

          try {
            __deltaLogTriagemDom({
              stage: recovered ? "link_deferred_hit" : "link_deferred_miss",
              thread_key: t,
              account_login: ACCOUNT_LOGIN,
              attempt,
              attempts_max: deferAttempts,
              wave: linkWaveNow,
              waves_max: maxLinkWaves,
              item_link: recovered,
            });
          } catch (_) {}
          try {
            __forensicEdgeEmit({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              flow_stage: recovered ? "link_deferred_hit" : "link_deferred_miss",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                attempt,
                attempts_max: deferAttempts,
                wave: linkWaveNow,
                waves_max: maxLinkWaves,
                item_link: recovered,
              },
            });
          } catch (_) {}

          if (!recovered) {
            if (attempt < deferAttempts) {
              runAttempt(attempt + 1);
              return;
            }
            // Wave extra de link: lentidão/VM sob pressão — não rende com 1 onda.
            if (linkWaveNow < maxLinkWaves) {
              const nextWave = linkWaveNow + 1;
              greetingStateByThread.set(t, {
                sentAt: Number((stNow && stNow.sentAt) || greetingSentAt || Date.now()),
                greetingText: String((stNow && stNow.greetingText) || greetingText || "").trim(),
                itemLink: null,
                city: null,
                citySource: null,
                cityStatus: "collecting",
                linkStatus: "collecting",
                linkRecoveryScheduled: false,
                linkRecoveryWave: nextWave,
              });
              await settleToHandler({
                account_login: ACCOUNT_LOGIN,
                thread_key: t,
                item_link: null,
                cidade: null,
                city_source: null,
                city_status: "collecting",
                cityOut: { ok: false, error: "item_link_wave_retry", wave: nextWave },
              });
              try {
                __forensicEdgeEmit({
                  account_login: ACCOUNT_LOGIN,
                  thread_key: t,
                  flow_stage: "link_deferred_wave_retry",
                  details: {
                    tag: "FORENSIC_DOM_REVERSE",
                    wave: nextWave,
                    waves_max: maxLinkWaves,
                    gap_ms_min: linkWaveGapMin,
                    gap_ms_max: linkWaveGapMax,
                  },
                });
              } catch (_) {}
              const gapMs = randomBetween(linkWaveGapMin, linkWaveGapMax);
              const waveTimer = setTimeout(() => {
                linkRecoveryTimers.delete(t);
                if (!running) return;
                scheduleDeferredLinkAndCityRecovery({
                  threadKey: t,
                  greetingText: String((stNow && stNow.greetingText) || greetingText || "").trim(),
                  greetingSentAt: Number((stNow && stNow.sentAt) || greetingSentAt || Date.now()) || Date.now(),
                  cityCollectorTimeoutMs: collectorTimeout,
                  cityCollectorAttempts: collectorAttempts,
                  force: true,
                });
              }, gapMs);
              linkRecoveryTimers.set(t, waveTimer);
              return;
            }
            greetingStateByThread.set(t, {
              sentAt: Number((stNow && stNow.sentAt) || greetingSentAt || Date.now()),
              greetingText: String((stNow && stNow.greetingText) || greetingText || "").trim(),
              itemLink: null,
              city: null,
              citySource: "fallback_city_pending",
              cityStatus: "pending",
              linkStatus: "pending",
              linkRecoveryScheduled: false,
              linkRecoveryWave: linkWaveNow,
            });
            await settleToHandler({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              item_link: null,
              cidade: null,
              city_source: "fallback_city_pending",
              city_status: "pending",
              cityOut: { ok: false, error: "item_link_missing_after_deferred_recovery" },
            });
            return;
          }

          // Link recuperado: patch collecting + cidade em background com retry soberano.
          // NÃO fazer collect síncrono aqui (engessa hands / gera pending por timeout).
          greetingStateByThread.set(t, {
            sentAt: Number((stNow && stNow.sentAt) || greetingSentAt || Date.now()),
            greetingText: String((stNow && stNow.greetingText) || greetingText || "").trim(),
            itemLink: recovered,
            city: null,
            citySource: null,
            cityStatus: "collecting",
            linkStatus: "resolved",
            linkRecoveryScheduled: false,
            linkRecoveryWave: linkWaveNow,
            cityCollectBgWave: 1,
          });
          await settleToHandler({
            account_login: ACCOUNT_LOGIN,
            thread_key: t,
            item_link: recovered,
            cidade: null,
            city_source: null,
            city_status: "collecting",
            cityOut: { ok: true, deferred: true },
          });
          const bg = scheduleBackgroundCityCollectFromLink({
            threadKey: t,
            itemLink: recovered,
            greetingText: String((stNow && stNow.greetingText) || greetingText || "").trim(),
            greetingSentAt: Number((stNow && stNow.sentAt) || greetingSentAt || Date.now()) || Date.now(),
            cityCollectorTimeoutMs: collectorTimeout,
            cityCollectorAttempts: collectorAttempts,
            reason: "deferred_link_hit",
            force: true,
          });
          if (!(bg && (bg.scheduled || bg.deduped))) {
            try {
              __forensicEdgeEmit({
                account_login: ACCOUNT_LOGIN,
                thread_key: t,
                flow_stage: "city_bg_schedule_failed",
                details: {
                  tag: "FORENSIC_DOM_REVERSE",
                  item_link: recovered,
                  bg,
                },
              });
            } catch (_) {}
          }
        }).catch(() => {});
      }, randomBetween(waitMin, waitMax));
      linkRecoveryTimers.set(t, timer);
      return true;
    };

    const started = runAttempt(1);
    return { ok: !!started, scheduled: !!started, wave: linkWaveNow };
  }

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
    if (envDirect) {
      const normalized = envDirect.replace(/\/+$/, "");
      if (/\/api\/attendance\/confirm-delivery$/i.test(normalized)) return normalized;
      return `${normalized}/api/attendance/confirm-delivery`;
    }
    const base = String(process.env.CT_BASE_URL || process.env.CT_URL || "").trim();
    if (base) return `${base.replace(/\/+$/, "")}/api/attendance/confirm-delivery`;
    // Primário canônico do CT de atendimentos (não subdomínio UUID).
    return "https://atendimentos.convenientetecnologia.com/api/attendance/confirm-delivery";
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

  function pruneReplyDispatchState() {
    try {
      const now = Date.now();
      for (const [cid, info] of replyDispatchStateByClientId.entries()) {
        const at = Number(info && info.at || 0) || 0;
        if (!at || (now - at) > REPLY_DISPATCH_ID_TTL_MS) {
          replyDispatchStateByClientId.delete(cid);
        }
      }
      if (replyDispatchStateByClientId.size <= REPLY_DISPATCH_ID_MAX) return;
      const ranked = Array.from(replyDispatchStateByClientId.entries())
        .map(([cid, info]) => ({ cid, at: Number(info && info.at || 0) || 0 }))
        .sort((a, b) => a.at - b.at);
      const overflow = replyDispatchStateByClientId.size - REPLY_DISPATCH_ID_MAX;
      for (let i = 0; i < overflow; i++) {
        const cid = ranked[i] && ranked[i].cid;
        if (cid) replyDispatchStateByClientId.delete(cid);
      }
    } catch (_) {}
  }

  function getReplyDispatchState(clientMessageId) {
    const cid = String(clientMessageId || "").trim();
    if (!cid) return null;
    pruneReplyDispatchState();
    return replyDispatchStateByClientId.get(cid) || null;
  }

  function setReplyDispatchState(clientMessageId, state, threadKey = null) {
    const cid = String(clientMessageId || "").trim();
    if (!cid) return;
    pruneReplyDispatchState();
    replyDispatchStateByClientId.set(cid, {
      state: String(state || "").trim() || "inflight",
      at: Date.now(),
      thread_key: String(threadKey || "").trim() || null
    });
  }

  function clearReplyDispatchState(clientMessageId) {
    const cid = String(clientMessageId || "").trim();
    if (!cid) return;
    try { replyDispatchStateByClientId.delete(cid); } catch (_) {}
  }

  function resolveCtReverseDeliveryStatusUrl() {
    try {
      const reverseUrl = "https://convenientetecnologia.com";
      return `${reverseUrl}/api/attendance/reverse-delivery-status`;
    } catch {
      return "";
    }
  }

  function resolveCtReverseDeliveryStatusFallbackUrl() {
    try {
      return "https://atendimentos.convenientetecnologia.com/api/attendance/reverse-delivery-status";
    } catch {
      return "";
    }
  }

  function kickReverseDeliveryStatus({ client_message_id, thread_key, status, error } = {}) {
    try {
      const cid = String(client_message_id || "").trim();
      if (!cid) return;
      let url = resolveCtReverseDeliveryStatusUrl();
      if (!url) return;
      const payload = {
        server_id: SERVER_ID,
        account_login: ACCOUNT_LOGIN,
        thread_key: String(thread_key || "").trim() || null,
        client_message_id: cid,
        status: String(status || "error_failed_to_send").trim() || "error_failed_to_send",
        error: String(error || "").slice(0, 500) || null,
      };
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
            let r = await postJsonWithTimeout(url, payload, { timeoutMs: 4500 }).catch((e) => ({
              ok: false,
              status: 0,
              error: (e && e.message) ? String(e.message) : String(e),
            }));
            if (!(r && r.ok) && (Number(r && r.status || 0) || 0) === 404) {
              const fallbackUrl = resolveCtReverseDeliveryStatusFallbackUrl();
              if (fallbackUrl && fallbackUrl !== url) {
                try {
                  __forensicEdgeEmit({
                    account_login: ACCOUNT_LOGIN,
                    thread_key: payload.thread_key,
                    flow_stage: "reverse_delivery_reroute_attempt",
                    details: {
                      tag: "FORENSIC_DOM_REVERSE",
                      from_url: url,
                      to_url: fallbackUrl,
                      client_message_id: cid,
                      ts_ms: Date.now(),
                    }
                  });
                } catch (_) {}
                const r2 = await postJsonWithTimeout(fallbackUrl, payload, { timeoutMs: 4500 }).catch((e) => ({
                  ok: false,
                  status: 0,
                  error: (e && e.message) ? String(e.message) : String(e),
                }));
                if (r2 && r2.ok) {
                  r = r2;
                  url = fallbackUrl;
                } else if (!(r && r.ok)) {
                  r = r2 || r;
                }
              }
            }
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
      function __deriveCtConfirmCanonicalFallbackUrl() {
        try {
          return "https://atendimentos.convenientetecnologia.com/api/attendance/confirm-delivery";
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
            r = await postJsonWithTimeout(url, payload, { timeoutMs: 4500 });
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

          // Auto-cura de roteamento (404): tenta fallback canônico de atendimentos
          // e depois endpoint por server_id antes de dead-letter.
          try {
            const stTry = Number(r && r.status || 0) || 0;
            const is404 = stTry === 404 || String(r && r.error || "").includes("http_404");
            const looksLikeCtDomain = /:\/\/([A-Za-z0-9.-]+\.)?convenientetecnologia\.com\/?/i.test(String(url || ""));
            if (is404 && looksLikeCtDomain) {
              let reroutedSuccess = false;
              // Ordem: canônico atendimentos → convenientetecnologia.com → subdomínio server_id (último recurso).
              const rerouteCandidates = [
                __deriveCtConfirmCanonicalFallbackUrl(),
                "https://convenientetecnologia.com/api/attendance/confirm-delivery",
                __deriveCtConfirmUrlFromServerId(payload && payload.server_id),
              ].filter((v, idx, arr) => !!v && arr.indexOf(v) === idx && v !== url);

              for (const alt of rerouteCandidates) {
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
                const r2 = await postJsonWithTimeout(alt, payload, { timeoutMs: 4500 }).catch((e) => ({
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
                  reroutedSuccess = true;
                  break;
                }
                if (!(r && r.ok)) r = r2 || r;
              }
              if (reroutedSuccess) {
                continue;
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
  let page = pages[restrictTab] || pages[0] || null;
  const bootNome = String(nome || ACCOUNT_LOGIN || "").trim();
  if (!page) {
    if (typeof newPageDaConta !== "function") throw new Error("virtusDelta_boot_no_gate");
    if (!bootNome) throw new Error("virtusDelta_boot_no_nome");
    page = await newPageDaConta(browser, bootNome, { source: "virtusDelta_boot" });
  } else {
    if (!bootNome) throw new Error("virtusDelta_boot_no_nome");
    if (typeof blindarPaginaDaConta !== "function") throw new Error("virtusDelta_boot_no_gate");
    await blindarPaginaDaConta(page, bootNome, { source: "virtusDelta_boot_existing" });
  }
  attachDeltaNavigationFirewall(page, { profileName: ACCOUNT_LOGIN || nome });

  // Boot minimal: garantir que estamos em /messages (permitido no boot; proibição é no reply flow).
  try {
    const u0 = String(page.url ? page.url() : "");
    if (!/facebook\.com\/messages/i.test(u0)) {
      await __gotoWithBootInterlock(page, startUrl, {
        timeoutMs: 45000,
        profileName: ACCOUNT_LOGIN || nome,
        bootInterlockEnabled: (cfg && Object.prototype.hasOwnProperty.call(cfg, "bootInterlockEnabled")) ? !!cfg.bootInterlockEnabled : true,
        bootInterlockHoldMs: Number(cfg && cfg.bootInterlockHoldMs || 3000) || 3000,
        bootInterlockBeforeNavigate: (cfg && typeof cfg.bootInterlockBeforeNavigate === "function") ? cfg.bootInterlockBeforeNavigate : null,
        bootInterlockIsEarReady: (cfg && typeof cfg.bootInterlockIsEarReady === "function") ? cfg.bootInterlockIsEarReady : null,
      });
    }
  } catch (_) {}
  try {
    await waitForMessagesBootStable(page, "messages_ready_worker");
  } catch (_) {}
  try {
    // Cura vitalícia do freeze por seleção: injeta CSS global anti-seleção logo após o boot.
    await __injectAntiSelectionCss(page, { profileName: ACCOUNT_LOGIN || nome, reason: "boot_worker" });
  } catch (_) {}
  if (DELTA_MARKETPLACE_AUTOFILTER_ENABLED) {
    try {
      // Hands liberam em <= BOOT_TIMEOUT mesmo se o filtro DOM nao validar.
      const mpBoot = await __raceMarketplaceActivate(page, {
        timeoutMs: DELTA_MARKETPLACE_BOOT_TIMEOUT_MS,
        reason: "boot_worker",
      });
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

  async function enforceGlobalDeltaCooldown(accountLogin = ACCOUNT_LOGIN, policy = null) {
    const custom = (policy && typeof policy === "object") ? policy : null;
    const minBase = Number(CROSS_THREAD_SEND_GAP && CROSS_THREAD_SEND_GAP.min || 3_000) || 3_000;
    const maxBase = Number(CROSS_THREAD_SEND_GAP && CROSS_THREAD_SEND_GAP.max || 12_000) || 12_000;
    const minMs = Math.max(0, Number(custom && custom.minMs != null ? custom.minMs : minBase) || minBase);
    const maxMs = Math.max(minMs, Number(custom && custom.maxMs != null ? custom.maxMs : maxBase) || maxBase);
    const policyReason = String(custom && custom.reason || "default").trim() || "default";
    const delayMs = randomBetween(minMs, maxMs);
    const last = readLastDeltaSendTimestamp(accountLogin);
    const now = Date.now();
    const elapsed = Math.max(0, now - last);
    if (last > now + 1500) {
      try {
        __forensicEdgeEmit({
          account_login: String(accountLogin || ACCOUNT_LOGIN || "").trim() || null,
          thread_key: null,
          flow_stage: "cooldown_clock_skew_guard",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            now_ts: now,
            last_send_ts: last,
            skew_ms: last - now,
            action: "elapsed_clamped_to_zero",
          }
        });
      } catch (_) {}
    }
    if (!last || elapsed >= delayMs) return { waitedMs: 0, delayMs, elapsedMs: elapsed };

    const remainMs = Math.max(0, Math.min(maxMs, delayMs - elapsed));
    const endAt = now + remainMs;
    try {
      __forensicEdgeEmit({
        account_login: String(accountLogin || ACCOUNT_LOGIN || "").trim() || null,
        thread_key: null,
        flow_stage: "cooldown_execution_wait",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          phase: "begin",
          policy_reason: policyReason,
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
          policy_reason: policyReason,
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

  /**
   * Após reply do CT (IA): thread já aberta — coleta nome/link/cidade (via dupla)
   * e patcha o CT. Não inventa fallback fraco; se não veio, agenda recovery.
   */
  async function collectMetadataAfterCtReply(threadKey, sendOut) {
    const t = String(threadKey || "").trim();
    if (!t || !running) return { ok: false, error: "not_ready" };
    const prior = greetingStateByThread.get(t) || null;
    // Só pula recollect se cidade limpa + fonte forte (dual/âncora). Suja = rearma.
    if (
      prior &&
      prior.cityStatus === "resolved" &&
      prior.city &&
      prior.itemLink &&
      __deltaCityLabelIsClean(prior.city, prior.citySource)
    ) {
      return { ok: true, skipped: "already_resolved" };
    }

    const cityCollectorTimeoutMs = Math.max(
      12_000,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 28_000) || 28_000
    );
    const cityCollectorAttempts = Math.max(
      1,
      Math.min(5, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_ATTEMPTS || 3) || 3)
    );
    const itemLinkAttempts = Math.max(4, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 8) || 8);
    const linkReadyMs = Math.max(1500, Number(process.env.VIRTUS_DELTA_LINK_READY_MS || 8000) || 8000);

    let itemLink = String((sendOut && sendOut.item_link) || (prior && prior.itemLink) || "").trim() || null;
    if (!itemLink) {
      try {
        itemLink = await extractMarketplaceItemLinkWithRetry(page, {
          attempts: itemLinkAttempts,
          readinessTimeoutMs: linkReadyMs,
          forensicAccountLogin: ACCOUNT_LOGIN,
          threadKey: t,
        });
      } catch (_) {
        itemLink = null;
      }
    }
    itemLink = String(itemLink || "").trim() || null;

    let nomeClienteLimpo = null;
    try {
      nomeClienteLimpo = String(await extractLeadClientNameFromFeedDom(page) || "").trim() || null;
    } catch (_) {
      nomeClienteLimpo = null;
    }

    const settleToHandler = (payload) => {
      const handler = typeof cityCollectSettledHandler === "function" ? cityCollectSettledHandler : null;
      if (!handler) return Promise.resolve(null);
      return Promise.resolve(handler(payload)).catch(() => {});
    };

    if (!itemLink) {
      // Sem link: NÃO resolver cidade por regex do Messenger (lixo de título vira "sem cobertura").
      // Match duplo (Anunciado ∩ Localização) exige página do item — fica collecting + recovery de link.
      const priorPendingNoLink =
        !!(prior && (prior.cityStatus === "pending" || prior.linkStatus === "pending"));
      try {
        scheduleDeferredLinkAndCityRecovery({
          threadKey: t,
          greetingText: String((prior && prior.greetingText) || "").trim(),
          greetingSentAt: Number((prior && prior.sentAt) || Date.now()) || Date.now(),
          cityCollectorTimeoutMs,
          cityCollectorAttempts,
          force: priorPendingNoLink,
        });
      } catch (_) {}
      await settleToHandler({
        account_login: ACCOUNT_LOGIN,
        thread_key: t,
        item_link: null,
        customer_name: nomeClienteLimpo,
        client_name: nomeClienteLimpo,
        nome_cliente_limpo: nomeClienteLimpo,
        cidade: null,
        city_status: "collecting",
        city_source: null,
      });
      return { ok: true, deferred: true, name: nomeClienteLimpo };
    }

    // Link OK: reply NÃO espera / NÃO mata o collector.
    // Patch imediato collecting + link/nome; cidade resolve em background com retry.
    // (Bug forense 4/4: city_collect_reply_outer_timeout → pending com link válido.)
    if (
      prior &&
      prior.cityStatus === "resolved" &&
      prior.city &&
      __deltaCityLabelIsClean(prior.city, prior.citySource)
    ) {
      await settleToHandler({
        account_login: ACCOUNT_LOGIN,
        thread_key: t,
        item_link: itemLink,
        customer_name: nomeClienteLimpo,
        client_name: nomeClienteLimpo,
        nome_cliente_limpo: nomeClienteLimpo,
        cidade: prior.city,
        city_source: prior.citySource || "collector_listing_page",
        city_status: "resolved",
      });
      return {
        ok: true,
        cidade: prior.city,
        city_status: "resolved",
        link_anuncio: itemLink,
        nome_cliente_limpo: nomeClienteLimpo,
      };
    }

    // LEI: com link, soberano = collector match-duplo (Anunciado ∩ Localização) com retry em BG.
    // NUNCA resolver aqui por extractCityFromMarketplaceDom / dom_live_fallback (regex do chat).
    // Link OK (inclusive tardio pós-pending): SEMPRE rearma cidade — never leave phone+link sem cidade.
    const forceCityRearm =
      !!(prior && (prior.cityStatus === "pending" || prior.cityStatus === "collecting" || !prior.city));
    greetingStateByThread.set(t, {
      sentAt: Number((prior && prior.sentAt) || Date.now()) || Date.now(),
      greetingText: String((prior && prior.greetingText) || "").trim(),
      itemLink,
      city: null,
      citySource: null,
      cityStatus: "collecting",
      linkStatus: "resolved",
      // Reply/IA = nova chance soberana: zera wave pra não herdar esgotamento antigo.
      cityCollectBgWave: 1,
    });
    await settleToHandler({
      account_login: ACCOUNT_LOGIN,
      thread_key: t,
      item_link: itemLink,
      customer_name: nomeClienteLimpo,
      client_name: nomeClienteLimpo,
      nome_cliente_limpo: nomeClienteLimpo,
      cidade: null,
      city_source: null,
      city_status: "collecting",
    });
    scheduleBackgroundCityCollectFromLink({
      threadKey: t,
      itemLink,
      customerName: nomeClienteLimpo,
      greetingText: String((prior && prior.greetingText) || "").trim(),
      greetingSentAt: Number((prior && prior.sentAt) || Date.now()) || Date.now(),
      cityCollectorTimeoutMs,
      cityCollectorAttempts,
      reason: forceCityRearm ? "reply_meta_bg_rearm" : "reply_meta_bg",
      force: true,
    });
    try {
      __forensicEdgeEmit({
        account_login: ACCOUNT_LOGIN,
        thread_key: t,
        flow_stage: "city_collect_reply_deferred_bg",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          item_link: itemLink,
          city_status: "collecting",
        },
      });
    } catch (_) {}
    try {
      logInfo(
        `[virtusDelta][reply_meta] thread_key=${t} city=- link=sim name=${nomeClienteLimpo || "-"} mode=bg_collect`
      );
    } catch (_) {}

    return {
      ok: true,
      cidade: null,
      city_status: "collecting",
      link_anuncio: itemLink,
      nome_cliente_limpo: nomeClienteLimpo,
      city_collect_deferred: true,
    };
  }

  async function sendDeltaReplyNow({
    threadKey,
    textoResposta,
    clientMessageId = null,
    threadKeyCandidates = [],
    __candidateHop = 0
  }) {
    if (!running || !epochOk()) return { ok: false, error: "delta_runtime_not_ready" };
    const t = String(threadKey || "").trim();
    const msg = String(textoResposta || "").replace(/\r/g, "");
    const cmid = String(clientMessageId || "").trim() || null;
    if (!t || !msg) return { ok: false, error: "missing_thread_key_or_texto_resposta" };
    // Melhor primeiro; pessoal 1000… por último. Até 12 candidatos.
    const normalizedCandidates = __deltaRankThreadKeyCandidatesLocal([
      t,
      ...(Array.isArray(threadKeyCandidates) ? threadKeyCandidates : []),
    ]).slice(0, 12);

    // Primário lixo (timestamp/perfil): nunca navegar — promove 1º marketplace hop-worthy.
    if (__deltaIsGarbageThreadTokenLocal(t)) {
      const rescue = (
        normalizedCandidates.find(__deltaIsHopWorthyThreadKeyLocal)
        || (Array.isArray(threadKeyCandidates) ? threadKeyCandidates : [])
          .map((v) => String(v || "").trim())
          .find(__deltaIsHopWorthyThreadKeyLocal)
        || ""
      );
      if (rescue && Number(__candidateHop || 0) < 10) {
        try {
          __forensicEdgeEmit({
            account_login: ACCOUNT_LOGIN,
            thread_key: t,
            flow_stage: "reply_garbage_primary_rescued",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              from_thread_key: t,
              to_thread_key: rescue,
              candidate_hop: Number(__candidateHop || 0) + 1,
              ts_ms: Date.now(),
            },
          });
        } catch (_) {}
        return sendDeltaReplyNow({
          threadKey: rescue,
          textoResposta: msg,
          clientMessageId: cmid,
          threadKeyCandidates: normalizedCandidates.filter((v) => v !== rescue),
          __candidateHop: Number(__candidateHop || 0) + 1,
        });
      }
      return {
        ok: false,
        error: "candidates_exhausted:garbage_primary_thread_key",
        status: "send_failed",
        nonretryable: false,
        thread_key: t,
      };
    }

    // Se o primário veio pior que um irmão, ainda tenta o pedido atual primeiro
    // (já escolhido upstream); alternativas = resto ordenado sem o atual.
    const alternativeCandidates = normalizedCandidates.filter((v) => v !== t);

    // Drenagem rápida de linha aberta:
    // se a thread já está aberta/selecionada, mantém o canal e aplica pacing 2–10s.
    let continuityProbe = await probeOpenLineContinuity(page, t).catch(() => ({ is_open_line_ready: false }));
    const openLineReady = !!(continuityProbe && continuityProbe.is_open_line_ready === true);
    const cooldownPolicy = openLineReady
      ? { minMs: 3_000, maxMs: 10_000, reason: "open_line_fast_lane" }
      : null;

    // Relógio sentinela por conta; em linha aberta usa faixa 2–10s.
    await enforceGlobalDeltaCooldown(ACCOUNT_LOGIN, cooldownPolicy);

    // Resiliência: recovery curto + hop de candidatos (sem goto paranoico).
    // Confirmação final de envio continua nonretryable (sem balão azul falso).
    const maxRetries = Math.max(0, Math.min(2, Number(process.env.VIRTUS_DELTA_REPLY_MAX_RETRIES || 1) || 1));
    // Default 2 (era 3): menos pressão no browser quando o link está errado.
    const routingRecoveryRounds = Math.max(
      1,
      Math.min(3, Number(process.env.VIRTUS_DELTA_ROUTING_RECOVERY_ROUNDS || 2) || 2)
    );
    const isNonRetryableSendError = (err) => {
      const e = String(err || "").trim().toLowerCase();
      return (
        e === "send_not_confirmed_after_enter_only" ||
        e === "send_not_confirmed_composer_not_empty" ||
        e === "composer_text_not_registered" ||
        e === "thread_content_unavailable" ||
        e.includes("thread_content_unavailable") ||
        e.includes("id_virtus")
      );
    };
    const isBadThreadSignal = (err) => {
      const e = String(err || "").trim().toLowerCase();
      if (!e) return false;
      return (
        e.includes("composer_missing") ||
        e.includes("thread_login_redirect") ||
        e.includes("thread_e2ee_gate") ||
        e.includes("e2ee_gate_blocked") ||
        e.includes("goto_circuit_open") ||
        e.includes("thread_key_garbage_token")
      );
    };
    const isRoutingFailure = (err) => {
      const e = String(err || "").trim().toLowerCase();
      if (!e) return false;
      // Chat excluído/indisponível NÃO é rota recuperável.
      if (e.includes("thread_content_unavailable")) return false;
      return (
        e.includes("wrong_thread_guard_blocked") ||
        e.includes("messages_boot_not_stable") ||
        e.includes("thread_open_hydration_timeout") ||
        e.includes("thread_open_goto_failed") ||
        e.includes("thread_card_not_found") ||
        e.includes("thread_open_failed") ||
        e.includes("url_mismatch_preventing_cross_routing") ||
        e.includes("goto_circuit_open") ||
        isBadThreadSignal(e)
      );
    };
    let lastOut = null;
    let lastErr = "delta_reply_unknown_error";
    let visualAttempt = 0;
    let routingRound = 0;
    const hardCap = 1 + maxRetries + routingRecoveryRounds;

    const markSendOk = (out) => {
      const nowTs = Date.now();
      writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
      lastCrossThreadKey = String(t);
      lastCrossThreadSendAt = nowTs;
      try { __deltaGotoCircuitClear(ACCOUNT_LOGIN, t); } catch (_) {}
      try {
        const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: t, texto_resposta: msg });
        enqueueDeliveryConfirmToDiskSync({ cmdId: cid, thread_key: t, status: "sent_to_facebook" });
        kickDeliveryConfirmPump();
      } catch (_) {}
      try {
        void collectMetadataAfterCtReply(t, out).catch(() => {});
      } catch (_) {}
      return {
        ...(out && typeof out === "object" ? out : {}),
        ok: true,
        status: "send_ok",
        thread_key: t,
      };
    };

    const markNonRetryable = (err, out) => {
      try {
        logInfo(`[virtusDelta][reply] nonretryable_send_failed thread_key=${t} reason=${err}`);
      } catch (_) {}
      try {
        const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: t, texto_resposta: msg });
        kickReverseDeliveryStatus({
          client_message_id: cid,
          thread_key: t,
          status: "error_failed_to_send",
          error: err,
        });
      } catch (_) {}
      return {
        ok: false,
        error: err,
        nonretryable: true,
        status: "send_failed_nonretryable",
        thread_key: t,
        item_link: (out && out.item_link) ? String(out.item_link) : null,
        last_result: out && typeof out === "object" ? out : null,
      };
    };

    for (let attempt = 1; attempt <= hardCap; attempt++) {
      if (attempt > 1) {
        const routingMode = isRoutingFailure(lastErr);
        if (routingMode) {
          // Link podre ou já houve 1 recovery + há outro candidato → hop (sem goto paranoico).
          if (alternativeCandidates.length && (isBadThreadSignal(lastErr) || routingRound >= 1)) break;
          if (routingRound >= routingRecoveryRounds) break;
          routingRound += 1;
          // Timers humanos: menos pressão no browser.
          const retryWaitMs = randomBetween(4_500, 9_000);
          logInfo(
            `[virtusDelta][reply] routing_recovery round=${routingRound}/${routingRecoveryRounds} thread_key=${t} err=${lastErr} wait_ms=${retryWaitMs}`
          );
          await sleep(retryWaitMs);
          // Invalida fast-path; no máximo 1 goto suave por round — nunca se circuit aberto.
          continuityProbe = null;
          if (__deltaGotoCircuitIsOpen(ACCOUNT_LOGIN, t)) {
            lastErr = "goto_circuit_open";
            break;
          }
          try {
            const gotoOut = await __deltaTryOpenThreadByDirectGoto(page, t, {
              forensicAccountLogin: ACCOUNT_LOGIN,
              stepAError: lastErr,
            });
            if (gotoOut && gotoOut.ok === false && gotoOut.error) {
              lastErr = String(gotoOut.error || lastErr);
              if (isBadThreadSignal(lastErr) && alternativeCandidates.length) break;
              if (String(lastErr).toLowerCase().includes("goto_circuit_open")) break;
            }
          } catch (gotoErr) {
            try {
              logInfo(
                `[virtusDelta][reply] routing_recovery_goto_fail thread_key=${t} err=${gotoErr && gotoErr.message ? gotoErr.message : String(gotoErr)}`
              );
            } catch (_) {}
          }
          try {
            await dismissMessengerE2eeInterstitial(page, {
              forensicAccountLogin: ACCOUNT_LOGIN,
            });
          } catch (_) {}
        } else {
          if (visualAttempt >= maxRetries) break;
          visualAttempt += 1;
          const retryWaitMs = randomBetween(1_800, 3_200);
          logInfo(
            `[virtusDelta][reply] retry_visual attempt=${visualAttempt}/${maxRetries} thread_key=${t} wait_ms=${retryWaitMs}`
          );
          await sleep(retryWaitMs);
          continuityProbe = null;
        }
      }

      try {
        const r = await sendReplyFlow({
          page,
          threadKey: t,
          textoResposta: msg,
          fromNetworkLead: false,
          forensicAccountLogin: ACCOUNT_LOGIN,
          continuityProbe,
          skipActionDispatch: true
        });
        lastOut = r && typeof r === "object" ? r : { ok: true };
        if (lastOut && lastOut.ok) {
          return markSendOk(lastOut);
        }
        lastErr = String((lastOut && lastOut.error) || "send_reply_flow_failed");
        if (isNonRetryableSendError(lastErr)) {
          return markNonRetryable(lastErr, lastOut);
        }
        // Routing: continua o loop (goto+resend). Soft visual: idem até maxRetries.
        if (isRoutingFailure(lastErr)) {
          try {
            __forensicEdgeEmit({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              flow_stage: "reply_routing_failure",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                error: lastErr,
                attempt,
                routing_round: routingRound,
                routing_recovery_rounds: routingRecoveryRounds,
                bad_thread_signal: isBadThreadSignal(lastErr),
                alternatives: alternativeCandidates.length,
                ts_ms: Date.now(),
              }
            });
          } catch (_) {}
          // Continuar / login / composer_missing / já tem irmão → hop, sem mais pressão.
          if (alternativeCandidates.length && (isBadThreadSignal(lastErr) || routingRound >= 1)) break;
          continue;
        }
      } catch (e) {
        lastErr = e && e.message ? String(e.message) : String(e);
        lastOut = { ok: false, error: lastErr };
        if (isNonRetryableSendError(lastErr)) {
          return markNonRetryable(lastErr, lastOut);
        }
        if (isRoutingFailure(lastErr)) {
          if (alternativeCandidates.length && (isBadThreadSignal(lastErr) || routingRound >= 1)) break;
          continue;
        }
      }
    }

    // Hop de candidatos: só marketplace 15–17 (nunca timestamp/perfil/pessoal).
    const hopWorthyAlternatives = alternativeCandidates.filter(__deltaIsHopWorthyThreadKeyLocal);
    if (
      hopWorthyAlternatives.length > 0 &&
      Number(__candidateHop || 0) < 10 &&
      (isBadThreadSignal(lastErr) || isRoutingFailure(lastErr)) &&
      !String(lastErr || "").toLowerCase().includes("goto_circuit_open")
    ) {
      const nextThread = String(hopWorthyAlternatives[0] || "").trim();
      if (nextThread) {
        const hopPauseMs = randomBetween(3_000, 6_500);
        try {
          logInfo(
            `[virtusDelta][reply] thread_key_autocorrect_switch hop=${Number(__candidateHop + 1)} from=${t} to=${nextThread} remaining=${Math.max(0, hopWorthyAlternatives.length - 1)} pause_ms=${hopPauseMs} reason=${lastErr}`
          );
        } catch (_) {}
        try {
          __forensicEdgeEmit({
            account_login: ACCOUNT_LOGIN,
            thread_key: t,
            flow_stage: "reply_thread_key_autocorrect_switch",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              from_thread_key: t,
              to_thread_key: nextThread,
              candidate_hop: Number(__candidateHop + 1),
              remaining_candidates: hopWorthyAlternatives.slice(1),
              skipped_non_hop_worthy: Math.max(0, alternativeCandidates.length - hopWorthyAlternatives.length),
              reason: String(lastErr || "routing_recovery_exhausted"),
              pause_ms: hopPauseMs,
            }
          });
        } catch (_) {}
        try { await sleep(hopPauseMs); } catch (_) {}
        try {
          const switched = await sendDeltaReplyNow({
            threadKey: nextThread,
            textoResposta: msg,
            clientMessageId: cmid,
            threadKeyCandidates: hopWorthyAlternatives.slice(1),
            __candidateHop: Number(__candidateHop + 1)
          });
          if (switched && typeof switched === "object") {
            return {
              ...switched,
              thread_key_autocorrected_from: t,
              thread_key_autocorrected_to: nextThread,
              thread_key_candidate_hop: Number(__candidateHop + 1)
            };
          }
        } catch (switchErr) {
          try {
            logInfo(
              `[virtusDelta][reply] thread_key_autocorrect_switch_fail from=${t} to=${nextThread} err=${switchErr && switchErr.message ? switchErr.message : String(switchErr)}`
            );
          } catch (_) {}
        }
      }
    }

    // Sem mais candidatos hop-worthy (ou hop falhou): soft-requeue no outbox (edge rotaciona fila).
    if (isRoutingFailure(lastErr) || isBadThreadSignal(lastErr)) {
      const exhaustedAll = hopWorthyAlternatives.length === 0;
      try {
        logInfo(
          `[virtusDelta][reply] routing_recovery_exhausted_soft_requeue thread_key=${t} err=${lastErr} rounds=${routingRound} hop=${__candidateHop} alternatives_left=${hopWorthyAlternatives.length}`
        );
      } catch (_) {}
      try {
        __forensicEdgeEmit({
          account_login: ACCOUNT_LOGIN,
          thread_key: t,
          flow_stage: "reply_routing_recovery_exhausted_soft",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            error: String(lastErr || "routing_failed"),
            routing_rounds: routingRound,
            candidates_remaining: hopWorthyAlternatives.length,
            candidate_hop: Number(__candidateHop || 0),
            exhausted_all_candidates: exhaustedAll,
            ts_ms: Date.now(),
          }
        });
      } catch (_) {}
      return {
        ok: false,
        error: exhaustedAll
          ? `candidates_exhausted:${String(lastErr || "routing_failed")}`
          : `routing_recovery_exhausted:${String(lastErr || "routing_failed")}`,
        status: "send_failed",
        nonretryable: false,
        routing_recovery_exhausted: true,
        thread_key: t,
        retries: maxRetries,
        routing_rounds: routingRound,
        attempts: Math.min(hardCap, 1 + visualAttempt + routingRound),
        last_result: lastOut && typeof lastOut === "object" ? lastOut : null,
      };
    }

    // Retryable: outbox pump requeue. NÃO reverter CT aqui.
    return {
      ok: false,
      error: String(lastErr || "send_reply_failed_after_retries"),
      status: "send_failed",
      nonretryable: false,
      thread_key: t,
      retries: maxRetries,
      routing_rounds: routingRound,
      routing_recovery_exhausted: false,
      attempts: Math.min(hardCap, 1 + visualAttempt + routingRound),
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
    let greetingSentAt = Number((prior && prior.sentAt) || 0) || 0;
    const itemLinkAttempts = Math.max(4, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 8) || 8);
    const linkReadyMs = Math.max(1500, Number(process.env.VIRTUS_DELTA_LINK_READY_MS || 8000) || 8000);
    // Collector serial (1 browser): budget completo fica em background.
    // Hands so espera um wait curto — se veio, manda resolved; senao collecting + patch depois.
    const cityCollectorTimeoutMs = Math.max(
      12_000,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 28_000) || 28_000
    );
    const cityCollectorAttempts = Math.max(
      1,
      Math.min(5, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_ATTEMPTS || 3) || 3)
    );
    const cityCollectFastWaitMs = Math.max(
      1_500,
      Math.min(8_000, Number(process.env.VIRTUS_DELTA_CITY_COLLECT_FAST_WAIT_MS || 4_000) || 4_000)
    );

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
        timeoutMs: cityCollectorTimeoutMs,
        attempts: cityCollectorAttempts,
        page,
      });
    })().catch((e) => ({
      ok: false,
      error: (e && e.message) ? String(e.message) : "city_collect_exception",
    }));

    let sendOut = null;
    if (!greetingAlreadySent) {
      sendOut = await sendReplyFlow({
        page,
        threadKey: t,
        textoResposta: greetingText,
        fromNetworkLead: true,
        onItemLink: (link) => resolveItemLink(link),
        forensicAccountLogin: ACCOUNT_LOGIN,
        skipActionDispatch: true,
      });
      if (sendOut && sendOut.item_link) {
        resolveItemLink(sendOut.item_link);
      } else {
        let recoveredItemLink = null;
        try {
          recoveredItemLink = await extractMarketplaceItemLinkWithRetry(page, {
            attempts: itemLinkAttempts,
            readinessTimeoutMs: linkReadyMs,
            forensicAccountLogin: ACCOUNT_LOGIN,
            threadKey: t,
          });
        } catch (_) {}
        if (!recoveredItemLink) {
          try {
            const openOut = await openThreadAndExtractItemLink(page, t, {
              fromNetworkLead: false,
              forensicAccountLogin: ACCOUNT_LOGIN,
            });
            if (openOut && openOut.ok && openOut.item_link) {
              recoveredItemLink = String(openOut.item_link || "").trim() || null;
            }
          } catch (_) {}
        }
        if (recoveredItemLink) {
          try {
            logInfo(`[virtusDelta][city_link_recovery] thread_key=${t} recovered=sim`);
          } catch (_) {}
          // Propaga o link recuperado para o retorno hands (nao so para o collector).
          sendOut = {
            ...(sendOut && typeof sendOut === "object" ? sendOut : {}),
            item_link: recoveredItemLink,
          };
        } else {
          try {
            logInfo(`[virtusDelta][city_link_recovery] thread_key=${t} recovered=nao`);
          } catch (_) {}
        }
        resolveItemLink(recoveredItemLink || null);
      }
      if (!sendOut || !sendOut.ok) {
        return {
          ok: false,
          error: String((sendOut && sendOut.error) || "hands_send_failed"),
        };
      }
      greetingSentAt = Date.now();
    } else {
      // Retry de cidade não reenvia saudação: somente reabre o thread para recuperar link, se necessário.
      if (!(prior && prior.itemLink)) {
        const openOut = await openThreadAndExtractItemLink(page, t, {
          fromNetworkLead: true,
          forensicAccountLogin: ACCOUNT_LOGIN,
        });
        if (openOut && openOut.ok && openOut.item_link) {
          resolveItemLink(openOut.item_link);
          sendOut = { ok: true, item_link: String(openOut.item_link || "").trim() || null };
        } else {
          resolveItemLink(null);
          sendOut = { ok: true, item_link: null };
        }
      } else {
        resolveItemLink(prior.itemLink);
        sendOut = { ok: true, item_link: (prior && prior.itemLink) || null };
      }
      if (!greetingSentAt) greetingSentAt = Date.now();
    }

    // Link soberano = o mesmo que alimentou o collector (promise ja resolvida neste ponto).
    const awaitedItemLink = await itemLinkPromise;
    const pickMarketplaceLink = (...cands) => {
      for (const c of cands) {
        const s = String(c || "").trim();
        if (!s || /link\s*n[aã]o\s*coletado/i.test(s)) continue;
        if (/(?:facebook|fb|messenger)\.com\/marketplace\/item\/[0-9A-Za-z_-]+/i.test(s)) return s;
      }
      return null;
    };
    const itemLinkFinal = pickMarketplaceLink(
      sendOut && sendOut.item_link,
      prior && prior.itemLink,
      awaitedItemLink
    );

    const leadNamePromise = (async () => {
      try {
        const out = await extractLeadClientNameFromFeedDom(page);
        return String(out || "").trim() || null;
      } catch {
        return null;
      }
    })();

    // Wait curto: se a fila serial ja tiver a cidade (cache/rapido), manda resolved junto.
    let cityOut = await Promise.race([
      cityCollectionPromise,
      sleep(cityCollectFastWaitMs).then(() => ({
        ok: false,
        error: "city_collect_fast_wait",
        timeout_ms: cityCollectFastWaitMs,
      })),
    ]);
    if (cityOut && cityOut.error === "city_collect_fast_wait") {
      try {
        __forensicEdgeEmit({
          account_login: ACCOUNT_LOGIN,
          thread_key: t,
          flow_stage: "city_collect_fast_wait",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            timeout_ms: cityCollectFastWaitMs,
            collector_timeout_ms: cityCollectorTimeoutMs,
            collector_attempts: cityCollectorAttempts,
            item_link: itemLinkFinal || null,
          }
        });
      } catch (_) {}
    }

    // Só resolve no hands se o collector global (match-duplo soberano) já devolveu cidade.
    // Sem dom_live_fallback / cache do Messenger aqui — isso promovia título de anúncio a cidade.
    let cityCandidate = String((cityOut && cityOut.ok && cityOut.cidade) || "").trim() || null;
    let citySource = cityCandidate
      ? (String((cityOut && cityOut.city_source) || "collector_listing_page").trim() || "collector_listing_page")
      : null;

    let profileUrl = null;
    try {
      const u = String(page && page.url ? page.url() : "").trim();
      if (u) profileUrl = u;
    } catch (_) {}
    const nomeClienteLimpo = await leadNamePromise;
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

    const baseReturn = {
      ok: true,
      link_anuncio: itemLinkFinal || null,
      profile_url: profileUrl,
      greeting_text: greetingText,
      mensagens_cliente: mensagensConcatenadas,
      nome_cliente_limpo: nomeClienteLimpo,
      customer_name: nomeClienteLimpo,
      greeting_already_sent: greetingAlreadySent,
      greeting_sent_at: Number(greetingSentAt || Date.now()) || Date.now(),
    };

    const nowTs = Date.now();
    writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
    lastCrossThreadKey = String(t);
    lastCrossThreadSendAt = nowTs;

    if (cityCandidate) {
      greetingStateByThread.set(t, {
        sentAt: Number(greetingSentAt || (prior && prior.sentAt) || Date.now()),
        greetingText,
        itemLink: itemLinkFinal,
        city: cityCandidate,
        citySource,
        cityStatus: "resolved",
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
            city_status: "resolved",
            item_link: itemLinkFinal
          }
        });
      } catch (_) {}
      return {
        ...baseReturn,
        cidade: cityCandidate,
        city_source: citySource,
        city_status: "resolved",
      };
    }

    // Sem link no hands: saudação já foi (ou pode ter sido); NÃO trava o chat.
    // Marca collecting + agenda late-link recovery (reabre depois, sob menos pressão).
    if (!itemLinkFinal) {
      const sentAtFinal = Number(greetingSentAt || (prior && prior.sentAt) || Date.now()) || Date.now();
      try {
        scheduleDeferredLinkAndCityRecovery({
          threadKey: t,
          greetingText,
          greetingSentAt: sentAtFinal,
          cityCollectorTimeoutMs,
          cityCollectorAttempts,
        });
      } catch (_) {
        greetingStateByThread.set(t, {
          sentAt: sentAtFinal,
          greetingText,
          itemLink: null,
          city: null,
          citySource: null,
          cityStatus: "collecting",
          linkStatus: "collecting",
          linkRecoveryScheduled: false,
        });
      }
      try {
        __deltaLogTriagemDom({
          stage: "link_collect_deferred",
          thread_key: t,
          account_login: ACCOUNT_LOGIN,
          reason: String((cityOut && cityOut.error) || "item_link_missing"),
        });
      } catch (_) {}
      try {
        __forensicEdgeEmit({
          account_login: ACCOUNT_LOGIN,
          thread_key: t,
          flow_stage: "link_collect_deferred",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            reason: String((cityOut && cityOut.error) || "item_link_missing"),
            city_status: "collecting",
            link_status: "collecting",
          },
        });
      } catch (_) {}
      return {
        ...baseReturn,
        cidade: null,
        city_source: null,
        city_status: "collecting",
        link_status: "collecting",
        city_collect_deferred: true,
        link_collect_deferred: true,
      };
    }

    // Collecting: card ja pode ir ao CT; collector serial termina em background e faz patch.
    greetingStateByThread.set(t, {
      sentAt: Number(greetingSentAt || (prior && prior.sentAt) || Date.now()),
      greetingText,
      itemLink: itemLinkFinal,
      city: null,
      citySource: null,
      cityStatus: "collecting",
    });
    try {
      __forensicEdgeEmit({
        account_login: ACCOUNT_LOGIN,
        thread_key: t,
        flow_stage: "city_collect_deferred",
        details: {
          tag: "FORENSIC_DOM_REVERSE",
          city_status: "collecting",
          item_link: itemLinkFinal,
          fast_wait_ms: cityCollectFastWaitMs,
        }
      });
    } catch (_) {}

    try {
      const settleDeferredCity = (lateOut) => {
        const priorState = greetingStateByThread.get(t) || null;
        // Nao rebaixar se hands ja resolveu cidade no fast-wait (race rara).
        if (priorState && priorState.cityStatus === "resolved" && priorState.city) {
          return null;
        }
        const linkNow = itemLinkFinal || (priorState && priorState.itemLink) || null;
        const lateCity = String((lateOut && lateOut.ok && lateOut.cidade) || "").trim() || null;
        if (lateCity) {
          const lateSource =
            String((lateOut && lateOut.city_source) || "collector_listing_page").trim() ||
            "collector_listing_page";
          greetingStateByThread.set(t, {
            sentAt: Number((priorState && priorState.sentAt) || greetingSentAt || Date.now()),
            greetingText: String((priorState && priorState.greetingText) || greetingText || "").trim(),
            itemLink: linkNow,
            city: lateCity,
            citySource: lateSource,
            cityStatus: "resolved",
          });
          try {
            __forensicEdgeEmit({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              flow_stage: "city_collect_deferred_resolved",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                city_status: "resolved",
                city_clean: lateCity,
                city_source: lateSource,
                item_link: linkNow || null,
              },
            });
          } catch (_) {}
          const handler = typeof cityCollectSettledHandler === "function"
            ? cityCollectSettledHandler
            : null;
          if (!handler) return null;
          return Promise.resolve(
            handler({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              item_link: linkNow,
              cidade: lateCity,
              city_source: lateSource,
              city_status: "resolved",
              cityOut: lateOut && typeof lateOut === "object" ? lateOut : null,
              customer_name: nomeClienteLimpo || null,
              client_name: nomeClienteLimpo || null,
              nome_cliente_limpo: nomeClienteLimpo || null,
            })
          ).catch(() => {});
        }

        const err =
          String((lateOut && lateOut.error) || "city_collect_failed").trim() ||
          "city_collect_failed";
        // Com link válido: não pending ainda — background retry soberano.
        if (
          linkNow &&
          (__deltaIsRetryableCityCollectError(err) || cityCollectBgInFlight.has(t))
        ) {
          try {
            __forensicEdgeEmit({
              account_login: ACCOUNT_LOGIN,
              thread_key: t,
              flow_stage: "city_collect_deferred_bg_handoff",
              details: {
                tag: "FORENSIC_DOM_REVERSE",
                city_status: "collecting",
                collector_error: err.slice(0, 220),
                item_link: linkNow,
                bg_inflight: cityCollectBgInFlight.has(t),
              },
            });
          } catch (_) {}
          const bgHandoff = scheduleBackgroundCityCollectFromLink({
            threadKey: t,
            itemLink: linkNow,
            customerName: nomeClienteLimpo || null,
            greetingText: String((priorState && priorState.greetingText) || greetingText || "").trim(),
            greetingSentAt: Number((priorState && priorState.sentAt) || greetingSentAt || Date.now()) || Date.now(),
            cityCollectorTimeoutMs,
            cityCollectorAttempts,
            reason: "hands_deferred_miss",
            force: true,
          });
          // Se não agendou e não está inflight: não deixar collecting mudo.
          if (!(bgHandoff && (bgHandoff.scheduled || bgHandoff.deduped)) && !cityCollectBgInFlight.has(t)) {
            // cai no pending abaixo
          } else {
            return null;
          }
        }

        greetingStateByThread.set(t, {
          sentAt: Number((priorState && priorState.sentAt) || greetingSentAt || Date.now()),
          greetingText: String((priorState && priorState.greetingText) || greetingText || "").trim(),
          itemLink: linkNow,
          city: null,
          citySource: err,
          cityStatus: "pending",
        });
        try {
          __forensicEdgeEmit({
            account_login: ACCOUNT_LOGIN,
            thread_key: t,
            flow_stage: "city_collect_deferred_pending",
            details: {
              tag: "FORENSIC_DOM_REVERSE",
              city_status: "pending",
              city_source: err,
              item_link: linkNow || null,
              collector_error: err.slice(0, 220),
            },
          });
        } catch (_) {}
        const handler = typeof cityCollectSettledHandler === "function"
          ? cityCollectSettledHandler
          : null;
        if (!handler) return null;
        return Promise.resolve(
          handler({
            account_login: ACCOUNT_LOGIN,
            thread_key: t,
            item_link: linkNow,
            cidade: null,
            city_source: err,
            city_status: "pending",
            cityOut: lateOut && typeof lateOut === "object" ? lateOut : { ok: false, error: err },
            customer_name: nomeClienteLimpo || null,
            client_name: nomeClienteLimpo || null,
            nome_cliente_limpo: nomeClienteLimpo || null,
          })
        ).catch(() => {});
      };
      cityCollectionPromise
        .then((lateOut) => settleDeferredCity(lateOut && typeof lateOut === "object" ? lateOut : null))
        .catch((e) => settleDeferredCity({
          ok: false,
          error: (e && e.message) ? String(e.message) : "city_collect_deferred_exception",
        }));
    } catch (_) {}

    return {
      ...baseReturn,
      cidade: null,
      city_source: null,
      city_status: "collecting",
      city_collect_deferred: true,
    };
  }

  /**
   * Force sync (CT urgente): abre thread → recupera link se faltar → collector match-duplo.
   * Só devolve ok com cidade canônica; link recuperado volta mesmo se cidade falhar.
   */
  const enqueueForceCollectLinkAndCity = ({
    thread_key,
    item_link,
    timeoutMs,
    attempts,
    link_attempts,
    ticket_id,
  } = {}) => {
    return enqueue(async () => {
      const tk = String(thread_key || "").trim();
      const ticketId = Number(ticket_id || 0) || 0;
      if (!tk) {
        return { ok: false, error: "missing_thread_key", ticket_id: ticketId || null };
      }
      const collectorTimeout = Math.max(12_000, Number(timeoutMs || 20_000) || 20_000);
      const collectorAttempts = Math.max(1, Math.min(5, Number(attempts || 3) || 3));
      const linkAttempts = Math.max(1, Math.min(4, Number(link_attempts || 3) || 3));
      let itemLink = String(item_link || "").trim();
      let linkRecovered = false;
      let triedLink = false;
      let triedCity = false;

      const settleForce = (payload) => {
        const handler = typeof cityCollectSettledHandler === "function" ? cityCollectSettledHandler : null;
        if (!handler) return Promise.resolve(null);
        return Promise.resolve(handler(payload)).catch(() => {});
      };

      try {
        const prior = greetingStateByThread.get(tk) || null;
        if ((!itemLink || !/marketplace\/item\//i.test(itemLink)) && prior && prior.itemLink) {
          const cached = String(prior.itemLink || "").trim();
          if (cached && /marketplace\/item\//i.test(cached)) itemLink = cached;
        }
      } catch (_) {}

      if (!itemLink || !/marketplace\/item\//i.test(itemLink)) {
        triedLink = true;
        for (let i = 0; i < linkAttempts; i++) {
          if (!running) break;
          try {
            const openOut = await openThreadAndExtractItemLink(page, tk, {
              fromNetworkLead: true,
              forensicAccountLogin: ACCOUNT_LOGIN,
            });
            const recovered = String((openOut && openOut.item_link) || "").trim();
            if (recovered && /marketplace\/item\//i.test(recovered)) {
              itemLink = recovered;
              linkRecovered = true;
              break;
            }
          } catch (_) {}
          try {
            await humanPause("postThreadOpen", `force_link_retry_${i + 1}`);
          } catch (_) {}
        }
      }

      if (!itemLink || !/marketplace\/item\//i.test(itemLink)) {
        try {
          greetingStateByThread.set(tk, {
            ...(greetingStateByThread.get(tk) || {}),
            sentAt: Number((greetingStateByThread.get(tk) || {}).sentAt || Date.now()) || Date.now(),
            itemLink: null,
            city: null,
            citySource: null,
            cityStatus: "collecting",
            linkStatus: "collecting",
          });
        } catch (_) {}
        try {
          await settleForce({
            account_login: ACCOUNT_LOGIN,
            thread_key: tk,
            item_link: null,
            cidade: null,
            city_source: null,
            city_status: "collecting",
          });
        } catch (_) {}
        return {
          ok: false,
          error: "item_link_missing_after_force_attempts",
          ticket_id: ticketId || null,
          account_login: ACCOUNT_LOGIN,
          thread_key: tk,
          item_link: null,
          link_recovered: false,
          tried_link: true,
          tried_city: false,
        };
      }

      triedCity = true;
      let cityOut = null;
      try {
        cityOut = await collectCityFromItemLinkUsingGlobalCollector({
          itemLink,
          threadKey: tk,
          accountLogin: ACCOUNT_LOGIN,
          timeoutMs: collectorTimeout,
          attempts: collectorAttempts,
          page,
        });
      } catch (e) {
        cityOut = {
          ok: false,
          error: (e && e.message) ? String(e.message) : "force_city_collect_exception",
        };
      }

      const cidade = String((cityOut && cityOut.ok && cityOut.cidade) || "").trim() || null;
      const citySource = cidade
        ? (String((cityOut && cityOut.city_source) || "collector_listing_page").trim() || "collector_listing_page")
        : null;

      if (cidade) {
        try {
          const prior = greetingStateByThread.get(tk) || {};
          greetingStateByThread.set(tk, {
            ...prior,
            sentAt: Number(prior.sentAt || Date.now()) || Date.now(),
            itemLink,
            city: cidade,
            citySource,
            cityStatus: "resolved",
            linkStatus: "resolved",
            cityCollectBgScheduled: false,
            linkRecoveryScheduled: false,
          });
        } catch (_) {}
        try {
          await settleForce({
            account_login: ACCOUNT_LOGIN,
            thread_key: tk,
            item_link: itemLink,
            cidade,
            city_source: citySource,
            city_status: "resolved",
            cityOut: cityOut && typeof cityOut === "object" ? cityOut : null,
          });
        } catch (_) {}
        try {
          logInfo(
            `[virtusDelta][force_collect] OK thread_key=${tk} city=${cidade} link=${linkRecovered ? "recovered" : "given"} src=${citySource}`
          );
        } catch (_) {}
        return {
          ok: true,
          cidade,
          city_source: citySource,
          ticket_id: ticketId || null,
          account_login: ACCOUNT_LOGIN,
          thread_key: tk,
          item_link: itemLink,
          link_recovered: !!linkRecovered,
          tried_link: triedLink,
          tried_city: true,
          cached: !!(cityOut && cityOut.cached),
        };
      }

      try {
        const prior = greetingStateByThread.get(tk) || {};
        greetingStateByThread.set(tk, {
          ...prior,
          sentAt: Number(prior.sentAt || Date.now()) || Date.now(),
          itemLink,
          city: null,
          citySource: null,
          cityStatus: "collecting",
          linkStatus: "resolved",
        });
      } catch (_) {}
      try {
        await settleForce({
          account_login: ACCOUNT_LOGIN,
          thread_key: tk,
          item_link: itemLink,
          cidade: null,
          city_source: null,
          city_status: "collecting",
        });
      } catch (_) {}

      return {
        ok: false,
        error: String((cityOut && cityOut.error) || "city_collect_failed").slice(0, 220),
        ticket_id: ticketId || null,
        account_login: ACCOUNT_LOGIN,
        thread_key: tk,
        item_link: itemLink,
        link_recovered: !!linkRecovered,
        tried_link: triedLink,
        tried_city: true,
        collector: cityOut && typeof cityOut === "object"
          ? {
              login_wall: !!cityOut.login_wall,
              has_localizacao: !!cityOut.has_localizacao,
              has_anunciado: !!cityOut.has_anunciado,
              candidates_count: Number(cityOut.candidates_count || 0) || 0,
            }
          : null,
      };
    });
  };

  const enqueueDeltaReply = ({
    thread_key,
    texto_resposta,
    client_message_id,
    thread_key_candidates,
    known_city,
    known_city_source,
    known_item_link,
  } = {}) => {
    return enqueue(async () => {
      try {
        const tk = String(thread_key || "").trim();
        const tr = String(texto_resposta || "").replace(/\r/g, "");
        const cmid = String(client_message_id || "").trim() || null;
        const threadKeyCandidates = __deltaRankThreadKeyCandidatesLocal(
          Array.isArray(thread_key_candidates) ? thread_key_candidates : []
        ).slice(0, 12);
        // Hidrata greetingState com cidade limpa do thread-state (pós-restart / open-all).
        // Evita re-raspagem em todo reply quando dual já resolveu.
        try {
          const seedCity = String(known_city || "").trim();
          const seedSource = String(known_city_source || "").trim() || null;
          const seedLink = String(known_item_link || "").trim() || null;
          if (tk && seedCity && __deltaCityLabelIsClean(seedCity, seedSource)) {
            const priorSeed = greetingStateByThread.get(tk) || null;
            const priorClean =
              priorSeed &&
              priorSeed.cityStatus === "resolved" &&
              __deltaCityLabelIsClean(priorSeed.city, priorSeed.citySource);
            if (!priorClean) {
              greetingStateByThread.set(tk, {
                sentAt: Number((priorSeed && priorSeed.sentAt) || Date.now()) || Date.now(),
                greetingText: String((priorSeed && priorSeed.greetingText) || "").trim(),
                itemLink: seedLink || (priorSeed && priorSeed.itemLink) || null,
                city: seedCity,
                citySource: seedSource || "thread_state_seed",
                cityStatus: "resolved",
                linkStatus: seedLink || (priorSeed && priorSeed.itemLink) ? "resolved" : (priorSeed && priorSeed.linkStatus) || null,
                cityCollectBgScheduled: false,
                cityCollectBgWave: Number((priorSeed && priorSeed.cityCollectBgWave) || 0) || 0,
                linkRecoveryScheduled: !!(priorSeed && priorSeed.linkRecoveryScheduled),
                linkRecoveryWave: Number((priorSeed && priorSeed.linkRecoveryWave) || 0) || 0,
              });
            }
          }
        } catch (_) {}
        if (cmid) {
          const prior = getReplyDispatchState(cmid);
          if (prior && prior.state === "done") {
            try { logInfo(`[virtusDelta][reply] duplicate_done_skip thread_key=${tk} client_message_id=${cmid}`); } catch (_) {}
            return { ok: true, status: "duplicate_done_skip", client_message_id: cmid };
          }
          if (prior && prior.state === "inflight") {
            try { logInfo(`[virtusDelta][reply] duplicate_inflight_skip thread_key=${tk} client_message_id=${cmid}`); } catch (_) {}
            // NÃO é sucesso final — pump deve soft-requeue até send_ok / duplicate_done.
            return { ok: false, error: "duplicate_inflight_skip", status: "duplicate_inflight_skip", client_message_id: cmid };
          }
          setReplyDispatchState(cmid, "inflight", tk);
        }
        const out = await sendDeltaReplyNow({
          threadKey: tk,
          textoResposta: tr,
          clientMessageId: cmid,
          threadKeyCandidates
        });
        if (out && out.ok) {
          const sentThreadKey = String(
            (out && (out.thread_key_autocorrected_to || out.thread_key || tk)) || tk
          ).trim() || tk;
          if (cmid) setReplyDispatchState(cmid, "done", sentThreadKey);
          try {
            await __deltaEnforceSidebarResetToTop(page, {
              threadKey: sentThreadKey,
              forensicAccountLogin: ACCOUNT_LOGIN,
              reason: "reply_sent_success"
            });
          } catch (_) {}
          return {
            ...(out && typeof out === "object" ? out : {}),
            ok: true,
            status: String((out && out.status) || "send_ok").trim() || "send_ok",
            client_message_id: cmid,
          };
        }

        // nonretryable já reverte CT dentro de sendDeltaReplyNow.
        // Retryable (rota/hidratação/etc): NÃO reverter aqui — outbox requeue até send_ok
        // ou dead-letter (aí o pump do index faz reverse final).
        if (cmid) clearReplyDispatchState(cmid);
        const failStatus = (out && out.nonretryable === true)
          ? "send_failed_nonretryable"
          : (String((out && out.status) || "send_failed").trim() || "send_failed");
        return {
          ...(out && typeof out === "object" ? out : {}),
          ok: false,
          error: String((out && out.error) || "send_failed").trim() || "send_failed",
          status: failStatus,
          client_message_id: cmid,
        };
      } catch (e) {
        const cmid = String(client_message_id || "").trim() || null;
        const err = e && e.message ? String(e.message) : String(e);
        // Exceção também é retryable via outbox — sem reverse prematuro no CT.
        if (cmid) clearReplyDispatchState(cmid);
        return { ok: false, error: err || "send_failed_exception", status: "send_failed", client_message_id: cmid };
      }
    });
  };

  const enqueueDeltaGreetingFlow = ({ thread_key, mensagens_cliente }) => {
    return enqueue(async () => {
      try {
        const out = await sendDeltaGreetingNow({
          threadKey: thread_key,
          mensagensCliente: mensagens_cliente,
        });
        if (out && out.ok) {
          try {
            await __deltaEnforceSidebarResetToTop(page, {
              threadKey: String(thread_key || "").trim(),
              forensicAccountLogin: ACCOUNT_LOGIN,
              reason: "greeting_flow_success"
            });
          } catch (_) {}
        }
        return out;
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
    setCityCollectSettledHandler: (fn) => {
      cityCollectSettledHandler = typeof fn === "function" ? fn : null;
      return true;
    },
    enqueueDeltaReply,
    enqueueDeltaGreetingFlow,
    enqueueForceCollectLinkAndCity,
    stop: async () => {
      running = false;
      cityCollectSettledHandler = null;
      try { marketplaceEnforcer.stop(); } catch (_) {}
      try { if (cityTimer) clearInterval(cityTimer); } catch (_) {}
      try {
        for (const t of autoGreetingTimers.values()) { try { clearTimeout(t); } catch (_) {} }
        autoGreetingTimers.clear();
      } catch (_) {}
      try {
        for (const tk of Array.from(linkRecoveryTimers.keys())) clearLinkRecoveryTimer(tk);
        linkRecoveryTimers.clear();
      } catch (_) {}
      try {
        for (const tk of Array.from(cityCollectBgTimers.keys())) clearCityCollectBgTimer(tk);
        cityCollectBgTimers.clear();
        cityCollectBgInFlight.clear();
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
  waitForMarketplaceFeedReady,
  clickAcceptMessageRequestIfPresent,
  HUMAN_TIMINGS,
  humanPause,
  dismissMessengerE2eeInterstitial,
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

