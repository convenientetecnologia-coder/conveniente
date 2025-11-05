// scripts/chatLock.js

'use strict';
const fs = require('fs');
const path = require('path');

const LOCK_DIR = path.join(__dirname, '..', 'dados', 'locks');
function ensureDir() {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
}
ensureDir();

function key(perfil, chatId) {
  return path.join(LOCK_DIR, `${perfil}__${chatId}.lock`);
}

const STALE_MS = 30 * 60 * 1000; // 30min

function isStale(fp) {
  try {
    const st = fs.statSync(fp);
    return (Date.now() - st.mtimeMs) > STALE_MS;
  } catch { return false; }
}

function acquire(perfil, chatId) {
  const f = key(perfil, chatId);
  try {
    const fd = fs.openSync(f, 'wx'); // atômico
    try {
      fs.writeFileSync(fd, String(Date.now()));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return true;
  } catch (e) {
    // Já existe? Verifique stale
    if (fs.existsSync(f) && isStale(f)) {
      try { fs.unlinkSync(f); } catch {}
      try {
        const fd2 = fs.openSync(f, 'wx');
        try { fs.writeFileSync(fd2, String(Date.now())); fs.fsyncSync(fd2); }
        finally { fs.closeSync(fd2); }
        return true;
      } catch {}
    }
    return false;
  }
}

function release(perfil, chatId) {
  try {
    const f = key(perfil, chatId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

module.exports = { acquire, release };