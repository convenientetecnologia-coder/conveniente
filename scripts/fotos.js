// scripts/fotos.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto'); // <--- ADICIONADO

// ------------------------ Configs e caminhos ------------------------
const DADOS_DIR = path.join(__dirname, '..', 'dados');
const INDEX_FILE = path.join(DADOS_DIR, 'fotos_postadas.json');

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
  return idx;
}
function saveIndex(idx) {
  return writeJsonAtomic(INDEX_FILE, idx);
}

// ------------------------ Leitura de fotos do diretório ------------------------
function listAllPhotosSortedByMtimeAsc() {
  const dir = resolveFotosDir();
  if (!fs.existsSync(dir)) return [];
  const list = fs.readdirSync(dir).filter(isImageFile);
  const enriched = list.map(name => {
    const abs = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    return { name, abs, stat: st };
  }).filter(x => !!x.stat);
  enriched.sort((a, b) => (a.stat.mtimeMs || 0) - (b.stat.mtimeMs || 0));
  return enriched;
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
  } catch {}
}

// Verifica se o arquivo atual parece ser a mesma “geração” que registramos (preferencialmente por hash)
function sameGeneration(rec, stat, absPath) {
  if (!rec || !stat) return false;
  if (rec.sha256 && absPath) {
    try { return rec.sha256 === fs.existsSync(absPath) ? require('crypto').createHash('sha256').update(fs.readFileSync(absPath)).digest('hex') : ''; }
    catch { return false; } // Se erro, treat as not the same
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
 * @param {string} nomeConta
 * @param {string[]} workingNames - lista atual de contas trabalhando (para futuros critérios; aqui não é obrigatório)
 * @returns {Promise<{ok:true,file:string,absPath:string}|{ok:false,error:string}>}
 */
async function pickPhotoForAccount(nomeConta, workingNames = []) {
  return _serialize(async () => {
    const dir = resolveFotosDir();
    if (!fs.existsSync(dir)) return { ok: false, error: 'fotos_dir_missing' };
    let idx = loadIndex();

    const all = listAllPhotosSortedByMtimeAsc();
    let changed = false;

    for (const item of all) {
      const { name, abs, stat } = item;
      let rec = idx[name];

      if (!rec) {
        rec = idx[name] = { postedBy: [], reservedBy: {} };
        await applyStatToRec(rec, stat, abs);
        changed = true;
      } else {
        if (!sameGeneration(rec, stat, abs)) {
          rec.postedBy = [];
          rec.reservedBy = {};
          await applyStatToRec(rec, stat, abs);
          rec.deletePending = false;
          changed = true;
        }
      }

      if (!Array.isArray(rec.postedBy)) rec.postedBy = [];
      if (!rec.reservedBy) rec.reservedBy = {};

      // --- PASSO 2: Pular obrigatoriamente fotos já tentadas ---
      // Se já postou (tentou) para esta conta, nunca retorna de novo
      if (rec.postedBy.includes(nomeConta)) continue;

      // Se já reservado por esta conta, continue servindo esta foto
      if (rec.reservedBy[nomeConta]) {
        return { ok: true, file: name, absPath: abs };
      }

      // Se reservado por outra conta, pule
      if (Object.keys(rec.reservedBy).length > 0) continue;

      // Reserva agora para esta conta e flusha
      rec.reservedBy[nomeConta] = { ts: Date.now() };
      saveIndex(idx);
      return { ok: true, file: name, absPath: abs };
    }

    // Limpa entradas do índice que não existem mais no disco
    let removed = false;
    for (const key of Object.keys(idx)) {
      const abs = path.join(dir, key);
      if (!fs.existsSync(abs)) {
        delete idx[key];
        removed = true;
      }
    }
    if (removed || changed) saveIndex(idx);

    return { ok: false, error: 'no-photo-available' };
  });
}

/**
 * Libera a reserva de uma conta específica para um arquivo, caso haja erro ou abandono.
 * @param {string} nomeConta
 * @param {string} fileName
 * @returns {Promise<{ok:true}>}
 */
async function releaseReservation(nomeConta, fileName) {
  return _serialize(async () => {
    let idx = loadIndex();
    const rec = idx[fileName];
    if (rec && rec.reservedBy && rec.reservedBy[nomeConta]) {
      delete rec.reservedBy[nomeConta];
      saveIndex(idx);
    }
    return { ok: true };
  });
}

/**
 * ATENÇÃO: ESTA FUNÇÃO DEVE SER CHAMADA APÓS TODA TENTATIVA DE POSTAGEM, INDEPENDENTE DE SUCESSO OU FALHA. 
 * ELA GARANTE QUE A FOTO JAMAIS SERÁ SERVIDA DUAS VEZES PARA A MESMA CONTA.
 *
 * Marca uma foto como postada por uma conta e tenta excluir se TODAS workingNames já postaram.
 *   Se o arquivo no disco não for a mesma “geração” registrada, zera postedBy (foto foi substituída → trata como nova).
 *   Remove o registro ao excluir a foto com sucesso.
 *   Se falhar a exclusão, marca deletePending para o GC tentar depois.
 *
 * @param {string} nomeConta
 * @param {string} fileName
 * @param {string[]} workingNames
 * @returns {Promise<{ok:true,deleted:boolean}|{ok:false,error:string}>}
 */
async function markPostedAndMaybeDelete(nomeConta, fileName, workingNames = []) {
  return _serialize(async () => {
    const dir = resolveFotosDir();
    let idx = loadIndex();

    const abs = path.join(dir, fileName);
    const exists = fs.existsSync(abs);
    const stat = exists ? (() => { try { return fs.statSync(abs); } catch { return null; } })() : null;

    let rec = idx[fileName];
    if (!rec) {
      rec = idx[fileName] = { postedBy: [], reservedBy: {} };
      if (stat) await applyStatToRec(rec, stat, abs);
    } else {
      if (stat && !sameGeneration(rec, stat, abs)) {
        rec.postedBy = [];
        rec.reservedBy = {};
        await applyStatToRec(rec, stat, abs);
        rec.deletePending = false;
      }
    }

    if (!Array.isArray(rec.postedBy)) rec.postedBy = [];
    if (!rec.reservedBy) rec.reservedBy = {};

    // --- PASSO 3: SEMPRE adicione ao postedBy, MESMO EM ERRO ---
    // Remove reserva se houver
    if (rec.reservedBy && rec.reservedBy[nomeConta]) delete rec.reservedBy[nomeConta];
    // GARANTIA DE MARCAÇÃO
    if (!rec.postedBy.includes(nomeConta)) rec.postedBy.push(nomeConta);

    // Critério de exclusão: workingNames
    const workingSet = new Set((workingNames || []).filter(Boolean));
    const allWorkedPosted = workingSet.size > 0
      ? [...workingSet].every(n => rec.postedBy.includes(n))
      : false;

    if (!exists) {
      delete idx[fileName];
      saveIndex(idx);
      return { ok: true, deleted: true };
    }

    if (allWorkedPosted) {
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
          return { ok: true, deleted: false };
        }
      } else {
        rec.postedBy = [];
        rec.reservedBy = {};
        await applyStatToRec(rec, stat, abs);
        rec.deletePending = false;
        saveIndex(idx);
        return { ok: true, deleted: false };
      }
    }
    saveIndex(idx);
    return { ok: true, deleted: false };
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
    const dir = resolveFotosDir();
    let idx = loadIndex();
    let removedIndex = 0, deletedFiles = 0, resetGens = 0;
    let changed = false;

    for (const [name, rec] of Object.entries(idx)) {
      const abs = path.join(dir, name);
      const exists = fs.existsSync(abs);
      const stat = exists ? (() => { try { return fs.statSync(abs); } catch { return null; } })() : null;

      if (!exists || !stat) {
        // arquivo não existe -> remove índice
        delete idx[name];
        removedIndex++;
        changed = true;
        continue;
      }

      // Se a geração mudou (arquivo novo com o mesmo nome) → trata como nova
      if (!sameGeneration(rec, stat, abs)) {
        rec.postedBy = [];
        rec.reservedBy = {};
        await applyStatToRec(rec, stat, abs);
        if (rec.deletePending) rec.deletePending = false;
        resetGens++;
        changed = true;
        continue;
      }

      // Limpeza de reservas antigas (TTL 3h)
      if (rec && rec.reservedBy) {
        for (const n of Object.keys(rec.reservedBy)) {
          if (Date.now() - rec.reservedBy[n].ts > 3*3600*1000) {
            delete rec.reservedBy[n];
            changed = true;
          }
        }
      }

      // Tenta remover os pendentes
      if (rec.deletePending) {
        try {
          fs.unlinkSync(abs);
          delete idx[name];
          deletedFiles++;
          changed = true;
        } catch (e) {
          // mantém pendente; GC tentará depois
          rec.lastError = String(e && e.message || e);
          changed = true;
        }
      }
    }

    if (changed) saveIndex(idx);
    return { ok: true, removedIndex, deletedFiles, resetGens };
  });
}

/**
 * Retorna um snapshot do índice (para debug/monitoramento).
 */
async function getIndexSnapshot() {
  return _serialize(async () => {
    const idx = loadIndex();
    return { ok: true, index: idx, fotosDir: resolveFotosDir(), indexPath: INDEX_FILE };
  });
}

module.exports = {
  resolveFotosDir,
  pickPhotoForAccount,
  markPostedAndMaybeDelete,
  releaseReservation,
  gcSweep,
  getIndexSnapshot
};