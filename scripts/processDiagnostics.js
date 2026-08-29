"use strict";

/**
 * Habilita relatórios nativos do Node para fatal errors/OOM.
 * Não muda fluxo do sistema; apenas grava evidência quando o runtime aborta.
 */

const fs = require("fs");
const path = require("path");

const REPORT_DIR = path.join(__dirname, "..", "dados", "forensic_node_reports");
const MAX_REPORTS = 20;

function pruneOldReports() {
  try {
    if (!fs.existsSync(REPORT_DIR)) return;
    const files = fs.readdirSync(REPORT_DIR)
      .filter((name) => /^report\..+\.json$/i.test(String(name || "")))
      .map((name) => {
        const filePath = path.join(REPORT_DIR, name);
        let mtimeMs = 0;
        try { mtimeMs = Number(fs.statSync(filePath).mtimeMs || 0) || 0; } catch {}
        return { filePath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const item of files.slice(MAX_REPORTS)) {
      try { fs.unlinkSync(item.filePath); } catch {}
    }
  } catch {}
}

function install({ role = "process" } = {}) {
  const result = {
    ok: false,
    role: String(role || "process").slice(0, 32),
    reportDir: REPORT_DIR,
  };
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    pruneOldReports();
    if (!process.report || typeof process.report !== "object") {
      return { ...result, error: "process_report_unavailable" };
    }

    process.report.directory = REPORT_DIR;
    process.report.filename = "";
    process.report.reportOnFatalError = true;
    process.report.reportOnUncaughtException = true;
    // Não vazar tokens/secrets de ambiente no artefato forense.
    try { process.report.excludeEnv = true; } catch {}

    return {
      ...result,
      ok: true,
      reportOnFatalError: process.report.reportOnFatalError === true,
      reportOnUncaughtException: process.report.reportOnUncaughtException === true,
      excludeEnv: process.report.excludeEnv === true,
    };
  } catch (error) {
    return {
      ...result,
      error: String(error && error.message ? error.message : error).slice(0, 220),
    };
  }
}

module.exports = {
  install,
  REPORT_DIR,
};
