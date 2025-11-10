// manifestStore.js
// ATENÇÃO: Toda gravação/mutação em manifest.json (qualquer perfil) DEVE ser feita exclusivamente via manifestStore.update(nome, fnPatch), que já provê lock serializado.
// É PROIBIDO qualquer write/disco a manifest.json por fora deste módulo!

'use strict';

const fs = require('fs');
const path = require('path');

const locks = new Map();

/** Espera não bloqueante (promise-based). */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

/** Lock atômico simples por perfil para serialização de IO/disco. */
// TODO/FUTURE: Aqui pode-se limitar (por perfil) o número de jobs/Promises simultâneos na fila, caso sobrecarga percebida
function withLock(nome, fn) {
  const prev = locks.get(nome) || Promise.resolve();
  const job = prev.then(() => Promise.resolve(fn()).catch(()=>{}))
                  .finally(() => { if (locks.get(nome) === job) locks.delete(nome); });
  locks.set(nome, job);
  return job;
}

/** Leitura atômica/retry tolerante para manifest.json. */
async function read(nome) {
  const file = getManifestPath(nome);
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
    let next = await Promise.resolve(patchFn(cur)) || cur;
    // Sempre garante merge: mescla campos do cur manifest caso patchFn não os retorne!
    next = Object.assign({}, cur, next);
    writeJsonAtomic(file, next);
    return next;
  });
}

/**
 * Atualiza credenciais no manifest, atomicamente.
 * - login === "" ou null → remove campo login do manifest.
 * - password === "" ou null → remove campo password do manifest.
 * - (autoLoginEnabled é totalmente ignorado/removido; nunca salvo)
 * - Se ambos forem removidos, remove obj credentials do manifest; senão, atualiza timestamp updatedAt.
 * - Ao gravar, sempre remove o campo autoLoginEnabled herdado de manifests antigos.
 */
async function updateCredentials(nome, { login, password } = {}) {
  return update(nome, m => {
    m = m || {};
    m.credentials = (m.credentials && typeof m.credentials === 'object') ? m.credentials : {};

    // Purga autoLoginEnabled legado:
    if ('autoLoginEnabled' in m.credentials) delete m.credentials.autoLoginEnabled;

    // Login: string vazia ou null -> remove; string não vazia -> define
    if (login === null || login === '') {
      delete m.credentials.login;
    } else if (typeof login === 'string') {
      m.credentials.login = login.trim();
    }

    // Senha: string vazia ou null -> remove; string não vazia -> define
    if (password === null || password === '') {
      delete m.credentials.password;
    } else if (typeof password === 'string') {
      m.credentials.password = password;
    }

    const hasLogin = typeof m.credentials.login === 'string' && m.credentials.login.trim() !== '';
    const hasPass  = typeof m.credentials.password === 'string' && m.credentials.password.length > 0;
    if (!hasLogin && !hasPass) {
      delete m.credentials;
    } else {
      m.credentials.updatedAt = Date.now();
    }
    return m;
  });
}

/**
 * Lê credenciais brutas (uso interno worker/browser).
 */
async function readCredentials(nome) {
  const m = await read(nome);
  return (m && m.credentials) || {};
}

/**
 * Lê credenciais de forma mascarada (para API/UI):
 * loginMasked: máscara defensiva
 * hasPassword: boolean, autoLoginEnabled, updatedAt.
 */
async function readCredentialsMasked(nome) {
  const m = await read(nome);
  const c = (m && m.credentials) || {};
  // Requere utils.js.maskLogin
  let mask = s=>s;
  try { mask = require('./utils.js').maskLogin; } catch {}
  return {
    loginMasked: c.login ? mask(c.login) : '',
    hasPassword: !!c.password,
    autoLoginEnabled: !!c.autoLoginEnabled,
    updatedAt: c.updatedAt || null
  };
}

// Só use read/write/update deste módulo para trabalhar com manifest.json em workers, apis ou scripts! Não acesse nem escreva o arquivo direto!
module.exports = {
  getManifestPath, read, write, update,
  updateCredentials, readCredentials, readCredentialsMasked
};