'use strict';

const stepLog = require('./stepLog.js');

const LOCKS = new Map();

/**
 * Mutex por perfil para qualquer ação de UI (openChat/scrape/send).
 * Serializa collector + sender + detection do próprio collector.
 */
async function withVirtusUiLock(perfil, owner, chatId, fn) {
  if (!perfil || typeof fn !== 'function') return fn();
  
  const prev = LOCKS.get(perfil) || Promise.resolve();
  const queuedAt = Date.now();
  
  const job = prev
    .catch(() => {})
    .then(async () => {
      const waitMs = Date.now() - queuedAt;
      if (waitMs > 10) {
        stepLog.appendJSONL(perfil, 'virtus_ui_lock', {
          step: 'ui_lock_wait',
          owner: String(owner || ''),
          chatId: chatId ? String(chatId) : null,
          waitMs
        });
      }
      
      stepLog.appendJSONL(perfil, 'virtus_ui_lock', {
        step: 'ui_lock_acquire',
        owner: String(owner || ''),
        chatId: chatId ? String(chatId) : null
      });
      
      try {
        return await fn();
      } finally {
        stepLog.appendJSONL(perfil, 'virtus_ui_lock', {
          step: 'ui_lock_release',
          owner: String(owner || ''),
          chatId: chatId ? String(chatId) : null
        });
      }
    })
    .finally(() => {
      if (LOCKS.get(perfil) === job) LOCKS.delete(perfil);
    });
  
  LOCKS.set(perfil, job);
  return job;
}

module.exports = { withVirtusUiLock };

