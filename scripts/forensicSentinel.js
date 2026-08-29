"use strict";

/**
 * Interface fixa para instalar/consultar a sentinela.
 * Não oferece shell arbitrário.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const PS1 = path.join(__dirname, "forensicSentinel.ps1");
const VALID_ACTIONS = new Map([
  ["install", "Install"],
  ["status", "Status"],
  ["uninstall", "Uninstall"],
]);

function clip(value, max = 300) {
  const text = value == null ? "" : String(value);
  return text.length <= max ? text : text.slice(0, max);
}

function run(action = "status", { timeoutMs = 45000 } = {}) {
  const normalized = String(action || "status").trim().toLowerCase();
  const mode = VALID_ACTIONS.get(normalized);
  if (!mode) {
    return Promise.resolve({
      ok: false,
      error: "invalid_sentinel_action",
      allowed: Array.from(VALID_ACTIONS.keys()),
    });
  }
  if (process.platform !== "win32") {
    return Promise.resolve({ ok: false, error: "not_windows", action: normalized });
  }
  if (!fs.existsSync(PS1)) {
    return Promise.resolve({ ok: false, error: "sentinel_ps1_missing", action: normalized });
  }

  const ps = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const timeout = Math.max(10000, Math.min(90000, Number(timeoutMs) || 45000));

  return new Promise((resolve) => {
    execFile(
      ps,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", PS1,
        "-Mode", mode,
      ],
      {
        timeout,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(stdout || "").trim().replace(/^\uFEFF/, ""));
        } catch {}
        if (parsed && typeof parsed === "object") {
          return resolve({
            ...parsed,
            action: normalized,
          });
        }
        resolve({
          ok: false,
          action: normalized,
          error: clip(error && error.message ? error.message : "sentinel_command_failed"),
          stderr: clip(stderr, 500),
        });
      }
    );
  });
}

module.exports = {
  run,
  PS1,
};
