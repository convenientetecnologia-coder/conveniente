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
const { withVirtusUiLock } = require('./virtusUiLock.js');
const virtusPagePool = require('./virtusPagePool.js');
const virtusChatLock = require('./virtusChatLock.js');

// Constantes
const AI_COLLECT_WINDOW_MS = parseInt(process.env.VIRTUS_AI_COLLECT_MS || '45000', 10); // 45s
const POLL_INTERVAL_MS = parseInt(process.env.VIRTUS_POLL_MS || '1000', 10); // 1s
const STALE_REQUEUE_MS = 5 * 60 * 1000; // 5min - itens presos em processing voltam para inbox
const COLLECT_MAX_ATTEMPTS = parseInt(process.env.VIRTUS_COLLECT_MAX_ATTEMPTS || '6', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function collectedOrReplyExistsAnywhere(perfil, eventId) {
  const collectedDirs = [
    virtusV2Paths.collectedInboxDir(perfil),
    virtusV2Paths.collectedDoneDir(perfil),
    virtusV2Paths.collectedDeadDir(perfil)
  ];
  for (const dir of collectedDirs) {
    await virtusDiskQueue.ensureDir(dir);
    if (await exists(path.join(dir, `${eventId}.json`))) return true;
  }

  // processing: nome tem suffix .claim-*
  try {
    const processingFiles = await virtusDiskQueue.listJsonFiles(virtusV2Paths.collectedProcessingDir(perfil));
    if (processingFiles.some(f => path.basename(f).startsWith(`${eventId}.json`))) return true;
  } catch {}

  // replies (replyId == eventId)
  const replyDirs = [
    virtusV2Paths.repliesInboxDir(perfil),
    virtusV2Paths.repliesScheduledDir(perfil),
    virtusV2Paths.repliesProcessingDir(perfil),
    virtusV2Paths.repliesSentDir(perfil),
    virtusV2Paths.repliesCanceledDir(perfil),
    virtusV2Paths.repliesDeadDir(perfil),
  ];
  for (const dir of replyDirs) {
    await virtusDiskQueue.ensureDir(dir);
    if (await exists(path.join(dir, `${eventId}.json`))) return true;
  }
  try {
    const rp = await virtusDiskQueue.listJsonFiles(virtusV2Paths.repliesProcessingDir(perfil));
    if (rp.some(f => path.basename(f).startsWith(`${eventId}.json`))) return true;
  } catch {}

  return false;
}

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
async function updateCollectDue(perfil, chatId, { firstSeenAt, dueAt, source = 'poll', previewSig = null, stage = null, attempts = null, lastError = null, lastCollected = null } = {}) {
  const dir = virtusV2Paths.collectDueDir(perfil);
  await virtusDiskQueue.ensureDir(dir);
  
  const file = path.join(dir, `${chatId}.json`);
  const existing = await readCollectDue(perfil, chatId);
  
  const now = Date.now();
  const prevStage = existing?.stage || 'pending';
  const prevPreview = (existing && typeof existing.previewSig === 'string') ? existing.previewSig : null;
  const nextPreview = (typeof previewSig === 'string' && previewSig) ? previewSig : prevPreview;
  
  // MILITAR: null -> "abc" CONTA COMO MUDANÇA (senão você perde chat)
  const previewChanged = (typeof previewSig === 'string' && previewSig && previewSig !== prevPreview);
  
  // NUNCA faça early-return aqui. "collected" NÃO é terminal se o chat reapareceu como unread.
  // O dedup real é por histSig/eventId, não por preview.

  const newFirstSeenAt = previewChanged ? (firstSeenAt || now) : (firstSeenAt || existing?.firstSeenAt || now);
  
  // Calcula novo dueAt
  let newDueAt = dueAt;
  if (!newDueAt) {
    newDueAt = newFirstSeenAt + AI_COLLECT_WINDOW_MS;
  }
  
  // Se já existe, mantém o mínimo (não reduz delay)
  if (existing && existing.dueAt && existing.dueAt > now) {
    newDueAt = Math.min(newDueAt, existing.dueAt);
  }

  const nextStage = stage || (previewChanged ? 'pending' : prevStage);
  const nextAttempts = (typeof attempts === 'number')
    ? attempts
    : (previewChanged ? 0 : (existing?.attempts || 0));
  
  const record = {
    perfil,
    chatId,
    firstSeenAt: newFirstSeenAt,
    dueAt: (nextStage === 'collected') ? (now + 365*24*60*60*1000) : newDueAt,
    updatedAt: now,
    stage: nextStage,
    previewSig: nextPreview,
    attempts: nextAttempts,
    lastError: lastError || existing?.lastError || null,
    lastErrorAt: lastError ? now : (existing?.lastErrorAt || null),
    lastCollected: lastCollected || existing?.lastCollected || null
  };
  
  await virtusDiskQueue.writeJsonAtomic(file, record);
  
  // Instrumentação: loga criação/atualização de collect_due
  stepLog.appendJSONL(perfil, 'virtus_collector', {
    step: existing ? 'collect_due_update' : 'collect_due_create',
    chatId,
    firstSeenAt: newFirstSeenAt,
    dueAt: record.dueAt,
    stage: record.stage,
    previewSig: record.previewSig || null,
    attempts: record.attempts || 0,
    source: String(source || 'poll')
  });
  
  return record;
}

/**
 * Detecta chats novos via polling do feed
 */
async function detectChatsPoll(page, perfil) {
  try {
    const batchId = stepLog.attemptId();
    
    const chats = await withVirtusUiLock(perfil, 'collector_detect', null, async () => {
      // DETECT é low-priority: nunca segure UI lock por 25s.
      await virtusMessenger.ensureMarketplace(page, { timeoutMs: 3500 }).catch(() => {});
      return await virtusMessenger.listRecentUnreadChats(page);
    });
    
    const now = Date.now();
    for (const chat of chats) {
      if (!chat.id || chat.fromMine || !chat.recentEnough) continue;
      if (chat.isUnread !== true) continue; // MILITAR: só agenda coleta para não-lidos
      
      const idadeMs = Number(chat.idadeMs || 0);
      
      await updateCollectDue(perfil, chat.id, {
        firstSeenAt: now - idadeMs,
        dueAt: now + Math.max(0, AI_COLLECT_WINDOW_MS - idadeMs),
        previewSig: chat.previewSig || null,
        source: 'poll',
        batchId
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
    const batchId = stepLog.attemptId();
    let processed = 0;
    
    for (const evt of eventos) {
      try {
        const chatId = String(evt.chatId || '').trim();
        if (!chatId) continue;
        
        const now = Date.now();
        await updateCollectDue(perfil, chatId, {
          firstSeenAt: evt.ts || now,
          dueAt: now + AI_COLLECT_WINDOW_MS,
          source: 'observer',
          previewSig: evt.previewSig || null,
          batchId
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
  
  if (!virtusChatLock.acquire(perfil, chatId, 'collector')) {
    stepLog.appendJSONL(perfil, 'virtus_collector', { step:'collect_skip_chat_locked', chatId });
    return { ok:false, retry:true, reason:'chat_locked' };
  }
  
  const lockKey = `page:${page._virtusLockKey}`;
  return await withVirtusUiLock(perfil, 'collector_collect', chatId, lockKey, async () => {
    try {
      const collectOpenBeginAt = Date.now();
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_begin',
        chatId,
        collectOpenBeginAt
      });
      
      // Abre chat
      const opened = await virtusMessenger.openChat(page, chatId, { timeoutMs: 20000 });
      const collectOpenOkAt = Date.now();
      if (!opened) {
        stepLog.appendJSONL(perfil, 'virtus_collector', {
          attempt: attemptId,
          step: 'collect_fail_open',
          chatId
        });
        return { ok: false, retry: true, reason: 'open_failed' };
      }
      
      // Garante que conversa está pronta
      const ready = await virtusMessenger.ensureConversationReady(page, chatId, { timeoutMs: 20000 });
      if (!ready) {
        stepLog.appendJSONL(perfil, 'virtus_collector', {
          attempt: attemptId,
          step: 'collect_fail_ready',
          chatId
        });
        return { ok: false, retry: true, reason: 'ready_failed' };
      }
      
      // Coleta histórico
      const history = await virtusMessenger.scrapeHistory(page);
      const collectScrapeOkAt = Date.now();
      if (!Array.isArray(history) || history.length === 0) {
        stepLog.appendJSONL(perfil, 'virtus_collector', {
          attempt: attemptId,
          step: 'collect_empty_history',
          chatId
        });
        return { ok: false, retry: true, reason: 'empty_history' };
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
        // Não é erro -> não requeue em loop. Só volta a coletar se previewSig mudar.
        return { ok: true, retry: false, reason: 'no_new_client_bubble' };
      }
      
      // Computa hash do histórico
      const histSig = virtusIds.historySig(history);
      
      // Gera ID determinístico
      const eventId_val = virtusIds.eventId({
        perfil,
        chatId,
        histSig
      });

      // Dedupe global (inbox/processing/done/dead + replies/*)
      if (await collectedOrReplyExistsAnywhere(perfil, eventId_val)) {
        stepLog.appendJSONL(perfil, 'virtus_collector', {
          attempt: attemptId,
          step: 'collect_skip_duplicate_anywhere',
          chatId,
          eventId: eventId_val,
          histSig
        });
        return { ok: true, retry: false, reason: 'duplicate_anywhere', histSig, eventId: eventId_val };
      }
      
      // Lê collect_due para copiar firstSeenAt e dueAt
      const collectDueRecord = await readCollectDue(perfil, chatId).catch(() => null);
      
      // Cria record completo
      const record = {
        id: eventId_val,
        perfil,
        chatId,
        histSig,
        history,
        collectedAt: Date.now(),
        firstSeenAt: collectDueRecord?.firstSeenAt || Date.now(),
        dueAt: collectDueRecord?.dueAt || Date.now(),
        attemptId
      };
      
      const inboxDir = virtusV2Paths.collectedInboxDir(perfil);
      await virtusDiskQueue.ensureDir(inboxDir);
      const collectedFile = path.join(inboxDir, `${eventId_val}.json`);
      
      // Grava atomicamente
      await virtusDiskQueue.writeJsonAtomic(collectedFile, record);
      const collectWrittenAt = Date.now();
      
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_success',
        chatId,
        eventId: eventId_val,
        histSig,
        historyLen: history.length,
        collectOpenBeginAt,
        collectOpenOkAt,
        collectScrapeOkAt,
        collectWrittenAt
      });
      
      return { ok: true, retry: false, reason: 'collected', histSig, eventId: eventId_val };
    } catch (err) {
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        attempt: attemptId,
        step: 'collect_error',
        chatId,
        error: String(err)
      });
      logger.error(`[virtusCollector][${perfil}] Erro ao coletar chat ${chatId}`, { err });
      return { ok: false, retry: true, reason: 'exception', error: String(err) };
    } finally {
      virtusChatLock.release(perfil, chatId);
    }
  });
}

/**
 * Processa collect_due files que estão prontos (dueAt <= now)
 */
const DUE_BUCKET_MS = 2000;

function dueBucket(ts) { return Math.floor(Number(ts||0) / DUE_BUCKET_MS); }

async function processDueCollects(browser, perfil) {
  const dir = virtusV2Paths.collectDueDir(perfil);
  
  let files = [];
  try {
    files = await virtusDiskQueue.listJsonFiles(dir);
  } catch {
    return 0;
  }
  
  if (!files.length) return 0;
  
  const now = Date.now();
  const rows = [];
  
  for (const file of files) {
    try {
      const rec = await virtusDiskQueue.readJsonSafe(file, null);
      if (!rec || !rec.chatId) continue;
      
      const st = rec.stage || 'pending';
      if (st === 'collected' || st === 'dead') continue;
      
      if (rec.dueAt && rec.dueAt > now) continue;
      
      rows.push(rec);
    } catch {}
  }
  
  rows.sort((a,b) => (a.dueAt||0)-(b.dueAt||0) || (a.firstSeenAt||0)-(b.firstSeenAt||0));
  
  // agrupa
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.batchId || 'noBatch'}__${dueBucket(r.dueAt)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  
  let processed = 0;
  
  for (const [gk, grp] of groups.entries()) {
    const batchStartAt = Date.now();
    
    stepLog.appendJSONL(perfil, 'virtus_collector', {
      step: 'collect_batch_begin',
      batchKey: gk,
      n: grp.length,
      chatIds: grp.map(x => x.chatId)
    });
    
    await Promise.allSettled(grp.map(async (r) => {
      const io = await virtusPagePool.acquireIoPage(browser, perfil);
      if (!io || !io.page) return;
      
      try {
        // IMPORTANTÍSSIMO: se res.histSig === r.lastCollected?.histSig -> SKIP e marque collected sem recriar evento
        const res = await collectChatHistory(io.page, perfil, r.chatId);
        
        if (res && res.ok === true && res.retry === false) {
          // Se histSig igual ao último coletado, não recriar evento mas marcar como collected
          if (res.histSig === r.lastCollected?.histSig) {
            await updateCollectDue(perfil, r.chatId, {
              stage: 'collected',
              source: 'collect',
              previewSig: r.previewSig || null,
              lastCollected: r.lastCollected
            }).catch(() => {});
          } else {
            await updateCollectDue(perfil, r.chatId, {
              stage: 'collected',
              source: 'collect',
              previewSig: r.previewSig || null,
              lastCollected: {
                at: Date.now(),
                histSig: res.histSig || null,
                eventId: res.eventId || null,
                reason: res.reason || 'ok'
              }
            }).catch(() => {});
          }
        } else {
          const nextAttempts = Number(r.attempts || 0) + 1;
          const backoff = Math.min(300000, 5000 * Math.pow(2, Math.max(0, nextAttempts - 1)));
          const willDead = nextAttempts >= COLLECT_MAX_ATTEMPTS;
          await updateCollectDue(perfil, r.chatId, {
            firstSeenAt: r.firstSeenAt || now,
            dueAt: willDead ? (now + 60*60*1000) : (now + backoff),
            source: 'collect_retry',
            previewSig: r.previewSig || null,
            stage: willDead ? 'dead' : 'pending',
            attempts: nextAttempts,
            lastError: (res && res.reason) ? String(res.reason) : 'collect_failed'
          }).catch(() => {});
          stepLog.appendJSONL(perfil, 'virtus_collector', {
            step: willDead ? 'collect_due_deadletter' : 'collect_due_retry_scheduled',
            chatId: r.chatId,
            attempts: nextAttempts,
            backoffMs: willDead ? (60*60*1000) : backoff,
            reason: (res && res.reason) ? String(res.reason) : 'collect_failed'
          });
        }
      } finally {
        try { io.release(); } catch {}
      }
    }));
    
    const batchEndAt = Date.now();
    const batchSpreadMs = batchEndAt - batchStartAt;
    
    stepLog.appendJSONL(perfil, 'virtus_collector', {
      step: 'collect_batch_end',
      batchKey: gk,
      ms: batchSpreadMs
    });
    
    if (batchSpreadMs > 4000) {
      stepLog.appendJSONL(perfil, 'virtus_collector', {
        step: 'SLA_VIOLATION_collect_batch_spread',
        batchKey: gk,
        spreadMs: batchSpreadMs,
        n: grp.length
      });
    }
    
    processed += grp.length;
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
  virtusPagePool.getListPage(browser, perfil).then(async (page) => {
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
        
        const page = await virtusPagePool.getListPage(browser, perfil);
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

