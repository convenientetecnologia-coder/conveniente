"use strict";

/**
 * Puxa Event Viewer (Application + System) só-leitura.
 * Não consulta Security. Não executa shutdown. Não mata processo.
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PS1 = path.join(__dirname, "windowsEventsForensic.ps1");
const LIFE = require("./indexLifecycle.js");

function collectWindowsEvents({ hours = 24, maxEvents = 80, timeoutMs = 25000 } = {}) {
  const h = Math.max(1, Math.min(72, Number(hours) || 24));
  const max = Math.max(10, Math.min(120, Number(maxEvents) || 80));
  const to = Math.max(8000, Math.min(55000, Number(timeoutMs) || 25000));
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      return resolve({ ok: false, error: "not_windows" });
    }
    if (!fs.existsSync(PS1)) {
      return resolve({ ok: false, error: "ps1_missing" });
    }
    execFile(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", PS1,
        "-Hours", String(h),
        "-Max", String(max)
      ],
      { timeout: to, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let parsed = null;
        try { parsed = JSON.parse(String(stdout || "").trim()); } catch {}
        if (parsed && parsed.ok === true) {
          return resolve(parsed);
        }
        resolve({
          ok: false,
          error: (err && err.message) ? String(err.message).slice(0, 220) : "wevt_parse_failed",
          stderr: String(stderr || "").slice(0, 240)
        });
      }
    );
  });
}

async function buildWindowsForensicReport(opts) {
  const hours = Math.max(1, Math.min(72, Number(opts && opts.hours || 24) || 24));
  const maxEvents = Math.max(10, Math.min(120, Number(opts && opts.maxEvents || 80) || 80));
  const win = await collectWindowsEvents({ hours, maxEvents, timeoutMs: opts && opts.timeoutMs });
  return {
    ok: true,
    kind: "windows_events",
    collectedAt: Date.now(),
    collectedAtIso: new Date().toISOString(),
    hostname: os.hostname(),
    pid: process.pid,
    hours,
    lifecycleTail: LIFE.readTail(40),
    heartbeat: LIFE.readHeartbeat(),
    windows: win
  };
}

module.exports = {
  collectWindowsEvents,
  buildWindowsForensicReport
};
