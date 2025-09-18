// scripts/fotos.js
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

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

// ------------------------ Utils atômicos ------------------------
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
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
  for (const k of Object.keys(idx)) {
    const v = idx[k];
    if (Array.isArray(v)) {
      idx[k] = { postedBy: v.slice(0) };
    } else if (!v || typeof v !== 'object') {
      idx[k] = { postedBy: [] };
    } else {
      if (!Array.isArray(v.postedBy)) v.postedBy = [];
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

// Verifica se o arquivo atual parece ser a mesma “geração” que registramos
function sameGeneration(rec, stat) {
  if (!rec || !stat) return false;
  if (typeof rec.size !== 'number' || typeof rec.mtimeMs !== 'number') return false;
  // Exige match exato; se mudou mtimeMs ou size, consideramos “outra geração”
  return rec.size === stat.size && rec.mtimeMs === stat.mtimeMs;
}

// Atualiza metadados de stat do registro
function applyStatToRec(rec, stat) {
  rec.size = stat.size;
  rec.mtimeMs = stat.mtimeMs;
  if (typeof rec.generation !== 'number') rec.generation = 1;
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
        rec = idx[name] = { postedBy: [], size: stat.size, mtimeMs: stat.mtimeMs, generation: 1 };
        changed = true;
      } else {
        // Se arquivo atual não bate com a geração registrada → trata como nova foto
        if (!sameGeneration(rec, stat)) {
          rec.postedBy = [];
          applyStatToRec(rec, stat);
          rec.deletePending = false;
          changed = true;
        }
      }

      // Se esta conta já usou, pula para próxima
      if (rec.postedBy.includes(nomeConta)) continue;

      // Foto disponível para esta conta
      if (changed) saveIndex(idx);
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
      // Se foto não estava no índice ainda, cria registro
      rec = idx[fileName] = { postedBy: [] };
      if (stat) applyStatToRec(rec, stat);
    } else {
      // Se houver stat registrado e o arquivo mudou, trata como nova geração
      if (stat && !sameGeneration(rec, stat)) {
        rec.postedBy = [];
        applyStatToRec(rec, stat);
        rec.deletePending = false;
      }
    }

    // Garante postedBy
    if (!Array.isArray(rec.postedBy)) rec.postedBy = [];

    // Marca esta conta, se ainda não constar
    if (!rec.postedBy.includes(nomeConta)) {
      rec.postedBy.push(nomeConta);
    }

    // Critério de exclusão: se TODAS as workingNames constam em postedBy
    const workingSet = new Set((workingNames || []).filter(Boolean));
    const allWorkedPosted = workingSet.size > 0
      ? [...workingSet].every(n => rec.postedBy.includes(n))
      : false;

    // Se não tiver arquivo físico, apenas limpa o índice
    if (!exists) {
      delete idx[fileName];
      saveIndex(idx);
      return { ok: true, deleted: true };
    }

    if (allWorkedPosted) {
      // Confirma que vamos excluir a MESMA geração
      if (sameGeneration(rec, stat)) {
        try {
          fs.unlinkSync(abs); // exclusão definitiva (não vai para Lixeira)
          delete idx[fileName];
          saveIndex(idx);
          return { ok: true, deleted: true };
        } catch (e) {
          // marca como pendente para GC
          rec.deletePending = true;
          rec.lastError = String(e && e.message || e);
          saveIndex(idx);
          return { ok: true, deleted: false };
        }
      } else {
        // Geração mudou (arquivo substituído) → trata como nova
        rec.postedBy = [];
        applyStatToRec(rec, stat);
        rec.deletePending = false;
        saveIndex(idx);
        return { ok: true, deleted: false };
      }
    }

    // Ainda não pode excluir
    saveIndex(idx);
    return { ok: true, deleted: false };
  });
}

/**
 * Varredura de limpeza (GC):
 *   Remove entradas de índice cujos arquivos sumiram.
 *   Tenta excluir arquivos marcados com deletePending (se geração ainda combinar).
 *   Se a geração mudar para uma foto nova (mesmo nome), reseta postedBy para [].
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
      if (!sameGeneration(rec, stat)) {
        rec.postedBy = [];
        applyStatToRec(rec, stat);
        if (rec.deletePending) rec.deletePending = false;
        resetGens++;
        changed = true;
        continue;
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
  gcSweep,
  getIndexSnapshot
};