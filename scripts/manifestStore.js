// manifestStore.js
// ATENÇÃO: Toda gravação/mutação em manifest.json (qualquer perfil) DEVE ser feita exclusivamente via manifestStore.update(nome, fnPatch), que já provê lock serializado.
// É PROIBIDO qualquer write/disco a manifest.json por fora deste módulo!
// 
// IMPORTANTE: NENHUM código deve gravar em manifest.json sem explicitamente usar o lock com acquireFileLock/releaseFileLock.
// O lock físico (manifest.json.lck) garante exclusão mútua inter-process.

'use strict';

const fs = require('fs');
const path = require('path');

const locks = new Map();

/** Espera não bloqueante (promise-based). */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Adquire lock de arquivo físico (cross-process).
 * Tenta abrir o arquivo lockPath em modo 'wx' (exclusive), retry/backoff caso já exista.
 * @param {string} lockPath - Caminho do arquivo de lock (.lck)
 * @param {number} maxRetries - Número máximo de tentativas (padrão 300 = 5s com delay de 15ms)
 * @param {number} delay - Delay entre tentativas em ms (padrão 15ms)
 * @returns {number} File descriptor do lock adquirido
 * @throws {Error} Se timeout após maxRetries tentativas
 */
function acquireFileLock(lockPath, maxRetries = 300, delay = 15) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      return fd;
    } catch (e) {
      if (i === maxRetries - 1) throw new Error('file_lock_timeout:' + lockPath);
      // Cross-process sleep usando Atomics.wait
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  throw new Error('file_lock_timeout:' + lockPath);
}

/**
 * Libera lock de arquivo físico (cross-process).
 * Fecha o file descriptor e remove o arquivo de lock.
 * @param {string} lockPath - Caminho do arquivo de lock (.lck)
 * @param {number} fd - File descriptor retornado por acquireFileLock
 */
function releaseFileLock(lockPath, fd) {
  try { if (typeof fd === 'number') fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(lockPath); } catch {}
}

/** Resolve o caminho absoluto do manifest.json de um perfil (por slug/nome). */
function getManifestPath(nome) {
  // Lê perfis.json diretamente para resolver o caminho do manifest
  const perfisPath = path.join(__dirname, '..', 'dados', 'perfis.json');
  const arr = readJsonSafe(perfisPath, []);
  const p = arr.find(x => x && x.nome === nome);
  if (!p || !p.userDataDir) throw new Error('userDataDir não encontrado: ' + nome);
  return path.join(p.userDataDir, 'manifest.json');
}

/** Resolve o caminho do arquivo de lock para um manifest.json. */
function getLockPath(manifestPath) {
  return manifestPath + '.lck';
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
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
    fs.fsyncSync(fd); // Sempre garante flush militar
  } finally {
    fs.closeSync(fd);
  }
  try { fs.unlinkSync(file); } catch {}
  try { fs.renameSync(tmp, file); }
  catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp);} catch {} }
}

/** Lock atômico simples por perfil para serialização de IO/disco (IN-PROCESSO). */
// TODO/FUTURE: Aqui pode-se limitar (por perfil) o número de jobs/Promises simultâneos na fila, caso sobrecarga percebida
// NOTA: withLock funciona como fila/serialização IN-PROCESSO (único processo). O fileLock físico garante exclusão inter-processo/disco.
function withLock(nome, fn) {
  const prev = locks.get(nome) || Promise.resolve();
  const job = prev.then(() => Promise.resolve(fn()).catch(()=>{}))
                  .finally(() => { if (locks.get(nome) === job) locks.delete(nome); });
  locks.set(nome, job);
  return job;
}

/** Leitura atômica/retry tolerante para manifest.json com lock físico. */
async function read(nome) {
  return withLock(nome, async () => {
    const file = getManifestPath(nome);
    const lockPath = getLockPath(file);
    let fd = null;
    try {
      // Adquire lock físico antes de ler
      fd = acquireFileLock(lockPath);
      
      // Tolerante a janela de rename: 5 tentativas com backoff (20ms)
      for (let i = 0; i < 5; i++) {
        try {
          if (fs.existsSync(file)) {
            const data = fs.readFileSync(file, 'utf8');
            return JSON.parse(data);
          }
          // fallback: tente ler o .tmp se existe (escrita atômica em progresso)
          const tmp = file + '.tmp';
          if (fs.existsSync(tmp)) {
            const data = fs.readFileSync(tmp, 'utf8');
            return JSON.parse(data);
          }
        } catch {}
        await sleep(20);
      }
      return null;
    } finally {
      // Libera lock físico após ler
      if (fd !== null) releaseFileLock(lockPath, fd);
    }
  });
}

/** Escrita atômica sob lock (in-processo + físico). */
async function write(nome, man) {
  return withLock(nome, async () => {
    const file = getManifestPath(nome);
    const lockPath = getLockPath(file);
    let fd = null;
    try {
      // Adquire lock físico antes de escrever
      fd = acquireFileLock(lockPath);
      writeJsonAtomic(file, man);
      return true;
    } finally {
      // Libera lock físico após escrever
      if (fd !== null) releaseFileLock(lockPath, fd);
    }
  });
}

/** Update mutável atômico: fn recebe o objeto, patcha e retorna objeto novo (promise ou sync) com lock físico. */
async function update(nome, patchFn) {
  return withLock(nome, async () => {
    const file = getManifestPath(nome);
    const lockPath = getLockPath(file);
    let fd = null;
    try {
      // Adquire lock físico antes de ler
      fd = acquireFileLock(lockPath);
      
      const cur = readJsonSafe(file, {}) || {};
      let next = await Promise.resolve(patchFn(cur)) || cur;
      // Sempre garante merge: mescla campos do cur manifest caso patchFn não os retorne!
      next = Object.assign({}, cur, next);
      writeJsonAtomic(file, next);
      return next;
    } finally {
      // Libera lock físico após escrever
      if (fd !== null) releaseFileLock(lockPath, fd);
    }
  });
}

// Só use read/write/update deste módulo para trabalhar com manifest.json em workers, apis ou scripts! Não acesse nem escreva o arquivo direto!
// IMPORTANTE: NENHUM código deve gravar em manifest.json sem explicitamente usar o lock com acquireFileLock/releaseFileLock.
module.exports = { getManifestPath, read, write, update, acquireFileLock, releaseFileLock };
