// scripts/manifestStore.js

'use strict';

const fs = require('fs');
const path = require('path');
const fileStore = require('./fileStore.js'); // Para loadPerfisJson etc.

const locks = new Map();

/** Resolve o caminho absoluto do manifest.json de um perfil (por slug/nome). */
function getManifestPath(nome) {
  const arr = fileStore.loadPerfisJson();
  const p = arr.find(x => x && x.nome === nome);
  if (!p || !p.userDataDir) throw new Error('userDataDir não encontrado: ' + nome);
  return path.join(p.userDataDir, 'manifest.json');
}

/** Leitura de JSON com fallback robusto. */
function readJsonSafe(file, fb) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fb; }
}

/** Escrita de JSON atômica, sempre com write + rename para segurança. */
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try { fs.unlinkSync(file); } catch {}
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp);} catch {} }
}

/** Lock atômico simples por perfil para serialização de IO/disco. */
function withLock(nome, fn) {
  const prev = locks.get(nome) || Promise.resolve();
  const job = prev.then(() => Promise.resolve(fn()).catch(()=>{}));
  locks.set(nome, job);
  return job;
}

/** Leitura atômica sob lock (pode ser usado sem lock, mas sempre lock em update!). */
async function read(nome) {
  const file = getManifestPath(nome);
  return readJsonSafe(file, null);
}

/** Escrita atômica sob lock. */
async function write(nome, man) {
  return withLock(nome, async () => {
    const file = getManifestPath(nome);
    writeJsonAtomic(file, man);
    return true;
  });
}

/** Update mutável atômico: fn recebe o objeto, patcha e retorna objeto novo (promise ou sync). */
async function update(nome, patchFn) {
  return withLock(nome, async () => {
    const file = getManifestPath(nome);
    const cur = readJsonSafe(file, {}) || {};
    const next = await Promise.resolve(patchFn(cur)) || cur;
    writeJsonAtomic(file, next);
    return next;
  });
}

module.exports = { getManifestPath, read, write, update };