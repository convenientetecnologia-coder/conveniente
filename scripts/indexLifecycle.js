"use strict";

/**
 * Caixa-preta do processo (index e worker).
 * Grava boot/saída/exception/sinal em disco. handle_pulse vai para
 * index_handle_pulse.jsonl (nao infla a caixa-preta de morte).
 * Não altera frota, janela, pedido, Robe.
 * SIGHUP/SIGBREAK (RDP/console) NÃO dão process.exit — pai e worker permanecem.
 * taskkill /F e crash nativo podem NÃO passar aqui — aí vale o Event Viewer.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DADOS = (function resolveDados() {
  const env = String(process.env.CONVENIENTE_DADOS_DIR || "").trim();
  return env ? path.resolve(env) : path.join(__dirname, "..", "dados");
})();
const LIFE_PATH = path.join(DADOS, "index_lifecycle.jsonl");
const LIFE_PREV_PATH = path.join(DADOS, "index_lifecycle.prev.jsonl");
const PULSE_PATH = path.join(DADOS, "index_handle_pulse.jsonl");
const PULSE_PREV_PATH = path.join(DADOS, "index_handle_pulse.prev.jsonl");
const HEART_PATH = path.join(DADOS, "index_heartbeat.json");
const BOOT_CTX_PATH = path.join(DADOS, "index_boot_context.json");
const DESIRED_PATH = path.join(DADOS, "desired.json");
const ARCH_DIR = path.join(DADOS, "logs");
const MAX_LIFE_BYTES = 2 * 1024 * 1024;
const MAX_PULSE_BYTES = 2 * 1024 * 1024;
const KEEP_ARCH = 40;

let installed = false;
let role = "index";
let extra = {};
let heartTimer = null;

function ensureDir() {
  try { fs.mkdirSync(DADOS, { recursive: true }); } catch {}
}

function clip(v, n) {
  const s = v == null ? "" : String(v);
  return s.length <= n ? s : s.slice(0, n);
}

function archiveStamp() {
  const ts = new Date();
  return (
    String(ts.getFullYear()) +
    String(ts.getMonth() + 1).padStart(2, "0") +
    String(ts.getDate()).padStart(2, "0") + "-" +
    String(ts.getHours()).padStart(2, "0") +
    String(ts.getMinutes()).padStart(2, "0") +
    String(ts.getSeconds()).padStart(2, "0")
  );
}

function pruneArchives(prefix) {
  try {
    if (!fs.existsSync(ARCH_DIR)) return;
    const re = new RegExp(
      "^" + String(prefix || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.\\d{8}-\\d{6}\\.jsonl$"
    );
    const hits = fs.readdirSync(ARCH_DIR)
      .filter((n) => re.test(String(n || "")))
      .map((name) => {
        const full = path.join(ARCH_DIR, name);
        let mtimeMs = 0;
        try { mtimeMs = Number(fs.statSync(full).mtimeMs || 0) || 0; } catch {}
        return { name, full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const row of hits.slice(KEEP_ARCH)) {
      try { fs.unlinkSync(row.full); } catch {}
    }
  } catch {}
}

function archiveBeforeOverwrite(prevPath, prefix) {
  try {
    if (!prevPath || !fs.existsSync(prevPath)) return;
    try { fs.mkdirSync(ARCH_DIR, { recursive: true }); } catch {}
    const dest = path.join(ARCH_DIR, `${prefix}.${archiveStamp()}.jsonl`);
    try {
      fs.renameSync(prevPath, dest);
    } catch {
      try { fs.copyFileSync(prevPath, dest); } catch {}
      try { fs.unlinkSync(prevPath); } catch {}
    }
    pruneArchives(prefix);
  } catch {}
}

function rotateIfHuge(filePath, prevPath, prefix, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const cap = Math.max(64 * 1024, Number(maxBytes || MAX_LIFE_BYTES) || MAX_LIFE_BYTES);
    if (!st || st.size < cap) return;
    archiveBeforeOverwrite(prevPath, prefix);
    try { fs.unlinkSync(prevPath); } catch {}
    fs.renameSync(filePath, prevPath);
  } catch {}
}

function readFleetSnap() {
  try {
    if (!fs.existsSync(DESIRED_PATH)) return null;
    const j = JSON.parse(fs.readFileSync(DESIRED_PATH, "utf8"));
    const perf = (j && j.perfis && typeof j.perfis === "object") ? j.perfis : {};
    const keys = Object.keys(perf);
    let active = 0;
    let virtusOn = 0;
    for (const k of keys) {
      const row = perf[k];
      if (row && row.active === true) active += 1;
      if (row && String(row.virtus || "").toLowerCase() === "on") virtusOn += 1;
    }
    return {
      n: keys.length,
      active,
      virtusOn,
      startClosed: !!j._bootStartClosed,
      openAllBy: j._openAll && j._openAll.by ? String(j._openAll.by) : null
    };
  } catch {
    return null;
  }
}

function buildRow(event, patch) {
  const mem = process.memoryUsage();
  return {
    ts: Date.now(),
    iso: new Date().toISOString(),
    event: clip(event, 48),
    role,
    pid: process.pid,
    ppid: process.ppid || null,
    node: process.version,
    hostname: os.hostname(),
    uptimeSec: Math.round(process.uptime()),
    rssMB: Math.round((mem.rss || 0) / 1048576),
    heapMB: Math.round((mem.heapUsed || 0) / 1048576),
    argv0: clip(process.argv && process.argv[0], 160),
    title: clip(process.title, 80),
    ...extra,
    ...(patch && typeof patch === "object" ? patch : {})
  };
}

function appendTo(filePath, prevPath, prefix, maxBytes, event, patch) {
  ensureDir();
  rotateIfHuge(filePath, prevPath, prefix, maxBytes);
  fs.appendFileSync(filePath, JSON.stringify(buildRow(event, patch)) + "\n", "utf8");
}

function append(event, patch) {
  try {
    appendTo(LIFE_PATH, LIFE_PREV_PATH, "index_lifecycle", MAX_LIFE_BYTES, event, patch);
  } catch {}
}

function appendPulse(event, patch) {
  try {
    appendTo(PULSE_PATH, PULSE_PREV_PATH, "index_handle_pulse", MAX_PULSE_BYTES, event || "handle_pulse", patch);
  } catch {}
}

function writeHeartbeat() {
  try {
    ensureDir();
    const mem = process.memoryUsage();
    const body = JSON.stringify({
      ts: Date.now(),
      iso: new Date().toISOString(),
      role,
      pid: process.pid,
      ppid: process.ppid || null,
      uptimeSec: Math.round(process.uptime()),
      rssMB: Math.round((mem.rss || 0) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
      totalMB: Math.round(os.totalmem() / 1048576),
      fleet: readFleetSnap()
    });
    fs.writeFileSync(HEART_PATH, body, "utf8");
  } catch {}
}

function writeBootContext() {
  if (role !== "index") return;
  try {
    ensureDir();
    const ctx = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      hostname: os.hostname(),
      pid: process.pid,
      ppid: process.ppid || null,
      node: process.version,
      cwd: clip(process.cwd(), 200),
      argv: (process.argv || []).map((x) => clip(x, 160)),
      title: clip(process.title, 80),
      execPath: clip(process.execPath, 200),
      fleet: readFleetSnap()
    };
    fs.writeFileSync(BOOT_CTX_PATH, JSON.stringify(ctx, null, 2), "utf8");
  } catch {}
}

function isConsoleSessionSignal(sig) {
  const s = String(sig || "");
  return s === "SIGHUP" || s === "SIGBREAK";
}

function handleConsoleSessionSignal(sig) {
  const name = String(sig || "SIGHUP");
  try {
    append("signal", {
      signal: name,
      fleet: readFleetSnap(),
      shielded: true,
      keepAlive: true
    });
  } catch {}
  try {
    const now = Date.now();
    const last = Number(handleConsoleSessionSignal._lastLogAt || 0) || 0;
    if (!last || (now - last) >= 5000) {
      handleConsoleSessionSignal._lastLogAt = now;
      console.log("[OXY-LOG] [SIGHUP-SHIELD] Sinal RDP detectado. Console pai mantido ativo.");
    }
  } catch {}
  return { keptAlive: true, exited: false, signal: name };
}

function install(opts) {
  if (installed) return { ok: true, already: true };
  installed = true;
  role = clip((opts && opts.role) || "index", 24) || "index";
  extra = (opts && opts.extra && typeof opts.extra === "object") ? opts.extra : {};

  append("boot", { cwd: clip(process.cwd(), 200), fleet: readFleetSnap() });
  writeHeartbeat();
  writeBootContext();

  const onFatal = (event) => (err) => {
    append(event, {
      error: clip(err && err.message ? err.message : err, 240),
      stack: clip(err && err.stack, 800),
      fleet: readFleetSnap()
    });
  };
  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", (reason) => {
    append("unhandledRejection", {
      error: clip(reason && reason.message ? reason.message : reason, 240),
      stack: clip(reason && reason.stack, 800),
      fleet: readFleetSnap()
    });
  });
  process.on("exit", (code) => {
    append("exit", { code: Number(code) || 0, fleet: readFleetSnap() });
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    try {
      process.on(sig, () => {
        append("signal", { signal: sig, fleet: readFleetSnap() });
      });
    } catch {}
  }
  for (const sig of ["SIGBREAK", "SIGHUP"]) {
    try {
      process.on(sig, () => {
        handleConsoleSessionSignal(sig);
      });
    } catch {}
  }
  try {
    const cur = typeof process.getMaxListeners === "function" ? Number(process.getMaxListeners()) : 10;
    if (Number.isFinite(cur) && cur !== 0 && cur < 32) process.setMaxListeners(32);
  } catch {}

  if (role === "index") {
    heartTimer = setInterval(() => { writeHeartbeat(); }, 20000);
    try { heartTimer.unref(); } catch {}
  }

  try {
    require("./winHandlePulse.js").install({
      role,
      append: appendPulse,
      intervalMs: 5 * 60 * 1000,
      firstDelayMs: 45 * 1000
    });
  } catch {}

  return { ok: true, path: LIFE_PATH };
}

function readTail(maxLines) {
  const n = Math.max(5, Math.min(200, Number(maxLines || 40) || 40));
  try {
    if (!fs.existsSync(LIFE_PATH)) return [];
    const raw = fs.readFileSync(LIFE_PATH, "utf8");
    const lines = raw.split(/\n/).filter(Boolean);
    return lines.slice(-n).map((line) => {
      try { return JSON.parse(line); } catch { return { raw: clip(line, 300) }; }
    });
  } catch {
    return [];
  }
}

function readHeartbeat() {
  try {
    if (!fs.existsSync(HEART_PATH)) return null;
    return JSON.parse(fs.readFileSync(HEART_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readBootContext() {
  try {
    if (!fs.existsSync(BOOT_CTX_PATH)) return null;
    return JSON.parse(fs.readFileSync(BOOT_CTX_PATH, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  install,
  append,
  appendPulse,
  readTail,
  readHeartbeat,
  readBootContext,
  isConsoleSessionSignal,
  handleConsoleSessionSignal,
  LIFE_PATH,
  LIFE_PREV_PATH,
  PULSE_PATH,
  PULSE_PREV_PATH,
  HEART_PATH,
  BOOT_CTX_PATH,
  MAX_LIFE_BYTES,
  MAX_PULSE_BYTES
};
