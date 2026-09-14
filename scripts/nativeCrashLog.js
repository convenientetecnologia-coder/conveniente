"use strict";

/**
 * Olho nativo em disco. Nao segura JSONL na RAM.
 * Rename/stat/tail de poucos KB. Nao le arquivo gigante.
 */

const fs = require("fs");
const path = require("path");

const DADOS = (function resolveDados() {
  const env = String(process.env.CONVENIENTE_DADOS_DIR || "").trim();
  return env ? path.resolve(env) : path.join(__dirname, "..", "dados");
})();
const LOGS = path.join(DADOS, "logs");
const REPORT_DIR = path.join(DADOS, "forensic_node_reports");
const INDEX_JSON = path.join(DADOS, "forensic_node_reports_index.json");

const NATIVE_MAX_BYTES = 8 * 1024 * 1024;
const HUGE_JSONL_BYTES = 64 * 1024 * 1024;
const TAIL_BYTES = 6 * 1024;
const HUGE_KEEP = 2;

function decodeExitCode(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return { code: null, hex: null, name: null };
  const u = n >>> 0;
  const hex = "0x" + u.toString(16).toUpperCase();
  let name = "OTHER";
  if (u === 0xc0000409) name = "FASTFAIL";
  else if (u === 0xc0000374) name = "HEAP_CORRUPT";
  else if (u === 0xc000012d) name = "COMMIT_LIMIT";
  else if (u === 0xc00000fd) name = "STACK_OVERFLOW";
  else if (u === 0x80000003) name = "WAIT_ABANDONED";
  else if (n === 134 || u === 0x86) name = "ABORT";
  else if (n === 0 || u === 0) name = "OK";
  return { code: n, hex, name };
}

function ensureLogsDir() {
  try { fs.mkdirSync(LOGS, { recursive: true }); } catch {}
}

function stamp() {
  const ts = new Date();
  return (
    String(ts.getFullYear()) +
    String(ts.getMonth() + 1).padStart(2, "0") +
    String(ts.getDate()).padStart(2, "0") +
    "-" +
    String(ts.getHours()).padStart(2, "0") +
    String(ts.getMinutes()).padStart(2, "0") +
    String(ts.getSeconds()).padStart(2, "0")
  );
}

function clip(s, n) {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : t.slice(0, n);
}

function indexNativeLogPath() {
  return path.join(LOGS, "crash_nativo_index.log");
}
function indexNativePrevPath() {
  return path.join(LOGS, "crash_nativo_index.prev.log");
}
function indexNativeOutPath() {
  return path.join(LOGS, "crash_nativo_index.out.log");
}
function cellNativeLogPath(idx1) {
  const n = Math.max(1, Math.min(32, Number(idx1) || 1));
  return path.join(LOGS, "cell_" + n + "_native.log");
}

function rotateIfHuge(filePath, maxBytes) {
  const cap = Math.max(64 * 1024, Number(maxBytes || NATIVE_MAX_BYTES) || NATIVE_MAX_BYTES);
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: "missing" };
    const st = fs.statSync(filePath);
    if (!st || st.size < cap) return { ok: true, skipped: true, bytes: Number(st && st.size) || 0 };
    ensureLogsDir();
    const dest = path.join(LOGS, path.basename(filePath) + "." + stamp());
    fs.renameSync(filePath, dest);
    return { ok: true, rotated: true, bytes: st.size, dest };
  } catch (e) {
    return { ok: false, error: clip(e && e.message || e, 180) };
  }
}

function prunePrefix(dir, prefix, keep) {
  try {
    if (!fs.existsSync(dir)) return;
    const re = new RegExp(
      "^" + String(prefix || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.\\d{8}-\\d{6}"
    );
    const hits = fs.readdirSync(dir)
      .filter((n) => re.test(String(n || "")))
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = Number(fs.statSync(full).mtimeMs || 0) || 0; } catch {}
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const k = Math.max(1, Number(keep || HUGE_KEEP) || HUGE_KEEP);
    for (const row of hits.slice(k)) {
      try { fs.unlinkSync(row.full); } catch {}
    }
  } catch {}
}

function tailFileBytes(filePath, maxBytes) {
  const cap = Math.max(256, Math.min(32 * 1024, Number(maxBytes || TAIL_BYTES) || TAIL_BYTES));
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const st = fs.statSync(filePath);
    const size = Number(st && st.size || 0) || 0;
    if (!size) return "";
    const start = Math.max(0, size - cap);
    const toRead = Math.max(0, size - start);
    if (!toRead) return "";
    const buf = Buffer.allocUnsafe(toRead);
    const fd = fs.openSync(filePath, "r");
    try { fs.readSync(fd, buf, 0, toRead, start); }
    finally { try { fs.closeSync(fd); } catch {} }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function headFileBytes(filePath, maxBytes) {
  const cap = Math.max(256, Math.min(128 * 1024, Number(maxBytes || 64 * 1024) || 64 * 1024));
  try {
    if (!filePath || !fs.existsSync(filePath)) return "";
    const st = fs.statSync(filePath);
    const size = Number(st && st.size || 0) || 0;
    if (!size) return "";
    const toRead = Math.min(cap, size);
    const buf = Buffer.allocUnsafe(toRead);
    const fd = fs.openSync(filePath, "r");
    try { fs.readSync(fd, buf, 0, toRead, 0); }
    finally { try { fs.closeSync(fd); } catch {} }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function summarizeReport(full) {
  const raw = headFileBytes(full, 64 * 1024);
  const pick = (re) => {
    const m = raw.match(re);
    return m && m[1] ? clip(m[1], 240) : null;
  };
  const num = (re) => {
    const m = raw.match(re);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  const used = num(/"usedHeapSize"\s*:\s*(\d+)/);
  const total = num(/"totalHeapSize"\s*:\s*(\d+)/);
  const limit = num(/"heapSizeLimit"\s*:\s*(\d+)/);
  return {
    trigger: pick(/"trigger"\s*:\s*"([^"]+)"/),
    event: pick(/"event"\s*:\s*"([^"]+)"/),
    heap: (used != null || total != null || limit != null)
      ? {
        usedMB: used != null ? Math.round(used / 1048576) : null,
        totalMB: total != null ? Math.round(total / 1048576) : null,
        limitMB: limit != null ? Math.round(limit / 1048576) : null
      }
      : null,
    head: clip(raw.replace(/\s+/g, " ").trim(), 900)
  };
}

function openCellNativeFd(idx1) {
  ensureLogsDir();
  const fp = cellNativeLogPath(idx1);
  rotateIfHuge(fp, NATIVE_MAX_BYTES);
  const fd = fs.openSync(fp, "a");
  return { fd, path: fp };
}

function listRecentReports(maxN) {
  const cap = Math.max(1, Math.min(20, Number(maxN || 8) || 8));
  try {
    if (!fs.existsSync(REPORT_DIR)) return [];
    return fs.readdirSync(REPORT_DIR)
      .filter((name) => /^report\..+\.json$/i.test(String(name || "")))
      .map((name) => {
        const full = path.join(REPORT_DIR, name);
        let mtimeMs = 0;
        let bytes = 0;
        try {
          const st = fs.statSync(full);
          mtimeMs = Number(st.mtimeMs || 0) || 0;
          bytes = Number(st.size || 0) || 0;
        } catch {}
        const pidM = String(name).match(/\.(\d+)\.\d+\.\d+\.json$/i);
        return {
          name,
          full,
          bytes,
          mtimeMs,
          pid: pidM ? Number(pidM[1]) : null
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, cap);
  } catch {
    return [];
  }
}

function writeReportsIndex() {
  try {
    ensureLogsDir();
    try { fs.mkdirSync(REPORT_DIR, { recursive: true }); } catch {}
    const items = listRecentReports(8).map((it) => {
      let sum = null;
      try { sum = summarizeReport(it.full); } catch {}
      return {
        name: it.name,
        bytes: it.bytes,
        mtimeMs: it.mtimeMs,
        pid: it.pid,
        trigger: sum && sum.trigger || null,
        event: sum && sum.event || null,
        heap: sum && sum.heap || null,
        head: sum && sum.head || null
      };
    });
    fs.writeFileSync(INDEX_JSON, JSON.stringify({
      ts: Date.now(),
      iso: new Date().toISOString(),
      dir: REPORT_DIR,
      items
    }) + "\n", "utf8");
    return { ok: true, n: items.length };
  } catch (e) {
    return { ok: false, error: clip(e && e.message || e, 180) };
  }
}

function findReportForPid(pid) {
  const want = Number(pid) || 0;
  if (!(want > 0)) return null;
  const items = listRecentReports(20);
  return items.find((it) => Number(it.pid) === want) || null;
}

function attachReportFields(report) {
  if (!report) {
    return {
      reportName: null,
      reportBytes: null,
      reportPid: null,
      reportTrigger: null,
      reportEvent: null,
      reportHeap: null
    };
  }
  let sum = null;
  try { sum = summarizeReport(report.full); } catch {}
  return {
    reportName: report.name || null,
    reportBytes: report.bytes || null,
    reportPid: report.pid || null,
    reportTrigger: sum && sum.trigger || null,
    reportEvent: sum && sum.event || null,
    reportHeap: sum && sum.heap || null
  };
}

function deathEvidence({ idx1, pid } = {}) {
  const n = Math.max(1, Number(idx1) || 1);
  const tail = tailFileBytes(cellNativeLogPath(n), TAIL_BYTES);
  const report = findReportForPid(pid);
  return {
    nativeLog: "cell_" + n + "_native",
    nativeTail: clip(tail, 3500),
    ...attachReportFields(report)
  };
}

function indexDeathEvidence(pid) {
  const prev = tailFileBytes(indexNativePrevPath(), TAIL_BYTES);
  const cur = tailFileBytes(indexNativeLogPath(), TAIL_BYTES);
  const report = findReportForPid(pid);
  return {
    nativeTail: clip(prev || cur, 3500),
    nativeFrom: prev ? "crash_nativo_index.prev" : (cur ? "crash_nativo_index" : null),
    ...attachReportFields(report)
  };
}

function statJsonlSizes() {
  const names = ["messenger_pin.jsonl", "login_required_events.jsonl", "provision_audit.jsonl"];
  const out = {};
  for (const name of names) {
    const key = name.replace(/\.jsonl$/, "");
    const fp = path.join(DADOS, name);
    try {
      const st = fs.statSync(fp);
      const bytes = Number(st.size || 0) || 0;
      out[key] = { bytes, mb: Math.round(bytes / 1048576) };
    } catch {
      out[key] = { bytes: 0, mb: 0 };
    }
  }
  return out;
}

function archiveHugeJsonl({ maxBytes, keep } = {}) {
  const raw = Number(maxBytes);
  const cap = Number.isFinite(raw) && raw > 0
    ? Math.max(1024, raw)
    : HUGE_JSONL_BYTES;
  const keepN = Math.max(1, Number(keep || HUGE_KEEP) || HUGE_KEEP);
  const keys = [
    { name: "messenger_pin", fp: path.join(DADOS, "messenger_pin.jsonl") },
    { name: "login_required_events", fp: path.join(DADOS, "login_required_events.jsonl") },
    { name: "provision_audit", fp: path.join(DADOS, "provision_audit.jsonl") }
  ];
  const results = [];
  ensureLogsDir();
  for (const k of keys) {
    try {
      if (!fs.existsSync(k.fp)) {
        results.push({ key: k.name, skipped: "missing" });
        continue;
      }
      const st = fs.statSync(k.fp);
      const bytes = Number(st.size || 0) || 0;
      if (bytes < cap) {
        results.push({ key: k.name, skipped: "small", bytes });
        continue;
      }
      const dest = path.join(LOGS, k.name + "." + stamp() + ".jsonl");
      fs.renameSync(k.fp, dest);
      try { fs.writeFileSync(k.fp, "", "utf8"); } catch {}
      prunePrefix(LOGS, k.name, keepN);
      results.push({ key: k.name, ok: true, bytes, dest: path.basename(dest) });
    } catch (e) {
      results.push({ key: k.name, ok: false, error: clip(e && e.message || e, 180) });
    }
  }
  return results;
}

module.exports = {
  DADOS,
  LOGS,
  REPORT_DIR,
  INDEX_JSON,
  NATIVE_MAX_BYTES,
  HUGE_JSONL_BYTES,
  decodeExitCode,
  indexNativeLogPath,
  indexNativePrevPath,
  indexNativeOutPath,
  cellNativeLogPath,
  rotateIfHuge,
  tailFileBytes,
  headFileBytes,
  summarizeReport,
  openCellNativeFd,
  listRecentReports,
  writeReportsIndex,
  findReportForPid,
  deathEvidence,
  indexDeathEvidence,
  statJsonlSizes,
  archiveHugeJsonl
};
