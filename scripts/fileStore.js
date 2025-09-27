// scripts/fileStore.js

// Centraliza TODO o acesso seguro a arquivos de perfis, desired, status, manifests, paths, renomeio, locks leves de migração, etc.
// Exporta funções para server.js, apis, worker etc (NÃO separar arquivos!).
// Só use funções DENTRO DESTE SCRIPT para acessar/mexer em arquivos dessas estruturas!

const fs   = require('fs');
const path = require('path');
const utils = require('./utils.js'); // slugify, etc.

//// Constantes de caminhos globais ////
const dadosDir    = path.join(__dirname, '../dados');
const perfisPath  = path.join(dadosDir, 'perfis.json');
const perfisDir   = path.join(dadosDir, 'perfis');
const presetsPath = path.join(dadosDir, 'ua_presets.json');
const desiredPath = path.join(dadosDir, 'desired.json');
const statusPath  = path.join(dadosDir, 'status.json');

// ManifestStore import para setPerfilFrozenUntil
// const manifestStore = require('./manifestStore.js');

//// (opcional) Locks locais por perfil (adicione se/quando precisar) ////
// const profileLocks = {};

//// HELPERs DE IO atômicos e seguros ////

/** Lê arquivo JSON, fallback se ausente ou inválido */
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Grava JSON atômico, sempre em tmp+rename */
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
  } catch { return false; }
}

/** Garante desired.json (perfis) existe */
function ensureDesired() {
  try { if (!fs.existsSync(desiredPath)) writeJsonAtomic(desiredPath, { perfis: {} }); } catch {}
}
/** Garante perfis.json existe */
function ensurePerfisJson() {
  try { if (!fs.existsSync(perfisPath)) writeJsonAtomic(perfisPath, []); } catch {}
}

//// PERFIS: carregar e salvar array principal ////
function loadPerfisJson() {
  return readJsonSafe(perfisPath, []);
}
function savePerfisJson(arr) {
  writeJsonAtomic(perfisPath, arr || []);
}

//// UA PRESET: balanceado sempre que criar ////
function pickUaPreset() {
  try {
    const presets = readJsonSafe(presetsPath, []);
    const perfis  = loadPerfisJson();
    if (!Array.isArray(presets) || presets.length === 0) return null;
    const count = {};
    presets.forEach(p => count[p.id] = 0);
    for (const pf of perfis) {
      if (pf.uaPresetId) count[pf.uaPresetId] = (count[pf.uaPresetId] || 0) + 1;
    }
    const min = Math.min(...Object.values(count));
    const candidates = presets.filter(p => count[p.id] === min);
    candidates.sort(() => Math.random() - 0.5);
    return candidates[0] || null;
  } catch { return null; }
}

///// === LOCK INTERNO DE desired.json  (Promise chain FIFO) === /////
let _desiredLock = Promise.resolve();
// Executa a função asyncFn(desejado atual), espera resultado, salva, retorna novo desired.
// Garantido em ordem serial via promise chain lock.
async function withDesiredLock(asyncFn) {
  let ret;
  _desiredLock = _desiredLock
    .then(async () => {
      ensureDesired();
      let desired = readJsonSafe(desiredPath, { perfis: {} });
      const novo = await asyncFn(desired);
      // Só salva se retornou objeto (não null/undefined)
      if (novo && typeof novo === 'object') {
        writeJsonAtomic(desiredPath, novo);
      }
      ret = novo;
    })
    .catch(()=>{});
  await _desiredLock;
  return ret;
}

//// PATCH DESIRED PERFIL ////
// Refatorada: lock atômico global
async function patchDesired(nome, patch) {
  return withDesiredLock(desired => {
    desired.perfis = desired.perfis || {};
    desired.perfis[nome] = { ...(desired.perfis[nome] || {}), ...(patch || {}) };
    return desired;
  });
}

//// STATUS SNAPSHOT: fallback a perfis.json se status.json ausente/inválido ////
function getStatusSnapshot() {
  // Militar: snapshot status unificado, null-safe, sem corridas, todos campos para painel
  // Carrega o snapshot do status.json, incluindo campos militares de RAM, CPU, robeMeta, cooldown, frozen etc.
  const st = readJsonSafe(statusPath, null);
  if (st && Array.isArray(st.perfis)) return st;
  // Fallback: cria estrutura básica a partir do perfis.json, SEM inventar campos ausentes
  const perfisArr = readJsonSafe(perfisPath, []);
  // PATCH: persistir e expor freezer detalhado no status (retrocompatível)
  const perfis = perfisArr.map(p => {
    let frozenReason = null, frozenAt = null, frozenSetBy = null, robeFrozenUntil = null;
    try {
      if (p.userDataDir) {
        const manifestPath = path.join(p.userDataDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const man = readJsonSafe(manifestPath, {});
          robeFrozenUntil = (typeof man.frozenUntil === 'number') ? man.frozenUntil : null;
          frozenReason = man.frozenReason || null;
          frozenAt    = man.frozenAt    || null;
          frozenSetBy = man.frozenSetBy || null;
        }
      }
    } catch {}
    return {
      nome: p.nome,
      label: p.label || null,
      cidade: p.cidade,
      uaPresetId: p.uaPresetId,
      active: false,
      trabalhando: false,
      configurando: false,
      // Militar: RAM desconhecida/null, nunca fake zero
      ramMB: null,
      // Militar: CPU desconhecida/null, nunca fake zero
      cpuPercent: null,
      // Militar: numPages desconhecido/null
      numPages: null,
      // Militar: robeFrozenUntil
      robeFrozenUntil,
      // PATCH: campos detalhados do freezer
      frozenReason,
      frozenAt,
      frozenSetBy
      // Adicione outros campos health militar que o painel consome, sempre iniciando com null se não disponível.
    };
  });
  // Não inventa campos militares se não existem snapshot
  return { perfis, robes: {}, robeQueue: [], ts: Date.now() };
}

// Função para gravar (persistir) o snapshot do status
function writeStatusSnapshot(obj) {
  // Militar: snapshot status unificado, null-safe, sem corridas, todos campos para painel
  // NÃO inventa/zera nada: salva exatamente o objeto recebido
  return writeJsonAtomic(statusPath, obj);
}

// Função: Leitura de campo militar granular por perfil
function getStatusField(nome, campo) {
  const snapshot = getStatusSnapshot();
  const ent = (snapshot.perfis||[]).find(p => p && p.nome === nome);
  if (!ent) return undefined;
  // Militar: RAM desconhecida/null, nunca fake zero
  if (
    ['ramMB', 'cpuPercent', 'numPages', 'robeFrozenUntil'].includes(campo)
  ) {
    return (typeof ent[campo] === 'number' ? ent[campo] : (ent[campo] !== undefined ? ent[campo] : null));
  }
  // PATCH: freezer detalhado (não inventar valores fake, null retrocompatível)
  if (
    ['frozenReason','frozenAt','frozenSetBy'].includes(campo)
  ) {
    return (ent[campo] !== undefined ? ent[campo] : null);
  }
  return ent[campo];
}

// Função: Atualização/patch granular de campo militar por perfil
function writeStatusField(nome, campo, valor) {
  const snapshot = getStatusSnapshot();
  const arr = Array.isArray(snapshot.perfis) ? snapshot.perfis : [];
  const idx = arr.findIndex(p => p && p.nome === nome);
  if (idx < 0) return false;
  // Militar: RAM desconhecida/null, nunca fake zero
  if(
    ['ramMB', 'cpuPercent', 'numPages', 'robeFrozenUntil'].includes(campo)
  ) {
    arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
  }
  // PATCH: freezer detalhado (não inventar valores fake, sempre null se desconhecido)
  else if (
    ['frozenReason','frozenAt','frozenSetBy'].includes(campo)
  ) {
    arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
  } else {
    arr[idx][campo] = valor;
  }
  writeJsonAtomic(statusPath, snapshot);
  return true;
}

// Função: PATCH múltiplos campos militares por perfil
function patchStatusField(nome, patchObj) {
  const snapshot = getStatusSnapshot();
  const arr = Array.isArray(snapshot.perfis) ? snapshot.perfis : [];
  const idx = arr.findIndex(p => p && p.nome === nome);
  if (idx < 0) return false;
  // Garantir null para RAM/cpu/numPages/frozen se não disponíveis!
  Object.entries(patchObj || {}).forEach(([campo, valor]) => {
    if (
      ['ramMB', 'cpuPercent', 'numPages', 'robeFrozenUntil'].includes(campo)
    ) {
      // Militar: RAM desconhecida/null, nunca fake zero
      arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
    }
    // PATCH: freezer detalhado (não inventar valores fake, sempre null se desconhecido)
    else if (
      ['frozenReason','frozenAt','frozenSetBy'].includes(campo)
    ) {
      arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
    } else {
      arr[idx][campo] = valor;
    }
  });
  writeJsonAtomic(statusPath, snapshot);
  return true;
}

// ******** REMOVIDA updateManyStatusFields(obj) ********

// Função militar completa para ler TUDO (RAM, robeMeta, cooldowns etc.)
function getFullStatusSnapshot() {
  // Sempre retorna o último snapshot físico gravado (nunca inventar/popular campos virtuais)
  return getStatusSnapshot(); // já retorna tudo do status.json conforme últimas gravações
}

// Função militar granular para update (nome, campo, valor)
function updateStatusField(nome, campo, valor) {
  return writeStatusField(nome, campo, valor);
}

// --------- CAMPOS MILITARIZADOS/ROBÔ ---------//
// Campo RAM por perfil: usado pelo painel militar e para circuit breaker de auto-reboot
// Campo robeFrozenUntil: antiflood militar, jamais re-enfileirar conta durante congelamento

// Exporta também patchStatusField e updateManyStatusFields para uso tanto pelo monitor RAM quanto circuito militar

//// VALIDADORES DE PATH ////
function existsDir(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}
function existsFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

//// REMOVE/COPIA/MOVE DIRs (rimraf, copy, move atomic) ////
function rimrafSync(target) {
  try {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    // Fallback manual old node
    try {
      if (fs.existsSync(target)) {
        const entries = fs.readdirSync(target, { withFileTypes: true });
        for (const ent of entries) {
          const cur = path.join(target, ent.name);
          if (ent.isDirectory()) rimrafSync(cur);
          else { try { fs.unlinkSync(cur); } catch {} }
        }
        try { fs.rmdirSync(target); } catch {}
      }
    } catch {}
  }
}
function copyDirSync(src, dst) {
  if (!existsDir(src)) throw new Error('src dir inexistente: ' + src);
  if (!existsDir(dst)) fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else {
      const data = fs.readFileSync(s);
      fs.writeFileSync(d, data);
    }
  }
}
function moveDirAtomicSync(src, dst) {
  if (!existsDir(src)) throw new Error('src dir inexistente: ' + src);
  try {
    fs.renameSync(src, dst);
    return true;
  } catch {
    copyDirSync(src, dst);
    rimrafSync(src);
    return true;
  }
}

//// MANIPULADORES: LABEL, SLUG RENAME etc ////
function updatePerfilLabel(nome, novoLabel) {
  const perfisArr = loadPerfisJson();
  const idx = perfisArr.findIndex(p => p && p.nome === nome);
  if (idx < 0) throw new Error('Perfil não encontrado');
  perfisArr[idx].label = String(novoLabel || '').trim();
  // Manifest também
  // NOVO TRECHO ATUALIZADO PARA userDataDir
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (perfil && perfil.userDataDir) {
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    if (existsFile(manifestPath)) {
      const man = readJsonSafe(manifestPath, {});
      man.label = String(novoLabel || '').trim();
      writeJsonAtomic(manifestPath, man);
    }
  }
  savePerfisJson(perfisArr);
  return true;
}
function renamePerfilSlug(nomeAntigo, nomeNovoDesejado) {
  // ATUALIZADO: desired e manifest proteção por lock/store
  const novoSlug = utils.slugify(nomeNovoDesejado || '');
  if (!novoSlug) throw new Error('novo nome inválido');
  if (nomeAntigo === novoSlug) return { ok: true, renamed: false, nome: nomeAntigo };
  const perfisArr = loadPerfisJson();
  const idx = perfisArr.findIndex(p => p && p.nome === nomeAntigo);
  if (idx < 0) throw new Error('Perfil não encontrado');
  if (perfisArr.some(p => p && p.nome === novoSlug)) throw new Error('Já existe uma conta com esse nome');
  // --- INÍCIO DO NOVO BLOCO: mover apenas userDataDir apontado ----
  const pOld = perfisArr[idx];
  const oldDir = pOld.userDataDir;
  const newDirParent = path.dirname(oldDir);
  const newDir = path.join(newDirParent, novoSlug);
  if (!existsDir(oldDir)) throw new Error('Diretório do perfil ausente');
  moveDirAtomicSync(oldDir, newDir);
  pOld.nome = novoSlug;
  pOld.userDataDir = newDir;
  savePerfisJson(perfisArr);
  // Manifest
  const manifestPath = path.join(newDir, 'manifest.json');
  const man = readJsonSafe(manifestPath, {});
  man.nome = novoSlug;
  man.userDataDir = newDir;
  writeJsonAtomic(manifestPath, man);
  // --- FIM DO NOVO BLOCO ---
  // desired.json (usando lock)
  withDesiredLock(desired => {
    if (desired.perfis && desired.perfis[nomeAntigo]) {
      desired.perfis[novoSlug] = { ...(desired.perfis[novoSlug] || {}), ...(desired.perfis[nomeAntigo]) };
      delete desired.perfis[nomeAntigo];
      return desired;
    }
    return desired;
  });
  // status.json (opcional)
  try {
    const st = readJsonSafe(statusPath, null);
    if (st && Array.isArray(st.perfis)) {
      st.perfis.forEach(ent => { if (ent && ent.nome === nomeAntigo) ent.nome = novoSlug; });
      writeJsonAtomic(statusPath, st);
    }
  } catch {}
  return { ok: true, renamed: true, nome: novoSlug };
}

//// CHECAGEM ATIVO ////
function isPerfilAtivo(nome) {
  try {
    const st = readJsonSafe(statusPath, null);
    if (!st || !Array.isArray(st.perfis)) return false;
    const p = st.perfis.find(x => x && x.nome === nome);
    return !!(p && p.active);
  } catch { return false; }
}

//// RESETAR desired TODOS OFF ao boot //// 
function resetDesiredAllOffOnBoot() {
  // ATUALIZADO: lock
  withDesiredLock(desired => {
    ensureDesired();
    const perfisArr = loadPerfisJson();
    desired.perfis = desired.perfis || {};
    for (const p of perfisArr) {
      if (!p || !p.nome) continue;
      const nome = p.nome;
      desired.perfis[nome] = {
        ...(desired.perfis[nome] || {}),
        active: false,
        virtus: 'off',
        configureOnce: false,
        robePlay: false,
        invokeHuman: false
      };
    }
    return desired;
  });
}

//// MÉTRICAS DO SISTEMA (RAM, CPU%) ////
// PATCH MILITAR: cpu.percent (global, para painel) é soma dos cpuPercent de todos perfis/Chrome do snapshot status.json dividido por cores.
// No Windows, loadavg==0, por isso não use loadavg! 
function getSysMetricsSnapshot() {
  const os = require('os');
  const totalBytes = os.totalmem();
  const freeBytes  = os.freemem();
  const usedBytes  = totalBytes - freeBytes;
  const toMB = (b) => Math.round(b / (1024*1024));
  const toGB = (b) => Math.round(b / (1024*1024*10)) / 100; // duas casas

  const robeMetaStatus = (() => {
    try {
      const st = readJsonSafe(statusPath, null);
      if (st && st.robes) return st.robes;
    } catch {} return null;
  })();

  let cpuApprox = null;
  if (robeMetaStatus) {
    let cpuChrome = 0, count = 0;
    for (const nome in robeMetaStatus) {
      const v = robeMetaStatus[nome]?.cpuPercent;
      if (typeof v === 'number') { cpuChrome += v; count++; }
    }
    const coresQ = (os.cpus()||[]).length || 1;
    cpuApprox = count ? Math.min(100, Math.round(cpuChrome / coresQ)) : null;
  }

  return {
    ok: true,
    mem: {
      totalBytes,
      freeBytes,
      usedBytes,
      totalMB: toMB(totalBytes),
      freeMB:  toMB(freeBytes),
      usedMB:  toMB(usedBytes),
      totalGB: toGB(totalBytes),
      freeGB:  toGB(freeBytes),
      usedGB:  toGB(usedBytes),
      minFreeRequiredMB: parseInt(process.env.MIN_FREE_RAM_MB || '1536', 10)
    },
    cpu: {
      percent: cpuApprox // <= ISSO É O QUE O PAINEL CONSOME!
    },
    ts: Date.now()
  };
}

// ******** REMOVIDA getAggregateHealthMetrics() ********

/**
 * Persiste o frozenUntil DE UM PERFIL no seu manifest (para robustez do freeze, P0).
 */
async function setPerfilFrozenUntil(nome, frozenUntil) {
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) return false;
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    const man = readJsonSafe(manifestPath, {}) || {};
    man.frozenUntil = frozenUntil;
    return writeJsonAtomic(manifestPath, man);
  } catch { return false; }
}

/**
 * Lê o frozenUntil de um manifest de perfil, caso exista.
 */
function getPerfilFrozenUntil(nome) {
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) return null;
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    if (existsFile(manifestPath)) {
      const man = readJsonSafe(manifestPath, {});
      if (man && typeof man.frozenUntil === 'number' && man.frozenUntil > Date.now()) {
        return man.frozenUntil;
      }
    }
  } catch {}
  return null;
}

// === Helpers de validação de nome/slug e de existência de perfil ===
function isValidSlug(s) {
  return typeof s === 'string' && /^[a-z0-9_-]+$/.test(s);
}
function assertPerfilExists(fileStore, nome) {
  if (!isValidSlug(nome)) throw new Error('nome invalido');
  const perfis = fileStore.loadPerfisJson();
  if (!perfis.find(p => p && p.nome === nome)) throw new Error('perfil inexistente');
}

// EXPORTAÇÃO EXPANDIDA PARA FUNÇÕES MILITARES
module.exports = {
  dadosDir, perfisPath, perfisDir, presetsPath, desiredPath, statusPath,
  readJsonSafe, writeJsonAtomic, ensureDesired, ensurePerfisJson,
  patchDesired, // agora async/lock
  loadPerfisJson, savePerfisJson, pickUaPreset, getStatusSnapshot, isPerfilAtivo,
  rimrafSync, copyDirSync, moveDirAtomicSync, updatePerfilLabel, renamePerfilSlug,
  resetDesiredAllOffOnBoot, getSysMetricsSnapshot, existsFile, existsDir,
  // Militares:
  writeStatusSnapshot,
  getStatusField, writeStatusField, patchStatusField,
  getFullStatusSnapshot, updateStatusField,
  setPerfilFrozenUntil,
  getPerfilFrozenUntil,
  // Novos helpers (APIs):
  isValidSlug,
  assertPerfilExists,
  // Lock helper export
  withDesiredLock,
};