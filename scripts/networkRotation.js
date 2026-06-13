"use strict";

const fs = require("fs");
const path = require("path");
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
    currentPublicIp: null,
    previousPublicIp: null,
    attemptsLastCycle: 0,
    rebootDetectedLastCycle: false,
    activeGateway: null,
    selectedFlow: null,
    manualTriggerPending: false,
    credentialCache: null, // { username, password, savedAt }
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
  return out;
}

async function getDefaultGatewayIpv4() {
  try {
    const { stdout } = await execAsync("route print -4");
    const line = String(stdout || "")
      .split(/\r?\n/)
      .find((l) => /\b0\.0\.0\.0\b/.test(l) && /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(l));
    if (!line) return null;
    const ips = line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
    return ips.length >= 2 ? ips[1] : null;
  } catch {
    return null;
  }
}

function buildFlowCandidates(gatewayIp) {
  const cfg = serverConfig.readServerConfigEffective({});
  const nr = (cfg && cfg.networkRotation) ? cfg.networkRotation : {};
  const gw = String(gatewayIp || nr.gatewayHost || "").trim();
  const out = [];
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
  return out;
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

async function clearAndTypeHandle(handle, value) {
  await handle.click({ clickCount: 3 });
  await handle.press("Backspace");
  await handle.type(String(value || ""), { delay: 28 });
}

async function getLoginInputHandles(page) {
  const inputs = await page.$$("input");
  const visible = [];
  for (const h of inputs) {
    const m = await h.evaluate((el) => {
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        visible: st.display !== "none" && st.visibility !== "hidden" && r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly,
        type: (el.getAttribute("type") || "text").toLowerCase()
      };
    });
    if (m.visible) visible.push({ handle: h, type: m.type });
  }
  const pass = visible.find((x) => x.type === "password") || null;
  const user = visible.find((x) => ["text", "email", "tel", ""].includes(x.type)) || null;
  return { userInput: user ? user.handle : null, passInput: pass ? pass.handle : null };
}

async function clickLikelyButton(page, regex) {
  return page.evaluate((pattern) => {
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

async function runRebootAttempt({ flow, credential, cfg, timeline }) {
  const browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    args: ["--ignore-certificate-errors"]
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(20000);
  try {
    await page.goto(flow.loginUrl, { waitUntil: "domcontentloaded" });
    await sleep(1000);
    const { userInput, passInput } = await getLoginInputHandles(page);
    if (!userInput || !passInput) return { ok: false, error: "login_inputs_not_found" };
    await clearAndTypeHandle(userInput, credential.username);
    await clearAndTypeHandle(passInput, credential.password);
    const clickedLogin = await clickLikelyButton(page, /(login|entrar|sign in|ok)/i);
    if (!clickedLogin) await page.keyboard.press("Enter");
    await sleep(2200);
    await page.goto(flow.rebootUrl, { waitUntil: "domcontentloaded" });
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

async function runCycle() {
  const cfg = getRotationConfig();
  const cfgAll = serverConfig.readServerConfigEffective({});
  const cfgNet = (cfgAll && cfgAll.networkRotation) ? cfgAll.networkRotation : {};
  const t0 = now();
  const timeline = [{ ts: t0, step: "cycle_start" }];
  const gateway = await getDefaultGatewayIpv4();
  const flows = buildFlowCandidates(gateway);
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
    schedulerEnabled: cfg.enabled,
    activeGateway: gateway || null,
    lastError: null,
    attemptsLastCycle: 0,
    rebootDetectedLastCycle: false
  });

  let ipBefore = await getPublicIp();
  let ipCurrent = ipBefore || state.currentPublicIp || null;
  let selectedFlow = null;
  let selectedCredential = null;
  let changed = false;
  let attempts = 0;
  let cycleError = null;
  let pauseResult = null;
  let resumeResult = null;
  let pausedNames = [];
  let rebootDetected = false;

  try {
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
    await sleep(cfg.pauseBeforeRotationSec * 1000);

    for (let i = 0; i < cfg.maxAttemptsPerCycle; i += 1) {
      attempts += 1;
      const cred = credentials[i % credentials.length];
      const flow = flows[i % flows.length];
      selectedFlow = flow;
      selectedCredential = cred;
      timeline.push({ ts: now(), step: "attempt_begin", attempt: attempts, flow: flow.name, credSource: cred.source || "unknown" });
      const rr = await runRebootAttempt({ flow, credential: cred, cfg, timeline });
      if (!rr.ok) {
        timeline.push({ ts: now(), step: "attempt_fail", attempt: attempts, error: rr.error || "attempt_failed" });
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
  } finally {
    try {
      resumeResult = await httpJson(`http://127.0.0.1:${localPort}/api/network-rotation/resume-runtime`, { pausedNames });
      timeline.push({
        ts: now(),
        step: "resume_runtime",
        ok: !!(resumeResult && resumeResult.ok === true),
        resumed: Number(resumeResult && resumeResult.resumed || 0) || 0
      });
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
    selectedFlow: selectedFlow ? { name: selectedFlow.name, loginUrl: selectedFlow.loginUrl, rebootUrl: selectedFlow.rebootUrl } : null,
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
    if (cfg.enabled !== !!st.schedulerEnabled) {
      const patch = { schedulerEnabled: cfg.enabled };
      if (cfg.enabled && !st.nextRotationAt) patch.nextRotationAt = now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes);
      if (!cfg.enabled) patch.nextRotationAt = 0;
      saveState(patch);
    }
    const cur0 = state || st;
    const manualPending = cur0.manualTriggerPending === true;
    if (!cfg.enabled && !manualPending) return;
    const cur = state || st;
    if (!cur.nextRotationAt) {
      saveState({ nextRotationAt: now() + pickRandomDelayMs(cfg.intervalMinMinutes, cfg.intervalMaxMinutes) });
      return;
    }
    if (cur.inProgress) return;
    if (now() < Number(cur.nextRotationAt || 0)) return;
    try {
      if (manualPending) {
        saveState({ manualTriggerPending: false });
        await runCycle();
      } else {
        await runCycle();
      }
    } catch (e) {
      logger.warn("[NET-ROTATE] ciclo com falha", { error: (e && e.message) ? e.message : String(e) });
    }
  } finally {
    inFlight = false;
  }
}

function getStateSnapshot() {
  const st = state || loadState();
  const out = { ...st };
  if (out.credentialCache) {
    out.credentialCache = {
      username: out.credentialCache.username || null,
      passwordMasked: out.credentialCache.password ? "***" : null,
      savedAt: out.credentialCache.savedAt || null
    };
  }
  out.countdownSec = out.nextRotationAt ? Math.max(0, Math.ceil((Number(out.nextRotationAt) - now()) / 1000)) : null;
  return out;
}

async function triggerNow(reason = "manual_trigger") {
  saveState({
    nextRotationAt: now(),
    manualTriggerPending: true,
    triggerReason: String(reason || "").slice(0, 120)
  });
  return { ok: true };
}

function startNetworkRotationScheduler({ port } = {}) {
  localPort = Number(port || localPort || 8088) || 8088;
  state = loadState();
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

