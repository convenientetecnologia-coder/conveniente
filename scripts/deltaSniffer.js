const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

let puppeteer = null;
try {
  const pExtra = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
} catch (_) {
  try {
    puppeteer = require("puppeteer");
  } catch {
    puppeteer = null;
  }
}

const DEFAULT_START_URL = "https://www.facebook.com/messages";
const DEFAULT_LEADS_PATH = path.join(__dirname, "..", "dados", "leads_brutos.jsonl");
const DEFAULT_HEXDUMP_BYTES = Math.max(16, Number(process.env.DELTA_SNIFFER_HEXDUMP_BYTES || 32) || 32);
const DEFAULT_FRAME_DUMP_EVERY_MS = Math.max(0, Number(process.env.DELTA_SNIFFER_FRAME_DUMP_EVERY_MS || 15000) || 15000);

function parseArgs(argv) {
  const out = Object.create(null);
  const raw = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < raw.length; i++) {
    const token = String(raw[i] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).trim();
    if (!key) continue;
    const next = String(raw[i + 1] || "");
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "1";
    }
  }
  return out;
}

function decodeEscapedText(value) {
  if (typeof value !== "string") return "";
  try {
    return JSON.parse(`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  } catch {
    return value;
  }
}

function decodeWsPayloadBuffer(payloadData, opcode) {
  if (Buffer.isBuffer(payloadData)) return payloadData;
  if (typeof payloadData !== "string" || payloadData.length === 0) return Buffer.alloc(0);
  const shouldDecodeBase64 = Number(opcode) === 2 || (/^[A-Za-z0-9+/=\r\n]+$/.test(payloadData) && payloadData.length % 4 === 0);
  if (!shouldDecodeBase64) {
    try {
      return Buffer.from(payloadData, "utf8");
    } catch {
      return Buffer.alloc(0);
    }
  }
  try {
    return Buffer.from(payloadData, "base64");
  } catch {
    try {
      return Buffer.from(payloadData, "utf8");
    } catch {
      return Buffer.alloc(0);
    }
  }
}

function hexdumpPrefix(buf, maxBytes = DEFAULT_HEXDUMP_BYTES) {
  if (!Buffer.isBuffer(buf) || !buf.length) return "";
  const n = Math.max(1, Number(maxBytes) || DEFAULT_HEXDUMP_BYTES);
  return buf.subarray(0, Math.min(buf.length, n)).toString("hex");
}

function normalizeBinaryText(text) {
  if (typeof text !== "string" || !text) return "";
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectThreadCandidatesFromBinaryText(text, intoSet) {
  const out = intoSet instanceof Set ? intoSet : new Set();
  if (typeof text !== "string" || !text) return out;
  const patterns = [
    /(?:thread_key|thread_id|thread_fbid|threadKey|threadId)[^0-9]{0,24}(\d{5,24})/gi,
    /\/messages\/(?:e2ee\/)?t\/(\d{5,24})/gi,
    /(?:^|[^0-9])(1\d{14,20})(?:[^0-9]|$)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m = null;
    while ((m = re.exec(text))) {
      const v = String((m[1] || "").trim());
      if (v) out.add(v);
    }
  }
  return out;
}

function looksLikeHumanTextCandidate(value) {
  const t = String(value || "").trim();
  if (!t) return false;
  if (t.startsWith("mid.")) return false;
  if (/^\d{6,}$/.test(t)) return false;
  if (/^[a-f0-9]{16,}$/i.test(t)) return false;
  if (/^(true|false|null)$/i.test(t)) return false;
  return t.length >= 1;
}

function collectMessageCandidatesFromBinaryText(text, intoArr) {
  const out = Array.isArray(intoArr) ? intoArr : [];
  if (typeof text !== "string" || !text) return out;
  const patterns = [
    /"(?:text|body|snippet|message_text|messageText)"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    /(?:text|body|snippet|message_text|messageText)[^"]{0,16}"((?:\\.|[^"\\])*)"/gi,
    /(?:texto_limpo|mensagem|message)[^:\n]{0,24}:\s*"((?:\\.|[^"\\])*)"/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m = null;
    while ((m = re.exec(text))) {
      const candidate = decodeEscapedText(String(m[1] || "").trim());
      if (looksLikeHumanTextCandidate(candidate)) out.push(candidate);
    }
  }
  return out;
}

function extractLightspeedBinaryEvents({ payloadData, opcode } = {}) {
  const rawBuffer = decodeWsPayloadBuffer(payloadData, opcode);
  if (!Buffer.isBuffer(rawBuffer) || !rawBuffer.length) return [];

  let utf8 = "";
  try {
    utf8 = rawBuffer.toString("utf8");
  } catch {
    utf8 = "";
  }
  const normalized = normalizeBinaryText(utf8);
  if (!normalized) return [];

  const threadCandidates = collectThreadCandidatesFromBinaryText(normalized, new Set());
  const messageCandidates = collectMessageCandidatesFromBinaryText(normalized, []);
  if (!threadCandidates.size || !messageCandidates.length) return [];

  const seen = new Set();
  const out = [];
  for (const threadKey of threadCandidates) {
    for (const messageText of messageCandidates) {
      const k = `${threadKey}|${messageText}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        thread_key: String(threadKey || "").trim(),
        texto_limpo: String(messageText || "").trim(),
      });
    }
  }
  return out;
}

function classifyWsUrl(url) {
  const u = String(url || "").toLowerCase();
  const isFacebook = /facebook\.com/.test(u);
  const isLightspeedish = /(lightspeed|mqtt|chat|mercury|messenger|graphql)/.test(u);
  return {
    url: String(url || ""),
    isFacebook,
    isLightspeedish,
    enabled: isFacebook && isLightspeedish,
  };
}

async function loadCookies(filePath) {
  const fp = String(filePath || "").trim();
  if (!fp) return [];
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = await fsp.readFile(fp, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function createRecentDeduper(maxSize = 3000) {
  const map = new Map();
  return {
    seen(key, ttlMs) {
      const now = Date.now();
      const last = Number(map.get(key) || 0);
      if (last && (now - last) < ttlMs) return true;
      map.set(key, now);
      if (map.size > maxSize) {
        const floor = now - Math.max(ttlMs, 30_000);
        for (const [k, ts] of map.entries()) {
          if ((Number(ts) || 0) < floor) map.delete(k);
        }
      }
      return false;
    },
  };
}

function ensureLeadsFile(leadsPath) {
  fs.mkdirSync(path.dirname(leadsPath), { recursive: true });
  if (!fs.existsSync(leadsPath)) fs.writeFileSync(leadsPath, "", "utf8");
}

function buildSnifferRuntime({ accountLogin, leadsPath, dedupeTtlMs, frameDumpEveryMs, tag }) {
  const wsMetaByRid = new Map();
  const wsLastDumpByRid = new Map();
  const deduper = createRecentDeduper();
  const label = String(tag || "deltaSniffer").trim() || "deltaSniffer";

  const log = (msg) => {
    try { console.log(`[${label}] ${msg}`); } catch (_) {}
  };

  const upsertWsMeta = (rid, patch) => {
    const id = String(rid || "").trim();
    if (!id) return null;
    const prev = wsMetaByRid.get(id) || { rid: id, url: "", enabled: false };
    const next = { ...prev, ...(patch || {}) };
    if (patch && patch.url != null) {
      const info = classifyWsUrl(next.url);
      next.url = info.url;
      next.enabled = info.enabled;
    }
    wsMetaByRid.set(id, next);
    return next;
  };

  const appendLead = (lead, context = {}) => {
    const threadKey = String(lead && lead.thread_key ? lead.thread_key : "").trim();
    const textoLimpo = String(lead && lead.texto_limpo ? lead.texto_limpo : "").trim();
    if (!threadKey || !textoLimpo) return;
    if (textoLimpo.startsWith("mid.")) return;
    if (/^\d{6,}$/.test(textoLimpo)) return;

    const dedupeKey = `${threadKey}|${textoLimpo}`;
    if (deduper.seen(dedupeKey, dedupeTtlMs)) return;

    const nowTs = Date.now();
    const payload = {
      ts: nowTs,
      iso: new Date(nowTs).toISOString(),
      source: "delta_sniffer_lightspeed",
      account_login: accountLogin,
      thread_key: threadKey,
      texto_limpo: textoLimpo,
      request_id: String(context.requestId || ""),
      ws_url: String(context.wsUrl || ""),
      payload_len: Number(context.payloadLen || 0) || 0,
      hexdump: String(context.hexdump || ""),
      idempotency_key: crypto.createHash("sha1").update(`${threadKey}|${textoLimpo}`).digest("hex"),
    };
    try {
      fs.appendFileSync(leadsPath, `${JSON.stringify(payload)}\n`, "utf8");
      log(`lead thread_key=${threadKey} text=${textoLimpo.slice(0, 140)}`);
    } catch (e) {
      log(`append_fail err=${e && e.message ? e.message : String(e)}`);
    }
  };

  const onWsCreated = (ev) => {
    const rid = String(ev && ev.requestId ? ev.requestId : "");
    const url = String(ev && ev.url ? ev.url : "");
    upsertWsMeta(rid, { url });
  };
  const onWsHandshakeReq = (ev) => {
    const rid = String(ev && ev.requestId ? ev.requestId : "");
    const url = String((ev && ev.request && ev.request.url) || "");
    upsertWsMeta(rid, { url });
  };
  const onWsHandshakeRes = (ev) => {
    const rid = String(ev && ev.requestId ? ev.requestId : "");
    const url = String((ev && ev.response && ev.response.url) || "");
    upsertWsMeta(rid, { url });
  };
  const onWsClosed = (ev) => {
    const rid = String(ev && ev.requestId ? ev.requestId : "");
    if (!rid) return;
    wsMetaByRid.delete(rid);
    wsLastDumpByRid.delete(rid);
  };
  const onFrame = (ev) => {
    const rid = String(ev && ev.requestId ? ev.requestId : "").trim();
    if (!rid) return;
    const meta = wsMetaByRid.get(rid) || upsertWsMeta(rid, { url: "" });
    if (!meta || meta.enabled !== true) return;

    const response = ev && ev.response ? ev.response : {};
    const opcode = Number(response.opcode || 0) || 0;
    if (opcode !== 2) return;

    const payloadData = response.payloadData;
    const rawBuffer = decodeWsPayloadBuffer(payloadData, opcode);
    if (!rawBuffer.length) return;

    const now = Date.now();
    const lastDumpAt = Number(wsLastDumpByRid.get(rid) || 0);
    if (frameDumpEveryMs === 0 || !lastDumpAt || (now - lastDumpAt) >= frameDumpEveryMs) {
      wsLastDumpByRid.set(rid, now);
      log(`frame rid=${rid} bytes=${rawBuffer.length} hexdump=${hexdumpPrefix(rawBuffer, DEFAULT_HEXDUMP_BYTES)}`);
    }

    const events = extractLightspeedBinaryEvents({ payloadData, opcode });
    if (!events.length) return;
    for (const lead of events) {
      appendLead(lead, {
        requestId: rid,
        wsUrl: meta.url || "",
        payloadLen: rawBuffer.length,
        hexdump: hexdumpPrefix(rawBuffer, DEFAULT_HEXDUMP_BYTES),
      });
    }
  };

  return {
    onWsCreated,
    onWsHandshakeReq,
    onWsHandshakeRes,
    onWsClosed,
    onFrame,
    log,
  };
}

async function attachDeltaSnifferToPage(page, options = {}) {
  if (!page || !page.target || typeof page.target !== "function") {
    throw new Error("page_invalid");
  }
  const accountLogin = String(options.accountLogin || process.env.FB_ACCOUNT_LOGIN || process.env.ACCOUNT_LOGIN || "").trim() || null;
  const leadsPath = path.resolve(String(options.leadsPath || process.env.DELTA_SNIFFER_LEADS_FILE || DEFAULT_LEADS_PATH).trim());
  const dedupeTtlMs = Math.max(5000, Number(options.dedupeTtlMs || process.env.DELTA_SNIFFER_DEDUPE_TTL_MS || 90_000) || 90_000);
  const frameDumpEveryMs = Math.max(0, Number(options.frameDumpEveryMs || process.env.DELTA_SNIFFER_FRAME_DUMP_EVERY_MS || DEFAULT_FRAME_DUMP_EVERY_MS) || DEFAULT_FRAME_DUMP_EVERY_MS);
  const tag = String(options.tag || `deltaSniffer:${String(options.nome || accountLogin || "runtime")}`).trim();

  ensureLeadsFile(leadsPath);
  const guardKey = "__deltaSnifferAttachState";
  if (page[guardKey] && page[guardKey].active) {
    return { ok: true, reused: true, stop: page[guardKey].stop };
  }

  const client = await page.target().createCDPSession();
  await client.send("Network.enable");
  const runtime = buildSnifferRuntime({ accountLogin, leadsPath, dedupeTtlMs, frameDumpEveryMs, tag });

  client.on("Network.webSocketCreated", runtime.onWsCreated);
  client.on("Network.webSocketWillSendHandshakeRequest", runtime.onWsHandshakeReq);
  client.on("Network.webSocketHandshakeResponseReceived", runtime.onWsHandshakeRes);
  client.on("Network.webSocketClosed", runtime.onWsClosed);
  client.on("Network.webSocketFrameReceived", runtime.onFrame);

  const stop = async () => {
    try { client.removeListener("Network.webSocketCreated", runtime.onWsCreated); } catch (_) {}
    try { client.removeListener("Network.webSocketWillSendHandshakeRequest", runtime.onWsHandshakeReq); } catch (_) {}
    try { client.removeListener("Network.webSocketHandshakeResponseReceived", runtime.onWsHandshakeRes); } catch (_) {}
    try { client.removeListener("Network.webSocketClosed", runtime.onWsClosed); } catch (_) {}
    try { client.removeListener("Network.webSocketFrameReceived", runtime.onFrame); } catch (_) {}
    try { await client.detach(); } catch (_) {}
    try { if (page[guardKey]) page[guardKey].active = false; } catch (_) {}
  };

  page[guardKey] = { active: true, stop };
  runtime.log(`ready attached leads_file=${leadsPath}`);
  return { ok: true, stop };
}

async function startDeltaSniffer(options = {}) {
  if (!puppeteer) {
    throw new Error("puppeteer_not_installed");
  }
  const accountLogin = String(options.accountLogin || process.env.FB_ACCOUNT_LOGIN || process.env.ACCOUNT_LOGIN || "").trim() || null;
  const leadsPath = path.resolve(String(options.leadsPath || process.env.DELTA_SNIFFER_LEADS_FILE || DEFAULT_LEADS_PATH).trim());
  const chromeExecutable = String(
    options.chromeExecutable ||
    process.env.CHROME_PATH ||
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe")
  ).trim();
  const userDataDir = String(options.userDataDir || process.env.VIRTUS_DELTA_USER_DATA_DIR || "").trim() || null;
  const cookiesFile = String(options.cookiesFile || process.env.VIRTUS_DELTA_COOKIES_FILE || "").trim() || null;
  const startUrl = String(options.startUrl || process.env.DELTA_SNIFFER_START_URL || DEFAULT_START_URL).trim() || DEFAULT_START_URL;
  const browserUrl = String(options.browserUrl || process.env.DELTA_SNIFFER_BROWSER_URL || "").trim() || null;
  const dedupeTtlMs = Math.max(5000, Number(options.dedupeTtlMs || process.env.DELTA_SNIFFER_DEDUPE_TTL_MS || 90_000) || 90_000);
  const frameDumpEveryMs = Math.max(0, Number(options.frameDumpEveryMs || process.env.DELTA_SNIFFER_FRAME_DUMP_EVERY_MS || DEFAULT_FRAME_DUMP_EVERY_MS) || DEFAULT_FRAME_DUMP_EVERY_MS);

  ensureLeadsFile(leadsPath);

  console.log(`[deltaSniffer][boot] account_login=${accountLogin || "null"}`);
  console.log(`[deltaSniffer][boot] leads_file=${leadsPath}`);
  console.log(`[deltaSniffer][boot] start_url=${startUrl}`);
  if (userDataDir) console.log(`[deltaSniffer][boot] user_data_dir=${userDataDir}`);

  const browser = browserUrl
    ? await puppeteer.connect({ browserURL: browserUrl })
    : await puppeteer.launch({
        headless: false,
        executablePath: chromeExecutable || undefined,
        userDataDir: userDataDir || undefined,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-features=IsolateOrigins,site-per-process"],
        defaultViewport: null,
      });
  const ownsBrowser = !browserUrl;

  const pages = await browser.pages().catch(() => []);
  const page = pages[0] || (await browser.newPage());

  const cookies = await loadCookies(cookiesFile);
  if (cookies.length) {
    try { await page.setCookie(...cookies); } catch (_) {}
  }

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  const attached = await attachDeltaSnifferToPage(page, {
    accountLogin,
    leadsPath,
    dedupeTtlMs,
    frameDumpEveryMs,
    tag: "deltaSniffer",
  });

  const shutdown = async () => {
    try { if (attached && typeof attached.stop === "function") await attached.stop(); } catch (_) {}
    if (ownsBrowser) {
      try { await browser.close(); } catch (_) {}
    }
  };

  process.on("SIGINT", () => shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown().finally(() => process.exit(0)));
  console.log("[deltaSniffer][ready] escuta dedicada ativa.");
  return { ok: true, shutdown };
}

module.exports = {
  startDeltaSniffer,
  attachDeltaSnifferToPage,
  decodeWsPayloadBuffer,
  extractLightspeedBinaryEvents,
};

if (require.main === module) {
  const cli = parseArgs(process.argv.slice(2));
  startDeltaSniffer({
    accountLogin: cli.accountLogin || cli.account_login,
    leadsPath: cli.leadsPath || cli.leads_path,
    chromeExecutable: cli.chromeExecutable || cli.chrome_executable,
    userDataDir: cli.userDataDir || cli.user_data_dir,
    cookiesFile: cli.cookiesFile || cli.cookies_file,
    startUrl: cli.startUrl || cli.start_url,
    browserUrl: cli.browserUrl || cli.browser_url,
    dedupeTtlMs: cli.dedupeTtlMs || cli.dedupe_ttl_ms,
    frameDumpEveryMs: cli.frameDumpEveryMs || cli.frame_dump_every_ms,
  }).catch((e) => {
    console.error("[deltaSniffer][fatal]", e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
