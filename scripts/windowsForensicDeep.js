"use strict";

/**
 * Executa o coletor PowerShell profundo e persiste o último resultado.
 * A resposta do command-bus é compacta; o JSON completo sai no allowlist.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PS1 = path.join(__dirname, "windowsForensicDeep.ps1");
const LAST_PATH = path.join(__dirname, "..", "dados", "windows_forensic_deep_last.json");

function safeReadLast() {
  try {
    const raw = String(fs.readFileSync(LAST_PATH, "utf8") || "").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clip(value, max = 220) {
  const text = value == null ? "" : String(value);
  return text.length <= max ? text : text.slice(0, max);
}

function summarize(report) {
  const events = report && report.events && typeof report.events === "object"
    ? report.events
    : {};
  const eventCounts = {};
  for (const [key, rows] of Object.entries(events)) {
    eventCounts[key] = Array.isArray(rows) ? rows.length : 0;
  }
  const porteiroRows = report && report.porteiroHistory && Array.isArray(report.porteiroHistory.rows)
    ? report.porteiroHistory.rows
    : [];
  const porteiroCounts = {};
  for (const row of porteiroRows) {
    const kind = row && row.kind ? String(row.kind) : "other";
    porteiroCounts[kind] = (porteiroCounts[kind] || 0) + 1;
  }
  return {
    collectedAtUtc: report && report.collectedAtUtc || null,
    hostname: report && report.identity && report.identity.hostname || os.hostname(),
    reason: report && report.identity && report.identity.reason || null,
    os: report && report.os ? {
      version: report.os.version || null,
      build: report.os.build || null,
      uptimeMin: report.os.uptimeMin ?? null,
      freePhysicalMemoryMB: report.os.freePhysicalMemoryMB ?? null,
      freeVirtualMemoryMB: report.os.freeVirtualMemoryMB ?? null,
    } : null,
    memory: report && report.memory ? {
      availableMB: report.memory.availableMB ?? null,
      committedMB: report.memory.committedMB ?? null,
      commitLimitMB: report.memory.commitLimitMB ?? null,
      commitUsedPercent: report.memory.commitUsedPercent ?? null,
      poolPagedMB: report.memory.poolPagedMB ?? null,
      poolNonpagedMB: report.memory.poolNonpagedMB ?? null,
      processes: report.memory.processes ?? null,
      threads: report.memory.threads ?? null,
    } : null,
    diskClean: report && report.diskClean ? {
      exists: report.diskClean.exists === true,
      sha256: report.diskClean.sha256 || null,
      signatureStatus: report.diskClean.signatureStatus || null,
      company: report.diskClean.company || null,
      version: report.diskClean.version || null,
    } : null,
    antivirusProducts: Array.isArray(report && report.antivirusProducts)
      ? report.antivirusProducts.map((row) => row && row.name).filter(Boolean)
      : [],
    defenderThreats: Array.isArray(report && report.defenderThreats)
      ? report.defenderThreats.length
      : 0,
    scheduledTasks: Array.isArray(report && report.scheduledTasks)
      ? report.scheduledTasks.length
      : 0,
    porteiro: {
      exists: !!(report && report.porteiroHistory && report.porteiroHistory.exists),
      counts: porteiroCounts,
      lastRows: porteiroRows.slice(-20),
    },
    dumps: report && report.wer && Array.isArray(report.wer.dumps)
      ? report.wer.dumps.length
      : 0,
    eventCounts,
    fullReportPath: LAST_PATH,
  };
}

function collect({
  hours = 24,
  maxEvents = 100,
  reason = "remote_manual",
  timeoutMs = 90000,
} = {}) {
  const h = Math.max(1, Math.min(168, Number(hours) || 24));
  const max = Math.max(20, Math.min(250, Number(maxEvents) || 100));
  const timeout = Math.max(15000, Math.min(150000, Number(timeoutMs) || 90000));
  const ps = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );

  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      return resolve({ ok: false, error: "not_windows", summary: null });
    }
    if (!fs.existsSync(PS1)) {
      return resolve({ ok: false, error: "deep_ps1_missing", summary: null });
    }

    execFile(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", PS1,
        "-Hours", String(h),
        "-MaxEvents", String(max),
        "-Reason", clip(reason, 100),
      ],
      {
        timeout,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let report = null;
        try {
          const raw = String(stdout || "").trim().replace(/^\uFEFF/, "");
          report = raw ? JSON.parse(raw) : null;
        } catch {}
        if (!report) report = safeReadLast();

        if (report && report.ok === true) {
          return resolve({
            ok: true,
            kind: "windows_forensic_deep",
            summary: summarize(report),
          });
        }
        resolve({
          ok: false,
          kind: "windows_forensic_deep",
          error: clip(
            report && report.error
              ? report.error
              : error && error.message
                ? error.message
                : "deep_forensic_failed",
            300
          ),
          stderr: clip(stderr, 400),
          summary: report ? summarize(report) : null,
        });
      }
    );
  });
}

module.exports = {
  collect,
  LAST_PATH,
};
