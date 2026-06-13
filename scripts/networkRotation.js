"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { exec } = require("child_process");
const { promisify } = require("util");
const puppeteer = require("puppeteer");
const logger = require("./logger.js");
const serverConfig = require("./serverConfig.js");
const provisionAudit = require("./provisionAudit.js");

const execAsync = promisify(exec);
const DADOS_DIR = path.join(__dirname, "..", "dados");
const STATE_PATH = path.join(DADOS_DIR, "network_rotation_state.json");
const LOOP_MS = 5000;
const PUBLIC_IP_REFRESH_MS = 2 * 60 * 1000;
const BROWSER_LAUNCH_TIMEOUT_MS = Math.max(5000, Number(process.env.NETWORK_ROTATION_BROWSER_LAUNCH_TIMEOUT_MS || 25000) || 25000);
const INPROGRESS_STALE_MS = Math.max(60 * 1000, Number(process.env.NETWORK_ROTATION_INPROGRESS_STALE_MS || (25 * 60 * 1000)) || (25 * 60 * 1000));
const CYCLE_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.NETWORK_ROTATION_CYCLE_TIMEOUT_MS || (15 * 60 * 1000)) || (15 * 60 * 1000));
const AUTO_DEFAULT_MODEM_LOGIN_URL = String(process.env.NETWORK_ROTATION_DEFAULT_LOGIN_URL || "http://192.168.2.1:2080/").trim();
const AUTO_DEFAULT_MODEM_REBOOT_URL = String(process.env.NETWORK_ROTATION_DEFAULT_REBOOT_URL || "http://192.168.2.1:2080/Reboot").trim();
const AUTO_DEFAULT_MODEM_USER = String(process.env.NETWORK_ROTATION_DEFAULT_MODEM_USER || "SupAdmin").trim();
const AUTO_DEFAULT_MODEM_PASSWORD = String(process.env.NETWORK_ROTATION_DEFAULT_MODEM_PASSWORD || "AdminSup3031").trim();

let timer = null;
let inFlight = false;
let state = null;
let localPort = Number(process.env.PORT || 8088) || 8088;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function now() { return Date.now(); }

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function readJsonSafe(fp, fallback = null) {
  try { return JSON.parse(String(fs.readFileSync(fp, "utf8") || "")); } catch { return fallback; }
}

function writeJsonAtomic(fp, obj) {
  ensureDirSync(path.dirname(fp));
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, fp);
}

function buildDefaultState() {
  return {
    version: 1,
    updatedAt: now(),
    schedulerEnabled: false,
    nextRotationAt: 0,
    lastRotationAt: 0,
    lastRotationFinishedAt: 0,
    lastRotationOk: null,
    lastRotationSummary: null,
    inProgress: false,
    inProgressSince: 0,
    currentPublicIp: null,
    previousPublicIp: null,
    attemptsLastCycle: 0,
    rebootDetectedLastCycle: false,
    activeGateway: null,
    selectedFlow: null,
    manualTriggerPending: false,
    manualTriggerOptions: null,
    credentialCache: null, // { username, password, savedAt }
    lastPublicIpCheckAt: 0,
    lastError: null
  };
}

function loadState() {
  const j = readJsonSafe(STATE_PATH, null);
  return (j && typeof j === "object") ? { ...buildDefaultState(), ...j } : buildDefaultState();
}

function saveState(patch = null) {
  const next = { ...(state || buildDefaultState()), ...(patch || {}), updatedAt: now() };
  state = next;
  writeJsonAtomic(STATE_PATH, next);
  return next;
}

function pickRandomDelayMs(minMinutes, maxMinutes) {
  const minMs = Math.floor(Math.max(1, Number(minMinutes) || 60) * 60 * 1000);
  const maxMs = Math.floor(Math.max(minMs, Number(maxMinutes) || 120) * 60 * 1000);
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function parseCredentialCandidates(cfgNet = null) {
  // Formato: "user1|pass1;user2|pass2"
  const rawBank = String(process.env.NETWORK_ROTATION_CREDENTIALS || "").trim();
  const out = [];
  if (rawBank) {
    for (const item of rawBank.split(";")) {
      const part = String(item || "").trim();
      if (!part) continue;
      const [u, p] = part.split("|");
      const username = String(u || "").trim();
      const password = String(p || "").trim();
      if (username && password) out.push({ username, password, source: "env_bank" });
    }
  }
  const singleU = String(process.env.NETWORK_ROTATION_MODEM_USER || "").trim();
  const singleP = String(process.env.NETWORK_ROTATION_MODEM_PASSWORD || "").trim();
  if (singleU && singleP) out.push({ username: singleU, password: singleP, source: "env_single" });
  const cfgUser = String(cfgNet && cfgNet.modemUsername || "").trim();
  const cfgPass = String(cfgNet && cfgNet.modemPassword || "").trim();
  if (cfgUser && cfgPass) out.unshift({ username: cfgUser, password: cfgPass, source: "server_config" });
  if (AUTO_DEFAULT_MODEM_USER && AUTO_DEFAULT_MODEM_PASSWORD) {
    out.push({ username: AUTO_DEFAULT_MODEM_USER, password: AUTO_DEFAULT_MODEM_PASSWORD, source: "autofill_default" });
  }
  return out.filter((x, idx, arr) => {
    const key = `${String(x && x.username || "").trim()}::${String(x && x.password || "").trim()}`;
    return key !== "::" && arr.findIndex((y) => `${String(y && y.username || "").trim()}::${String(y && y.password || "").trim()}` === key) === idx;
  });
}

function getHostFromUrl(url) {
  try {
    const u = new URL(String(url || "").trim());
    return String(u.hostname || "").trim() || null;
  } catch {
    return null;
  }
}

function dedupeFlows(list) {
  const out = [];
  const seen = new Set();
  for (const flow of (Array.isArray(list) ? list : [])) {
    if (!isValidFlow(flow)) continue;
    const key = `${String(flow.loginUrl).trim()}::${String(flow.rebootUrl).trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ...flow,
      gatewayHost: String(flow.gatewayHost || getHostFromUrl(flow.loginUrl) || "").trim() || null
    });
  }
  return out;
}

function isUsableIpv4(ip) {
  const v = String(ip || "").trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v)) return false;
  if (v === "0.0.0.0") return false;
  return true;
}

function isBlockedHost(host) {
  const h = String(host || "").trim().toLowerCase();
  if (!h) return true;
  if (h === "0.0.0.0") return true;
  return false;
}

function isValidFlow(flow) {
  try {
    if (!flow || !flow.loginUrl || !flow.rebootUrl) return false;
    const lu = new URL(String(flow.loginUrl).trim());
    const ru = new URL(String(flow.rebootUrl).trim());
    if (isBlockedHost(lu.hostname)) return false;
    if (isBlockedHost(ru.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function sanitizeNextRotationAt(st, cfg) {
  const cur = (st && typeof st === "object") ? st : {};
  const nowTs = now();
  const maxIntervalMin = Math.max(10, Number(cfg && cfg.intervalMaxMinutes || 120) || 120);
  const maxFutureMs = (maxIntervalMin * 60 * 1000) + (10 * 60 * 1000);
  const nextTs = Number(cur.nextRotationAt || 0) || 0;
  if (nextTs <= 0) return 0;
  if ((nextTs - nowTs) > maxFutureMs) return 0;
  return nextTs;
}

function findChromeStable() {
  const envChrome = String(process.env.CHROME_PATH || "").trim();
  if (envChrome && fs.existsSync(envChrome)) return envChrome;
  const envChromium = String(process.env.CHROMIUM_PATH || "").trim();
  if (envChromium && fs.existsSync(envChromium)) return envChromium;
  const candidates = [];
  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(os.homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")
    );
  } else {
    candidates.push(
      "/opt/google/chrome/chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/snap/bin/chromium"
    );
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function recoverStaleInProgressState(st, { reason = "stale_recovered" } = {}) {
  const cur = (st && typeof st === "object") ? st : (state || loadState());
  if (!cur || cur.inProgress !== true) return false;
  const tNow = now();
  const startedAt = Number(cur.inProgressSince || cur.lastRotationAt || 0) || 0;
  const stale = (startedAt <= 0) || ((tNow - startedAt) > INPROGRESS_STALE_MS);
  if (!stale) return false;
  saveState({
    inProgress: false,
    inProgressSince: 0,
    manualTriggerPending: false,
    manualTriggerOptions: null,
    lastError: reason,
    lastRotationFinishedAt: tNow
  });
  try {
    provisionAudit.append({
      ts: tNow,
      event: "network_rotation_stale_recovered",
      ok: false,
      error: reason
    });
  } catch {}
  try { logger.warn("[NET-ROTATE] estado inProgress recuperado", { reason, startedAt }); } catch {}
  return true;
}

async function withTimeout(promise, timeoutMs, timeoutLabel = "operation_timeout") {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(timeoutLabel));
    }, Math.max(1000, Number(timeoutMs) || 1000));
    promise.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      reject(e);
    });
  });
}

async function getDefaultGatewayIpv4() {
  try {
    const { stdout } = await execAsync("route print -4");
    const lines = String(stdout || "")
      .split(/\r?\n/)
      .map((l) => String(l || "").trim())
      .filter(Boolean);
    for (const line of lines) {
      const cols = line.split(/\s+/);
      // Formato típico do Windows:
      // 0.0.0.0  0.0.0.0  <gateway>  <interface>  <metric>
      if (cols.length < 3) continue;
      if (cols[0] !== "0.0.0.0" || cols[1] !== "0.0.0.0") continue;
      const gw = cols[2];
      if (isUsableIpv4(gw)) return gw;
    }
    return null;
  } catch {
    return null;
  }
}

function buildFlowCandidates(gatewayIp) {
  const cfg = serverConfig.readServerConfigEffective({});
  const nr = (cfg && cfg.networkRotation) ? cfg.networkRotation : {};
  const gwRaw = String(gatewayIp || nr.gatewayHost || "").trim();
  const gw = isUsableIpv4(gwRaw) ? gwRaw : "";
  const st = state || loadState();
  const out = [];
  if (st && st.selectedFlow && st.selectedFlow.loginUrl && st.selectedFlow.rebootUrl) {
    out.push({
      name: "state_cached_flow",
      loginUrl: String(st.selectedFlow.loginUrl).trim(),
      rebootUrl: String(st.selectedFlow.rebootUrl).trim(),
      gatewayHost: String(st.selectedFlow.gatewayHost || getHostFromUrl(st.selectedFlow.loginUrl) || "").trim() || null
    });
  }
  if (String(nr.loginUrl || "").trim() && String(nr.rebootUrl || "").trim()) {
    out.push({
      name: "config_urls",
      loginUrl: String(nr.loginUrl).trim(),
      rebootUrl: String(nr.rebootUrl).trim(),
      gatewayHost: gw || null
    });
  }
  if (gw) {
    out.push({ name: "gw_2080_http", loginUrl: `http://${gw}:2080/`, rebootUrl: `http://${gw}:2080/Reboot`, gatewayHost: gw });
    out.push({ name: "gw_https_reboot", loginUrl: `https://${gw}/`, rebootUrl: `https://${gw}/Reboot`, gatewayHost: gw });
    out.push({ name: "gw_http_admin_login", loginUrl: `http://${gw}/admin/login.asp`, rebootUrl: `http://${gw}/Reboot`, gatewayHost: gw });
  }
  if (AUTO_DEFAULT_MODEM_LOGIN_URL && AUTO_DEFAULT_MODEM_REBOOT_URL) {
    out.push({
      name: "autofill_default_urls",
      loginUrl: AUTO_DEFAULT_MODEM_LOGIN_URL,
      rebootUrl: AUTO_DEFAULT_MODEM_REBOOT_URL,
      gatewayHost: getHostFromUrl(AUTO_DEFAULT_MODEM_LOGIN_URL)
    });
  }
  return dedupeFlows(out);
}

function httpProbe(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, statusCode: res.statusCode || null });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ ok: false, error: (err && err.message) ? err.message : String(err) }));
  });
}

function fetchText(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https://") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function extractIpv4(text) {
  const m = String(text || "").match(/\b(\d{1,3}\.){3}\d{1,3}\b/);
  return m ? m[0] : null;
}

async function getPublicIp() {
  const providers = ["https://api.ipify.org", "https://ifconfig.me/ip", "https://ipv4.icanhazip.com"];
  for (const url of providers) {
    try {
      const txt = await fetchText(url, 7000);
      const ip = extractIpv4(txt);
      if (ip) return ip;
    } catch {}
  }
  return null;
}

async function refreshPublicIpSnapshot({ force = false } = {}) {
  const st = state || loadState();
  const tNow = now();
  const shouldRefresh = force
    || !st.lastPublicIpCheckAt
    || ((tNow - Number(st.lastPublicIpCheckAt || 0)) >= PUBLIC_IP_REFRESH_MS);
  if (!shouldRefresh) return st.currentPublicIp || null;
  const ip = await getPublicIp();
  if (ip) {
    saveState({
      currentPublicIp: ip,
      lastPublicIpCheckAt: tNow
    });
  } else {
    saveState({ lastPublicIpCheckAt: tNow });
  }
  return ip || st.currentPublicIp || null;
}

async function httpJson(url, body = null, timeoutMs = 45000) {
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  try {
    const r = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "x-operator": "network_rotation" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal
    });
    return await r.json().catch(() => null);
  } finally {
    clearTimeout(t);
  }
}

async function listActiveProfileNames() {
  const st = await httpJson(`http://127.0.0.1:${localPort}/api/status`, null, 30000);
  const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
  return perfis
    .filter((p) => p && p.active === true)
    .map((p) => String(p && p.nome || "").trim())
    .filter(Boolean);
}

async function clearAndTypeHandle(handle, value) {
  await handle.click({ clickCount: 3 });
  await handle.press("Backspace");
  await handle.type(String(value || ""), { delay: 28 });
}

async function isVisibleInputHandle(handle) {
  if (!handle) return false;
  try {
    return await handle.evaluate((el) => {
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== "none"
        && st.visibility !== "hidden"
        && r.width > 0
        && r.height > 0
        && !el.disabled
        && !el.readOnly;
    });
  } catch {
    return false;
  }
}

async function firstVisibleHandle(frameOrPage, selectors) {
  for (const sel of selectors) {
    let handles = [];
    try { handles = await frameOrPage.$$(sel); } catch { handles = []; }
    for (const h of handles) {
      if (await isVisibleInputHandle(h)) return h;
    }
  }
  return null;
}

async function getLoginInputHandles(page) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  const userSelectors = [
    "input[name*='user' i]",
    "input[id*='user' i]",
    "input[name*='login' i]",
    "input[id*='login' i]",
    "input[type='text']",
    "input[type='email']",
    "input[type='tel']",
    "input:not([type])"
  ];
  const passSelectors = [
    "input[type='password']",
    "input[name*='pass' i]",
    "input[id*='pass' i]",
    "input[name*='senha' i]",
    "input[id*='senha' i]"
  ];
  for (const frame of frames) {
    const userInput = await firstVisibleHandle(frame, userSelectors);
    const passInput = await firstVisibleHandle(frame, passSelectors);
    if (userInput && passInput) {
      return { frame, userInput, passInput };
    }
  }
  return { frame: page.mainFrame(), userInput: null, passInput: null };
}

async function clickLikelyButton(frameOrPage, regex) {
  return frameOrPage.evaluate((pattern) => {
    const rx = new RegExp(pattern, "i");
    const isVisible = (el) => {
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll("button,input[type='submit'],input[type='button'],a[role='button']"));
    const hit = nodes.find((el) => isVisible(el) && rx.test((el.innerText || el.value || "").trim()));
    if (!hit) return false;
    hit.click();
    return true;
  }, regex.source);
}

async function findRebootButton(page) {
  const byId = await page.$("#reboot_btn");
  if (byId) return byId;
  const nodes = await page.$$("button,input[type='submit'],input[type='button'],a[role='button']");
  for (const n of nodes) {
    const txt = await n.evaluate((el) => String(el.innerText || el.value || "").trim().toLowerCase());
    if (/reiniciar|reboot|restart|reset/.test(txt)) return n;
  }
  return null;
}

async function launchBrowserForAttempt({ showBrowser = false, timeline = null, flow = null }) {
  const executablePath = findChromeStable();
  const launchArgs = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--ignore-certificate-errors",
    "--lang=pt-BR",
    "--window-size=1366,768",
    "--start-maximized"
  ];
  const baseOptions = {
    defaultViewport: null,
    ignoreHTTPSErrors: true,
    args: launchArgs,
    protocolTimeout: 60000
  };
  if (executablePath) {
    baseOptions.executablePath = executablePath;
  }
  if (showBrowser) {
    try {
      const b = await withTimeout(
        puppeteer.launch({ ...baseOptions, headless: false }),
        BROWSER_LAUNCH_TIMEOUT_MS,
        "visible_browser_launch_timeout"
      );
      if (Array.isArray(timeline)) timeline.push({
        ts: now(),
        step: "browser_launch",
        mode: "visible",
        flow: flow && flow.name ? flow.name : null,
        executablePath: executablePath || "bundled"
      });
      return b;
    } catch (e) {
      if (Array.isArray(timeline)) {
        timeline.push({
          ts: now(),
          step: "browser_visible_launch_failed_fallback_headless",
          error: (e && e.message) ? String(e.message) : String(e),
          executablePathTried: executablePath || "bundled"
        });
      }
    }
  }
  const b = await withTimeout(
    puppeteer.launch({ ...baseOptions, headless: true }),
    BROWSER_LAUNCH_TIMEOUT_MS,
    "headless_browser_launch_timeout"
  );
  if (Array.isArray(timeline)) timeline.push({
    ts: now(),
    step: "browser_launch",
    mode: "headless",
    flow: flow && flow.name ? flow.name : null,
    executablePath: executablePath || "bundled"
  });
  return b;
}

async function runRebootAttempt({ flow, credential, cfg, timeline, showBrowser = false }) {
  const browser = await launchBrowserForAttempt({ showBrowser, timeline, flow });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  try {
    await page.bringToFront().catch(() => {});
    await page.goto(flow.loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(1000);
    const { frame, userInput, passInput } = await getLoginInputHandles(page);
    if (!userInput || !passInput) return { ok: false, error: "login_inputs_not_found" };
    await clearAndTypeHandle(userInput, credential.username);
    await clearAndTypeHandle(passInput, credential.password);
    const clickedLogin = await clickLikelyButton(frame || page, /(login|entrar|sign in|ok|acessar)/i);
    if (!clickedLogin) await passInput.press("Enter").catch(async () => { await page.keyboard.press("Enter").catch(() => {}); });
    await sleep(2200);
    await page.goto(flow.rebootUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(1200);
    const rebootBtn = await findRebootButton(page);
    if (!rebootBtn) return { ok: false, error: "reboot_button_not_found" };
    await rebootBtn.click();
    timeline.push({ ts: now(), step: "reboot_clicked", flow: flow.name });
    await sleep(350);

    const downStart = now();
    let downOk = false;
    while ((now() - downStart) < (cfg.maxWaitDownSec * 1000)) {
      const p = await httpProbe(flow.loginUrl, 3500);
      if (!p.ok) { downOk = true; break; }
      await sleep(cfg.pollSec * 1000);
    }
    if (!downOk) return { ok: false, error: "network_down_not_detected" };

    const upStart = now();
    let upOk = false;
    while ((now() - upStart) < (cfg.maxWaitUpSec * 1000)) {
      const p = await httpProbe(flow.loginUrl, 3500);
      if (p.ok) { upOk = true; break; }
      await sleep(cfg.pollSec * 1000);
    }
    if (!upOk) return { ok: false, error: "network_up_not_detected" };
    await sleep(cfg.postRotationStabilizeSec * 1000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  } finally {
    try { await browser.close(); } catch {}
  }
}

function getRotationConfig() {
  const cfg = serverConfig.readServerConfigEffective({});
  const n = (cfg && cfg.networkRotation) ? cfg.networkRotation : {};
  return {
    enabled: n.enabled === true,
    intervalMinMinutes: clamp(Number(n.intervalMinMinutes || 60) || 60, 10, 1440),
    intervalMaxMinutes: clamp(Number(n.intervalMaxMinutes || 120) || 120, 10, 1440),
    maxAttemptsPerCycle: clamp(Number(n.maxAttemptsPerCycle || 5) || 5, 1, 5),
    pauseBeforeRotationSec: clamp(Number(n.pauseBeforeRotationSec || 60) || 60, 5, 300),
    postRotationStabilizeSec: clamp(Number(n.postRotationStabilizeSec || 30) || 30, 5, 180),
    maxWaitDownSec: clamp(Number(n.maxWaitDownSec || 120) || 120, 10, 300),
    maxWaitUpSec: clamp(Number(n.maxWaitUpSec || 300) || 300, 20, 900),
    pollSec: clamp(Number(n.pollSec || 5) || 5, 2, 20)
  };
}

async function runCycle({ manualOptions = null } = {}) {
  const cfg = getRotationConfig();
  const cfgAll = serverConfig.readServerConfigEffective({});
  const cfgNet = (cfgAll && cfgAll.networkRotation) ? cfgAll.networkRotation : {};
  const t0 = now();
  const timeline = [{ ts: t0, step: "cycle_start" }];
  const gateway = await getDefaultGatewayIpv4();
  const flows = buildFlowCandidates(gateway).filter(isValidFlow);
  const baseCredentials = parseCredentialCandidates(cfgNet);
  const cached = state && state.credentialCache && state.credentialCache.username && state.credentialCache.password
    ? [{ username: state.credentialCache.username, password: state.credentialCache.password, source: "cache" }]
    : [];
  const credentials = [...cached, ...baseCredentials].filter((x, idx, arr) => {
    const k = `${x.username}::${x.password}`;
    return arr.findIndex((y) => `${y.username}::${y.password}` === k) === idx;
  });
  if (!flows.length) throw new Error("gateway_or_flow_not_found");
  if (!credentials.length) throw new Error("credential_candidates_not_found");

  saveState({
    inProgress: true,
    inProgressSince: now(),
    schedulerEnabled: cfg.enabled,
    activeGateway: gateway || null,
    lastError: null,
    attemptsLastCycle: 0,
    rebootDetectedLastCycle: false
  });

  let ipBefore = await getPublicIp();
  if (!ipBefore) {
    ipBefore = await refreshPublicIpSnapshot({ force: true });
  }
  let ipCurrent = ipBefore || state.currentPublicIp || null;
  let selectedFlow = null;
  let selectedCredential = null;
  let changed = false;
  let attempts = 0;
  let cycleError = null;
  let pauseResult = null;
  let resumeResult = null;
  let pausedNames = [];
  let shouldPauseRuntime = true;
  let rebootDetected = false;
  const manualShowBrowser = !!(manualOptions && manualOptions.showBrowser === true);
  logger.info("[NET-ROTATE] ciclo iniciado", {
    manual: manualShowBrowser,
    flowCandidates: flows.length,
    credentialCandidates: credentials.length,
    flowPreviewJson: JSON.stringify(flows.slice(0, 4).map((f) => ({
      name: f && f.name ? f.name : null,
      loginUrl: f && f.loginUrl ? f.loginUrl : null
    })))
  });

  try {
    const activeNames = await listActiveProfileNames().catch(() => []);
    shouldPauseRuntime = Array.isArray(activeNames) && activeNames.length > 0;
    if (shouldPauseRuntime) {
      pauseResult = await httpJson(`http://127.0.0.1:${localPort}/api/network-rotation/pause-runtime`, { reason: "network_rotation_cycle" });
      pausedNames = Array.isArray(pauseResult && pauseResult.pausedNames) ? pauseResult.pausedNames : [];
      timeline.push({
        ts: now(),
        step: "pause_runtime",
        ok: !!(pauseResult && pauseResult.ok === true),
        pausedCount: pausedNames.length
      });
      if (!pauseResult || pauseResult.ok !== true) {
        throw new Error((pauseResult && pauseResult.error) ? String(pauseResult.error) : "pause_runtime_failed");
      }
    } else {
      timeline.push({
        ts: now(),
        step: "pause_runtime_skipped_no_active_profiles",
        ok: true
      });
      pauseResult = { ok: true, pausedNames: [] };
      pausedNames = [];
    }
    await sleep(cfg.pauseBeforeRotationSec * 1000);

    for (let i = 0; i < cfg.maxAttemptsPerCycle; i += 1) {
      attempts += 1;
      const cred = credentials[i % credentials.length];
      const flow = flows[i % flows.length];
      selectedFlow = flow;
      selectedCredential = cred;
      timeline.push({
        ts: now(),
        step: "attempt_begin",
        attempt: attempts,
        flow: flow.name,
        credSource: cred.source || "unknown",
        showBrowser: manualShowBrowser
      });
      const rr = await runRebootAttempt({ flow, credential: cred, cfg, timeline, showBrowser: manualShowBrowser });
      if (!rr.ok) {
        timeline.push({ ts: now(), step: "attempt_fail", attempt: attempts, error: rr.error || "attempt_failed" });
        logger.warn("[NET-ROTATE] tentativa falhou", { attempt: attempts, flow: flow.name, error: rr.error || "attempt_failed" });
        continue;
      }
      rebootDetected = true;
      const ipAfter = await getPublicIp();
      timeline.push({ ts: now(), step: "attempt_ip_after", attempt: attempts, ipAfter: ipAfter || null });
      if (ipAfter && ipCurrent && ipAfter !== ipCurrent) {
        changed = true;
        ipCurrent = ipAfter;
        break;
      }
      if (ipAfter && !ipCurrent) {
        // Sem baseline confiável: considera sucesso operacional.
        ipCurrent = ipAfter;
        changed = true;
        break;
      }
      await sleep(2500);
    }

    if (!changed) {
      cycleError = rebootDetected ? "ip_not_changed_after_max_attempts" : "reboot_not_confirmed";
    }
  } catch (e) {
    cycleError = cycleError || ((e && e.message) ? String(e.message) : String(e));
    timeline.push({ ts: now(), step: "cycle_exception", error: cycleError });
    logger.warn("[NET-ROTATE] excecao durante ciclo", { error: cycleError });
  } finally {
    try {
      if (shouldPauseRuntime) {
        resumeResult = await httpJson(`http://127.0.0.1:${localPort}/api/network-rotation/resume-runtime`, { pausedNames });
        timeline.push({
          ts: now(),
          step: "resume_runtime",
          ok: !!(resumeResult && resumeResult.ok === true),
          resumed: Number(resumeResult && resumeResult.resumed || 0) || 0
        });
      } else {
        resumeResult = { ok: true, resumed: 0, resumedNames: [] };
        timeline.push({ ts: now(), step: "resume_runtime_skipped_no_active_profiles", ok: true });
      }
    } catch (e) {
      timeline.push({ ts: now(), step: "resume_runtime", ok: false, error: (e && e.message) ? e.message : String(e) });
    }
  }

  const nextDelay = pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes);
  const doneAt = now();
  const lastSummary = {
    startedAt: t0,
    finishedAt: doneAt,
    durationMs: doneAt - t0,
    attempts,
    rebootDetected,
    changed,
    ipBefore: ipBefore || null,
    ipAfter: ipCurrent || null,
    flow: selectedFlow ? selectedFlow.name : null,
    pausedCount: pausedNames.length,
    pauseOk: !!(pauseResult && pauseResult.ok === true),
    resumeOk: !!(resumeResult && resumeResult.ok === true),
    error: cycleError
  };

  const nextStatePatch = {
    inProgress: false,
    inProgressSince: 0,
    schedulerEnabled: cfg.enabled,
    lastRotationAt: t0,
    lastRotationFinishedAt: doneAt,
    lastRotationOk: changed,
    lastRotationSummary: lastSummary,
    attemptsLastCycle: attempts,
    rebootDetectedLastCycle: rebootDetected,
    previousPublicIp: state.currentPublicIp || ipBefore || null,
    currentPublicIp: ipCurrent || state.currentPublicIp || null,
    nextRotationAt: cfg.enabled ? (doneAt + nextDelay) : 0,
    manualTriggerPending: false,
    manualTriggerOptions: null,
    activeGateway: (selectedFlow && selectedFlow.gatewayHost) ? String(selectedFlow.gatewayHost) : (gateway || null),
    selectedFlow: selectedFlow ? {
      name: selectedFlow.name,
      loginUrl: selectedFlow.loginUrl,
      rebootUrl: selectedFlow.rebootUrl,
      gatewayHost: selectedFlow.gatewayHost || null
    } : null,
    lastPublicIpCheckAt: now(),
    lastError: cycleError || null
  };
  if (selectedCredential && changed) {
    nextStatePatch.credentialCache = {
      username: selectedCredential.username,
      password: selectedCredential.password,
      savedAt: doneAt
    };
  }
  saveState(nextStatePatch);
  logger.info("[NET-ROTATE] ciclo finalizado", {
    ok: changed,
    attempts,
    rebootDetected,
    error: cycleError || null
  });
  try {
    provisionAudit.append({
      ts: doneAt,
      event: "network_rotation_cycle",
      ok: changed,
      attempts,
      rebootDetected,
      ipBefore: ipBefore || null,
      ipAfter: ipCurrent || null,
      error: cycleError || null
    });
  } catch {}
  if (!changed) throw new Error(cycleError || "rotation_failed");
}

async function loopTick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const cfg = getRotationConfig();
    const st = state || loadState();
    try { await refreshPublicIpSnapshot({ force: false }); } catch {}
    recoverStaleInProgressState(st, { reason: "rotation_cycle_stale_recovered" });
    if (cfg.enabled !== !!st.schedulerEnabled) {
      const patch = { schedulerEnabled: cfg.enabled };
      if (cfg.enabled && !st.nextRotationAt) patch.nextRotationAt = now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes);
      if (!cfg.enabled) patch.nextRotationAt = 0;
      saveState(patch);
    }
    const cur0 = state || st;
    recoverStaleInProgressState(cur0, { reason: "rotation_cycle_stale_recovered" });
    const cur1 = state || st;
    if (cur1.inProgress) return;
    const manualPending = cur1.manualTriggerPending === true;
    if (!cfg.enabled && !manualPending) return;
    const cur = state || st;
    const nowTs = now();
    const maxFutureMs = (Math.max(1, Number(cfg.intervalMaxMinutes || 120)) * 60 * 1000) + (10 * 60 * 1000);
    const nextTs = Number(cur.nextRotationAt || 0) || 0;
    if (nextTs > 0 && ((nextTs - nowTs) > maxFutureMs)) {
      saveState({
        nextRotationAt: nowTs + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes),
        lastError: "next_rotation_out_of_range_rescheduled"
      });
      return;
    }
    if (!cur.nextRotationAt) {
      saveState({ nextRotationAt: now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes) });
      return;
    }
    if (now() < Number(cur.nextRotationAt || 0)) return;
    try {
      if (manualPending) {
        const manualOptions = (cur && cur.manualTriggerOptions && typeof cur.manualTriggerOptions === "object")
          ? { ...cur.manualTriggerOptions }
          : null;
        saveState({ manualTriggerPending: false, manualTriggerOptions: null });
        await withTimeout(runCycle({ manualOptions }), CYCLE_TIMEOUT_MS, "network_rotation_cycle_timeout");
      } else {
        await withTimeout(runCycle(), CYCLE_TIMEOUT_MS, "network_rotation_cycle_timeout");
      }
    } catch (e) {
      logger.warn("[NET-ROTATE] ciclo com falha", { error: (e && e.message) ? e.message : String(e) });
      try {
        saveState({
          inProgress: false,
          inProgressSince: 0,
          manualTriggerPending: false,
          manualTriggerOptions: null,
          lastError: (e && e.message) ? String(e.message) : String(e)
        });
      } catch {}
    }
  } finally {
    inFlight = false;
  }
}

function getStateSnapshot() {
  const st = state || loadState();
  const cfg = getRotationConfig();
  if (Number(st.schedulerEnabled === true) !== Number(cfg.enabled === true)) {
    saveState({ schedulerEnabled: cfg.enabled });
  }
  const stAligned = state || st;
  const manualPendingStale =
    stAligned.manualTriggerPending === true
    && stAligned.inProgress !== true
    && (now() - Number(stAligned.updatedAt || 0)) > (2 * 60 * 1000);
  if (manualPendingStale) {
    saveState({
      manualTriggerPending: false,
      manualTriggerOptions: null,
      lastError: "manual_trigger_pending_stale_cleared_in_snapshot"
    });
  }
  const stAfterPending = state || stAligned;
  const safeNextRotationAt = sanitizeNextRotationAt(stAfterPending, cfg);
  if (safeNextRotationAt !== Number(stAfterPending.nextRotationAt || 0)) {
    saveState({
      nextRotationAt: safeNextRotationAt || (cfg.enabled ? (now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes)) : 0),
      lastError: "next_rotation_sanitized_for_dashboard"
    });
  }
  const cur = state || stAfterPending;
  const out = { ...cur };
  out.intervalMinMinutes = cfg.intervalMinMinutes;
  out.intervalMaxMinutes = cfg.intervalMaxMinutes;
  if (out.credentialCache) {
    out.credentialCache = {
      username: out.credentialCache.username || null,
      passwordMasked: out.credentialCache.password ? "***" : null,
      savedAt: out.credentialCache.savedAt || null
    };
  }
  out.countdownSec = out.nextRotationAt ? Math.max(0, Math.ceil((Number(out.nextRotationAt) - now()) / 1000)) : null;
  const maxCountdownSec = ((Math.max(10, Number(cfg.intervalMaxMinutes || 120)) + 10) * 60);
  if (cfg.enabled === true && Number.isFinite(Number(out.countdownSec || 0)) && Number(out.countdownSec || 0) > maxCountdownSec) {
    const repairedNextAt = now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes);
    saveState({
      nextRotationAt: repairedNextAt,
      lastError: "next_rotation_out_of_range_repaired_in_snapshot"
    });
    out.nextRotationAt = repairedNextAt;
    out.countdownSec = Math.max(0, Math.ceil((repairedNextAt - now()) / 1000));
  }
  const zeroStuck =
    cfg.enabled === true
    && out.inProgress !== true
    && out.manualTriggerPending !== true
    && Number(out.countdownSec || 0) <= 0;
  if (zeroStuck) {
    const repairedNextAt = now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes);
    saveState({
      nextRotationAt: repairedNextAt,
      lastError: "next_rotation_zero_stuck_repaired_in_snapshot"
    });
    out.nextRotationAt = repairedNextAt;
    out.countdownSec = Math.max(0, Math.ceil((repairedNextAt - now()) / 1000));
  }
  return out;
}

async function triggerNow(reason = "manual_trigger", options = null) {
  recoverStaleInProgressState(state || loadState(), { reason: "manual_trigger_stale_recovered" });
  saveState({
    nextRotationAt: now(),
    manualTriggerPending: true,
    triggerReason: String(reason || "").slice(0, 120),
    manualTriggerOptions: {
      showBrowser: !!(options && options.showBrowser === true)
    }
  });
  logger.info("[NET-ROTATE] trigger manual recebido", {
    reason: String(reason || "").slice(0, 120),
    showBrowser: !!(options && options.showBrowser === true)
  });
  return { ok: true };
}

function startNetworkRotationScheduler({ port } = {}) {
  localPort = Number(port || localPort || 8088) || 8088;
  state = loadState();
  if (state && state.selectedFlow && !isValidFlow(state.selectedFlow)) {
    saveState({
      selectedFlow: null,
      activeGateway: null,
      lastError: "invalid_cached_flow_cleared_on_boot"
    });
  }
  // Reinício do processo deve sempre limpar estados transitórios para evitar UI presa em "rotacionando...".
  if (state && (state.inProgress === true || state.manualTriggerPending === true)) {
    saveState({
      inProgress: false,
      inProgressSince: 0,
      manualTriggerPending: false,
      manualTriggerOptions: null,
      lastError: state.inProgress === true ? "boot_cleared_stale_inprogress" : state.lastError || null
    });
    try {
      provisionAudit.append({
        ts: now(),
        event: "network_rotation_boot_state_cleared",
        ok: true,
        hadInProgress: !!state.inProgress,
        hadManualPending: !!state.manualTriggerPending
      });
    } catch {}
  }
  recoverStaleInProgressState(state, { reason: "boot_stale_recovered" });
  try {
    const cfg = getRotationConfig();
    const safeNextAt = sanitizeNextRotationAt(state || loadState(), cfg);
    if (safeNextAt !== Number((state && state.nextRotationAt) || 0)) {
      saveState({
        nextRotationAt: safeNextAt || (cfg.enabled ? (now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes)) : 0),
        lastError: "next_rotation_sanitized_on_boot"
      });
    }
    if (cfg && cfg.enabled === true) {
      // Regra operacional: após restart, sempre agenda próximo ciclo para frente (não executa "ciclo atrasado" herdado).
      saveState({
        nextRotationAt: now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes),
        inProgress: false,
        inProgressSince: 0,
        manualTriggerPending: false,
        manualTriggerOptions: null
      });
      try {
        provisionAudit.append({
          ts: now(),
          event: "network_rotation_boot_rescheduled",
          ok: true
        });
      } catch {}
    }
  } catch {}
  if (timer) return;
  timer = setInterval(() => { loopTick().catch(() => {}); }, LOOP_MS);
  try { if (typeof timer.unref === "function") timer.unref(); } catch {}
  loopTick().catch(() => {});
}

function stopNetworkRotationScheduler() {
  if (!timer) return;
  try { clearInterval(timer); } catch {}
  timer = null;
}

module.exports = {
  startNetworkRotationScheduler,
  stopNetworkRotationScheduler,
  getStateSnapshot,
  triggerNow
};

