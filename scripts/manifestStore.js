// manifestStore.js
// ATENÇÃO: Toda gravação/mutação em manifest.json (qualquer perfil) DEVE ser feita exclusivamente via manifestStore.update(nome, fnPatch), que já provê lock serializado.
// É PROIBIDO qualquer write/disco a manifest.json por fora deste módulo!
// 
// IMPORTANTE: NENHUM código deve gravar em manifest.json sem explicitamente usar o lock com acquireFileLock/releaseFileLock.
// O lock físico (manifest.json.lck) garante exclusão mútua inter-process.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const stepLog = require('./stepLog.js');
const audit = stepLog.audit;

const locks = new Map();
const heldLocks = new Map();

/** Espera não bloqueante (promise-based). */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isLockStale(lockPath, maxAgeMs = 2 * 60 * 1000) {
  try {
    if (!fs.existsSync(lockPath)) return false;
    const st = fs.statSync(lockPath);
    if ((Date.now() - st.mtimeMs) > maxAgeMs) return true;
    try {
      const txt = fs.readFileSync(lockPath, 'utf8');
      const meta = JSON.parse(txt);
      if (meta && meta.pid && !isProcessAlive(Number(meta.pid))) return true;
    } catch {}
    return false;
  } catch {
    return false;
  }
}

function safeSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {/* busy-wait */}
}

/**
 * Adquire lock de arquivo físico (cross-process) com suporte a reentrância e limpeza de locks stale.
 * @param {string} lockPath - Caminho do arquivo de lock (.lck)
 * @param {number} maxWaitMs - Tempo máximo de espera em ms (padrão 5000)
 * @param {number} stepDelayMs - Delay entre tentativas em ms (padrão 10)
 * @returns {number} File descriptor do lock adquirido
 * @throws {Error} Se timeout após maxWaitMs
 */
function acquireFileLock(lockPath, maxWaitMs = 5000, stepDelayMs = 10) {
  // Reentrância: se já possuímos, apenas incremente contagem
  const h = heldLocks.get(lockPath);
  if (h && typeof h.fd === 'number') {
    h.count = (h.count || 1) + 1;
    heldLocks.set(lockPath, h);
    return h.fd;
  }
  const start = Date.now();
  try {
    while (true) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        try {
          const meta = { pid: process.pid, host: os.hostname(), startedAt: Date.now() };
          fs.writeFileSync(fd, JSON.stringify(meta), 'utf8');
          fs.fsyncSync(fd);
        } catch {}
        heldLocks.set(lockPath, { fd, count: 1, ownerPid: process.pid });
        return fd;
      } catch (e) {
        if (e && e.code === 'EEXIST') {
          if (isLockStale(lockPath)) {
            audit('GLOBAL', 'virtus', 'warn', 'manifest_flock_stale_removed', { lockPath });
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
          if ((Date.now() - start) >= maxWaitMs) {
            audit('GLOBAL', 'virtus', 'error', 'manifest_flock_timeout', { lockPath, maxWaitMs });
            throw new Error('file_lock_timeout:' + lockPath);
          }
          safeSleep(stepDelayMs);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    audit('GLOBAL', 'virtus', 'error', 'manifest_flock_acquire_error', { lockPath, error: (e && e.message) || String(e) });
    throw e;
  }
}

/**
 * Libera lock de arquivo físico (cross-process) com suporte a reentrância.
 * @param {string} lockPath - Caminho do arquivo de lock (.lck)
 * @param {number} fdIgnored - File descriptor (ignorado, usado apenas para compatibilidade)
 */
function releaseFileLock(lockPath, fdIgnored) {
  const h = heldLocks.get(lockPath);
  if (!h) {
    try { if (typeof fdIgnored === 'number') fs.closeSync(fdIgnored); } catch (e) {
      audit('GLOBAL', 'virtus', 'warn', 'manifest_flock_release_error', { lockPath, error: (e && e.message) || String(e) });
    }
    try { fs.unlinkSync(lockPath); } catch (e) {
      audit('GLOBAL', 'virtus', 'warn', 'manifest_flock_release_error', { lockPath, error: (e && e.message) || String(e) });
    }
    return;
  }
  h.count = Math.max(0, (h.count || 1) - 1);
  if (h.count > 0) {
    heldLocks.set(lockPath, h);
    return;
  }
  try { fs.closeSync(h.fd); } catch (e) {
    audit('GLOBAL', 'virtus', 'warn', 'manifest_flock_release_error', { lockPath, error: (e && e.message) || String(e) });
  }
  try { fs.unlinkSync(lockPath); } catch (e) {
    audit('GLOBAL', 'virtus', 'warn', 'manifest_flock_release_error', { lockPath, error: (e && e.message) || String(e) });
  }
  heldLocks.delete(lockPath);
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
            const result = JSON.parse(data);
            return result;
          }
          // fallback: tente ler o .tmp se existe (escrita atômica em progresso)
          const tmp = file + '.tmp';
          if (fs.existsSync(tmp)) {
            const data = fs.readFileSync(tmp, 'utf8');
            const result = JSON.parse(data);
            return result;
          }
        } catch {}
        await sleep(20);
      }
      return null;
    } catch (e) {
      audit(nome || 'GLOBAL', 'virtus', 'error', 'manifest_error', { file, error: (e && e.message) || String(e) });
      throw e;
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
    audit(nome, 'virtus', 'debug', 'manifest_write_start', { file });
    const lockPath = getLockPath(file);
    let fd = null;
    try {
      // Adquire lock físico antes de escrever
      fd = acquireFileLock(lockPath);
      writeJsonAtomic(file, man);
      audit(nome, 'virtus', 'info', 'manifest_write_end', { file });
      return true;
    } catch (e) {
      audit(nome || 'GLOBAL', 'virtus', 'error', 'manifest_error', { file, error: (e && e.message) || String(e) });
      throw e;
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
    audit(nome, 'virtus', 'debug', 'manifest_update_start', { file });
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
      audit(nome, 'virtus', 'info', 'manifest_update_end', { file });
      return next;
    } catch (e) {
      audit(nome || 'GLOBAL', 'virtus', 'error', 'manifest_error', { file, error: (e && e.message) || String(e) });
      throw e;
    } finally {
      // Libera lock físico após escrever
      if (fd !== null) releaseFileLock(lockPath, fd);
    }
  });
}

// Só use read/write/update deste módulo para trabalhar com manifest.json em workers, apis ou scripts! Não acesse nem escreva o arquivo direto!
// IMPORTANTE: NENHUM código deve gravar em manifest.json sem explicitamente usar o lock com acquireFileLock/releaseFileLock.
module.exports = { getManifestPath, read, write, update, acquireFileLock, releaseFileLock };
