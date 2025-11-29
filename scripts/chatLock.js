'use strict';
const fs = require('fs');
const path = require('path');
const issues = require('./issues.js');
const logger = require('./logger.js');

const LOCK_DIR = path.join(__dirname, '..', 'dados', 'locks');
function ensureDir() {
try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
}
ensureDir();

function key(perfil, chatId) {
return path.join(LOCK_DIR, `${perfil}__${chatId}.lock`);
}

// Armazenamento dos FDs abertos para cada lock ativo
const openFDs = new Map(); // chave é o caminho do arquivo de lock

const STALE_MS = 30 * 60 * 1000; // 30min (apenas para detecção de zumbi/crash)

function isStale(fp) {
try {
const st = fs.statSync(fp);
return (Date.now() - st.mtimeMs) > STALE_MS;
} catch { return false; }
}

function acquire(perfil, chatId) {
ensureDir();
const f = key(perfil, chatId);
try {
const fd = fs.openSync(f, 'wx'); // lock de disco, atômico
fs.writeFileSync(fd, String(Date.now()));
fs.fsyncSync(fd);
// Mantém o FD aberto durante a execução (garante exclusividade)
openFDs.set(f, fd);
return true;
} catch (e) {
// Arquivo existe; se estiver "stale" e não está em openFDs, libere e tente novamente
if (fs.existsSync(f) && isStale(f) && !openFDs.has(f)) {
try { fs.unlinkSync(f); } catch {}
try {
const fd2 = fs.openSync(f, 'wx');
fs.writeFileSync(fd2, String(Date.now()));
fs.fsyncSync(fd2);
openFDs.set(f, fd2);
try { issues.append(perfil, 'mil_action', `chat_lock_timeout_release chat=${chatId}`); } catch {}
logger.info('[CHATLOCK] timeout_release', { perfil, chatId, file: f });
return true;
} catch {}
}
// Falha na aquisição — registra telemetria
try { issues.append(perfil, 'mil_action', `chat_lock_acquire_fail chat=${chatId}`); } catch {}
logger.warn('[CHATLOCK] acquire_fail', { perfil, chatId, file: f });
return false;
}
}

function release(perfil, chatId) {
const f = key(perfil, chatId);
const fd = openFDs.get(f);
if (typeof fd === 'number') {
try { fs.closeSync(fd); } catch {}
openFDs.delete(f);
}
try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

function touch(perfil, chatId) {
const f = key(perfil, chatId);
try { fs.utimesSync(f, new Date(), new Date()); } catch {}
}

module.exports = { acquire, release, touch };