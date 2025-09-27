// manifestStore.js
// ATENÇÃO: Toda gravação/mutação em manifest.json (qualquer perfil) DEVE ser feita exclusivamente via manifestStore.update(nome, fnPatch), que já provê lock serializado.
// É PROIBIDO qualquer write/disco a manifest.json por fora deste módulo!

'use strict';

const fs = require('fs');
const path = require('path');

const locks = new Map();

/** Resolve o caminho absoluto do manifest.json de um perfil (por slug/nome). */
function getManifestPath(nome) {
  // Lê perfis.json diretamente para resolver o caminho do manifest
  const perfisPath = path.join(__dirname, '..', 'dados', 'perfis.json');
  const arr = readJsonSafe(perfisPath, []);
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
// TODO/FUTURE: Aqui pode-se limitar (por perfil) o número de jobs/Promises simultâneos na fila, caso sobrecarga percebida
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

// Só use read/write/update deste módulo para trabalhar com manifest.json em workers, apis ou scripts! Não acesse nem escreva o arquivo direto!
module.exports = { getManifestPath, read, write, update };