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
      try { 
        fs.unlinkSync(f);
        console.warn(`[chatLock] Lock stale removido para ${perfil}/${chatId}`);
        try {
          let issues = null;
          try { issues = require('./issues.js'); } catch {}
          if (issues && typeof issues.append === 'function') {
            issues.append(perfil || 'system', 'chatLock_stale_removed', `Lock stale removido para ${perfil}/${chatId}`).catch(()=>{});
          }
        } catch {}
      } catch {}
      try {
        const fd2 = fs.openSync(f, 'wx');
        try { fs.writeFileSync(fd2, String(Date.now())); fs.fsyncSync(fd2); }
        finally { fs.closeSync(fd2); }
        return true;
      } catch {}
    }
    console.warn(`[chatLock] Falha ao adquirir lock para ${perfil}/${chatId}`);
    try {
      let issues = null;
      try { issues = require('./issues.js'); } catch {}
      if (issues && typeof issues.append === 'function') {
        issues.append(perfil || 'system', 'chatLock_acquire_failed', `Falha ao adquirir lock para ${perfil}/${chatId}`).catch(()=>{});
      }
    } catch {}
    return false;
  }
}

function release(perfil, chatId) {
  try {
    const f = key(perfil, chatId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (e) {
    console.warn(`[chatLock] Erro ao liberar lock para ${perfil}/${chatId}`, e);
    try {
      let issues = null;
      try { issues = require('./issues.js'); } catch {}
      if (issues && typeof issues.append === 'function') {
        issues.append(perfil || 'system', 'chatLock_release_failed', `Erro ao liberar lock para ${perfil}/${chatId}: ${e && e.message || String(e)}`).catch(()=>{});
      }
    } catch {}
  }
}

// Remove locks com mais de 10min e loga
function forceUnlockStale(ms = 600_000) {
  try {
    const files = fs.readdirSync(LOCK_DIR);
    const now = Date.now();
    for (const file of files) {
      const fp = path.join(LOCK_DIR, file);
      try {
        const st = fs.statSync(fp);
        if ((now - st.mtimeMs) > ms) {
          fs.unlinkSync(fp);
          console.warn(`[chatLock][forceUnlockStale] Removido lock stale: ${fp}`);
        }
      } catch (e) {
        console.error(`[chatLock][forceUnlockStale] Erro ao processar lock: ${fp}`, e);
      }
    }
  } catch (e) {
    console.error(`[chatLock][forceUnlockStale] Erro geral`, e);
  }
}

module.exports = { acquire, release, forceUnlockStale };