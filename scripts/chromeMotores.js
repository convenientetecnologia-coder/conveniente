'use strict';

/**
 * Isolamento de motores: 1 worker = 1 clone oficial do Chrome.
 * userDataDir das contas permanece no cofre original (User Data\\Conveniente\\<nome>).
 * Sem fallback para o chrome.exe unificado do Windows.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
const { planMemoryAndShards } = require('./memoryPlan.js');
const fileStore = require('./fileStore.js');
const logger = require('./logger.js');

const MOTORES_ROOT = 'C:\\conveniente\\motores';
const LAST_PATH = path.join(__dirname, '..', 'dados', 'multi_engine_last.json');

function fatal(msg, extra) {
  const text = 'MULTI_ENGINE_FATAL: ' + String(msg || 'falha');
  try { logger.error(text, extra && typeof extra === 'object' ? extra : {}); } catch {}
  try { console.error(text); } catch {}
  const err = new Error(text);
  err.multiEngine = true;
  throw err;
}

function sleepMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch {
    const end = Date.now() + n;
    while (Date.now() < end) { /* wait */ }
  }
}

function writeLast(obj) {
  try {
    fs.mkdirSync(path.dirname(LAST_PATH), { recursive: true });
    const tmp = LAST_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.unlinkSync(LAST_PATH); } catch {}
    try { fs.renameSync(tmp, LAST_PATH); }
    catch { fs.copyFileSync(tmp, LAST_PATH); try { fs.unlinkSync(tmp); } catch {} }
  } catch {}
}

function parseVersionToken(raw) {
  const m = String(raw || '').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { full: m[0], major: Number(m[1]) || 0 };
}

function findMasterChromeExe() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function readExeVersion(exePath) {
  const exe = String(exePath || '').trim();
  if (!exe || !fs.existsSync(exe)) return null;
  const dir = path.dirname(exe);
  let best = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      const parsed = parseVersionToken(name);
      if (!parsed) continue;
      const asDir = path.join(dir, name);
      let isDir = false;
      try { isDir = fs.statSync(asDir).isDirectory(); } catch {}
      if (!isDir) continue;
      if (!best || parsed.major > best.major || (parsed.major === best.major && parsed.full > best.full)) {
        best = parsed;
      }
    }
  } catch {}
  if (best) return Object.assign({ exe }, best);
  try {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const out = execFileSync(ps, [
      '-NoProfile', '-Command',
      "(Get-Item -LiteralPath '" + exe.replace(/'/g, "''") + "').VersionInfo.FileVersion"
    ], { timeout: 8000, encoding: 'utf8', windowsHide: true });
    const parsed = parseVersionToken(out);
    if (parsed) return Object.assign({ exe }, parsed);
  } catch {}
  try {
    const out = execFileSync(exe, ['--version'], { timeout: 4000, encoding: 'utf8', windowsHide: true });
    const parsed = parseVersionToken(out);
    if (parsed) return Object.assign({ exe }, parsed);
  } catch {}
  return null;
}

function motorDir(n) {
  return path.join(MOTORES_ROOT, 'w' + String(n));
}

function motorExe(n) {
  return path.join(motorDir(n), 'chrome.exe');
}

function listMotorIndexes() {
  const out = [];
  try {
    if (!fs.existsSync(MOTORES_ROOT)) return out;
    for (const name of fs.readdirSync(MOTORES_ROOT)) {
      const m = String(name || '').match(/^w(\d+)$/i);
      if (!m) continue;
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n < 1) continue;
      let isDir = false;
      try { isDir = fs.statSync(path.join(MOTORES_ROOT, name)).isDirectory(); } catch {}
      if (isDir) out.push(n);
    }
  } catch (e) {
    fatal('nao consegui ler C:\\conveniente\\motores', { error: e && e.message || String(e) });
  }
  return out.sort((a, b) => a - b);
}

function chromeProcessCount() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000
    });
    const t = String((r && r.stdout) || '');
    return (t.match(/chrome\.exe/gi) || []).length;
  } catch {
    return -1;
  }
}

function hardPurgeChrome() {
  try {
    spawnSync('taskkill', ['/F', '/IM', 'chrome.exe'], { windowsHide: true, timeout: 20000 });
  } catch (e) {
    fatal('taskkill chrome.exe falhou', { error: e && e.message || String(e) });
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const n = chromeProcessCount();
    if (n === 0) return { ok: true, leftover: 0 };
    sleepMs(400);
  }
  const leftover = chromeProcessCount();
  if (leftover > 0) {
    fatal('chrome.exe ainda vivo apos taskkill. Nao posso clonar motores com arquivo preso.', { leftover });
  }
  return { ok: true, leftover: 0 };
}

function rmDirFatal(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    fatal('nao consegui limpar pasta do motor (permissao ou arquivo preso)', {
      dir,
      error: e && e.message || String(e)
    });
  }
}

function cloneMasterTo(destDir, masterDir, masterVer) {
  try {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
  } catch (e) {
    fatal('nao consegui criar C:\\conveniente\\motores', { error: e && e.message || String(e) });
  }
  rmDirFatal(destDir);
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    fatal('nao consegui criar pasta do motor', { dir: destDir, error: e && e.message || String(e) });
  }
  try {
    fs.cpSync(masterDir, destDir, { recursive: true, force: true, errorOnExist: false });
  } catch (e) {
    fatal('copia do Chrome mestre falhou (permissao ou disco)', {
      from: masterDir,
      to: destDir,
      error: e && e.message || String(e)
    });
  }
  const exe = path.join(destDir, 'chrome.exe');
  if (!fs.existsSync(exe)) {
    fatal('clone sem chrome.exe apos a copia', { destDir });
  }
  const ver = readExeVersion(exe);
  if (!ver || !ver.full || ver.full !== masterVer.full) {
    fatal('clone nasceu com versao diferente do Chrome mestre', {
      destDir,
      master: masterVer.full,
      clone: ver && ver.full || null
    });
  }
  return ver;
}

function deleteObsoleteMotors(keepN) {
  const n = Math.max(1, Number(keepN) || 1);
  const extras = [];
  for (const idx of listMotorIndexes()) {
    if (idx > n) {
      const dir = motorDir(idx);
      rmDirFatal(dir);
      extras.push(idx);
    }
  }
  return extras;
}

function planWorkerCount() {
  let names = [];
  try {
    names = (fileStore.loadPerfisJson() || []).map((p) => p && p.nome).filter(Boolean);
  } catch (e) {
    fatal('nao consegui ler perfis.json para dimensionar workers', { error: e && e.message || String(e) });
  }
  const plan = planMemoryAndShards({ totalProfiles: names.length });
  const nodes = Math.max(1, Number(plan && plan.nodes) || 1);
  return {
    nodes,
    totalMB: plan.totalMB,
    divisorGb: plan.serverConfig && plan.serverConfig.workerRamDivisorGb,
    hardwareNodes: plan.serverConfig && plan.serverConfig.hardwareNodes,
    profiles: names.length
  };
}

function shardIndex1FromEnv() {
  const raw = process.env.WORKER_SHARD_INDEX;
  const idx = Number(raw);
  if (!Number.isFinite(idx) || idx < 0) return null;
  return idx + 1;
}

function resolveWorkerExeOrFatal() {
  if (String(process.env.IS_WORKER_CHILD || '') !== '1') {
    fatal('launch de conta so no worker. Sem fallback ao Chrome unificado.');
  }
  const n = shardIndex1FromEnv();
  if (!n) fatal('WORKER_SHARD_INDEX ausente ou invalido no worker');
  const exe = motorExe(n);
  if (!fs.existsSync(exe)) {
    fatal('motor ausente para este worker. Boot abortado.', { worker: n, exe });
  }
  const expected = String(process.env.CHROME_MOTOR_EXE || '').trim();
  if (expected && path.normalize(expected).toLowerCase() !== path.normalize(exe).toLowerCase()) {
    fatal('CHROME_MOTOR_EXE nao bate com o motor deste worker', { worker: n, exe, expected });
  }
  return exe;
}

function resolveLaunchExeOrFatal() {
  return resolveWorkerExeOrFatal();
}

function ensureWorkers(workerCount, { purge = false } = {}) {
  const n = Math.max(1, Math.floor(Number(workerCount) || 0));
  if (!n) fatal('quantidade de workers invalida');

  let purgeInfo = null;
  if (purge) purgeInfo = hardPurgeChrome();

  const masterExe = findMasterChromeExe();
  if (!masterExe) {
    fatal('Chrome mestre do Windows nao encontrado em Program Files / LocalAppData');
  }
  const masterVer = readExeVersion(masterExe);
  if (!masterVer || !masterVer.full) {
    fatal('nao consegui ler a versao do Chrome mestre', { masterExe });
  }
  const masterDir = path.dirname(masterExe);

  try {
    fs.mkdirSync(MOTORES_ROOT, { recursive: true });
  } catch (e) {
    fatal('nao consegui criar C:\\conveniente\\motores', { error: e && e.message || String(e) });
  }

  const cloned = [];
  const reused = [];
  for (let i = 1; i <= n; i++) {
    const dest = motorDir(i);
    const exe = motorExe(i);
    let need = true;
    if (fs.existsSync(exe)) {
      const local = readExeVersion(exe);
      if (local && local.full === masterVer.full) {
        need = false;
        reused.push(i);
      }
    }
    if (need) {
      cloneMasterTo(dest, masterDir, masterVer);
      cloned.push(i);
    }
  }

  const deleted = deleteObsoleteMotors(n);
  const engines = [];
  for (let i = 1; i <= n; i++) {
    const exe = motorExe(i);
    if (!fs.existsSync(exe)) fatal('motor faltando apos sync', { worker: i, exe });
    const ver = readExeVersion(exe);
    if (!ver || ver.full !== masterVer.full) {
      fatal('motor com versao divergente apos sync', { worker: i, master: masterVer.full, clone: ver && ver.full || null });
    }
    engines.push({ worker: i, exe, version: ver.full });
  }

  const rec = {
    ok: true,
    kind: 'multi_engine',
    tag: 'MULTI_ENGINE_OK',
    ts: Date.now(),
    iso: new Date().toISOString(),
    hostname: os.hostname(),
    nodes: n,
    masterExe,
    masterVersion: masterVer.full,
    cloned,
    reused,
    deletedObsolete: deleted,
    purged: !!purge,
    purgeInfo,
    engines,
    userDataDirPolicy: 'User Data\\Conveniente\\<nome> intacto'
  };
  writeLast(rec);
  try {
    logger.info('[MULTI_ENGINE_OK]', {
      ts: rec.iso,
      motores: n,
      versao: masterVer.full,
      clonados: cloned.join(',') || '0',
      reuso: reused.join(',') || '0'
    });
  } catch {}
  try { console.log('[MULTI_ENGINE_OK] ' + rec.iso + ' motores=' + n + ' versao=' + masterVer.full); } catch {}
  return rec;
}

function bootFromCli() {
  try {
    const plan = planWorkerCount();
    const rec = ensureWorkers(plan.nodes, { purge: true });
    rec.plan = plan;
    writeLast(rec);
    process.exit(0);
  } catch (e) {
    writeLast({
      ok: false,
      kind: 'multi_engine',
      tag: 'MULTI_ENGINE_FATAL',
      ts: Date.now(),
      iso: new Date().toISOString(),
      hostname: os.hostname(),
      error: String(e && e.message || e)
    });
    process.exit(1);
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--boot')) bootFromCli();
  else {
    console.error('uso: node scripts/chromeMotores.js --boot');
    process.exit(2);
  }
}

module.exports = {
  MOTORES_ROOT,
  LAST_PATH,
  motorDir,
  motorExe,
  findMasterChromeExe,
  readExeVersion,
  planWorkerCount,
  ensureWorkers,
  hardPurgeChrome,
  resolveWorkerExeOrFatal,
  resolveLaunchExeOrFatal,
  shardIndex1FromEnv
};
