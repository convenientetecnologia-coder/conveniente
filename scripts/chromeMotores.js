'use strict';

/**
 * Chrome unico: todos os workers usam o chrome.exe oficial do Windows.
 * userDataDir das contas permanece no cofre (User Data\\Conveniente\\<nome>).
 * Nao clona pasta em C:\\conveniente\\motores.
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
const LOG_PATH = path.join(__dirname, '..', 'dados', 'logs', 'multi_engine.log');

function say(line) {
  const text = String(line || '');
  try { console.log(text); } catch {}
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(LOG_PATH, ts + ' ' + text + '\n', 'utf8');
  } catch {}
}

function fatal(msg, extra) {
  const text = 'MULTI_ENGINE_FATAL: ' + String(msg || 'falha');
  try { logger.error(text, extra && typeof extra === 'object' ? extra : {}); } catch {}
  try {
    if (extra && typeof extra === 'object') console.error(text + ' ' + JSON.stringify(extra));
    else console.error(text);
  } catch {
    try { console.error(text); } catch {}
  }
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

function taskkillIm(image) {
  try {
    spawnSync('taskkill', ['/F', '/IM', String(image)], { windowsHide: true, timeout: 20000 });
  } catch {}
}

function killChromeFamily() {
  taskkillIm('chrome.exe');
  taskkillIm('crashpad_handler.exe');
  taskkillIm('GoogleCrashHandler.exe');
  taskkillIm('GoogleCrashHandler64.exe');
}

function killProcessesTouching(dir) {
  const target = String(dir || '').trim();
  if (!target) return;
  const needle = target.toLowerCase().replace(/'/g, "''");
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('" +
    needle +
    "') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    spawnSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      windowsHide: true,
      timeout: 25000
    });
  } catch {}
}

function clearReadOnlyTree(dir) {
  const target = String(dir || '');
  if (!target || !fs.existsSync(target)) return;
  const attrib = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'attrib.exe');
  try {
    spawnSync(attrib, ['-R', path.join(target, '*'), '/S', '/D'], { windowsHide: true, timeout: 60000 });
  } catch {}
}

function rmdirViaCmd(dir) {
  const target = String(dir || '');
  if (!target) return;
  try {
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'rmdir', '/s', '/q', target], {
      windowsHide: true,
      timeout: 120000
    });
  } catch {}
}

function errText(e) {
  if (!e) return 'locked';
  const code = e.code ? String(e.code) : '';
  const msg = e.message ? String(e.message) : String(e);
  return (code ? code + ' ' : '') + msg;
}

function rmDirBestEffort(dir) {
  const target = String(dir || '');
  if (!target) return { ok: true, leftover: false };
  if (!fs.existsSync(target)) return { ok: true, leftover: false };
  let lastErr = null;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      clearReadOnlyTree(target);
      killChromeFamily();
      killProcessesTouching(target);
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      if (!fs.existsSync(target)) return { ok: true, leftover: false };
    } catch (e) {
      lastErr = e;
    }
    rmdirViaCmd(target);
    if (!fs.existsSync(target)) return { ok: true, leftover: false };
    sleepMs(800);
  }
  return {
    ok: false,
    leftover: fs.existsSync(target),
    error: errText(lastErr)
  };
}

function renameAside(dir) {
  const target = String(dir || '');
  if (!target || !fs.existsSync(target)) return null;
  const trash = target + '.__trash__' + Date.now();
  try {
    fs.renameSync(target, trash);
    return trash;
  } catch {
    return null;
  }
}

function sweepTrashMotors() {
  try {
    if (!fs.existsSync(MOTORES_ROOT)) return;
    for (const name of fs.readdirSync(MOTORES_ROOT)) {
      if (!/^w\d+\.__trash__/i.test(name) && !/^w\d+\.__new__/i.test(name)) continue;
      const full = path.join(MOTORES_ROOT, name);
      const r = rmDirBestEffort(full);
      if (r && r.leftover) say('[MULTI_ENGINE] lixo residual ' + name + ' (best-effort)');
    }
  } catch {}
}

function pruneForeignVersionDirs(destDir, keepFull) {
  const keep = String(keepFull || '');
  let names = [];
  try { names = fs.readdirSync(destDir); } catch { return; }
  for (const name of names) {
    const parsed = parseVersionToken(name);
    if (!parsed || parsed.full === keep) continue;
    const full = path.join(destDir, name);
    let isDir = false;
    try { isDir = fs.statSync(full).isDirectory(); } catch {}
    if (!isDir) continue;
    const r = rmDirBestEffort(full);
    if (r && r.leftover) {
      say('[MULTI_ENGINE] versao antiga ficou ' + name + ' (nao bloqueia) ' + (r.error || ''));
    }
  }
}

function hardPurgeChrome() {
  killChromeFamily();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const n = chromeProcessCount();
    if (n === 0) return { ok: true, leftover: 0 };
    killChromeFamily();
    sleepMs(400);
  }
  const leftover = chromeProcessCount();
  if (leftover > 0) {
    fatal('chrome.exe ainda vivo apos taskkill. Nao posso clonar motores com arquivo preso.', { leftover });
  }
  return { ok: true, leftover: 0 };
}

function verifyMotorDir(destDir, masterVer) {
  const exe = path.join(destDir, 'chrome.exe');
  if (!fs.existsSync(exe)) return { ok: false, reason: 'sem chrome.exe' };
  const ver = readExeVersion(exe);
  if (!ver || !ver.full || ver.full !== masterVer.full) {
    return { ok: false, reason: 'versao', clone: ver && ver.full || null };
  }
  return { ok: true, ver };
}

function copyMasterOnto(destDir, masterDir) {
  fs.mkdirSync(destDir, { recursive: true });
  clearReadOnlyTree(destDir);
  try {
    fs.cpSync(masterDir, destDir, { recursive: true, force: true, errorOnExist: false });
    return;
  } catch (e) {
    const r = spawnSync('robocopy', [
      masterDir,
      destDir,
      '/E', '/IS', '/IT', '/R:4', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS'
    ], { windowsHide: true, timeout: 180000 });
    const code = r && r.status != null ? Number(r.status) : 16;
    if (code >= 0 && code < 8) return;
    throw e;
  }
}

function freeMotorSlot(destDir) {
  const gone = rmDirBestEffort(destDir);
  if (!fs.existsSync(destDir)) return { ok: true, how: 'rm' };
  killChromeFamily();
  killProcessesTouching(destDir);
  sleepMs(500);
  const trash = renameAside(destDir);
  if (trash && !fs.existsSync(destDir)) return { ok: true, how: 'rename', trash };
  return {
    ok: false,
    how: 'locked',
    error: gone && gone.error ? gone.error : 'pasta presa (Explorer/AV/chrome)',
    trash: trash || null
  };
}

function cloneMasterTo(destDir, masterDir, masterVer) {
  try {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
  } catch (e) {
    fatal('nao consegui criar C:\\conveniente\\motores', { error: e && e.message || String(e) });
  }

  killChromeFamily();
  killProcessesTouching(destDir);

  let lastErr = null;
  const overlayDeadline = Date.now() + 90000;
  while (Date.now() < overlayDeadline) {
    try {
      copyMasterOnto(destDir, masterDir);
      const checked = verifyMotorDir(destDir, masterVer);
      if (checked.ok) {
        pruneForeignVersionDirs(destDir, masterVer.full);
        return checked.ver;
      }
      lastErr = new Error(checked.reason + (checked.clone ? ' clone=' + checked.clone : ''));
    } catch (e) {
      lastErr = e;
    }
    say('[MULTI_ENGINE] overlay falhou em ' + destDir + ' :: ' + errText(lastErr) + ' — tentando esvaziar a pasta');
    const freed = freeMotorSlot(destDir);
    if (!freed.ok) {
      fatal('nao consegui limpar pasta do motor (permissao ou arquivo preso)', {
        dir: destDir,
        error: freed.error || errText(lastErr)
      });
    }
    sleepMs(400);
  }

  fatal('copia do Chrome mestre falhou (permissao ou disco)', {
    from: masterDir,
    to: destDir,
    error: errText(lastErr)
  });
}

function deleteObsoleteMotors(keepN) {
  const n = Math.max(1, Number(keepN) || 1);
  const extras = [];
  for (const idx of listMotorIndexes()) {
    if (idx <= n) continue;
    const dir = motorDir(idx);
    const r = rmDirBestEffort(dir);
    if (r && r.leftover) {
      const trash = renameAside(dir);
      if (fs.existsSync(dir)) {
        say('[MULTI_ENGINE] nao apaguei motor extra w' + idx + ' (best-effort, nao aborta) ' + (r.error || ''));
        continue;
      }
      if (trash) say('[MULTI_ENGINE] motor extra w' + idx + ' movido para lixo ' + path.basename(trash));
    }
    extras.push(idx);
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
    fatal('launch de conta so no worker.');
  }
  const exe = findMasterChromeExe();
  if (!exe || !fs.existsSync(exe)) {
    fatal('Chrome oficial do Windows nao encontrado em Program Files / LocalAppData');
  }
  return exe;
}

function resolveLaunchExeOrFatal() {
  return resolveWorkerExeOrFatal();
}

function ensureWorkers(capacity, { purge = false } = {}) {
  let purgeInfo = null;
  if (purge) purgeInfo = hardPurgeChrome();

  const masterExe = findMasterChromeExe();
  if (!masterExe) {
    fatal('Chrome oficial do Windows nao encontrado em Program Files / LocalAppData');
  }
  const masterVer = readExeVersion(masterExe);
  if (!masterVer || !masterVer.full) {
    fatal('nao consegui ler a versao do Chrome oficial', { masterExe });
  }

  const rec = {
    ok: true,
    kind: 'single_engine',
    tag: 'MULTI_ENGINE_OK',
    ts: Date.now(),
    iso: new Date().toISOString(),
    hostname: os.hostname(),
    capacity: 1,
    nodes: Math.max(1, Math.floor(Number(capacity) || 1)),
    masterExe,
    masterVersion: masterVer.full,
    cloned: [],
    reused: [1],
    deletedObsolete: [],
    purged: !!purge,
    purgeInfo,
    engines: [{ worker: 1, exe: masterExe, version: masterVer.full }],
    userDataDirPolicy: 'User Data\\Conveniente\\<nome> intacto'
  };
  writeLast(rec);
  try {
    logger.info('[MULTI_ENGINE_OK]', {
      ts: rec.iso,
      kind: 'single_engine',
      versao: masterVer.full,
      exe: masterExe
    });
  } catch {}
  say('[CHROME] oficial ' + rec.iso + ' versao=' + masterVer.full + ' exe=' + masterExe);
  return rec;
}

function bootFromCli() {
  try {
    const plan = planWorkerCount();
    const capacity = Math.max(1, Number(plan.hardwareNodes) || Number(plan.nodes) || 1);
    const rec = ensureWorkers(capacity, { purge: true });
    rec.plan = plan;
    rec.liveWorkers = plan.nodes;
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
