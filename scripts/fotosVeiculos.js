// robeVeiculos.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('./logger.js');

const DADOS_DIR = path.join(__dirname, '..', 'dados');
const INDEX_FILE = path.join(DADOS_DIR, 'fotosveiculos_postadas.json');
const INDEX_LOCK_FILE = INDEX_FILE + '.lock';

async function acquireIndexLock(retries = 200, delayMs = 15) {
  for (let i = 0; i < retries; i++) {
    try {
      if (fs.existsSync(INDEX_LOCK_FILE)) {
        try {
          const st = fs.statSync(INDEX_LOCK_FILE);
          if (Date.now() - st.mtimeMs > 60 * 1000) fs.unlinkSync(INDEX_LOCK_FILE);
        } catch {}
      }
      const fd = fs.openSync(INDEX_LOCK_FILE, 'wx');
      return fd;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
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
      // idempotência: se reservado por esta conta, sirva a mesma
      for (const [k, rec] of Object.entries(idx)) {
        if (rec && rec.reservedBy && rec.reservedBy[nomeConta]) {
          const abs = path.join(dir, k);
          if (fs.existsSync(abs)) return { ok: true, file: k, absPath: abs };
          delete rec.reservedBy[nomeConta];
          saveIndex(idx);
        }
      }
      const all = listAllPhotosSortedByMtimeAsc();
      for (const it of all) {
        const { name, abs, stat } = it;
        let rec = idx[name];
        if (!rec) {
          rec = idx[name] = { postedBy: [], reservedBy: {} };
          await applyStatToRec(rec, stat, abs);
        } else {
          if (!sameGeneration(rec, stat, abs)) {
            rec.postedBy = [];
            rec.reservedBy = {};
            await applyStatToRec(rec, stat, abs);
            rec.deletePending = false;
          }
        }
        if (!Array.isArray(rec.postedBy)) rec.postedBy = [];
        if (!rec.reservedBy || typeof rec.reservedBy !== 'object') rec.reservedBy = {};
        if (rec.reservedBy[nomeConta]) return { ok: true, file: name, absPath: abs };
        if (rec.postedBy.map(canonName).includes(nomeConta)) continue;
        if (Object.keys(rec.reservedBy).length) continue;
        // reserva + postedBy
        rec.reservedBy[nomeConta] = { ts: Date.now() };
        if (!rec.postedBy.map(canonName).includes(nomeConta)) rec.postedBy.push(nomeConta);
        saveIndex(idx);
        return { ok: true, file: name, absPath: abs };
      }
      // limpa arquivos que sumiram
      let changed = false;
      for (const k of Object.keys(idx)) {
        if (!fs.existsSync(path.join(dir, k))) { delete idx[k]; changed = true; }
      }
      if (changed) saveIndex(idx);
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