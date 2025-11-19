// scripts/worker.js
const path = require('path');
const fs = require('fs');
const logger = require('./logger.js');
const { detectLimitOverlayDeep, detectLimitOverlayEverywhere } = require('./browser.js');

const browserHelper = require('./browser.js');
const virtusHelper = require('./virtus.js');
const robeHelper   = require('./robe.js');
const robeQueue    = require('./robeQueue.js');
const utils        = require('./utils.js');
const fotos        = require('./fotos.js');

const issues = require('./issues.js');
const manifestStore = require('./manifestStore.js');
const fileStore = require('./fileStore.js');

const _profileOpLocks = new Map();
async function lockProfileAction(nome, fn) {
  if (!nome) return fn();
  const prev = _profileOpLocks.get(nome) || Promise.resolve();
  let resolveNext;
  const next = new Promise(res => resolveNext = res);
  _profileOpLocks.set(nome, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    resolveNext();
    if (_profileOpLocks.get(nome) === next) _profileOpLocks.delete(nome);
  }
}

async function readAccountFlags(nome) {
  try {
    const m = await manifestStore.read(nome).catch(()=>null);
    return (m && m.accountFlags) ? m.accountFlags : {};
  } catch { return {}; }
}

async function setLoginRequiredFlag(nome, { reason = '', source = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.loginRequired === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.loginRequired = true;
      man.accountFlags.loginReason = String(reason||'');
      man.accountFlags.loginSource = String(source||'');
      man.accountFlags.lastLoginRequiredAt = Date.now();
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'login_required_detected',
        `reason=${reason||''} source=${source||''} at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].loginRequired = true;
    robeMeta[nome].loginReason = reason || '';
  } catch {}
}

async function setBannedFlag(nome, { reason = '', snippet = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.banned === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.banned = true;
      man.accountFlags.bannedAt = Date.now();
      man.accountFlags.bannedReason = String(reason||'');
      man.accountFlags.bannedText = String(snippet||'').slice(0, 400);
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'account_banned_detected',
        `reason=${reason||''} snippet="${(snippet||'').slice(0,120)}" at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].banned = true;
  } catch {}
}

async function clearAccountFlags(nome, which = ['loginRequired','banned']) {
  try {
    const prev = await readAccountFlags(nome);
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      if (which.includes('loginRequired')) {
        if (man.accountFlags.loginRequired || man.accountFlags.loginReason || man.accountFlags.loginSource) {
          delete man.accountFlags.loginRequired;
          delete man.accountFlags.loginReason;
          delete man.accountFlags.loginSource;
          delete man.accountFlags.lastLoginRequiredAt;
        }
      }
      if (which.includes('banned')) {
        if (man.accountFlags.banned || man.accountFlags.bannedAt || man.accountFlags.bannedReason || man.accountFlags.bannedText) {
          delete man.accountFlags.banned;
          delete man.accountFlags.bannedAt;
          delete man.accountFlags.bannedReason;
          delete man.accountFlags.bannedText;
        }
      }
      if (Object.keys(man.accountFlags).length === 0) delete man.accountFlags;
      return man;
    });
    if (which.includes('loginRequired') && (prev && prev.loginRequired)) {
      await issues.append(nome, 'login_required_cleared', `at=${new Date().toISOString()}`);
    }
    if (which.includes('banned') && (prev && prev.banned)) {
      await issues.append(nome, 'account_banned_cleared', `at=${new Date().toISOString()}`);
    }
    robeMeta[nome] = robeMeta[nome] || {};
    if (which.includes('loginRequired')) {
      delete robeMeta[nome].loginRequired;
      delete robeMeta[nome].loginReason;
    }
    if (which.includes('banned')) delete robeMeta[nome].banned;
    await snapshotStatusAndWrite();
  } catch {}
}

const SHARD_PROFILES = (() => { try { return JSON.parse(process.env.SHARD_PROFILES || '[]'); } catch { return []; }})();
let SHARD_SET = new Set(Array.isArray(SHARD_PROFILES) ? SHARD_PROFILES : []);
const STATUS_FILE_NAME = process.env.STATUS_FILE_NAME || 'status.json';

function inShard(nome) { return SHARD_SET.size === 0 ? true : SHARD_SET.has(nome); }

async function isLimitPostingActive(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil || 0) > Date.now());
  } catch { return false; }
}

function isLimitPostingRes(res) {
  return !!(res && (res.limitPosting === true || res.error === 'limit_posting' || res.HALT === true));
}

async function detectFbLimitInAnyPage(ctrl) {
  try {
    if (!ctrl || !ctrl.browser || typeof ctrl.browser.pages !== 'function') return false;
    const pages = await ctrl.browser.pages();
    for (const p of pages) {
      try {
        const url = p.url ? p.url() : '';
        if (/facebook\.com\/marketplace\/(create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(url)) {
          const deep = await detectLimitOverlayDeep(p, { alsoCheckFrames: true });
          if (deep && deep.blocked) return true;
          const det = await require('./browser.js').detectMessengerTempBlock(p);
          if (det && det.blocked && det.domain === 'facebook') return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

const pidusage = require('pidusage');
const psList = require('ps-list');

const supervisorClient = require('./supervisorClient.js');
const { getAvailableMB } = utils;

const HEALTH_CFG = {
  TICK_MS: 10000,
  DEAD_NO_EVENT_MS: 45000,
  DEAD_NO_DOM_MS: 45000,
  DEAD_NO_NET_MS: 60000,
  RECOVERY_COOLDOWN_MS: {
    reload: 30000,
    navHome: 45000,
    newPage: 60000
  },
  SUCCESS_RESET_MS: 20000,
  MAX_SOFT_RELOADS_10MIN: 2,
  MAX_NAVHOME_10MIN: 2,
  MAX_NEWPAGE_30MIN: 2,
  ESCALATE_TO_REOPEN_AFTER: 2,
  ABOUT_BLANK_GRACE_MS: 7000
};

const PHANTOM_CFG = {
  INITIAL_GRACE_MS: 9000,
  PERSIST_MS: 20000,
  CHECK_INTERVAL_MS: 5000,
  COOLDOWN_BETWEEN_TRIES_MS: 30000,
  MAX_PHTM_RELOADS_10M: 2,
  MAX_PHTM_NAV_10M: 2,
  MAX_PHTM_NEWPAGE_30M: 2,
  ESCALATE_AFTER_STEPS: 2
};
function _prune(arr, ms) {
  const now = Date.now();
  return (arr||[]).filter(ts => (now - ts) < ms);
}
function getPhantomState(nome) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].phantom = robeMeta[nome].phantom || {
    firstSeenAt: 0,
    lastOkAt: 0,
    lastActionAt: 0,
    actions10m: [],
    navs10m: [],
    reloads10m: [],
    newpages30m: [],
    failures: 0
  };
  return robeMeta[nome].phantom;
}
async function evaluateChatsState(page) {
  try {
    const res = await page.evaluate(() => {
      const norm = (s) => (s||'').toLowerCase();
      let grid = Array.from(document.querySelectorAll('div[role="grid"]'))
      .find(g => {
        const al = (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby') || '');
        const t = norm(al);
        return t.includes('conversas') || t.includes('conversations');
      });
      if (!grid) {
        const pagelet = document.querySelector('div[data-pagelet="MWThreadList"]');
        if (pagelet) {
          const g2 = pagelet.querySelector('div[role="grid"]');
          if (g2) grid = g2;
        }
      }
      let rows = 0, anchors = 0, skeletons = 0;
      if (grid) {
        rows = grid.querySelectorAll('div[role="row"]').length;
        anchors = grid.querySelectorAll('a[href^="/marketplace/t/"]').length;
        skeletons = grid.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      } else {
        skeletons = document.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      }
      return { hasGrid: !!grid, rows, anchors, skeletons };
    });
    return res || { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  } catch {
    return { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  }
}
function isPhantomFromSnapshot(snap) {
  const noThreads = (snap.rows === 0 && snap.anchors === 0);
  if (noThreads && snap.skeletons > 0) return true;
  return false;
}
function isOkFromSnapshot(snap) {
  return (snap.rows > 0 || snap.anchors > 0);
}
async function tryFixPhantom(nome, page) {
  const ctrlGuard = controllers.get(nome);
  if (ctrlGuard && (ctrlGuard.humanControl === true || ctrlGuard.configurando === true)) return false;
  const ph = getPhantomState(nome);
  const now = Date.now();
  ph.actions10m = _prune(ph.actions10m, 10601000);
  ph.navs10m = _prune(ph.navs10m, 10601000);
  ph.reloads10m = _prune(ph.reloads10m, 10601000);
  ph.newpages30m = _prune(ph.newpages30m, 30601000);

  if ((now - ph.lastActionAt) < PHANTOM_CFG.COOLDOWN_BETWEEN_TRIES_MS) return false;

  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || ctrl.configurando) return false;
  if (robeMeta[nome] && robeMeta[nome].emExecucao) return false;

  if (ph.navs10m.length < PHANTOM_CFG.MAX_PHTM_NAV_10M) {
    try {
      await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
      ph.navs10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:navHome');
      return true;
    } catch {}
  }
  if (ph.reloads10m.length < PHANTOM_CFG.MAX_PHTM_RELOADS_10M) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      ph.reloads10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:reload');
      return true;
    } catch {}
  }
  if (ph.newpages30m.length < PHANTOM_CFG.MAX_PHTM_NEWPAGE_30M) {
    try {
      const ctrl2 = controllers.get(nome);
      const np = await ctrl2.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        await browserHelper.patchPage(nome, np, utils.getCoords(man && man.cidade || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl2.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl2.mainPage = np;
      await wirePageObservers(nome, np);
      ph.newpages30m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:newPage');
      return true;
    } catch {}
  }
  ph.failures = (ph.failures || 0) + 1;
  await issues.append(nome, 'mil_action', `phantom_escalate:reopen failures=${ph.failures}`);
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return true;
  }
  await handlers.deactivate({ nome, reason: 'phantom_reopen', policy: 'preserveDesired' });
  setKillGuard(nome);
  ph.lastActionAt = now;
  return true;
}

const healthState = new Map();
function getHealth(nome) {
  const now = Date.now();
  if (!healthState.has(nome)) {
    healthState.set(nome, {
      lastOkAt: 0, lastDomEventAt: 0, lastNetEventAt: 0, lastConsoleErrorAt: 0,
      lastUrl: '', lastTitle: '', stage: 'ok', nextTryAt: 0,
      counters: { softReloads10m: [], navHomes10m: [], newPages30m: [], cyclesWithoutLife: 0 },
      newPageInFlight: false,
      lastNewPageAt: 0
    });
  }
  return healthState.get(nome);
}
function _pruneWindow(arr, ms) {
  const now = Date.now();
  return arr.filter(ts => (now - ts) < ms);
}

const os = require('os');
const AUTO_CFG = {
  MEM_ENTER_MB: 2048,
  MEM_EXIT_MB: 3072,
  CPU_ENTER: 85,
  CPU_EXIT: 70,
  EMA_ALPHA_CPU: 0.30,
  EMA_ALPHA_MEM: 0.20,
  HOT_TICKS: 3,
  COOL_TICKS: 3,
  MIN_HOLD_MS: 45000,
  ROBE_LIGHT_MIN_SPACING_MS: 60000,
  RAM_KILL_MB: 1600,
  RAM_WARN_MB: 700
};

// NOVO: RAM mínima dinâmica - 2GB base + 500MB por node ativo (garante que robes possam trabalhar simultaneamente)
function getOpenMinFreeMB() {
  const baseMB = 2048; // 2GB base
  const activeNodes = robeQueue.activeCount(); // 0 ou 1 atualmente (pode aumentar no futuro)
  const perNodeMB = 500; // 500MB por node ativo
  return baseMB + (activeNodes * perNodeMB);
}
const OPEN_MIN_FREE_MB_STATIC = parseInt(process.env.OPEN_MIN_FREE_MB || '2048', 10); // Mantido para compatibilidade
const HEADROOM_AFTER_OPEN_MB = parseInt(process.env.HEADROOM_AFTER_OPEN_MB || '0', 10);
const TARGET_ALIVE = parseInt(process.env.TARGET_ALIVE || '0', 10);

const autoMode = {
  mode: 'full', since: Date.now(), reason: 'supervisor_controlled',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }

let _statusLock = Promise.resolve();

async function milLog(type, msg) {
  try { await reportAction('system', type || 'mil_action', String(msg || '')); } catch {}
}

let opening = {};

async function killPids(pids = []) {
  for (const pid of (pids || [])) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function killProcessTreeByRootPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      await new Promise(res=>{
        execFile('powershell.exe', ['-NoProfile','-Command', `
$parent = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; 
if ($parent) {
  $queue = @($parent);
  for ($i=0; $i -lt $queue.Count; $i++) {
    $cur = $queue[$i];
    $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $cur.ProcessId };
    $queue += $children;
  }
  $queue | Sort-Object -Property ProcessId -Descending | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }
}
        `], {stdio:'ignore'}, ()=>res());
      });
    } else {
      return;
    }
  } catch {}
}

async function killStrayChromes() {
  try {
    if (process.platform !== 'win32') {
      return;
    }
    const perfisArr = loadPerfisJson();
    const nomeByDir = {};
    for (const p of perfisArr) {
      if (p && p.nome && p.userDataDir) nomeByDir[normalizePath(p.userDataDir)] = p.nome;
    }
    const procs = await psList().catch(()=>[]);
    const group = {};
    for (const proc of procs) {
      const cmd = proc.cmd || proc.command || '';
      if (!/chrome|chromium/i.test(cmd)) continue;
      const userDir = extractUserDataDir(cmd);
      if (!userDir) continue;
      const nome = nomeByDir[normalizePath(userDir)];
      if (!nome) continue;
      if (controllers.has(nome)) continue;
      if (!group[nome]) group[nome] = [];
      group[nome].push(Number(proc.pid));
    }
    for (const [nome, pidList] of Object.entries(group)) {
      if (opening[nome]) {
        await milLog('mil_action', `stray_skip_opening: ${nome} pids=${pidList.join(',')}`);
        continue;
      }
      if (!pidList || !pidList.length) continue;
      await milLog('mil_action', `stray_kill: ${nome} pids=${pidList.join(',')}`);
      await killPids(pidList);
    }
  } catch {}
}

try {
  logger.info('[WORKER][BOOT]', {
    pid: process.pid,
    execPath: process.execPath,
    versions: process.versions,
    npm_node_execpath: process.env.npm_node_execpath || '',
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '',
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd()
  });
} catch (e) {
  try { logger.warn('[WORKER][BOOT] log error', { error: e && e.message || e }); } catch {}
}
try {
  logger.info(`[WORKER][BOOT][SHARD] pid=${process.pid} shardSize=${SHARD_SET.size}`);
} catch {}

setImmediate(() => { try { snapshotStatusAndWrite().catch(()=>{}); } catch {} });

const perfisPath = path.join(__dirname, '../dados', 'perfis.json');
const presetsPath = path.join(__dirname, '../dados', 'ua_presets.json');
const perfisDir = path.join(__dirname, '../dados', 'perfis');

const desiredPath = path.join(__dirname, '../dados', 'desired.json');
const statusPath  = path.join(__dirname, '../dados', STATUS_FILE_NAME);

function readJsonFile(file, fallback) {
try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
try {
const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const tmp = file + '.tmp';
const fd = fs.openSync(tmp, 'w');
try {
  fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
try { fs.unlinkSync(file); } catch {}
try { fs.renameSync(tmp, file); }
catch {
fs.copyFileSync(tmp, file);
try { fs.unlinkSync(tmp); } catch {}
}
return true;
} catch {
return false;
}
}
function ensureDesired() {
try {
if (!fs.existsSync(desiredPath)) writeJsonAtomic(desiredPath, { perfis: {} });
} catch {}
}

function manifestPathOf(nome) {
  const perfisArr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  return path.join(perfil.userDataDir, 'manifest.json');
}

async function freezeCooldownIfNotWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (working && !humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if (m.robeCooldownUntil && m.robeCooldownUntil > now) {
        m.robeCooldownRemainingMs = m.robeCooldownUntil - now;
        m.robeCooldownUntil = 0;
      }
      return m;
    });
  } catch {}
}

async function unfreezeCooldownIfWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (!working || humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if ((m.robeCooldownUntil || 0) <= now) {
        const remaining = Number(m.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          m.robeCooldownUntil = now + remaining;
          m.robeCooldownRemainingMs = 0;
        }
      }
      return m;
    });
  } catch {}
}

const ERROR_TYPES = new Set(['robe_error', 'robe_no_photo', 'virtus_blocked', 'virtus_no_composer', 'virtus_send_failed']);

function countErrorsLocal(nome) {
  try {
    const file = path.join(perfisDir, nome, 'issues.json');
    const arr = readJsonFile(file, []);
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const it of arr) {
      const t = (it && it.type) ? String(it.type) : '';
      if (ERROR_TYPES.has(t)) n++;
    }
    return n;
  } catch { return 0; }
}

async function ensureManifestValid(nome) {
  function hasEssentials(man) {
    return man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
  }
  let manifest = await manifestStore.read(nome).catch(()=>null);
  if (manifest && hasEssentials(manifest)) return manifest;
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (perfil && hasEssentials(perfil)) {
      const merged = Object.assign({}, perfil, manifest || {});
      if (merged.userDataDir && !fs.existsSync(merged.userDataDir)) {
        fs.mkdirSync(merged.userDataDir, { recursive: true });
      }
      await manifestStore.update(nome, () => merged);
      return merged;
    }
  } catch {}
  return null;
}

async function computeManifestStatus(nome) {
  try {
    const man = await manifestStore.read(nome);
    if (!man) return 'unknown';
    const ok = man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
    return ok ? 'ok' : 'incomplete';
  } catch { return 'unknown'; }
}

async function reportAction(nome, type, message) {
try {
if (!nome) return;
if (!issues || typeof issues.append !== 'function') return;
const msg = String(message == null ? '' : message).slice(0, 400);
await issues.append(nome, type, msg);
} catch {}
}

const controllers = new Map();

const robeMeta = {};

function memorySweep() {
  try {
    const nomesValidos = new Set(loadPerfisJson().map(p => p.nome));
    for (const [n] of healthState) if (!nomesValidos.has(n) && !controllers.has(n)) healthState.delete(n);
    for (const [n] of profileFailures) if (!nomesValidos.has(n) && !controllers.has(n)) profileFailures.delete(n);
    for (const n of Object.keys(robeMeta)) {
      if (!nomesValidos.has(n) && !controllers.has(n)) delete robeMeta[n];
    }
  } catch {}
}
setInterval(memorySweep, 10 * 60 * 1000);

function killGuardActive(nome) {
  return robeMeta[nome]?.killGuardUntil && robeMeta[nome].killGuardUntil > Date.now();
}
function setKillGuard(nome, ms=90000) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].killGuardUntil = Date.now() + ms;
}

try {
  const perfisArr = loadPerfisJson();
  for (const p of perfisArr) {
    if (p && p.nome && p.userDataDir) {
      const manifestPath = path.join(p.userDataDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (man.frozenUntil && man.frozenUntil > Date.now()) {
          robeMeta[p.nome] = robeMeta[p.nome] || {};
          robeMeta[p.nome].frozenUntil = man.frozenUntil;
          if (man.frozenReason) robeMeta[p.nome].frozenReason = man.frozenReason;
          if (man.frozenAt) robeMeta[p.nome].frozenAt = man.frozenAt;
          if (man.frozenSetBy) robeMeta[p.nome].frozenSetBy = man.frozenSetBy;
        }
      }
    }
  }
} catch (err) {
  try { logger.warn('[BOOT] Erro ao repopular frozenUntil dos manifests', { error: err && err.message || err }); } catch {}
}

const _issuesAppendOrig = issues && issues.append ? issues.append.bind(issues) : null;
if (_issuesAppendOrig) {
  issues.append = async function(nome, type, msg) {
    try {
      const now = Date.now();
      let url = '', readyState = '', pagesCount = 0;
      let deltaDom = '', deltaNet = '';
      let healthStage = '';
      let killGuardUntil = robeMeta[nome]?.killGuardUntil || 0;
      let recoveryHysteresisUntil = robeMeta[nome]?.recoveryHysteresisUntil || 0;
      let blockHysteresisUntil = robeMeta[nome]?.blockHysteresisUntil || 0;
      let strikes = 0;

      const ctrl = controllers.get(nome);
      let page = null;
      if (ctrl && ctrl.browser) {
        try {
          const pages = await ctrl.browser.pages().catch(()=>[]);
          pagesCount = Array.isArray(pages) ? pages.length : 0;
          if (pages && pages[0]) page = pages[0];
        } catch {}
      }
      if (page) {
        try { url = typeof page.url === 'function' ? (page.url() || '') : ''; } catch {}
        try {
          readyState = await Promise.race([
            (async () => await page.evaluate(() => document.readyState).catch(()=>''))(),
            new Promise(res => setTimeout(()=>res(''), 300))
          ]);
        } catch {}
      }
      const st = getHealth && getHealth(nome);
      if (st) {
        healthStage = st.stage || '';
        if (st.lastDomEventAt) deltaDom = String(now - st.lastDomEventAt);
        if (st.lastNetEventAt) deltaNet = String(now - st.lastNetEventAt);
      }
      const rm = robeMeta[nome] || {};
      strikes = rm.noPagesStrikes || rm.zombieStrikes || (Array.isArray(rm.blockDetectWindow) ? rm.blockDetectWindow.length : 0) || 0;

      const extra = ` url=${url||''} readyState=${readyState||''} deltaDom=${deltaDom} deltaNet=${deltaNet} pagesCount=${pagesCount} strikes=${strikes} killGuardUntil=${killGuardUntil||0} recoveryHysteresisUntil=${recoveryHysteresisUntil||0} blockHysteresisUntil=${blockHysteresisUntil||0} healthStage=${healthStage||''}`;
      const newMsg = (msg == null ? '' : String(msg)) + extra;
      return await _issuesAppendOrig(nome, type, newMsg);
    } catch (e) {
      try { return await _issuesAppendOrig(nome, type, msg); } catch {}
    }
  };
}

function isFrozenNow(nome) {
  const now = Date.now();
  const inMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
  let inDisk = 0;
  try {
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (man && typeof man.frozenUntil === 'number') inDisk = man.frozenUntil;
    }
  } catch {}
  const until = Math.max(inMem, inDisk || 0);
  return until > now ? until : 0;
}

const activationLocks = new Map();

async function activateOnce(nome, source = '') {
  if (opening[nome]) return { ok: false, error: 'already_opening' };

  if (controllers.has(nome)) {
    return { ok: true, already: true };
  }

  const inflight = activationLocks.get(nome);
  if (inflight) {
    try { await inflight.catch(() => {}); } catch {}
    return controllers.has(nome)
      ? { ok: true, already: true }
      : { ok: false, error: 'activation_in_progress' };
  }

  opening[nome] = true;
  let _supervisorSlotGranted = false;
  try {
    if (SHARD_SET.size && !inShard(nome)) {
      await reportAction(nome, 'mil_action', 'activate_skip_wrong_shard');
      logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=false size=${SHARD_SET.size}`);
      return { ok: false, error: 'wrong_shard' };
    }
    logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=${inShard(nome)} size=${SHARD_SET.size}`);

    if (killGuardActive(nome)) {
      await reportAction(nome, 'guard_skip_open', 'Abertura negada por kill_guard_until');
      return { ok:false, error:"kill_guard_until" };
    }

    try {
      const desired = readJsonFile(desiredPath, { perfis: {} });
      if (desired && desired.perfis && desired.perfis[nome] && desired.perfis[nome].humanHold === true) {
        await reportAction(nome, 'mil_action', 'activate_skip_human_hold');
        return { ok: false, error: 'human_hold' };
      }
    } catch {}

    const slotResp = await supervisorClient.requestOpen(nome).catch(()=>({ok:false, error:'supervisor_unreachable'}));
    if (!slotResp || !slotResp.ok) {
      robeMeta[nome] = robeMeta[nome] || {};
      // NOVO: Reduzido de 30s para 5s (supervisor já controla velocidade via cooldowns)
      robeMeta[nome].activationHeldUntil = Date.now() + 5000;
      await reportAction(nome, 'mil_action', `activation_hold_by_supervisor reason=${(slotResp && slotResp.reason) || 'unknown'}`); 
      return { ok:false, error: `supervisor_denied:${(slotResp && slotResp.reason) || 'unknown'}` };
    }
    _supervisorSlotGranted = true;

    if (!nome) {
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'Nome ausente' };
    }

    if (isFrozenNow(nome)) {
      await reportAction(nome, 'mil_action', 'block_activate_frozen');
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'account_is_frozen' };
    }

    const job = (async () => {
      logger.info('[WORKER][activateOnce] start', { nome, source });
      try {
        logger.info('[WORKER][activateOnce] start nome=' + nome + ' source=' + source);
        const manifest = await ensureManifestValid(nome);
        if (!manifest) {
          await freezeProfileFor(nome, 12*60*60*1000, 'manifest_incomplete', 'system');
          await reportAction(nome, 'robe_error', 'manifest incompleto na ativação; perfil congelado 12h');
          if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
          return { ok:false, error: 'manifest_incomplete' };
        }

        {
          const freeMB = getAvailableMB();
          const minFreeMB = getOpenMinFreeMB(); // NOVO: RAM mínima dinâmica
          if (freeMB <= minFreeMB) {
            await reportAction(nome, 'mem_block_activate', `RAM livre=${freeMB}MB <= ${minFreeMB}MB (gate, activeNodes=${robeQueue.activeCount()})`);
            throw new Error('ram_insuficiente_para_ativar');
          }
        }

        const browser = await browserHelper.openBrowser(manifest);
        if (!browser || typeof browser.newPage !== 'function') {
          throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
        }
        const proc = browser.process && browser.process();
        if (proc && proc.pid) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].rootPid = proc.pid;
        }
        controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });

        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].activatedAt = Date.now();
        robeMeta[nome].ramHist = [];
        robeMeta[nome].cpuHistory = [];
        robeMeta[nome].lastWarn = null;

        try { healer.lastProgressAt = Date.now(); } catch {}

        try { attachBrowserLifecycle(nome, browser); } catch {}
        try {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            const pages = await browser.pages().catch(()=>[]);
            if (pages && pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
            maybeStartPruneLoop(nome, ctrl.browser, ctrl.mainPage);
            try {
              browserHelper.installOneTabGuard(ctrl.browser, nome, {
                allow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  return !!(c && (c.configurando === true || c.humanControl === true || rm.emExecucao === true));
                },
                maxPagesWhenAllow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  if (c && c.humanControl === true) return Number.MAX_SAFE_INTEGER;
                  return rm.emExecucao === true ? 3 : 10;
                },
                onNumPages: (n) => {
                  robeMeta[nome] = robeMeta[nome] || {};
                  robeMeta[nome].numPages = n;
                  snapshotStatusAndWrite().catch(()=>{});
                }
              });
            } catch {}
            try {
              browserHelper.installAboutBlankKiller(ctrl.browser, nome, { graceMs: 7000 });
            } catch {}
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].closingReason = null;
        logger.info('[WORKER][activateOnce] done nome=' + nome + ' source=' + source);
        logger.info('[WORKER][activateOnce] concluído', { nome, source });
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'ok'); } catch {} }

        return { ok: true };
      } catch (e) {
        try {
          const st = readJsonFile(statusPath, null) || { perfis: [] };
          let found = false;
          if (Array.isArray(st.perfis)) {
            st.perfis = st.perfis.map(p => {
              if (p && p.nome === nome) { found = true; return { ...p, active: false }; }
              return p;
            });
          }
          if (!found) st.perfis.push({ nome, active: false });
          _statusLock = _statusLock.then(async () => {
            const ok = writeJsonAtomic(statusPath, st);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|activateOnce_fail_status`); } catch {} }
          });
        } catch {}
        try { await reportAction(nome, 'activate_failed', 'Falha ao abrir navegador: ' + (e && e.message)); } catch {}
        if (e && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(String(e && e.message || e))) {
          robeMeta[nome] = robeMeta[nome] || {};
          // NOVO: Reduzido de 15s para 5s (supervisor já controla velocidade)
          robeMeta[nome].activationHeldUntil = Date.now() + 5000;
          try { await reportAction(nome, 'mil_action', 'activation_hold_due_ram 5s (activateOnce)'); } catch {}
        }
        logger.error('[WORKER][activateOnce] fail', { nome, source, err: e && e.message || e }, e);
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
        return { ok: false, error: e && e.message || String(e) };
      } finally {
        activationLocks.delete(nome);
      }
    })();

    activationLocks.set(nome, job);
    return await job;
  } finally {
    delete opening[nome];
  }
}

function sendReply(msgId, data) {
  if (process && process.send) {
    process.send({ replyTo: msgId, data });
  }
}

function loadPerfisJson() {
  try {
    const arr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
    if (!SHARD_SET.size) return arr;
    return arr.filter(p => p && p.nome && inShard(p.nome));
  } catch { return []; }
}
function savePerfisJson(arr) {
  try { fs.writeFileSync(perfisPath, JSON.stringify(arr, null, 2)); } catch {}
}

function pickUaPreset() {
  const presets = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
  const perfis = loadPerfisJson();
  const count = {};
  for (const p of presets) count[p.id] = 0;
  for (const pf of perfis) {
    if (pf.uaPresetId) count[pf.uaPresetId] = (count[pf.uaPresetId] || 0) + 1;
  }
  let min = Math.min(...Object.values(count));
  const candidates = presets.filter(p => count[p.id] === min);
  candidates.sort(() => Math.random() - 0.5);
  return candidates[0];
}

async function normalizeCooldown(nome) {
  try {
    const now = Date.now();
    const ctrl = controllers.get(nome);
    const man = await manifestStore.read(nome).catch(()=>null);
    try {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].pauseReason = man.robePauseReason || null;
    } catch {}
    if (!man) return 0;
    const until = Number(man.robeCooldownUntil || 0);
    const remaining = Number(man.robeCooldownRemainingMs || 0);
    const leftUntil = until > now ? (until - now) : 0;
    const leftRem = remaining > 0 ? remaining : 0;

    if (leftUntil > 0 && leftRem > 0 && Math.abs(leftUntil - leftRem) > 60*1000) {
      const winner = Math.max(leftUntil, leftRem);
      if (ctrl && ctrl.trabalhando && !ctrl.humanControl) {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = now + winner;
          m.robeCooldownRemainingMs = 0;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using until=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      } else {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = 0;
          m.robeCooldownRemainingMs = winner;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using remaining=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      }
    }
    const finalMs = leftUntil > 0 ? leftUntil : leftRem;
    try {
      if (finalMs === 0) {
        await releaseLimitPostingIfExpired(nome);
      }
    } catch {}
    return Math.max(0, Math.floor(finalMs/1000));
  } catch { return 0; }
}

async function releaseLimitPostingIfExpired(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (!man) return false;
    const now = Date.now();
    const hasLimitPosting = (man.robePauseReason === 'limit_posting');
    const stillOn = (Number(man.robeCooldownUntil||0) > now) || (Number(man.robeCooldownRemainingMs||0) > 0);
    if (hasLimitPosting && !stillOn) {
      await manifestStore.update(nome, m => {
        m = m || {};
        if (m.robePauseReason === 'limit_posting') delete m.robePauseReason;
        return m;
      });
      robeMeta[nome] = robeMeta[nome] || {};
      delete robeMeta[nome].pauseReason;
      try { await issues.append(nome, 'mil_action', 'limit_posting_release'); } catch {}
      return true;
    }
  } catch {}
  return false;
}

function robeCooldownLeft(nome) {
  let left = 0;
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const p = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const now = Date.now();
      if (working && !humanControl) {
        const until = Number(p.robeCooldownUntil || 0);
        if (until > now) {
          left = Math.floor((until - now) / 1000);
        }
      } else {
        const remaining = Number(p.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          left = Math.floor(remaining > 0 ? remaining / 1000 : 0);
        } else {
          const until = Number(p.robeCooldownUntil || 0);
          if (until > now) {
            left = Math.floor((until - now) / 1000);
          }
        }
      }
      if (left < 0) left = 0;
    }
  } catch {}
  return left;
}

async function robeLastPosted(nome) {
  let ts = 0;
  try {
    const p = await manifestStore.read(nome).catch(()=>null);
    if (p && p.ultimaPostagemRobe) ts = p.ultimaPostagemRobe;
  } catch {}
  return ts;
}

function robeUpdateMeta(nome, patch) {
  robeMeta[nome] = robeMeta[nome] || {};
  Object.assign(robeMeta[nome], patch || {});
}

function getWorkingProfileNames() {
  const nomes = [];
  controllers.forEach((ctrl, nome) => {
    if (ctrl && ctrl.browser && ctrl.trabalhando) nomes.push(nome);
  });
  return nomes;
}

async function closeExtraPages(browser, mainPage, nome) {
  try {
    const issues = require('./issues.js');
    const pages = await browser.pages();
    let closed = 0;

    const ctrl = controllers.get(nome);
    const sendLockActive = ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active;
    const inRobe = (browser && browser._robeActiveFor === nome) || (nome && robeMeta[nome] && robeMeta[nome].emExecucao === true);
    const inConfig = ctrl && ctrl.configurando === true;
    const inHuman = ctrl && ctrl.humanControl === true;

    if (!(sendLockActive || inRobe || inConfig || inHuman)) {
      for (const p of pages) {
        try {
          if (mainPage && p === mainPage) continue;
          if (!mainPage && pages[0] && p === pages[0]) continue;
          let url = ''; try { url = typeof p.url === 'function' ? url = p.url() : ''; } catch {}
          if (!url || url === 'about:blank') {
            await p.close({ runBeforeUnload: false }).catch(()=>{});
            closed++;
          }
        } catch {}
      }
    }

    if (!(sendLockActive || inRobe || inConfig || inHuman)) {
      const again = await browser.pages();
      for (const p of again) {
        if (mainPage && p === mainPage) continue;
        if (!mainPage && again[0] && p === again[0]) continue;
        let url = ''; try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
        if (/facebook\.com\/marketplace\/create\/item/i.test(url)) continue;
        await p.close({ runBeforeUnload: false }).catch(()=>{});
        closed++;
      }
    }

    if (closed > 0) {
      logger.info('[PRUNER] Fechou abas extras', { nome, closed });
      try { await issues.append(nome, 'mil_action', `pruner_closed_extras n=${closed}`); } catch {}
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
    }
  }
}

const _pruners = new Map();

function maybeStartPruneLoop(nome, browser, mainPage) {
  if (_pruners.has(nome)) return;
  const interval = setInterval(async () => {
    try {
      await closeExtraPages(browser, mainPage, nome);
    } catch (e) {
      if (process.env.PRUNE_DEBUG === '1') {
        logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
      }
    }
  }, 2*60*1000);
  _pruners.set(nome, interval);
}

function stopPruneLoop(nome) {
  if (_pruners.has(nome)) {
    clearInterval(_pruners.get(nome));
    _pruners.delete(nome);
  }
}

let ramMonitorInterval = null;

// ====== ELEIÇÃO DE LÍDER DE MÉTRICAS (UM POR HOST) ======
// Somente o líder executa o monitor pesado de RAM/CPU (WMI/pidusage).
// Demais workers apenas aguardam e consomem os dados via robeMeta/status.json.
const METRICS_LEADER_FILE = path.join(__dirname, '..', 'dados', 'metrics_leader.lock');
const METRICS_LEADER_STALE_MS = 60 * 1000; // 60s
let isMetricsLeaderFlag = false;

function ensureMetricsLeader() {
  try {
    const now = Date.now();

    // Se já somos líder, apenas atualiza o heartbeat no arquivo
    if (isMetricsLeaderFlag) {
      try {
        fs.writeFileSync(
          METRICS_LEADER_FILE,
          JSON.stringify({ pid: process.pid, ts: now }),
          'utf8'
        );
      } catch {}
      return true;
    }

    // Tenta adquirir lock criando o arquivo em modo exclusivo
    try {
      const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      isMetricsLeaderFlag = true;
      return true;
    } catch {
      // Arquivo já existe — verificar se está STALE
      let data = null;
      try {
        const raw = fs.readFileSync(METRICS_LEADER_FILE, 'utf8');
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      const ts = data && typeof data.ts === 'number' ? data.ts : 0;
      if (!ts || (now - ts) > METRICS_LEADER_STALE_MS) {
        // Considera líder anterior como morto/stale — tenta assumir
        try { fs.unlinkSync(METRICS_LEADER_FILE); } catch {}
        try {
          const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
          try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
          } finally {
            fs.closeSync(fd);
          }
          isMetricsLeaderFlag = true;
          return true;
        } catch {
          // Outro processo venceu a corrida — não somos líder
          return false;
        }
      }
      // Arquivo recente: outro worker é o líder
      return false;
    }
  } catch {
    return false;
  }
}

async function ramCpuMonitorTick() {
  const INTERVAL_MS = 8000 + Math.floor(Math.random() * 2000); // ~8–10s

  // Se não há nenhum controller ativo, não há o que monitorar — evita work desnecessário
  if (!controllers || controllers.size === 0) {
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
    return;
  }

  const pidsByNome = {};
  let erroMonitor = false;
  try {
    // NOVO: Monitor orientado por rootPid por perfil, sem varredura WMI global
    // Em vez de chamar Get-CimInstance Win32_Process para toda a máquina,
    // usamos o pid raiz capturado em activateOnce (browser.process().pid).
    for (const [nome, ctrl] of controllers.entries()) {
      if (!ctrl || !ctrl.browser) continue;
      const meta = robeMeta[nome] || {};
      const rootPid = meta.rootPid;
      if (!rootPid || typeof rootPid !== 'number') continue;
      if (!pidsByNome[nome]) pidsByNome[nome] = [];
      pidsByNome[nome].push(rootPid);
    }

    try {
      const nomesComPid = new Set(Object.keys(pidsByNome || {}));
      for (const nome of Object.keys(robeMeta)) {
        if (!nomesComPid.has(nome)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
          robeMeta[nome].ramHist = [];
          robeMeta[nome].cpuHistory = [];
        }
      }
    } catch {}
    const nomes = Object.keys(pidsByNome);
    const promises = [];
    for (const nome of nomes) {
      const pids = pidsByNome[nome];
      if (!pids || !pids.length) continue;
      promises.push((async () => {
        let somaRam = 0, somaCpu = 0;
        let countValid = 0;
        try {
          const statsObj = await pidusage(pids);
          for (const pid of pids) {
            const st = statsObj[pid];
            if (!st) continue;
            if (typeof st.memory === "number") somaRam += st.memory;
            if (typeof st.cpu === "number") somaCpu += st.cpu;
            countValid++;
          }
        } catch {
        }
        if (!countValid) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
        } else {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = typeof somaRam === "number" ? Math.round(somaRam/1024/1024) : null;
          robeMeta[nome].cpuPercent = typeof somaCpu === "number" ? Math.round(somaCpu) : null;
        }

        if (typeof robeMeta[nome].cpuPercent === "number") {
          const ch = robeMeta[nome].cpuHistory || (robeMeta[nome].cpuHistory = []);
          ch.push({ t: Date.now(), p: robeMeta[nome].cpuPercent });
          while (robeMeta[nome].cpuHistory.length > 8) robeMeta[nome].cpuHistory.shift();
        }

        if (typeof robeMeta[nome].cpuPercent === 'number' && robeMeta[nome].cpuPercent < 120) {
          const ch = robeMeta[nome].cpuHistory || [];
          if (ch.length >= 2 && ch.slice(-2).every(h => h.p < 120)) robeMeta[nome].cpuHistory = [];
        }
        if (typeof robeMeta[nome].ramMB === 'number' && robeMeta[nome].ramMB < 800) {
          const rh = robeMeta[nome].ramHist || [];
          if (rh.length >= 2 && rh.slice(-2).every(h => h.mb < 800)) robeMeta[nome].ramHist = [];
        }

        const vivos = Array.from(controllers.values()).filter(c => !!(c && c.browser && c.trabalhando)).length;
        const actAt = robeMeta[nome]?.activatedAt || 0;
        if (!actAt || (Date.now() - actAt) < 180000) return;
        if (vivos <= 1) return;

        const hist = robeMeta[nome].cpuHistory || [];
        if (hist.length >= 5) {
          const last5 = hist.slice(-5);
          const allHigh = last5.every(h => h.p >= 150);
          if (allHigh) {
            const ctrl = controllers.get(nome);
            if (ctrl && (ctrl.configurando === true || ctrl.humanControl === true)) return;

            if (killGuardActive(nome)) {
              await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
              logger.info('[BREAKER][CPU] guard_skip', { nome });
              return;
            }

            logger.warn('[BREAKER][CPU] acionado', { nome, last5: last5.map(h => h.p) });
            await handlers.deactivate({nome, reason:'cpuKill', policy:'preserveDesired'});
            setKillGuard(nome);
            await reportAction(nome, 'cpu_memory_spike', `CPU breaker acionado (>=150% por 5 rodadas) reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
            robeMeta[nome].cpuPercent = null;
          }
        }
      })());
    }
    await Promise.all(promises);
  } catch {
    erroMonitor = true;
  }

  for (const nome of Object.keys(robeMeta)) {
    if (!controllers.has(nome)) continue;

    const now = Date.now();
    if (robeMeta[nome]?.ramKillHysteresisUntil && robeMeta[nome].ramKillHysteresisUntil > now) {
      await issues.append(nome, 'ram_hysteresis_skip', `skip_until=${robeMeta[nome].ramKillHysteresisUntil}`);
      logger.info('[BREAKER][RAM] hysteresis_skip', { nome, until: robeMeta[nome].ramKillHysteresisUntil });
      continue;
    }

    const ramMB = (typeof robeMeta[nome].ramMB === 'number') ? robeMeta[nome].ramMB : null;
    if (ramMB == null) continue;

    const vivos = Array.from(controllers.values()).filter(c => !!(c && c.browser && c.trabalhando)).length;
    if (!robeMeta[nome].activatedAt || Date.now() - robeMeta[nome].activatedAt < 180000) continue;
    if (vivos <= 1) continue;

    // NOVO: Ignorar verificação de RAM se Robe está trabalhando (Robe é temporário, apenas Virtus acumula RAM)
    const ctrl = controllers.get(nome);
    const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true) || 
                        !!(ctrl && ctrl.browser && ctrl.browser._robeActiveFor === nome);
    if (robeRunning) {
      // Se Robe está trabalhando, não verifica RAM (Robe abre/fecha rapidamente, não acumula RAM)
      continue;
    }

    // NOVO: Limite reduzido para 800MB quando apenas Virtus está ativo (Virtus sozinho normalmente usa 400-600MB)
    const RAM_KILL_MB_LOCAL = 800;

    const hist = robeMeta[nome].ramHist || (robeMeta[nome].ramHist = []);
    hist.push({ t: Date.now(), mb: ramMB });
    while (hist.length > 8) hist.shift();

    if (typeof robeMeta[nome].cpuPercent === 'number' && robeMeta[nome].cpuPercent < 120) {
      const ch = robeMeta[nome].cpuHistory || [];
      if (ch.length >= 2 && ch.slice(-2).every(h => h.p < 120)) robeMeta[nome].cpuHistory = [];
    }
    if (typeof robeMeta[nome].ramMB === 'number' && robeMeta[nome].ramMB < 800) {
      const rh = robeMeta[nome].ramHist || [];
      if (rh.length >= 2 && rh.slice(-2).every(h => h.mb < 800)) robeMeta[nome].ramHist = [];
    }

    if (ramMB >= AUTO_CFG.RAM_WARN_MB && ramMB < RAM_KILL_MB_LOCAL) {
      if (!robeMeta[nome].lastWarn || (Date.now() - robeMeta[nome].lastWarn) > 600000) {
        try { await reportAction(nome, 'chrome_memory_warn', `RAM alta: ${ramMB} MB (>=${AUTO_CFG.RAM_WARN_MB})`); } catch {}
        logger.warn('[BREAKER][RAM] warning_high_usage', { nome, ramMB, warnThreshold: AUTO_CFG.RAM_WARN_MB });
        robeMeta[nome].lastWarn = Date.now();
      }
    }

    if (hist.length >= 5) {
      const recent = hist.slice(-5);
      const allHigh = recent.every(h => h.mb >= RAM_KILL_MB_LOCAL);
      let slopeOK = false;
      if (!allHigh) {
        const A = hist[0], B = hist[hist.length-1];
        const elapsedMs = (B.t - A.t);
        const dMin = Math.max(0.5, elapsedMs/60000);
        const slope = (B.mb - A.mb) / dMin;
        const avg = hist.reduce((a,b)=>a+b.mb,0)/hist.length;
        slopeOK = (elapsedMs >= 120000) && (slope > 50) && (avg > 800);
      }
      if (allHigh || slopeOK) {
        try {
          await new Promise(r=>setTimeout(r,1500));
          let newStats = null;
          const pids = (pidsByNome && pidsByNome[nome]) || [];
          let ramMB2 = null;
          if (Array.isArray(pids) && pids.length) {
            try {
              newStats = await pidusage(pids);
              let somaRam2 = 0, count2 = 0;
              for (const pid of pids) {
                const st2 = newStats[pid];
                if (!st2) continue;
                if (typeof st2.memory === 'number') { somaRam2 += st2.memory; count2++; }
              }
              if (count2 > 0) ramMB2 = Math.round(somaRam2/1024/1024);
            } catch {}
          }
          if (typeof ramMB2 === 'number') {
            hist.push({ t: Date.now(), mb: ramMB2 });
            while (hist.length > 8) hist.shift();
          }
          const last5 = hist.slice(-5);
          const allHigh2 = last5.every(h => h.mb >= RAM_KILL_MB_LOCAL);
          let slopeOK2 = false;
          {
            const A2 = hist[0], B2 = hist[hist.length-1];
            const elapsedMs2 = (B2.t - A2.t);
            const dMin2 = Math.max(0.5, elapsedMs2/60000);
            const slope2 = (B2.mb - A2.mb) / dMin2;
            const avg2 = hist.reduce((a,b)=>a+b.mb,0)/hist.length;
            // Ajustado para novo limite de 800MB
            slopeOK2 = (elapsedMs2 >= 120000) && (slope2 > 50) && (avg2 > 600);
          }

          if (!(allHigh2 || slopeOK2)) {
            await issues.append(nome, 'ram_double_sample_clear', `skip=${ramMB2!=null?ramMB2:'n/a'}MB`);
            logger.info('[BREAKER][RAM] double_sample_clear', { nome, sampleMB: ramMB2 });
            continue;
          }
        } catch {}

        // ctrl já foi obtido acima, reutilizar
        if (ctrl && (ctrl.configurando === true || ctrl.humanControl === true)) continue;

        if (killGuardActive(nome)) {
          await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
          logger.info('[BREAKER][RAM] guard_skip', { nome });
          continue;
        }

        logger.warn('[BREAKER][RAM] acionado', { nome, ramMB, allHigh, slopeOK });
        await handlers.deactivate({ nome, reason:'ramKill', policy:'preserveDesired' });
        setKillGuard(nome);
        await reportAction(nome, 'chrome_memory_spike', `RAM breaker acionado (mb=${ramMB}, allHigh=${allHigh}, slopeOK=${slopeOK}) reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);

        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].ramKillHysteresisUntil = Date.now() + 180000;
        robeMeta[nome].ramKilledAt = Date.now();
      }
    }
  }

  for (const nome of Object.keys(robeMeta)) {
  }

  await snapshotStatusAndWrite();

  ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
}

function normalizePath(x) { return String(x||'').replace(/\\/g,'/'); }

function extractUserDataDir(cmd) {
  if (!cmd) return null;
  const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(cmd);
  return m ? (m[1] || m[2] || m[3]) : null;
}

setTimeout(ramCpuMonitorTick, 5000);

// ====== Robe dinâmico (itens vs veiculos) ======
async function getRobeModuleFor(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    const mode = (man && man.robeMode) ? String(man.robeMode) : 'itens';
    if (mode === 'veiculos') {
      return require('./robeVeiculos.js');
    }
    return require('./robe.js');
  } catch {
    return require('./robe.js');
  }
}

// Wrapper: startRobeDynamic (substitui hook global robeHelper.startRobe)
async function startRobeDynamic(browser, nome, robePauseMs, workingNow) {
  let manifest = null;
  try { manifest = await manifestStore.read(nome); } catch{}
  if (!manifest) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_unavailable (no freeze)');
    return { ok: false, error: 'manifest_unavailable' };
  }
  if (!manifest.cookies || !manifest.fp) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_incomplete (no freeze)');
    return { ok: false, error: 'manifest_incomplete' };
  }
  const now = Date.now();
  if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > now) {
    return { ok: false, error: 'ram_backoff' };
  }
  try {
    const mod = await getRobeModuleFor(nome);
    return await mod.startRobe(browser, nome, robePauseMs, workingNow);
  } catch (e) {
    await reportAction(nome, 'robe_error', `Erro técnico no Robe: ${(e&&e.message)||e}. Cooldown padrão (15–30min) será aplicado pelo módulo.`);
    return { ok: false, error: String(e&&e.message||e) };
  }
}

async function robeTickGlobal() {

  const perfisArr = loadPerfisJson();
  const nomesAll = perfisArr.map(p => p.nome);
  const prontosArr = await Promise.all(nomesAll.map(async (nome) => {
    if (isFrozenNow(nome)) return null;
    if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
      return null;
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.trabalhando || ctrl.configurando || ctrl.humanControl) return null;
    const cooldown = await normalizeCooldown(nome);
    const inFila = robeQueue.inQueue(nome);
    const exec = robeQueue.isActive(nome);
    const manGate = await manifestStore.read(nome).catch(()=>null);
    if (manGate && manGate.robePauseReason === 'limit_posting' && (manGate.robeCooldownUntil || 0) > Date.now()) {
      try { await issues.append(nome, 'mil_action', 'skip_robe_enqueue_due_limit_posting_active'); } catch {}
      return null;
    }
    return (cooldown === 0 && (!inFila) && (!exec)) ? nome : null;
  }));
  const prontos = prontosArr.filter(Boolean);

  for (const nome of prontos) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) continue;

    logger.info('[WORKER][robeTickGlobal] Enfileirando', { nome, cooldown: await normalizeCooldown(nome), inQueue: robeQueue.inQueue(nome), isActive: robeQueue.isActive(nome) });

    robeQueue.enqueue(nome, async () => {

      robeUpdateMeta(nome, { emExecucao: true, emFila: false });

      let virtusWasRunning = false;
      const ctrl = controllers.get(nome);
      const workingNow = getWorkingProfileNames();
      if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        robeUpdateMeta(nome, { estado: 'erro' });
        try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (guard)'); } catch {}
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        return;
      }

      try { logger.info('[WORKER][robeTickGlobal] Robe start', { nome }); } catch {}
      try { await reportAction(nome, 'robe_start', 'Iniciando Robe via fila global'); } catch {}

      let mainPage = null;
      try {
        if (ctrl && ctrl.browser && !ctrl.mainPage) {
          try {
            const pages = await ctrl.browser.pages();
            if (pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
          } catch {}
        }
        mainPage = ctrl.mainPage;

        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          virtusWasRunning = true;
          try { await ctrl.virtus.stop(); } catch {}
          ctrl.virtus = null;
        }

        try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

        const robePauseMs = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;

        let res;
        try {
          res = await startRobeDynamic(ctrl.browser, nome, robePauseMs, workingNow);
        } catch (e) {
          if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].limitPostingThisRun = Date.now();
            robeMeta[nome].pauseReason = 'limit_posting';
            robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
            try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robeTickGlobal)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          try { logger.warn('[WORKER][robeTickGlobal] Robe error', { nome, error: e && e.message || e }); } catch {}
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (isLimitPostingRes(res)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].limitPostingThisRun = Date.now();
          robeMeta[nome].pauseReason = 'limit_posting';
          robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
          await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h');
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (res && res.ok) {
          try {
            await manifestStore.update(nome, (m) => {
              m = m || {};
              m.ultimaPostagemRobe = Date.now();
              return m;
            });
          } catch {}
          const last = await robeLastPosted(nome);
          robeUpdateMeta(nome, {
            estado: 'ok',
            cooldownSec: await normalizeCooldown(nome),
            proximaPostagem: last + robePauseMs,
            ultimaPostagem: Date.now()
          });
          try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso'); } catch {}
          try { logger.info('[WORKER][robeTickGlobal] Robe success', { nome }); } catch {}
        } else {
          robeUpdateMeta(nome, {
            estado: 'idle',
            cooldownSec: await normalizeCooldown(nome)
          });
        }
      } catch (e) {
        robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
      } finally {
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
          await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
          delete robeMeta[nome].limitPostingThisRun;
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
          robeUpdateMeta(nome, { emExecucao: false });
          if (virtusWasRunning && automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
              ctrl.trabalhando = true;
              await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
            } catch {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          }
          await snapshotStatusAndWrite();
          return;
        }
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

        robeUpdateMeta(nome, { emExecucao: false });

        if (virtusWasRunning) {
          if (automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
              ctrl.trabalhando = true;
            } catch (e) {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          } else {
            ctrl.virtus = null;
            ctrl.trabalhando = false;
          }
          await snapshotStatusAndWrite();
        }

        try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado'); } catch {}
        try { logger.info('[WORKER][robeTickGlobal] Robe end', { nome }); } catch {}
      }
    });

    robeUpdateMeta(nome, { emFila: true });
  }

  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!robeQueue.inQueue(n)) delete m.emFila;
    if (!robeQueue.isActive(n)) delete m.emExecucao;
  }
}

setInterval(robeTickGlobal, 7000);
setTimeout(robeTickGlobal, 3500);

async function fotosGcTick() {
  try {
    const res = await fotos.gcSweep();
    if (res && (res.deletedFiles || res.removedIndex || res.resetGens)) {
      logger.info('[FOTOS][GC] resultado', { deletedFiles: res.deletedFiles, removedIndex: res.removedIndex, resetGens: res.resetGens });
    }
  } catch (e) {
    logger.warn('[FOTOS][GC] erro', { error: e && e.message || e });
  }
}
setInterval(fotosGcTick, 90_000);
setTimeout(fotosGcTick, 8000);

async function stopVirtus(nome) {
const ctrl = controllers.get(nome);
if (!ctrl) return;
try {
if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
await ctrl.virtus.stop().catch(()=>{});
}
} catch {}
ctrl.virtus = null;
ctrl.trabalhando = false;
ctrl.virtusEpoch = (ctrl.virtusEpoch || 0) + 1;
if (ctrl.browser) {
  ctrl.browser._fenceEpochMap = ctrl.browser._fenceEpochMap || {};
  ctrl.browser._fenceEpochMap[nome] = ctrl.virtusEpoch;
}
try { freezeCooldownIfNotWorking(nome); } catch {}
await snapshotStatusAndWrite();
}

function attachBrowserLifecycle(nome, browser) {
browser.once('disconnected', async () => {
try {
logger.info('[WORKER][BROWSER] disconnected', { nome });
try { robeQueue.skip && robeQueue.skip(nome); } catch {}

const ctrl = controllers.get(nome);
if (ctrl) { ctrl.humanControl = false; ctrl.configurando = false; }
try {
  if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
    await ctrl.virtus.stop().catch(()=>{});
  }
} catch {}

try { freezeCooldownIfNotWorking(nome); } catch {}

controllers.delete(nome);

try { healthState.delete(nome); } catch {}
try { profileFailures.delete(nome); } catch {}
try {
  if (robeMeta[nome]) {
    delete robeMeta[nome].emExecucao;
    delete robeMeta[nome].emFila;
    delete robeMeta[nome].cpuHistory;
    delete robeMeta[nome].ramHist;
    delete robeMeta[nome].reloadAttemptsWindow;
    delete robeMeta[nome].blockDetectWindow;
  }
} catch {}

try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}

stopPruneLoop(nome);

try { registerFailure(nome, 'disconnected', 'external'); } catch {}
try {
  const d = readJsonFile(desiredPath, { perfis: {} });
  const isDesiredActive = d.perfis?.[nome]?.active === true;
  const isHold = d.perfis?.[nome]?.humanHold === true;
  robeMeta[nome] = robeMeta[nome] || {};
  const now = Date.now();

  if (!isFrozenNow(nome) && isDesiredActive && !isHold) {
    if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
      robeMeta[nome].reopenAt = now + ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
      robeMeta[nome].closingReason = 'disconnected';
      issues.append(nome, 'mil_action', 'nurse_reopen_scheduled(disconnected)').catch(()=>{});
      // NOVO: Reduzido de 30s para 5s (reabertura quase imediata, supervisor controla velocidade)
      setKillGuard(nome, 5000);
    } else {
      issues.append(nome, 'mil_action', 'reopen_preserved_existing(disconnected)').catch(()=>{});
    }
  } else {
    robeMeta[nome].reopenAt = null;
    issues.append(nome, 'mil_action', isFrozenNow(nome) ? 
      'reopen_suppressed_frozen' : (isHold ? 'reopen_suppressed_human_hold' : 'reopen_suppressed_desired_off')).catch(()=>{});
  }
} catch {}

try { await snapshotStatusAndWrite(); } catch {}
} catch (e) {
  try { logger.warn('[WORKER][BROWSER] disconnect handler err', { error: e && e.message || e }); } catch {}
}
try {
  browser.removeAllListeners && browser.removeAllListeners('targetcreated');
  browser.removeAllListeners && browser.removeAllListeners('targetchanged');
  browser.removeAllListeners && browser.removeAllListeners('targetdestroyed');
} catch {}
});
}

function resolveChromeUserDataRoot() {
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
    const os = require('os');
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  const os = require('os');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

function automationAllowed(ctrl) {
  return !!(ctrl && !ctrl.humanControl && !ctrl.configurando && !ctrl.trabalhando);
}

async function start_work({ nome }) {
  return lockProfileAction(nome, async () => {
    logger.info('[HANDLER] start_work chamada', { nome });

    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.())
      return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    if (ctrl.humanControl || ctrl.configurando) {
      await issues.append(nome, 'mil_action', 'start_work_denied (human/config mode)');
      logger.warn('[HANDLER] start_work denied (human/config mode)', { nome });
      return { ok: false, error: 'profile_in_human_or_config' };
    }
    if (ctrl.trabalhando && ctrl.virtus) {
      logger.info('[HANDLER] start_work ok (já trabalhando)', { nome });
      return { ok: true };
    }
    if (ctrl._virtusStarting) {
      logger.info('[HANDLER] start_work ok (_virtusStarting)', { nome });
      return { ok: true };
    }

    try {
      ctrl._virtusStarting = true;
      if (!automationAllowed(ctrl)) {
        await issues.append(nome, 'mil_action', 'automation_not_allowed');
        logger.warn('[HANDLER] automation_not_allowed em start_work', { nome });
        return { ok: false, error: 'automation_not_allowed' };
      }
      ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);

      ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch });
      ctrl.trabalhando = true;
      try {
        await browserHelper.forceCloseExtras(ctrl.browser);
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      if (ctrl.browser && typeof browserHelper.forceCloseExtras === 'function') {
        await browserHelper.forceCloseExtras(ctrl.browser);
      }

      try {
        await unfreezeCooldownIfWorking(nome);
        await normalizeCooldown(nome);
      } catch {}

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] start_work ok', { nome });
      return { ok: true };
    } catch (e) {
      logger.error('[HANDLER] start_work erro', { nome, error: e && e.message }, e);
      return { ok: false, error: e && e.message || String(e) };
    } finally {
      ctrl._virtusStarting = false;
    }
  });
}

const handlers = {
  async ['criar-perfil']({ cidade, cookies }) {
    logger.info('[HANDLER] criar-perfil chamada', { cidadeProvided: !!cidade, cookiesProvided: !!cookies });
    if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };
    if (!fs.existsExists(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

    let nome = utils.slugify(cidade) + '-' + Date.now();
    while (fs.existsSync(path.join(perfisDir, nome))) nome += Math.floor(Math.random() * 100);

    const preset = pickUaPreset();
    if (!preset) return { ok: false, error: 'UA preset esgotado.' };

    const cookiesArr = utils.normalizeCookies(cookies);
    if (!cookiesArr.length || !cookiesArr.find(c => c.name === 'c_user') || !cookiesArr.find(c => c.name === 'xs')) {
      return { ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' };
    }

    const perfilObj = {
      nome,
      cidade,
      uaPresetId: preset.id,
      uaString: preset.uaString,
      uaCh: preset.uaCh,
      fp: {
        viewport: preset.viewport || (preset.fp && preset.fp.viewport) || { width: 1366, height: 768 },
        dpr: preset.dpr || (preset.fp && preset.fp.dpr) || 1,
        hardwareConcurrency: preset.hardwareConcurrency || (preset.fp && preset.fp.hardwareConcurrency) || 4
      },
      cookies: cookiesArr,
      robeCooldownUntil: 0,
      configuredAt: null,
      userDataDir: path.join(resolveChromeUserDataRoot(), 'Conveniente', nome)
    };
    try { fs.mkdirSync(perfilObj.userDataDir, { recursive: true }); } catch {}

    const perfisArr = loadPerfisJson();
    perfisArr.push(perfilObj);
    savePerfisJson(perfisArr);

    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        return Object.assign({}, m, perfilObj);
      });
    } catch {}

    logger.info('[HANDLER] criar-perfil ok', { nome });
    return { ok: true, perfil: perfilObj };
  },

  async activate({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] activate chamada', { nome });
      const r = await activateOnce(nome, 'message');
      logger.info('[HANDLER] activate resultado', { nome, ok: !!(r && r.ok), error: r && r.error });
      return r;
    });
  },

  async deactivate({ nome, reason, policy }) {
  return lockProfileAction(nome, async () => {
  logger.info('[HANDLER] deactivate chamada', { nome, reason, policy });
  const preserve = (policy === 'preserveDesired');
  let reopenDelayMs = 0;
  if (preserve) {
    try { registerFailure(nome, reason || 'deactivate_preserve'); } catch {}
    if (reason === 'ramKill' || reason === 'cpuKill') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_RAMCPU_MS + Math.floor(Math.random()*120000);
    } else if (reason === 'virtus_block') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
    } else {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
    }
  }
  const ctrl = controllers.get(nome);
  if (!ctrl) {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    if (preserve && !isFrozenNow(nome) && !isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      const now = Date.now();
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else if (preserve && isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] deactivate concluído (controller ausente)', { nome });
    return { ok: true };
  }
  try {
    if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
      await ctrl.virtus.stop();
    }
  } catch {}
  try {
    if (ctrl.browser && ctrl.browser.close) {
      await ctrl.browser.close();
    }
  } catch {}
  try {
    const root = robeMeta[nome]?.rootPid;
    if (root) {
      await killProcessTreeByRootPid(root);
      robeMeta[nome].rootPid = null;
    }
  } catch {}
  try { freezeCooldownIfNotWorking(nome); } catch {}
  controllers.delete(nome);

  try {
    if (robeMeta[nome]) {
      delete robeMeta[nome].emExecucao;
      delete robeMeta[nome].emFila;
      delete robeMeta[nome].cpuHistory;
      delete robeMeta[nome].ramHist;
      delete robeMeta[nome].reloadAttemptsWindow;
      delete robeMeta[nome].blockDetectWindow;
    }
  } catch {}

  stopPruneLoop(nome);
  if (!preserve) {
    try {
      await fileStore.withDesiredFileLockUpdate((d) => {
        d.perfis = d.perfis || {};
        d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
        return d;
      });
    } catch (e) {
      try { await issues.append('system','persist_failed', `${nome}|deactivate_desired_write`); } catch {}
    }
  } else {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    if (!isHold) {
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else {
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
  }
  await snapshotStatusAndWrite();
  logger.info('[HANDLER] deactivate concluído', { nome, reason, policy });
  return { ok: true };
  });
},

  async configure({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] configure chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 10601000;

      const perfisArr = loadPerfisJson();
      const perfil = perfisArr.find(p => p && p.nome === nome);
      if (!perfil || !perfil.userDataDir) return { ok: false, error: 'Perfil não encontrado!' };
      const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return { ok: false, error: 'Manifest não existe para este perfil!' };
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.cookies) || !manifest.cookies.length) {
        try { await issues.append(nome, 'cookie_inject_failed', 'Cookies não encontrados no manifest!'); } catch {}
        return { ok: false, error: 'Cookies não encontrados no manifest!' };
      }
      ctrl.configurando = true;

      try { await stopVirtus(nome); } catch {}

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
          return desired;
        });
      } catch {}

      try {
        await browserHelper.configureProfile(ctrl.browser, nome, manifest.cookies);
        try { await clearAccountFlags(nome, ['loginRequired']); } catch {}
        logger.info('[HANDLER] configure ok', { nome });
        return { ok: true };
      } catch (e) {
        try { await issues.append(nome, 'cookie_inject_failed', e && e.message || e); } catch {}
        logger.error('[HANDLER] configure erro', { nome, error: e && e.message || e }, e);
        return { ok: false, error: e && e.message || 'falha_injetar_cookies' };
      } finally {
        ctrl.configurando = false;
        ctrl.humanControl = true;
        stopPruneLoop(nome);
        await snapshotStatusAndWrite();
      }
    });
  },

  start_work,

  async invoke_human({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] invoke_human chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      const robes = robeMeta[nome] || {};
      if (robes.emExecucao) {
        const waitTimeout = 180 * 1000;
        const started = Date.now();
        while ((robeMeta[nome] && robeMeta[nome].emExecucao) && (Date.now() - started < waitTimeout)) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      ctrl.humanControl = true;

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: true };
          return desired;
        });
      } catch {}

      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].reopenAt = null;
        robeMeta[nome].closingReason = null;
      } catch {}

      ctrl.configurando = false;
      stopPruneLoop(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
          return desired;
        });
      } catch {}
      await snapshotStatusAndWrite();

      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 246060*1000;

      try { await stopVirtus(nome); } catch {}

      await browserHelper.invocarHumano(ctrl.browser, nome);

      try { freezeCooldownIfNotWorking(nome); } catch {}

      await snapshotStatusAndWrite();

      logger.info('[HANDLER] invoke_human ok', { nome });
      return { ok: true };
    });
  },

  async ['human-resume']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] human-resume chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      ctrl.humanControl = false;
      try { await clearAccountFlags(nome, ['loginRequired','banned']); } catch {}
      try { if (ctrl.browser && ctrl.browser._suppressBlankKillUntil) delete ctrl.browser._suppressBlankKillUntil[nome]; } catch {}

      let pages2 = [];
      try { pages2 = await ctrl.browser.pages(); } catch {}
      if (pages2 && pages2[0]) maybeStartPruneLoop(nome, ctrl.browser, pages2[0]);
      try { await browserHelper.forceCloseExtras(ctrl.browser); } catch {}
      try {
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      let pages;
      try { pages = await ctrl.browser.pages(); } catch {}
      if (pages && pages[0]) {
        try {
          await require('./browser.js').ensureMinimizedWindowForPage(pages[0]);
          await new Promise(r => setTimeout(r, 350));
          await pages[0].goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch {}
      }

      if (automationAllowed(ctrl)) {
        ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
        ctrl.trabalhando = true;
      }

      try { unfreezeCooldownIfWorking(nome); } catch {}

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] human-resume ok', { nome });

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          if (desired.perfis[nome]) desired.perfis[nome].humanHold = false;
          return desired;
        });
      } catch {}

      return { ok:true };
    });
  },

  async ['robe-play']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] robe-play chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      if (isFrozenNow(nome)) {
        return { ok: false, error: 'account_frozen' }
      }
      if (ctrl && ctrl.configurando) return { ok: false, error: 'perfil_em_configuracao' };

      try {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          m.robeCooldownUntil = Date.now();
          m.robeCooldownRemainingMs = 0;
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
        if (robeMeta[nome]) {
          delete robeMeta[nome].pauseReason;
          delete robeMeta[nome].lastRobeBlockAt;
        }
      } catch {}

      if (!robeQueue.inQueue(nome) && !robeQueue.isActive(nome)) {
        robeUpdateMeta(nome, { emFila: true });
        robeQueue.enqueue(nome, async () => {

          robeUpdateMeta(nome, { emExecucao: true, emFila: false });

          let virtusWasRunning = false;
          const ctrl = controllers.get(nome);
          const workingNow = getWorkingProfileNames();
          if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

          if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
            robeUpdateMeta(nome, { estado: 'erro' });
            try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (robe-play guard)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }

          try { logger.info('[WORKER][robe-play] Robe start', { nome }); } catch {}
          try { await reportAction(nome, 'robe_start', 'Iniciando Robe via robe-play'); } catch {}

          let mainPage = null;
          try {
            if (ctrl && ctrl.browser && !ctrl.mainPage) {
              try {
                const pages = await ctrl.browser.pages();
                if (pages[0]) {
                  ctrl.mainPage = pages[0];
                  try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
                }
              } catch {}
            }
            mainPage = ctrl.mainPage;

            if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
              virtusWasRunning = true;
              try { await ctrl.virtus.stop(); } catch {}
              ctrl.virtus = null;
            }

            try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

            let res;
            try {
              res = await startRobeDynamic(ctrl.browser, nome, (15 + Math.floor(Math.random() * 16)) * 60 * 1000, workingNow);
            } catch (e) {
              if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].limitPostingThisRun = Date.now();
                robeMeta[nome].pauseReason = 'limit_posting';
                robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
                try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robe-play)'); } catch {}
                try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
                return;
              }
              await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
              robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
              try { logger.warn('[WORKER][robe-play] Robe error', { nome, error: e && e.message || e }); } catch {}
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (isLimitPostingRes(res)) {
              robeMeta[nome] = robeMeta[nome] || {};
              robeMeta[nome].limitPostingThisRun = Date.now();
              robeMeta[nome].pauseReason = 'limit_posting';
              robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
              await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h (robe-play)');
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (res && res.ok) {
              try {
                await manifestStore.update(nome, (m) => {
                  m = m || {};
                  m.ultimaPostagemRobe = Date.now();
                  return m;
                });
              } catch {}
              const last = await robeLastPosted(nome);
              robeUpdateMeta(nome, {
                estado: 'ok',
                cooldownSec: await normalizeCooldown(nome),
                proximaPostagem: last + ((15+Math.floor(Math.random()*16))*60*1000),
                ultimaPostagem: Date.now()
              });
              try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso (robe-play)'); } catch {}
              try { logger.info('[WORKER][robe-play] Robe success', { nome }); } catch {}
            } else {
              robeUpdateMeta(nome, {
                estado: 'idle',
                cooldownSec: await normalizeCooldown(nome)
              });
            }
          } catch (e) {
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          } finally {
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
              await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
              delete robeMeta[nome].limitPostingThisRun;
              try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
              robeUpdateMeta(nome, { emExecucao: false });
              if (virtusWasRunning && automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
                  ctrl.trabalhando = true;
                  await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
                } catch {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              }
              await snapshotStatusAndWrite();
              return;
            }
            try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

            robeUpdateMeta(nome, { emExecucao: false });

            if (virtusWasRunning) {
              if (automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
                  ctrl.trabalhando = true;
                } catch (e) {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              } else {
                ctrl.virtus = null;
                ctrl.trabalhando = false;
              }
              await snapshotStatusAndWrite();
            } else {
              await snapshotStatusAndWrite();
            }

            try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado (robe-play)'); } catch {}
            try { logger.info('[WORKER][robe-play] Robe end', { nome }); } catch {}
          }
        });
        await snapshotStatusAndWrite();
      }
      logger.info('[HANDLER] robe-play ok', { nome });
      return { ok: true };
    });
  },

  async ['robes-release-all']() {
    logger.info('[HANDLER] robes-release-all chamada');
    const perfisArr = loadPerfisJson();
    for (const p of perfisArr) {
      try {
        robeMeta[p.nome] = robeMeta[p.nome] || {};
        delete robeMeta[p.nome].pauseReason;
        delete robeMeta[p.nome].lastRobeBlockAt;
        await manifestStore.update(p.nome, m => {
          m = m || {};
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
      } catch {}
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] robes-release-all ok');
    return { ok: true };
  },

  // ====== HANDLER apply-city - aplica coordenadas da nova cidade em runtime ======
  async ['apply-city']({ nome }) {
    return lockProfileAction(nome, async () => {
      const ctrl = controllers.get(nome);

      // Se navegador não está ativo para este perfil, não há o que aplicar!
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        await issues.append(nome, 'mil_action', 'apply_city_runtime_skip_not_active');

        return { ok: true, active: false };
      }

      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        const cidade = man && man.cidade || '';
        const coords = require('./utils.js').getCoords(cidade || '');

        if (!coords || !coords.latitude || !coords.longitude) {
          await issues.append(nome, 'mil_action', `apply_city_skip coords_unavailable cidade="${cidade||''}"`);

          return { ok: false, error: 'coords_unavailable' };
        }

        const pages = await ctrl.browser.pages().catch(()=>[]);
        let applied = 0;

        for (const p of (pages||[])) {
          try { await p.setGeolocation(coords); applied++; } catch {}
        }

        await issues.append(nome, 'mil_action', `apply_city_runtime_ok cidade="${cidade}" pages=${applied}`);

        // Optionally: update status snapshot
        try { await snapshotStatusAndWrite(); } catch {}

        return { ok: true, appliedPages: applied, cidade };

      } catch (e) {
        await issues.append(nome, 'mil_action', `apply_city_runtime_error ${(e&&e.message)||e}`);

        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  },

  async ['get-status']() {
    try {
      for (const n of Object.keys(robeMeta)) {
        const m = robeMeta[n];
        if (!m) continue;
        if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
        while (m.cpuHistory.length > 8) m.cpuHistory.shift();
        if (!Array.isArray(m.ramHist)) m.ramHist = [];
        while (m.ramHist.length > 8) m.ramHist.shift();
        if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
        while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
        if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
        while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
      }
    } catch {}

    const perfisArr = loadPerfisJson();
    const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
    const perfis = [];
    for (const p of perfisArr) {
      const nome = p.nome;
      let issuesCount = 0;
      try {
        if (issues && typeof issues.countErrors === 'function') {
          const res = issues.countErrors(nome);
          issuesCount = Number(res && res.count) || 0;
        } else {
          issuesCount = countErrorsLocal(nome);
        }
      } catch { issuesCount = 0; }
      const fail = getFailureCounts(nome);
      let manifestStatus = await computeManifestStatus(nome);
      const man = await manifestStore.read(nome).catch(()=>null);
      const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
      const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
      const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
      const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
      const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
      const problem = man
        ? !!((man.accountFlags && man.accountFlags.loginRequired === true) || (man.accountFlags && man.accountFlags.banned === true))
        : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned);
      const man0 = await manifestStore.read(nome).catch(()=>null);
      const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';

      perfis.push({
        nome,
        label: p.label || null,
        cidade: p.cidade,
        uaPresetId: p.uaPresetId,
        active: controllers.has(nome),
        trabalhando: !!(controllers.get(nome)?.trabalhando),
        configurando: !!(controllers.get(nome)?.configurando),
        humanControl: !!(controllers.get(nome)?.humanControl),
        humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
        issuesCount,
        ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
        killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
        reopenAt: robeMeta[nome]?.reopenAt || null,
        manifestStatus,
        closingReason: robeMeta[nome]?.closingReason || null,
        openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
        lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
        loginRequired,
        loginReason,
        banned,
        bannedAt,
        bannedText,
        problem,
        robeMode
      });
    }
    const robes = {};
    for (const p of perfisArr) {
      const nome = p.nome;
      const fail = getFailureCounts(nome);
      robes[nome] = {
        cooldownSec: await normalizeCooldown(nome),
        estado: robeMeta[nome]?.estado || '',
        proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
        ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
        emFila: !!robeMeta[nome]?.emFila,
        emExecucao: !!robeMeta[nome]?.emExecucao,
        ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        pauseReason: robeMeta[nome]?.pauseReason || null,
        lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
      };
      const pauseActive = await (async () => {
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
        } catch { return false; }
      })();
      if (pauseActive) {
        robes[nome].estado = 'paused_limit';
      }
      const man = await manifestStore.read(nome).catch(()=>null);
      if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
        robes[nome].pauseReason = 'limit_posting';
        robes[nome].estado = 'paused_limit';
        await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
      }
    }
    const robeQueueList = robeQueue.queueList();
    const sys = {
      freeMB: Math.round(os.freemem()/(1024*1024)),
      totalMB: Math.round(os.totalmem()/(1024*1024)),
      cores: (os.cpus()||[]).length,
      cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
    };
    return {
      perfis,
      robes,
      robeQueue: robeQueueList,
      autoMode,
      sys
    };
  },

  async unfreeze({ nome, setBy }) {
    return lockProfileAction(nome, async () => {
      if (!nome) return { ok: false, error: 'nome_obrigatorio' };
      try { await unfreezeProfile(nome, setBy || 'admin'); } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
      return { ok: true };
    });
  },

  async ['unfreeze-all']() {
    try {
      const perfisArr = loadPerfisJson();
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        try { await unfreezeProfile(p.nome, 'admin_all'); } catch {}
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
  },

  async ['set-shard']({ names }) {
    try {
      const newSet = new Set(Array.isArray(names) ? names : []);
      const removed = [];
      for (const nome of SHARD_SET) {
        if (!newSet.has(nome)) removed.push(nome);
      }
      SHARD_SET = newSet;

      for (const nome of removed) {
        const ctrl = controllers.get(nome);
        const rm = robeMeta[nome] || {};
        const robeRunning = rm.emExecucao === true || (ctrl && ctrl.browser && ctrl.browser._robeActiveFor === nome);
        const busy = robeRunning || (ctrl && (ctrl.configurando === true || ctrl.humanControl === true));

        if (busy) {
          robeMeta[nome] = rm;
          rm.pendingShardMove = true;
          rm.deferShardMoveUntil = Date.now() + 10*60*1000;
          await issues.append(nome, 'mil_action', 'shard_move_deferred (busy)');
          continue;
        }

        try { robeQueue.skip && robeQueue.skip(nome); } catch {}
        try {
          if (ctrl && ctrl.browser) {
            await handlers.deactivate({ nome, reason: 'shard_moved', policy: 'preserveDesired' });
          }
        } catch {}
        controllers.delete(nome);
        try { healthState.delete(nome); } catch {}
        try { profileFailures.delete(nome); } catch {}
        if (robeMeta[nome]) {
          delete robeMeta[nome].emExecucao;
          delete robeMeta[nome].emFila;
          delete robeMeta[nome].cpuHistory;
          delete robeMeta[nome].ramHist;
          delete robeMeta[nome].reloadAttemptsWindow;
          delete robeMeta[nome].blockDetectWindow;
        }
      }
      await snapshotStatusAndWrite();
      return { ok: true, size: SHARD_SET.size, removed };

    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  }
};

async function snapshotStatusAndWrite() {
_statusLock = _statusLock.then(async () => {
try {
try {
  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
    while (m.cpuHistory.length > 8) m.cpuHistory.shift();
    if (!Array.isArray(m.ramHist)) m.ramHist = [];
    while (m.ramHist.length > 8) m.ramHist.shift();
    if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
    while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
    if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
    while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
  }
} catch {}

const perfisArr = loadPerfisJson();
const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
const perfis = [];
for (const p of perfisArr) {
const nome = p.nome;
let issuesCount = 0;
try {
  if (issues && typeof issues.countErrors === 'function') {
    const res = issues.countErrors(nome);
    issuesCount = Number(res && res.count) || 0;
  } else {
    issuesCount = countErrorsLocal(nome);
  }
} catch {}
const fail = getFailureCounts(nome);
let manifestStatus = await computeManifestStatus(nome);
const man = await manifestStore.read(nome).catch(()=>null);
const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
const problem = man
  ? !!((man.accountFlags && man.accountFlags.loginRequired === true) || (man.accountFlags && man.accountFlags.banned === true))
  : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned);
const man0 = await manifestStore.read(nome).catch(()=>null);
const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';

perfis.push({
  nome,
  label: p.label || null,
  cidade: p.cidade,
  uaPresetId: p.uaPresetId,
  active: controllers.has(nome),
  trabalhando: !!(controllers.get(nome)?.trabalhando),
  configurando: !!(controllers.get(nome)?.configurando),
  humanControl: !!(controllers.get(nome)?.humanControl),
  humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
  issuesCount,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
  killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
  reopenAt: robeMeta[nome]?.reopenAt || null,
  manifestStatus,
  closingReason: robeMeta[nome]?.closingReason || null,
  openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
  lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
  loginRequired,
  loginReason,
  banned,
  bannedAt,
  bannedText,
  problem,
  robeMode
});
}
const robes = {};
for (const p of perfisArr) {
const nome = p.nome;
const fail = getFailureCounts(nome);
robes[nome] = {
  cooldownSec: await normalizeCooldown(nome),
  estado: robeMeta[nome]?.estado || '',
  proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
  ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
  emFila: !!robeMeta[nome]?.emFila,
  emExecucao: !!robeMeta[nome]?.emExecucao,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  pauseReason: robeMeta[nome]?.pauseReason || null,
  lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
};
try {
  if (robes[nome].cooldownSec === 0) {
    await releaseLimitPostingIfExpired(nome);
  }
} catch {}
if (robes[nome].cooldownSec === 0 && robeMeta[nome] && robeMeta[nome].pauseReason === 'fb_block') {
  const ts = robeMeta[nome].lastRobeBlockAt || 0;
  if (ts && (Date.now() - ts) > 25*60*60*1000) {
    delete robeMeta[nome].pauseReason;
    delete robeMeta[nome].lastRobeBlockAt;
  }
}
const pauseActive = await (async () => {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
  } catch { return false; }
})();
if (pauseActive) {
  robes[nome].estado = 'paused_limit';
  robes[nome].pauseReason = 'limit_posting';
  await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
}
}
const robeQueueList = robeQueue.queueList();
const sys = {
  freeMB: Math.round(os.freemem()/(1024*1024)),
  totalMB: Math.round(os.totalmem()/(1024*1024)),
  cores: (os.cpus()||[]).length,
  cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
};
const statusObj = { perfis, robes, robeQueue: robeQueueList, autoMode, sys, ts: Date.now() };
const ok = writeJsonAtomic(statusPath, statusObj);
if (!ok) { try { await issues.append('system','persist_failed', 'status_write'); } catch {} }
} catch (e) {
try { logger.warn('[WORKER][statusWrite] erro', { error: e && e.message || e }); } catch {}
}
});
try { supervisorClient.sendTelemetria({ type: 'hb', alive: controllers.size }); } catch {}
return _statusLock;
}

async function appendIssueNurseDebounced(nome, type, message, key) {
  if (!nome) return;
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].nurseLogDebounce = robeMeta[nome].nurseLogDebounce || {};
  const k = key || type;
  const last = robeMeta[nome].nurseLogDebounce[k] || 0;
  if (Date.now() - last < 60000) return;
  robeMeta[nome].nurseLogDebounce[k] = Date.now();
  await issues.append(nome, type, message);
}

const NURSE_CFG = {
  INTERVAL_MS: 5000,
  PAGE_EVAL_TIMEOUT_MS: 5000
};

const MAX_OPEN_CONCURRENCY = 1;
let slotsInUse = 0;
const OPEN_ACTIVATION_DELAY_MS = parseInt(process.env.OPEN_ACTIVATION_DELAY_MS || '1200', 10);

const ULTRA_RECOVERY = {
  MAX_RELOADS: 2,
  RELOAD_TIMEOUT_MS: 10000,
  RELOAD_POST_WAIT_MS: 250,
  REOPEN_DELAY_SHORT_MS: 5000, // NOVO: Reduzido de 60s para 5s (reabertura quase imediata, supervisor controla velocidade)
  REOPEN_DELAY_RAMCPU_MS: 60000,
  FAIL_WINDOW_MS: 3*60*60*1000,
  FAIL_FREEZE_AFTER: 5,
  FAIL_FREEZE_MS: 2*60*60*1000,
  REOPEN_DELAY_VIRTUS_BLOCK_MS: 2*60*60*1000
};

async function ensureFrozenShutdown(nome, origin = 'frozen') {
  const ctrl = controllers.get(nome);
  if (!ctrl) return;
  try { robeQueue.skip && robeQueue.skip(nome); } catch {}
  try { await reportAction(nome, 'mil_action', 'frozen_kill'); } catch {}
  try {
    await handlers.deactivate({ nome, reason: 'frozen', policy: 'preserveDesired' });
  } catch {}
  try { stopPruneLoop(nome); } catch {}
  try {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].reopenAt = null;
    robeMeta[nome].activationHeldUntil = robeMeta[nome].frozenUntil || (Date.now() + 3600_000);
  } catch {}
  try { await snapshotStatusAndWrite(); } catch {}
}

const INTERNAL_REASONS = new Set(['ramKill','cpuKill','manifest_missing','manifest_incomplete','panic','open_headroom']);
const EXTERNAL_REASONS = new Set(['disconnected','no_pages','zombie','network','fb_dom','messenger_temp_block','blocked']);

function classifyReason(reason, fallback) {
  if (INTERNAL_REASONS.has(reason)) return 'internal';
  if (EXTERNAL_REASONS.has(reason)) return 'external';
  return fallback || 'unknown';
}

function getFailureCounts(nome) {
  const now = Date.now();
  const rec = profileFailures.get(nome);
  if (!rec) return { internal: 0, external: 0, unknown: 0 };
  const pruned = {
    internal: (rec.internal||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    external: (rec.external||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    unknown: (rec.unknown||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS)
  };
  profileFailures.set(nome, pruned);
  return { internal: pruned.internal.length, external: pruned.external.length, unknown: pruned.unknown.length };
}

const profileFailures = new Map();
async function registerFailure(nome, reason, classification) {
  const now = Date.now();
  const cls = classification || classifyReason(reason, 'unknown');
  const rec = profileFailures.get(nome) || { internal: [], external: [], unknown: [] };
  rec.internal = (rec.internal||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.external = (rec.external||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.unknown  = (rec.unknown ||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  if (cls === 'internal') rec.internal.push(now);
  else if (cls === 'external') rec.external.push(now);
  else rec.unknown.push(now);
  profileFailures.set(nome, rec);
  const counts = getFailureCounts(nome);
  try { await issues.append(nome, 'failure', `reason=${reason} class=${cls} internal=${counts.internal} external=${counts.external} unknown=${counts.unknown}`); } catch {}

  const ALLOWED_FREEZE_REASONS = new Set(['manifest_missing','manifest_incomplete']);
  if (ALLOWED_FREEZE_REASONS.has(reason)) {
    await freezeProfileFor(nome, 12*60*60*1000, reason, 'system');
    await ensureFrozenShutdown(nome, reason || 'frozen');
  }
}

async function pageReadyBasic(p0) {
  try {
    const res = await Promise.race([
      (async () => (await p0.evaluate(() => document.readyState)) || 'unknown')(),
      new Promise(res => setTimeout(() => res('timeout'), NURSE_CFG.PAGE_EVAL_TIMEOUT_MS))
    ]);
    return (res === 'interactive' || res === 'complete');
  } catch { return false; }
}

async function tryReloadShort(p0, nome, attempt) {
  try {
    if (process.env.NURSE_DEBUG === '1') {
      await reportAction(nome, 'mil_action', `nurse_reload_try #${attempt} url=${(p0 && p0.url && p0.url()) || ''} readyState=${await (async () => { try { return await p0.evaluate(()=>document.readyState); } catch { return '-'; } })()} reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
    }
  } catch {}
  try {
    await p0.reload({ waitUntil: 'domcontentloaded', timeout: ULTRA_RECOVERY.RELOAD_TIMEOUT_MS }).catch(()=>{});
    await new Promise(r=>setTimeout(r, ULTRA_RECOVERY.RELOAD_POST_WAIT_MS));
  } catch {}
  return await pageReadyBasic(p0);
}

function ms(h) { return h * 60 * 60 * 1000; }

async function freezeProfileFor(nome, msDuration, reason, setBy = 'system') {
  try {
    const now = Date.now();
    let applied = { until: now + msDuration, mode: 'set' };
    await manifestStore.update(nome, (man) => {
      man = man || {};
      const existingMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
      const existingDisk = (man && man.frozenUntil) || 0;
      const existing = Math.max(existingMem, existingDisk, 0);
      let until = now + msDuration;
      let mode = 'set';
      if (existing > now) {
        until = existing + msDuration;
        mode = 'extended';
      }
      applied.until = until;
      applied.mode = mode;

      man.frozenUntil = until;
      man.frozenReason = String(reason || '');
      man.frozenAt = man.frozenAt || now;
      man.frozenSetBy = setBy || 'system';
      return man;
    });

    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].frozenUntil = applied.until;
    robeMeta[nome].frozenReason = String(reason || '');
    robeMeta[nome].frozenAt = robeMeta[nome].frozenAt || now;
    robeMeta[nome].frozenSetBy = setBy || 'system';

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `frozen_${Math.round(msDuration/60000)}min(${applied.mode}): reason=${reason||''} setBy=${setBy} until=${new Date(applied.until).toISOString()}`
      );
    } catch {}

    await ensureFrozenShutdown(nome, reason || 'frozen');
    await snapshotStatusAndWrite();
  } catch {}
}

async function unfreezeProfile(nome, setBy = 'admin') {
  try {
    const now = Date.now();

    robeMeta[nome] = robeMeta[nome] || {};
    delete robeMeta[nome].frozenUntil;
    delete robeMeta[nome].frozenReason;
    delete robeMeta[nome].frozenAt;
    delete robeMeta[nome].frozenSetBy;
    robeMeta[nome].activationHeldUntil = now + 60*1000;
    robeMeta[nome].reloadAttemptsWindow = [];
    robeMeta[nome].unfreezeCount = (robeMeta[nome].unfreezeCount || 0) + 1;
    robeMeta[nome].lastUnfreezeAt = now;
    robeMeta[nome].reopenAt = null;

    await manifestStore.update(nome, (man) => {
      man = man || {};
      if ('frozenUntil' in man) delete man.frozenUntil;
      if ('frozenReason' in man) delete man.frozenReason;
      if ('frozenAt' in man) delete man.frozenAt;
      if ('frozenSetBy' in man) delete man.frozenSetBy;
      return man;
    });

    profileFailures.set(nome, { internal: [], external: [], unknown: [] });

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `unfreeze by=${setBy}`
      );
    } catch {}

    await snapshotStatusAndWrite();
  } catch {}
}

async function detectMessengerTempBlock(page) {
  try {
    const url = page.url ? page.url() : '';
    if (!/messenger.com/i.test(url)) return { blocked: false };
    return await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const texts = Array.from(document.querySelectorAll('h1,h2,span,div'))
        .slice(0, 300)
        .map(el => norm(el.innerText || el.content || el.textContent || ''))
        .filter(Boolean);

      const hasBlocked =
        texts.some(t =>
          t.includes('voce esta bloqueado temporariamente') ||
          t.includes('você está bloqueado temporariamente') ||
          t.includes('youre temporarily blocked') ||
          t.includes('you’re temporarily blocked') ||
          t.includes('temporarily blocked')
        );
      const hasReloadBtn =
        !!document.querySelector('[aria-label*="Recarregar pagina"],[aria-label*="Recarregar página"],[aria-label*="Reload"]');
      return { blocked: hasBlocked, hasReloadBtn };
    });
  } catch { return { blocked: false }; }
}

let _nurseTickRunning = false;

async function nurseTick() {
  if (_nurseTickRunning) return;
  _nurseTickRunning = true;
  if (controllers.size === 0) { _nurseTickRunning = false; return; }
  try {
    const now = Date.now();
    const desired = readJsonFile(desiredPath, { perfis: {} });
    for (const nome of Object.keys(desired.perfis || {})) {
      if (SHARD_SET.size && !inShard(nome)) {
        if (process.env.NURSE_DEBUG === '1') {
          try { logger.info(`[NURSE][SKIP_OTHER_SHARD] ${nome}`); } catch {}
        }
        continue;
      }
      const want = desired.perfis[nome] || {};
      const ctrl = controllers.get(nome);

      if (want.humanHold === true) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_human_hold', 'nurse_skip_human_hold');
        continue;
      }

      {
        const rm = robeMeta[nome] || {};
        if (rm.emExecucao === true) {
          await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_robe_running', 'nurse_skip_robe_running');
          continue;
        }
      }

      if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) {
        continue;
      }
      if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'send_lock_skip', 'send_lock_skip');
        continue;
      }

      if (isFrozenNow(nome)) {
        if (ctrl) { await ensureFrozenShutdown(nome, 'nurse_guard'); }
        continue;
      }

      const hs = getHealth && getHealth(nome);
      if (hs && ['recover1','recover2','recover3'].includes(hs.stage)) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'health_recovery_in_progress_skip', 'health_recovery_in_progress_skip');
        continue;
      }

      if (want.active === true && !ctrl) {
        if (isFrozenNow(nome)) continue;

        if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > Date.now()) continue;
        if (robeMeta[nome]?.reopenAt && robeMeta[nome].reopenAt > Date.now()) continue;

        if (slotsInUse >= MAX_OPEN_CONCURRENCY) continue;
        slotsInUse++;
        try {
          await reportAction(nome, 'nurse_restart', 'desired ativo porém controller ausente — tentando ativar');
          try {
            const r = await activateOnce(nome, 'nurse_auto');
            if (!r || !r.ok) {
              const err = (r && r.error) || '';
              if (/ram_insuficiente_para_ativar|supervisor_denied:ram_low|supervisor_denied:slots|headroom_below_min_after_open/.test(err)) {
                await issues.append(nome, 'mil_action', 'open_denied_ram_swap_attempt err='+err);

                const swapped = await trySwapOpen(nome);

                if (!swapped) {
                  robeMeta[nome] = robeMeta[nome] || {};
                  // NOVO: Backoff fixo de 3s ao invés de escalonado (supervisor já controla velocidade)
                  const curBackoff = 3000;
                  robeMeta[nome].openBackoffMs = curBackoff;
                  robeMeta[nome].activationHeldUntil = Date.now() + curBackoff;
                  await issues.append(nome, 'mil_action', `open_backoff set to ${Math.floor(curBackoff/1000)}s (fixed)`);
                  logger.warn('[SWAP] open_backoff set', { nome, backoffMs: curBackoff, reason: err });
                } else {
                  logger.info('[SWAP] swap_open_success (nurse)', { target: nome });
                }
              }
            } else {
              // NOVO: Backoff fixo de 3s ao invés de 15s
              if (robeMeta[nome]) robeMeta[nome].openBackoffMs = 3000;
              logger.info('[NURSE] activateOnce ok', { nome });
            }
          } catch { }
        } finally {
          slotsInUse--;
        }
        await new Promise(r => setTimeout(r, OPEN_ACTIVATION_DELAY_MS));
        continue;
      }

      if (!ctrl || !ctrl.browser) continue;
      let pages = [];
      try { pages = await ctrl.browser.pages().catch(()=>[]); } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].noPagesStrikes = robeMeta[nome].noPagesStrikes || 0;
      robeMeta[nome].lastNoPagesAt = robeMeta[nome].lastNoPagesAt || 0;

      if (!pages || !pages[0]) {
        let retryFailed = false;
        if (ctrl.browser.isConnected?.()) {
          await new Promise(r=>setTimeout(r,400));
          let retryPages = [];
          try { retryPages = await ctrl.browser.pages(); } catch {}
          if (!retryPages || !retryPages[0]) retryFailed = true;
        } else {
          retryFailed = true;
        }
        if (retryFailed) {
          robeMeta[nome].noPagesStrikes += 1;
          robeMeta[nome].lastNoPagesAt = Date.now();
          await appendIssueNurseDebounced(nome, `suspect_no_pages`, `strike=${robeMeta[nome].noPagesStrikes}`, 'suspect_no_pages');
          if (robeMeta[nome].noPagesStrikes >= 2 && (Date.now() - robeMeta[nome].lastNoPagesAt) >= 5000) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_nopages`, `Strikes=${robeMeta[nome].noPagesStrikes}`, 'action_nurse_kill_nopages');
            await registerFailure(nome, 'no_pages', 'external');
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].noPagesStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].noPagesStrikes = 0;
      }

      const p0 = pages[0];
      try {
        const lr = await browserHelper.detectLoginRequired(p0);
        if (lr && lr.loginRequired) {
          await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' });
        }
      } catch {}
      try {
        const bd = await browserHelper.detectAccountSuspended(p0);
        if (bd && bd.banned) {
          await setBannedFlag(nome, { reason: bd.reason || '', snippet: bd.snippet || '' });
        }
      } catch {}
      let det = { blocked:false };
      try {
        const urlNow = (typeof p0.url === 'function') ? (p0.url() || '') : '';
        const isMessenger = /messenger.com/i.test(urlNow);
        const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const isCreateOrSellerRoute =
          /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

        if (isMessenger) {
          det = await browserHelper.detectMessengerTempBlock(p0);
          det.domain = 'messenger';
        } else if (robeRunning || isCreateOrSellerRoute) {
          const deep = await detectLimitOverlayDeep(p0, { alsoCheckFrames: true }).catch(()=>null);
          if (deep && deep.blocked) {
            det = { blocked: true, domain: 'facebook' };
          } else {
            det = await browserHelper.detectMessengerTempBlock(p0);
            det.domain = det.domain || 'facebook';
          }
        }
      } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow || [];
      let now2 = Date.now();

      if (det && det.blocked && det.domain === 'messenger') {
        robeMeta[nome].blockDetectWindow.push(now2);
        robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow.filter(ts => now2 - ts <= 5000);
        while (robeMeta[nome].blockDetectWindow.length > 8) robeMeta[nome].blockDetectWindow.shift();

        if (robeMeta[nome].blockDetectWindow.length >= 2 && (!robeMeta[nome].blockHysteresisUntil || robeMeta[nome].blockHysteresisUntil < now2)) {
          await appendIssueNurseDebounced(nome, `action_virtus_block`, `blockDetectWindow=${robeMeta[nome].blockDetectWindow.length}`, 'action_virtus_block');
          robeMeta[nome].blockHysteresisUntil = now2 + 15*60*1000;
          if (killGuardActive(nome)) {
            await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)', 'guard_skip_block');
            continue;
          }
          await stopVirtus(nome);
          if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now2)) {
            robeMeta[nome].reopenAt = now2 + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
            robeMeta[nome].closingReason = 'virtus_block';
          }
          await registerFailure(nome, 'messenger_temp_block', 'external');
          await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
          setKillGuard(nome);
          await snapshotStatusAndWrite();
          continue;
        } else {
          await appendIssueNurseDebounced(nome, `suspect_messenger_block`, `strike=${robeMeta[nome].blockDetectWindow.length}`, 'suspect_messenger_block');
          continue;
        }
      }
      if (robeMeta[nome].blockHysteresisUntil && robeMeta[nome].blockHysteresisUntil > now2) continue;

      if (det && det.blocked && det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      let anyFbBlocked = false;
      try {
        if (robeMeta[nome] && robeMeta[nome].emExecucao === true && ctrl && ctrl.browser) {
          anyFbBlocked = await detectFbLimitInAnyPage(ctrl);
        }
      } catch {}
      if (anyFbBlocked) {
        try { await issues.append(nome, 'block_detected', 'domain=facebook multi-page=true'); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      const hs2 = getHealth && getHealth(nome);
      if (hs2 && (hs2.stage === 'recover1' || hs2.stage === 'recover2' || hs2.stage === 'recover3')) {
        continue;
      }

      let healthy = await pageReadyBasic(p0);
      if (!healthy) {
        if (robeMeta[nome].recoveryHysteresisUntil && robeMeta[nome].recoveryHysteresisUntil > Date.now()) {
          await appendIssueNurseDebounced(nome, 'hysteresis_skip', 'Aguardando histerese pós-recover', 'hysteresis_skip_after_recover');
          continue;
        }

        robeMeta[nome] = robeMeta[nome] || {};
        const nowReload = Date.now();
        if (!robeMeta[nome].reloadAttemptsWindow) robeMeta[nome].reloadAttemptsWindow = [];
        robeMeta[nome].reloadAttemptsWindow = robeMeta[nome].reloadAttemptsWindow.filter(ts => nowReload - ts < 60000);

        robeMeta[nome].reloadAttemptsWindow.push(nowReload);
        while (robeMeta[nome].reloadAttemptsWindow.length > 8) robeMeta[nome].reloadAttemptsWindow.shift();

        if (robeMeta[nome].reloadAttemptsWindow.length > 3) {
          robeMeta[nome].reloadBlockedUntil = nowReload+60000;
          await reportAction(nome, 'mil_action', 
            `nurse_reload_blocked: Excesso de reloads (${robeMeta[nome].reloadAttemptsWindow.length}) em 60s, url=${((p0.url&&p0.url())||'')}`
          );
          continue;
        }
        if (robeMeta[nome].reloadBlockedUntil && robeMeta[nome].reloadBlockedUntil > nowReload) {
          continue;
        }

        healthy = await tryReloadShort(p0, nome, 1);
        if (!healthy) {
          healthy = await tryReloadShort(p0, nome, 2);
        }
        if (healthy) {
          await reportAction(nome, 'mil_action', 'nurse_recover_success(reload)');
          robeMeta[nome].recoveryHysteresisUntil = Date.now() + 90000;
        } else {
          robeMeta[nome].zombieStrikes = robeMeta[nome].zombieStrikes || 0;
          robeMeta[nome].zombieStrikes += 1;
          await appendIssueNurseDebounced(nome, `suspect_page_zombie`, `strike=${robeMeta[nome].zombieStrikes}`, 'suspect_page_zombie');
          if (robeMeta[nome].zombieStrikes >= 2) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until', 'guard_skip_page_zombie');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_page_zombie`, `Strike=${robeMeta[nome].zombieStrikes}`, 'action_nurse_kill_page_zombie');
            try { registerFailure(nome, 'zombie', 'external'); } catch {}
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].zombieStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].zombieStrikes = 0;
      }

      try {
        const url = p0.url ? p0.url() : '';
        if (/messenger\.com\/.*marketplace/i.test(url) && !ctrl.configurando && !(robeMeta[nome] && robeMeta[nome].emExecucao)) {
          const ph = getPhantomState(nome);
          const snap = await evaluateChatsState(p0);
          if (isOkFromSnapshot(snap)) {
            ph.lastOkAt = Date.now(); ph.firstSeenAt = 0;
          } else {
            const now = Date.now();
            if (isPhantomFromSnapshot(snap)) {
              if (!ph.firstSeenAt) ph.firstSeenAt = now;
              const elapsed = now - ph.firstSeenAt;
              const sinceOk = ph.lastOkAt ? (now - ph.lastOkAt) : Infinity;
              if (elapsed > PHANTOM_CFG.PERSIST_MS && sinceOk > PHANTOM_CFG.INITIAL_GRACE_MS) {
                await issues.append(nome, 'mil_action',
                  `phantom_detected rows=${snap.rows} anchors=${snap.anchors} sk=${snap.skeletons} elapsed=${elapsed}ms`);
                await tryFixPhantom(nome, p0);
              }
            } else if (snap.skeletons === 0) {
              ph.firstSeenAt = 0;
            }
          }
        }
      } catch {}

      if (ctrl && ctrl.configurando) {
        logger.info('[NURSE][SKIP PRUNE] Perfil em configuração, prune ignorado', { nome });
        continue;
      }
      if (!(robeMeta[nome] && robeMeta[nome].emExecucao)) {
        try { await closeExtraPages(ctrl.browser, p0, nome).catch(()=>{}); } catch {}
      }
      if (want.virtus === 'on' && automationAllowed(ctrl)) {
        try { 
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 }); 
          ctrl.trabalhando = true; 
        } catch {}
      }
    }
  } finally {
    _nurseTickRunning = false;
  }
}

async function trySwapOpen(target) {
  const aliveNames = Array.from(controllers.keys());
  if (aliveNames.length <= 1) return false;

  const candidates = aliveNames
    .filter(n => n !== target)
    .map(n => ({
      n,
      mb: (typeof robeMeta[n]?.ramMB === 'number') ? robeMeta[n].ramMB : -1,
      emExecucao: robeMeta[n]?.emExecucao,
      configurando: controllers.get(n)?.configurando,
      humanControl: controllers.get(n)?.humanControl
    }))
    .filter(c => !c.configurando && !c.emExecucao && !c.humanControl && c.mb >= (process.platform==='win32' ? 900 : 700))
    .sort((a, b) => b.mb - a.mb);

  for (const cand of candidates) {
    if (killGuardActive(cand.n)) continue;
    await issues.append(cand.n, 'mil_action', `swap_kill fechamento para abrir ${target} RAM=${cand.mb}MB`);
    logger.info('[SWAP] swap_kill', { fechar: cand.n, abrir: target, ramMB: cand.mb });
    await handlers.deactivate({ nome: cand.n, reason: 'swap_for_open', policy: 'preserveDesired' });
    setKillGuard(cand.n, 45000);
    await new Promise(r=>setTimeout(r, 2000));
    
    const r = await activateOnce(target, 'nurse_swap');
    if (r && r.ok) {
      await issues.append(target, 'mil_action', `swap_open_success após fechar ${cand.n}`);
      robeMeta[target] = robeMeta[target] || {};
      robeMeta[target].lastSwapAt = Date.now();
      logger.info('[SWAP] swap_open_success', { target, fechado: cand.n });
      return true;
    }
    await issues.append(target, 'mil_action', `swap_open_failed após fechar ${cand.n}`);
    logger.warn('[SWAP] swap_open_failed', { target, fechado: cand.n });
  }
  await issues.append(target, 'mil_action', 'swap_open_failed_nenhum_sucesso');
  logger.warn('[SWAP] swap_open_failed_nenhum_sucesso', { target });
  return false;
}

setInterval(() => { nurseTick().catch(()=>{}); }, NURSE_CFG.INTERVAL_MS);
setTimeout(() => { nurseTick().catch(()=>{}); }, 2000);

async function wirePageObservers(nome, page) {
  const st = getHealth(nome);
  try {
    page.removeAllListeners && page.removeAllListeners('domcontentloaded');
    page.removeAllListeners && page.removeAllListeners('framenavigated');
    page.removeAllListeners && page.removeAllListeners('requestfinished');
    page.removeAllListeners && page.removeAllListeners('requestfailed');
    page.removeAllListeners && page.removeAllListeners('console');
    page.removeAllListeners && page.removeAllListeners('pageerror');
  } catch {}
  page.on('domcontentloaded', async () => {
    const st = getHealth(nome);
    st.lastDomEventAt = Date.now();
    try { st.lastTitle = await page.title().catch(()=>st.lastTitle); } catch {}
    try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
  });
  page.on('framenavigated', (frame) => {
    const st = getHealth(nome);
    if (frame === page.mainFrame()) {
      st.lastDomEventAt = Date.now();
      try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
    }
  });
  page.on('requestfinished', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('requestfailed', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('console', (msg) => { if (msg && msg.type && msg.type() === 'error') getHealth(nome).lastConsoleErrorAt = Date.now(); });
  page.on('pageerror', () => { getHealth(nome).lastConsoleErrorAt = Date.now(); });
}

async function isPageLikelyAlive(page, nome) {
  const st = getHealth(nome);
  const now = Date.now();
  const noDom = (now - st.lastDomEventAt) > HEALTH_CFG.DEAD_NO_DOM_MS;
  const noNet = (now - st.lastNetEventAt) > HEALTH_CFG.DEAD_NO_NET_MS;
  let readyOk = false, url = '';
  try {
    const rs = await Promise.race([
      page.evaluate(()=>document.readyState).catch(()=> 'err'),
      new Promise(res=>setTimeout(()=>res('timeout'), 1200))
    ]);
    readyOk = (rs === 'interactive' || rs === 'complete');
    url = page.url ? page.url() : '';
  } catch {}
  const aboutBlankStuck = (url === 'about:blank') && ((now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS);
  const urlIsFb = /facebook\.com|messenger\.com/i.test(url);
  const aliveBySignals = (!noDom || !noNet);
  const aliveByReady = (readyOk && urlIsFb && !aboutBlankStuck);
  return aliveBySignals || aliveByReady;
}

async function recoveryStep(nome, page, step) {
  const st = getHealth(nome);
  const now = Date.now();
  if (st.nextTryAt && st.nextTryAt > now) return false;
  if (step === 'reload') {
    st.counters.softReloads10m = _pruneWindow(st.counters.softReloads10m, 10*60*1000);
    if (st.counters.softReloads10m.length >= HEALTH_CFG.MAX_SOFT_RELOADS_10MIN) return false;
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); } catch {}
    st.counters.softReloads10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.reload;
    try { await issues.append(nome, 'mil_action', 'health_recover:reload'); } catch {}
    return true;
  }
  if (step === 'navHome') {
    st.counters.navHomes10m = _pruneWindow(st.counters.navHomes10m, 10*60*1000);
    if (st.counters.navHomes10m.length >= HEALTH_CFG.MAX_NAVHOME_10MIN) return false;
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); } catch {}
    st.counters.navHomes10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.navHome;
    try { await issues.append(nome, 'mil_action', 'health_recover:navHome'); } catch {}
    return true;
  }
  if (step === 'newPage') {
    if (st.newPageInFlight) return false;
    if (st.lastNewPageAt && (now - st.lastNewPageAt) < 90000) return false;
    st.counters.newPages30m = _pruneWindow(st.counters.newPages30m, 30*60*1000);
    if (st.counters.newPages30m.length >= HEALTH_CFG.MAX_NEWPAGE_30MIN) return false;
    st.newPageInFlight = true;
    try {
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser) return false;
      const np = await ctrl.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(() => null);
        await browserHelper.patchPage(nome, np, utils.getCoords((man && man.cidade) || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl.mainPage = np;
      await wirePageObservers(nome, np);
      st.counters.newPages30m.push(Date.now());
      st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.newPage;
      st.lastNewPageAt = now;
      try { await issues.append(nome, 'mil_action', 'health_recover:newPage'); } catch {}
      return true;
    } finally {
      st.newPageInFlight = false;
    }
  }
  return false;
}
async function escalateToReopen(nome, reason='health_reopen') {
  const ctrl = controllers.get(nome);
  try { await issues.append(nome, 'mil_action', `health_escalate:${reason}`); } catch {}
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return;
  }
  await handlers.deactivate({ nome, reason, policy: 'preserveDesired' });
  setKillGuard(nome);
  const st = getHealth(nome);
  st.stage = 'reopen';
  st.nextTryAt = Date.now() + 60000;
}

async function healthTick() {
  if (controllers.size === 0) { return; }
  for (const [nome, ctrl] of controllers) {
    if (robeMeta[nome] && robeMeta[nome].emExecucao === true) continue;
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) continue;

    if (!ctrl || !ctrl.browser) continue;
    if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
      continue;
    }
    const st = getHealth(nome);
    const now = Date.now();
    let pages = [];
    try { pages = await ctrl.browser.pages(); } catch {}
    if (!pages || !pages[0]) continue;
    const page = pages[0];
    if (page && ctrl.mainPage !== page) {
      ctrl.mainPage = page;
      await wirePageObservers(nome, page);
    }

    let det = { blocked:false };
    try {
      const urlNow = (typeof page.url === 'function') ? (page.url() || '') : '';
      const isMessenger = /messenger.com/i.test(urlNow);
      const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
      const isCreateOrSellerRoute =
        /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

      if (isMessenger) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = 'messenger';
      } else if (robeRunning || isCreateOrSellerRoute) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = det.domain || 'facebook';
      }
    } catch {}
    if (det && det.blocked) {
      if (det.domain === 'messenger') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        try { await stopVirtus(nome); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        const jitterMs = (5 + Math.floor(Math.random() * 21)) * 60 * 1000;
        if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > Date.now())) {
          robeMeta[nome].reopenAt = Date.now() + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + jitterMs;
          robeMeta[nome].closingReason = 'virtus_block';
        }
        try { registerFailure(nome, 'messenger_temp_block', 'external'); } catch {}
        if (killGuardActive(nome)) {
          await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)');
          continue;
        }
        await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
        setKillGuard(nome);
        await snapshotStatusAndWrite();
        continue;
      }
      if (det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const now = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man0 = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man0 && man0.robeCooldownUntil ? (man0.robeCooldownUntil - now) : 0;
          if (!man0 || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = now + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'health_detect_facebook_block_preserve_reason=limit_posting');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }
    }

    if (isFrozenNow(nome)) continue;
    const alive = await isPageLikelyAlive(page, nome);
    if (alive) {
      st.lastOkAt = now;
      st.stage = 'ok';
      st.counters.cyclesWithoutLife = 0;
      continue;
    }
    const noEventsFor = Math.max(now - st.lastDomEventAt, now - st.lastNetEventAt);
    if (noEventsFor > HEALTH_CFG.DEAD_NO_EVENT_MS) {
      st.counters.cyclesWithoutLife++;
      if (st.stage === 'ok') st.stage = 'suspect';
    }
    try {
      const url = page.url ? page.url() : '';
      if (url === 'about:blank' && (now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS) {
        if (await recoveryStep(nome, page, 'navHome')) continue;
      }
    } catch {}
    if (st.stage === 'suspect') {
      if (await recoveryStep(nome, page, 'reload')) { st.stage = 'recover1'; continue; }
      st.stage = 'recover1';
    } else if (st.stage === 'recover1') {
      if (await recoveryStep(nome, page, 'navHome')) { st.stage = 'recover2'; continue; }
      st.stage = 'recover2';
    } else if (st.stage === 'recover2') {
      if (await recoveryStep(nome, page, 'newPage')) { st.stage = 'recover3'; continue; }
      st.stage = 'recover3';
    } else if (st.stage === 'recover3') {
      if (st.counters.cyclesWithoutLife >= HEALTH_CFG.ESCALATE_TO_REOPEN_AFTER) {
        await escalateToReopen(nome, 'health_no_progress');
      }
    }
  }
}
setInterval(() => { healthTick().catch(()=>{}); }, HEALTH_CFG.TICK_MS);
setTimeout(() => { healthTick().catch(()=>{}); }, 2500);

// ====== LIMPEZA PERIÓDICA DE ABAS ABOUT:BLANK ÓRFÃS ======
// Varre todos os navegadores ativos e fecha abas about:blank que estão órfãs
// (criadas mas abandonadas quando Robe aborta/abandona postagem)
// Roda a cada 3 minutos - não agressivo, apenas limpa o que ficou esquecido
async function periodicAboutBlankCleanup() {
  try {
    const issues = require('./issues.js');
    let totalClosed = 0;

    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) continue;

        // Proteções: não limpa se Robe está ativo, configurando, ou em modo humano
        const inRobe = (ctrl.browser._robeActiveFor === nome) || (robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const sendLockActive = ctrl.browser._sendLock && ctrl.browser._sendLock.active;
        const inConfig = ctrl.configurando === true;
        const inHuman = ctrl.humanControl === true;

        if (inRobe || sendLockActive || inConfig || inHuman) continue;

        // Varre todas as páginas procurando about:blank órfãs
        const pages = await ctrl.browser.pages().catch(() => []);
        if (!Array.isArray(pages) || pages.length <= 1) continue;

        const mainPage = ctrl.mainPage || pages[0];
        
        // Proteção extra: verifica se há create item aberto (só verifica uma vez)
        const hasCreateItem = pages.some(pg => {
          try {
            const u = pg.url ? pg.url() : '';
            return /facebook\.com\/marketplace\/create\/item/i.test(u);
          } catch { return false; }
        });
        
        // Se há create item, não limpa (pode ser que o Robe esteja prestes a usar)
        if (hasCreateItem) continue;

        let closed = 0;

        for (const p of pages) {
          try {
            // Nunca fecha a página principal
            if (p === mainPage) continue;
            if (!mainPage && p === pages[0]) continue;

            // Verifica se é about:blank
            let url = '';
            try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
            if (!url || url !== 'about:blank') continue;

            // Fecha a aba about:blank órfã
            // (já verificamos que não há Robe ativo e não há create item)
            await p.close({ runBeforeUnload: false }).catch(() => {});
            closed++;
          } catch {}
        }

        if (closed > 0) {
          totalClosed += closed;
          try {
            await issues.append(nome, 'mil_action', `periodic_cleanup_aboutblank n=${closed}`);
          } catch {}
        }
      } catch (e) {
        if (process.env.PRUNE_DEBUG === '1') {
          logger.warn('[PERIODIC_CLEANUP] Erro em perfil', { nome, error: e && e.message || e });
        }
      }
    }

    if (totalClosed > 0) {
      logger.info('[PERIODIC_CLEANUP] Fechou abas about:blank órfãs', { total: totalClosed });
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PERIODIC_CLEANUP] Erro geral', { error: e && e.message || e });
    }
  }
}

// Roda a cada 3 minutos (180000ms) - não agressivo, apenas limpa o que ficou esquecido
setInterval(() => { periodicAboutBlankCleanup().catch(() => {}); }, 3 * 60 * 1000);
// Primeira execução após 30 segundos (dá tempo para sistema inicializar)
setTimeout(() => { periodicAboutBlankCleanup().catch(() => {}); }, 30000);

setInterval(() => {
  const now = Date.now();
  for (const nome of Object.keys(robeMeta)) {
    if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > now && (robeMeta[nome].frozenUntil - now > 6 * 3600 * 1000)) {
      issues.append(nome, 'frozen_watchdog', 'Perfil congelado > 6h');
    }
    const desired = readJsonFile(desiredPath, { perfis: {} });
    if (desired.perfis?.[nome]?.active === true && !controllers.has(nome)) {
      issues.append(nome, 'stuck_activation', 'Desired ativo sem browser por >10min');
    }
  }
}, 10 * 60 * 1000);

let _shuttingDown = false;
async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    logger.info('[WORKER] gracefulShutdown start', { reason });
    try { robeQueue.clear(); } catch {}
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          await ctrl.virtus.stop().catch(()=>{});
        }
      } catch {}
    }
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
          await ctrl.browser.close().catch(()=>{});
        }
      } catch {}
    }
    for (const nome of _pruners.keys()) stopPruneLoop(nome);
    if (ramMonitorInterval) try { clearTimeout(ramMonitorInterval); } catch{}
  } catch (e) {
    try { logger.error('[WORKER] gracefulShutdown exception', { reason, error: e && e.message || e }, e); } catch {}
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('disconnect', () => gracefulShutdown('disconnect'));

process.on('message', async (msg) => {
  if (!msg || !msg.type || !msg.msgId) return;
  const fn = handlers[msg.type];
  if (typeof fn !== 'function') {
    logger.warn('Comando desconhecido recebido', { type: msg.type, hasMsgId: !!msg.msgId });
    sendReply(msg.msgId, { ok: false, error: 'Comando desconhecido' });
    return;
  }
  try {
    const resp = await fn(msg.payload || {});
    sendReply(msg.msgId, resp);
  } catch (e) {
    logger.error('[WORKER][MESSAGE] handler error', { type: msg.type, error: e && e.message || e }, e);
    sendReply(msg.msgId, { ok: false, error: e && e.message || String(e) });
  }
});

process.on('uncaughtException', (e) => {
  try { logger.error('uncaught', { error: e && e.message || e }, e); } catch {}
}
);
process.on('unhandledRejection', (e) => {
  try { logger.error('unhandled', { error: (e && e.message) || e }, e); } catch {}
});