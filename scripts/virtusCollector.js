'use strict';

/**
 * Virtus V2 - Collector Stage
 * 
 * Responsabilidades EXCLUSIVAS:
 * - Detecta chats novos/unread no Messenger feed
 * - Atualiza collect_due/<perfil>/<chatId>.json (debounce persistente de 45s)
 * - Quando dueAt <= now, coleta histórico e grava em collected/<perfil>/inbox/<id>.json
 * 
 * REGRAS ABSOLUTAS:
 * - NUNCA chama LLM (não tem acesso a OpenAI)
 * - NUNCA envia mensagem
 * - NUNCA depende de estado em memória (tudo em disco com fsync)
 * - Restart-safe (pode crashar e voltar sem perder eventos)
 */

const path = require('path');
const fs = require('fs/promises');
const virtusDiskQueue = require('./virtusDiskQueue.js');
const virtusV2Paths = require('./virtusV2Paths.js');
const virtusIds = require('./virtusIds.js');
const virtusMessenger = require('./virtusMessenger.js');
const browserHelper = require('./browser.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');

// Constantes
const AI_COLLECT_WINDOW_MS = parseInt(process.env.VIRTUS_AI_COLLECT_MS || '45000', 10); // 45s
const POLL_INTERVAL_MS = parseInt(process.env.VIRTUS_POLL_MS || '1000', 10); // 1s
const STALE_REQUEUE_MS = 5 * 60 * 1000; // 5min - itens presos em processing voltam para inbox

/**
 * Garante que a página principal está disponível
 */
async function ensurePage(browser, nome) {
  if (!browser) return null;
  
  try {
    const pages = await browser.pages();
    if (!pages || pages.length === 0) return null;
    
    // Procura página do Marketplace/Messenger
    for (const p of pages) {
      try {
        const url = await p.url().catch(() => '');
        if (/messenger\.com/i.test(url)) {
          return p;
        }
      } catch {}
    }
    
    // Fallback: primeira página
    return pages[0] || null;
  } catch {
    return null;
  }
}

/**
 * Lê estado de collect_due de um chat
 */
async function readCollectDue(perfil, chatId) {
  const file = path.join(virtusV2Paths.collectDueDir(perfil), `${chatId}.json`);
  return await virtusDiskQueue.readJsonSafe(file, null);
}

/**
 * Atualiza estado de collect_due (debounce persistente)
 * 
 * Se já existe, atualiza dueAt mantendo o mínimo entre:
 * - devidoAt anterior (se ainda no futuro)
 * - novo cálculo (firstSeenAt + AI_COLLECT_WINDOW_MS)
 * 
 * Isso garante que múltiplos eventos do mesmo chat não reduzem o delay.
 */
async function updateCollectDue(perfil, chatId, { firstSeenAt, dueAt } = {}) {
  const dir = virtusV2Paths.collectDueDir(perfil);
  await virtusDiskQueue.ensureDir(dir);
  
  const file = path.join(dir, `${chatId}.json`);
  const existing = await readCollectDue(perfil, chatId);
  
  const now = Date.now();
  const newFirstSeenAt = firstSeenAt || existing?.firstSeenAt || now;
  
  // Calcula novo dueAt
  let newDueAt = dueAt;
  if (!newDueAt) {
    newDueAt = newFirstSeenAt + AI_COLLECT_WINDOW_MS;
  }
  
  // Se já existe, mantém o mínimo (não reduz delay)
  if (existing && existing.dueAt && existing.dueAt > now) {
    newDueAt = Math.min(newDueAt, existing.dueAt);
  }
  
  const record = {
    perfil,
    chatId,
    firstSeenAt: newFirstSeenAt,
    dueAt: newDueAt,
    updatedAt: now
  };
  
  await virtusDiskQueue.writeJsonAtomic(file, record);
  
  return record;
}

/**
 * Detecta chats novos via polling do feed
 */
async function detectChatsPoll(page, perfil) {
  try {
    await virtusMessenger.ensureMarketplace(page, { timeoutMs: 25000 }).catch(() => {});
    const chats = await virtusMessenger.listRecentUnreadChats(page);
    
    const now = Date.now();
    for (const chat of chats) {
      if (!chat.id || chat.fromMine || !chat.recentEnough) continue;
      
      // Calcula idade da mensagem
      const idadeMs = chat.idadeMs || 0;
      
      // Atualiza collect_due
      await updateCollectDue(perfil, chat.id, {
        firstSeenAt: now - idadeMs,
        dueAt: now + Math.max(0, AI_COLLECT_WINDOW_MS - idadeMs)
      }).catch(() => {});
    }
    
    return chats.length;
  } catch (err) {
    logger.warn(`[virtusCollector][${perfil}] Erro em detectChatsPoll`, { err: String(err) });
    return 0;
  }
}

/**
 * Instala observer de feed no Messenger (chama browserHelper.installFeedObserver)
 * O observer já popula global.__virtusEventsMap[perfil] automaticamente
 */
async function setupObserverEvents(perfil, page) {
  try {
    // browserHelper.installFeedObserver já instala o observer e popula global.__virtusEventsMap
    await browserHelper.installFeedObserver(page, perfil);
  } catch (err) {
    logger.warn(`[virtusCollector][${perfil}] Erro ao instalar observer`, { err: String(err) });
  }
}

/**
 * Processa eventos da fila do observer
 */
async function processObserverEvents(perfil) {
  try {
    if (!global.__virtusEventsMap || !global.__virtusEventsMap.has(perfil)) {
      return 0;
    }
    
    const eventQueue = global.__virtusEventsMap.get(perfil);
    if (!Array.isArray(eventQueue) || eventQueue.length === 0) {
      return 0;
    }
    
    // Remove todos de uma vez para evitar race
    const eventos = eventQueue.splice(0, eventQueue.length);
    let processed = 0;
    
    for (const evt of eventos) {
      try {
        const chatId = String(evt.chatId || '').trim();
        if (!chatId) continue;
        
        const now = Date.now();
        await updateCollectDue(perfil, chatId, {
          firstSeenAt: evt.ts || now,
          dueAt: now + AI_COLLECT_WINDOW_MS
        });
        
        processed++;
      } catch {}
    }
    
    return processed;
  } catch {
    return 0;
  }
}

/**
 * Coleta histórico de um chat e grava em collected/inbox
 */
async function collectChatHistory(page, perfil, chatId) {
  const attemptId = stepLog.attemptId();
  
  try {
    stepLog.appendJSONL(perfil, 'virtus_collector', {
      attempt: attemptId,
      step: 'collect_begin',
      chatId
    });
    
    // Abre chat
    const opened = await virtusMessenger.openChat(page, chatId, { timeoutMs: 20000 });
    if (!opened) {
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_fail_open',
        chatId
      });
      return false;
    }
    
    // Garante que conversa está pronta
    const ready = await virtusMessenger.ensureConversationReady(page, chatId, { timeoutMs: 20000 });
    if (!ready) {
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_fail_ready',
        chatId
      });
      return false;
    }
    
    // Coleta histórico
    const history = await virtusMessenger.scrapeHistory(page);
    if (!Array.isArray(history) || history.length === 0) {
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_empty_history',
        chatId
      });
      return false;
    }
    
    // Verifica se última mensagem é do cliente (evita coletar sem bolha nova)
    const last = history[history.length - 1];
    if (!last || last.autor !== 'cliente') {
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_skip_no_new_client_bubble',
        chatId,
        lastAutor: last?.autor || 'none'
      });
      return false;
    }
    
    // Computa hash do histórico
    const histSig = virtusIds.historySig(history);
    
    // Gera ID determinístico
    const eventId_val = virtusIds.eventId({
      perfil,
      chatId,
      histSig
    });
    
    // Verifica se já foi coletado (deduplicação)
    const inboxDir = virtusV2Paths.collectedInboxDir(perfil);
    await virtusDiskQueue.ensureDir(inboxDir);
    const collectedFile = path.join(inboxDir, `${eventId_val}.json`);
    
    try {
      await fs.access(collectedFile);
      // Arquivo já existe - skip (idempotência)
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_skip_duplicate',
        chatId,
        eventId: eventId_val,
        histSig
      });
      return true;
    } catch {
      // Arquivo não existe - prossegue
    }
    
    // Cria record completo
    const record = {
      id: eventId_val,
      perfil,
      chatId,
      histSig,
      history,
      collectedAt: Date.now(),
      attemptId
    };
    
    // Grava atomicamente
    await virtusDiskQueue.writeJsonAtomic(collectedFile, record);
    
    stepLog.appendJSONL(perfil, 'virtus_collector', {
      attempt: attemptId,
      step: 'collect_success',
      chatId,
      eventId: eventId_val,
      histSig,
      historyLen: history.length
    });
    
    return true;
  } catch (err) {
    stepLog.appendJSONL(perfil, 'virtus_collector', {
      attempt: attemptId,
      step: 'collect_error',
      chatId,
      error: String(err)
    });
    logger.error(`[virtusCollector][${perfil}] Erro ao coletar chat ${chatId}`, { err });
    return false;
  }
}

/**
 * Processa collect_due files que estão prontos (dueAt <= now)
 */
async function processDueCollects(browser, perfil) {
  const dir = virtusV2Paths.collectDueDir(perfil);
  
  let files = [];
  try {
    files = await virtusDiskQueue.listJsonFiles(dir);
  } catch {
    return 0;
  }
  
  const now = Date.now();
  let processed = 0;
  
  for (const file of files) {
    try {
      const record = await virtusDiskQueue.readJsonSafe(file, null);
      if (!record || !record.chatId) continue;
      
      // Se não está due ainda, skip
      if (record.dueAt && record.dueAt > now) continue;
      
      // Garante página
      const page = await ensurePage(browser, perfil);
      if (!page) continue;
      
      // Coleta histórico
      const success = await collectChatHistory(page, perfil, record.chatId);
      
      if (success) {
        // Remove collect_due após coleta bem-sucedida
        try {
          await fs.unlink(file);
        } catch {}
      } else {
        // Em caso de falha, reschedule para 10s depois
        await updateCollectDue(perfil, record.chatId, {
          firstSeenAt: record.firstSeenAt || now,
          dueAt: now + 10000
        });
      }
      
      processed++;
    } catch (err) {
      logger.warn(`[virtusCollector][${perfil}] Erro ao processar collect_due`, { file, err: String(err) });
    }
  }
  
  return processed;
}

/**
 * Requeue itens stale em processing
 */
async function requeueStaleProcessing(perfil) {
  const processingDir = virtusV2Paths.collectedProcessingDir(perfil);
  const inboxDir = virtusV2Paths.collectedInboxDir(perfil);
  
  await virtusDiskQueue.ensureDir(processingDir);
  await virtusDiskQueue.ensureDir(inboxDir);
  
  const moved = await virtusDiskQueue.requeueStale(processingDir, inboxDir, STALE_REQUEUE_MS);
  
  if (moved > 0) {
    logger.warn(`[virtusCollector][${perfil}] Requeued ${moved} stale items from processing`);
  }
  
  return moved;
}

/**
 * Inicia o coletor Virtus V2
 * 
 * @param {Browser} browser - Instância do Puppeteer Browser
 * @param {string} perfil - Nome do perfil
 * @param {Object} options - Opções
 * @param {number} options.epoch - Epoch do browser (fence para restart safety)
 * @returns {Object} { stop: async function() }
 */
function startVirtusCollector(browser, perfil, options = {}) {
  const { epoch = 0 } = options;
  let running = true;
  let pollLoopHandle = null;
  let processLoopHandle = null;
  let requeueLoopHandle = null;
  
  // Verifica frozen
  let manifestFrozenUntil = 0;
  try {
    const manifestStore = require('./manifestStore.js');
    manifestStore.read(perfil).then((manifest) => {
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    }).catch(() => {});
  } catch {}
  
  // Epoch fence
  function epochOk() {
    try {
      if (browser && browser._fenceEpochMap && typeof browser._fenceEpochMap[perfil] !== 'undefined') {
        return browser._fenceEpochMap[perfil] === epoch;
      }
      return true;
    } catch {
      return false;
    }
  }
  
  logger.info(`[virtusCollector][${perfil}] Iniciando Virtus Collector V2`);
  stepLog.appendJSONL(perfil, 'virtus_collector', { step: 'start', epoch });
  
  // Setup observer events (instala uma vez)
  let observerInstalled = false;
  ensurePage(browser, perfil).then(async (page) => {
    if (page && !observerInstalled) {
      await setupObserverEvents(perfil, page);
      observerInstalled = true;
    }
  }).catch(() => {});
  
  // Loop de detecção (poll + observer)
  async function detectionLoop() {
    while (running && epochOk()) {
      try {
        // Verifica frozen
        if (manifestFrozenUntil > Date.now()) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        
        const page = await ensurePage(browser, perfil);
        if (!page) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }
        
        // Processa eventos do observer (já instalado pelo browserHelper)
        await processObserverEvents(perfil);
        
        // Poll do feed
        await detectChatsPoll(page, perfil);
        
        // Instala observer se ainda não instalado
        if (!observerInstalled) {
          await setupObserverEvents(perfil, page);
          observerInstalled = true;
        }
      } catch (err) {
        logger.warn(`[virtusCollector][${perfil}] Erro no detection loop`, { err: String(err) });
      }
      
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  
  // Loop de processamento de dueAt
  async function processLoop() {
    while (running && epochOk()) {
      try {
        if (manifestFrozenUntil > Date.now()) {
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        
        await processDueCollects(browser, perfil);
      } catch (err) {
        logger.warn(`[virtusCollector][${perfil}] Erro no process loop`, { err: String(err) });
      }
      
      // Processa a cada 2s
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  
  // Loop de requeue stale
  async function requeueLoop() {
    while (running && epochOk()) {
      try {
        await requeueStaleProcessing(perfil);
      } catch (err) {
        logger.warn(`[virtusCollector][${perfil}] Erro no requeue loop`, { err: String(err) });
      }
      
      // Requeue a cada 1min
      await new Promise((r) => setTimeout(r, 60000));
    }
  }
  
  // Inicia loops
  detectionLoop();
  processLoop();
  requeueLoop();
  
  return {
    stop: async () => {
      running = false;
      
      if (pollLoopHandle) {
        clearTimeout(pollLoopHandle);
        pollLoopHandle = null;
      }
      
      if (processLoopHandle) {
        clearTimeout(processLoopHandle);
        processLoopHandle = null;
      }
      
      if (requeueLoopHandle) {
        clearTimeout(requeueLoopHandle);
        requeueLoopHandle = null;
      }
      
      stepLog.appendJSONL(perfil, 'virtus_collector', { step: 'stop' });
      logger.info(`[virtusCollector][${perfil}] Virtus Collector V2 parado`);
    }
  };
}

module.exports = {
  startVirtusCollector
};

