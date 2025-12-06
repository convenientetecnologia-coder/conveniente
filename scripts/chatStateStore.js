'use strict';

const fs = require('fs');
const path = require('path');
const { acquireFileLock, releaseFileLock } = require('./manifestStore.js');
const stepLog = require('./stepLog.js');
const audit = stepLog.audit;

function ensureDir(p){ try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function stateFile(perfil, chatId){
  const d = path.join(__dirname, '..', 'dados', 'perfis', String(perfil||'default'), 'chats');
  ensureDir(d);
  return path.join(d, `${chatId}.state.json`);
}

function readSafe(file, fb){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }

function writeAtomicNoLock(file, obj) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  const fdw = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fdw, JSON.stringify(obj || {}, null, 2), 'utf8');
    fs.fsyncSync(fdw);
  } finally { fs.closeSync(fdw); }
  try { fs.unlinkSync(file); } catch {}
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch {}
  return true;
}

function initState() {
  return { 
    // Somente campos essenciais ao ciclo minimalista:
    cursor: {
      client: { count: 0, digest: '', lastTs: 0, contentSig: '' }, 
      ia: { sentSig: '', queuedSig: '' }, 
      feed: {}
    },
    data: {},        // Só dados essenciais para Última extração, lastClientNorm/lastClientTs/etc
    finalization: {}  // Finalização de atendimento (campo backend)
    // CAMPO 'schedule', 'freeze' não mais escritos no initState - mantidos apenas em estados legados para compatibilidade
  };
}

function deepMerge(a, b) {
  if (!b || typeof b !== 'object') return a;
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
      a[k] = deepMerge(a[k] || {}, b[k]);
    } else {
      a[k] = b[k];
    }
  }
  return a;
}

function monotonicMerge(prev, next) {
  // Garante que timestamps não retrocedam
  const out = deepMerge({ ...prev }, next || {});
  const keys = ['lastScanAt', 'lastIARespondedAt', 'discoveredAt', 'chatLogLastTs'];
  for (const k of keys) {
    const p = Number(prev && prev[k] || 0);
    const n = Number(out && out[k] || 0);
    if (p && n && n < p) out[k] = p;
  }
  return out;
}

function get(perfil, chatId){
  audit(perfil, 'virtus', 'debug', 'state_get_start', { chatId });
  const file = stateFile(perfil, chatId);
  const lockPath = file + '.lck';
  let fd = null;
  try {
    fd = acquireFileLock(lockPath);
    let s = readSafe(file, null);
    const existed = !!s;
    if (!s) {
      s = initState();
      writeAtomicNoLock(file, s);
      audit(perfil, 'virtus', 'info', 'state_get_init', { chatId });
    }
    audit(perfil, 'virtus', 'info', 'state_get_end', { chatId, exists: existed });
    return s;
  } catch (e) {
    audit(perfil, 'virtus', 'error', 'state_get_err', { chatId, error: (e && e.message) || String(e) });
    throw e;
  } finally {
    try { releaseFileLock(lockPath, fd); } catch {}
  }
}

function patch(perfil, chatId, patchObj){
  audit(perfil, 'virtus', 'debug', 'state_patch_start', { chatId, patchKeys: Object.keys(patchObj || {}) });
  const file = stateFile(perfil, chatId);
  const lockPath = file + '.lck';
  let fd = null;
  try {
    fd = acquireFileLock(lockPath);
    let cur = readSafe(file, null);
    if (!cur) cur = initState();
    let next = monotonicMerge(cur, patchObj || {});
    writeAtomicNoLock(file, next);
    audit(perfil, 'virtus', 'info', 'state_patch_end', { chatId });
    return next;
  } catch (e) {
    audit(perfil, 'virtus', 'error', 'state_patch_err', { chatId, error: (e && e.message) || String(e) });
    throw e;
  } finally {
    try { releaseFileLock(lockPath, fd); } catch {}
  }
}

module.exports = { get, patch };
