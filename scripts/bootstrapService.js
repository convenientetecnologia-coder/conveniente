// scripts/bootstrapService.js
// Bootstrap ultra seguro para Windows: cria tarefa agendada (sem admin) ou instala NSSM (se tiver admin + nssm.exe).
"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const logger = require("./logger.js");
const https = require("https");

function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: cwd || process.cwd() }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === "number" ? err.code : 0,
        error: err ? (err.message || String(err)) : null,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function isAdminWindows() {
  // net session exige admin; se retornar 0, é admin
  const r = await run("cmd.exe", ["/c", "net", "session"], {});
  return !!r.ok;
}

async function scheduledTaskExists(taskName) {
  const r = await run("schtasks.exe", ["/Query", "/TN", taskName], {});
  return !!r.ok;
}

async function createScheduledTask({ taskName, workDir, nodePath, scriptPath, envPairs = [] }) {
  // Obs: Task Scheduler não aceita env vars diretamente no task action; usamos cmd /c "set ... && node index.js"
  const envPrefix = envPairs
    .filter(x => x && x.key)
    .map(x => `set "${x.key}=${String(x.value ?? "")}"`)
    .join(" && ");
  const cmdLine = (envPrefix ? (envPrefix + " && ") : "") + `"${nodePath}" "${scriptPath}"`;
  const tr = `cmd.exe /c ${cmdLine}`;

  const args = [
    "/Create",
    "/F",
    // ONSTART costuma exigir admin; sem admin usamos ONLOGON (vai subir quando o operador logar).
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/TN", taskName,
    "/TR", tr
  ];
  // /RU SYSTEM só se admin; sem user especificado, roda como o usuário atual (mais simples).
  const r = await run("schtasks.exe", args, { cwd: workDir });
  return r;
}

async function startScheduledTask(taskName) {
  return await run("schtasks.exe", ["/Run", "/TN", taskName], {});
}

async function nssmInstall({ nssmPath, serviceName, nodePath, workDir, scriptPath, envPairs = [], stdoutPath, stderrPath }) {
  // Instala o service
  let r = await run(nssmPath, ["install", serviceName, nodePath, scriptPath], { cwd: workDir });
  if (!r.ok) return r;
  // Working dir
  await run(nssmPath, ["set", serviceName, "AppDirectory", workDir], { cwd: workDir });
  // Logs
  if (stdoutPath) await run(nssmPath, ["set", serviceName, "AppStdout", stdoutPath], { cwd: workDir });
  if (stderrPath) await run(nssmPath, ["set", serviceName, "AppStderr", stderrPath], { cwd: workDir });
  await run(nssmPath, ["set", serviceName, "AppRotateFiles", "1"], { cwd: workDir });
  await run(nssmPath, ["set", serviceName, "AppRotateOnline", "1"], { cwd: workDir });
  await run(nssmPath, ["set", serviceName, "AppRotateBytes", "10485760"], { cwd: workDir }); // 10MB
  // Env vars
  if (envPairs.length) {
    const envStr = envPairs.map(x => `${x.key}=${String(x.value ?? "")}`).join("\0");
    await run(nssmPath, ["set", serviceName, "AppEnvironmentExtra", envStr], { cwd: workDir });
  }
  // Auto start
  await run(nssmPath, ["set", serviceName, "Start", "SERVICE_AUTO_START"], { cwd: workDir });
  return { ok: true };
}

function toolsDir() {
  return path.join(resolveRepoDir(), "dados", "tools");
}
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function downloadToFile(url, outFile) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(outFile);
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        try { file.close(); } catch {}
        try { fs.unlinkSync(outFile); } catch {}
        return resolve({ ok: false, error: `http_${res.statusCode}` });
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve({ ok: true })));
    });
    req.on("error", (e) => {
      try { file.close(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      resolve({ ok: false, error: (e && e.message) || String(e) });
    });
  });
}
async function expandZip(zipPath, destDir) {
  ensureDir(destDir);
  // PowerShell Expand-Archive é nativo no Windows
  const ps = [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`
  ];
  return await run("powershell.exe", ps, { cwd: destDir });
}
function findNssmExe(extractDir) {
  try {
    const archFolder = (process.arch === "x64") ? "win64" : "win32";
    // layout padrão do zip do NSSM: nssm-2.24/win64/nssm.exe
    const rootItems = fs.readdirSync(extractDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of rootItems) {
      const cand = path.join(extractDir, d.name, archFolder, "nssm.exe");
      if (fs.existsSync(cand)) return cand;
    }
  } catch {}
  return null;
}
async function ensureNssmAvailable() {
  const existing = String(process.env.NSSM_PATH || "").trim();
  if (existing && fs.existsSync(existing)) return { ok: true, nssmPath: existing, source: "env" };

  // Só baixa se permitido explicitamente (segurança)
  if (process.env.CT_ALLOW_DOWNLOAD_TOOLS !== "1") {
    return { ok: false, error: "nssm_not_found", hint: "Defina NSSM_PATH ou use CT_ALLOW_DOWNLOAD_TOOLS=1 para baixar automaticamente." };
  }
  if (process.platform !== "win32") {
    return { ok: false, error: "not_windows" };
  }

  const tdir = toolsDir();
  ensureDir(tdir);
  const zipUrl = String(process.env.CT_NSSM_ZIP_URL || "https://nssm.cc/release/nssm-2.24.zip").trim();
  const zipPath = path.join(tdir, "nssm.zip");
  const extractDir = path.join(tdir, "nssm");

  logger.info("[BOOTSTRAP] baixando NSSM", { url: zipUrl });
  const dl = await downloadToFile(zipUrl, zipPath);
  if (!dl.ok) return { ok: false, error: "download_failed", details: dl.error };

  const ex = await expandZip(zipPath, extractDir);
  if (!ex.ok) return { ok: false, error: "extract_failed", details: ex.stderr || ex.stdout || ex.error };

  const nssmPath = findNssmExe(extractDir);
  if (!nssmPath) return { ok: false, error: "nssm_exe_not_found_after_extract" };
  return { ok: true, nssmPath, source: "download" };
}

async function nssmStart({ nssmPath, serviceName, workDir }) {
  return await run(nssmPath, ["start", serviceName], { cwd: workDir });
}

function pickNodePath() {
  // Windows default
  const candidates = [
    process.execPath,
    "C:\\\\Program Files\\\\nodejs\\\\node.exe",
    "C:\\\\Program Files (x86)\\\\nodejs\\\\node.exe"
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return process.execPath;
}

function resolveRepoDir() {
  return path.join(__dirname, "..");
}

function buildEnvPairs() {
  // Mantém o mínimo; o resto vem do ambiente do host
  const pairs = [];
  if (process.env.LOG_INGEST_SECRET) pairs.push({ key: "LOG_INGEST_SECRET", value: process.env.LOG_INGEST_SECRET });
  if (process.env.PORT) pairs.push({ key: "PORT", value: process.env.PORT });
  if (process.env.DASHBOARD_INTERVAL_MS) pairs.push({ key: "DASHBOARD_INTERVAL_MS", value: process.env.DASHBOARD_INTERVAL_MS });
  // Proteção: não abrir chromium automaticamente no servidor
  pairs.push({ key: "OPEN_CHROMIUM_ON_START", value: "0" });
  return pairs;
}

async function ensureServiceInstalled() {
  if (process.platform !== "win32") return { ok: true, skipped: true, reason: "not_windows" };
  if (process.env.CT_BOOTSTRAP_SERVICE !== "1") {
    return {
      ok: true,
      skipped: true,
      reason: "CT_BOOTSTRAP_SERVICE!=1",
      hint: "Para auto-instalar runtime gerenciado: defina CT_BOOTSTRAP_SERVICE=1 (e opcionalmente CT_SERVICE_MODE=task|nssm)"
    };
  }
  if (process.env.IS_SERVICE === "1") return { ok: true, skipped: true, reason: "already_service" };

  const repoDir = resolveRepoDir();
  const nodePath = pickNodePath();
  const scriptPath = path.join(repoDir, "index.js");
  const envPairs = buildEnvPairs();

  const preferred = String(process.env.CT_SERVICE_MODE || "task").trim().toLowerCase(); // task|nssm
  const serviceName = String(process.env.CT_SERVICE_NAME || "Conveniente").trim() || "Conveniente";
  const taskName = String(process.env.CT_TASK_NAME || "Conveniente").trim() || "Conveniente";

  // 1) NSSM se solicitado explicitamente
  if (preferred === "nssm") {
    const nssmEnsure = await ensureNssmAvailable();
    if (!nssmEnsure.ok) return nssmEnsure;
    const nssmPath = nssmEnsure.nssmPath;
    const isAdmin = await isAdminWindows();
    if (!isAdmin) {
      return { ok: false, error: "not_admin", hint: "Abra PowerShell como Administrador para instalar o serviço NSSM" };
    }
    const stdoutPath = path.join(repoDir, "dados", "service_stdout.log");
    const stderrPath = path.join(repoDir, "dados", "service_stderr.log");
    const r = await nssmInstall({ nssmPath, serviceName, nodePath, workDir: repoDir, scriptPath, envPairs, stdoutPath, stderrPath });
    if (!r.ok) return r;
    await nssmStart({ nssmPath, serviceName, workDir: repoDir });
    return { ok: true, mode: "nssm", serviceName };
  }

  // 2) Default: Scheduled Task (mais fácil sem admin)
  const isAdmin = await isAdminWindows();
  const exists = await scheduledTaskExists(taskName);
  if (!exists) {
    // Se for admin, ONSTART é o ideal
    const r = isAdmin
      ? await run("schtasks.exe", ["/Create","/F","/SC","ONSTART","/RL","HIGHEST","/TN",taskName,"/TR", `cmd.exe /c "${nodePath}" "${scriptPath}"`], { cwd: repoDir })
      : await createScheduledTask({ taskName, workDir: repoDir, nodePath, scriptPath, envPairs });
    if (!r.ok) return { ok: false, error: "task_create_failed", details: r.stderr || r.stdout || r.error };
  }
  // tenta rodar agora (vai iniciar em background)
  await startScheduledTask(taskName);
  return { ok: true, mode: "task", taskName };
}

async function boot() {
  try {
    const r = await ensureServiceInstalled();
    if (r && r.skipped) {
      logger.info("[BOOTSTRAP] service bootstrap skip", r);
      return;
    }
    if (r && r.ok) {
      logger.info("[BOOTSTRAP] service bootstrap ok", r);
      // Se instalou com sucesso, sugere sair para que o service/Task assuma
      if (String(process.env.CT_BOOTSTRAP_EXIT || "1") === "1") {
        logger.info("[BOOTSTRAP] saindo do processo atual para o runtime gerenciado assumir (CT_BOOTSTRAP_EXIT=1)");
        try { process.exit(0); } catch {}
      }
      return;
    }
    logger.warn("[BOOTSTRAP] service bootstrap falhou", r);
  } catch (e) {
    logger.warn("[BOOTSTRAP] exception", { error: (e && e.message) || String(e) });
  }
}

module.exports = { boot };

