"use strict";

/**
 * Porteiro = sistema WINDOWS à parte (tarefa ao logon + loop PowerShell).
 * Vive sem o index.js: reboot 04:00, lixeira, AUTO_BOOT do Conveniente.
 *
 * O index NÃO é o dono do Porteiro. O index só CORRIGE a versão uma vez:
 *   - arquivo errado/velho (mem_soft) → copia v5.2.0-nomem
 *   - loop morto → dispara a tarefa Windows (não fica filho do Node)
 *   - loop vivo ainda no BOOT v5.1.13 → schtasks /End + o loop novo (Highest)
 *     mata qualquer rival (porteiro_loop, vigia.bat, limpeza_memoria, outro loop)
 *   - ja nomem, tarefa Running, ultimo BOOT nomem → NAO recicla o loop.
 *     Ainda apaga kit velho (LimpezaAutomaticaConveniente, vigia.bat, …).
 *   - garante ConvenienteDiskClean (SYSTEM). O loop NAO dispara o exe.
 *
 * Tarefas ao logon/startup ausentes: UAC uma vez (install.ps1). Sem isso o
 * reboot do PC não religa o Porteiro.
 *
 * Kill switch: PORTEIRO_SYNC_DISABLED=1
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const AUTO_VIGIA = "C:\\auto_vigia";
const DEST_PS1 = path.join(AUTO_VIGIA, "manutencao.ps1");
const PORTEIRO_LOG = path.join(AUTO_VIGIA, "logs", "porteiro.log");
const LOG_FILE = path.join(AUTO_VIGIA, "logs", "porteiro_ensure.log");
const SRC_PS1 = path.join(__dirname, "..", "porteiro", "kit", "manutencao.ps1");
const INSTALLER_PS1 = path.join(__dirname, "..", "instalar_porteiro.ps1");
const PS_EXE = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const TASK_LOOP = "ConvenientePorteiro";
const TASK_NET = "ConvenienteNetBoot";
const WANT_BOOT = "BOOT v5.2.0-nomem";

function envDisabled() {
  return String(process.env.PORTEIRO_SYNC_DISABLED || "").trim() === "1";
}

function oxyLog(line) {
  try { console.log(String(line)); } catch {}
}

function persistLog(row) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const rec = Object.assign({ ts: new Date().toISOString() }, row || {});
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n", "utf8");
  } catch {}
  const action = (row && row.action) || "";
  const extra = (row && (row.detail || row.error)) || "";
  oxyLog("[OXY-LOG] [PORTEIRO-SYNC] " + action + (extra ? " " + extra : ""));
}

function md5File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("md5").update(buf).digest("hex");
}

function sourceIsNomem(text) {
  if (/Invoke-SoftMemClean/.test(text)) return false;
  if (/\bmem_soft\b/.test(text)) return false;
  if (/Start-Process[\s\S]{0,240}DiskClean\.exe/i.test(text)) return false;
  if (/ArgumentList\s+['"]\/StandbyList['"]/.test(text)) return false;
  if (!/v5\.2\.0-nomem/.test(text)) return false;
  if (!/MemClean=OFF/.test(text)) return false;
  if (!/ConvenienteDiskClean/.test(text)) return false;
  if (!/function Ensure-DiskCleanTask/.test(text)) return false;
  return true;
}

function destLooksLikeOldMemClean(text) {
  return /Invoke-SoftMemClean/.test(text) || /\bmem_soft\b/.test(text) || /Start-Process[\s\S]{0,240}DiskClean\.exe/i.test(text) || /ArgumentList\s+['"]\/StandbyList['"]/.test(text);
}

function lastBootLineIsNomem(text) {
  let last = "";
  String(text || "").split(/\r?\n/).forEach((line) => {
    if (/\bBOOT v/.test(line)) last = line;
  });
  if (!last) return null;
  return last.indexOf(WANT_BOOT) >= 0;
}

function readTail(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    const n = Math.min(Math.max(4096, Number(maxBytes) || 80000), size);
    const start = Math.max(0, size - n);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(filePath, "r");
    try { fs.readSync(fd, buf, 0, n, start); } finally { try { fs.closeSync(fd); } catch {} }
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function runningLoopIsNomem() {
  if (!fs.existsSync(PORTEIRO_LOG)) return null;
  return lastBootLineIsNomem(readTail(PORTEIRO_LOG, 120000));
}

function planEnsure({ destExists, destOld, hashEqual, taskRunning, tasksOk, runningNomem }) {
  const copy = !destExists || !!destOld || !hashEqual;
  const staleInMemory = runningNomem === false;
  const restartLoop = copy || !taskRunning || staleInMemory;
  const installTasks = !tasksOk;
  const scrubOldKit = true;
  return { copy, restartLoop, installTasks, scrubOldKit };
}

function taskState(name) {
  if (process.platform !== "win32") return "MISSING";
  const tn = String(name || "").replace(/'/g, "''");
  try {
    const r = spawnSync(PS_EXE, [
      "-NoProfile",
      "-Command",
      "try { [string]((Get-ScheduledTask -TaskName '" + tn + "' -ErrorAction Stop).State) } catch { 'MISSING' }"
    ], {
      windowsHide: true,
      timeout: 12000,
      encoding: "utf8"
    });
    return String((r && r.stdout) || "").trim() || "MISSING";
  } catch {
    return "MISSING";
  }
}

function taskIsRunning(name) {
  return /^Running$/i.test(taskState(name));
}

function taskExists(name) {
  if (process.platform !== "win32") return false;
  try {
    const r = spawnSync("schtasks.exe", ["/Query", "/TN", String(name)], {
      windowsHide: true,
      timeout: 8000,
      encoding: "utf8"
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function tasksOk() {
  return taskExists(TASK_LOOP) && taskExists(TASK_NET);
}

function schtasksEnd(name) {
  try {
    spawnSync("schtasks.exe", ["/End", "/TN", String(name)], {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8"
    });
  } catch {}
}

function schtasksDelete(name) {
  try {
    spawnSync("schtasks.exe", ["/Delete", "/TN", String(name), "/F"], {
      windowsHide: true,
      timeout: 15000,
      encoding: "utf8"
    });
  } catch {}
}

const OLD_TASKS = ["LimpezaAutomaticaConveniente"];
const OLD_FILES = [
  "vigia.bat", "porteiro_loop.ps1", "node_control.ps1", "node_control_cli.ps1",
  "lib_metrics.ps1", "lib_system.ps1", "limpeza_disco.ps1", "limpeza_memoria.ps1",
  "iniciar_sistema.bat", "parar_sistema.bat", "status_sistema.bat", "aplicar_agora.ps1"
];

function scrubOldKitFiles() {
  for (let i = 0; i < OLD_FILES.length; i++) {
    try { fs.unlinkSync(path.join(AUTO_VIGIA, OLD_FILES[i])); } catch {}
  }
}

function stopOldVigia({ endMainLoop }) {
  for (let i = 0; i < OLD_TASKS.length; i++) {
    schtasksEnd(OLD_TASKS[i]);
    schtasksDelete(OLD_TASKS[i]);
  }
  if (endMainLoop) schtasksEnd(TASK_LOOP);

  const endMain = !!endMainLoop;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$lock = 'C:\\auto_vigia\\porteiro.lock'",
    endMain ? [
      "if (Test-Path -LiteralPath $lock) {",
      "  try {",
      "    $old = [int]((Get-Content -LiteralPath $lock -Raw).Trim())",
      "    if ($old -gt 0) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }",
      "  } catch {}",
      "  Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue",
      "}"
    ].join(" ") : "",
    "$re = 'porteiro_loop\\.ps1|limpeza_memoria\\.ps1|auto_vigia\\\\vigia\\.bat|node_control\\.ps1'",
    endMain ? "$re = $re + '|manutencao\\.ps1 -Action loop|manutencao\\.ps1\" -Action loop|auto_vigia\\\\manutencao\\.ps1 -Action loop'" : "",
    "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {",
    "  $_.CommandLine -and ($_.CommandLine -match $re) -and ($_.CommandLine -notmatch 'windowsForensicDeep|-Action (start|stop|status|netboot|install|ensure_diskclean)')",
    "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].filter(Boolean).join("; ");

  const r = spawnSync(PS_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    timeout: 20000,
    encoding: "utf8"
  });
  try { scrubOldKitFiles(); } catch {}
  return {
    ok: !r.error && (r.status === 0 || r.status == null),
    status: r.status,
    endMainLoop: endMain,
    error: r.error ? String(r.error.message || r.error) : null
  };
}

function startLoopSpawn() {
  const psArg = PS_EXE.replace(/'/g, "''");
  const fileArg = DEST_PS1.replace(/'/g, "''");
  const cmd =
    "Start-Process -FilePath '" + psArg + "' -WindowStyle Hidden -ArgumentList " +
    "'-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File','" + fileArg + "','-Action','loop'";
  const r = spawnSync(PS_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    windowsHide: true,
    timeout: 15000,
    encoding: "utf8"
  });
  return {
    via: "start_process",
    ok: !r.error && (r.status === 0 || r.status == null),
    status: r.status,
    error: r.error ? String(r.error.message || r.error) : null
  };
}

function startLoopOwnedByWindows() {
  if (taskExists(TASK_LOOP)) {
    try {
      const r = spawnSync("schtasks.exe", ["/Run", "/TN", TASK_LOOP], {
        windowsHide: true,
        timeout: 20000,
        encoding: "utf8"
      });
      if (r.status === 0) return { via: "schtasks", ok: true };
    } catch {}
  }
  return startLoopSpawn();
}

function requestTaskInstall() {
  if (!fs.existsSync(INSTALLER_PS1)) {
    return { ok: false, error: "installer_missing" };
  }
  const fileArg = INSTALLER_PS1.replace(/'/g, "''");
  const psArg = PS_EXE.replace(/'/g, "''");
  const cmd =
    "Start-Process -FilePath '" + psArg + "' -Verb RunAs -ArgumentList " +
    "'-NoProfile -ExecutionPolicy Bypass -File \"" + fileArg + "\"'";
  const child = spawn(PS_EXE, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { ok: true, pid: child.pid || 0 };
}

function ensureDirs() {
  fs.mkdirSync(path.join(AUTO_VIGIA, "logs"), { recursive: true });
}

function sleepMs(ms) {
  const n = Math.max(0, Math.min(5000, Number(ms) || 0));
  if (n <= 0) return;
  spawnSync(PS_EXE, ["-NoProfile", "-Command", "Start-Sleep -Milliseconds " + n], {
    windowsHide: true,
    timeout: n + 4000
  });
}

function sync(opts) {
  const reason = (opts && opts.reason) || "manual";
  const result = { ok: false, action: "none", reason };

  if (envDisabled()) {
    result.action = "disabled";
    persistLog(result);
    return result;
  }

  if (process.platform !== "win32") {
    result.action = "not_windows";
    persistLog(result);
    return result;
  }

  if (!fs.existsSync(SRC_PS1)) {
    result.action = "src_missing";
    persistLog(result);
    return result;
  }

  const srcText = fs.readFileSync(SRC_PS1, "utf8");
  if (!sourceIsNomem(srcText)) {
    result.action = "src_has_memclean_refused";
    persistLog(result);
    return result;
  }

  const destExists = fs.existsSync(DEST_PS1);
  let destOld = false;
  let hashEqual = false;
  const srcHash = md5File(SRC_PS1);
  if (destExists) {
    try {
      destOld = destLooksLikeOldMemClean(fs.readFileSync(DEST_PS1, "utf8"));
      hashEqual = md5File(DEST_PS1) === srcHash;
    } catch {
      destOld = true;
      hashEqual = false;
    }
  }

  let taskRunning = false;
  let tasksPresent = false;
  let runningNomem = false;
  try { taskRunning = taskIsRunning(TASK_LOOP); } catch {}
  try { tasksPresent = tasksOk(); } catch {}
  try { runningNomem = runningLoopIsNomem(); } catch {}

  const plan = planEnsure({
    destExists,
    destOld,
    hashEqual,
    taskRunning,
    tasksOk: tasksPresent,
    runningNomem
  });
  result.plan = plan;

  try {
    ensureDirs();
  } catch (e) {
    result.action = "mkdir_failed";
    result.error = (e && e.message) || String(e);
    persistLog(result);
    return result;
  }

  if (plan.copy) {
    try {
      fs.copyFileSync(SRC_PS1, DEST_PS1);
    } catch (e) {
      result.action = "copy_failed";
      result.error = (e && e.message) || String(e);
      persistLog(result);
      return result;
    }
  }

  try { stopOldVigia({ endMainLoop: false }); } catch {}

  if (plan.restartLoop) {
    const stop = stopOldVigia({ endMainLoop: true });
    result.stop = stop;
    try { sleepMs(800); } catch {}
    try {
      const start = startLoopOwnedByWindows();
      result.start = start;
    } catch (e) {
      result.action = "copied_start_failed";
      result.hash = md5File(DEST_PS1).slice(0, 8);
      result.error = (e && e.message) || String(e);
      persistLog(result);
      return result;
    }
  }

  if (plan.installTasks) {
    const asked = requestTaskInstall();
    result.uac = asked;
  }

  result.ok = true;
  result.hash = (fs.existsSync(DEST_PS1) ? md5File(DEST_PS1) : srcHash).slice(0, 8);
  result.runningNomemBefore = runningNomem;
  if (!destExists && plan.copy) result.action = "installed_fresh";
  else if (destOld) result.action = "upgraded_nomem";
  else if (plan.copy) result.action = "updated";
  else if (plan.restartLoop && !runningNomem) result.action = "loop_loaded_nomem";
  else if (plan.restartLoop) result.action = "loop_restarted";
  else result.action = "already_nomem";
  if (plan.installTasks) result.action += "+tasks_uac";

  persistLog({
    action: result.action,
    hash: result.hash,
    reason,
    plan,
    tasksPresent,
    taskRunningBefore: taskRunning,
    runningNomemBefore: runningNomem,
    start: result.start || null
  });
  return result;
}

module.exports = {
  sync,
  envDisabled,
  sourceIsNomem,
  destLooksLikeOldMemClean,
  lastBootLineIsNomem,
  planEnsure,
  SRC_PS1,
  DEST_PS1,
  TASK_LOOP,
  TASK_NET
};
