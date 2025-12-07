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
      client: { 
        count: 0, 
        digest: '', 
        lastTs: 0, 
        contentSig: '', 
        lastMsgSig: '',          // NOVO: fingerprint da última mensagem cliente
        recentMsgSigs: []        // NOVO: fingerprint das últimas 50 mensagens cliente
      }, 
      ia: { 
        sentSig: '', 
        queuedSig: '', 
        lastLlmSig: '',          // NOVO: fingerprint do último contentSig processado pela LLM
        lastLlmAt: 0             // NOVO: timestamp da última chamada bem-sucedida da LLM
      }, 
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
  // Garantir monotonicidade de lastLlmAt em cursor.ia
  if (prev && prev.cursor && prev.cursor.ia && prev.cursor.ia.lastLlmAt) {
    const prevLlmAt = Number(prev.cursor.ia.lastLlmAt || 0);
    if (out && out.cursor && out.cursor.ia && out.cursor.ia.lastLlmAt) {
      const nextLlmAt = Number(out.cursor.ia.lastLlmAt || 0);
      if (prevLlmAt && nextLlmAt && nextLlmAt < prevLlmAt) {
        if (!out.cursor) out.cursor = {};
        if (!out.cursor.ia) out.cursor.ia = {};
        out.cursor.ia.lastLlmAt = prevLlmAt;
      }
    }
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
    
    // MERGE robusto nos campos de fingerprint:
    let next = monotonicMerge(cur, patchObj || {});

    // TRATAMENTO ESPECIAL recentMsgSigs: concatena, remove duplicatas e limita a 50
    if (cur &&
        cur.cursor && cur.cursor.client && Array.isArray(cur.cursor.client.recentMsgSigs) &&
        next.cursor && next.cursor.client && Array.isArray(next.cursor.client.recentMsgSigs)
    ) {
      const prev = cur.cursor.client.recentMsgSigs;
      const add  = next.cursor.client.recentMsgSigs;
      const unique = Array.from(new Set([...prev, ...add])).slice(-50); // 50 mais recentes
      next.cursor.client.recentMsgSigs = unique;
    } else if (next.cursor && next.cursor.client && Array.isArray(next.cursor.client.recentMsgSigs)) {
      // Se não havia antes mas há agora, apenas remove duplicatas e limita a 50
      next.cursor.client.recentMsgSigs = Array.from(new Set(next.cursor.client.recentMsgSigs)).slice(-50);
    } else if (cur && cur.cursor && cur.cursor.client && Array.isArray(cur.cursor.client.recentMsgSigs)) {
      // Se havia antes mas não há no patch, mantém o anterior
      if (!next.cursor) next.cursor = {};
      if (!next.cursor.client) next.cursor.client = {};
      next.cursor.client.recentMsgSigs = cur.cursor.client.recentMsgSigs;
    }

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
