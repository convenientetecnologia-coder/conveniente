'use strict';

const fs = require('fs');
const path = require('path');

const LOCK_DIR = path.join(__dirname, '..', 'dados', 'virtus_v2', 'locks');
const STALE_MS = 5 * 60 * 1000; // 5min, MILITAR

function ensureDir() {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
}

ensureDir();

function lockPath(perfil, chatId) {
  return path.join(LOCK_DIR, `${String(perfil)}__${String(chatId)}.lock`);
}

function isStale(fp) {
  try {
    const st = fs.statSync(fp);
    return (Date.now() - st.mtimeMs) > STALE_MS;
  } catch {
    return false;
  }
}

function acquire(perfil, chatId, owner = 'virtus') {
  const fp = lockPath(perfil, chatId);
  try {
    const fd = fs.openSync(fp, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify({ ts: Date.now(), pid: process.pid, owner }), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    // stale recovery
    if (fs.existsSync(fp) && isStale(fp)) {
      try { fs.unlinkSync(fp); } catch {}
      try {
        const fd2 = fs.openSync(fp, 'wx');
        try {
          fs.writeFileSync(fd2, JSON.stringify({ ts: Date.now(), pid: process.pid, owner, recovered: true }), 'utf8');
          fs.fsyncSync(fd2);
        } finally {
          fs.closeSync(fd2);
        }
        return true;
      } catch {}
    }
    return false;
  }
}

function release(perfil, chatId) {
  const fp = lockPath(perfil, chatId);
  try { fs.unlinkSync(fp); } catch {}
}

module.exports = { acquire, release };

