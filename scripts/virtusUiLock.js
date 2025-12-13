'use strict';

const stepLog = require('./stepLog.js');

const LOCKS = new Map();

/**
 * ASSINATURAS SUPORTADAS:
 *  - withVirtusUiLock(perfil, owner, chatId, fn)              -> key = perfil (legacy)
 *  - withVirtusUiLock(perfil, owner, chatId, lockKey, fn)     -> key = lockKey (MILITAR)
 *
 * USE lockKey = `page:${page._virtusLockKey}` PARA PARALELIZAR ENTRE TABS.
 */
async function withVirtusUiLock(perfil, owner, chatId, keyOrFn, maybeFn) {
  const hasKey = (typeof keyOrFn === 'string' && keyOrFn.length > 0);
  const fn = hasKey ? maybeFn : keyOrFn;
  const key = hasKey ? keyOrFn : String(perfil || 'GLOBAL');
  
  if (typeof fn !== 'function') {
    throw new Error('withVirtusUiLock: fn obrigatório');
  }
  
  const prev = LOCKS.get(key) || Promise.resolve();
  const queuedAt = Date.now();
  
  const job = prev
    .catch(() => {})
    .then(async () => {
      const waitMs = Date.now() - queuedAt;
      if (waitMs > 10) {
        stepLog.appendJSONL(perfil, 'virtus_ui_lock', {
          step: 'ui_lock_wait',
          key,
          owner: String(owner || ''),
          chatId: chatId ? String(chatId) : null,
          waitMs
        });
      }
      
      stepLog.appendJSONL(perfil, 'virtus_ui_lock', {
        step: 'ui_lock_acquire',
        key,
        owner: String(owner || ''),
        chatId: chatId ? String(chatId) : null
      });
      
      try {
        return await fn();
      } finally {
        stepLog.appendJSONL(perfil, 'virtus_ui_lock', {
          step: 'ui_lock_release',
          key,
          owner: String(owner || ''),
          chatId: chatId ? String(chatId) : null
        });
      }
    })
    .finally(() => {
      if (LOCKS.get(key) === job) LOCKS.delete(key);
    });
  
  LOCKS.set(key, job);
  return job;
}

module.exports = { withVirtusUiLock };

