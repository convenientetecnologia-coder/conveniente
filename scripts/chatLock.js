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

function acquire(perfil, chatId) {
  try {
    const f = key(perfil, chatId);
    if (fs.existsSync(f)) return false; // já está lockado
    fs.writeFileSync(f, String(Date.now())); // locka
    return true;
  } catch { return false; }
}
function release(perfil, chatId) {
  try {
    const f = key(perfil, chatId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

module.exports = { acquire, release };