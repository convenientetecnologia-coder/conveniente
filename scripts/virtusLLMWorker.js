'use strict';

/**
 * Virtus V2 - LLM Worker Stage (Processo Independente)
 * 
 * Responsabilidades EXCLUSIVAS:
 * - Consome collected/<perfil>/inbox/*.json
 * - Chama masterExtractAnswer (LLM)
 * - Escreve replies/<perfil>/inbox/*.json
 * - Move collected para done
 * 
 * REGRAS ABSOLUTAS:
 * - NUNCA interage com browser (processo separado)
 * - NUNCA processa coleta ou envio
 * - Nunca trava fila por item ruim (try/catch por item, sempre continua)
 * - Claim por rename = um worker por arquivo (idempotência)
 */

const path = require('path');
const fs = require('fs/promises');
const virtusDiskQueue = require('./virtusDiskQueue.js');
const virtusV2Paths = require('./virtusV2Paths.js');
const virtusIds = require('./virtusIds.js');
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');
const logger = require('./logger.js');
const stepLog = require('./stepLog.js');

// Constantes
const PROCESS_INTERVAL_MS = 2000; // 2s entre processamentos
const STALE_REQUEUE_MS = 5 * 60 * 1000; // 5min - itens presos em processing voltam para inbox
const MAX_ATTEMPTS = 3; // máximo de tentativas de processamento LLM

/**
 * Lista todos os perfis que têm collected/inbox
 */
async function listPerfisWithCollected() {
  const collectedBase = path.join(virtusV2Paths.BASE, 'collected');
  
  try {
    const entries = await fs.readdir(collectedBase, { withFileTypes: true });
    return entries
      .filter(ent => ent.isDirectory())
      .map(ent => ent.name);
  } catch {
    return [];
  }
}

/**
 * Verifica se reply existe em qualquer diretório (dedup global)
 */
async function replyExistsAnywhere(perfil, replyId) {
  const dirs = [
    virtusV2Paths.repliesInboxDir(perfil),
    virtusV2Paths.repliesScheduledDir(perfil),
    virtusV2Paths.repliesProcessingDir(perfil),
    virtusV2Paths.repliesSentDir(perfil),
    virtusV2Paths.repliesCanceledDir(perfil),
    virtusV2Paths.repliesDeadDir(perfil),
  ];

  for (const dir of dirs) {
    await virtusDiskQueue.ensureDir(dir);
    // existe como arquivo "normal"?
    try {
      await fs.access(path.join(dir, `${replyId}.json`));
      return true;
    } catch {}
  }

  // processing pode estar como *.json.claim-*
  try {
    const processingFiles = await virtusDiskQueue.listJsonFiles(virtusV2Paths.repliesProcessingDir(perfil));
    if (processingFiles.some(f => path.basename(f).startsWith(`${replyId}.json`))) return true;
  } catch {}

  return false;
}

/**
 * Processa um item collected/inbox
 */
async function processCollectedItem(perfil, collectedFile) {
  const attemptId = stepLog.attemptId();
  
  try {
    // Lê item coletado
    const collectedItem = await virtusDiskQueue.readJsonSafe(collectedFile, null);
    if (!collectedItem || !collectedItem.id) {
      logger.warn(`[virtusLLMWorker] Item coletado inválido`, { file: collectedFile });
      return false;
    }
    
    const replyId = collectedItem.id;
    const chatId = collectedItem.chatId;
    const history = collectedItem.history || [];
    const histSig = collectedItem.histSig || null;

    const repliesInboxDir = virtusV2Paths.repliesInboxDir(perfil);
    await virtusDiskQueue.ensureDir(repliesInboxDir);
    const replyFile = path.join(repliesInboxDir, `${replyId}.json`);
    
    stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
      attempt: attemptId,
      step: 'llm_begin',
      replyId,
      chatId,
      histSig,
      historyLen: history.length
    });
    
    // ===== HARD DEDUPE (ANTES DE GASTAR TOKEN) =====
    if (await replyExistsAnywhere(perfil, replyId)) {
      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_skip_reply_exists_pre',
        replyId,
        chatId,
        histSig
      });
      await moveCollectedToDone(perfil, collectedItem, collectedFile);
      return true;
    }

    // ===== CACHE EM DISCO: se já temos resultado LLM neste item, NUNCA chamar LLM de novo =====
    let llmCache = collectedItem.llm || null;
    if (llmCache && llmCache.finishedAt && typeof llmCache.shouldReply === 'boolean') {
      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_cache_hit',
        replyId,
        chatId,
        histSig,
        cachedShouldReply: llmCache.shouldReply,
        cachedAt: llmCache.finishedAt
      });
    } else {
      const mensagens = history;
      const contexto = { perfil, chatId, histSig };

      const startedAt = Date.now();
      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_call_begin',
        replyId,
        chatId,
        histSig
      });

      let result = null;
      try {
        result = await masterExtractAnswer({
          perfil,
          chatId,
          mensagens,
          contexto,
          respond: true
        });
      } catch (e) {
        result = {
          extraction: {},
          answer: 'Desculpa, tive um problema técnico aqui. Pode me enviar seu WhatsApp com DDD (apenas números), por favor?',
          control: { shouldReply: true, askField: 'telefone', finalMessage: false },
          meta: { confidence: 0.0, tokensUsed: 0, error: String((e && e.message) || e) }
        };
      }

      const finishedAt = Date.now();
      const replyText = (result && result.answer) ? String(result.answer).trim() : '';
      const shouldReply = !!(result && result.control && result.control.shouldReply && replyText && replyText.length >= 2);

      llmCache = {
        startedAt,
        finishedAt,
        shouldReply,
        replyText: shouldReply ? replyText : null,
        extraction: result && result.extraction ? result.extraction : {},
        control: result && result.control ? result.control : {},
        meta: result && result.meta ? result.meta : {}
      };

      // Persistir cache no PRÓPRIO arquivo claimed (processing) -> retry nunca re-chama LLM
      const updatedCollected = { ...collectedItem, llm: llmCache };
      await virtusDiskQueue.writeJsonAtomic(collectedFile, updatedCollected);
      Object.assign(collectedItem, updatedCollected);

      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_call_done_cached',
        replyId,
        chatId,
        histSig,
        llmMs: finishedAt - startedAt,
        tokensUsed: Number(llmCache.meta && llmCache.meta.tokensUsed) || 0,
        shouldReply
      });
    }
    
    // ===== Sem reply: marcar DONE e encerrar (sem loop) =====
    if (!llmCache || llmCache.shouldReply !== true || !llmCache.replyText) {
      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_no_reply',
        replyId,
        chatId,
        histSig,
        reason: (llmCache && llmCache.shouldReply === false) ? 'shouldReply_false' : 'answer_empty_or_uncached'
      });
      
      await moveCollectedToDone(perfil, collectedItem, collectedFile);
      return true;
    }
    
    const replyText = String(llmCache.replyText || '').trim();
    if (!replyText || replyText.length < 2) {
      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_no_reply',
        replyId,
        chatId,
        histSig,
        reason: 'answer_too_short'
      });
      
      await moveCollectedToDone(perfil, collectedItem, collectedFile);
      return true;
    }
    
    // Dedupe FINAL antes de escrever reply (pode existir por replay/restart)
    if (await replyExistsAnywhere(perfil, replyId)) {
      stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
        attempt: attemptId,
        step: 'llm_skip_duplicate_anywhere',
        replyId,
        chatId,
        histSig
      });
      
      await moveCollectedToDone(perfil, collectedItem, collectedFile);
      return true;
    }
    
    // Cria reply item
    const replyItem = {
      id: replyId,
      perfil,
      chatId,
      histSig,
      replyText,
      extraction: llmCache.extraction || {},
      control: llmCache.control || {},
      meta: llmCache.meta || {},
      collectedAt: collectedItem.collectedAt,
      firstSeenAt: collectedItem.firstSeenAt || null,
      dueAt: collectedItem.dueAt || null,
      llmAt: llmCache.finishedAt || Date.now(),
      attemptId
    };
    
    // Escreve reply atomicamente
    await virtusDiskQueue.writeJsonAtomic(replyFile, replyItem);
    
    // Append no ledger LLM
    const llmLedgerFile = virtusV2Paths.llmLedgerFile(perfil);
    await virtusDiskQueue.appendJsonl(llmLedgerFile, {
      id: replyId,
      chatId,
      perfil,
      histSig,
      replyTextSha1: virtusIds.textSha1(replyText),
      llmAt: llmCache.finishedAt || Date.now(),
      tokensUsed: llmCache.meta?.tokensUsed || 0,
      promptTokens: llmCache.meta?.promptTokens || 0,
      completionTokens: llmCache.meta?.completionTokens || 0,
      confidence: llmCache.meta?.confidence || 0
    });
    
    stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
      attempt: attemptId,
      step: 'llm_success',
      replyId,
      chatId,
      histSig,
      replyLen: replyText.length,
      tokensUsed: llmCache.meta?.tokensUsed || 0
    });
    
    // Move collected para done
    await moveCollectedToDone(perfil, collectedItem, collectedFile);
    
    return true;
  } catch (err) {
    stepLog.appendJSONL(perfil, 'virtus_llm_worker', {
      attempt: attemptId,
      step: 'llm_error',
      error: String(err)
    });
    logger.error(`[virtusLLMWorker] Erro ao processar collected item`, { file: collectedFile, err });
    
    // Lê item novamente para incrementar attempts
    try {
      const collectedItem = await virtusDiskQueue.readJsonSafe(collectedFile, null);
      if (!collectedItem) return false;
      
      const attempts = (collectedItem.attempts || 0) + 1;
      
      if (attempts >= MAX_ATTEMPTS) {
        // Manda para dead após N tentativas
        await moveCollectedToDead(perfil, collectedItem, collectedFile, `max_attempts_exceeded: ${attempts}`, String(err));
      } else {
        // Volta para inbox para retry
        await requeueCollectedItem(perfil, collectedItem, collectedFile, attempts, String(err));
      }
    } catch {
      // Falha ao ler/requeue, continua
    }
    
    return false;
  }
}

/**
 * Move collected item para done
 */
async function moveCollectedToDone(perfil, collectedItem, processingFile) {
  const collectedId = collectedItem.id;
  const doneDir = virtusV2Paths.collectedDoneDir(perfil);
  
  await virtusDiskQueue.ensureDir(doneDir);
  
  const doneFile = path.join(doneDir, `${collectedId}.json`);
  
  try {
    const doneItem = {
      ...collectedItem,
      doneAt: Date.now(),
      status: 'done'
    };
    await virtusDiskQueue.writeJsonAtomic(doneFile, doneItem);
    if (processingFile) await fs.unlink(processingFile).catch(() => {});
  } catch (err) {
    logger.warn(`[virtusLLMWorker] Erro ao mover para done`, { collectedId, err: String(err) });
  }
}

/**
 * Move collected item para dead
 */
async function moveCollectedToDead(perfil, collectedItem, processingFile, reason, error) {
  const collectedId = collectedItem.id;
  const deadDir = virtusV2Paths.collectedDeadDir(perfil);
  
  await virtusDiskQueue.ensureDir(deadDir);
  
  const deadFile = path.join(deadDir, `${collectedId}.json`);
  
  try {
    const deadItem = {
      ...collectedItem,
      deadAt: Date.now(),
      deadReason: reason,
      lastError: error,
      status: 'dead'
    };
    await virtusDiskQueue.writeJsonAtomic(deadFile, deadItem);
    if (processingFile) await fs.unlink(processingFile).catch(() => {});
  } catch (err) {
    logger.warn(`[virtusLLMWorker] Erro ao mover para dead`, { collectedId, err: String(err) });
  }
}

/**
 * Requeue collected item (volta para inbox para retry)
 */
async function requeueCollectedItem(perfil, collectedItem, processingFile, attempts, error) {
  const collectedId = collectedItem.id;
  const inboxDir = virtusV2Paths.collectedInboxDir(perfil);
  
  await virtusDiskQueue.ensureDir(inboxDir);
  
  // Remove sufixo de claim para voltar ao nome original
  const baseName = virtusDiskQueue.stripClaimSuffix(path.basename(processingFile));
  const inboxFile = path.join(inboxDir, baseName);
  
  try {
    const requeuedItem = {
      ...collectedItem,
      attempts,
      lastError: error,
      lastErrorAt: Date.now()
    };
    await virtusDiskQueue.writeJsonAtomic(inboxFile, requeuedItem);
    if (processingFile) await fs.unlink(processingFile).catch(() => {});
  } catch (err) {
    logger.warn(`[virtusLLMWorker] Erro ao requeue item`, { collectedId, err: String(err) });
  }
}

/**
 * Processa inbox de um perfil
 */
async function processPerfilInbox(perfil) {
  const inboxDir = virtusV2Paths.collectedInboxDir(perfil);
  
  let files = [];
  try {
    files = await virtusDiskQueue.listJsonFiles(inboxDir);
  } catch {
    return 0;
  }
  
  if (files.length === 0) return 0;
  
  // PATCH #6: Ordenação determinística por collectedAt (ou mtime)
  const items = [];
  for (const file of files) {
    try {
      const item = await virtusDiskQueue.readJsonSafe(file, null);
      if (item && item.id) {
        const stats = await fs.stat(file).catch(() => ({ mtimeMs: 0 }));
        items.push({ file, item, collectedAt: item.collectedAt || stats.mtimeMs });
      }
    } catch {}
  }
  
  // Ordena por collectedAt asc (FIFO real)
  items.sort((a, b) => a.collectedAt - b.collectedAt);
  
  if (items.length === 0) return 0;
  
  // Processa primeiro item (claim por rename)
  const firstFile = items[0].file;
  
  // Claim via rename para processing
  const processingDir = virtusV2Paths.collectedProcessingDir(perfil);
  await virtusDiskQueue.ensureDir(processingDir);
  
  let claimedFile = null;
  try {
    claimedFile = await virtusDiskQueue.claimFile(firstFile, processingDir);
  } catch (err) {
    // Claim falhou (arquivo já foi claimado por outro worker ou não existe mais)
    return 0;
  }
  
  // Processa item
  await processCollectedItem(perfil, claimedFile);
  
  return 1;
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
    logger.warn(`[virtusLLMWorker] Requeued ${moved} stale items from processing (${perfil})`);
  }
  
  return moved;
}

/**
 * Loop principal do LLM Worker
 */
async function mainLoop() {
  logger.info('[virtusLLMWorker] Iniciando Virtus LLM Worker V2');
  
  while (true) {
    try {
      // Lista perfis com collected/inbox
      const perfis = await listPerfisWithCollected();
      
      // Processa inbox de cada perfil (um item por vez)
      for (const perfil of perfis) {
        try {
          await processPerfilInbox(perfil);
        } catch (err) {
          logger.warn(`[virtusLLMWorker] Erro ao processar perfil`, { perfil, err: String(err) });
        }
      }
      
      // Requeue stale processing de cada perfil
      for (const perfil of perfis) {
        try {
          await requeueStaleProcessing(perfil);
        } catch (err) {
          logger.warn(`[virtusLLMWorker] Erro ao requeue stale`, { perfil, err: String(err) });
        }
      }
    } catch (err) {
      logger.error('[virtusLLMWorker] Erro no main loop', { err });
    }
    
    // Aguarda próximo ciclo
    await new Promise((r) => setTimeout(r, PROCESS_INTERVAL_MS));
  }
}

// Inicia worker se executado diretamente
if (require.main === module) {
  mainLoop().catch((err) => {
    logger.error('[virtusLLMWorker] Erro fatal', { err });
    process.exit(1);
  });
}

module.exports = {};

