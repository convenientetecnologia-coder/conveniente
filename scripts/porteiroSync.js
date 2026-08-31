"use strict";

/**
 * Atualiza C:\auto_vigia\manutencao.ps1 a partir do kit no repo
 * (C:\conveniente\porteiro\kit\manutencao.ps1) e recicla SÓ o loop do porteiro.
 *
 * Contrato:
 *   - NÃO chama a acao stop (PARAR). NÃO mata Node. NÃO mata Chrome.
 *   - NÃO registra tarefa agendada (isso é instalar_porteiro.ps1 / admin).
 *   - Se C:\auto_vigia não existe: não inventa instalação. Só loga.
 *   - Se o kit-fonte ainda tiver DiskClean/StandbyList: recusa copiar.
 *   - Copiar o .ps1 NÃO muda o processo já em memória: precisa restart do loop.
 *   - Se o kill do loop falhar (loop elevado): arquivo novo no disco;
 *     o reboot 04:00 / próximo logon carrega v5.2.0-nomem.
 *
 * Kill switch: PORTEIRO_SYNC_DISABLED=1
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const AUTO_VIGIA = "C:\\auto_vigia";
const DEST_PS1 = path.join(AUTO_VIGIA, "manutencao.ps1");
const LOCK_FILE = path.join(AUTO_VIGIA, "porteiro.lock");
const SRC_PS1 = path.join(__dirname, "..", "porteiro", "kit", "manutencao.ps1");
const PS_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function envDisabled() {
  return String(process.env.PORTEIRO_SYNC_DISABLED || "").trim() === "1";
}

function oxyLog(line) {
  try { console.log(String(line)); } catch {}
}

function md5File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(buf).digest("hex");
}

function sourceIsNomem(text) {
  if (/Invoke-SoftMemClean/.test(text)) return false;
  if (/DiskClean\.exe/i.test(text)) return false;
  if (/ArgumentList\s+['"]\/StandbyList['"]/.test(text)) return false;
  if (/\bmem_soft\b/.test(text)) return false;
  if (!/v5\.2\.0-nomem/.test(text)) return false;
  if (!/MemClean=OFF/.test(text)) return false;
  return true;
}

function destLooksLikeOldMemClean(text) {
  return /Invoke-SoftMemClean/.test(text) || /DiskClean\.exe/i.test(text) || /ArgumentList\s+['"]\/StandbyList['"]/.test(text) || /\bmem_soft\b/.test(text);
}

function stopLoopOnly() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$lock = 'C:\\auto_vigia\\porteiro.lock'",
    "if (Test-Path -LiteralPath $lock) {",
    "  try {",
    "    $old = [int]((Get-Content -LiteralPath $lock -Raw).Trim())",
    "    if ($old -gt 0) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }",
    "  } catch {}",
    "  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
    "}",
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.CommandLine -and ($_.CommandLine -match 'manutencao\\.ps1 -Action loop|manutencao\\.ps1\" -Action loop')",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join("; ");
  const r = spawnSync(PS_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    timeout: 20000,
    encoding: "utf8"
  });
  return {
    ok: !r.error && (r.status === 0 || r.status == null),
    status: r.status,
    error: r.error ? String(r.error.message || r.error) : null
  };
}

function startLoop() {
  const child = spawn(PS_EXE, [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", DEST_PS1,
    "-Action", "loop"
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return { pid: child.pid || 0 };
}

function sync(opts) {
  const reason = (opts && opts.reason) || "manual";
  const result = { ok: false, action: "none", reason };

  if (envDisabled()) {
    result.action = "disabled";
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] skipped disabled");
    return result;
  }

  if (!fs.existsSync(SRC_PS1)) {
    result.action = "src_missing";
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] skipped src_missing");
    return result;
  }

  const srcText = fs.readFileSync(SRC_PS1, "utf8");
  if (!sourceIsNomem(srcText)) {
    result.action = "src_has_memclean_refused";
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] REFUSED src still has mem clean");
    return result;
  }

  if (!fs.existsSync(AUTO_VIGIA) || !fs.existsSync(DEST_PS1)) {
    result.action = "dest_absent";
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] skipped dest_absent (rode instalar_porteiro.ps1 como admin)");
    return result;
  }

  const srcHash = md5File(SRC_PS1);
  const destHash = md5File(DEST_PS1);
  const destText = fs.readFileSync(DEST_PS1, "utf8");
  const destOld = destLooksLikeOldMemClean(destText);

  if (srcHash === destHash && !destOld) {
    result.ok = true;
    result.action = "already_nomem";
    result.hash = srcHash.slice(0, 8);
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] already_nomem hash=" + result.hash);
    return result;
  }

  try {
    fs.copyFileSync(SRC_PS1, DEST_PS1);
  } catch (e) {
    result.action = "copy_failed";
    result.error = (e && e.message) || String(e);
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] copy_failed " + result.error);
    return result;
  }

  const afterHash = md5File(DEST_PS1);
  const stop = stopLoopOnly();
  let start = { pid: 0 };
  try {
    start = startLoop();
  } catch (e) {
    result.action = "copied_start_failed";
    result.hash = afterHash.slice(0, 8);
    result.stop = stop;
    result.error = (e && e.message) || String(e);
    oxyLog("[OXY-LOG] [PORTEIRO-SYNC] copied_start_failed hash=" + result.hash + " — loop novo no proximo reboot 04:00");
    return result;
  }

  result.ok = true;
  result.action = destOld ? "upgraded_nomem" : "updated";
  result.hash = afterHash.slice(0, 8);
  result.stop = stop;
  result.loopPid = start.pid;
  oxyLog("[OXY-LOG] [PORTEIRO-SYNC] " + result.action + " hash=" + result.hash + " reason=" + reason);
  return result;
}

module.exports = {
  sync,
  envDisabled,
  sourceIsNomem,
  destLooksLikeOldMemClean,
  SRC_PS1,
  DEST_PS1
};
