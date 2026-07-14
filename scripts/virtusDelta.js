const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
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
  try {
    const u = new URL(String(rawUrl || ""));
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();
    if (!(host === "www.facebook.com" || host === "facebook.com" || host === "www.messenger.com" || host === "messenger.com")) return false;
    if (path.startsWith("/messages")) return true;
    if (host.includes("messenger.com")) return true;
    return false;
  } catch {
    return false;
  }
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
            if (!reqHost.endsWith("facebook.com") || !tgtHost.endsWith("facebook.com")) return false;
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
  /** Fila de ação das mãos (dashboard + chat novo): padrão 2–10s */
  actionDispatch: envMs("VIRTUS_DELTA_ACTION_DELAY_MS_MIN", "VIRTUS_DELTA_ACTION_DELAY_MS_MAX", 2000, 10000),
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
  char: envMs("VIRTUS_DELTA_HUMAN_CHAR_MS_MIN", "VIRTUS_DELTA_HUMAN_CHAR_MS_MAX", 80, 130),
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
  30_000,
  90_000
);
const CROSS_THREAD_SEND_GAP = envMs(
  "VIRTUS_DELTA_CROSS_THREAD_GAP_MS_MIN",
  "VIRTUS_DELTA_CROSS_THREAD_GAP_MS_MAX",
  2_000,
  10_000
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
    .replace(/\s*,\s*/g, ", ")
    .trim();
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
  return s.slice(0, 80);
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

async function ensureMarketplaceFilterActiveFast(page) {
  if (!page) return { ok: false, error: "no_page", quick_path: true };

  const activeBefore = await isMarketplaceFilterActive(page).catch(() => false);
  if (activeBefore) {
    return { ok: true, already_active: true, active_before: true, active_after: true, quick_path: true };
  }

  // Guardrail anti-thrash: evita repetir clique em janela curta.
  const guard = (page && page.__virtusDeltaMarketplaceGuard) ? page.__virtusDeltaMarketplaceGuard : {};
  const now = Date.now();
  const lastClickAt = Number(guard.lastClickAt || 0) || 0;
  if (lastClickAt > 0 && (now - lastClickAt) < 8_000) {
    const activeAfterGuard = await isMarketplaceFilterActive(page).catch(() => false);
    return {
      ok: !!activeAfterGuard,
      guarded_recent_click: true,
      active_before: false,
      active_after: !!activeAfterGuard,
      quick_path: true,
    };
  }

  await humanPause("preMarketplace", "marketplace_fast_pre_click");
  const click = await clickMarketplaceFilterIfPresent(page).catch(() => ({
    ok: false,
    changed: false,
    reason: "click_failed",
  }));
  await humanPause("postMarketplace", "marketplace_fast_post_click");
  const activeAfter = await isMarketplaceFilterActive(page).catch(() => false);

  try {
    page.__virtusDeltaMarketplaceGuard = {
      ...(page.__virtusDeltaMarketplaceGuard || {}),
      lastClickAt: (click && click.changed) ? Date.now() : lastClickAt,
      lastStableAt: activeAfter ? Date.now() : Number(guard && guard.lastStableAt || 0) || 0,
      inFlightUntil: 0,
    };
  } catch (_) {}

  const out = {
    ...(click && typeof click === "object" ? click : {}),
    ok: !!activeAfter,
    active_before: !!activeBefore,
    active_after: !!activeAfter,
    quick_path: true,
  };
  logInfo(`[virtusDelta][marketplace_fast] activate result=${JSON.stringify(out)}`);
  return out;
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

async function prepareDomForNetworkLead(page, threadKey, { fastMarketplace = true } = {}) {
  const t = String(threadKey || "").trim();
  logDelta("CITY", `🏙️ Extraindo link do item e coletando a cidade de origem no DOM...`, { threadKey: t });

  // Modo seguro: não forçar Marketplace por padrão para evitar "abre e sai" no passivo.
  const useFastMarketplace = fastMarketplace !== false;
  const mp = DELTA_MARKETPLACE_AUTOFILTER_ENABLED
    ? (
      useFastMarketplace
        ? await ensureMarketplaceFilterActiveFast(page)
        : await ensureMarketplaceFilterActive(page)
    )
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
      if (useFastMarketplace) await ensureMarketplaceFilterActiveFast(page);
      else await ensureMarketplaceFilterActive(page);
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
  try {
    const parsed = input.startsWith("http")
      ? new URL(input)
      : input.startsWith("/")
        ? new URL(input, "https://www.facebook.com")
        : null;
    if (!parsed) return "";
    const host = String(parsed.hostname || "").toLowerCase();
    if (host && !host.includes("facebook.com")) return "";
    const m = String(parsed.pathname || "").match(/\/marketplace\/item\/([0-9A-Za-z_-]+)/i);
    if (!m || !m[1]) return "";
    const itemId = String(m[1] || "").trim();
    if (!itemId) return "";
    return `https://www.facebook.com/marketplace/item/${itemId}/`;
  } catch {
    return "";
  }
}

async function extractMarketplaceItemLink(page) {
  const rawCandidates = await page.evaluate(() => {
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
      try { push(a.getAttribute("href"), "details_anchor"); } catch (_) {}
    }

    // Links com referral do messenger tendem a ser o item correto do thread.
    const messengerAnchors = Array.from(
      document.querySelectorAll('a[href*="/marketplace/item/"][href*="referralSurface=messenger_banner"]')
    );
    for (const a of messengerAnchors) {
      try { push(a.getAttribute("href"), "messenger_referral_anchor"); } catch (_) {}
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

    // Quando abre em página de item ou login interstitial, o "next" costuma carregar o item URL.
    const nextInputs = Array.from(document.querySelectorAll('input[name="next"][value*="/marketplace/item/"]'));
    for (const inp of nextInputs) {
      try { push(inp.getAttribute("value"), "hidden_next_input"); } catch (_) {}
    }

    try {
      const hrefNow = String(location && location.href || "").trim();
      if (/\/marketplace\/item\//i.test(hrefNow)) push(hrefNow, "location_href");
    } catch (_) {}

    const body = String((document.body && document.body.innerText) || "").replace(/\s+/g, " ");
    const bodyHttp = body.match(/https?:\/\/(?:www\.)?facebook\.com\/marketplace\/item\/[0-9A-Za-z_-]+[^\s]*/gi) || [];
    for (const h of bodyHttp) push(h, "body_http");
    const bodyRel = body.match(/\/marketplace\/item\/[0-9A-Za-z_-]+[^\s]*/gi) || [];
    for (const h of bodyRel) push(h, "body_relative");

    return out;
  }).catch(() => []);

  const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
  const ranked = [];
  const seen = new Set();
  const scoreOf = (raw, source) => {
    const text = String(raw || "").toLowerCase();
    let score = 0;
    if (source === "details_anchor") score += 100;
    if (source === "messenger_referral_anchor") score += 80;
    if (source === "hidden_next_input") score += 60;
    if (source === "location_href") score += 40;
    if (text.includes("referralsurface=messenger_banner")) score += 20;
    if (text.includes("ref=messenger_banner")) score += 10;
    return score;
  };

  for (const cand of candidates) {
    const raw = String(cand && cand.raw || "").trim();
    const source = String(cand && cand.source || "").trim();
    const canonical = canonicalizeMarketplaceItemLink(raw);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    ranked.push({ link: canonical, score: scoreOf(raw, source) });
  }

  if (!ranked.length) return "";
  ranked.sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)));
  return String(ranked[0] && ranked[0].link || "").trim();
}

async function extractMarketplaceItemLinkWithRetry(page, { attempts = 4 } = {}) {
  const maxAttempts = Math.max(1, Math.min(8, Number(attempts || 4) || 4));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const link = await extractMarketplaceItemLink(page).catch(() => "");
    if (link) return link;
    if (attempt < maxAttempts) {
      try {
        await page.waitForSelector('a[href*="/marketplace/item/"],a[data-href*="/marketplace/item/"]', {
          timeout: Math.min(1800, 500 + (attempt * 350))
        });
      } catch (_) {}
      await sleep(randomBetween(220, 520));
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

async function runWrongThreadGuard(page, threadKey, { forensicAccountLogin = null, stage = "post_click", requireComposer = true } = {}) {
  const t = String(threadKey || "").trim();
  const expectedTarget = `/messages/(?:e2ee/)?t/${t}`;
  const currentUrl = String(page && page.url ? page.url() : "").trim();
  const expectedRe = new RegExp(`/messages/(?:e2ee/)?t/${String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`, "i");
  let urlMatches = false;
  if (currentUrl) {
    try {
      const parsed = new URL(currentUrl);
      urlMatches = expectedRe.test(String(parsed.pathname || ""));
    } catch (_) {
      urlMatches = expectedRe.test(currentUrl);
    }
  }

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
      const expectedHrefRe = new RegExp(`/messages/(?:e2ee/)?t/${String(threadId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`, "i");
      const sidebarMatchesThread = !!(activeHref && expectedHrefRe.test(activeHref));
      return {
        ok: composers.length === 1 && sidebarMatchesThread,
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

async function __deltaTryOpenThreadByDirectGoto(page, threadKey, { forensicAccountLogin = null, stepAError = null } = {}) {
  const t = String(threadKey || "").trim();
  const gotoCandidates = [
    `https://www.facebook.com/messages/t/${t}/`,
    `https://www.facebook.com/messages/t/${t}`,
    `https://facebook.com/messages/t/${t}/`,
  ];
  try {
    __deltaLogTriagemDom({
      stage: "fallback_goto_start",
      thread_key: t,
      step_a_error: stepAError || null,
      goto_url: gotoCandidates[0],
    });
  } catch (_) {}
  let lastNavErr = "";
  let hydrationReady = false;
  for (let i = 0; i < gotoCandidates.length; i += 1) {
    const gotoUrl = String(gotoCandidates[i] || "").trim();
    if (!gotoUrl) continue;
    try {
      __deltaLogTriagemDom({
        stage: "fallback_goto_attempt",
        thread_key: t,
        step_a_error: stepAError || null,
        goto_url: gotoUrl,
        attempt: i + 1,
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
        await page.goto("https://www.facebook.com/messages/", { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (_) {}
      try { await humanPause("domSettle", "fallback_goto_messages_bootstrap"); } catch (_) {}
      continue;
    }

    for (let h = 0; h < 3; h += 1) {
      try {
        await page.waitForSelector('div[data-lexical-editor="true"]', { timeout: 7000 });
        hydrationReady = true;
        break;
      } catch (_) {
        if (h < 2) {
          try { await humanPause("domSettle", "fallback_goto_hydration_retry"); } catch (_) {}
          if (h === 0) {
            try { await page.reload({ waitUntil: "domcontentloaded", timeout: 35000 }); } catch (_) {}
          }
        }
      }
    }
    if (hydrationReady) break;
  }

  if (!hydrationReady && lastNavErr) {
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
      step_a_error: stepAError || null,
    });
  } catch (_) {}
  return {
    ok: true,
    matched_selector: "direct_goto",
    hydrated: true,
    opened_via: "direct_goto",
    fallback_used: true,
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

  try {
    await page.waitForFunction(
      () => {
        const hrefs = Array.from(document.querySelectorAll('a[href*="/messages"]'))
          .map((a) => String(a.getAttribute("href") || ""))
          .filter(Boolean);
        const nonNew = hrefs.filter((h) => !h.includes("/messages/new"));
        return nonNew.length >= 1;
      },
      { timeout: 5000 }
    );
  } catch (_) {}

  const primaryCardSelector = `div[role="row"] a[href*="/messages/t/${t}"]`;
  const cardSelectors = [
    primaryCardSelector,
    `div[role="row"] a[href="/messages/t/${t}/"]`,
    `div[role="row"] a[href="/messages/t/${t}"]`,
    `div[role="row"] a[href*="/messages/e2ee/t/${t}"]`,
  ];

  let stepAError = "thread_card_not_found";
  let stepASelector = null;
  for (const cardSelector of cardSelectors) {
    const cardElement = cardSelector === primaryCardSelector
      ? await page.waitForSelector(cardSelector, { timeout: 3000 }).catch(() => null)
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
          (threadId) => {
            const path = String(location.pathname || "");
            return path.includes("/messages") && path.includes(`/t/${threadId}`);
          },
          { timeout: 1800 },
          t
        );
        openedByNavigation = true;
        break;
      } catch (_) {}
    }

    if (!openedByNavigation) {
      stepAError = "thread_card_not_found";
      continue;
    }

    await humanPause("postThreadOpen", "post_thread_card_click");
    try {
      await page.waitForSelector('div[data-lexical-editor="true"]', { timeout: 5000 });
    } catch (_) {
      stepAError = "thread_open_hydration_timeout";
      break;
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
  try {
    __deltaLogTriagemDom({
      stage: "hard_fail_after_fallback",
      thread_key: t,
      selector: stepASelector,
      step_a_error: stepAError,
      final_error: String(fallback && fallback.error || "thread_open_failed"),
    });
  } catch (_) {}
  return fallback || { ok: false, error: "thread_open_failed", step_a_error: stepAError };
}

async function probeOpenLineContinuity(page, threadKey) {
  const t = String(threadKey || "").trim();
  if (!page || !t) return { is_open_line_ready: false, reason: "missing_page_or_thread" };
  try {
    const out = await page.evaluate((threadId) => {
      const normHref = (href) => String(href || "").trim();
      const path = String(location.pathname || "").trim();
      const expectedRe = new RegExp(`/messages/(?:e2ee/)?t/${String(threadId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`, "i");
      const urlMatchesThread = expectedRe.test(path);
      const active = document.querySelector('a[aria-current="page"][href], [aria-current="page"] a[href]');
      const activeHref = normHref(active && active.getAttribute("href"));
      const sidebarMatchesThread = !!(activeHref && expectedRe.test(activeHref));
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
    }, t);
    const ready = !!(out && out.url_matches_thread && out.aria_current_page && out.composer_ready);
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
        const m = rawUrl.match(/\/messages\/(?:e2ee\/)?t\/(\d+)(?:\/|$)/i);
        const currentThread = m && m[1] ? String(m[1]) : "";
        if (currentThread && currentThread === String(t)) {
          return { ok: true, current_thread: currentThread, current_path: `/messages/t/${currentThread}/`, url: rawUrl };
        }
        return { ok: false, current_thread: currentThread || null, current_path: m && m[1] ? `/messages/t/${currentThread}/` : null, url: rawUrl };
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
    if (fromNetworkLead && !canUseOpenLineFastPath) {
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

    if (!canUseOpenLineFastPath) {
      await humanPause("postThreadOpen", "post_open_read_context");
    }

    // Link do classificado (Coletor 101) - coletado no exato momento de abertura do chat.
    let itemLink = null;
    if (!canUseOpenLineFastPath || fromNetworkLead || typeof onItemLink === "function") {
      const itemLinkAttempts = Math.max(2, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 4) || 4);
      try {
        itemLink = await extractMarketplaceItemLinkWithRetry(page, { attempts: itemLinkAttempts });
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

    await ensureComposerFocused(page, { thread_key: t, account_login: forensicAccountLogin });
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
      if (clicked) {
        return {
          ok: true,
          item_link: itemLink || null,
          delivery_confidence: "send_button_only",
          unconfirmed_reason: "composer_empty_send_button",
        };
      }
      try { await page.keyboard.press("Enter"); } catch (_) {}
      return {
        ok: true,
        item_link: itemLink || null,
        delivery_confidence: "unconfirmed_best_effort",
        unconfirmed_reason: "composer_empty_no_send_control",
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
      // Composer ainda tem texto: confirmação local falhou, mas seguimos best-effort.
      try {
        __forensicEdgeEmit({
          account_login: forensicAccountLogin,
          thread_key: t,
          flow_stage: "send_unconfirmed_best_effort",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            reason: "composer_not_empty_after_send_attempts",
            composer_preview: after.slice(0, 120),
            ts_ms: Date.now(),
          }
        });
      } catch (_) {}
      return {
        ok: true,
        item_link: itemLink || null,
        delivery_confidence: "unconfirmed_best_effort",
        unconfirmed_reason: "composer_not_empty_after_send",
        composer_preview: after.slice(0, 80),
      };
    }

    return { ok: true, item_link: itemLink || null, delivery_confidence: "confirmed_local" };
  } finally {
    try { if (page) page.__virtusDeltaReplyInFlight = false; } catch (_) {}
  }
}

async function openThreadAndExtractItemLink(page, threadKey, { fromNetworkLead = true } = {}) {
  const t = String(threadKey || "").trim();
  if (!t) return { ok: false, error: "missing_thread_key" };
  try {
    if (fromNetworkLead) {
      await prepareDomForNetworkLead(page, threadKey, { fastMarketplace: true });
    }
  } catch (_) {}

  const open = await openThreadByClick(page, threadKey, { maxScrollSteps: 20, forensicAccountLogin: null });
  if (!open || !open.ok) {
    return { ok: false, error: String((open && open.error) || "thread_open_failed") };
  }

  const itemLinkAttempts = Math.max(2, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 4) || 4);
  let itemLink = null;
  try {
    itemLink = await extractMarketplaceItemLinkWithRetry(page, { attempts: itemLinkAttempts });
  } catch (_) {}
  if (!itemLink) {
    return { ok: false, error: "item_link_missing" };
  }
  return { ok: true, item_link: itemLink };
}

async function collectCityFromItemLinkUsingGlobalCollector({
  itemLink,
  threadKey,
  accountLogin,
  timeoutMs,
  attempts
}) {
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
    timeoutMs,
    attempts
  });
  return out && typeof out === "object" ? out : { ok: false, error: "delta_city_collector_unknown_error" };
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
    if (envDirect) {
      const normalized = envDirect.replace(/\/+$/, "");
      if (/\/api\/attendance\/confirm-delivery$/i.test(normalized)) return normalized;
      return `${normalized}/api/attendance/confirm-delivery`;
    }
    const base = String(process.env.CT_BASE_URL || process.env.CT_URL || "").trim();
    if (base) return `${base.replace(/\/+$/, "")}/api/attendance/confirm-delivery`;
    // Regra rígida: sem fallback para produção pública.
    // Se não houver URL explícita de ambiente, falha de forma visível (log forense),
    // mantendo o envio no Facebook desacoplado (fire-and-forget).
    return "";
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
              const rerouteCandidates = [
                __deriveCtConfirmCanonicalFallbackUrl(),
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
  const page = pages[restrictTab] || pages[0] || (await browser.newPage());
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

  async function sendDeltaReplyNow({ threadKey, textoResposta, clientMessageId = null }) {
    if (!running || !epochOk()) return { ok: false, error: "delta_runtime_not_ready" };
    const t = String(threadKey || "").trim();
    const msg = String(textoResposta || "").replace(/\r/g, "");
    const cmid = String(clientMessageId || "").trim() || null;
    if (!t || !msg) return { ok: false, error: "missing_thread_key_or_texto_resposta" };

    // Drenagem rápida de linha aberta:
    // se a thread já está aberta/selecionada, mantém o canal e aplica pacing 2–10s.
    const continuityProbe = await probeOpenLineContinuity(page, t).catch(() => ({ is_open_line_ready: false }));
    const openLineReady = !!(continuityProbe && continuityProbe.is_open_line_ready === true);
    const cooldownPolicy = openLineReady
      ? { minMs: 2_000, maxMs: 10_000, reason: "open_line_fast_lane" }
      : null;

    // Relógio sentinela por conta; em linha aberta usa faixa 2–10s.
    await enforceGlobalDeltaCooldown(ACCOUNT_LOGIN, cooldownPolicy);

    // Resiliência controlada: 1 retry para falhas transitórias de abertura/hidratação
    // sem repetir comando quando erro for de confirmação final de envio.
    const maxRetries = Math.max(0, Math.min(2, Number(process.env.VIRTUS_DELTA_REPLY_MAX_RETRIES || 1) || 1));
    const isNonRetryableSendError = (err) => {
      const e = String(err || "").trim();
      return (
        e === "send_not_confirmed_after_enter_only" ||
        e === "send_not_confirmed_composer_not_empty" ||
        e === "composer_text_not_registered"
      );
    };
    let lastOut = null;
    let lastErr = "delta_reply_unknown_error";

    for (let attempt = 1; attempt <= (maxRetries + 1); attempt++) {
      if (attempt > 1) {
        const retryWaitMs = randomBetween(1_200, 2_400);
        logInfo(
          `[virtusDelta][reply] retry_visual attempt=${attempt - 1}/${maxRetries} thread_key=${t} wait_ms=${retryWaitMs}`
        );
        await sleep(retryWaitMs);
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
        if (isNonRetryableSendError(lastErr)) {
          const bestEffortOut = {
            ok: true,
            best_effort: true,
            delivery_confidence: "unconfirmed_best_effort",
            unconfirmed_reason: lastErr,
            item_link: (lastOut && lastOut.item_link) ? String(lastOut.item_link) : null,
            last_result: lastOut && typeof lastOut === "object" ? lastOut : null,
          };
          try {
            logInfo(
              `[virtusDelta][reply] nonretryable_promoted_best_effort thread_key=${t} reason=${lastErr}`
            );
          } catch (_) {}
          const nowTs = Date.now();
          writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
          lastCrossThreadKey = String(t);
          lastCrossThreadSendAt = nowTs;
          try {
            const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: t, texto_resposta: msg });
            enqueueDeliveryConfirmToDiskSync({ cmdId: cid, thread_key: t, status: "sent_to_facebook" });
            kickDeliveryConfirmPump();
          } catch (_) {}
          return bestEffortOut;
        }
      } catch (e) {
        lastErr = e && e.message ? String(e.message) : String(e);
        lastOut = { ok: false, error: lastErr };
        if (isNonRetryableSendError(lastErr)) {
          const bestEffortOut = {
            ok: true,
            best_effort: true,
            delivery_confidence: "unconfirmed_best_effort",
            unconfirmed_reason: lastErr,
            last_result: lastOut && typeof lastOut === "object" ? lastOut : null,
          };
          try {
            logInfo(
              `[virtusDelta][reply] exception_promoted_best_effort thread_key=${t} reason=${lastErr}`
            );
          } catch (_) {}
          const nowTs = Date.now();
          writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
          lastCrossThreadKey = String(t);
          lastCrossThreadSendAt = nowTs;
          try {
            const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: t, texto_resposta: msg });
            enqueueDeliveryConfirmToDiskSync({ cmdId: cid, thread_key: t, status: "sent_to_facebook" });
            kickDeliveryConfirmPump();
          } catch (_) {}
          return bestEffortOut;
        }
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
    const itemLinkAttempts = Math.max(2, Number(process.env.VIRTUS_DELTA_ITEM_LINK_ATTEMPTS || 4) || 4);
    const cityCollectorTimeoutMs = Math.max(
      8_000,
      Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000
    );
    const cityCollectorAttempts = Math.max(
      1,
      Math.min(5, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_ATTEMPTS || 3) || 3)
    );
    const cityCollectorInterAttemptMaxMs = 1_600;
    const cityCollectorBudgetMs =
      (cityCollectorTimeoutMs * cityCollectorAttempts) +
      (Math.max(0, cityCollectorAttempts - 1) * cityCollectorInterAttemptMaxMs) +
      2_500;
    const cityCollectMaxWaitEnvMs = Number(process.env.VIRTUS_DELTA_CITY_COLLECT_MAX_WAIT_MS || 0) || 0;
    const cityCollectMaxWaitMs = Math.max(18_000, cityCollectorBudgetMs, cityCollectMaxWaitEnvMs);

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
        skipActionDispatch: true,
      });
      if (sendOut && sendOut.item_link) {
        resolveItemLink(sendOut.item_link);
      } else {
        let recoveredItemLink = null;
        try {
          recoveredItemLink = await extractMarketplaceItemLinkWithRetry(page, { attempts: itemLinkAttempts });
        } catch (_) {}
        if (!recoveredItemLink) {
          try {
            const openOut = await openThreadAndExtractItemLink(page, t, { fromNetworkLead: false });
            if (openOut && openOut.ok && openOut.item_link) {
              recoveredItemLink = String(openOut.item_link || "").trim() || null;
            }
          } catch (_) {}
        }
        if (recoveredItemLink) {
          try {
            logInfo(`[virtusDelta][city_link_recovery] thread_key=${t} recovered=sim`);
          } catch (_) {}
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

    const itemLinkFinal = String(
      (sendOut && sendOut.item_link) ||
      (prior && prior.itemLink) ||
      ""
    ).trim() || null;

    const leadNamePromise = (async () => {
      try {
        const out = await extractLeadClientNameFromFeedDom(page);
        return String(out || "").trim() || null;
      } catch {
        return null;
      }
    })();

    const cityOut = await Promise.race([
      cityCollectionPromise,
      sleep(cityCollectMaxWaitMs).then(() => ({
        ok: false,
        error: "city_collect_timeout",
        timeout_ms: cityCollectMaxWaitMs,
      })),
    ]);
    if (cityOut && cityOut.error === "city_collect_timeout") {
      try {
        __forensicEdgeEmit({
          account_login: ACCOUNT_LOGIN,
          thread_key: t,
          flow_stage: "city_collect_timeout",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            timeout_ms: cityCollectMaxWaitMs,
            collector_timeout_ms: cityCollectorTimeoutMs,
            collector_attempts: cityCollectorAttempts,
            collector_budget_ms: cityCollectorBudgetMs,
          }
        });
      } catch (_) {}
    }

    let cityCandidate = String((cityOut && cityOut.cidade) || "").trim() || null;
    let citySource = cityCandidate
      ? (String((cityOut && cityOut.city_source) || "collector_listing_page").trim() || "collector_listing_page")
      : null;
    if (!cityCandidate) {
      try {
        const domCity = await extractCityFromMarketplaceDom(page);
        const domCityCandidate = String(domCity || "").trim();
        if (domCityCandidate) {
          cityCandidate = domCityCandidate;
          citySource = "dom_live_fallback";
        }
      } catch (_) {}
    }
    if (!cityCandidate) {
      const cachedCity = String((cityCache && cityCache.value) || "").trim();
      if (cachedCity) {
        cityCandidate = cachedCity;
        citySource = "dom_cache_fallback";
      }
    }

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

    if (!cityCandidate) {
      greetingStateByThread.set(t, {
        sentAt: Number((prior && prior.sentAt) || Date.now()),
        greetingText,
        itemLink: itemLinkFinal,
        city: null,
        citySource: null,
      });
      try {
        __forensicEdgeEmit({
          account_login: ACCOUNT_LOGIN,
          thread_key: t,
          flow_stage: "city_collect_contingency",
          details: {
            tag: "FORENSIC_DOM_REVERSE",
            reason: String((cityOut && cityOut.error) || "city_collect_failed"),
            item_link: itemLinkFinal || null,
            city_cache_hit: !!(cityCache && cityCache.value),
          }
        });
      } catch (_) {}
      const nowTs = Date.now();
      writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
      lastCrossThreadKey = String(t);
      lastCrossThreadSendAt = nowTs;
      return {
        ok: true,
        cidade: null,
        city_source: null,
        link_anuncio: itemLinkFinal || null,
        profile_url: profileUrl,
        greeting_text: greetingText,
        mensagens_cliente: mensagensConcatenadas,
        nome_cliente_limpo: nomeClienteLimpo,
        customer_name: nomeClienteLimpo,
        metadata_contingency_applied: true,
        metadata_error: String((cityOut && cityOut.error) || "city_collect_failed"),
      };
    }

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

    const nowTs = Date.now();
    writeLastDeltaSendTimestamp(ACCOUNT_LOGIN, nowTs);
    lastCrossThreadKey = String(t);
    lastCrossThreadSendAt = nowTs;

    return {
      ok: true,
      cidade: cityCandidate || null,
      city_source: citySource,
      link_anuncio: itemLinkFinal || null,
      profile_url: profileUrl,
      greeting_text: greetingText,
      mensagens_cliente: mensagensConcatenadas,
      nome_cliente_limpo: nomeClienteLimpo,
      customer_name: nomeClienteLimpo,
    };
  }

  const enqueueDeltaReply = ({ thread_key, texto_resposta, client_message_id } = {}) => {
    return enqueue(async () => {
      try {
        const tk = String(thread_key || "").trim();
        const tr = String(texto_resposta || "").replace(/\r/g, "");
        const cmid = String(client_message_id || "").trim() || null;
        if (cmid) {
          const prior = getReplyDispatchState(cmid);
          if (prior && prior.state === "done") {
            try { logInfo(`[virtusDelta][reply] duplicate_done_skip thread_key=${tk} client_message_id=${cmid}`); } catch (_) {}
            return { ok: true, status: "duplicate_done_skip", client_message_id: cmid };
          }
          if (prior && prior.state === "inflight") {
            try { logInfo(`[virtusDelta][reply] duplicate_inflight_skip thread_key=${tk} client_message_id=${cmid}`); } catch (_) {}
            return { ok: true, status: "duplicate_inflight_skip", client_message_id: cmid };
          }
          setReplyDispatchState(cmid, "inflight", tk);
        }
        const out = await sendDeltaReplyNow({ threadKey: tk, textoResposta: tr, clientMessageId: cmid });
        if (out && out.ok) {
          if (cmid) setReplyDispatchState(cmid, "done", tk);
          try {
            await __deltaEnforceSidebarResetToTop(page, {
              threadKey: tk,
              forensicAccountLogin: ACCOUNT_LOGIN,
              reason: "reply_sent_success"
            });
          } catch (_) {}
          return out;
        }

        // Sem requeue em background: falhou no ciclo síncrono (A->B), reverte status no CT e encerra.
        try {
          const err = String(out && out.error || "").trim() || "send_failed";
          const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: tk, texto_resposta: tr });
          kickReverseDeliveryStatus({ client_message_id: cid, thread_key: tk, status: "error_failed_to_send", error: err });
        } catch (_) {}
        if (cmid) clearReplyDispatchState(cmid);
        return out;
      } catch (e) {
        const tk = String(thread_key || "").trim();
        const tr = String(texto_resposta || "").replace(/\r/g, "");
        const cmid = String(client_message_id || "").trim() || null;
        const err = e && e.message ? String(e.message) : String(e);
        try {
          const cid = cmid || computeFallbackClientMessageId({ account_login: ACCOUNT_LOGIN, thread_key: tk, texto_resposta: tr });
          kickReverseDeliveryStatus({ client_message_id: cid, thread_key: tk, status: "error_failed_to_send", error: err || "send_failed_exception" });
        } catch (_) {}
        if (cmid) clearReplyDispatchState(cmid);
        return { ok: false, error: err };
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

