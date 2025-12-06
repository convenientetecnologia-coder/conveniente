'use strict';

const fs = require('fs');
const path = require('path');

let issues = null;
try { issues = require('./issues.js'); } catch {}
const logger = require('./logger.js');
const stepLog = require('./stepLog.js');
const audit = stepLog.audit;

const LOCK_DIR = path.join(__dirname, '..', 'dados', 'locks');
const STALE_MS = 30 * 60 * 1000; // 30min (limite para stale locks)

function ensureDir() {
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch {}
}
ensureDir();

function key(perfil, chatId) {
  return path.join(LOCK_DIR, `${String(perfil || '')}__${String(chatId || '')}.lock`);
}

// Armazenamento dos FDs abertos para cada lock ativo
// Chave: caminho do arquivo de lock, Valor: { fd: number, acquiredAt: timestamp, count: number }
const openFDs = new Map();

function isStale(fp) {
  try {
    if (!fs.existsSync(fp)) return false;
    const st = fs.statSync(fp);
    const age = Date.now() - st.mtimeMs;
    return age > STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Adquire lock exclusivo para perfil+chatId
 * @param {string} perfil - Nome do perfil
 * @param {string} chatId - ID do chat
 * @param {number} timeoutMs - Timeout em ms (opcional, padrão: sem timeout)
 * @returns {Promise<boolean>} - true se adquirido com sucesso, false caso contrário
 */
async function acquire(perfil, chatId, timeoutMs) {
  ensureDir();
  const f = key(perfil, chatId);
  audit(perfil, 'virtus', 'debug', 'chatlock_acquire_start', { chatId, file: f, timeoutMs });
  const startTime = Date.now();
  
  // Reentrância: se já possuímos, apenas incrementa contagem e retorna sucesso
  if (openFDs.has(f)) {
    const entry = openFDs.get(f);
    if (entry && typeof entry.fd === 'number') {
      try {
        // Verifica se o FD ainda está válido
        fs.fstatSync(entry.fd);
        // Incrementa contagem e retorna sucesso imediato
        entry.count = (entry.count || 1) + 1;
        openFDs.set(f, entry);
        return true;
      } catch {
        // FD inválido, remove e tenta adquirir novamente
        openFDs.delete(f);
      }
    }
  }
  
  // Loop de tentativas (com timeout se especificado)
  while (true) {
    // Verifica timeout
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        try {
          if (issues && typeof issues.append === 'function') {
            await issues.append(perfil, 'chat_lock_acquire_fail', `chat=${chatId} timeout=${timeoutMs}ms`);
          }
        } catch {}
        logger.warn('[CHATLOCK] acquire_timeout', { perfil, chatId, file: f, timeoutMs, elapsed });
        audit(perfil, 'virtus', 'error', 'chatlock_acquire_timeout', { chatId, file: f, timeoutMs });
        return false;
      }
    }
    
    try {
      // Tenta criar lock de forma atômica (wx = exclusive write, falha se arquivo existe)
      const fd = fs.openSync(f, 'wx');
      
      // Escreve timestamp no arquivo
      const timestamp = String(Date.now());
      fs.writeFileSync(fd, timestamp, 'utf8');
      fs.fsyncSync(fd); // Garante escrita em disco
      
      // Mantém o FD aberto durante a execução (garante exclusividade)
      openFDs.set(f, { fd, acquiredAt: Date.now(), count: 1 });
      
      audit(perfil, 'virtus', 'info', 'chatlock_acquired', { chatId, file: f });
      logger.debug('[CHATLOCK] acquired', { perfil, chatId, file: f });
      return true;
      
    } catch (e) {
      // Arquivo já existe
      if (e.code === 'EEXIST' || fs.existsSync(f)) {
        // Se está stale e não está em openFDs, remove e tenta novamente
        if (isStale(f) && !openFDs.has(f)) {
          try {
            // Loga timeout_release antes de remover
            try {
              if (issues && typeof issues.append === 'function') {
                await issues.append(perfil, 'chat_lock_timeout_release', `chat=${chatId} stale_lock_removed`);
              }
            } catch {}
            logger.info('[CHATLOCK] timeout_release', { perfil, chatId, file: f, reason: 'stale_lock' });
            
            audit(perfil, 'virtus', 'warn', 'chatlock_stale_removed', { chatId, file: f });
            fs.unlinkSync(f);
            // Tenta novamente imediatamente
            continue;
          } catch (unlinkErr) {
            // Falha ao remover stale, loga e tenta novamente após pequeno delay
            try {
              if (issues && typeof issues.append === 'function') {
                await issues.append(perfil, 'chat_lock_timeout_release', `chat=${chatId} stale_removal_failed`);
              }
            } catch {}
            logger.warn('[CHATLOCK] stale_removal_failed', { perfil, chatId, file: f, error: (unlinkErr && unlinkErr.message) || unlinkErr });
            
            // Aguarda um pouco antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
        }
        
        // Lock existe e não está stale, ou está em openFDs (outro processo tem)
        // Se não há timeout, retorna false imediatamente
        if (typeof timeoutMs !== 'number' || timeoutMs <= 0) {
          try {
            if (issues && typeof issues.append === 'function') {
              await issues.append(perfil, 'chat_lock_acquire_fail', `chat=${chatId} lock_exists`);
            }
          } catch {}
          logger.warn('[CHATLOCK] acquire_fail', { perfil, chatId, file: f, reason: 'lock_exists' });
          audit(perfil, 'virtus', 'warn', 'chatlock_acquire_fail', { chatId, file: f, reason: 'lock_exists' });
          return false;
        }
        
        // Com timeout, aguarda um pouco e tenta novamente
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      
      // Outro tipo de erro
      try {
        if (issues && typeof issues.append === 'function') {
          await issues.append(perfil, 'chat_lock_acquire_fail', `chat=${chatId} error=${(e && e.message) || String(e)}`);
        }
      } catch {}
      logger.error('[CHATLOCK] acquire_error', { perfil, chatId, file: f, error: (e && e.message) || e });
      audit(perfil, 'virtus', 'error', 'chatlock_acquire_error', { chatId, file: f, error: (e && e.message) || String(e) });
      return false;
    }
  }
}

/**
 * Libera lock para perfil+chatId
 * @param {string} perfil - Nome do perfil
 * @param {string} chatId - ID do chat
 */
function release(perfil, chatId) {
  const f = key(perfil, chatId);
  audit(perfil, 'virtus', 'debug', 'chatlock_release', { chatId, file: f });
  const entry = openFDs.get(f);
  
  if (entry && typeof entry.fd === 'number') {
    entry.count = Math.max(0, (entry.count || 1) - 1);
    if (entry.count > 0) {
      openFDs.set(f, entry);
      return;
    }
    try {
      // Fecha o FD (libera o lock no sistema de arquivos)
      fs.closeSync(entry.fd);
    } catch (e) {
      logger.warn('[CHATLOCK] close_fd_error', { perfil, chatId, file: f, error: (e && e.message) || e });
      audit(perfil, 'virtus', 'warn', 'chatlock_release_error', { chatId, file: f, error: (e && e.message) || e });
    }
    openFDs.delete(f);
  }
  
  // Remove arquivo de lock (se ainda existir)
  try {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  } catch (e) {
    logger.warn('[CHATLOCK] unlink_error', { perfil, chatId, file: f, error: (e && e.message) || e });
    audit(perfil, 'virtus', 'warn', 'chatlock_release_error', { chatId, file: f, error: (e && e.message) || e });
  }
  
  logger.debug('[CHATLOCK] released', { perfil, chatId, file: f });
}

/**
 * Atualiza mtime do arquivo de lock (touch)
 * @param {string} perfil - Nome do perfil
 * @param {string} chatId - ID do chat
 */
function touch(perfil, chatId) {
  const f = key(perfil, chatId);
  try {
    if (fs.existsSync(f)) {
      const now = new Date();
      fs.utimesSync(f, now, now);
      audit(perfil, 'virtus', 'debug', 'chatlock_touch', { chatId, file: f });
    }
  } catch (e) {
    logger.warn('[CHATLOCK] touch_error', { perfil, chatId, file: f, error: (e && e.message) || e });
    audit(perfil, 'virtus', 'warn', 'chatlock_touch_error', { chatId, file: f, error: (e && e.message) || e });
  }
}

module.exports = { acquire, release, touch };
