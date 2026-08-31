"use strict";

/**
 * Pulso de HandleCount Win32 do PRÓPRIO pid (index ou worker).
 * Não abre Chrome. Não mata processo. Não usa PowerShell (evita motor extra).
 * WMIC é best-effort; se faltar, loga só uvHandleCount (libuv, não Win32).
 *
 * Isto NÃO prova causa de FastFail 0xC0000409. Serve para ver se o teto
 * do Node estabiliza depois do detach das sessões CDP efêmeras.
 */

const { execFile } = require("child_process");
const path = require("path");

const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_DELAY_MS = 45 * 1000;
const WMIC_TIMEOUT_MS = 4000;

let installed = false;
let inflight = false;
let lastWin32 = null;

function uvHandleCount() {
  try {
    if (typeof process._getActiveHandles === "function") {
      const list = process._getActiveHandles();
      return Array.isArray(list) ? list.length : null;
    }
  } catch {}
  return null;
}

function sampleWin32HandleCount(cb) {
  if (process.platform !== "win32") {
    cb(null);
    return;
  }
  if (inflight) {
    cb(lastWin32);
    return;
  }
  inflight = true;
  const wmic = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wbem", "WMIC.exe");
  try {
    execFile(
      wmic,
      ["process", "where", `ProcessId=${process.pid}`, "get", "HandleCount", "/value"],
      { windowsHide: true, timeout: WMIC_TIMEOUT_MS },
      (err, stdout) => {
        inflight = false;
        const m = String(stdout || "").match(/HandleCount=(\d+)/i);
        lastWin32 = m ? Number(m[1]) : null;
        if (!Number.isFinite(lastWin32)) lastWin32 = null;
        cb(lastWin32);
      }
    );
  } catch {
    inflight = false;
    cb(null);
  }
}

function install({ role = "process", append = null, intervalMs = INTERVAL_MS, firstDelayMs = FIRST_DELAY_MS } = {}) {
  if (installed) return { ok: true, already: true };
  installed = true;
  const pulse = () => {
    sampleWin32HandleCount((win32) => {
      const uv = uvHandleCount();
      try {
        console.log(
          `[OXY-LOG] [HANDLES] pid=${process.pid} role=${String(role || "process")} win32=${win32 == null ? "na" : win32} uv=${uv == null ? "na" : uv}`
        );
      } catch {}
      try {
        if (typeof append === "function") {
          append("handle_pulse", {
            win32HandleCount: win32,
            uvHandleCount: uv
          });
        }
      } catch {}
    });
  };
  try {
    const first = setTimeout(pulse, Math.max(5_000, Number(firstDelayMs) || FIRST_DELAY_MS));
    first.unref();
  } catch {}
  try {
    const t = setInterval(pulse, Math.max(60_000, Number(intervalMs) || INTERVAL_MS));
    t.unref();
  } catch {}
  return { ok: true };
}

module.exports = {
  install,
  sampleWin32HandleCount,
  uvHandleCount
};
