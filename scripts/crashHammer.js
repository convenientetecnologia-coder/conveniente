"use strict";

/**
 * Martelo da queda. Nao atrasa respawn. Junta varios drops no mesmo segundo.
 * O JS nao ve FastFail — o Windows ve. Este arquivo so dispara o olho de fora.
 */

const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PS1 = path.join(__dirname, "crashHammer.ps1");
const PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const LAST = path.join(__dirname, "..", "dados", "crash_hammer_last.json");
const DEBOUNCE_MS = 2000;

let pending = [];
let timer = null;
let running = false;
let memCache = { at: 0, v: null };

function clip(s, n) {
  const t = String(s == null ? "" : s);
  return t.length <= n ? t : t.slice(0, n);
}

function scheduleWorkerDrop(drop) {
  try {
    pending.push({
      idx: drop && drop.idx != null ? Number(drop.idx) : null,
      code: drop && drop.code != null ? Number(drop.code) : null,
      signal: drop && drop.signal != null ? String(drop.signal) : null,
      workerPid: drop && drop.workerPid != null ? Number(drop.workerPid) : null,
      shard: drop && drop.shard != null ? Number(drop.shard) : null,
      ts: Date.now()
    });
  } catch {}
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flush("worker_drop");
  }, DEBOUNCE_MS);
}

function scheduleIndex(reason) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flush(reason || "index");
  }, 400);
}

function dropsCsv(list) {
  return (list || []).map((d) => {
    const hex = d && d.code != null && Number.isFinite(Number(d.code))
      ? ("0x" + (Number(d.code) >>> 0).toString(16).toUpperCase())
      : "";
    return [d && d.idx != null ? d.idx : "", hex, d && d.workerPid != null ? d.workerPid : ""].join(":");
  }).join(",");
}

function flush(reason) {
  if (running) {
    timer = setTimeout(() => flush(reason), 1500);
    return;
  }
  const drops = pending.splice(0, pending.length);
  running = true;
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", PS1,
    "-Reason", String(reason || "manual"),
    "-Minutes", "20"
  ];
  const csv = dropsCsv(drops);
  if (csv) args.push("-DropsCsv", csv);

  if (process.platform !== "win32" || !fs.existsSync(PS1)) {
    running = false;
    return;
  }

  execFile(PS, args, { timeout: 20000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err) => {
    running = false;
    try {
      require("./indexLifecycle.js").append("crash_hammer", {
        reason: String(reason || ""),
        drops: drops.length,
        ok: !err,
        err: err ? clip(err.message, 160) : null
      });
    } catch {}
  });
}

function readOsMemCached() {
  const now = Date.now();
  if (memCache.v && (now - memCache.at) < 50000) return memCache.v;
  const empty = { freeMB: null, totalMB: null, commitPct: null, commitUsedMB: null, commitLimitMB: null };
  if (process.platform !== "win32") {
    memCache = { at: now, v: empty };
    return empty;
  }
  try {
    const raw = execFileSync(PS, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-Command",
      "$o=Get-CimInstance Win32_OperatingSystem; $tot=[double]$o.TotalVisibleMemorySize; $free=[double]$o.FreePhysicalMemory; $vt=[double]$o.TotalVirtualMemorySize; $vf=[double]$o.FreeVirtualMemory; '{0}|{1}|{2}|{3}|{4}' -f [int][math]::Round($free/1024),[int][math]::Round($tot/1024),[math]::Round(100*($vt-$vf)/$vt,1),[int][math]::Round(($vt-$vf)/1024),[int][math]::Round($vt/1024)"
    ], { timeout: 2500, windowsHide: true, encoding: "utf8" });
    const parts = String(raw || "").trim().split("|");
    const v = {
      freeMB: Number(parts[0]) || null,
      totalMB: Number(parts[1]) || null,
      commitPct: parts[2] != null && parts[2] !== "" ? Number(parts[2]) : null,
      commitUsedMB: Number(parts[3]) || null,
      commitLimitMB: Number(parts[4]) || null
    };
    memCache = { at: now, v };
    return v;
  } catch {
    memCache = { at: now, v: empty };
    return empty;
  }
}

function readLast() {
  try {
    return JSON.parse(fs.readFileSync(LAST, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  scheduleWorkerDrop,
  scheduleIndex,
  readOsMemCached,
  readLast,
  LAST
};
