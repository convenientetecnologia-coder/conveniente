// scripts/worker.js
const path = require('path');
const fs = require('fs');

// IMPORTS dos helpers
const browserHelper = require('./browser.js');
const virtusHelper = require('./virtus.js');
const robeHelper   = require('./robe.js');
const robeQueue    = require('./robeQueue.js');
const utils        = require('./utils.js');
const fotos        = require('./fotos.js'); // gestor central de fotos

const issues = require('./issues.js'); // <<<<<<<<<<<<<< IMPORT NOVO
const manifestStore = require('./manifestStore.js'); // <<<<<<<<<<<<<< IMPORT NOVO

// NOVO: Import RAM/CPU cross-platform
const pidusage = require('pidusage');
const psList = require('ps-list');
const serverCap = require('./serverCap.js');

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
  RAM_KILL_MB: 900,
  RAM_WARN_MB: 700
};

// APÓS o bloco do AUTO_CFG, adicione:
const OPEN_MIN_FREE_MB = parseInt(process.env.OPEN_MIN_FREE_MB || '3072', 10);   // mínimo RAM livre para abrir navegador
const HEADROOM_AFTER_OPEN_MB = parseInt(process.env.HEADROOM_AFTER_OPEN_MB || '2048', 10); // mínimo RAM que deve sobrar pós-abertura

// INICIO DA INSTRUÇÃO (scripts/worker.js – MODO LEVE INTELIGENTE, ORÇAMENTO DINÂMICO, FAIRNESS REAL)
// 1. Logo após o bloco do AUTO_CFG, adicione:
const LIGHT_BUDGET_CFG = {
  BROWSER_DEFAULT_MB: 600,
  SAFETY_FREE_MB:     1024,
  MIN_KEEP:           1,
  PRIORITY:           'LOW_RAM_FIRST',
  HOLD_MS:            90000,
  REEVAL_MS:          15000
};
const lightPlan = {
  keep: new Set(),
  drop: new Set(),
  lastEvalAt: 0
};

// 2. Função para calcular capacidade (RAM budget/cap):
function computeLightCapacity() {
  const freeMB = Math.round(require('os').freemem()/(1024*1024));
  const active = Array.from(controllers.keys());
  const measured = active
    .map(n => robeMeta[n] && robeMeta[n].ramMB)
    .filter(v => typeof v === 'number' && v > 0);
  const avgMB = measured.length
    ? Math.max(350, Math.round(measured.reduce((a,b)=>a+b,0)/measured.length))
    : LIGHT_BUDGET_CFG.BROWSER_DEFAULT_MB;
  const cap = Math.max(LIGHT_BUDGET_CFG.MIN_KEEP,
    Math.floor(Math.max(0, freeMB - LIGHT_BUDGET_CFG.SAFETY_FREE_MB) / avgMB)
  );
  return { cap, avgMB, freeMB };
}

// 3. Função para orquestrar quem fica e quem cai em modo leve:
async function enforceLightBudget(reason = 'light_tick') {
  const { cap, avgMB, freeMB } = computeLightCapacity();
  const active = Array.from(controllers.keys());
  if (active.length <= cap) {
    lightPlan.keep = new Set(active);
    lightPlan.drop.clear();
    await milLog('mil_action', `light_budget_ok active=${active.length} cap=${cap} free=${freeMB}MB avg=${avgMB}MB`);
    return;
  }
  // Prioridade LOW_RAM_FIRST:
  const scored = active.map(n => {
    const ram = (robeMeta[n] && typeof robeMeta[n].ramMB === 'number') ? robeMeta[n].ramMB : 9999;
    const last = (robeMeta[n] && robeMeta[n].ultimaPostagem) || 0;
    return { n, ram, last };
  });
  scored.sort((a,b) => a.ram - b.ram || a.last - b.last);
  const keepN = Math.max(LIGHT_BUDGET_CFG.MIN_KEEP, cap);
  const keep = scored.slice(0, keepN).map(x=>x.n);
  const drop = scored.slice(keepN).map(x=>x.n);

  lightPlan.keep = new Set(keep);
  lightPlan.drop = new Set(drop);

  await milLog('mil_action', `light_budget_drop drop=${drop.length}/${active.length} cap=${cap} keep=${keep.length} free=${freeMB}MB avg=${avgMB}MB policy=${LIGHT_BUDGET_CFG.PRIORITY}`);

  for (const nome of drop) {
    try {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].activationHeldUntil = Date.now() + LIGHT_BUDGET_CFG.HOLD_MS;
      robeMeta[nome].lightDropUntil = Date.now() + LIGHT_BUDGET_CFG.HOLD_MS;
      await handlers.deactivate({ nome, reason: 'light_budget', policy: 'preserveDesired' });
    } catch {}
  }
}

// 4. Funções para agendar/desagendar reavaliação periódica do light-budget:
let _lightReevalTimer = null;
function scheduleLightReeval() {
  if (_lightReevalTimer) return;
  _lightReevalTimer = setInterval(() => {
    if (autoMode.mode === 'light') enforceLightBudget('reeval').catch(()=>{});
  }, LIGHT_BUDGET_CFG.REEVAL_MS);
}
function clearLightReeval() {
  if (_lightReevalTimer) clearInterval(_lightReevalTimer);
  _lightReevalTimer = null;
}
// FIM DA INSTRUÇÃO (scripts/worker.js – MODO LEVE INTELIGENTE, ORÇAMENTO DINÂMICO, FAIRNESS REAL)

const autoMode = {
  mode: 'full', since: Date.now(), reason: '',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }
//— ===== FIM PATCH MILITAR: BLOCO AUTO-ADAPTATIVO =====

// ===== LOCKS ATÔMICOS (status e manifest) =====
let _statusLock = Promise.resolve();

// ===== FIM LOCKS ATÔMICOS =====

// HOOKS de Modo LEVE/FULL (próximo aos patches militares - AUTO_CFG)
async function onEnterLightMode() {
  try { await reportAction('system', 'light_enter', 'enter_light_mode'); } catch {}
  try { robeQueue.clear(); } catch {}
  for (const [nome, ctrl] of controllers) {
    try {
      if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
        await ctrl.virtus.stop().catch(()=>{});
      }
      if (ctrl) { ctrl.virtus = null; ctrl.trabalhando = false; }
      const ramMB = (robeMeta[nome] && typeof robeMeta[nome].ramMB === 'number') ? robeMeta[nome].ramMB : null;
      if (ramMB != null && ramMB >= AUTO_CFG.RAM_KILL_MB) {
        await reportAction(nome, 'nurse_kill', `LEVE: kill pesado/zumbi (RAM=${ramMB}MB) preserveDesired reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
        await handlers.deactivate({ nome, reason: 'light_ram_shed', policy: 'preserveDesired' });
      }
    } catch {}
  }
  await enforceLightBudget('enter_light');
  scheduleLightReeval();
}

async function onExitLightMode() {
  try { await reportAction('system', 'light_exit', 'exit_light_mode'); } catch {}
  try {
    for (const nome of Object.keys(robeMeta)) {
      if (!robeMeta[nome]) continue;
      delete robeMeta[nome].lightDropUntil;
      const held = robeMeta[nome].activationHeldUntil || 0;
      if (held && held > Date.now()) {
        delete robeMeta[nome].activationHeldUntil;
      }
    }
  } catch {}
  clearLightReeval();
}

// ======= AUTOFIX/HEAL CONFIG =======
const SELF_HEAL_CFG = {
  SURVIVAL_MIN_ACTIVE: parseInt(process.env.SURVIVAL_MIN_ACTIVE || '2', 10),
  LIGHT_ESCALATE_STEP: parseInt(process.env.LIGHT_ESCALATE_STEP || '3', 10),
  LIGHT_ESCALATE_INTERVAL_MS: parseInt(process.env.LIGHT_ESCALATE_INTERVAL_MS || '180000', 10), // 3min
  FULL_ASSERT_INTERVAL_MS: parseInt(process.env.FULL_ASSERT_INTERVAL_MS || '120000', 10), // 2min
  PANIC_LIGHT_MAX_MS: parseInt(process.env.PANIC_LIGHT_MAX_MS || '15601000', 10), // 15min
  PANIC_NO_PROGRESS_MS: parseInt(process.env.PANIC_NO_PROGRESS_MS || '8601000', 10), // 8min
  MAX_LIGHT_CYCLES_WITHOUT_PROGRESS: parseInt(process.env.MAX_LIGHT_CYCLES_WITHOUT_PROGRESS || '2', 10)
};

const healer = {
  lastProgressAt: Date.now(),
  lastFullAssertAt: 0,
  lightEnterAt: 0,
  lightCycles: 0,
  lightAttempts: 0,
  noProgressCycles: 0,
  escalateTimer: null,
  assertTimer: null,
  lastLightCause: ''
};

async function milLog(type, msg) {
  try { await reportAction('system', type || 'mil_action', String(msg || '')); } catch {}
}

function countActive() {
  let n = 0;
  controllers.forEach((ctrl) => { if (ctrl && ctrl.browser) n++; });
  return n;
}

function countWorking() {
  let n = 0;
  controllers.forEach((ctrl) => { if (ctrl && ctrl.browser && ctrl.trabalhando) n++; });
  return n;
}

function desiredActiveNames() {
  const d = readJsonFile(desiredPath, { perfis: {} }) || { perfis: {} };
  return Object.entries(d.perfis || {}).filter(([_, ent]) => ent && ent.active === true).map(([nome]) => nome);
}

function chooseCandidatesToOpen(maxN = 2) {
  const now = Date.now();
  const desired = new Set(desiredActiveNames());
  const allPerfis = loadPerfisJson();
  const candidates = allPerfis
    .map(p => p.nome)
    .filter(nome => desired.has(nome) && !controllers.has(nome))
    .filter(nome => !isFrozenNow(nome))
    .slice(0);
  candidates.sort((a,b) => {
    const ra = typeof robeMeta[a]?.ramMB === 'number' ? robeMeta[a].ramMB : 999999;
    const rb = typeof robeMeta[b]?.ramMB === 'number' ? robeMeta[b].ramMB : 999999;
    return ra - rb;
  });
  return candidates.slice(0, Math.max(1, maxN));
}

async function escalateTowardsFull() {
  if (autoMode.mode !== 'light') return;
  const { cap } = computeLightCapacity();
  const ativos = countActive();
  if (ativos >= cap) {
    await milLog('mil_action', `light_escalate_cap: ativos=${ativos} cap=${cap} — nenhum open`);
    return;
  }
  const slots = Math.max(0, cap - ativos);
  if (slots === 0) return;

  const candAll = chooseCandidatesToOpen(999);
  const cand = candAll.slice(0, slots);

  if (cand.length) {
    await milLog('mil_action', `light_escalate: tentando abrir ${cand.length} perfis (cap=${cap})`);
    for (const nome of cand) {
      try {
        const gate = await openGate.trySchedule(nome, 'heal_escalate');
        if (gate.now) {
          const r = await activateOnce(nome, 'heal_escalate');
          if (r && r.ok) healer.lastProgressAt = Date.now();
          else if (r && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(r.error||'')) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].activationHeldUntil = Date.now() + 60000;
            await reportAction(nome, 'mil_action', 'activation_hold_due_ram 60s (escalate)');
          }
        } else {
          await issues.append(nome, 'mil_action', 'activation_queued(cap) src=heal_escalate');
        }
      } catch {}
    }
    healer.lightAttempts++;
  }
}

function scheduleLightEscalator() {
  if (healer.escalateTimer) return;
  healer.escalateTimer = setInterval(async () => {
    if (autoMode.mode === 'light') {
      const since = healer.lightEnterAt || autoMode.since || Date.now();
      const elapsed = Date.now() - since;
      const noProgElapsed = Date.now() - healer.lastProgressAt;
      if (elapsed > SELF_HEAL_CFG.PANIC_LIGHT_MAX_MS || noProgElapsed > SELF_HEAL_CFG.PANIC_NO_PROGRESS_MS) {
        healer.noProgressCycles++;
        if (healer.noProgressCycles >= SELF_HEAL_CFG.MAX_LIGHT_CYCLES_WITHOUT_PROGRESS) {
          panicMode();
          healer.noProgressCycles = 0;
        }
      }
      await escalateTowardsFull();
    }
  }, SELF_HEAL_CFG.LIGHT_ESCALATE_INTERVAL_MS);
}

function clearLightEscalator() {
  if (healer.escalateTimer) { clearInterval(healer.escalateTimer); healer.escalateTimer = null; }
  healer.lightAttempts = 0;
  healer.noProgressCycles = 0;
}

async function assertFullActivity() {
  const now = Date.now();
  if ((now - healer.lastFullAssertAt) < SELF_HEAL_CFG.FULL_ASSERT_INTERVAL_MS) return;
  healer.lastFullAssertAt = now;
  try { await killStrayChromes(); } catch {}
  
  if (countActive() === 0) {
    const need = Math.max(SELF_HEAL_CFG.SURVIVAL_MIN_ACTIVE, 1);
    const cand = chooseCandidatesToOpen(need);
    if (cand.length) {
      await milLog('mil_action', `assert_full_activity: subir ${cand.length} para não ficar em zero`);
      for (const nome of cand) {
        try {
          const gate = await openGate.trySchedule(nome, 'assert_full_activity');
          if (gate.now) {
            await activateOnce(nome, 'assert_full_activity');
            healer.lastProgressAt = Date.now();
          } else {
            await issues.append(nome, 'mil_action', 'activation_queued(cap) src=assert_full_activity');
          }
        } catch {}
      }
    }
  }
}

// PANIC MODE: drop parcial + bootstrap mínimo e agressivo
async function panicMode() {
  await milLog('mil_action', `panic_mode_start: light since=${(Date.now()-(healer.lightEnterAt||autoMode.since||Date.now()))}ms cause=${healer.lastLightCause}`);
  try { robeQueue.clear(); } catch {}
  const nomesAtivos = Array.from(controllers.keys());
  for (const nome of nomesAtivos) {
    try { await handlers.deactivate({ nome, reason: 'panic', policy: 'preserveDesired' }); } catch {}
  }
  try { await killStrayChromes(); } catch {}
  const cand = chooseCandidatesToOpen(Math.max(SELF_HEAL_CFG.SURVIVAL_MIN_ACTIVE, 2));
  await milLog('mil_action', `panic_min_bootstrap: abrindo ${cand.length}`);
  for (const nome of cand) {
    try {
      const gate = await openGate.trySchedule(nome, 'panic_bootstrap');
      if (gate.now) {
        await activateOnce(nome, 'panic_bootstrap');
        healer.lastProgressAt = Date.now();
      } else {
        await issues.append(nome, 'mil_action', 'activation_queued(cap) src=panic_bootstrap');
      }
    } catch {}
  }
  await milLog('mil_action', `panic_mode_end`);
}

// === Stray kill helpers ===
async function killPids(pids = []) {
  for (const pid of (pids || [])) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function killStrayChromes() {
  try {
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
      if (!pidList || !pidList.length) continue;
      await milLog('mil_action', `stray_kill: ${nome} pids=${pidList.join(',')}`);
      await killPids(pidList);
    }
  } catch {}
}

// ====== BOOT ENV LOG ======
try {
console.log('[WORKER][BOOT]', {
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
try { console.log('[WORKER][BOOT] log error', e && e.message || e); } catch {}
}
(async () => {
  try { 
    const cap = await serverCap.calibrateIfNeeded();
    console.log('[CAP]', cap);
  } catch(e){
    console.warn('[CAP] calibrate failed', e && e.message || e); 
  }
})();

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
fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
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

// 2. CRIAR openGate GLOBAL DE ABERTURA
const openGate = {
  cap: null,
  lastOpenAt: 0,
  queue: [],
  initDone: false,
  async init() {
    if (this.initDone) return;
    this.cap = await serverCap.calibrateIfNeeded();
    this.initDone = true;
    setInterval(()=>this.tick().catch(()=>{}), 1000);
  },
  currentOpen() { return controllers.size; },
  canOpenNow() {
    const cap = this.cap || serverCap.getCap() || {};
    const max = cap.safeMaxBrowsers || 1;
    const spacing = cap.minOpenSpacingMs || 9000;
    const timeOk = (Date.now() - this.lastOpenAt) >= spacing;
    return this.currentOpen() < max && timeOk;
  },
  async trySchedule(nome, source='reconcile') {
    await this.init();
    if (this.canOpenNow()) return { ok: true, now: true };
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + Math.max(15000, (this.cap?.minOpenSpacingMs||9000));
    robeMeta[nome].activationHeldReason = 'cap_reached';
    if (!this.queue.includes(nome)) this.queue.push(nome);
    try { await issues.append(nome, 'mil_action', `activation_queued(cap) src=${source}`); } catch {}
    return { ok: true, now: false, queued: true };
  },
  async tick() {
    if (!this.queue.length) return;
    if (!this.canOpenNow()) return;
    const nome = this.queue.shift();
    const desired = readJsonFile(desiredPath, { perfis: {} });
    if (!desired.perfis?.[nome]?.active || isFrozenNow(nome)) return;
    this.lastOpenAt = Date.now();
    try {
      const r = await activateOnce(nome, 'openGate');
      if (!r || !r.ok) {
        this.lastOpenAt = Date.now() - (this.cap?.minOpenSpacingMs||9000) + 2000;
        setTimeout(()=> this.queue.push(nome), 3000);
      }
    } catch { setTimeout(()=> this.queue.push(nome), 4000); }
  }
};
openGate.init().catch(()=>{});

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
  try { console.warn('[BOOT] Erro ao repopular frozenUntil dos manifests:', err && err.message || err); } catch {}
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
if (!nome) return { ok: false, error: 'Nome ausente' };
// Já está ativo?
if (controllers.has(nome)) return { ok: true, already: true };

// BLOQUEIO: não ativa se estiver congelado
if (isFrozenNow(nome)) {
  await reportAction(nome, 'mil_action', 'block_activate_frozen');
  return { ok: false, error: 'account_is_frozen' };
}

// Se já existe uma ativação em curso para este nome, aguarde finalização
const inflight = activationLocks.get(nome);
if (inflight) {
try { await inflight.catch(() => {}); } catch {}
return controllers.has(nome)
? { ok: true, already: true }
: { ok: false, error: 'activation_in_progress' };
}

const job = (async () => {
try {
console.log('[WORKER][activateOnce] start nome=' + nome + ' source=' + source);
const manifest = resolveManifest(nome);
if (!manifest) throw new Error('Perfil não encontrado');

try {
  await openGate.init();
  const cap = openGate.cap || serverCap.getCap() || {};
  const max = cap.safeMaxBrowsers || 1;
  if (controllers.size >= max) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + (cap.minOpenSpacingMs || 9000);
    robeMeta[nome].activationHeldReason = 'cap_reached';
    await issues.append(nome, 'mil_action', `block_activate_cap_reached max=${max} active=${controllers.size}`);
    return { ok: false, error: 'cap_reached' };
  }
} catch {}

// GATE DE RAM antes de abrir (livre > 3GB)
{
  const freeMB = Math.round(os.freemem() / (1024*1024));
  if (freeMB <= OPEN_MIN_FREE_MB) {
    await reportAction(nome, 'mem_block_activate', `RAM livre=${freeMB}MB <= ${OPEN_MIN_FREE_MB}MB (gate)`);
    throw new Error('ram_insuficiente_para_ativar');
  }
}

const browser = await browserHelper.openBrowser(manifest);
if (!browser || typeof browser.newPage !== 'function') {
throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
}
controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });
openGate.lastOpenAt = Date.now();

// HEADROOM pós-abrir (rollback se < 2GB)
{
  const freeAfter = Math.round(os.freemem() / (1024*1024));
  if (freeAfter < HEADROOM_AFTER_OPEN_MB) {
    await reportAction(nome, 'open_rollback_memory', `Headroom pós-abrir=${freeAfter}MB < ${HEADROOM_AFTER_OPEN_MB}MB; rollback preserveDesired`);
    try { await handlers.deactivate({ nome, reason: 'open_headroom', policy: 'preserveDesired' }); } catch {}
    return { ok: false, error: 'headroom_below_min_after_open' };
  }
}

// PATCH MILITAR: marcar ativação e limpar históricos/avisos
robeMeta[nome] = robeMeta[nome] || {};
robeMeta[nome].activatedAt = Date.now();
robeMeta[nome].ramHist = [];
robeMeta[nome].cpuHistory = [];
robeMeta[nome].lastWarn = null;

try { healer.lastProgressAt = Date.now(); } catch {}

try { attachBrowserLifecycle(nome, browser); } catch {}
try { await snapshotStatusAndWrite(); } catch {}
console.log('[WORKER][activateOnce] done nome=' + nome + ' source=' + source);
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
const msg = (e && e.message) || '';
if (/Session closed|Target closed|Target\.createTarget|main frame too early|Navigation timeout/i.test(msg)) {
  try { require('./serverCap.js').bumpDown('open_fail_spike'); } catch {}
  // hold individual
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].reopenAt = Date.now() + (45 + Math.floor(Math.random()*45))*1000;
  await issues.append(nome, 'mil_action', `reopen_delayed(${Math.round((robeMeta[nome].reopenAt-Date.now())/1000)}s) reason=${msg.slice(0,60)}`);
}
// INICIO DA INSTRUÇÃO 9: hold em erros de RAM/headroom
if (e && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(String(e && e.message || e))) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].activationHeldUntil = Date.now() + 60000;
  try { await reportAction(nome, 'mil_action', 'activation_hold_due_ram 60s (activateOnce)'); } catch {}
}
// FIM DA INSTRUÇÃO 9
console.warn('[WORKER][activateOnce] fail nome=' + nome + ' source=' + source + ':', e && e.message || e);
return { ok: false, error: e && e.message || String(e) };
} finally {
activationLocks.delete(nome);
}
})();

activationLocks.set(nome, job);
return await job;
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
          left = Math.floor(remaining / 1000);
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
      console.log('[PRUNER] Fechou', closed, 'abas extras.');
    } else if (process.env.PRUNE_DEBUG === '1') {
      console.debug('[PRUNER] Nada a fechar.');
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      console.warn('[PRUNER] Erro prune:', e && e.message || e);
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
        console.warn('[PRUNER] Erro prune:', e && e.message || e);
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
      console.log('[METRICS] pidsByNome:', Object.keys(pidsByNome), 'Example command:', Object.values(pidsMeta)[0]?.cmd || '');
    }

    // para cada nome: query pidusage para RAM/CPU dos seus PIDs
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
            // GUARD: Nunca realizar kill durante configuração — ctrl.configurando
            const ctrl = controllers.get(nome);
            if (ctrl && ctrl.configurando) return;

            handlers.deactivate({nome, reason:'cpuKill', policy:'preserveDesired'})
              .then(() => reportAction(nome, 'cpu_memory_spike', `CPU breaker acionado (>=150% por 5 rodadas) reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`))
              .catch(()=>{});
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
    const ramMB = (typeof robeMeta[nome].ramMB === 'number') ? robeMeta[nome].ramMB : null;
    if (ramMB == null) continue;

    // PATCH MILITAR: nunca suicidar navegador por pico de boot/start/post,
    // só mata leak persistente e nunca perfil único.
    const vivos = Array.from(controllers.values()).filter(c => !!(c && c.browser && c.trabalhando)).length;
    if (!robeMeta[nome].activatedAt || Date.now() - robeMeta[nome].activatedAt < 180000) continue; // <3min
    if (vivos <= 1) continue; // nunca processa breaker se só 1 perfil trabalhando

    // Histórico curto
    const hist = robeMeta[nome].ramHist || (robeMeta[nome].ramHist = []);
    hist.push({ t: Date.now(), mb: ramMB });
    while (hist.length > 6) hist.shift();

    // Warn apenas se RAM muito alta, sem kill
    if (ramMB >= AUTO_CFG.RAM_WARN_MB && ramMB < AUTO_CFG.RAM_KILL_MB) {
      if (!robeMeta[nome].lastWarn || (Date.now() - robeMeta[nome].lastWarn) > 600000) {
        try { await reportAction(nome, 'chrome_memory_warn', `RAM alta: ${ramMB} MB (>=${AUTO_CFG.RAM_WARN_MB})`); } catch {}
        robeMeta[nome].lastWarn = Date.now();
      }
    }

    // **Agora só KILL se leak comprovado**
    if (hist.length >= 5) {
      const allHigh = hist.slice(-5).every(h => h.mb >= AUTO_CFG.RAM_KILL_MB);
      let slopeOK = false;
      if (!allHigh) {
        const A = hist[0], B = hist[hist.length-1];
        const dMin = Math.max(0.5, (B.t - A.t)/60000);
        const slope = (B.mb - A.mb) / dMin;
        const avg = hist.reduce((a,b)=>a+b.mb,0)/hist.length;
        slopeOK = (slope > 50) && (avg > 800);
      }
      // Só kill se comprovado leak real!
      if (allHigh || slopeOK) {
        // GUARD: Nunca realizar kill durante configuração — ctrl.configurando
        const ctrl = controllers.get(nome);
        if (ctrl && ctrl.configurando) return;

        handlers.deactivate({ nome, reason:'ramKill', policy:'preserveDesired' })
        .then(() => reportAction(nome, 'chrome_memory_spike', `RAM breaker acionado (mb=${ramMB}, allHigh=${allHigh}, slopeOK=${slopeOK}) reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`))
        .catch(()=>{});
        // Não limpar hist; preserveDesired reabrirá mais tarde
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
  // CPU global e RAM livre
  let chromeTotalCpu = 0;
  for (const k of Object.keys(robeMeta)) {
    const v = robeMeta[k] && robeMeta[k].cpuPercent;
    if (typeof v === 'number') chromeTotalCpu += v;
  }
  const cores = Math.max(1, (os.cpus() || []).length);
  const cpuApprox = Math.min(100, Math.round(chromeTotalCpu / cores));
  const freeMB = Math.round(os.freemem() / (1024*1024));

  // EMA
  autoMode.cpuEma = _ema(autoMode.cpuEma, cpuApprox, AUTO_CFG.EMA_ALPHA_CPU);
  autoMode.freeEmaMB = _ema(autoMode.freeEmaMB, freeMB, AUTO_CFG.EMA_ALPHA_MEM);

  const enterPressure = (freeMB < AUTO_CFG.MEM_ENTER_MB) ||
    (autoMode.freeEmaMB != null && autoMode.freeEmaMB < AUTO_CFG.MEM_ENTER_MB) ||
    (cpuApprox > AUTO_CFG.CPU_ENTER) ||
    (autoMode.cpuEma != null && autoMode.cpuEma > (AUTO_CFG.CPU_ENTER - 3));
  const exitPressure = (freeMB >= AUTO_CFG.MEM_EXIT_MB) &&
    (autoMode.freeEmaMB != null && autoMode.freeEmaMB >= AUTO_CFG.MEM_EXIT_MB) &&
    (cpuApprox <= AUTO_CFG.CPU_EXIT) &&
    (autoMode.cpuEma != null && autoMode.cpuEma <= AUTO_CFG.CPU_EXIT);

  if (enterPressure) { autoMode.hot++; autoMode.cool = 0; }
  else if (exitPressure) { autoMode.cool++; autoMode.hot = 0; }
  else { autoMode.hot = 0; autoMode.cool = 0; }

  // ENTER light
  if (autoMode.mode === 'full' && autoMode.hot >= AUTO_CFG.HOT_TICKS && _canSwitch()) {
    autoMode.mode = 'light';
    autoMode.since = Date.now();
    autoMode.reason = `CPU≈${cpuApprox}% (EMA≈${Math.round(autoMode.cpuEma||0)}%), freeMB=${freeMB} (EMA≈${Math.round(autoMode.freeEmaMB||0)})`;
    autoMode.light.nextRobeEnqueueAt = Date.now() + AUTO_CFG.ROBE_LIGHT_MIN_SPACING_MS;
    healer.lightEnterAt = autoMode.since;
    healer.lightCycles++;
    healer.lastLightCause = autoMode.reason;
    await reportAction('system', 'auto_mode', 'enter_light: ' + autoMode.reason);
    // HOOK: entrar no Modo Leve — pausa Virtus, limpa fila, derruba pesados/zumbis
    await onEnterLightMode();
    scheduleLightEscalator(); // NOVO
  }

  // EXIT light
  if (autoMode.mode === 'light' && autoMode.cool >= AUTO_CFG.COOL_TICKS && _canSwitch()) {
    autoMode.mode = 'full';
    autoMode.since = Date.now();
    autoMode.reason = '';
    healer.noProgressCycles = 0;
    healer.lightAttempts = 0;
    await reportAction('system', 'auto_mode', 'exit_light');
    // HOOK: sair do Modo Leve
    await onExitLightMode();
    clearLightEscalator(); // NOVO
  }
  // ===== FIM PATCH MILITAR: Avaliação/autoMode global =====

  // No final, snapshot status global, nunca direto!
  try {
    const vals = Object.values(robeMeta).map(m => (typeof m.ramMB === 'number' ? m.ramMB : null)).filter(x => x != null && x > 50 && x < 2000);
    if (vals.length >= 3) {
      const avg = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
      require('./serverCap.js').recordRuntimeSample({ perBrowserMBAvg: avg });
    }
  } catch {}
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
  console.log('[WORKER][robeTickGlobal] Tick fila global, hora:', new Date().toLocaleString());

  // === PATCH autoMode Light: gate para robeTickGlobal ===
  if (autoMode.mode === 'light') {
    if (Date.now() < autoMode.light.nextRobeEnqueueAt) {
      return;
    }
  }
  // === FIM patch ===

  const perfisArr = loadPerfisJson();
  const prontos = perfisArr
    .map(p => p.nome)
    .filter(nome => {
      // ALTERAÇÃO: antifila militar - respeita frozen
      if (isFrozenNow(nome)) {
        return false; // GUARD: evita spam/OOM por manifest ausente, conta está congelada
      }
      // RAM kill/killbackoff (Terminator)
      if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
        return false; // GUARD: bloqueado até cooldown após RAM spike
      }
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.trabalhando || ctrl.configurando || ctrl.humanControl) return false; // Atualização: impede fila em modo humano
      const cooldown = robeCooldownLeft(nome);
      const inFila = robeQueue.inQueue(nome);
      const exec = robeQueue.isActive(nome);
      return cooldown === 0 && (!inFila) && (!exec);
    });

  for (const nome of prontos) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) continue;

    console.log(`[WORKER][robeTickGlobal] Enfileirando ${nome}? cooldown=${robeCooldownLeft(nome)}s inQueue=${robeQueue.inQueue(nome)}, isActive=${robeQueue.isActive(nome)}`);

    robeQueue.enqueue(nome, async () => {
      // === PATCH autoMode Light: após enfileirar em modo light, rate limit ===
      if (autoMode.mode === 'light') {
        autoMode.light.nextRobeEnqueueAt = Date.now() + AUTO_CFG.ROBE_LIGHT_MIN_SPACING_MS;
        autoMode.light.robeSkipped = (autoMode.light.robeSkipped || 0) + 1;
      }
      // === FIM patch ===

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
      try { console.log(`[WORKER][robeTickGlobal] Robe start: ${nome}`); } catch {}
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
          // Penalidade por erro técnico
          const penalSec = 60+Math.floor(Math.random()*241); // 60-300s
          await manifestStore.update(nome, (m)=>{
            m = m || {};
            const now = Date.now();
            m.robeCooldownUntil = now + penalSec*1000;
            m.robeCooldownRemainingMs = 0;
            return m;
          });
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].cooldownSec = penalSec;
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown militar ${penalSec}s`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: penalSec });
          try { console.warn('[WORKER][robeTickGlobal] Robe error:', e && e.message || e); } catch {}
          return; // não crasha fila global
        }
        // ==== EOF COOL/PRUNED ERRORS ====

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
            cooldownSec: robeCooldownLeft(nome),
            proximaPostagem: robeLastPosted(nome) + robePauseMs,
            ultimaPostagem: Date.now()
          });
          try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso'); } catch {}
          try { console.log(`[WORKER][robeTickGlobal] Robe success: ${nome}`); } catch {}
        } else {
          robeUpdateMeta(nome, {
            estado: 'idle',
            cooldownSec: robeCooldownLeft(nome)
          });
        }
      } catch (e) {
        robeUpdateMeta(nome, { estado: 'erro', cooldownSec: robeCooldownLeft(nome) });
      } finally {
        // PRUNE DE ABAS antes de religar o Virtus (garantia: sem paralelismo Robe/Pruner)
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

        // Religa o Virtus se estava rodando antes
        if (virtusWasRunning) {
          try {
            ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 });
          } catch (e) {
            console.warn('[WORKER] Falha ao religar Virtus após Robe para', nome, e && e.message || e);
          }
        }
        robeUpdateMeta(nome, { emExecucao: false });

        // INÍCIO ALTERAÇÃO 1: snapshotStatusAndWrite após religar Virtus
        if (virtusWasRunning) {
          ctrl.trabalhando = true;
          await snapshotStatusAndWrite();
        }

        // Log de término do Robe
        try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado'); } catch {}
        try { console.log(`[WORKER][robeTickGlobal] Robe end: ${nome}`); } catch {}
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
      console.log(`[FOTOS][GC] deletedFiles=${res.deletedFiles} removedIndex=${res.removedIndex} resetGens=${res.resetGens}`);
    }
  } catch (e) {
    console.warn('[FOTOS][GC] erro:', e && e.message || e);
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
console.log(`[WORKER][BROWSER] disconnected: ${nome}`);
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

// Log de morte/desconexão imediatamente após remover do controllers
try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}

// LIMPA PRUNER DE ABAS
stopPruneLoop(nome);

// Registrar falha e agendar reabertura curta
try { registerFailure(nome, 'disconnected', 'external'); } catch {}
try {
  // Checagem de desired: só agenda reopenAt se desired.active === true
  const d = readJsonFile(desiredPath, { perfis: {} });
  const isDesiredActive = d.perfis?.[nome]?.active === true;
  robeMeta[nome] = robeMeta[nome] || {};
  if (!isFrozenNow(nome) && isDesiredActive) {
    robeMeta[nome].reopenAt = Date.now() + ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
    issues.append(nome, 'mil_action', 'nurse_reopen_scheduled(disconnected)').catch(()=>{});
  } else {
    robeMeta[nome].reopenAt = null;
    issues.append(nome, 'mil_action', isFrozenNow(nome) ? 'reopen_suppressed_frozen' : 'reopen_suppressed_desired_off').catch(()=>{});
  }
} catch {}

// Atualiza status.json imediato
try { await snapshotStatusAndWrite(); } catch {}
} catch (e) {
  try { console.warn('[WORKER][BROWSER] disconnect handler err:', e && e.message || e); } catch {}
}
});  // <-- Fecha o browser.once('disconnected', async () => { ... })
}     // <-- Fecha a função attachBrowserLifecycle(nome, browser)

// == FIM função ciclo de vida browser ==

// ========== HANDLERS ==========
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

const handlers = {
  async ['criar-perfil']({ cidade, cookies }) {
    if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };
    if (!fs.existsSync(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

    let nome = utils.slugify(cidade) + '-' + Date.now();
    while (fs.existsSync(path.join(perfisDir, nome))) nome += Math.floor(Math.random()*100);

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

    // NOVO: gravar manifest somente no userDataDir
    fs.writeFileSync(path.join(perfilObj.userDataDir, 'manifest.json'), JSON.stringify(perfilObj, null, 2));

    // REMOVIDO: gravação antiga/duplicada no dados/perfis/NOME

    return { ok: true, perfil: perfilObj };
  },

  async activate({ nome }) {
    const gate = await openGate.trySchedule(nome, 'message');
    if (gate.now) {
      return await activateOnce(nome, 'message');
    } else {
      await issues.append(nome, 'mil_action', 'activation_queued(cap) src=message').catch(()=>{});
      return { ok: true, queued: true, now: false };
    }
  },

  async deactivate({ nome, reason, policy }) {
  const preserve = (policy === 'preserveDesired');
  let reopenDelayMs = 0;
  if (preserve) {
    try { registerFailure(nome, reason || 'deactivate_preserve'); } catch {}
    if (reason === 'ramKill' || reason === 'cpuKill') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_RAMCPU_MS + Math.floor(Math.random()*120000);
    } else {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
    }
  }
  const ctrl = controllers.get(nome);
  if (!ctrl) {
    if (preserve && !isFrozenNow(nome)) {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].reopenAt = Date.now() + reopenDelayMs;
      issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
    }
    await snapshotStatusAndWrite();
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
  try { freezeCooldownIfNotWorking(nome); } catch {}
  controllers.delete(nome);
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
    if (!isFrozenNow(nome)) {
      robeMeta[nome].reopenAt = Date.now() + reopenDelayMs;
      issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
    }
  }
  await snapshotStatusAndWrite();
  return { ok: true };
},

  async configure({ nome }) {
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
    try {
      await browserHelper.configureProfile(ctrl.browser, nome, manifest.cookies);
      // NÃO execute closeExtraPages/prune aqui!
      return { ok: true };
    } catch (e) {
      try { await issues.append(nome, 'cookie_inject_failed', e && e.message || e); } catch {}
      return { ok: false, error: e && e.message || 'falha_injetar_cookies' };
    } finally {
      ctrl.configurando = false;
      await snapshotStatusAndWrite();
    }
  },

  async start_work({ nome }) {
  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

  // PATCH: não repetir trabalho se virtus já iniciando/ativo
  if (ctrl.trabalhando && ctrl.virtus) return { ok: true }; // já trabalhando
  if (ctrl._virtusStarting) return { ok: true };

  try {
    ctrl._virtusStarting = true;
    ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 });
    ctrl.trabalhando = true;
    if (ctrl.browser && typeof browserHelper.forceCloseExtras === 'function') {
      await browserHelper.forceCloseExtras(ctrl.browser);
    }
    await snapshotStatusAndWrite();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message || String(e) };
  } finally {
    ctrl._virtusStarting = false;
  }
},

  async invoke_human({ nome }) {
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

    // 2. Pausa Virtus
    ctrl.trabalhando = false;
    if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
      try { await ctrl.virtus.stop(); } catch {}
    }
    ctrl.virtus = null;
    await snapshotStatusAndWrite();

    // 3. Browser oferece foco + página marketplace/you/selling
    await browserHelper.invocarHumano(ctrl.browser, nome);

    // 4. [Opcional] Marque flag em memória (tipo ctrl.humanControl = true), se quiser personalizar pill na UI ou botão (“Retomar Trabalho”)
    ctrl.humanControl = true;

    // Adicionado - garantir cooldown congelado ao entrar no modo humano:
    try { freezeCooldownIfNotWorking(nome); } catch {}

    await snapshotStatusAndWrite();

    return { ok: true };
  },

  async ['human-resume']({ nome }) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    ctrl.humanControl = false; // Sai do modo humano antes de iniciar as automações

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
    ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 });
    ctrl.trabalhando = true;

    try { unfreezeCooldownIfWorking(nome); } catch {}

    await snapshotStatusAndWrite();
    return { ok:true };
  },

  // == ALTERAÇÃO 3: Handler robe-play substituído ==
  async ['robe-play']({ nome }) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
    // P0.3: recusa se frozen
    if (isFrozenNow(nome)) {
      return { ok: false, error: 'account_frozen' }
    }
    // GUARD-RAIL: IMPEDIR PRUNE/POSTAGEM enquanto está em configuração (injeção de cookies)
    if (ctrl && ctrl.configurando) return { ok: false, error: 'perfil_em_configuracao' };

    // Zera cooldown no manifest
    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        m.robeCooldownUntil = Date.now();
        m.robeCooldownRemainingMs = 0;
        return m;
      });
    } catch {}

    // Se não está na fila nem ativo, enfileira o callback REAL igual ao robeTickGlobal:
    if (!robeQueue.inQueue(nome) && !robeQueue.isActive(nome)) {
      robeUpdateMeta(nome, { emFila: true });
      robeQueue.enqueue(nome, async () => {
        // === PATCH autoMode Light: após enfileirar em modo light, rate limit ===
        if (autoMode.mode === 'light') {
          autoMode.light.nextRobeEnqueueAt = Date.now() + AUTO_CFG.ROBE_LIGHT_MIN_SPACING_MS;
          autoMode.light.robeSkipped = (autoMode.light.robeSkipped || 0) + 1;
        }
        // === FIM patch ===

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
        try { console.log(`[WORKER][robe-play] Robe start: ${nome}`); } catch {}
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
            // Penalidade por erro técnico
            const penalSec = 60+Math.floor(Math.random() * 241); // 60-300s
            await manifestStore.update(nome, (m)=>{
              m = m || {};
              const now = Date.now();
              m.robeCooldownUntil = now + penalSec*1000;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].cooldownSec = penalSec;
            await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown militar ${penalSec}s`);
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: penalSec });
            try { console.warn('[WORKER][robe-play] Robe error:', e && e.message || e); } catch {}
            return; // não crasha fila global
          }
          // ==== EOF COOL/PRUNED ERRORS ====

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
              cooldownSec: robeCooldownLeft(nome),
              proximaPostagem: robeLastPosted(nome) + ((15+Math.floor(Math.random()*16))*60*1000),
              ultimaPostagem: Date.now()
            });
            try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso (robe-play)'); } catch {}
            try { console.log(`[WORKER][robe-play] Robe success: ${nome}`); } catch {}
          } else {
            robeUpdateMeta(nome, {
              estado: 'idle',
              cooldownSec: robeCooldownLeft(nome)
            });
          }
        } catch (e) {
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: robeCooldownLeft(nome) });
        } finally {
          // PRUNE DE ABAS antes de religar o Virtus
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

          if (virtusWasRunning) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 });
              ctrl.trabalhando = true;
            } catch (e) {}
          }
          robeUpdateMeta(nome, { emExecucao: false });
          await snapshotStatusAndWrite();

          // Log de término do Robe (robe-play)
          try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado (robe-play)'); } catch {}
          try { console.log(`[WORKER][robe-play] Robe end: ${nome}`); } catch {}
        }
      });
      await snapshotStatusAndWrite();
    }
    return { ok: true };
  },
  // == FIM ALTERAÇÃO 3 ==

  async ['get-status']() {
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
        reopenAt: robeMeta[nome]?.reopenAt || null,
      };
    });
    const robes = {};
    perfisArr.forEach(p => {
      const nome = p.nome;
      const fail = getFailureCounts(nome);
      robes[nome] = {
        cooldownSec: robeCooldownLeft(nome),
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
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null
      };
    });
    const robeQueueList = robeQueue.queueList();
    // PATCH autoMode/sys: incluir autoMode e sys
    const sys = {
      freeMB: Math.round(os.freemem()/(1024*1024)),
      totalMB: Math.round(os.totalmem()/(1024*1024)),
      cores: (os.cpus()||[]).length,
      cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
    };
    const cap = require('./serverCap.js').getCap();
    return {
      perfis,
      robes,
      robeQueue: robeQueueList,
      autoMode,
      sys,
      cap: {
        safeMaxBrowsers: cap?.safeMaxBrowsers || null,
        perBrowserMB: cap?.perBrowserMB || null,
        reserveMB: cap?.reserveMB || null,
        minOpenSpacingMs: cap?.minOpenSpacingMs || null,
        openQueueLen: (openGate.queue||[]).length
      }
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
  reopenAt: robeMeta[nome]?.reopenAt || null,
};
});
const robes = {};
perfisArr.forEach(p => {
const nome = p.nome;
const fail = getFailureCounts(nome);
robes[nome] = {
  cooldownSec: robeCooldownLeft(nome),
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
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null
};
});
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
try { console.warn('[WORKER][statusWrite] erro:', e && e.message || e); } catch {}
}
});
return _statusLock;
}
// == FIM: snapshotStatusAndWrite ==

// == INÍCIO: reconciliador declarativo (lê desired.json e executa ações) ==
const RECONCILE_INTERVAL_MS = 1500;
let _reconciling = false;

async function reconcileOnce() {
if (_reconciling) return;
_reconciling = true;
try {
ensureDesired();
const desired = readJsonFile(desiredPath, { perfis: {} }) || { perfis: {} };
const perfisDesired = (desired && desired.perfis && typeof desired.perfis === 'object') ? desired.perfis : {};
const nomes = Object.keys(perfisDesired);

// Varre controllers e fecha se congelado, antes de ativações
{
controllers.forEach((ctrl, nome) => {
  try {
    if (isFrozenNow(nome)) {
      ensureFrozenShutdown(nome, 'reconcile_guard').catch(()=>{});
    }
  } catch {}
});
}

// AUDITORIA GLOBAL DE COOLDOWN: congela/descongela por perfil conforme estado real
try {
const perfisArrAudit = loadPerfisJson();
// ========= ALTERAÇÃO SINCRONIZAÇÃO COOLDOWN (INÍCIO) ===========
for (const p of perfisArrAudit) {
  const nomeAudit = p && p.nome;
  if (!nomeAudit) continue;
  const ctrlAudit = controllers.get(nomeAudit);
  const working = !!(ctrlAudit && ctrlAudit.browser && ctrlAudit.trabalhando && !ctrlAudit.configurando);
  const humanControl = !!(ctrlAudit && ctrlAudit.humanControl);
  if (working && !humanControl) { // Só descongela se NÃO estiver em modo humano!
    unfreezeCooldownIfWorking(nomeAudit);
  } else {
    freezeCooldownIfNotWorking(nomeAudit);
  }
}
// ========= ALTERAÇÃO SINCRONIZAÇÃO COOLDOWN (FIM) ===========
} catch {}

for (const nome of nomes) {
  const want = perfisDesired[nome] || {};
  const ctrl = controllers.get(nome);

  // Reconhece política preserveDesired: reabrir automaticamente após reopenAt
  if (robeMeta[nome]?.reopenAt && robeMeta[nome].reopenAt <= Date.now() && !ctrl) {
    if (isFrozenNow(nome)) {
      continue;
    }
    if (want.active === true) {
      robeMeta[nome].reopenAt = null;
      robeMeta[nome].killHistory = [];
      const gate = await openGate.trySchedule(nome, 'reopenAt');
      if (gate.now) { await activateOnce(nome, 'reopenAt-preserveDesired'); }
      else { await issues.append(nome, 'mil_action', 'reopen_queued(cap)'); }
    } else {
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_at_ignored_desired_off').catch(()=>{});
    }
    continue;
  }

  // Liga/desliga browser
  if (want.active === true && !ctrl) {
    // Guard-rail frozen: se estiver congelado, pula
    const until = isFrozenNow(nome);
    if (until > Date.now()) {
      if (!robeMeta[nome] || !robeMeta[nome].frozenUntil || robeMeta[nome].frozenUntil !== until) {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].frozenUntil = until;
      }
      await snapshotStatusAndWrite();
      continue;
    }

    // === PATCH autoMode Light: gate para ativação no reconcileOnce ===
    const now = Date.now();
    if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > now) {
      await snapshotStatusAndWrite();
      continue;
    }
    // INICIO DA INSTRUÇÃO 7: respeita lightDropUntil
    if (robeMeta[nome]?.lightDropUntil && robeMeta[nome].lightDropUntil > Date.now()) {
      await snapshotStatusAndWrite();
      continue;
    }
    // FIM DA INSTRUÇÃO 7
    if (autoMode.mode === 'light') {
      const base = 20000, factor = Math.min(9, 1 + (autoMode.hot||0)), jitter = Math.floor(Math.random()*5000);
      const holdMs = Math.min(180000, base*factor) + jitter;
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].activationHeldUntil = now + holdMs;
      await issues.append(nome, 'mil_action', `activation_hold light ${holdMs}ms reason=${autoMode.reason} cpu≈${Math.round(autoMode.cpuEma||0)}% free≈${Math.round(autoMode.freeEmaMB||0)}MB`);
      autoMode.light.activationHeld++;
      await snapshotStatusAndWrite();
      continue;
    }
    // === FIM PATCH autoMode Light ===

    const gate = await openGate.trySchedule(nome, 'reconcile');
    if (gate.now) { try { await activateOnce(nome, 'reconcile'); } catch {} }
    else { await issues.append(nome, 'mil_action', 'activation_queued(cap)'); }
    continue;
  } else if (want.active === false && ctrl) {
    try { await handlers.deactivate({ nome }); } catch {}
    continue;
  }

  const ctrl2 = controllers.get(nome);
  if (!ctrl2) continue;

  // configureOnce
  if (want.configureOnce === true && !ctrl2.configurando) {
    try {
      const r = await handlers.configure({ nome });
      if (r && r.ok) {
        try {
          const d2 = readJsonFile(desiredPath, { perfis: {} });
          if (d2 && d2.perfis && d2.perfis[nome]) {
            d2.perfis[nome].configureOnce = false;
            const ok = writeJsonAtomic(desiredPath, d2);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|configureOnce_desired_write`); } catch {} }
          }
        } catch {}
      }
    } catch {}
  }

  // Virtus on/off
  if (isFrozenNow(nome)) {
    // Sincronização frozen disco⇄memória e snapshot imediato antes de pular
    const until = isFrozenNow(nome);
    if (until > Date.now() && (!robeMeta[nome] || !robeMeta[nome].frozenUntil || robeMeta[nome].frozenUntil !== until)) {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].frozenUntil = until;
    }
    await snapshotStatusAndWrite();
    if (ctrl2 && ctrl2.trabalhando) { try { await stopVirtus(nome); } catch {} }
    continue;
  }

  if (want.virtus === 'on' && autoMode.mode === 'full' && !ctrl2.trabalhando && !ctrl2.configurando) {
    try { ctrl2.virtus = virtusHelper.startVirtus(ctrl2.browser, nome, { restrictTab: 0 }); ctrl2.trabalhando = true; } catch {}
  } else if (want.virtus === 'off' && ctrl2.trabalhando) {
    try { await stopVirtus(nome); } catch {}
  }

  // RobePlay
  if (want.robePlay === true) {
    try {
      const r = await handlers['robe-play']({ nome });
      if (r && r.ok) {
        try {
          const d2 = readJsonFile(desiredPath, { perfis: {} });
          if (d2 && d2.perfis && d2.perfis[nome]) {
            d2.perfis[nome].robePlay = false;
            const ok2 = writeJsonAtomic(desiredPath, d2);
            if (!ok2) { try { await issues.append('system','persist_failed', `${nome}|robePlay_desired_write`); } catch {} }
          }
        } catch {}
      }
    } catch {}
  }

  // Invocar Humano
  if (want.invokeHuman === true) {
    try {
      const r = await handlers.invoke_human({ nome });
      if (r && r.ok) {
        try {
          const d2 = readJsonFile(desiredPath, { perfis: {} });
          if (d2 && d2.perfis && d2.perfis[nome]) {
            d2.perfis[nome].invokeHuman = false;
            const ok = writeJsonAtomic(desiredPath, d2);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|invokeHuman_desired_write`); } catch {} }
          }
        } catch {}
      }
    } catch {}
  }

  // Human Resume (Retomar Trabalho)
  if (want.humanResume === true) {
    try {
      const r = await handlers['human-resume']({ nome });
      if (r && r.ok) {
        try {
          const d2 = readJsonFile(desiredPath, { perfis: {} });
          if (d2 && d2.perfis && d2.perfis[nome]) {
            d2.perfis[nome].humanResume = false;
            const ok = writeJsonAtomic(desiredPath, d2);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|humanResume_desired_write`); } catch {} }
          }
        } catch {}
      }
    } catch {}
  }

  // RobePause24h
  if (want.robePause24h === true) {
    try {
      const now = Date.now();
      const ctrl3 = controllers.get(nome);
      const working = !!(ctrl3 && ctrl3.browser && ctrl3.trabalhando && !ctrl3.configurando);
      const plus24 = 24 * 60 * 60 * 1000;
      const humanControl = !!(ctrl3 && ctrl3.humanControl);
      await manifestStore.update(nome, (man) => {
        man = man || {};
        if (working && !humanControl) {
          man.robeCooldownUntil = now + plus24;
          man.robeCooldownRemainingMs = 0;
        } else {
          man.robeCooldownUntil = 0;
          man.robeCooldownRemainingMs = plus24;
        }
        return man;
      });

      const d2 = readJsonFile(desiredPath, { perfis: {} });
      if (d2 && d2.perfis && d2.perfis[nome]) {
        d2.perfis[nome].robePause24h = false;
        const ok2 = writeJsonAtomic(desiredPath, d2);
        if (!ok2) { try { await issues.append('system','persist_failed', `${nome}|robePause24h_desired_write`); } catch {} }
      }
    } catch (e) {
      try { console.warn('[WORKER][reconcile] robePause24h err:', e && e.message || e); } catch {}
    }

  }
}

await snapshotStatusAndWrite();

} catch (e) {
try { console.warn('[WORKER][reconcileOnce] erro:', e && e.message || e); } catch {}
} finally {
_reconciling = false;
}
}

// Agendadores do reconciliador
setInterval(() => { reconcileOnce().catch(()=>{}); }, RECONCILE_INTERVAL_MS);
setTimeout(() => { reconcileOnce().catch(()=>{}); }, 300);
 // == FIM: reconciliador declarativo ==

// === ASSERT FULL-ACTIVITY TIMER ===
setInterval(() => { assertFullActivity().catch(()=>{}); }, Math.max(15000, Math.floor(SELF_HEAL_CFG.FULL_ASSERT_INTERVAL_MS/2)));

// ENFERMEIRO DIGITAL — Saúde contínua de contas/navegadores:
const NURSE_CFG = {
  INTERVAL_MS: 5000,
  PAGE_EVAL_TIMEOUT_MS: 5000  // Mais tolerância, menos falso-positivo
};

// === ULTRA RECOVERY (militar) ===
const ULTRA_RECOVERY = {
  MAX_RELOADS: 2,                   // no máximo 2 reloads curtos por página zumbi
  RELOAD_TIMEOUT_MS: 10000,         // Mais tempo para reload Messenger
  RELOAD_POST_WAIT_MS: 250,         // pequena espera pós-reload
  REOPEN_DELAY_SHORT_MS: 4000,      // reabrir "já já" (nurse_kill, no_pages)
  REOPEN_DELAY_RAMCPU_MS: 4*60*1000, // reabrir após 4–6min em RAM/CPU kill (usaremos também jitter)
  FAIL_WINDOW_MS: 3*60*60*1000,     // 3h janela
  FAIL_FREEZE_AFTER: 5,             // >5 falhas em 3h => congela
  FAIL_FREEZE_MS: 2*60*60*1000      // congela por 2h
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

  // Congelar apenas por falhas INTERNAS
  if (cls === 'internal' && counts.internal > ULTRA_RECOVERY.FAIL_FREEZE_AFTER) {
    try {
      await freezeProfileFor(nome, ULTRA_RECOVERY.FAIL_FREEZE_MS, `fail_threshold:${reason}`, 'system');
      await ensureFrozenShutdown(nome, 'fail_freeze');
    } catch {}
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
        .map(el => norm(el.innerText || el.textContent || ''))
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

async function nurseTick() {
  const now = Date.now();
  const desired = readJsonFile(desiredPath, { perfis: {} });
  for (const nome of Object.keys(desired.perfis || {})) {
    const want = desired.perfis[nome] || {};
    const ctrl = controllers.get(nome);

    // GUARD: nunca manter ativo durante frozen
    if (isFrozenNow(nome)) {
      if (ctrl) { await ensureFrozenShutdown(nome, 'nurse_guard'); }
      continue;
    }

    // INICIO DA INSTRUÇÃO 6: substituição do trecho nurseTick para modo leve e holds
    if (want.active === true && !ctrl) {
      if (isFrozenNow(nome)) continue;

      // Modo leve: nurse não ativa
      if (autoMode.mode === 'light') {
        const now = Date.now();
        robeMeta[nome] = robeMeta[nome] || {};
        if (!robeMeta[nome].activationHeldUntil || robeMeta[nome].activationHeldUntil < now) {
          robeMeta[nome].activationHeldUntil = now + 60000;
          await reportAction(nome, 'mil_action', 'nurse_hold_light 60s');
        }
        continue;
      }

      await reportAction(nome, 'nurse_restart', 'desired ativo porém controller ausente — tentando ativar');
      const gate = await openGate.trySchedule(nome, 'nurse_auto');
      if (gate.now) {
        const r = await activateOnce(nome, 'nurse_auto');
        if (!r || !r.ok) {
          if (r && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(r.error||'')) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].activationHeldUntil = Date.now() + 60000;
            await reportAction(nome, 'mil_action', 'activation_hold_due_ram 60s');
          }
        }
      } else { await reportAction(nome, 'mil_action', 'nurse_activation_queued(cap)'); }
      continue;
    }
    // FIM DA INSTRUÇÃO 6

    if (!ctrl || !ctrl.browser) continue;
    let pages = [];
    try { pages = await ctrl.browser.pages().catch(()=>[]); } catch {}
    if (!pages || !pages[0]) {
      await reportAction(nome, 'nurse_kill', `motivo=no_pages url= reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
      try { registerFailure(nome, 'no_pages', 'external'); } catch {}
      await handlers.deactivate({ nome, reason: 'no_pages', policy: 'preserveDesired' });
      continue;
    }
    const p0 = pages[0];
    // Checagem de bloqueio temporário do Messenger (prioritário, antes de prune/reload/kill)
    const det = await detectMessengerTempBlock(p0);
    if (det && det.blocked) {
      try { await issues.append(nome, 'virtus_blocked', 'Messenger temporariamente bloqueado — stopVirtus e reabrir em ~2h'); } catch {}
      try { await stopVirtus(nome); } catch {}
      // Agendar reopen ~2h com jitter (sem freezer)
      robeMeta[nome] = robeMeta[nome] || {};
      const jitterMs = (5 + Math.floor(Math.random() * 21)) * 60 * 1000; // 5-26 min
      robeMeta[nome].reopenAt = Date.now() + ms(2) + jitterMs;
      try { registerFailure(nome, 'messenger_temp_block', 'external'); } catch {}
      await snapshotStatusAndWrite();
      continue; // Não tenta reload/kill, apenas sai do loop até a próxima rodada.
    }

    // NÃO competir com recovery stateful
    const hs = getHealth && getHealth(nome);
    if (hs && (hs.stage === 'recover1' || hs.stage === 'recover2' || hs.stage === 'recover3')) {
      continue;
    }

    let healthy = await pageReadyBasic(p0);
    if (!healthy) {
      // Debounce: conta reloads nos últimos 60s, pausa se ultrapassar 3
      robeMeta[nome] = robeMeta[nome] || {};
      const now2 = Date.now();
      if (!robeMeta[nome].reloadAttemptsWindow) robeMeta[nome].reloadAttemptsWindow = [];
      robeMeta[nome].reloadAttemptsWindow = robeMeta[nome].reloadAttemptsWindow.filter(ts => now2 - ts < 60000);

      robeMeta[nome].reloadAttemptsWindow.push(now2);
      if (robeMeta[nome].reloadAttemptsWindow.length > 3) {
        // Log e GRACE: não tente novo reload nos próximos 60s
        robeMeta[nome].reloadBlockedUntil = now2+60000;
        await reportAction(nome, 'mil_action', 
          `nurse_reload_blocked: Excesso de reloads (${robeMeta[nome].reloadAttemptsWindow.length}) em 60s, url=${(p0.url&&p0.url())||''}`
        );
        continue; // Não tenta nem reload nem kill — só sai do loop até a próxima rodada.
      }
      if (robeMeta[nome].reloadBlockedUntil && robeMeta[nome].reloadBlockedUntil > now2) {
        continue; // Se grace está ativo, pula hint de reload para este ciclo
      }

      healthy = await tryReloadShort(p0, nome, 1);
      if (!healthy) {
        healthy = await tryReloadShort(p0, nome, 2);
      }
      if (healthy) {
        await reportAction(nome, 'mil_action', 'nurse_recover_success(reload)');
      } else {
        await reportAction(nome, 'nurse_kill', `motivo=page_zumbi url=${(p0.url&&p0.url())||''} reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
        try { registerFailure(nome, 'zombie', 'external'); } catch {}
        await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
        continue;
      }
    }

    // Guard-rail ultra militar: nunca podar/prune abas durante configuração (injeção de cookies)
    if (ctrl && ctrl.configurando) {
      console.log(`[NURSE][SKIP PRUNE] Perfil ${nome} está configurando, prune ignorado.`);
      continue;
    }
    if (!(robeMeta[nome] && robeMeta[nome].emExecucao)) {
      try { await closeExtraPages(ctrl.browser, p0, nome).catch(()=>{}); } catch {}
    }
    if (want.virtus === 'on' && autoMode.mode === 'full' && !ctrl.trabalhando && !ctrl.configurando) {
      try { ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 }); ctrl.trabalhando = true; } catch {}
    }
  }
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
  await handlers.deactivate({ nome, reason, policy: 'preserveDesired' });
  const st = getHealth(nome);
  st.stage = 'reopen';
  st.nextTryAt = Date.now() + 60000;
}

async function healthTick() {
  for (const [nome, ctrl] of controllers) {
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
        try { await registerFailure(nome, 'health_no_progress', 'internal'); } catch {}
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

  // HANDLER novo: verifica backoff por erro militar
  const now = Date.now();
  if (robeMeta[nome]?.backoffUntil && robeMeta[nome].backoffUntil > now) {
    return { ok: false, error: 'backoff_militar' };
  }
  // RAM killbackoff (Terminator)
  if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
    return { ok: false, error: 'ram_backoff' };
  }
  try {
    // Chamando normalmente
    return await _startRobeOrig.apply(this, arguments);
  } catch (e) {
    // Penalidade/robustez
    const minSec = 60, maxSec = 300;
    let sec = minSec+Math.floor(Math.random()*(maxSec-minSec+1));
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].backoffUntil = Date.now() + sec*1000;
    await reportAction(nome, 'robe_error', `Erro técnico; militar backoff ${sec}s. ${e&&e.message}`);
    return { ok: false, error: String(e&&e.message||e) };
  }
};

// Resolve manifest: tenta migrar antigo caso não exista no novo local
function resolveManifest(nome) {
  try {
    const mPath = manifestPathOf(nome);
    if (!fs.existsSync(mPath)) {
      // Tenta migrar do dados/perfis/NOME/manifest.json
      const oldPath = path.join(perfisDir, nome, 'manifest.json');
      if (fs.existsSync(oldPath)) {
        fs.mkdirSync(path.dirname(mPath), { recursive: true });
        fs.copyFileSync(oldPath, mPath);
      }
    }
    if (!fs.existsSync(mPath)) {
      // Congela se não existe em nenhum lugar!
      robeMeta[nome] = robeMeta[nome] || {};
      try { freezeProfileFor(nome, 12*60*60*1000, 'manifest_missing', 'system').catch(()=>{}); } catch {}
      try { issues.append(nome, 'robe_error', 'manifest ausente/incompleto; congelado 12h (resolveManifest)').catch(()=>{}); } catch {}
      try { snapshotStatusAndWrite().catch(()=>{}); } catch {}
      return null;
    }
    const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    // GARANTIR userDataDir em User Data\Conveniente\NOME
    const chromeRoot = resolveChromeUserDataRoot();
    const desiredDir = path.join(chromeRoot, 'Conveniente', nome);
    if (!manifest.userDataDir || !String(manifest.userDataDir).startsWith(chromeRoot)) {
      manifest.userDataDir = desiredDir;
      try { fs.mkdirSync(desiredDir, { recursive: true }); } catch {}
      // persiste alteração no manifest
      try {
        const tmp = mPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
        try { fs.unlinkSync(mPath); } catch {}
        try { fs.renameSync(tmp, mPath); }
        catch { fs.copyFileSync(tmp, mPath); try { fs.unlinkSync(tmp); } catch {} }
      } catch {}
    } else {
      // garante que o diretório existe
      try { fs.mkdirSync(manifest.userDataDir, { recursive: true }); } catch {}
    }
    return manifest;
  } catch (e) {
    return null;
  }
}

// ============ FIM: PATCH/MODO FROZEN SE MANIFEST AUSENTE ==============

if (!utils.slugify) {
  utils.slugify = function(s) {
    return String(s).toLowerCase().replace(/[^\w\d\-]+/g,'_').replace(/_+/g,'_').replace(/(^_|_$)/g,'');
  };
}

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
    console.log('[WORKER] gracefulShutdown start: reason=' + reason);
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
    try { console.warn('[WORKER] gracefulShutdown exception:', e && e.message || e); } catch {}
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
    sendReply(msg.msgId, { ok: false, error: 'Comando desconhecido' });
    return;
  }
  try {
    const resp = await fn(msg.payload || {});
    sendReply(msg.msgId, resp);
  } catch (e) {
    sendReply(msg.msgId, { ok: false, error: e && e.message || String(e) });
  }
});

process.on('uncaughtException', (e) => {
  try { console.error('uncaught:', e && e.message); } catch {}
});
process.on('unhandledRejection', (e) => {
  try { console.error('unhandled:', e && e.message); } catch {}
});