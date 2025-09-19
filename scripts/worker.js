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

// NOVO: Import RAM/CPU cross-platform
const pidusage = require('pidusage');
const psList = require('ps-list');

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

const autoMode = {
  mode: 'full', since: Date.now(), reason: '',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }
// ===== FIM PATCH MILITAR: BLOCO AUTO-ADAPTATIVO =====

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
function readManifest(nome) {
  try {
    const mPath = manifestPathOf(nome);
    if (!fs.existsSync(mPath)) return null;
    const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    return man || null;
  } catch { return null; }
}
function writeManifest(nome, man) {
  try {
    const mPath = manifestPathOf(nome);
    const dir = path.dirname(mPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = mPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(man, null, 2), 'utf8');
    try { fs.unlinkSync(mPath); } catch {}
    try { fs.renameSync(tmp, mPath); }
    catch {
      fs.copyFileSync(tmp, mPath);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch { return false; }
}

// Converte robeCooldownUntil -> robeCooldownRemainingMs quando a conta NÃO está apta a postar (congela)
function freezeCooldownIfNotWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (working && !humanControl) return;
    const man = readManifest(nome);
    if (!man) return;
    const now = Date.now();
    if (man.robeCooldownUntil && man.robeCooldownUntil > now) {
      const remain = man.robeCooldownUntil - now;
      man.robeCooldownRemainingMs = remain;
      man.robeCooldownUntil = 0;
      writeManifest(nome, man);
    }
  } catch {}
}

// Converte robeCooldownRemainingMs -> robeCooldownUntil quando a conta está apta a postar (descongela)
function unfreezeCooldownIfWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (!working || humanControl) return;
    const man = readManifest(nome);
    if (!man) return;
    const now = Date.now();
    if ((man.robeCooldownUntil || 0) <= now) {
      const remaining = Number(man.robeCooldownRemainingMs || 0);
      if (remaining > 0) {
        man.robeCooldownUntil = now + remaining;
        man.robeCooldownRemainingMs = 0;
        writeManifest(nome, man);
      }
    }
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

// ======= INÍCIO: TRAVA DE ATIVAÇÃO SIMULTÂNEA =========
const activating = new Set();
// ======= FIM: TRAVA DE ATIVAÇÃO SIMULTÂNEA ============

// ======= INÍCIO: LOCK GLOBAL DE ATIVAÇÃO (ULTRA ROBUSTO) =======
const activationLocks = new Map(); // nome => Promise em andamento

async function activateOnce(nome, source = '') {
if (!nome) return { ok: false, error: 'Nome ausente' };
// Já está ativo?
if (controllers.has(nome)) return { ok: true, already: true };

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
const browser = await browserHelper.openBrowser(manifest);
if (!browser || typeof browser.newPage !== 'function') {
throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
}
controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });

// PATCH MILITAR: marcar ativação e limpar históricos/avisos
robeMeta[nome] = robeMeta[nome] || {};
robeMeta[nome].activatedAt = Date.now();
robeMeta[nome].ramHist = [];
robeMeta[nome].cpuHistory = [];
robeMeta[nome].lastWarn = null;

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
writeJsonAtomic(statusPath, st);
} catch {}
try { await reportAction(nome, 'activate_failed', 'Falha ao abrir navegador: ' + (e && e.message)); } catch {}
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
async function closeExtraPages(browser, mainPage) {
  try {
    const pages = await browser.pages();
    for (const page of pages) {
      if (mainPage && page === mainPage) continue;
      if (!mainPage && pages[0] && page === pages[0]) continue; // fallback se mainPage desconhecida
      try { await page.close(); } catch {}
    }
    console.debug('[PRUNER] Fechou abas extras, restando:', (await browser.pages()).length);
  } catch {}
}

// -------- PRUNE LOOP: Para cada browser, fecha abas extras periodicamente ---------
const _pruners = new Map(); // nome => pruneInterval

function maybeStartPruneLoop(nome, browser, mainPage) {
  if (_pruners.has(nome)) return;
  const interval = setInterval(async () => {
    try {
      await closeExtraPages(browser, mainPage);
    } catch (e) {
      console.warn('[PRUNER] Erro prune:', e && e.message || e);
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
              .then(() => reportAction(nome, 'cpu_memory_spike', `CPU breaker acionado (>=150% por 5 rodadas)`))
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
    if (!robeMeta[nome].activatedAt || Date.now() - robeMeta[nome].activatedAt < 180000) continue; // ignora <3min
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
        .then(() => reportAction(nome, 'chrome_memory_spike', `RAM breaker acionado (mb=${ramMB}, allHigh=${allHigh}, slopeOK=${slopeOK})`))
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

  if (autoMode.mode === 'full' && autoMode.hot >= AUTO_CFG.HOT_TICKS && _canSwitch()) {
    autoMode.mode = 'light';
    autoMode.since = Date.now();
    autoMode.reason = `CPU≈${cpuApprox}% (EMA≈${Math.round(autoMode.cpuEma||0)}%), freeMB=${freeMB} (EMA≈${Math.round(autoMode.freeEmaMB||0)})`;
    autoMode.light.nextRobeEnqueueAt = Date.now() + AUTO_CFG.ROBE_LIGHT_MIN_SPACING_MS;
    try { await reportAction('system', 'auto_mode', 'enter_light: ' + autoMode.reason); } catch {}
  }
  if (autoMode.mode === 'light' && autoMode.cool >= AUTO_CFG.COOL_TICKS && _canSwitch()) {
    autoMode.mode = 'full';
    autoMode.since = Date.now();
    autoMode.reason = '';
    try { await reportAction('system', 'auto_mode', 'exit_light'); } catch {}
  }
  // ===== FIM PATCH MILITAR: Avaliação/autoMode global =====

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
      if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > Date.now()) {
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

      let mainPage = null;
      try {
        if (ctrl && ctrl.browser && !ctrl.mainPage) {
          try {
            const pages = await ctrl.browser.pages();
            if (pages[0]) ctrl.mainPage = pages[0];
          } catch {}
        }
        mainPage = ctrl.mainPage;

        // PRUNE DE ABAS: sempre antes/antes de começar
        try { await closeExtraPages(ctrl.browser, mainPage); } catch {}

        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          virtusWasRunning = true;
          try { await ctrl.virtus.stop(); } catch {}
          ctrl.virtus = null; // ficará pausado durante o Robe
          // Mantemos ctrl.trabalhando = true para a semântica de "conta trabalhando"
        }

        // Pause curto pós-postagem
        const robePauseMs = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;

        // ==== ALTERAÇÃO HOTFIX: ANTIMANIFEST-FLOOD, COOL/PRUNED ERRORS ====
        let res;
        try {
          res = await robeHelper.startRobe(ctrl.browser, nome, robePauseMs, workingNow);
        } catch (e) {
          // Penalidade por erro técnico
          const penalSec = 60+Math.floor(Math.random()*241); // 60-300s
          const man = readManifest(nome) || {};
          const nextCd = Date.now() + penalSec*1000;
          man.robeCooldownUntil = nextCd;
          man.robeCooldownRemainingMs = 0;
          writeManifest(nome, man);
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].cooldownSec = penalSec;
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown militar ${penalSec}s`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: penalSec });
          return; // não crasha fila global
        }
        // ==== EOF COOL/PRUNED ERRORS ====

        if (res && res.ok) {
          try {
            const perfilPath = manifestPathOf(nome);
            if (fs.existsSync(perfilPath)) {
              const p = JSON.parse(fs.readFileSync(perfilPath, 'utf8'));
              p.ultimaPostagemRobe = Date.now();
              fs.writeFileSync(perfilPath, JSON.stringify(p, null, 2));
            }
          } catch {}
          robeUpdateMeta(nome, {
            estado: 'ok',
            cooldownSec: robeCooldownLeft(nome),
            proximaPostagem: robeLastPosted(nome) + robePauseMs,
            ultimaPostagem: Date.now()
          });
        } else {
          robeUpdateMeta(nome, {
            estado: 'idle',
            cooldownSec: robeCooldownLeft(nome)
          });
        }
      } catch (e) {
        robeUpdateMeta(nome, { estado: 'erro', cooldownSec: robeCooldownLeft(nome) });
      } finally {
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

        // PRUNE DE ABAS após ciclo de configure/post
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage); } catch {}
      }
    });

    robeUpdateMeta(nome, { emFila: true });
  }

  // Remove metainfos fantasmas
  for (const nome in robeMeta) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) delete robeMeta[nome];
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

// LIMPA PRUNER DE ABAS
stopPruneLoop(nome);

// Persiste desired.active=false e virtus='off' (não reabrir no boot)
try {
  const d = readJsonFile(desiredPath, { perfis: {} });
  d.perfis = d.perfis || {};
  d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
  writeJsonAtomic(desiredPath, d);
} catch {}

// Atualiza status.json imediato
try { await snapshotStatusAndWrite(); } catch {}

// ===== NOVO: Registrar browser_disconnected =====
// try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}
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
    return await activateOnce(nome, 'message');
  },

  async deactivate({ nome, reason, policy }) {
    // POLÍTICA preserveDesired para RAM/CPU breaker!
    // Se ramKill/cpuKill e policy preserveDesired, marca reopenAt/robeFrozenUntil, NÃO zera desired, nem desired.active.
    // Limite militar: max 3x em 10min, senão frozen por 1h.
    let killSource = (reason === 'ramKill' || reason === 'cpuKill') && policy === 'preserveDesired';
    if (killSource) {
      const MAX_ATTEMPTS = 3, WINDOW_MS = 10*60*1000, FROZEN_MS = 60*60*1000;
      robeMeta[nome] = robeMeta[nome] || {};
      if (!robeMeta[nome].killHistory) robeMeta[nome].killHistory = [];
      let arr = robeMeta[nome].killHistory = robeMeta[nome].killHistory.filter(t => t > Date.now() - WINDOW_MS);
      arr.push(Date.now());
      if (arr.length > MAX_ATTEMPTS) {
        // congelar 1h
        robeMeta[nome].frozenUntil = Date.now() + FROZEN_MS;
        robeMeta[nome].killHistory = [];
      } else {
        robeMeta[nome].reopenAt = Date.now() + 4*60*1000 + Math.floor(Math.random()*120000);
      }
    }
    // Prossiga desativação normal, exceto: preserve desired.active/virtus!
    const ctrl = controllers.get(nome);
    if (!ctrl) {
      await snapshotStatusAndWrite();
      return { ok: true };
    }
    try {
      if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
        await ctrl.virtus.stop();
      }
    } catch (e) {
      console.warn('[WORKER][deactivate] erro ao parar Virtus:', e && e.message || e);
    }
    try {
      if (ctrl.browser && ctrl.browser.close) {
        await ctrl.browser.close();
      }
    } catch (e) {
      console.warn('[WORKER][deactivate] erro ao fechar browser:', e && e.message || e);
    }
    try { freezeCooldownIfNotWorking(nome); } catch {}
    controllers.delete(nome);

    // LIMPAR PRUNER ao desativar
    stopPruneLoop(nome);

    // desired NÃO é mexido se preserveDesired, só marca reopenAt e snapshot
    if (!killSource) {
      try {
        const d = readJsonFile(desiredPath, { perfis: {} });
        d.perfis = d.perfis || {};
        d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
        writeJsonAtomic(desiredPath, d);
      } catch {}
    }
    await snapshotStatusAndWrite();
    return { ok: true };
  },

  async configure({ nome }) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) return { ok: false, error: 'Navegador não está aberto para esta conta!' };
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
    // ALTERAÇÃO 1: mantenha/simplifique, nunca chamado via workerClient, só via desired.json + reconciliador.
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) return { ok: false, error: 'Navegador não está aberto para esta conta!' };
    if (ctrl.trabalhando) return { ok: true }; // já trabalhando

    try {
      ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 });
      ctrl.trabalhando = true;

      // === GARANTE PRUNE SÓ NESTE MOMENTO (PRODUÇÃO!) ===
      try {
        if (ctrl.browser && typeof browserHelper.forceCloseExtras === 'function') {
          await browserHelper.forceCloseExtras(ctrl.browser);
        }
      } catch (e) {
        try { console.warn('[WORKER][start_work] prune/forceCloseExtras fail:', e && e.message || e); } catch {}
      }

      await snapshotStatusAndWrite();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  },

  async invoke_human({ nome }) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) return { ok: false, error: 'Navegador não está aberto para esta conta!' };

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
    if (!ctrl || !ctrl.browser) return { ok: false, error: 'Navegador não está aberto para esta conta!' };

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
    if (!ctrl || !ctrl.browser) return { ok: false, error: 'Navegador não está aberto para esta conta!' };

    // Zera cooldown no manifest
    try {
      const manifestPath = manifestPathOf(nome);
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.robeCooldownUntil = Date.now();
        manifest.robeCooldownRemainingMs = 0;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
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

        let mainPage = null;
        try {
          if (ctrl && ctrl.browser && !ctrl.mainPage) {
            try {
              const pages = await ctrl.browser.pages();
              if (pages[0]) ctrl.mainPage = pages[0];
            } catch {}
          }
          mainPage = ctrl.mainPage;

          // PRUNE ANTI-ABAS
          try { await closeExtraPages(ctrl.browser, mainPage); } catch {}

          // ==== ALTERAÇÃO HOTFIX: ANTIMANIFEST-FLOOD, COOL/PRUNED ERRORS ====
          let res;
          try {
            res = await robeHelper.startRobe(ctrl.browser, nome, (15 + Math.floor(Math.random() * 16)) * 60 * 1000, workingNow);
          } catch (e) {
            // Penalidade por erro técnico
            const penalSec = 60+Math.floor(Math.random()*241); // 60-300s
            const man = readManifest(nome) || {};
            const nextCd = Date.now() + penalSec*1000;
            man.robeCooldownUntil = nextCd;
            man.robeCooldownRemainingMs = 0;
            writeManifest(nome, man);
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].cooldownSec = penalSec;
            await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown militar ${penalSec}s`);
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: penalSec });
            return; // não crasha fila global
          }
          // ==== EOF COOL/PRUNED ERRORS ====

          if (res && res.ok) {
            try {
              const perfilPath = manifestPathOf(nome);
              if (fs.existsSync(perfilPath)) {
                const p = JSON.parse(fs.readFileSync(perfilPath, 'utf8'));
                p.ultimaPostagemRobe = Date.now();
                fs.writeFileSync(perfilPath, JSON.stringify(p, null, 2));
              }
            } catch {}
            robeUpdateMeta(nome, {
              estado: 'ok',
              cooldownSec: robeCooldownLeft(nome),
              proximaPostagem: robeLastPosted(nome) + ((15+Math.floor(Math.random()*16))*60*1000),
              ultimaPostagem: Date.now()
            });
          } else {
            robeUpdateMeta(nome, {
              estado: 'idle',
              cooldownSec: robeCooldownLeft(nome)
            });
          }
        } catch (e) {
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: robeCooldownLeft(nome) });
        } finally {
          if (virtusWasRunning) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0 });
              ctrl.trabalhando = true;
            } catch (e) {}
          }
          robeUpdateMeta(nome, { emExecucao: false });
          await snapshotStatusAndWrite();

          // PRUNE DE ABAS após ciclo
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage); } catch {}
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
      };
    });
    const robes = {};
    perfisArr.forEach(p => {
      const nome = p.nome;
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
    return {
      perfis,
      robes,
      robeQueue: robeQueueList,
      autoMode,
      sys
    };
  }
};

// == INÍCIO: função para escrever o snapshot de status (status.json) ==
async function snapshotStatusAndWrite() {
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
};
});
const robes = {};
perfisArr.forEach(p => {
const nome = p.nome;
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
writeJsonAtomic(statusPath, statusObj);
} catch (e) {
try { console.warn('[WORKER][statusWrite] erro:', e && e.message || e); } catch {}
}
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
    // Auto-reabrir (militar)
    robeMeta[nome].reopenAt = null;
    robeMeta[nome].killHistory = [];
    try { await activateOnce(nome, 'reopenAt-preserveDesired'); } catch {}
    continue;
  }

  // Liga/desliga browser
  if (want.active === true && !ctrl) {
    // Guard-rail frozen: se estiver congelado, pula
    if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > Date.now()) continue;

    // === PATCH autoMode Light: gate para ativação no reconcileOnce ===
    const now = Date.now();
    if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > now) continue;
    if (autoMode.mode === 'light') {
      const base = 20000, factor = Math.min(9, 1 + (autoMode.hot||0)), jitter = Math.floor(Math.random()*5000);
      const holdMs = Math.min(180000, base*factor) + jitter;
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].activationHeldUntil = now + holdMs;
      autoMode.light.activationHeld++;
      continue;
    }
    // === FIM PATCH autoMode Light ===

    try { await activateOnce(nome, 'reconcile'); } catch {}
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
            writeJsonAtomic(desiredPath, d2);
          }
        } catch {}
      }
    } catch {}
  }

  // Virtus on/off
  if (want.virtus === 'on' && !ctrl2.trabalhando && !ctrl2.configurando) {
    try { await handlers.start_work({ nome }); } catch {}
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
            writeJsonAtomic(desiredPath, d2);
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
            writeJsonAtomic(desiredPath, d2);
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
            writeJsonAtomic(desiredPath, d2);
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
      const man = readManifest(nome) || {};
      const plus24 = 24 * 60 * 60 * 1000;
      const humanControl = !!(ctrl3 && ctrl3.humanControl);
      if (working && !humanControl) {
        man.robeCooldownUntil = now + plus24;
        man.robeCooldownRemainingMs = 0;
      } else {
        man.robeCooldownUntil = 0;
        man.robeCooldownRemainingMs = plus24;
      }
      writeManifest(nome, man);

      const d2 = readJsonFile(desiredPath, { perfis: {} });
      if (d2 && d2.perfis && d2.perfis[nome]) {
        d2.perfis[nome].robePause24h = false;
        writeJsonAtomic(desiredPath, d2);
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

// ============ INÍCIO: PATCH/MODO FROZEN SE MANIFEST AUSENTE ==============

// PATCH: intercepta robeHelper.startRobe para bloquear e congelar militarmente se manifest ausente
const _startRobeOrig = robeHelper.startRobe;
robeHelper.startRobe = async function(browser, nome, robePauseMs, workingNow) {
  // GUARD: antifila infinito, antiflood militar se manifest ausente
  let manifest;
  try { manifest = readManifest(nome); } catch(e){}
  if (!manifest) {
    // Congela por 12h!
    const frozenUntil = Date.now() + 12*60*60*1000;
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].frozenUntil = frozenUntil;
    await reportAction(nome, 'robe_error', 'manifest ausente; congelado por 12h');
    return { ok: false, error: 'no_manifest' };
  }

  // Circuit breaker/migração manifest incompleto
  if (!manifest.cookies || !manifest.fp) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].frozenUntil = Date.now() + 12*60*60*1000;
    await reportAction(nome, 'robe_error', 'manifest incompleto (cookies/fp); congelado por 12h');
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
      robeMeta[nome].frozenUntil = Date.now() + 12*60*60*1000;
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