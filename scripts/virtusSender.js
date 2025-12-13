'use strict';

/**
 * Virtus V2 - Sender Stage
 * 
 * Responsabilidades EXCLUSIVAS:
 * - Consome replies/<perfil>/inbox/*.json
 * - Agenda envios com sendAt (anti-flood persistente)
 * - Envia mensagens via browser
 * - Registra envios no ledger (idempotência)
 * 
 * REGRAS ABSOLUTAS:
 * - NUNCA chama LLM (não tem acesso a OpenAI)
 * - NUNCA processa coleta
 * - Verifica 3 barreiras antes de enviar (arquivo sent, ledger, último outgoing)
 * - Verifica histSig antes de enviar (stale reply → canceled)
 */

const path = require('path');
const fs = require('fs/promises');
const virtusDiskQueue = require('./virtusDiskQueue.js');
const virtusV2Paths = require('./virtusV2Paths.js');
const virtusIds = require('./virtusIds.js');
const virtusMessenger = require('./virtusMessenger.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');
const { withVirtusUiLock } = require('./virtusUiLock.js');

// Constantes
const MIN_SEND_DELAY_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '30000', 10); // 30s
const MAX_SEND_DELAY_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '90000', 10); // 90s
const STALE_REQUEUE_MS = 5 * 60 * 1000; // 5min - itens presos em processing voltam para inbox
const MAX_ATTEMPTS = 3; // máximo de tentativas de envio

/**
 * Helper: random entre min e max
 */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Helper: garante que página está disponível
 */
async function ensurePage(browser, perfil) {
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
 * Lê estado de send_state/<perfil>.json (nextSendSlotAt persistente)
 */
async function readSendState(perfil) {
  const file = virtusV2Paths.sendStateFile(perfil);
  return await virtusDiskQueue.readJsonSafe(file, { nextSendSlotAt: 0 });
}

/**
 * Atualiza estado de send_state/<perfil>.json (nextSendSlotAt persistente)
 */
async function updateSendState(perfil, updates) {
  const file = virtusV2Paths.sendStateFile(perfil);
  const current = await readSendState(perfil);
  const updated = { ...current, ...updates, updatedAt: Date.now() };
  await virtusDiskQueue.writeJsonAtomic(file, updated);
  return updated;
}

/**
 * Verifica se item já foi enviado (3 barreiras cumulativas)
 */
async function isAlreadySent(perfil, replyId, replyText) {
  // Barreira 1: arquivo sent existe
  const sentDir = virtusV2Paths.repliesSentDir(perfil);
  await virtusDiskQueue.ensureDir(sentDir);
  const sentFile = path.join(sentDir, `${replyId}.json`);
  
  try {
    await fs.access(sentFile);
    return true; // Arquivo existe → já foi enviado
  } catch {
    // Arquivo não existe, continua verificando
  }
  
  // Barreira 2: ledger tem ID
  const ledgerFile = virtusV2Paths.sentLedgerFile(perfil);
  try {
    const content = await fs.readFile(ledgerFile, 'utf8').catch(() => '');
    if (content.includes(replyId)) {
      return true; // ID está no ledger → já foi enviado
    }
  } catch {
    // Ledger não existe ou erro de leitura, continua
  }
  
  // Barreira 3: último outgoing no chat já é igual ao texto
  // (Essa verificação será feita durante o envio, no processSend)
  
  return false;
}

/**
 * Agenda um reply para envio (calcula sendAt com anti-flood persistente)
 */
async function scheduleReply(perfil, replyItem) {
  const replyId = replyItem.id;
  const inboxDir = virtusV2Paths.repliesInboxDir(perfil);
  const scheduledDir = virtusV2Paths.repliesScheduledDir(perfil);
  
  await virtusDiskQueue.ensureDir(scheduledDir);
  
  // Lê send_state para obter nextSendSlotAt persistente
  const sendState = await readSendState(perfil);
  const now = Date.now();
  
  // Calcula delay aleatório
  const randomDelay = randomBetween(MIN_SEND_DELAY_MS, MAX_SEND_DELAY_MS);
  
  // Calcula sendAt garantindo que respeita nextSendSlotAt (anti-flood monotônico)
  const proposedSendAt = now + randomDelay;
  const sendAt = Math.max(proposedSendAt, sendState.nextSendSlotAt || now);
  
  // Adiciona sendAt ao item (copia firstSeenAt)
  const scheduledItem = {
    ...replyItem,
    sendAt,
    scheduledAt: now,
    firstSeenAt: replyItem.firstSeenAt || replyItem.llmAt || now
  };
  
  // Move de inbox para scheduled
  const inboxFile = path.join(inboxDir, `${replyId}.json`);
  const scheduledFile = path.join(scheduledDir, `${replyId}.json`);
  
  try {
    // NÃO avance sendState se o inboxFile nem existe.
    await fs.access(inboxFile);

    // Move primeiro, escreve depois.
    await virtusDiskQueue.moveFile(inboxFile, scheduledFile);
    await virtusDiskQueue.writeJsonAtomic(scheduledFile, scheduledItem);

    // Agora sim: avance o sendState (somente após sucesso).
    const newNextSendSlotAt = sendAt + MIN_SEND_DELAY_MS;
    await updateSendState(perfil, { nextSendSlotAt: newNextSendSlotAt });
    
    stepLog.appendJSONL(perfil, 'virtus_sender', {
      step: 'reply_scheduled',
      replyId,
      chatId: replyItem.chatId,
      sendAt,
      delayMs: sendAt - now
    });
    
    return true;
  } catch (err) {
    logger.warn(`[virtusSender][${perfil}] Erro ao agendar reply`, { replyId, err: String(err) });
    return false;
  }
}

/**
 * Helper: finaliza arquivo de reply (escreve destino e deleta claimed)
 */
async function finalizeReplyFile({ perfil, replyId, targetDir, item, claimedFile }) {
  await virtusDiskQueue.ensureDir(targetDir);
  const dest = path.join(targetDir, `${replyId}.json`);
  await virtusDiskQueue.writeJsonAtomic(dest, item);
  if (claimedFile) await fs.unlink(claimedFile).catch(() => {});
  return dest;
}

/**
 * Reagenda um reply que falhou (move de volta para scheduled)
 */
async function requeueClaimed(perfil, replyItem, claimedFile, attempts, delayMs = 30_000, reason = '') {
  const replyId = replyItem.id;
  const scheduledDir = virtusV2Paths.repliesScheduledDir(perfil);
  await virtusDiskQueue.ensureDir(scheduledDir);
  const scheduledFile = path.join(scheduledDir, `${replyId}.json`);

  const now = Date.now();
  const retrySendAt = now + Math.max(5000, delayMs);
  const updatedItem = {
    ...replyItem,
    attempts,
    sendAt: retrySendAt,
    lastError: reason || replyItem.lastError || null,
    lastErrorAt: now
  };

  await virtusDiskQueue.writeJsonAtomic(scheduledFile, updatedItem);
  if (claimedFile) await fs.unlink(claimedFile).catch(() => {});

  stepLog.appendJSONL(perfil, 'virtus_sender', {
    step: 'send_requeued',
    replyId,
    chatId: replyItem.chatId,
    attempts,
    retrySendAt,
    delayMs: retrySendAt - now,
    reason: reason || null
  });
}

/**
 * Processa item scheduled (envia se sendAt <= now)
 */
async function processScheduledReply(browser, perfil, replyItem, { claimedFile } = {}) {
  const replyId = replyItem.id;
  const chatId = replyItem.chatId;
  const replyText = replyItem.replyText || replyItem.text || '';
  const histSig = replyItem.histSig;
  const attemptId = stepLog.attemptId();
  
  try {
    stepLog.appendJSONL(perfil, 'virtus_sender', {
      attempt: attemptId,
      step: 'send_begin',
      replyId,
      chatId
    });
    
    // Verifica se já foi enviado (barreiras 1 e 2)
    if (await isAlreadySent(perfil, replyId, replyText)) {
      stepLog.appendJSONL(perfil, 'virtus_sender', {
        attempt: attemptId,
        step: 'send_skip_already_sent',
        replyId,
        chatId
      });
      
      // Move para sent mesmo sem reenviar (já está enviado)
      await moveToSent(perfil, replyItem, claimedFile);
      return true;
    }
    
    // Garante página
    const page = await ensurePage(browser, perfil);
    if (!page) {
      throw new Error('no_page');
    }
    
    return await withVirtusUiLock(perfil, 'sender_send', chatId, async () => {
      // Abre chat
      const opened = await virtusMessenger.openChat(page, chatId, { timeoutMs: 20000 });
      if (!opened) {
        throw new Error('open_failed');
      }
      
      // Verifica histSig atual do chat (stale reply check)
      const currentHistory = await virtusMessenger.scrapeHistory(page);
      const currentHistSig = virtusIds.historySig(currentHistory);
      
      if (currentHistSig !== histSig) {
        // HistSig mudou → resposta está stale → move para canceled
        stepLog.appendJSONL(perfil, 'virtus_sender', {
          attempt: attemptId,
          step: 'send_canceled_stale',
          replyId,
          chatId,
          oldHistSig: histSig,
          newHistSig: currentHistSig
        });
        
        await moveToCanceled(perfil, replyItem, 'histSig_changed', claimedFile);
        return true; // finalizado (canceled)
      }
      
      // Barreira 3: verifica último outgoing no chat
      const lastOutgoing = await virtusMessenger.readLastOutgoingText(page);
      if (lastOutgoing && lastOutgoing.trim() === replyText.trim()) {
        // Último envio já é igual ao texto → já foi enviado
        stepLog.appendJSONL(perfil, 'virtus_sender', {
          attempt: attemptId,
          step: 'send_skip_last_outgoing_match',
          replyId,
          chatId
        });
        
        await moveToSent(perfil, replyItem, claimedFile);
        return true;
      }
      
      // Envia mensagem
      const sent = await virtusMessenger.sendText(page, chatId, replyText);
      if (!sent) {
        throw new Error('send_ack_failed');
      }
      
      // Move para sent e registra no ledger
      await moveToSent(perfil, replyItem, claimedFile);
      
      stepLog.appendJSONL(perfil, 'virtus_sender', {
        attempt: attemptId,
        step: 'send_success',
        replyId,
        chatId
      });
      
      return true;
    });
  } catch (err) {
    stepLog.appendJSONL(perfil, 'virtus_sender', {
      attempt: attemptId,
      step: 'send_error',
      replyId,
      chatId,
      error: String(err)
    });
    logger.error(`[virtusSender][${perfil}] Erro ao enviar reply ${replyId}`, { err });
    
    const attempts = (replyItem.attempts || 0) + 1;
    const reason = String((err && err.message) || err);
    if (attempts >= MAX_ATTEMPTS) {
      await moveToDead(perfil, replyItem, `max_attempts_exceeded: ${attempts} reason=${reason}`, claimedFile);
    } else {
      await requeueClaimed(perfil, replyItem, claimedFile, attempts, 30_000, reason);
    }
    
    return false;
  }
}

/**
 * Move item para sent e registra no ledger
 */
async function moveToSent(perfil, replyItem, claimedFile) {
  const replyId = replyItem.id;
  const sentDir = virtusV2Paths.repliesSentDir(perfil);
  
  const sentItem = {
    ...replyItem,
    sentAt: Date.now(),
    status: 'sent',
    firstSeenAt: replyItem.firstSeenAt || replyItem.llmAt || Date.now()
  };
  
  await finalizeReplyFile({
    perfil,
    replyId,
    targetDir: sentDir,
    item: sentItem,
    claimedFile
  });
  
  // Append no ledger (idempotência)
  const ledgerFile = virtusV2Paths.sentLedgerFile(perfil);
  await virtusDiskQueue.appendJsonl(ledgerFile, {
    id: replyId,
    chatId: replyItem.chatId,
    perfil,
    histSig: replyItem.histSig,
    textSha1: virtusIds.textSha1(replyItem.replyText || replyItem.text || ''),
    sentAt: Date.now()
  });
}

/**
 * Move item para canceled
 */
async function moveToCanceled(perfil, replyItem, reason, claimedFile) {
  const replyId = replyItem.id;
  const canceledDir = virtusV2Paths.repliesCanceledDir(perfil);
  
  const canceledItem = {
    ...replyItem,
    canceledAt: Date.now(),
    canceledReason: reason,
    status: 'canceled'
  };
  
  await finalizeReplyFile({
    perfil,
    replyId,
    targetDir: canceledDir,
    item: canceledItem,
    claimedFile
  });
}

/**
 * Move item para dead (falha permanente)
 */
async function moveToDead(perfil, replyItem, reason, claimedFile) {
  const replyId = replyItem.id;
  const deadDir = virtusV2Paths.repliesDeadDir(perfil);
  
  const deadItem = {
    ...replyItem,
    deadAt: Date.now(),
    deadReason: reason,
    status: 'dead'
  };
  
  await finalizeReplyFile({
    perfil,
    replyId,
    targetDir: deadDir,
    item: deadItem,
    claimedFile
  });
}

/**
 * Requeue scheduled (retry após falha)
 */
async function requeueScheduled(perfil, replyItem, attempts) {
  const replyId = replyItem.id;
  const scheduledDir = virtusV2Paths.repliesScheduledDir(perfil);
  const scheduledFile = path.join(scheduledDir, `${replyId}.json`);
  
  const now = Date.now();
  const retrySendAt = now + 30000; // retry em 30s
  
  const updatedItem = {
    ...replyItem,
    sendAt: retrySendAt,
    attempts,
    lastErrorAt: now
  };
  
  await virtusDiskQueue.writeJsonAtomic(scheduledFile, updatedItem);
}

/**
 * Processa replies/inbox (agenda para envio)
 */
async function processInboxReplies(perfil) {
  const inboxDir = virtusV2Paths.repliesInboxDir(perfil);
  
  let files = [];
  try {
    files = await virtusDiskQueue.listJsonFiles(inboxDir);
  } catch {
    return 0;
  }
  
  // FIFO real: ordenar por firstSeenAt/collectedAt/mtime
  const items = [];
  for (const file of files) {
    try {
      const replyItem = await virtusDiskQueue.readJsonSafe(file, null);
      if (!replyItem || !replyItem.id) continue;
      const st = await fs.stat(file).catch(() => ({ mtimeMs: 0 }));
      const ts = Number(replyItem.firstSeenAt || replyItem.collectedAt || replyItem.llmAt || st.mtimeMs || 0);
      items.push({ file, replyItem, ts });
    } catch (err) {
      logger.warn(`[virtusSender][${perfil}] Erro ao processar inbox reply`, { file, err: String(err) });
    }
  }
  items.sort((a, b) => a.ts - b.ts);

  let processed = 0;
  for (const it of items) {
    try {
      await scheduleReply(perfil, it.replyItem);
      processed++;
    } catch {}
  }
  
  return processed;
}

/**
 * Processa replies/scheduled (envia se sendAt <= now)
 */
async function processScheduledReplies(browser, perfil) {
  const scheduledDir = virtusV2Paths.repliesScheduledDir(perfil);
  
  let files = [];
  try {
    files = await virtusDiskQueue.listJsonFiles(scheduledDir);
  } catch {
    return 0;
  }
  
  // PATCH #6: Ordenação determinística por sendAt
  const items = [];
  const now = Date.now();
  for (const file of files) {
    try {
      const replyItem = await virtusDiskQueue.readJsonSafe(file, null);
      if (replyItem && replyItem.id && replyItem.sendAt) {
        items.push({ file, replyItem });
      }
    } catch {}
  }
  
  // Ordena por sendAt asc (FIFO real)
  items.sort((a, b) => (a.replyItem.sendAt || 0) - (b.replyItem.sendAt || 0));
  
  let processed = 0;
  
  for (const { file, replyItem } of items) {
    try {
      // Se não está due ainda, skip
      if (replyItem.sendAt > now) continue;
      
      // Claim via rename para processing
      const processingDir = virtusV2Paths.repliesProcessingDir(perfil);
      await virtusDiskQueue.ensureDir(processingDir);
      const claimedFile = await virtusDiskQueue.claimFile(file, processingDir);
      
      // Releia o arquivo claimed (pode ter sido atualizado)
      const claimedItem = await virtusDiskQueue.readJsonSafe(claimedFile, replyItem);
      
      // Processa envio
      await processScheduledReply(browser, perfil, claimedItem, { claimedFile });
      processed++;
    } catch (err) {
      logger.warn(`[virtusSender][${perfil}] Erro ao processar scheduled reply`, { file, err: String(err) });
    }
  }
  
  return processed;
}

/**
 * Requeue itens stale em processing
 */
async function requeueStaleProcessing(perfil) {
  const processingDir = virtusV2Paths.repliesProcessingDir(perfil);
  const scheduledDir = virtusV2Paths.repliesScheduledDir(perfil);
  
  await virtusDiskQueue.ensureDir(processingDir);
  await virtusDiskQueue.ensureDir(scheduledDir);
  
  const moved = await virtusDiskQueue.requeueStale(processingDir, scheduledDir, STALE_REQUEUE_MS);
  
  if (moved > 0) {
    logger.warn(`[virtusSender][${perfil}] Requeued ${moved} stale items from processing`);
  }
  
  return moved;
}

/**
 * Inicia o sender Virtus V2
 * 
 * @param {Browser} browser - Instância do Puppeteer Browser
 * @param {string} perfil - Nome do perfil
 * @param {Object} options - Opções
 * @param {number} options.epoch - Epoch do browser (fence para restart safety)
 * @returns {Object} { stop: async function() }
 */
function startVirtusSender(browser, perfil, options = {}) {
  const { epoch = 0 } = options;
  let running = true;
  
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
  
  logger.info(`[virtusSender][${perfil}] Iniciando Virtus Sender V2`);
  stepLog.appendJSONL(perfil, 'virtus_sender', { step: 'start', epoch });
  
  // Loop de processamento de inbox (agenda replies)
  async function inboxLoop() {
    while (running && epochOk()) {
      try {
        if (manifestFrozenUntil > Date.now()) {
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        
        await processInboxReplies(perfil);
      } catch (err) {
        logger.warn(`[virtusSender][${perfil}] Erro no inbox loop`, { err: String(err) });
      }
      
      await new Promise((r) => setTimeout(r, 2000)); // processa a cada 2s
    }
  }
  
  // Loop de processamento de scheduled (envia replies)
  async function scheduledLoop() {
    while (running && epochOk()) {
      try {
        if (manifestFrozenUntil > Date.now()) {
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }
        
        await processScheduledReplies(browser, perfil);
      } catch (err) {
        logger.warn(`[virtusSender][${perfil}] Erro no scheduled loop`, { err: String(err) });
      }
      
      await new Promise((r) => setTimeout(r, 3000)); // processa a cada 3s
    }
  }
  
  // Loop de requeue stale
  async function requeueLoop() {
    while (running && epochOk()) {
      try {
        await requeueStaleProcessing(perfil);
      } catch (err) {
        logger.warn(`[virtusSender][${perfil}] Erro no requeue loop`, { err: String(err) });
      }
      
      await new Promise((r) => setTimeout(r, 60000)); // requeue a cada 1min
    }
  }
  
  // Inicia loops
  inboxLoop();
  scheduledLoop();
  requeueLoop();
  
  return {
    stop: async () => {
      running = false;
      stepLog.appendJSONL(perfil, 'virtus_sender', { step: 'stop' });
      logger.info(`[virtusSender][${perfil}] Virtus Sender V2 parado`);
    }
  };
}

module.exports = {
  startVirtusSender
};

