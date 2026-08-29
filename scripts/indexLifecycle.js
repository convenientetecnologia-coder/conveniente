"use strict";

/**
 * Caixa-preta do processo (index e worker).
 * Grava boot/saída/exception em disco. Não altera frota, janela, pedido, Robe.
 * taskkill /F e crash nativo podem NÃO passar aqui — aí vale o Event Viewer.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const DADOS = path.join(__dirname, "..", "dados");
const LIFE_PATH = path.join(DADOS, "index_lifecycle.jsonl");
const HEART_PATH = path.join(DADOS, "index_heartbeat.json");
const MAX_LIFE_BYTES = 2 * 1024 * 1024;

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

function rotateIfHuge() {
  try {
    const st = fs.statSync(LIFE_PATH);
    if (!st || st.size < MAX_LIFE_BYTES) return;
    const bak = path.join(DADOS, "index_lifecycle.prev.jsonl");
    try { fs.unlinkSync(bak); } catch {}
    fs.renameSync(LIFE_PATH, bak);
  } catch {}
}

function append(event, patch) {
  try {
    ensureDir();
    rotateIfHuge();
    const mem = process.memoryUsage();
    const row = {
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
    fs.appendFileSync(LIFE_PATH, JSON.stringify(row) + "\n", "utf8");
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
      totalMB: Math.round(os.totalmem() / 1048576)
    });
    fs.writeFileSync(HEART_PATH, body, "utf8");
  } catch {}
}

function install(opts) {
  if (installed) return { ok: true, already: true };
  installed = true;
  role = clip((opts && opts.role) || "index", 24) || "index";
  extra = (opts && opts.extra && typeof opts.extra === "object") ? opts.extra : {};

  append("boot", { cwd: clip(process.cwd(), 200) });
  writeHeartbeat();

  const onFatal = (event) => (err) => {
    append(event, {
      error: clip(err && err.message ? err.message : err, 240),
      stack: clip(err && err.stack, 800)
    });
  };
  process.on("uncaughtException", onFatal("uncaughtException"));
  process.on("unhandledRejection", (reason) => {
    append("unhandledRejection", {
      error: clip(reason && reason.message ? reason.message : reason, 240),
      stack: clip(reason && reason.stack, 800)
    });
  });
  process.on("exit", (code) => {
    append("exit", { code: Number(code) || 0 });
  });
  // SIGINT/SIGTERM: so grava. O index/worker ja tem shutdown proprio.
  // SIGBREAK/SIGHUP: se so escutar e nao sair, o Node deixa de encerrar no fechar do CMD.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    try {
      process.on(sig, () => {
        append("signal", { signal: sig });
      });
    } catch {}
  }
  for (const sig of ["SIGBREAK", "SIGHUP"]) {
    try {
      process.on(sig, () => {
        append("signal", { signal: sig });
        setImmediate(() => {
          try { process.exit(1); } catch {}
        });
      });
    } catch {}
  }

  if (role === "index") {
    heartTimer = setInterval(() => { writeHeartbeat(); }, 20000);
    try { heartTimer.unref(); } catch {}
  }

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

module.exports = {
  install,
  append,
  readTail,
  readHeartbeat,
  LIFE_PATH,
  HEART_PATH
};
