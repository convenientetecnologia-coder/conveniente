// chatStateStore.js

'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(p){ try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function stateFile(perfil, chatId){
  const d = path.join(__dirname, '..', 'dados', 'perfis', String(perfil||'default'), 'chats');
  ensureDir(d);
  return path.join(d, `${chatId}.state.json`);
}

function readSafe(file, fb){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }

function writeAtomic(file, obj){
  try {
    ensureDir(path.dirname(file));
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(obj || {}, null, 2),'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch { fs.copyFileSync(tmp, file); try{fs.unlinkSync(tmp);}catch{} }
    return true;
  } catch { return false; }
}

function get(perfil, chatId){
  const file = stateFile(perfil, chatId);
  const s = readSafe(file, null);
  if (s) return s;
  const init = { cursor:{ client:{ count:0, digest:'', lastTs:0 }, ia:{ sentSig:'' } }, freeze:{}, schedule:{}, data:{}, finalization:{} };
  writeAtomic(file, init);
  return init;
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

function patch(perfil, chatId, patchObj){
  const file = stateFile(perfil, chatId);
  const cur = get(perfil, chatId);
  const next = deepMerge({ ...cur }, patchObj || {});
  writeAtomic(file, next);
  return next;
}

module.exports = { get, patch };
