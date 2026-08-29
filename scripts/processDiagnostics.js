"use strict";

/**
 * Habilita relatórios nativos do Node para fatal errors/OOM.
 * Não muda fluxo do sistema; apenas grava evidência quando o runtime aborta.
 */

const fs = require("fs");
const path = require("path");

const REPORT_DIR = path.join(__dirname, "..", "dados", "forensic_node_reports");
const MAX_REPORTS = 20;

function nodeVersionAtLeast(major, minor = 0) {
  try {
    const [haveMajor, haveMinor] = String(process.versions && process.versions.node || "")
      .split(".")
      .map((value) => Number(value) || 0);
    return haveMajor > major || (haveMajor === major && haveMinor >= minor);
  } catch {
    return false;
  }
}

function addNodeOption(options, flag) {
  const current = String(options || "").trim();
  const name = String(flag || "").split("=")[0];
  if (!name || current.split(/\s+/).some((item) => item === name || item.startsWith(name + "="))) {
    return current;
  }
  return `${current} ${flag}`.trim();
}

function hardenChildNodeReports() {
  let options = String(process.env.NODE_OPTIONS || "").trim();
  options = addNodeOption(options, "--report-on-fatalerror");
  options = addNodeOption(options, "--report-uncaught-exception");
  options = addNodeOption(options, `--report-directory=${REPORT_DIR}`);
  if (nodeVersionAtLeast(20, 13)) {
    options = addNodeOption(options, "--report-exclude-network");
  }
  // --report-exclude-env só existe a partir de Node 22.13 / 23.3.
  if (nodeVersionAtLeast(23, 3) || nodeVersionAtLeast(22, 13) && !nodeVersionAtLeast(23, 0)) {
    options = addNodeOption(options, "--report-exclude-env");
  }
  process.env.NODE_OPTIONS = options;
  return {
    excludeEnv: options.includes("--report-exclude-env"),
    excludeNetwork: options.includes("--report-exclude-network"),
  };
}

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
    try { process.report.excludeNetwork = true; } catch {}
    // A API JS do Node 24 não expõe excludeEnv. O flag documentado é propagado
    // em NODE_OPTIONS para todos os filhos Node (workers/backup).
    const childReports = hardenChildNodeReports();

    return {
      ...result,
      ok: true,
      reportOnFatalError: process.report.reportOnFatalError === true,
      reportOnUncaughtException: process.report.reportOnUncaughtException === true,
      currentProcessExcludeNetwork: process.report.excludeNetwork === true,
      childReports,
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
