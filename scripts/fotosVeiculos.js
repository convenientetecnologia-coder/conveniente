// robeVeiculos.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');

const DADOS_DIR = path.join(__dirname, '..', 'dados');
const INDEX_FILE = path.join(DADOS_DIR, 'fotosveiculos_postadas.json');
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

function resolveFotosDir() {
  if (process.env.FOTOS_VEICULOS_DIR && fs.existsSync(process.env.FOTOS_VEICULOS_DIR)) {
    return process.env.FOTOS_VEICULOS_DIR;
  }
  const home = os.homedir();
  let desktopPath = path.join(home, 'Desktop');
  if (!fs.existsSync(desktopPath)) desktopPath = path.join(home, 'Área de Trabalho');
  return path.join(desktopPath, 'fotosveiculos');
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    try {
      const hash = crypto.createHash('sha256');
      const rs = fs.createReadStream(abs);
      rs.on('data', chunk => hash.update(chunk));
      rs.on('end', () => resolve(hash.digest('hex')));
      rs.on('error', reject);
    } catch (e) { reject(e); }
  });
}

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
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
    return true;
  } catch { return false; }
}
function isImageFile(name) { return /.(jpe?g|png)$/i.test(name || ''); }

let _queue = Promise.resolve();
function _serialize(fn) {
  const next = _queue.then(() => fn());
  _queue = next.catch(() => {});
  return next;
}

function ensureIndex() { if (!fs.existsSync(INDEX_FILE)) writeJsonAtomic(INDEX_FILE, {}); }
function loadIndex() {
  ensureIndex();
  const idx = readJsonSafe(INDEX_FILE, {});
  for (const k of Object.keys(idx)) {
    const v = idx[k];
    if (Array.isArray(v)) idx[k] = { postedBy: v.slice(0), reservedBy: {} };
    else if (!v || typeof v !== 'object') idx[k] = { postedBy: [], reservedBy: {} };
    else {
      if (!Array.isArray(v.postedBy)) v.postedBy = [];
      if (!v.reservedBy || typeof v.reservedBy !== 'object') v.reservedBy = {};
      if (v.size != null && typeof v.size !== 'number') delete v.size;
      if (v.mtimeMs != null && typeof v.mtimeMs !== 'number') delete v.mtimeMs;
      if (v.deletePending != null && typeof v.deletePending !== 'boolean') delete v.deletePending;
      if (v.generation != null && typeof v.generation !== 'number') delete v.generation;
    }
  }
  return idx;
}
function saveIndex(idx) { return writeJsonAtomic(INDEX_FILE, idx); }

function isDir(p) { try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }

function walkPhotos(baseDir, rel = '') {
  const absDir = path.join(baseDir, rel);
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { entries = []; }
  for (const ent of entries) {
    const name = ent.name;
    const relPath = rel ? path.join(rel, name) : name;
    const absPath = path.join(baseDir, relPath);
    if (ent.isDirectory()) {
      // Evita varrer diretórios ocultos
      if (!/^\./.test(name)) {
        out.push(...walkPhotos(baseDir, relPath));
      }
      continue;
    }
    if (!isImageFile(name)) continue;
    let st = null;
    try { st = fs.statSync(absPath); } catch { st = null; }
    if (!st) continue;
    const model = (relPath.includes(path.sep) ? relPath.split(path.sep)[0] : null) || null;
    out.push({ rel: relPath.replace(/\\/g,'/'), abs: absPath, stat: st, model });
  }
  return out;
}

function listAllPhotosSortedByMtimeAsc() {
  const dir = resolveFotosDir();
  if (!fs.existsSync(dir)) return [];
  const items = walkPhotos(dir, '');
  items.sort((a, b) => (a.stat.mtimeMs || 0) - (b.stat.mtimeMs || 0));
  return items;
}
async function applyStatToRec(rec, stat, absPath) {
  rec.size = stat.size;
  rec.mtimeMs = stat.mtimeMs;
  if (typeof rec.generation !== 'number') rec.generation = 1;
  try { rec.sha256 = await sha256File(absPath || ''); } catch (e) {
    logger.warn('[FOTOSV][applyStatToRec] sha256 fail', { arquivo: absPath, error: e && e.message || e });
  }
}
function sameGeneration(rec, stat, absPath) {
  if (!rec || !stat) return false;
  try {
    if (rec.sha256 && absPath && fs.existsSync(absPath)) {
      const cur = require('crypto').createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      return rec.sha256 === cur;
    }
  } catch {}
  if (typeof rec.size !== 'number' || typeof rec.mtimeMs !== 'number') return false;
  return rec.size === stat.size && rec.mtimeMs === stat.mtimeMs;
}

async function pickPhotoForAccount(nomeConta, workingNames = []) {
  nomeConta = canonName(nomeConta);
  workingNames = canonNames(workingNames);
  return _serialize(async () => {
    const lockFd = await acquireIndexLock();
    try {
      const dir = resolveFotosDir();
      if (!fs.existsSync(dir)) return { ok: false, error: 'fotos_dir_missing' };
      let idx = loadIndex();
      // 1) Reserva já existente para esta conta (respeita reserva anterior)
      for (const [k, rec] of Object.entries(idx)) {
        if (rec && rec.reservedBy && rec.reservedBy[nomeConta]) {
          const abs = path.join(dir, k);
          if (fs.existsSync(abs)) {
            const model = k.includes('/') ? k.split('/')[0] : null;
            return { ok: true, file: k, absPath: abs, model };
          }
          delete rec.reservedBy[nomeConta];
          saveIndex(idx);
        }
      }
      // 2) Lista completa (com rel e model)
      const all = listAllPhotosSortedByMtimeAsc();
      // Ajuste/atualização do índice (sha256, geração)
      let changed = false;
      for (const it of all) {
        const { rel, abs, stat } = it;
        let rec = idx[rel];
        if (!rec) {
          rec = idx[rel] = { postedBy: [], reservedBy: {} };
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
        if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};
      }
      if (changed) saveIndex(idx);
      // 3) Determina "modelos disponíveis para esta conta" (há pelo menos 1 foto não postada/reservada)
      const byModel = new Map();
      for (const it of all) {
        const rec = idx[it.rel];
        const postedBySet = new Set((rec && Array.isArray(rec.postedBy) ? rec.postedBy : []).map(canonName));
        const reservedCount = rec && rec.reservedBy ? Object.keys(rec.reservedBy).length : 0;
        if (postedBySet.has(nomeConta)) continue;
        if (reservedCount > 0) continue;
        const model = it.model || null;
        if (!model) continue; // ignorar fotos na raiz sem modelo
        if (!byModel.has(model)) byModel.set(model, []);
        byModel.get(model).push(it);
      }
      const allAvailableModels = Array.from(byModel.keys()).sort((a,b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
      // 4) Lê ciclo (manifest.veiculosCiclo.postados) e aplica rotação
      let postedSet = new Set();
      try {
        const man = await manifestStore.read(nomeConta).catch(() => null);
        if (man && man.veiculosCiclo && Array.isArray(man.veiculosCiclo.postados)) {
          postedSet = new Set(man.veiculosCiclo.postados.map(s => String(s || '').toLowerCase()));
        }
      } catch {}
      // Limpa modelos do ciclo que não existem mais
      postedSet = new Set(Array.from(postedSet).filter(m => allAvailableModels.includes(m)));
      // Modelos restantes no ciclo atual
      const modelsLeft = allAvailableModels.filter(m => !postedSet.has(m));
      // Se nenhum modelo restou (ciclo completo ou sem disponibilidade), reseta o ciclo e usa todos novamente
      const targetModels = (modelsLeft.length > 0 ? modelsLeft : allAvailableModels);
      // 5) Escolhe foto do primeiro modelo disponível no alvo
      for (const model of targetModels) {
        const candidates = (byModel.get(model) || []);
        for (const it of candidates) {
          const rec = idx[it.rel];
          const postedBySet = new Set((rec && Array.isArray(rec.postedBy) ? rec.postedBy : []).map(canonName));
          if (postedBySet.has(nomeConta)) continue;
          if (rec && rec.reservedBy && Object.keys(rec.reservedBy).length > 0) continue;
          // Reserva e marca esta conta como postada (mantém a política de nunca duplicar por conta)
          rec.reservedBy[nomeConta] = { ts: Date.now() };
          if (!postedBySet.has(nomeConta)) rec.postedBy.push(nomeConta);
          saveIndex(idx);
          return { ok: true, file: it.rel, absPath: it.abs, model };
        }
      }
      // 6) Fallback: se nada disponível por modelo, tenta qualquer remanescente (com/sem pasta)
      for (const it of all) {
        const rec = idx[it.rel];
        const postedBySet = new Set((rec && Array.isArray(rec.postedBy) ? rec.postedBy : []).map(canonName));
        if (postedBySet.has(nomeConta)) continue;
        if (rec && rec.reservedBy && Object.keys(rec.reservedBy).length > 0) continue;
        rec.reservedBy[nomeConta] = { ts: Date.now() };
        if (!postedBySet.has(nomeConta)) rec.postedBy.push(nomeConta);
        saveIndex(idx);
        const model = it.model || null;
        return { ok: true, file: it.rel, absPath: it.abs, model };
      }
      // Limpeza de índices para arquivos ausentes
      let removed = false;
      for (const key of Object.keys(idx)) {
        const abs = path.join(dir, key);
        if (!fs.existsSync(abs)) { delete idx[key]; removed = true; }
      }
      if (removed) saveIndex(idx);
      return { ok: false, error: 'no-photo-available' };
    } catch (e) {
      logger.error('[FOTOSV][pick] unexpected', { error: e && e.message || e });
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}
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
    } catch {
      return { ok: true };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}
async function markPostedAndMaybeDelete(nomeConta, fileName, workingNames = []) {
  nomeConta = canonName(nomeConta);
  workingNames = canonNames(workingNames);
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
      if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};
      if (rec.reservedBy[nomeConta]) delete rec.reservedBy[nomeConta];
      if (!rec.postedBy.map(canonName).includes(nomeConta)) rec.postedBy.push(nomeConta);
      if (!Array.isArray(rec.requiredFor)) rec.requiredFor = [];
      const rqSet = new Set(rec.requiredFor.map(canonName));
      for (const n of workingNames) rqSet.add(canonName(n));
      rec.requiredFor = Array.from(rqSet);

      if (!exists) {
        delete idx[fileName];
        saveIndex(idx);
        return { ok: true, deleted: true };
      }
      const reqSet = new Set(rec.requiredFor.map(canonName));
      const postedSet = new Set(rec.postedBy.map(canonName));
      const allRequiredPosted = reqSet.size > 0 && Array.from(reqSet).every(x => postedSet.has(x));
      if (allRequiredPosted) {
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
    } catch (e) {
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}
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
        if (!exists || !stat) { delete idx[name]; removedIndex++; changed = true; continue; }
        if (!rec || typeof rec !== 'object') { delete idx[name]; removedIndex++; changed = true; continue; }
        if (!rec.postedBy || !Array.isArray(rec.postedBy)) rec.postedBy = [];
        if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};
        if (!sameGeneration(rec, stat, abs)) {
          rec.postedBy = [];
          rec.reservedBy = {};
          await applyStatToRec(rec, stat, abs);
          if (rec.deletePending) rec.deletePending = false;
          resetGens++;
          changed = true;
          continue;
        }
        if (rec.reservedBy) {
          for (const n of Object.keys(rec.reservedBy)) {
            if (Date.now() - rec.reservedBy[n].ts > 20 * 60 * 1000) { delete rec.reservedBy[n]; changed = true; }
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
            changed = true;
          }
        }
      }
      if (changed) saveIndex(idx);
      return { ok: true, removedIndex, deletedFiles, resetGens };
    } catch (e) {
      return { ok: false, error: 'internal-error' };
    } finally {
      releaseIndexLock(lockFd);
    }
  });
}
async function getIndexSnapshot() {
  return _serialize(async () => {
    try {
      const idx = loadIndex();
      return { ok: true, index: idx, fotosDir: resolveFotosDir(), indexPath: INDEX_FILE };
    } catch (e) {
      return { ok: false, error: 'internal-error' };
    }
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