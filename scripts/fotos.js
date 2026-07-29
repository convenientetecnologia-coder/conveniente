// scripts/fotos.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto'); // <--- ADICIONADO
const logger = require('./logger.js'); // <--- ADICIONADO

// ------------------------ Configs e caminhos ------------------------
const DADOS_DIR = path.join(__dirname, '..', 'dados');
const INDEX_FILE = path.join(DADOS_DIR, 'fotos_postadas.json');

// BLOCO DE LOCK INTERPROCESSO
const INDEX_LOCK_FILE = INDEX_FILE + '.lock';

async function acquireIndexLock(retries = 200, delayMs = 15) {
  for (let i = 0; i < retries; i++) {
    try {
      // Verifica stale lock antes de tentar abrir (locks órfãos >60s são removidos)
      if (fs.existsSync(INDEX_LOCK_FILE)) {
        try {
          const st = fs.statSync(INDEX_LOCK_FILE);
          const age = Date.now() - st.mtimeMs;
          if (age > 60 * 1000) {
            // Lock órfão (>60s) - remove silenciosamente
            try { fs.unlinkSync(INDEX_LOCK_FILE); } catch {}
          }
        } catch {}
      }
      const fd = fs.openSync(INDEX_LOCK_FILE, 'wx');
      return fd;
    } catch {
      // Lock ocupado - aguarda e tenta novamente
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('index_lock_timeout');
}
function releaseIndexLock(fd) {
  try { if (typeof fd === 'number') fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(INDEX_LOCK_FILE); } catch {}
}

function canonName(s) { return String(s || '').trim().toLowerCase(); }
function canonNames(arr) { return Array.from(new Set((arr || []).map(canonName))).filter(Boolean); }

// Diretório de fotos: usa env FOTOS_DIR se existir; senão Desktop/Área de Trabalho/fotos
function resolveFotosDir() {
  if (process.env.FOTOS_DIR && fs.existsSync(process.env.FOTOS_DIR)) {
    return process.env.FOTOS_DIR;
  }
  const home = os.homedir();
  let desktopPath = path.join(home, 'Desktop');
  if (!fs.existsSync(desktopPath)) desktopPath = path.join(home, 'Área de Trabalho');
  return path.join(desktopPath, 'fotos');
}

// ----------- SHA-256 Helper -----------
function sha256File(abs) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(abs);
      rs.on('data', chunk => hash.update(chunk));
      rs.on('end', () => resolve(hash.digest('hex')));
      rs.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ------------------------ Utils atômicos ------------------------
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      fs.fsyncSync(fd); // <-- FSYNC aqui
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
  } catch { return false; }
}
function isImageFile(name) {
  return /.(jpe?g|png)$/i.test(name || '');
}

// Serialização simples para evitar corridas entre chamadas
let _queue = Promise.resolve();
function _serialize(fn) {
  const next = _queue.then(() => fn());
  _queue = next.catch(() => {}); // não interrompe a cadeia
  return next;
}

// ------------------------ Core do índice ------------------------
function ensureIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    writeJsonAtomic(INDEX_FILE, {}); // cria vazio
  }
}
function loadIndex() {
  ensureIndex();
  const idx = readJsonSafe(INDEX_FILE, {});
  // Compat: se valor for array, converte para { postedBy: arr }
  // --- PASSO 1: Certifique/normalize postedBy e reservedBy ---
  for (const k of Object.keys(idx)) {
    const v = idx[k];
    if (Array.isArray(v)) {
      idx[k] = { postedBy: v.slice(0) };
    } else if (!v || typeof v !== 'object') {
      idx[k] = { postedBy: [] };
    } else {
      if (!Array.isArray(v.postedBy)) v.postedBy = [];
      if (!v.reservedBy || typeof v.reservedBy !== 'object') v.reservedBy = {};
      // normaliza campos extra
      if (v.size != null && typeof v.size !== 'number') delete v.size;
      if (v.mtimeMs != null && typeof v.mtimeMs !== 'number') delete v.mtimeMs;
      if (v.deletePending != null && typeof v.deletePending !== 'boolean') delete v.deletePending;
      if (v.generation != null && typeof v.generation !== 'number') delete v.generation;
    }
  }

  // NUNCA calcular SHA em massa aqui. O SHA é calculado lazy/streaming em applyStatToRec()
  // quando um arquivo é visto/necessário, evitando buffers gigantes no heap.
  // Mantemos apenas saneamento das estruturas:
  for (const name of Object.keys(idx)) {
    const rec = idx[name] || {};
    if (!Array.isArray(rec.postedBy)) rec.postedBy = [];
    if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};
    if (rec.size != null && typeof rec.size !== 'number') delete rec.size;
    if (rec.mtimeMs != null && typeof rec.mtimeMs !== 'number') delete rec.mtimeMs;
    if (rec.deletePending != null && typeof rec.deletePending !== 'boolean') delete rec.deletePending;
    if (rec.generation != null && typeof rec.generation !== 'number') delete rec.generation;
    idx[name] = rec;
  }

  // O restante da função igual, sem cálculo massa de SHA, size, mtimeMs global.

  return idx;
}
function saveIndex(idx) {
  return writeJsonAtomic(INDEX_FILE, idx);
}

// ------------------------ Leitura de fotos do diretório ------------------------
function normalizeFotosSizeSubdir(size) {
  const s = String(size || '').trim().toUpperCase();
  if (s === 'P' || s === 'M' || s === 'G') return s.toLowerCase();
  return null;
}

/**
 * Garante Desktop/fotos e subpastas p/m/g (cria vazias se faltarem).
 * Usado ao ativar Robe V3 e antes de picks com size.
 */
function ensurePmgDirs() {
  const baseDir = resolveFotosDir();
  const created = [];
  const errors = [];
  try {
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
      created.push('.');
    }
  } catch (e) {
    errors.push({ path: baseDir, error: (e && e.message) || String(e) });
  }
  for (const sub of ['p', 'm', 'g']) {
    const d = path.join(baseDir, sub);
    try {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
        created.push(sub);
      }
    } catch (e) {
      errors.push({ path: d, error: (e && e.message) || String(e) });
    }
  }
  return {
    ok: errors.length === 0,
    baseDir,
    created,
    errors,
    dirs: {
      p: path.join(baseDir, 'p'),
      m: path.join(baseDir, 'm'),
      g: path.join(baseDir, 'g')
    }
  };
}

/**
 * Cascata V3: tamanho pedido → raiz fotos → outros tamanhos → só então aborta.
 * P: p → root → m → g
 * M: m → root → g → p
 * G: g → root → m → p
 * Sem size (V1/V2): só root.
 */
function buildV3PhotoScopeChain(preferredSize) {
  const pref = normalizeFotosSizeSubdir(preferredSize);
  if (!pref) return [null];
  const others = {
    p: ['m', 'g'],
    m: ['g', 'p'],
    g: ['m', 'p']
  };
  return [pref, null].concat(others[pref] || []);
}

function listAllPhotosSortedByMtimeAsc(opts = {}) {
  const baseDir = resolveFotosDir();
  const sub = normalizeFotosSizeSubdir(opts && opts.size);
  // opts.size === false ou { rootOnly: true } via sub null lista só a raiz (arquivos, sem entrar em p/m/g)
  const dir = sub ? path.join(baseDir, sub) : baseDir;
  if (!fs.existsSync(dir)) return [];
  let list = [];
  try {
    list = fs.readdirSync(dir).filter(isImageFile);
  } catch {
    return [];
  }
  const enriched = list.map(name => {
    const key = sub ? path.join(sub, name).replace(/\\/g, '/') : name;
    const abs = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    return { name: key, abs, stat: st };
  }).filter(x => !!x.stat);
  enriched.sort((a, b) => (a.stat.mtimeMs || 0) - (b.stat.mtimeMs || 0));
  return enriched;
}

function scopeLabel(scope) {
  return scope == null ? 'root' : String(scope);
}

// ------------------------ SHA e META helpers ------------------------

// Atualiza metadados de stat do registro + SHA-256
async function applyStatToRec(rec, stat, absPath) {
  rec.size = stat.size;
  rec.mtimeMs = stat.mtimeMs;
  if (typeof rec.generation !== 'number') rec.generation = 1;
  // Calcule SHA-256 assim que nova geração surge
  try {
    rec.sha256 = await sha256File(absPath || '');
  } catch (e) {
    logger.warn('[FOTOS][applyStatToRec] Falha ao calcular sha256', { arquivo: absPath, error: e && e.message || e });
  }
}

// Verifica se o arquivo atual parece ser a mesma “geração” que registramos (preferencialmente por hash)
function sameGeneration(rec, stat, absPath) {
  if (!rec || !stat) return false;
  try {
    if (rec.sha256 && absPath && fs.existsSync(absPath)) {
      const cur = require('crypto').createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      return rec.sha256 === cur;
    }
  } catch (e) {
    logger.warn('[FOTOS][sameGeneration] Erro ao comparar SHA256', { arquivo: absPath, error: e && e.message || e });
    return false;
  }
  if (typeof rec.size !== 'number' || typeof rec.mtimeMs !== 'number') return false;
  return rec.size === stat.size && rec.mtimeMs === stat.mtimeMs;
}

// ------------------------ API pública ------------------------

/**
 * Escolhe uma foto para uma conta que ainda não foi usada por ela.
 *
 * Garante:
 *     Nunca retorna foto cujo postedBy contenha nomeConta.
 *     Se a foto do disco mudou (mesmo nome, outro arquivo), zera postedBy (trata como “nova”).
 *     Se o arquivo sumiu, remove entrada do índice.
 *
 * V3 (opts.size = P|M|G):
 *   1) pasta do tamanho pedido
 *   2) raiz Desktop/fotos
 *   3) outras pastas (P→M→G / M→G→P / G→M→P)
 *   4) só então no-photo-available
 *   Pastas p/m/g são criadas automaticamente se faltarem.
 *
 * @param {string} nomeConta
 * @param {string[]} workingNames
 * @param {{ size?: string }} [opts]
 * @returns {Promise<{ok:true,file:string,absPath:string,size?:string|null,usedScope?:string,fallback?:boolean}|{ok:false,error:string}>}
 */
async function pickPhotoForAccount(nomeConta, workingNames = [], opts = undefined) {
  nomeConta = canonName(nomeConta);
  workingNames = canonNames(workingNames);
  const requestedSize = normalizeFotosSizeSubdir(opts && opts.size);
  const scopeChain = buildV3PhotoScopeChain(requestedSize);

  return _serialize(async () => {
    const lockFd = await acquireIndexLock();
    try {
      const baseDir = resolveFotosDir();
      if (!fs.existsSync(baseDir)) {
        try { fs.mkdirSync(baseDir, { recursive: true }); } catch {}
      }
      if (!fs.existsSync(baseDir)) return { ok: false, error: 'fotos_dir_missing' };

      // V3: cria p/m/g vazias se faltarem (nunca falha só por pasta ausente).
      if (requestedSize) {
        try { ensurePmgDirs(); } catch {}
      }

      let idx = loadIndex();

      // Idempotência: reutiliza reserva existente desta conta.
      // V3 (com size): aceita reserva em qualquer escopo da cascata (retry após fallback).
      // V1/V2: só raiz (não reutiliza chaves p/m/g).
      {
        let toRemove = [];
        for (const [k, rec] of Object.entries(idx)) {
          if (!(rec && rec.reservedBy && rec.reservedBy[nomeConta])) continue;
          const isPmgKey = /^[pmg][\\/]/i.test(String(k));
          if (!requestedSize && isPmgKey) continue;
          const abs = path.join(baseDir, k);
          if (fs.existsSync(abs)) {
            try {
              logger.info('[FOTOS][pickPhotoForAccount] reserva existente reutilizada', {
                conta: nomeConta,
                file: k,
                requestedSize: requestedSize || null
              });
            } catch {}
            return {
              ok: true,
              file: k,
              absPath: abs,
              size: requestedSize || null,
              usedScope: isPmgKey ? String(k).slice(0, 1).toLowerCase() : 'root',
              fallback: !!(requestedSize && (!isPmgKey || String(k).slice(0, 1).toLowerCase() !== requestedSize))
            };
          }
          delete rec.reservedBy[nomeConta];
          toRemove.push(k);
        }
        let removed = false;
        for (const key of toRemove) {
          if (!fs.existsSync(path.join(baseDir, key))) {
            delete idx[key];
            removed = true;
          }
        }
        if (removed) saveIndex(idx);
      }

      const cascadeStats = [];

      for (const scope of scopeChain) {
        const all = listAllPhotosSortedByMtimeAsc(scope ? { size: scope } : {});
        const stats = {
          scope: scopeLabel(scope),
          total: all.length,
          skippedPosted: 0,
          skippedReservedOther: 0,
          picked: 0
        };
        let changed = false;

        for (const item of all) {
          const { name, abs, stat } = item;
          let rec = idx[name];

          if (!rec) {
            rec = idx[name] = { postedBy: [], reservedBy: {} };
            try {
              await applyStatToRec(rec, stat, abs);
            } catch (e) {
              logger.warn('[FOTOS][pickPhotoForAccount] Erro ao aplicar stat em novo arquivo', { arquivo: abs, error: e && e.message || e });
            }
            changed = true;
          } else if (!sameGeneration(rec, stat, abs)) {
            rec.postedBy = [];
            rec.reservedBy = {};
            try {
              await applyStatToRec(rec, stat, abs);
            } catch (e) {
              logger.warn('[FOTOS][pickPhotoForAccount] Erro ao aplicar stat em troca de geração', { arquivo: abs, error: e && e.message || e });
            }
            rec.deletePending = false;
            changed = true;
          }

          if (!Array.isArray(rec.postedBy)) rec.postedBy = [];
          if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};

          if (rec.reservedBy[nomeConta]) {
            cascadeStats.push(stats);
            return {
              ok: true,
              file: name,
              absPath: abs,
              size: requestedSize || null,
              usedScope: scopeLabel(scope),
              fallback: !!(requestedSize && scope !== requestedSize)
            };
          }
          if (rec.postedBy.map(canonName).includes(nomeConta)) { stats.skippedPosted++; continue; }
          if (Object.keys(rec.reservedBy).length > 0) { stats.skippedReservedOther++; continue; }

          rec.reservedBy[nomeConta] = { ts: Date.now() };
          saveIndex(idx);
          stats.picked++;
          cascadeStats.push(stats);
          const isFallback = !!(requestedSize && scope !== requestedSize);
          try {
            logger.info('[FOTOS][pickPhotoForAccount] foto reservada', {
              conta: nomeConta,
              file: name,
              requestedSize: requestedSize || null,
              usedScope: scopeLabel(scope),
              fallback: isFallback,
              cascade: cascadeStats
            });
          } catch {}
          return {
            ok: true,
            file: name,
            absPath: abs,
            size: requestedSize || null,
            usedScope: scopeLabel(scope),
            fallback: isFallback
          };
        }

        // Limpeza de índice só no escopo atual
        let removed = false;
        for (const key of Object.keys(idx)) {
          if (scope) {
            const prefix = `${scope}/`;
            if (!String(key).startsWith(prefix) && !String(key).startsWith(`${scope}\\`)) continue;
          } else if (/^[pmg][\\/]/i.test(String(key))) {
            continue;
          }
          const abs = path.join(baseDir, key);
          if (!fs.existsSync(abs)) {
            delete idx[key];
            removed = true;
          }
        }
        if (removed || changed) saveIndex(idx);
        cascadeStats.push(stats);
      }

      try {
        logger.warn('[FOTOS][pickPhotoForAccount] no-photo-available', {
          conta: nomeConta,
          requestedSize: requestedSize || null,
          cascade: cascadeStats,
          indexSize: Object.keys(idx || {}).length
        });
      } catch {}
      return { ok: false, error: 'no-photo-available' };
    } catch (e) {
      logger.error('[FOTOS][pickPhotoForAccount] Erro inesperado', { error: e && e.message || e, stack: e && e.stack });
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}

/**
 * Libera a reserva de uma conta específica para um arquivo, caso haja erro ou abandono.
 * @param {string} nomeConta
 * @param {string} fileName
 * @returns {Promise<{ok:true}>}
 */
async function releaseReservation(nomeConta, fileName) {
  nomeConta = canonName(nomeConta);
  return _serialize(async () => {
    const lockFd = await acquireIndexLock();
    try {
      let idx = loadIndex();
      const rec = idx[fileName];
      if (rec && rec.reservedBy && rec.reservedBy[nomeConta]) {
        delete rec.reservedBy[nomeConta];
        saveIndex(idx);
      }
      return { ok: true };
    } catch (e) {
      logger.warn('[FOTOS][releaseReservation] Erro ao liberar reserva', { arquivo: fileName, conta: nomeConta, error: e && e.message || e });
      return { ok: true };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}

/**
 * ATENÇÃO: ESTA FUNÇÃO DEVE SER CHAMADA APÓS TODA TENTATIVA DE POSTAGEM, INDEPENDENTE DE SUCESSO OU FALHA. 
 * ELA GARANTE QUE A FOTO JAMAIS SERÁ SERVIDA DUAS VEZES PARA A MESMA CONTA.
 *
 * Marca uma foto como postada por uma conta e aplica política de deleção.
 *   Se o arquivo no disco não for a mesma “geração” registrada, zera postedBy (foto foi substituída → trata como nova).
 *   Remove o registro ao excluir a foto com sucesso.
 *   Se falhar a exclusão, marca deletePending para o GC tentar depois.
 *
 * @param {string} nomeConta
 * @param {string} fileName
 * @param {string[]} workingNames
 * @param {"after_all_working_posted"|"after_first_confirmed_post"} photoDeletePolicy
 * @returns {Promise<{ok:true,deleted:boolean}|{ok:false,error:string}>}
 */
async function markPostedAndMaybeDelete(nomeConta, fileName, workingNames = [], photoDeletePolicy = 'after_all_working_posted') {
  nomeConta = canonName(nomeConta);
  workingNames = canonNames(workingNames);
  const deletePolicy = (String(photoDeletePolicy || '').trim().toLowerCase() === 'after_first_confirmed_post')
    ? 'after_first_confirmed_post'
    : 'after_all_working_posted';

  return _serialize(async () => {
    const lockFd = await acquireIndexLock();
    try {
      const dir = resolveFotosDir();
      let idx = loadIndex();

      const abs = path.join(dir, fileName);
      const exists = fs.existsSync(abs);
      const stat = exists ? (() => { try { return fs.statSync(abs); } catch { return null; } })() : null;

      let rec = idx[fileName];
      if (!rec) {
        rec = idx[fileName] = { postedBy: [], reservedBy: {} };
        if (stat) {
          try {
            await applyStatToRec(rec, stat, abs);
          } catch (e) {
            logger.warn('[FOTOS][markPostedAndMaybeDelete] Erro ao aplicar stat (novo rec)', { arquivo: abs, error: e && e.message || e });
          }
        }
      } else {
        if (stat && !sameGeneration(rec, stat, abs)) {
          rec.postedBy = [];
          rec.reservedBy = {};
          try {
            await applyStatToRec(rec, stat, abs);
          } catch (e) {
            logger.warn('[FOTOS][markPostedAndMaybeDelete] Erro ao aplicar stat (nova geração)', { arquivo: abs, error: e && e.message || e });
          }
          rec.deletePending = false;
        }
      }

      if (!Array.isArray(rec.postedBy)) rec.postedBy = [];
      if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};

      // Remove reserva (se houver) e garante postedBy (idempotente)
      if (rec.reservedBy[nomeConta]) delete rec.reservedBy[nomeConta];
      if (!rec.postedBy.map(canonName).includes(nomeConta)) rec.postedBy.push(nomeConta);

      // [item 3] Acumulação requiredFor para todas gerações
      if (!Array.isArray(rec.requiredFor)) rec.requiredFor = [];
      let rqSet = new Set(rec.requiredFor.map(canonName));
      for (const n of workingNames) rqSet.add(canonName(n));
      rec.requiredFor = Array.from(rqSet);

      const reqSet = new Set(rec.requiredFor.map(canonName));
      const postedSet = new Set(rec.postedBy.map(canonName));
      const allRequiredPosted = reqSet.size > 0 && Array.from(reqSet).every(x => postedSet.has(x));
      const shouldDeleteNow = (deletePolicy === 'after_first_confirmed_post') || allRequiredPosted;

      if (!exists) {
        delete idx[fileName];
        saveIndex(idx);
        return { ok: true, deleted: true };
      }

      if (shouldDeleteNow) {
        if (sameGeneration(rec, stat, abs)) {
          try {
            fs.unlinkSync(abs);
            delete idx[fileName];
            saveIndex(idx);
            return { ok: true, deleted: true };
          } catch (e) {
            rec.deletePending = true;
            rec.lastError = String(e && e.message || e);
            saveIndex(idx);
            logger.warn('[FOTOS][markPostedAndMaybeDelete] Falha ao remover arquivo', { arquivo: abs, error: e && e.message || e });
            return { ok: true, deleted: false };
          }
        } else {
          rec.postedBy = [];
          rec.reservedBy = {};
          try {
            await applyStatToRec(rec, stat, abs);
          } catch (e) {
            logger.warn('[FOTOS][markPostedAndMaybeDelete] Erro ao aplicar stat ao resetar geração', { arquivo: abs, error: e && e.message || e });
          }
          rec.deletePending = false;
          saveIndex(idx);
          return { ok: true, deleted: false };
        }
      }
      saveIndex(idx);
      return { ok: true, deleted: false };
    } catch (e) {
      logger.error('[FOTOS][markPostedAndMaybeDelete] Erro inesperado', { arquivo: fileName, error: e && e.message || e, stack: e && e.stack });
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}

/**
 * Varredura de limpeza (GC):
 *   Remove entradas de índice cujos arquivos sumiram.
 *   Tenta excluir arquivos marcados com deletePending (se geração ainda combinar).
 *   Se a geração mudar para uma foto nova (mesmo nome), reseta postedBy para [].
 *   Limpeza de reservas antigas (>3h)
 * @returns {Promise<{ok:true, removedIndex:number, deletedFiles:number, resetGens:number}>}
 */
async function gcSweep() {
  return _serialize(async () => {
    const lockFd = await acquireIndexLock();
    try {
      const dir = resolveFotosDir();
      let idx = loadIndex();
      let removedIndex = 0, deletedFiles = 0, resetGens = 0;
      let changed = false;

      for (const [name, rec] of Object.entries(idx)) {
        const abs = path.join(dir, name);
        const exists = fs.existsSync(abs);
        const stat = exists ? (() => { try { return fs.statSync(abs); } catch { return null; } })() : null;

        if (!exists || !stat) {
          delete idx[name];
          removedIndex++;
          changed = true;
          continue;
        }

        if (!sameGeneration(rec, stat, abs)) {
          rec.postedBy = [];
          rec.reservedBy = {};
          try {
            await applyStatToRec(rec, stat, abs);
          } catch (e) {
            logger.warn('[FOTOS][gcSweep] Erro ao aplicar stat (nova geração)', { arquivo: abs, error: e && e.message || e });
          }
          if (rec.deletePending) rec.deletePending = false;
          resetGens++;
          changed = true;
          continue;
        }

        // [item 5] Limpeza de reservas antigas (>20min)
        if (rec && rec.reservedBy) {
          for (const n of Object.keys(rec.reservedBy)) {
            if (Date.now() - rec.reservedBy[n].ts > 20 * 60 * 1000) {
              delete rec.reservedBy[n];
              changed = true;
            }
          }
        }

        if (rec.deletePending) {
          try {
            fs.unlinkSync(abs);
            delete idx[name];
            deletedFiles++;
            changed = true;
          } catch (e) {
            rec.lastError = String(e && e.message || e);
            logger.warn('[FOTOS][GC] Falha ao remover arquivo', { arquivo: abs, error: e && e.message || e });
            changed = true;
          }
        }
      }

      if (removedIndex > 0 || deletedFiles > 0 || resetGens > 0) {
        logger.info('[FOTOS][GC]', { removedIndex, deletedFiles, resetGens });
      }

      if (changed) saveIndex(idx);
      return { ok: true, removedIndex, deletedFiles, resetGens };
    } catch (e) {
      logger.error('[FOTOS][gcSweep] Erro inesperado', { error: e && e.message || e, stack: e && e.stack });
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}

/**
 * Retorna um snapshot do índice (para debug/monitoramento).
 */
async function getIndexSnapshot() {
  return _serialize(async () => {
    try {
      const idx = loadIndex();
      return { ok: true, index: idx, fotosDir: resolveFotosDir(), indexPath: INDEX_FILE };
    } catch (e) {
      logger.error('[FOTOS][getIndexSnapshot] Erro ao obter snapshot', { error: e && e.message || e, stack: e && e.stack });
      return { ok: false, error: 'internal-error' };
    }
  });
}

/**
 * Remove histórico de "postedBy" e reservas de uma conta em todo o índice.
 * Usar somente como auto-heal quando a conta ficar "sem foto" apesar de pool existir.
 *
 * @param {string} nomeConta
 * @returns {Promise<{ok:true, clearedPostedRefs:number, clearedReservations:number}>|{ok:false,error:string}>}
 */
async function clearAccountHistory(nomeConta) {
  nomeConta = canonName(nomeConta);
  if (!nomeConta) return { ok: false, error: 'invalid_account' };

  return _serialize(async () => {
    const lockFd = await acquireIndexLock();
    try {
      const dir = resolveFotosDir();
      if (!fs.existsSync(dir)) return { ok: false, error: 'fotos_dir_missing' };
      let idx = loadIndex();
      let clearedPostedRefs = 0;
      let clearedReservations = 0;
      let changed = false;

      for (const rec of Object.values(idx)) {
        if (!rec || typeof rec !== 'object') continue;
        if (rec.reservedBy && typeof rec.reservedBy === 'object' && rec.reservedBy[nomeConta]) {
          delete rec.reservedBy[nomeConta];
          clearedReservations++;
          changed = true;
        }
        if (Array.isArray(rec.postedBy) && rec.postedBy.length) {
          const before = rec.postedBy.length;
          rec.postedBy = rec.postedBy.filter(n => canonName(n) !== nomeConta);
          const after = rec.postedBy.length;
          if (after !== before) {
            clearedPostedRefs += (before - after);
            changed = true;
          }
        }
      }

      if (changed) saveIndex(idx);
      logger.warn('[FOTOS][clearAccountHistory] auto-heal executado', { conta: nomeConta, clearedPostedRefs, clearedReservations });
      return { ok: true, clearedPostedRefs, clearedReservations };
    } catch (e) {
      logger.error('[FOTOS][clearAccountHistory] Erro inesperado', { conta: nomeConta, error: e && e.message || e, stack: e && e.stack });
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}

module.exports = {
  resolveFotosDir,
  ensurePmgDirs,
  buildV3PhotoScopeChain,
  pickPhotoForAccount,
  markPostedAndMaybeDelete,
  releaseReservation,
  gcSweep,
  getIndexSnapshot,
  clearAccountHistory
};
