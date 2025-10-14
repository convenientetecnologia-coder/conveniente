// scripts/worker.js
const path = require('path');
const fs = require('fs');
const logger = require('./logger.js');

// IMPORTS dos helpers
const browserHelper = require('./browser.js');
const virtusHelper = require('./virtus.js');
const robeHelper   = require('./robe.js');
const robeQueue    = require('./robeQueue.js');
const utils        = require('./utils.js');
const fotos        = require('./fotos.js'); // gestor central de fotos

const issues = require('./issues.js'); // <<<<<<<<<<<<<< IMPORT NOVO
const manifestStore = require('./manifestStore.js'); // <<<<<<<<<<<<<< IMPORT NOVO

// Bloqueio universal: Detecta se o pauseReason=limit_posting e o cooldown está ativo
async function isLimitPostingActive(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil || 0) > Date.now());
  } catch { return false; }
}

// Helper para normalizar retorno do Robe
function isLimitPostingRes(res) {
  return !!(res && (res.limitPosting === true || res.error === 'limit_posting' || res.HALT === true));
}

// Detecta bloqueio do Marketplace em QUALQUER aba da conta (quando o robe está rodando)
// Usada pelo nurseTick como fallback hypersafe
async function detectFbLimitInAnyPage(ctrl) {
  try {
    if (!ctrl || !ctrl.browser || typeof ctrl.browser.pages !== 'function') return false;
    const pages = await ctrl.browser.pages();
    for (const p of pages) {
      try {
        const url = p.url ? p.url() : '';
        if (/facebook\.com\/marketplace\/(create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(url)) {
          const det = await require('./browser.js').detectMessengerTempBlock(p);
          if (det && det.blocked && det.domain === 'facebook') return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// NOVO: Import RAM/CPU cross-platform
const pidusage = require('pidusage');
const psList = require('ps-list');

// Supervisor externo (slots)
const supervisorClient = require('./supervisorClient.js');
// Helper RAM disponível realista (utils)
const { getAvailableMB } = utils;

// =============== PATCH: HEALTH STATEFUL + RECOVERY ESCADA ===============
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

// INICIO DA INSTRUÇÃO (worker.js)
//
// ATUALIZAÇÃO ULTRA ROBUSTA PARA “PHANTOM STATE/SKELETON” DO MESSENGER
//
// 1) Adição após HEALTH_CFG
const PHANTOM_CFG = {
  INITIAL_GRACE_MS: 9000,          // quanto tempo esperar “de boa” ao abrir Messenger
  PERSIST_MS: 20000,               // skeleton por mais de 20s = stuck real
  CHECK_INTERVAL_MS: 5000,         // nurseTick já usa, não precisa timer extra
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
// 2) Snapshot DOM para o Messenger
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
// 3) Helpers de análise
function isPhantomFromSnapshot(snap) {
  const noThreads = (snap.rows === 0 && snap.anchors === 0);
  if (noThreads && snap.skeletons > 0) return true;
  return false;
}
function isOkFromSnapshot(snap) {
  return (snap.rows > 0 || snap.anchors > 0);
}
// 4) Auto-curing principal
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

  // Evite durante Robe/config
  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || ctrl.configurando) return false;
  if (robeMeta[nome] && robeMeta[nome].emExecucao) return false;

  // 1) navHome
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
  // 2) reload
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
  // 3) newPage
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
  // 4) Escalade: reopen browser
  ph.failures = (ph.failures || 0) + 1;
  await issues.append(nome, 'mil_action', `phantom_escalate:reopen failures=${ph.failures}`);
  // Interlock anti-flap
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return true;
  }
  await handlers.deactivate({ nome, reason: 'phantom_reopen', policy: 'preserveDesired' });
  setKillGuard(nome);
  ph.lastActionAt = now;
  return true;
}
// FIM DA INSTRUÇÃO (worker.js) – PHANTOM STATE

const healthState = new Map();
function getHealth(nome) {
  const now = Date.now();
  if (!healthState.has(nome)) {
    healthState.set(nome, {
      lastOkAt: 0, lastDomEventAt: 0, lastNetEventAt: 0, lastConsoleErrorAt: 0,
      lastUrl: '', lastTitle: '', stage: 'ok', nextTryAt: 0,
      counters: { softReloads10m: [], navHomes10m: [], newPages30m: [], cyclesWithoutLife: 0 }
    });
  }
  return healthState.get(nome);
}
function _pruneWindow(arr, ms) {
  const now = Date.now();
  return arr.filter(ts => (now - ts) < ms);
}
// ============================ FIM PATCH HEALTH ============================

// ===== PATCH MILITAR: BLOCO AUTO-ADAPTATIVO autoMode/sys/global =====
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
  RAM_KILL_MB: 1600, // Use pelo menos 1.6GB
  RAM_WARN_MB: 700
};

// APÓS o bloco do AUTO_CFG, adicione:
const OPEN_MIN_FREE_MB = parseInt(process.env.OPEN_MIN_FREE_MB || '2048', 10);   // mínimo RAM livre para abrir navegador
const HEADROOM_AFTER_OPEN_MB = parseInt(process.env.HEADROOM_AFTER_OPEN_MB || '0', 10); // mínimo RAM que deve sobrar pós-abertura (desativado)
const TARGET_ALIVE = parseInt(process.env.TARGET_ALIVE || '0', 10); // alvo de perfis vivos para SWAP quando abaixo

const autoMode = {
  mode: 'full', since: Date.now(), reason: 'supervisor_controlled',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }
//— ===== FIM PATCH MILITAR: BLOCO AUTO-ADAPTATIVO =====

// ===== LOCKS ATÔMICOS (status e manifest) =====
let _statusLock = Promise.resolve();

// ===== FIM LOCKS ATÔMICOS =====

// ======= AUTOFIX/HEAL CONFIG =======

async function milLog(type, msg) {
  try { await reportAction('system', type || 'mil_action', String(msg || '')); } catch {}
}

// ===== OPENING FLAG (global) para proteção durante abertura e killStray =======
let opening = {}; // { [nome]: true } enquanto activateOnce estiver em curso

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
      // Linux/macOS: desativado — kills apenas via PowerShell/Windows
      return;
    }
  } catch {}
}

async function killStrayChromes() {
  try {
    if (process.platform !== 'win32') {
      // Somente Windows: congelado em outras plataformas
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
      if (controllers.has(nome)) continue; // não é stray
      if (!group[nome]) group[nome] = [];
      group[nome].push(Number(proc.pid));
    }
    for (const [nome, pidList] of Object.entries(group)) {
      if (opening[nome]) { // proteção: não matar perfis em abertura
        await milLog('mil_action', `stray_skip_opening: ${nome} pids=${pidList.join(',')}`);
        continue;
      }
      if (!pidList || !pidList.length) continue;
      await milLog('mil_action', `stray_kill: ${nome} pids=${pidList.join(',')}`);
      await killPids(pidList);
    }
  } catch {}
}

// ====== BOOT ENV LOG ======
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

// Caminhos principais
const perfisPath = path.join(__dirname, '../dados', 'perfis.json');
const presetsPath = path.join(__dirname, '../dados', 'ua_presets.json');
const perfisDir = path.join(__dirname, '../dados', 'perfis');

// === INÍCIO: Adicionar caminhos dos arquivos desired.json e status.json + utilitários atômicos de I/O ===
const desiredPath = path.join(__dirname, '../dados', 'desired.json');
const statusPath  = path.join(__dirname, '../dados', 'status.json');

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
  fs.fsyncSync(fd); // <--- ADD esta linha
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
// === FIM: desired.json/status.json helpers ===



// === Helpers de manifest + cooldown ===
function manifestPathOf(nome) {
  const perfisArr = loadPerfisJson();
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  return path.join(perfil.userDataDir, 'manifest.json');
}

// Converte robeCooldownUntil -> robeCooldownRemainingMs quando a conta NÃO está apta a postar (congela)
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

// Converte robeCooldownRemainingMs -> robeCooldownUntil quando a conta está apta a postar (descongela)
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

// =============== INÍCIO: Helpers/Contagem de ERROS =====================
// === Somente ERROS devem contar para issuesCount ===
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
// =============== FIM: Helpers/Contagem de ERROS ========================

function ensureManifestValid(nome) {
  // Campos essenciais: nome, cidade, uaPresetId, uaString, uaCh, fp, cookies, userDataDir
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

  let manifest = null;
  try {
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    }
  } catch {}
  if (hasEssentials(manifest)) return manifest;

  // Tenta curar (merge) com perfis.json
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (perfil && hasEssentials(perfil)) {
      const merged = Object.assign({}, perfil, manifest || {});
      // Persiste merge, agora sanado
      if (merged.userDataDir && !fs.existsSync(merged.userDataDir)) {
        fs.mkdirSync(merged.userDataDir, { recursive: true });
      }
      // Escreve autosanado
      fs.writeFileSync(manifestPathOf(nome), JSON.stringify(merged, null, 2), 'utf8');
      return merged;
    }
  } catch {}

  // Se não curou, retorna null
  return null;
}

// =============== Issues/Actions logger (silencioso) ================
async function reportAction(nome, type, message) {
try {
if (!nome) return;
if (!issues || typeof issues.append !== 'function') return;
const msg = String(message == null ? '' : message).slice(0, 400);
await issues.append(nome, type, msg);
} catch {}
}
// ===================================================================

//
// Storage de perfis ativos
const controllers = new Map(); // nome => { browser, virtus, robe, status, configurando, trabalhando }

// Estado global do Robe (cooldown, fila, etc)
const robeMeta = {}; // { [nome]: {cooldownSec, robeCooldownUntil, estado, proximaPostagem, ultimaPostagem, emFila, emExecucao} }

// INICIO DA INSTRUÇÃO (worker.js)
//
// Objetivo: Sweeper global de memória para evitar crescimento indefinido dos estados efêmeros
function memorySweep() {
  try {
    const nomesValidos = new Set(loadPerfisJson().map(p => p.nome));
    // healthState (Map)
    for (const [n] of healthState) if (!nomesValidos.has(n) && !controllers.has(n)) healthState.delete(n);
    // profileFailures (Map)
    for (const [n] of profileFailures) if (!nomesValidos.has(n) && !controllers.has(n)) profileFailures.delete(n);
    // robeMeta (objeto)
    for (const n of Object.keys(robeMeta)) {
      if (!nomesValidos.has(n) && !controllers.has(n)) delete robeMeta[n];
    }
  } catch {}
}
setInterval(memorySweep, 10 * 60 * 1000);
// FIM DA INSTRUÇÃO (worker.js)

// Interlock global anti-flap per profile
function killGuardActive(nome) {
  return robeMeta[nome]?.killGuardUntil && robeMeta[nome].killGuardUntil > Date.now();
}
function setKillGuard(nome, ms=90000) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].killGuardUntil = Date.now() + ms;
}

// Repopular frozenUntil ao boot, lendo dos manifests
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

// Wrapper para enriquecer automaticamente os logs de issues.append (contexto completo)
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

// ======= INÍCIO: TRAVA DE ATIVAÇÃO SIMULTÂNEA =========
// ======= FIM: TRAVA DE ATIVAÇÃO SIMULTÂNEA ============

// ======= FUNÇÃO CENTRAL: isFrozenNow =======
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
// ============================================

// ======= INÍCIO: LOCK GLOBAL DE ATIVAÇÃO (ULTRA ROBUSTO) =======
const activationLocks = new Map(); // nome => Promise em andamento

async function activateOnce(nome, source = '') {
  if (opening[nome]) return { ok: false, error: 'already_opening' };

  // EARLY EXIT: já está ativo? Não peça slot nem chame notifyOpened!
  if (controllers.has(nome)) {
    return { ok: true, already: true };
  }

  // EARLY EXIT: já há job de ativação pendente? Não peça slot nem chame notifyOpened!
  const inflight = activationLocks.get(nome);
  if (inflight) {
    try { await inflight.catch(() => {}); } catch {}
    return controllers.has(nome)
      ? { ok: true, already: true }
      : { ok: false, error: 'activation_in_progress' };
  }

  // Chegou aqui, precisa abrir navegador mesmo — registre opening antes para killStray protection.
  opening[nome] = true;
  let _supervisorSlotGranted = false;
  try {
    // Supervisor interlock para aberturas durante kill_guard
    if (killGuardActive(nome)) {
      await reportAction(nome, 'guard_skip_open', 'Abertura negada por kill_guard_until');
      return { ok:false, error:"kill_guard_until" };
    }

    // [PATCH-GPT5] Não bloquear ativação por limit_posting — Virtus deve poder operar mesmo durante pausa do Robe.
    // Mantemos o gate de supervisor/slots/RAM, mas permitimos abrir o navegador mesmo com pauseReason='limit_posting'.

    // SÓ AGORA peça slot ao supervisor
    const slotResp = await supervisorClient.requestOpen(nome).catch(()=>({ok:false, error:'supervisor_unreachable'}));
    if (!slotResp || !slotResp.ok) {
      // Hold curto, não crasha
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].activationHeldUntil = Date.now() + 30000;
      await reportAction(nome, 'mil_action', `activation_hold_by_supervisor reason=${(slotResp && slotResp.reason) || 'unknown'}`);
      return { ok:false, error: `supervisor_denied:${(slotResp && slotResp.reason) || 'unknown'}` };
    }
    _supervisorSlotGranted = true;

    if (!nome) {
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'Nome ausente' };
    }

    // BLOQUEIO: não ativa se estiver congelado
    if (isFrozenNow(nome)) {
      await reportAction(nome, 'mil_action', 'block_activate_frozen');
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'account_is_frozen' };
    }

    const job = (async () => {
      logger.info('[WORKER][activateOnce] start', { nome, source });
      try {
        logger.info('[WORKER][activateOnce] start nome=' + nome + ' source=' + source);
        const manifest = ensureManifestValid(nome);
        if (!manifest) {
          // Não foi possível auto-curar (manifest + perfis.json quebrado)
          await freezeProfileFor(nome, 12*60*60*1000, 'manifest_incomplete', 'system');
          await reportAction(nome, 'robe_error', 'manifest incompleto na ativação; perfil congelado 12h');
          if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
          return { ok:false, error: 'manifest_incomplete' };
        }

        // GATE DE RAM antes de abrir (livre > 3GB)
        {
          const freeMB = getAvailableMB();
          if (freeMB <= OPEN_MIN_FREE_MB) {
            await reportAction(nome, 'mem_block_activate', `RAM livre=${freeMB}MB <= ${OPEN_MIN_FREE_MB}MB (gate)`);
            throw new Error('ram_insuficiente_para_ativar');
          }
        }

        const browser = await browserHelper.openBrowser(manifest);
        if (!browser || typeof browser.newPage !== 'function') {
          throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
        }
        // Salve rootPid para killProcessTree depois
        const proc = browser.process && browser.process();
        if (proc && proc.pid) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].rootPid = proc.pid;
        }
        controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });

        // HEADROOM pós-abrir (rollback se < 2GB) — DESATIVADO POR POLÍTICA UPTIME FIRST
        // {
        //   const freeAfter = getAvailableMB();
        //   if (freeAfter < HEADROOM_AFTER_OPEN_MB) {
        //     await reportAction(nome, 'open_rollback_memory', `Headroom pós-abrir=${freeAfter}MB < ${HEADROOM_AFTER_OPEN_MB}MB; rollback preserveDesired`);
        //     try { await handlers.deactivate({ nome, reason: 'open_headroom', policy: 'preserveDesired' }); } catch {}
        //     if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
        //     return { ok: false, error: 'headroom_below_min_after_open' };
        //   }
        // }

        // PATCH MILITAR: marcar ativação e limpar históricos/avisos
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].activatedAt = Date.now();
        robeMeta[nome].ramHist = [];
        robeMeta[nome].cpuHistory = [];
        robeMeta[nome].lastWarn = null;

        try { healer.lastProgressAt = Date.now(); } catch {}

        try { attachBrowserLifecycle(nome, browser); } catch {}
        try {
          // Define mainPage e observadores; inicia Pruner de abas
          const ctrl = controllers.get(nome);
          if (ctrl) {
            const pages = await browser.pages().catch(()=>[]);
            if (pages && pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
            maybeStartPruneLoop(nome, ctrl.browser, ctrl.mainPage);
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        // INSTRUÇÃO 4: Limpa closingReason ao abrir e autenticar com sucesso
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].closingReason = null;
        logger.info('[WORKER][activateOnce] done nome=' + nome + ' source=' + source);
        logger.info('[WORKER][activateOnce] concluído', { nome, source });
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'ok'); } catch {} }

        return { ok: true };
      } catch (e) {
        // Mantém status consistente (active:false) no snapshot em caso de falha
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
        // INICIO DA INSTRUÇÃO 9: hold em erros de RAM/headroom
        if (e && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(String(e && e.message || e))) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].activationHeldUntil = Date.now() + 15000;
          try { await reportAction(nome, 'mil_action', 'activation_hold_due_ram 15s (activateOnce)'); } catch {}
        }
        // FIM DA INSTRUÇÃO 9
        logger.error('[WORKER][activateOnce] fail', { nome, source, err: e && e.message }, e);
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
// ======= FIM: LOCK GLOBAL DE ATIVAÇÃO (ULTRA ROBUSTO) =======

function sendReply(msgId, data) {
  if (process && process.send) {
    process.send({ replyTo: msgId, data });
  }
}

// Helpers de perfis
function loadPerfisJson() {
  try { return JSON.parse(fs.readFileSync(perfisPath, 'utf8')); }
  catch { return []; }
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
    if (pf.uaPresetId) count[pf.uaPresetId] = (count[pf.uaPresetId] || 0) + 1; // corrigido bug [pf.f.uaPresetId] para [pf.uaPresetId]
  }
  let min = Math.min(...Object.values(count));
  const candidates = presets.filter(p => count[p.id] === min);
  candidates.sort(() => Math.random() - 0.5);
  return candidates[0];
}

// -- Utils Robe Timer

// PATCH 1 — Função normalizeCooldown (blindagem e correção até/remaining)
async function normalizeCooldown(nome) {
  try {
    const now = Date.now();
    const ctrl = controllers.get(nome);
    const man = await manifestStore.read(nome).catch(()=>null);
    // INSTRUÇÃO: Sincronize pauseReason do manifest para robeMeta
    try {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].pauseReason = man.robePauseReason || null;
    } catch {}
    if (!man) return 0;
    const until = Number(man.robeCooldownUntil || 0);
    const remaining = Number(man.robeCooldownRemainingMs || 0);
    const leftUntil = until > now ? (until - now) : 0;
    const leftRem = remaining > 0 ? remaining : 0;

    // Se ambos existem e diferem bastante, privilegia maior janela
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
    // Só um existe
    const finalMs = leftUntil > 0 ? leftUntil : leftRem;
    try {
      if (finalMs === 0) {
        await releaseLimitPostingIfExpired(nome);
      }
    } catch {}
    return Math.max(0, Math.floor(finalMs/1000));
  } catch { return 0; }
}

// 2.A — Função utilitária: limit_posting_release ao expirar cooldown
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
          // fallback defensivo (se por acaso houver until setado enquanto inativo)
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

function robeLastPosted(nome) {
  let ts = 0;
  try {
    const perfilPath = manifestPathOf(nome);
    if (fs.existsSync(perfilPath)) {
      const p = JSON.parse(fs.readFileSync(perfilPath, 'utf8'));
      if (p.ultimaPostagemRobe) ts = p.ultimaPostagemRobe;
    }
  } catch {}
  return ts;
}

function robeUpdateMeta(nome, patch) {
  robeMeta[nome] = robeMeta[nome] || {};
  Object.assign(robeMeta[nome], patch || {});
}

// --------------- NOVO: listar contas trabalhando (ativas e em modo de trabalho)
function getWorkingProfileNames() {
  const nomes = [];
  controllers.forEach((ctrl, nome) => {
    if (ctrl && ctrl.browser && ctrl.trabalhando) nomes.push(nome);
  });
  return nomes;
}

// ========== INICIO ALTERAÇÃO PRUNING DE ABAS ==============
async function closeExtraPages(browser, mainPage, nome) {
  try {
    const ctrl = controllers.get(nome);
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) return;
    // GUARD EXTREMO: nunca prune se emExecucao==true para esse perfil
    if (nome && robeMeta[nome] && robeMeta[nome].emExecucao === true) {
      return; // NÃO FECHA ABAS DURANTE O ROBE DESTE PERFIL
    }

    const pages = await browser.pages();
    let closed = 0;
    for (const page of pages) {
      if (mainPage && page === mainPage) continue;
      if (!mainPage && pages[0] && page === pages[0]) continue;
      // NOVO PATCH: n-u-n-c-a feche aba de Create Item (do Robe) deste perfil
      if (nome) {
        try {
          const url = typeof page.url === 'function' ? page.url() : '';
          if (/facebook\.com\/marketplace\/create\/item/i.test(url)) {
            continue;
          }
        } catch {}
      }
      try { await page.close({ runBeforeUnload: false }); closed++; } catch {}
    }
    if (closed > 0) {
      logger.info('[PRUNER] Fechou abas extras', { nome, closed });
    } else if (process.env.PRUNE_DEBUG === '1') {
      logger.info('[PRUNER] Nada a fechar', { nome });
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
    }
  }
}

// -------- PRUNE LOOP: Para cada browser, fecha abas extras periodicamente ---------
const _pruners = new Map(); // nome => pruneInterval

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
// ========== FIM ALTERAÇÃO PRUNING DE ABAS ==============

// ========== INICIO ALTERAÇÃO RAM/CHROME & CPU MONITOR CROSS-PLATFORM ==========

let ramMonitorInterval = null;

// Monitora RAM/CPU globalmente a cada N segundos, cross-platform
async function ramCpuMonitorTick() {
  const perfisArr = loadPerfisJson();
  // Build lookup userDataDir -> nome
  const nomeByUserDir = {};
  for (const p of perfisArr) {
    if (p.userDataDir) {
      nomeByUserDir[normalizePath(p.userDataDir)] = p.nome;
    }
  }
  // Associa cada perfil ao campo userDataDir normalizado
  // Temporário para associar PIDs a perfis
  const assocPerPid = {}; // pid => nome
  const pidsByNome = {};  // nome => [pids]
  const pidsMeta = {};    // pid => {cmd, ram, cpu}
  let psProcs = [];
  let winData = null;
  let erroMonitor = false;
  // Para circuit-breaker CPU
  const cpuPercentHistory = {}; // nome => [number, ...max 3]
  try {
    if (process.platform === 'win32') {
      // Windows: pega via PowerShell/WMI
      // timeout militar 5s
      await new Promise((resolve) => {
        let settled = false;
        const child = require('child_process').exec(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'chrome.exe\' or Name=\'chrome.exe*\' or Name=\'msedge.exe\'\\" | Select-Object ProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress"',
          {timeout: 5000},
          (err, stdout) => {
            if (settled) return;
            settled = true;
            if (!err && stdout) {
              try { winData = JSON.parse(stdout); } catch {}
            }
            resolve();
          }
        );
        setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 5000);
      });
      // winData pode ser objeto (único) ou array
      let allData = [];
      if (winData) {
        allData = Array.isArray(winData) ? winData : [winData];
      }
      // PARA cada processo chrome:
      for (const wproc of allData) {
        const pid = Number(wproc.ProcessId);
        if (!pid) continue;
        const cmd = wproc.CommandLine || '';
        const memBytes = Number(wproc.WorkingSetSize) || 0;
        // Detecta userDataDir
        const userDir = extractUserDataDir(cmd);
        let nome = userDir ? nomeByUserDir[normalizePath(userDir)] : null;
        if (nome) {
          assocPerPid[pid] = nome;
          pidsByNome[nome] = pidsByNome[nome] = (pidsByNome[nome] || []);
          pidsByNome[nome].push(pid);
        }
        pidsMeta[pid] = { cmd, memBytes };
      }
    } else {
      // Linux/macOS: ps-list()
      try {
        psProcs = await psList();
        for (const proc of psProcs) {
          const pid = Number(proc.pid);
          if (!pid) continue;
          let cmd = proc.cmd || proc.command || '';
          // Filtrar chrome/chromium (crosstable insensível)
          if (!/chrome|chromium/i.test(cmd)) continue;
          let userDir = extractUserDataDir(cmd);
          let nome = userDir ? nomeByUserDir[normalizePath(userDir)] : null;
          if (nome) {
            assocPerPid[pid] = nome;
            pidsByNome[nome] = pidsByNome[nome] || [];
            pidsByNome[nome].push(pid);
          }
          pidsMeta[pid] = { cmd, memBytes: null };
        }
      } catch {
        erroMonitor = true;
      }
    }

    // === STRAY CHROME KILL (perfil sem controller) ===
    try {
      for (const [nome, pids] of Object.entries(pidsByNome)) {
        if (!controllers.has(nome) && Array.isArray(pids) && pids.length) {
          await milLog('mil_action', `stray_detected: ${nome} pids=${pids.join(',')} — killing`);
          await killPids(pids);
        }
      }
    } catch {}

    // Exemplo de debug: flag por env p/ troubleshooting de problemas de monitoramento
    if (process.env.METRICS_DEBUG === '1') {
      logger.info('[METRICS] pidsByNome', { nomes: Object.keys(pidsByNome), exampleCommand: Object.values(pidsMeta)[0]?.cmd || '' });
    }

    // para cada nome: query pidusage para RAM/CPU dos seus PIDs
    // [PATCH-ANTI-STUCK][RAM-METRICS RESET]
    // Zera métricas de RAM/CPU e limpa históricos para perfis sem browser/pids.
    // Garante que RAM breaker não fique atuando contra perfil já fechado/não-vivo.
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
          // Fallback: zero, mas controle erro!
        }
        // Fallback: soma memBytes do pidsMeta do Windows se pidusage falhar
        const memSumBytes = (pids || []).reduce((acc, pid) => acc + (pidsMeta[pid]?.memBytes || 0), 0);
        if (!countValid && memSumBytes > 0) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = Math.round(memSumBytes / 1024 / 1024);
          robeMeta[nome].cpuPercent = null;
          return;
        }
        // Se não conseguiu coletar RAM/CPU suficientes (tem pids, mas erro), marcam null
        if (!countValid) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
        } else {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = typeof somaRam === "number" ? Math.round(somaRam/1024/1024) : null;
          robeMeta[nome].cpuPercent = typeof somaCpu === "number" ? Math.round(somaCpu) : null;
        }

        // Atualiza histórico CPU breaker persistente
        if (typeof robeMeta[nome].cpuPercent === "number") {
          // PATCH MILITAR: histórico persistente por perfil para CPU
          const ch = robeMeta[nome].cpuHistory || (robeMeta[nome].cpuHistory = []);
          ch.push({ t: Date.now(), p: robeMeta[nome].cpuPercent });
          while (robeMeta[nome].cpuHistory.length > 8) robeMeta[nome].cpuHistory.shift();
        }

        // Resets de streaks RAM/CPU em leituras baixas
        if (typeof robeMeta[nome].cpuPercent === 'number' && robeMeta[nome].cpuPercent < 120) {
          const ch = robeMeta[nome].cpuHistory || [];
          if (ch.length >= 2 && ch.slice(-2).every(h => h.p < 120)) robeMeta[nome].cpuHistory = [];
        }
        if (typeof robeMeta[nome].ramMB === 'number' && robeMeta[nome].ramMB < 800) {
          const rh = robeMeta[nome].ramHist || [];
          if (rh.length >= 2 && rh.slice(-2).every(h => h.mb < 800)) robeMeta[nome].ramHist = [];
        }

        // PATCH MILITAR: nunca suicidar navegador por pico de boot/start/post,
        // só mata leak persistente e nunca perfil único.
        const vivos = Array.from(controllers.values()).filter(c => !!(c && c.browser && c.trabalhando)).length;
        const actAt = robeMeta[nome]?.activatedAt || 0;
        if (!actAt || (Date.now() - actAt) < 180000) return; // <3min após ativação? ignora breaker CPU
        if (vivos <= 1) return; // nunca processa breaker se só 1 perfil trabalhando

        // Circuit-breaker CPU: só kill se leak mesmo (5 leituras altas consecutivas)
        const hist = robeMeta[nome].cpuHistory || [];
        if (hist.length >= 5) {
          const last5 = hist.slice(-5);
          const allHigh = last5.every(h => h.p >= 150);
          if (allHigh) {
            const ctrl = controllers.get(nome);
            if (ctrl && (ctrl.configurando === true || ctrl.humanControl === true)) return;

            // Interlock anti-flap
            if (killGuardActive(nome)) {
              await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
              logger.info('[BREAKER][CPU] guard_skip', { nome });
              return;
            }

            logger.warn('[BREAKER][CPU] acionado', { nome, last5: last5.map(h => h.p) });
            await handlers.deactivate({nome, reason:'cpuKill', policy:'preserveDesired'});
            setKillGuard(nome);
            await reportAction(nome, 'cpu_memory_spike', `CPU breaker acionado (>=150% por 5 rodadas) reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
            robeMeta[nome].cpuPercent = null; // marca null até a volta
          }
        }
      })());
    }
    await Promise.all(promises);
  } catch {
    erroMonitor = true;
  }

  // ===== PATCH MILITAR: RAM breaker inteligente por perfil =====
  for (const nome of Object.keys(robeMeta)) {
    // [PATCH-ANTI-STUCK] Só atua breaker se browser está realmente vivo!
    if (!controllers.has(nome)) continue;

    const now = Date.now();
    // Histerese: não agir se recente kill RAM
    if (robeMeta[nome]?.ramKillHysteresisUntil && robeMeta[nome].ramKillHysteresisUntil > now) {
      await issues.append(nome, 'ram_hysteresis_skip', `skip_until=${robeMeta[nome].ramKillHysteresisUntil}`);
      logger.info('[BREAKER][RAM] hysteresis_skip', { nome, until: robeMeta[nome].ramKillHysteresisUntil });
      continue;
    }

    const ramMB = (typeof robeMeta[nome].ramMB === 'number') ? robeMeta[nome].ramMB : null;
    if (ramMB == null) continue;

    // PATCH MILITAR: nunca suicidar navegador por pico de boot/start/post,
    // só mata leak persistente e nunca perfil único.
    const vivos = Array.from(controllers.values()).filter(c => !!(c && c.browser && c.trabalhando)).length;
    if (!robeMeta[nome].activatedAt || Date.now() - robeMeta[nome].activatedAt < 180000) continue; // <3min
    if (vivos <= 1) continue; // nunca processa breaker se só 1 perfil trabalhando

    // Thresholds: 2200MB em Windows, senão 1600MB
    const RAM_KILL_MB_LOCAL = process.platform === 'win32' ? 2200 : 1600;

    // Histórico curto
    const hist = robeMeta[nome].ramHist || (robeMeta[nome].ramHist = []);
    hist.push({ t: Date.now(), mb: ramMB });
    while (hist.length > 8) hist.shift();

    // Resets de streaks RAM/CPU em leituras baixas (após atualizar históricos)
    if (typeof robeMeta[nome].cpuPercent === 'number' && robeMeta[nome].cpuPercent < 120) {
      const ch = robeMeta[nome].cpuHistory || [];
      if (ch.length >= 2 && ch.slice(-2).every(h => h.p < 120)) robeMeta[nome].cpuHistory = [];
    }
    if (typeof robeMeta[nome].ramMB === 'number' && robeMeta[nome].ramMB < 800) {
      const rh = robeMeta[nome].ramHist || [];
      if (rh.length >= 2 && rh.slice(-2).every(h => h.mb < 800)) robeMeta[nome].ramHist = [];
    }

    // Warn apenas se RAM muito alta, sem kill
    if (ramMB >= AUTO_CFG.RAM_WARN_MB && ramMB < RAM_KILL_MB_LOCAL) {
      if (!robeMeta[nome].lastWarn || (Date.now() - robeMeta[nome].lastWarn) > 600000) {
        try { await reportAction(nome, 'chrome_memory_warn', `RAM alta: ${ramMB} MB (>=${AUTO_CFG.RAM_WARN_MB})`); } catch {}
        logger.warn('[BREAKER][RAM] warning_high_usage', { nome, ramMB, warnThreshold: AUTO_CFG.RAM_WARN_MB });
        robeMeta[nome].lastWarn = Date.now();
      }
    }

    // **Agora só KILL se leak comprovado**
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
        // Exige pelo menos 2 minutos de janela para acionar por slope
        slopeOK = (elapsedMs >= 120000) && (slope > 50) && (avg > 800);
      }
      // Só kill se comprovado leak real!
      if (allHigh || slopeOK) {
        // Dupla amostragem com delay
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
          // Atualiza leitura no hist somente se conseguimos nova amostra
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
            slopeOK2 = (elapsedMs2 >= 120000) && (slope2 > 50) && (avg2 > 800);
          }

          if (!(allHigh2 || slopeOK2)) {
            await issues.append(nome, 'ram_double_sample_clear', `skip=${ramMB2!=null?ramMB2:'n/a'}MB`);
            logger.info('[BREAKER][RAM] double_sample_clear', { nome, sampleMB: ramMB2 });
            continue;
          }
        } catch {}

        const ctrl = controllers.get(nome);
        if (ctrl && (ctrl.configurando === true || ctrl.humanControl === true)) continue;

        // Interlock anti-flap
        if (killGuardActive(nome)) {
          await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
          logger.info('[BREAKER][RAM] guard_skip', { nome });
          continue;
        }

        logger.warn('[BREAKER][RAM] acionado', { nome, ramMB, allHigh, slopeOK });
        await handlers.deactivate({ nome, reason:'ramKill', policy:'preserveDesired' });
        setKillGuard(nome);
        await reportAction(nome, 'chrome_memory_spike', `RAM breaker acionado (mb=${ramMB}, allHigh=${allHigh}, slopeOK=${slopeOK}) reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);

        // Histerese 3min
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].ramKillHysteresisUntil = Date.now() + 180000;
        robeMeta[nome].ramKilledAt = Date.now();
      }
    }
  }
  // ===== FIM PATCH MILITAR: RAM breaker inteligente por perfil =====

  // Para RAM kill militar (old path/fallback, cross)
  for (const nome of Object.keys(robeMeta)) {
    // PATCH MILITAR: fallback desativado; lógica de breaker RAM foi substituída pelo bloco acima.
    // Mantido bloco para integridade estrutural, sem ação aqui.
  }
  // ===== PATCH MILITAR: Avaliação/autoMode global =====

  // No final, snapshot status global, nunca direto!
  await snapshotStatusAndWrite();

  // Agenda próxima rodada (3–4s)
  ramMonitorInterval = setTimeout(ramCpuMonitorTick, 3500 + Math.floor(Math.random()*1000));
}

function normalizePath(x) { return String(x||'').replace(/\\/g,'/'); }

// >>>>> PATCH: REGEX ROBUSTO
function extractUserDataDir(cmd) {
  if (!cmd) return null;
  // Aceita path entre aspas (duplas ou simples) e com espaços (Windows)!
  const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(cmd);
  return m ? (m[1] || m[2] || m[3]) : null;
}
// <<<<< PATCH: REGEX ROBUSTO

// Inicia monitor global
setTimeout(ramCpuMonitorTick, 5000);

// ========== FIM ALTERAÇÃO RAM/CHROME & CPU MONITOR CROSS-PLATFORM ==========

// --------------- ROBE/TICK
async function robeTickGlobal() {
  //logger.info('[WORKER][robeTickGlobal] Tick fila global', { hora: new Date().toLocaleString() });

  const perfisArr = loadPerfisJson();
  // PATCH 2 — Usar normalizeCooldown em vez de robeCooldownLeft (pré-filtragem com Promise.all)
  const nomesAll = perfisArr.map(p => p.nome);
  const prontosArr = await Promise.all(nomesAll.map(async (nome) => {
    if (isFrozenNow(nome)) return null; // GUARD: evita spam/OOM por manifest ausente, conta está congelada
    if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
      return null; // GUARD: bloqueado até cooldown após RAM spike
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.trabalhando || ctrl.configurando || ctrl.humanControl) return null; // impede fila em modo humano
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

      // Pausa Virtus da conta durante a postagem (nível militar)
      let virtusWasRunning = false;
      const ctrl = controllers.get(nome);
      const workingNow = getWorkingProfileNames();

      // GUARD: browser precisa estar vivo
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        robeUpdateMeta(nome, { estado: 'erro' });
        try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (guard)'); } catch {}
        return;
      }

      // Log de início do Robe
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

        // Sempre parar Virtus ANTES de prune
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          virtusWasRunning = true;
          try { await ctrl.virtus.stop(); } catch {}
          ctrl.virtus = null; // ficará pausado durante o Robe
          // Mantemos ctrl.trabalhando = true para a semântica de "conta trabalhando"
        }

        // PRUNE DE ABAS: sempre antes de começar (Virtus já parado)
        try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

        // Pause curto pós-postagem
        const robePauseMs = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;

        // ==== ALTERAÇÃO HOTFIX: ANTIMANIFEST-FLOOD, COOL/PRUNED ERRORS ====
        let res;
        try {
          res = await robeHelper.startRobe(ctrl.browser, nome, robePauseMs, workingNow);
        } catch (e) {
          // PATCH: Se bloqueio LIMIT_POSTING, pause só o Robe e feche a aba criada
          if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].limitPostingThisRun = Date.now();
            robeMeta[nome].pauseReason = 'limit_posting';
            robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
            try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robeTickGlobal)'); } catch {}
            // CORRETO: NÃO fechar ctrl.mainPage. A aba de postagem já foi fechada pelo robe.js.
            return;
          }
          // Outro erro técnico: mantém ciclo igual antes
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          try { logger.warn('[WORKER][robeTickGlobal] Robe error', { nome, error: e && e.message || e }); } catch {}
          return;
        }
        // ==== EOF COOL/PRUNED ERRORS ====

        if (isLimitPostingRes(res)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].limitPostingThisRun = Date.now(); // é só in-mem/ciclo
          robeMeta[nome].pauseReason = 'limit_posting'; // reforço
          robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
          await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h');
          // CORRETO: NÃO fechar ctrl.mainPage. A aba de postagem já foi fechada pelo robe.js.
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
          robeUpdateMeta(nome, {
            estado: 'ok',
            cooldownSec: await normalizeCooldown(nome),
            proximaPostagem: robeLastPosted(nome) + robePauseMs,
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
        // PRUNE DE ABAS antes de religar o Virtus (garantia: sem paralelismo Robe/Pruner)
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

        robeUpdateMeta(nome, { emExecucao: false });

        if (virtusWasRunning) {
          if (automationAllowed(ctrl)) {
            try {
              // Sincronize epoch
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

        // Log de término do Robe
        try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado'); } catch {}
        try { logger.info('[WORKER][robeTickGlobal] Robe end', { nome }); } catch {}
      }
    });

    robeUpdateMeta(nome, { emFila: true });
  }

  // Limpe apenas flags efêmeros quando o perfil não está na fila nem executando
  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!robeQueue.inQueue(n)) delete m.emFila;
    if (!robeQueue.isActive(n)) delete m.emExecucao;
  }
}

setInterval(robeTickGlobal, 7000);
setTimeout(robeTickGlobal, 3500);

// ===== GC DE FOTOS (mantido/instalado) =====
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

// == INÍCIO: helper para desligar o Virtus (sem remover nada existente) ==
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
// PATCH 3: Epoch fence increment + optional browser fence map
ctrl.virtusEpoch = (ctrl.virtusEpoch || 0) + 1;
if (ctrl.browser) {
  ctrl.browser._fenceEpochMap = ctrl.browser._fenceEpochMap || {};
  ctrl.browser._fenceEpochMap[nome] = ctrl.virtusEpoch;
}
try { freezeCooldownIfNotWorking(nome); } catch {}
// INÍCIO ALTERAÇÃO 2
await snapshotStatusAndWrite();
// FIM ALTERAÇÃO 2
}
// == FIM: stopVirtus ==

// == INÍCIO: Função de ciclo de vida do browser (fecha no X, etc) ==
function attachBrowserLifecycle(nome, browser) {
// Dispara quando o usuário fecha o Chrome no "X" (ou o processo cai)
browser.once('disconnected', async () => {
try {
logger.info('[WORKER][BROWSER] disconnected', { nome });
// Cancela Robe em fila (se estiver)
try { robeQueue.skip && robeQueue.skip(nome); } catch {}

// Para Virtus (se houver referência)
const ctrl = controllers.get(nome);
if (ctrl) { ctrl.humanControl = false; ctrl.configurando = false; }
try {
  if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
    await ctrl.virtus.stop().catch(()=>{});
  }
} catch {}

try { freezeCooldownIfNotWorking(nome); } catch {}

// Remove do mapa de controladores
controllers.delete(nome);

// INÍCIO DA INSTRUÇÃO: Limpeza extra ao desconectar/disconnect
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
// FIM DA INSTRUÇÃO: Limpeza extra ao desconectar/disconnect

// Log de morte/desconexão imediatamente após remover do controllers
try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}

// LIMPA PRUNER DE ABAS
stopPruneLoop(nome);

// Registrar falha e agendar reabertura curta
try { registerFailure(nome, 'disconnected', 'external'); } catch {}
try {
  // Checagem desired e reopenAt existente: NÃO sobrescreva um reopenAt futuro já calculado
  const d = readJsonFile(desiredPath, { perfis: {} });
  const isDesiredActive = d.perfis?.[nome]?.active === true;
  robeMeta[nome] = robeMeta[nome] || {};
  const now = Date.now();

  if (!isFrozenNow(nome) && isDesiredActive) {
    if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
      robeMeta[nome].reopenAt = now + ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
      robeMeta[nome].closingReason = 'disconnected';
      issues.append(nome, 'mil_action', 'nurse_reopen_scheduled(disconnected)').catch(()=>{});
      setKillGuard(nome, 30000); // 30s para janela 'disconnected'
    } else {
      issues.append(nome, 'mil_action', 'reopen_preserved_existing(disconnected)').catch(()=>{});
    }
  } else {
    robeMeta[nome].reopenAt = null;
    issues.append(nome, 'mil_action', isFrozenNow(nome) ? 'reopen_suppressed_frozen' : 'reopen_suppressed_desired_off').catch(()=>{});
  }
} catch {}

// Atualiza status.json imediato
try { await snapshotStatusAndWrite(); } catch {}
} catch (e) {
  try { logger.warn('[WORKER][BROWSER] disconnect handler err', { error: e && e.message || e }); } catch {}
}
});  // <-- Fecha o browser.once('disconnected', async () => { ... })
}     // <-- Fecha a função attachBrowserLifecycle(nome, browser)

// == FIM função ciclo de vida browser ==

// ========== HANDLERS ==========
// *** SOMENTE SUPERVISOR DEVE CHAMAR ESSE HANELER DIRETAMENTE ***
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

// PATCH 1: helper automationAllowed(ctrl) — logo antes dos handlers
function automationAllowed(ctrl) {
  return !!(ctrl && !ctrl.humanControl && !ctrl.configurando && !ctrl.trabalhando);
}

// PATCH 2: handler.start_work (definido fora do objeto handlers)
async function start_work({ nome }) {
  logger.info('[HANDLER] start_work chamada', { nome });

  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.())
    return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

  // BLOQUEIO: nunca permite start_work se humano/configurando
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
    // Fence: sincronize epoch para Virtus runner anti-zumbi
    ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);

    ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch });
    ctrl.trabalhando = true;

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
}

const handlers = {
  async ['criar-perfil']({ cidade, cookies }) {
    logger.info('[HANDLER] criar-perfil chamada', { cidadeProvided: !!cidade, cookiesProvided: !!cookies });
    if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };
    if (!fs.existsSync(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

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
      userDataDir: path.join(resolveChromeUserDataRoot(), 'Conveniente', nome) // <- NOVO ROOT
    };
    try { fs.mkdirSync(perfilObj.userDataDir, { recursive: true }); } catch {}

    const perfisArr = loadPerfisJson();
    perfisArr.push(perfilObj);
    savePerfisJson(perfisArr);

    // NOVO: gravar manifest via manifestStore.update (atomicidade/locks)
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
    logger.info('[HANDLER] activate chamada', { nome });
    const r = await activateOnce(nome, 'message');
    logger.info('[HANDLER] activate resultado', { nome, ok: !!(r && r.ok), error: r && r.error });
    return r;
  },

  async deactivate({ nome, reason, policy }) {
  logger.info('[HANDLER] deactivate chamada', { nome, reason, policy });
  const preserve = (policy === 'preserveDesired');
  let reopenDelayMs = 0;
  if (preserve) {
    try { registerFailure(nome, reason || 'deactivate_preserve'); } catch {}
    if (reason === 'ramKill' || reason === 'cpuKill') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_RAMCPU_MS + Math.floor(Math.random()*120000);
    } else if (reason === 'virtus_block') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
      // 2h + 5-25min jitter
    } else {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
    }
  }
  const ctrl = controllers.get(nome);
  if (!ctrl) {
    if (preserve && !isFrozenNow(nome)) {
      robeMeta[nome] = robeMeta[nome] || {};
      const now = Date.now();
      // Só agenda se não houver reopenAt futuro
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
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
  // Kill árvore de processos órfãos (rootPid salvo em robeMeta)
  try {
    const root = robeMeta[nome]?.rootPid;
    if (root) {
      await killProcessTreeByRootPid(root);
      robeMeta[nome].rootPid = null;
    }
  } catch {}
  try { freezeCooldownIfNotWorking(nome); } catch {}
  controllers.delete(nome);

  // INICIO DA INSTRUÇÃO (opcional, recomendado): Limpeza de efêmeros em robeMeta ao desativar
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
  // FIM DA INSTRUÇÃO (opcional, recomendado)

  stopPruneLoop(nome);
  if (!preserve) {
    try {
      const d = readJsonFile(desiredPath, { perfis: {} });
      d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
      const ok = writeJsonAtomic(desiredPath, d);
      if (!ok) { try { await issues.append('system','persist_failed', `${nome}|deactivate_desired_write`); } catch {} }
    } catch {}
  } else {
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
      robeMeta[nome].reopenAt = now + reopenDelayMs;
      robeMeta[nome].closingReason = reason || '';
      issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
    } else {
      issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
    }
  }
  await snapshotStatusAndWrite();
  logger.info('[HANDLER] deactivate concluído', { nome, reason, policy });
  return { ok: true };
},

  async configure({ nome }) {
    logger.info('[HANDLER] configure chamada', { nome });
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
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

    // Pare Virtus antes de configurar
    try { await stopVirtus(nome); } catch {}

    try {
      const desired = readJsonFile(desiredPath, { perfis: {} });
      desired.perfis = desired.perfis || {};
      desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
      writeJsonAtomic(desiredPath, desired);
    } catch {}

    try {
      await browserHelper.configureProfile(ctrl.browser, nome, manifest.cookies);
      // NÃO execute closeExtraPages/prune aqui!
      logger.info('[HANDLER] configure ok', { nome });
      return { ok: true };
    } catch (e) {
      try { await issues.append(nome, 'cookie_inject_failed', e && e.message || e); } catch {}
      logger.error('[HANDLER] configure erro', { nome, error: e && e.message || e }, e);
      return { ok: false, error: e && e.message || 'falha_injetar_cookies' };
    } finally {
      ctrl.configurando = false;
      ctrl.humanControl = true;  // mantém modo humano após configurar
      stopPruneLoop(nome);
      await snapshotStatusAndWrite();
    }
  },

  start_work,

  async invoke_human({ nome }) {
    logger.info('[HANDLER] invoke_human chamada', { nome });

    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    // 1. Esperar Robe terminar (se estiver em execução para esta conta)
    const robes = robeMeta[nome] || {};
    if (robes.emExecucao) {
      // Aguarda (polling simples)
      const waitTimeout = 180 * 1000; // máx 3 minutos
      const started = Date.now();
      while ((robeMeta[nome] && robeMeta[nome].emExecucao) && (Date.now() - started < waitTimeout)) {
        await new Promise(r => setTimeout(r, 600));
      }
    }

    // 2. ATENÇÃO: SETE AS FLAGS _ANTES_ DE TUDO!
    ctrl.humanControl = true;
    ctrl.configurando = false;
    stopPruneLoop(nome); // Garante que NENHUM prune corra durante humano
    try {
      const desired = readJsonFile(desiredPath, { perfis: {} });
      desired.perfis = desired.perfis || {};
      desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
      writeJsonAtomic(desiredPath, desired);
    } catch {}
    await snapshotStatusAndWrite();

    // 3. Mata Virtus agressivamente + fence (pode ser logo após flags)
    try { await stopVirtus(nome); } catch {}

    // 4. Só então faça a navegação do humano:
    await browserHelper.invocarHumano(ctrl.browser, nome);

    // 5. (Opcional para robustez/nurse): freezer cooldown como já fazia
    try { freezeCooldownIfNotWorking(nome); } catch {}

    await snapshotStatusAndWrite();

    logger.info('[HANDLER] invoke_human ok', { nome });
    return { ok: true };
  },

  async ['human-resume']({ nome }) {
    logger.info('[HANDLER] human-resume chamada', { nome });

    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    ctrl.humanControl = false; // Sai do modo humano antes de iniciar as automações

    let pages2 = [];
    try { pages2 = await ctrl.browser.pages(); } catch {}
    if (pages2 && pages2[0]) maybeStartPruneLoop(nome, ctrl.browser, pages2[0]); // Reabilita prune ao retornar ao robô

    let pages;
    try { pages = await ctrl.browser.pages(); } catch {}
    if (pages && pages[0]) {
      try {
        await require('./browser.js').ensureMinimizedWindowForPage(pages[0]);
        await new Promise(r => setTimeout(r, 350));
        await pages[0].goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {}
    }

    // Religando Virtus APÓS a minimização/navegação
    if (automationAllowed(ctrl)) {
      ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0 });
      ctrl.trabalhando = true;
    }

    try { unfreezeCooldownIfWorking(nome); } catch {}

    await snapshotStatusAndWrite();
    logger.info('[HANDLER] human-resume ok', { nome });
    return { ok:true };
  },

  // == ALTERAÇÃO 3: Handler robe-play substituído ==
  async ['robe-play']({ nome }) {
    logger.info('[HANDLER] robe-play chamada', { nome });
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    // P0.3: recusa se frozen
    if (isFrozenNow(nome)) {
      return { ok: false, error: 'account_frozen' }
    }
    // GUARD-RAIL: IMPEDIR PRUNE/POSTAGEM enquanto está em configuração (injeção de cookies)
    if (ctrl && ctrl.configurando) return { ok: false, error: 'perfil_em_configuracao' };

    // Zera cooldown REAL no manifest (libera imediatamente este perfil) e limpa fb_block
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

    // Se não está na fila nem ativo, enfileira o callback REAL igual ao robeTickGlobal:
    if (!robeQueue.inQueue(nome) && !robeQueue.isActive(nome)) {
      robeUpdateMeta(nome, { emFila: true });
      robeQueue.enqueue(nome, async () => {

        robeUpdateMeta(nome, { emExecucao: true, emFila: false });

        let virtusWasRunning = false;
        const ctrl = controllers.get(nome);
        const workingNow = getWorkingProfileNames();

        // GUARD: browser precisa estar vivo
        if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
          robeUpdateMeta(nome, { estado: 'erro' });
          try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (robe-play guard)'); } catch {}
          return;
        }

        // Log de início do Robe (robe-play)
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

          // Sempre parar Virtus ANTES de prune
          if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
            virtusWasRunning = true;
            try { await ctrl.virtus.stop(); } catch {}
            ctrl.virtus = null;
          }

          // PRUNE ANTI-ABAS (Virtus parado)
          try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

          // ==== ALTERAÇÃO HOTFIX: ANTIMANIFEST-FLOOD, COOL/PRUNED ERRORS ====
          let res;
          try {
            res = await robeHelper.startRobe(ctrl.browser, nome, (15 + Math.floor(Math.random() * 16)) * 60 * 1000, workingNow);
          } catch (e) {
            // PATCH: Se bloqueio LIMIT_POSTING, pause só o Robe e feche a aba criada
            if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
              robeMeta[nome] = robeMeta[nome] || {};
              robeMeta[nome].limitPostingThisRun = Date.now();
              robeMeta[nome].pauseReason = 'limit_posting';
              robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
              try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robe-play)'); } catch {}
              // CORRETO: NÃO fechar ctrl.mainPage. A aba de postagem já foi fechada pelo robe.js.
              return;
            }
            await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
            try { logger.warn('[WORKER][robe-play] Robe error', { nome, error: e && e.message || e }); } catch {}
            return;
          }
          // ==== EOF COOL/PRUNED ERRORS ====

          if (isLimitPostingRes(res)) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].limitPostingThisRun = Date.now();
            robeMeta[nome].pauseReason = 'limit_posting';
            robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
            await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h (robe-play)');
            // CORRETO: NÃO fechar ctrl.mainPage. A aba de postagem já foi fechada pelo robe.js.
            return; // ciclo abortado, não religar virtus
          }

          if (res && res.ok) {
            try {
              await manifestStore.update(nome, (m) => {
                m = m || {};
                m.ultimaPostagemRobe = Date.now();
                return m;
              });
            } catch {}
            robeUpdateMeta(nome, {
              estado: 'ok',
              cooldownSec: await normalizeCooldown(nome),
              proximaPostagem: robeLastPosted(nome) + ((15+Math.floor(Math.random()*16))*60*1000),
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
          // PRUNE DE ABAS antes de religar o Virtus
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

          robeUpdateMeta(nome, { emExecucao: false });

          if (virtusWasRunning) {
            if (automationAllowed(ctrl)) {
              try {
                // Sincronize epoch
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

          // Log de término do Robe (robe-play)
          try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado (robe-play)'); } catch {}
          try { logger.info('[WORKER][robe-play] Robe end', { nome }); } catch {}
        }
      });
      await snapshotStatusAndWrite();
    }
    logger.info('[HANDLER] robe-play ok', { nome });
    return { ok: true };
  },
  // == FIM ALTERAÇÃO 3 ==

  // INICIO DA INSTRUÇÃO (worker.js) - Handler robes-release-all
  async ['robes-release-all']() {
    logger.info('[HANDLER] robes-release-all chamada');
    // Limpa pauseReason de todos os perfis em robeMeta + no manifest (remover robePauseReason)
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
  // FIM DA INSTRUÇÃO (worker.js) - Handler robes-release-all

  async ['get-status']() {
    // INICIO DA INSTRUÇÃO 5: cap arrays efêmeros antes de gerar status
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
    // FIM DA INSTRUÇÃO 5

    const perfisArr = loadPerfisJson();
    const perfis = perfisArr.map(p => {
      const nome = p.nome;
      let issuesCount = 0;
      try {
        if (issues && typeof issues.countErrors === 'function') {
          const res = issues.countErrors(nome);
          issuesCount = Number(res && res.count) || 0;
        } else {
          issuesCount = countErrorsLocal(nome); // fallback local
        }
      } catch { issuesCount = 0; }
      const fail = getFailureCounts(nome);
      // PATCH 7 — manifestStatus
      let manifestStatus = 'missing';
      try {
        const mPath = manifestPathOf(nome);
        if (fs.existsSync(mPath)) {
          const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
          const ok = man &&
            typeof man.nome === 'string' && man.nome &&
            typeof man.cidade === 'string' && man.cidade &&
            typeof man.uaPresetId !== 'undefined' &&
            typeof man.uaString === 'string' && man.uaString &&
            typeof man.uaCh === 'object' && man.uaCh &&
            typeof man.fp === 'object' && man.fp &&
            Array.isArray(man.cookies) && man.cookies.length &&
            typeof man.userDataDir === 'string' && man.userDataDir;
          manifestStatus = ok ? 'ok' : 'incomplete';
        } else {
          manifestStatus = 'missing';
        }
      } catch { manifestStatus = 'missing'; }
      return {
        nome,
        label: p.label || null,
        cidade: p.cidade,
        uaPresetId: p.uaPresetId,
        active: controllers.has(nome),
        trabalhando: !!(controllers.get(nome)?.trabalhando),
        configurando: !!(controllers.get(nome)?.configurando),
        humanControl: !!(controllers.get(nome)?.humanControl), // <-- Expor flag Modo Humano na pill
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
        lastSwapAt: robeMeta[nome]?.lastSwapAt || null
      };
    });
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
      // PATCH 1: Forçar transmissão de limit_posting no get-status
      const man = await manifestStore.read(nome).catch(()=>null);
      if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
        robes[nome].pauseReason = 'limit_posting';
        robes[nome].estado = 'paused_limit';
        await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
      }
    }
    const robeQueueList = robeQueue.queueList();
    // PATCH autoMode/sys: incluir autoMode e sys
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
    if (!nome) return { ok: false, error: 'nome_obrigatorio' };
    try { await unfreezeProfile(nome, setBy || 'admin'); } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
    return { ok: true };
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
  }
};

// == INÍCIO: função para escrever o snapshot de status (status.json) ==
async function snapshotStatusAndWrite() {
_statusLock = _statusLock.then(async () => {
try {
// INICIO DA INSTRUÇÃO 5: cap arrays efêmeros antes de gerar snapshot
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
// FIM DA INSTRUÇÃO 5

const perfisArr = loadPerfisJson();
const perfis = perfisArr.map(p => {
const nome = p.nome;
let issuesCount = 0;
try {
  if (issues && typeof issues.countErrors === 'function') {
    const res = issues.countErrors(nome);
    issuesCount = Number(res && res.count) || 0;
  } else {
    issuesCount = countErrorsLocal(nome); // fallback local
  }
} catch {}
const fail = getFailureCounts(nome);
// PATCH 7 — manifestStatus
let manifestStatus = 'missing';
try {
  const mPath = manifestPathOf(nome);
  if (fs.existsSync(mPath)) {
    const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    const ok = man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
    manifestStatus = ok ? 'ok' : 'incomplete';
  } else {
    manifestStatus = 'missing';
  }
} catch { manifestStatus = 'missing'; }
return {
  nome,
  label: p.label || null,
  cidade: p.cidade,
  uaPresetId: p.uaPresetId,
  active: controllers.has(nome),
  trabalhando: !!(controllers.get(nome)?.trabalhando),
  configurando: !!(controllers.get(nome)?.configurando),
  humanControl: !!(controllers.get(nome)?.humanControl), // <-- Expor flag Modo Humano na pill
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
  lastSwapAt: robeMeta[nome]?.lastSwapAt || null
  // overweightNow: !!robeMeta[nome]?.overweightNow,
  // overweightSince: robeMeta[nome]?.overweightSince || null,
  // lastMaintenanceAt: robeMeta[nome]?.lastMaintenanceAt || null,
  // lastResetAt: robeMeta[nome]?.lastResetAt || null,
  // lastRamBeforeReset: (typeof robeMeta[nome]?.lastRamBeforeReset === 'number') ? robeMeta[nome].lastRamBeforeReset : null,
  // lastRamAfterReset: (typeof robeMeta[nome]?.lastRamAfterReset === 'number') ? robeMeta[nome].lastRamAfterReset : null,
  // lastDeltaMB: (typeof robeMeta[nome]?.lastDeltaMB === 'number') ? robeMeta[nome].lastDeltaMB : null
};
});
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
  // overweightNow: !!robeMeta[nome]?.overweightNow,
  // overweightSince: robeMeta[nome]?.overweightSince || null,
  // lastMaintenanceAt: robeMeta[nome]?.lastMaintenanceAt || null,
  // lastResetAt: robeMeta[nome]?.lastResetAt || null,
  // lastRamBeforeReset: (typeof robeMeta[nome]?.lastRamBeforeReset === 'number') ? robeMeta[nome].lastRamBeforeReset : null,
  // lastRamAfterReset: (typeof robeMeta[nome]?.lastRamAfterReset === 'number') ? robeMeta[nome].lastRamAfterReset : null,
  // lastDeltaMB: (typeof robeMeta[nome]?.lastDeltaMB === 'number') ? robeMeta[nome].lastDeltaMB : null
};
// 2.C — Liberação automática: limit_posting_release ao expirar cooldown
try {
  if (robes[nome].cooldownSec === 0) {
    await releaseLimitPostingIfExpired(nome);
  }
} catch {}
// (Opcional Higiene) – limpeza defensiva pós-cooldown
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
// PATCH autoMode/sys: incluir no statusObj
const sys = {
  freeMB: Math.round(os.freemem()/(1024*1024)),
  totalMB: Math.round(os.totalmem()/(1024*1024)),
  cores: (os.cpus()||[]).length,
  cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
};
const statusObj = { perfis, robes, robeQueue: robeQueueList, autoMode, sys, ts: Date.now() };
// Não inclui mais robeRam obsoleto, pois RAM por perfil já está em perfis/robes.
// Unificado cross-platform.
const ok = writeJsonAtomic(statusPath, statusObj);
if (!ok) { try { await issues.append('system','persist_failed', 'status_write'); } catch {} }
} catch (e) {
try { logger.warn('[WORKER][statusWrite] erro', { error: e && e.message || e }); } catch {}
}
});
try { supervisorClient.sendTelemetria({ type: 'hb', alive: controllers.size }); } catch {}
return _statusLock;
}
// == FIM: snapshotStatusAndWrite ==

// Debounce de logs via Nurse (1x/60s por diagnóstico)
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

// ENFERMEIRO DIGITAL — Saúde contínua de contas/navegadores:
const NURSE_CFG = {
  INTERVAL_MS: 5000,
  PAGE_EVAL_TIMEOUT_MS: 5000  // Mais tolerância, menos falso-positivo
};

// Pequeno slot global para abrir perfis em série + delay entre aberturas
const MAX_OPEN_CONCURRENCY = 1; // hard para servidor fraco!
let slotsInUse = 0;
const OPEN_ACTIVATION_DELAY_MS = parseInt(process.env.OPEN_ACTIVATION_DELAY_MS || '1200', 10); // delay entre ativações

// === ULTRA RECOVERY (militar) ===
const ULTRA_RECOVERY = {
  MAX_RELOADS: 2,                   // no máximo 2 reloads curtos por página zumbi
  RELOAD_TIMEOUT_MS: 10000,         // Mais tempo para reload Messenger
  RELOAD_POST_WAIT_MS: 250,         // pequena espera pós-reload
  REOPEN_DELAY_SHORT_MS: 60000,      // reabrir "já já" (nurse_kill, no_pages)
  REOPEN_DELAY_RAMCPU_MS: 60000, // reabrir após 60s em RAM/CPU kill (usaremos também jitter)
  FAIL_WINDOW_MS: 3*60*60*1000,     // 3h janela
  FAIL_FREEZE_AFTER: 5,             // >5 falhas em 3h => congela
  FAIL_FREEZE_MS: 2*60*60*1000,      // congela por 2h
  REOPEN_DELAY_VIRTUS_BLOCK_MS: 2*60*60*1000 // 2h
};

// ===== INÍCIO DO MÉTODO ULTRA CIRÚRGICO: ensureFrozenShutdown =====
async function ensureFrozenShutdown(nome, origin = 'frozen') {
  const ctrl = controllers.get(nome);
  if (!ctrl) return;
  try { robeQueue.skip && robeQueue.skip(nome); } catch {}
  try { await reportAction(nome, 'mil_action', 'frozen_kill'); } catch {}
  try {
    // Fecha “preservando desired”, mas sem reabrir durante o frozen
    await handlers.deactivate({ nome, reason: 'frozen', policy: 'preserveDesired' });
  } catch {}
  try { stopPruneLoop(nome); } catch {}
  try {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].reopenAt = null; // impede tentativa de reabrir antes do fim do frozen
    robeMeta[nome].activationHeldUntil = robeMeta[nome].frozenUntil || (Date.now() + 3600_000);
  } catch {}
  try { await snapshotStatusAndWrite(); } catch {}
}
// ===== FIM DO MÉTODO ULTRA CIRÚRGICO =====

// ===== CLASSIFICAÇÃO DE FALHAS =====
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
    internal: (rec.internal||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS),
    external: (rec.external||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS),
    unknown: (rec.unknown||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS)
  };
  // Atualiza janela já podada
  profileFailures.set(nome, pruned);
  return { internal: pruned.internal.length, external: pruned.external.length, unknown: pruned.unknown.length };
}

const profileFailures = new Map(); // nome => { internal:[], external:[], unknown:[] }
async function registerFailure(nome, reason, classification) {
  const now = Date.now();
  const cls = classification || classifyReason(reason, 'unknown');
  const rec = profileFailures.get(nome) || { internal: [], external: [], unknown: [] };
  // prune old
  rec.internal = (rec.internal||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.external = (rec.external||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.unknown  = (rec.unknown ||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  // push
  if (cls === 'internal') rec.internal.push(now);
  else if (cls === 'external') rec.external.push(now);
  else rec.unknown.push(now);
  profileFailures.set(nome, rec);
  const counts = getFailureCounts(nome);
  try { await issues.append(nome, 'failure', `reason=${reason} class=${cls} internal=${counts.internal} external=${counts.external} unknown=${counts.unknown}`); } catch {}

  // CONGELAR APENAS POR MOTIVO LÍCITO
  const ALLOWED_FREEZE_REASONS = new Set(['manifest_missing','manifest_incomplete']);
  if (ALLOWED_FREEZE_REASONS.has(reason)) {
    await freezeProfileFor(nome, 12*60*60*1000, reason, 'system'); // 12h
    await ensureFrozenShutdown(nome, reason || 'frozen');
  }
  // Qualquer outro motivo: NUNCA congele; apenas log.
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

// Funções adicionadas próximas ao nurseTick
function ms(h) { return h * 60 * 60 * 1000; }

// Congela perfil por um tempo (msDuration), persiste congelamento, faz shutdown.
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
        until = existing + msDuration; // soma janela
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
    robeMeta[nome].activationHeldUntil = now + 60*1000; // 60s hold
    robeMeta[nome].reloadAttemptsWindow = [];
    robeMeta[nome].unfreezeCount = (robeMeta[nome].unfreezeCount || 0) + 1;
    robeMeta[nome].lastUnfreezeAt = now;
    robeMeta[nome].reopenAt = null; // <<< LIMPA HOLDS RESIDUAIS AO DESCONGELAR

    await manifestStore.update(nome, (man) => {
      man = man || {};
      if ('frozenUntil' in man) delete man.frozenUntil;
      if ('frozenReason' in man) delete man.frozenReason;
      if ('frozenAt' in man) delete man.frozenAt;
      if ('frozenSetBy' in man) delete man.frozenSetBy;
      return man;
    });

    // Zera falhas
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

// Detecta bloqueio temporário pelo DOM do Messenger, retorna {blocked, hasReloadBtn}
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

// LOCK de reentrada do nurseTick
let _nurseTickRunning = false;

async function nurseTick() {
  if (_nurseTickRunning) return;
  _nurseTickRunning = true;
  try {
    const now = Date.now();
    const desired = readJsonFile(desiredPath, { perfis: {} });
    for (const nome of Object.keys(desired.perfis || {})) {
      const want = desired.perfis[nome] || {};
      const ctrl = controllers.get(nome);
      if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) {
        continue; // NUNCA navega, religia, nem prune enquanto em humano ou configurando
      }

      // GUARD: nunca manter ativo durante frozen
      if (isFrozenNow(nome)) {
        if (ctrl) { await ensureFrozenShutdown(nome, 'nurse_guard'); }
        continue;
      }

      // nurseTick não compete se healthTick recovering (histerese de recuperação)
      const hs = getHealth && getHealth(nome);
      if (hs && ['recover1','recover2','recover3'].includes(hs.stage)) {
        await appendIssueNurseDebounced(nome,'mil_action','health_recovery_in_progress_skip','health_recovery_in_progress_skip');
        continue;
      }

      // INICIO DA INSTRUÇÃO 6: substituição do trecho nurseTick para modo leve e holds
      if (want.active === true && !ctrl) {
        if (isFrozenNow(nome)) continue;

        // Respeitar holds e agendamentos de reabertura
        if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > Date.now()) continue;
        if (robeMeta[nome]?.reopenAt && robeMeta[nome].reopenAt > Date.now()) continue;

        // Slot global de aberturas
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

                // Tenta swap
                const swapped = await trySwapOpen(nome);

                if (!swapped) {
                  // backoff progressivo: dobra até max 5min
                  robeMeta[nome] = robeMeta[nome] || {};
                  const prevBackoff = robeMeta[nome].openBackoffMs || 15000;
                  const curBackoff = Math.min(300000, prevBackoff*2);
                  robeMeta[nome].openBackoffMs = curBackoff;
                  robeMeta[nome].activationHeldUntil = Date.now() + curBackoff;
                  await issues.append(nome, 'mil_action', `open_backoff escalated to ${Math.floor(curBackoff/1000)}s`);
                  logger.warn('[SWAP] open_backoff escalated', { nome, backoffMs: curBackoff, reason: err });
                } else {
                  logger.info('[SWAP] swap_open_success (nurse)', { target: nome });
                }
                // Se swap foi bem-sucedido, não seta activationHeld, tentará na próxima ronda normal
              }
            } else {
              // Sucesso: zera backoff (se existia)
              if (robeMeta[nome]) robeMeta[nome].openBackoffMs = 15000;
              logger.info('[NURSE] activateOnce ok', { nome });
            }
          } catch { }
        } finally {
          slotsInUse--;
        }
        // Pequeno delay entre ativações
        await new Promise(r => setTimeout(r, OPEN_ACTIVATION_DELAY_MS));
        continue;
      }
      // FIM DA INSTRUÇÃO 6

      if (!ctrl || !ctrl.browser) continue;
      let pages = [];
      try { pages = await ctrl.browser.pages().catch(()=>[]); } catch {}

      // INSTRUÇÃO 2: Dupla confirmação no_pages + retry + strikes
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].noPagesStrikes = robeMeta[nome].noPagesStrikes || 0;
      robeMeta[nome].lastNoPagesAt = robeMeta[nome].lastNoPagesAt || 0;

      if (!pages || !pages[0]) {
        let retryFailed = false;
        // Se browser.isConnected?.() é true — tente pages() novamente após 400ms
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
      // INSTRUÇÃO 1: SUBSTITUIR LÓGICA DE DETECÇÃO
      // DETECÇÃO: sempre checar Messenger; checar Facebook só em create/seller
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
          det = await browserHelper.detectMessengerTempBlock(p0);
          det.domain = det.domain || 'facebook';
        }
      } catch {}

      // INSTRUÇÃO 5: Bloqueio Messenger – Confirmação 2-de-3 leituras (janela 5s), blockHysteresisUntil
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow || [];
      let now2 = Date.now();

      if (det && det.blocked && det.domain === 'messenger') {
        // Mantenha array dos últimos 3 detecções em 5s
        robeMeta[nome].blockDetectWindow.push(now2);
        // mantém só strikes na janela de 5s
        robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow.filter(ts => now2 - ts <= 5000);
        // Cap a 8 entradas
        while (robeMeta[nome].blockDetectWindow.length > 8) robeMeta[nome].blockDetectWindow.shift();

        if (robeMeta[nome].blockDetectWindow.length >= 2 && (!robeMeta[nome].blockHysteresisUntil || robeMeta[nome].blockHysteresisUntil < now2)) {
          // Confirme: se for 2 de 3 strikes, só aqui desativa
          await appendIssueNurseDebounced(nome, `action_virtus_block`, `blockDetectWindow=${robeMeta[nome].blockDetectWindow.length}`, 'action_virtus_block');
          robeMeta[nome].blockHysteresisUntil = now2 + 15*60*1000; // 15min block window
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
      if (robeMeta[nome].blockHysteresisUntil && robeMeta[nome].blockHysteresisUntil > now2) continue; // suprime dentro da block window

      // Facebook block (mantém comportamento anterior)
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
        // PATCH MILITAR: PRESERVAR limit_posting — não sobrescrever com fb_block
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue; // NÃO sobrescreve, pill correta; não aplica fb_block
        }
        // Só se NÃO era limit_posting, aplica fb_block:
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      // --- INICIO PATCH VARREDURA MULTI-TAB ENQUANTO ROBO ATIVO ---
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
        // PATCH MILITAR MULTI-ABA: PRESERVAR limit_posting — não sobrescrever com fb_block
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue; // não sobrescreve!
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }
      // --- FIM PATCH VARREDURA MULTI-TAB ---

      // NÃO competir com recovery stateful (redundante, mas mantém)
      const hs2 = getHealth && getHealth(nome);
      if (hs2 && (hs2.stage === 'recover1' || hs2.stage === 'recover2' || hs2.stage === 'recover3')) {
        continue;
      }

      let healthy = await pageReadyBasic(p0);
      if (!healthy) {
        // Histerese pós-reload recover: suprime por 90s
        if (robeMeta[nome].recoveryHysteresisUntil && robeMeta[nome].recoveryHysteresisUntil > Date.now()) {
          await appendIssueNurseDebounced(nome, 'hysteresis_skip', 'Aguardando histerese pós-recover', 'hysteresis_skip_after_recover');
          continue;
        }

        // Debounce: conta reloads nos últimos 60s, pausa se ultrapassar 3
        robeMeta[nome] = robeMeta[nome] || {};
        const nowReload = Date.now();
        if (!robeMeta[nome].reloadAttemptsWindow) robeMeta[nome].reloadAttemptsWindow = [];
        robeMeta[nome].reloadAttemptsWindow = robeMeta[nome].reloadAttemptsWindow.filter(ts => nowReload - ts < 60000);

        robeMeta[nome].reloadAttemptsWindow.push(nowReload);
        // Cap a 8 entradas
        while (robeMeta[nome].reloadAttemptsWindow.length > 8) robeMeta[nome].reloadAttemptsWindow.shift();

        if (robeMeta[nome].reloadAttemptsWindow.length > 3) {
          // Log e GRACE: não tente novo reload nos próximos 60s
          robeMeta[nome].reloadBlockedUntil = nowReload+60000;
          await reportAction(nome, 'mil_action', 
            `nurse_reload_blocked: Excesso de reloads (${robeMeta[nome].reloadAttemptsWindow.length}) em 60s, url=${(p0.url&&p0.url())||''}`
          );
          continue; // Não tenta nem reload nem kill — só sai do loop até a próxima rodada.
        }
        if (robeMeta[nome].reloadBlockedUntil && robeMeta[nome].reloadBlockedUntil > nowReload) {
          continue; // Se grace está ativo, pula hint de reload para este ciclo
        }

        healthy = await tryReloadShort(p0, nome, 1);
        if (!healthy) {
          healthy = await tryReloadShort(p0, nome, 2);
        }
        if (healthy) {
          await reportAction(nome, 'mil_action', 'nurse_recover_success(reload)');
          // Histerese pós-reload
          robeMeta[nome].recoveryHysteresisUntil = Date.now() + 90000;
        } else {
          // INSTRUÇÃO 4: “page_zumbi” dupla de falha em ciclos (anti-flap)
          robeMeta[nome].zombieStrikes = robeMeta[nome].zombieStrikes || 0;
          robeMeta[nome].zombieStrikes += 1;
          await appendIssueNurseDebounced(nome, `suspect_page_zombie`, `strike=${robeMeta[nome].zombieStrikes}`, 'suspect_page_zombie');
          if (robeMeta[nome].zombieStrikes >= 2) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until', 'guard_skip_page_zombie');
              continue;
            }
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

      // INSTRUÇÃO 5 — INSERIR EXATAMENTE AQUI (DEPOIS de pageReadyBasic/reloads e ANTES de prune/virtus)
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
              ph.firstSeenAt = 0; // vazio legítimo: não perturbar
            }
          }
        }
      } catch {}
      // FIM DA INSERÇÃO DA INSTRUÇÃO 5

      // Guard-rail ultra militar: nunca podar/prune abas durante configuração (injeção de cookies)
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

// PASSO 1 — Adicionar função trySwapOpen(nomeTarget) logo após nurseTick
async function trySwapOpen(target) {
  // Tenta fechar navegador mais RAM-eater para abrir "target"
  const aliveNames = Array.from(controllers.keys());
  if (aliveNames.length <= 1) return false; // nunca swap se 1 só ativo

  // Ordena vivos por RAM decrescente e pega quem tem mais RAM (mas ignora "target")
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
    await new Promise(r=>setTimeout(r, 2000)); // settle RAM
    
    // Tenta abrir o target
    const r = await activateOnce(target, 'nurse_swap');
    if (r && r.ok) {
      await issues.append(target, 'mil_action', `swap_open_success após fechar ${cand.n}`);
      robeMeta[target] = robeMeta[target] || {};
      robeMeta[target].lastSwapAt = Date.now();
      logger.info('[SWAP] swap_open_success', { target, fechado: cand.n });
      return true;
    }
    // Swap não foi bem-sucedido, log e continue para o próximo possível
    await issues.append(target, 'mil_action', `swap_open_failed após fechar ${cand.n}`);
    logger.warn('[SWAP] swap_open_failed', { target, fechado: cand.n });
  }
  await issues.append(target, 'mil_action', 'swap_open_failed_nenhum_sucesso');
  logger.warn('[SWAP] swap_open_failed_nenhum_sucesso', { target });
  return false;
}

setInterval(() => { nurseTick().catch(()=>{}); }, NURSE_CFG.INTERVAL_MS);
setTimeout(() => { nurseTick().catch(()=>{}); }, 2000);

// =================== HEALTH: Observers, Heuristics e Recovery ===================
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
    st.counters.newPages30m = _pruneWindow(st.counters.newPages30m, 30*60*1000);
    if (st.counters.newPages30m.length >= HEALTH_CFG.MAX_NEWPAGE_30MIN) return false;
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
    } catch {}
    st.counters.newPages30m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.newPage;
    try { await issues.append(nome, 'mil_action', 'health_recover:newPage'); } catch {}
    return true;
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
  for (const [nome, ctrl] of controllers) {
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) continue;
    if (!ctrl || !ctrl.browser) continue;
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

    // DETECÇÃO: sempre checar Messenger; checar Facebook só em create/seller
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
        // Desliga Virtus, fecha navegador, agenda reopenAt, loga, UX: Bloqueio temporário Messenger
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
        // Pausa só o Robe, Virtus segue ativo; log, carimba motivo
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
        // Só se NÃO era limit_posting, aplica fb_block:
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
        // try { await registerFailure(nome, 'health_no_progress', 'internal'); } catch {}
      }
    }
  }
}
setInterval(() => { healthTick().catch(()=>{}); }, HEALTH_CFG.TICK_MS);
setTimeout(() => { healthTick().catch(()=>{}); }, 2500);
// =================== FIM HEALTH ===================

// ============ INÍCIO: PATCH/MODO FROZEN SE MANIFEST AUSENTE ==============

// PATCH: intercepta robeHelper.startRobe para bloquear e congelar militarmente se manifest ausente
const _startRobeOrig = robeHelper.startRobe;
robeHelper.startRobe = async function(browser, nome, robePauseMs, workingNow) {
  // GUARD: antifila infinito, antiflood militar se manifest ausente
  let manifest;
  try { manifest = await manifestStore.read(nome); } catch(e){}
  if (!manifest) {
    // Congela por 12h via worker
    try { freezeProfileFor(nome, 12*60*60*1000, 'manifest_missing', 'system').catch(()=>{}); } catch {}
    await reportAction(nome, 'robe_error', 'manifest ausente; congelado por 12h');
    await ensureFrozenShutdown(nome, 'manifest_missing'); // para manifest ausente
    return { ok: false, error: 'no_manifest' };
  }

  // Circuit breaker/migração manifest incompleto
  if (!manifest.cookies || !manifest.fp) {
    try { freezeProfileFor(nome, 12*60*60*1000, 'manifest_incomplete', 'system').catch(()=>{}); } catch {}
    await reportAction(nome, 'robe_error', 'manifest incompleto (cookies/fp); congelado por 12h');
    await ensureFrozenShutdown(nome, 'manifest_incomplete'); // para manifest incompleto
    return { ok: false, error: 'incomplete_manifest' };
  }

  // Cooldown sempre é 15–30min padronizado! NUNCA penalidade curta especial pós-falha.
  const now = Date.now();
  // RAM killbackoff (Terminator)
  if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
    return { ok: false, error: 'ram_backoff' };
  }
  try {
    // Chamando normalmente
    return await _startRobeOrig.apply(this, arguments);
  } catch (e) {
    // Cooldown sempre é 15–30min padronizado! NUNCA penalidade curta especial pós-falha.
    await reportAction(nome, 'robe_error', `Erro técnico no Robe: ${(e&&e.message)||e}. Cooldown padrão (15–30min) será aplicado por robe.js`);
    return { ok: false, error: String(e&&e.message||e) };
  }
};

// ============ FIM: PATCH/MODO FROZEN SE MANIFEST AUSENTE ==============

// ===== Watchdog de stuck/frozen =====
setInterval(() => {
  const now = Date.now();
  for (const nome of Object.keys(robeMeta)) {
    if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > now && (robeMeta[nome].frozenUntil - now > 6 * 3600 * 1000)) {
      issues.append(nome, 'frozen_watchdog', 'Perfil congelado > 6h');
    }
    const desired = readJsonFile(desiredPath, { perfis: {} });
    if (desired.perfis?.[nome]?.active === true && !controllers.has(nome)) {
      // desired ativo mas não há browser controlando — stuck
      issues.append(nome, 'stuck_activation', 'Desired ativo sem browser por >10min');
    }
  }
}, 10 * 60 * 1000);

// ====== GRACEFUL SHUTDOWN ======
let _shuttingDown = false;
async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    logger.info('[WORKER] gracefulShutdown start', { reason });
    try { robeQueue.clear(); } catch {}
    // Para o Virtus de todas as contas
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          await ctrl.virtus.stop().catch(()=>{});
        }
      } catch {}
    }
    // Fecha os browsers de todas as contas
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
          await ctrl.browser.close().catch(()=>{});
        }
      } catch {}
    }
    // LIMPA todos os intervals do pruner
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
  //logger.info('[WORKER][MESSAGE] received', { type: msg.type, hasMsgId: !!msg.msgId });
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
});
process.on('unhandledRejection', (e) => {
  try { logger.error('unhandled', { error: (e && e.message) || e }, e); } catch {}
});