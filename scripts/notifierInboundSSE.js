'use strict';

/**
 * Módulo de ingestão inbound de notificações/eventos via SSE (EventSource) do Notificador Virtus.
 *
 * - Um EventSource por perfil
 * - Cada mensagem recebida dispara queueMessengerSend pelo Virtus para resposta ao chat correto
 * - Deduplificação agressiva por key: chatId||respostaSan
 * - Nenhuma forma de polling ou fallback
 */

const EventSource = require('eventsource'); // Instale eventsource (`npm i eventsource`)
const logger = require('./logger.js');
const stepLog = require('./stepLog.js');
const audit = stepLog.audit;

// Referência para pendingKey dedup com Virtus
const virtus = require('./virtus.js'); // Assuma que virtus.js exporta getPendingSet ou seja injetado

const activeSSE = new Map(); // perfil -> EventSource instance

/**
 * Inicia e mantém conexão SSE com o notificador, ouvindo por respostas do Virtus.
 * @param {string} perfil - nome/slug do perfil.
 * @param {object} options - { url: baseURL do notificador, servidor: nomeServidor }
 */
function iniciarSSE(perfil, { url, servidor }) {
  if (activeSSE.has(perfil)) return;
  const endpoint = `${url.replace(/\/$/, '')}/api/virtus/stream?servidor=${encodeURIComponent(servidor)}&perfil=${encodeURIComponent(perfil)}`;
  logger.info(`[NOTIFIER_SSE] Conectando SSE para perfil=${perfil}: ${endpoint}`);
  stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_start', perfil, url: endpoint, ts: Date.now() });

  const es = new EventSource(endpoint, { withCredentials: false, rejectUnauthorized: false });
  activeSSE.set(perfil, es);

  es.onopen = () => {
    logger.info(`[NOTIFIER_SSE] SSE Aberto para perfil=${perfil}`);
    stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_open', perfil, url: endpoint });
  };

  es.onerror = (err) => {
    logger.error(`[NOTIFIER_SSE] SSE erro para perfil=${perfil}: `, err);
    stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_error', perfil, url: endpoint, err: err && err.message || String(err) });
    // Reconeção automática (EventSource padrão costuma lidar, mas documente)
  };

  es.onmessage = async (evt) => {
    try {
      if (!evt || !evt.data) return;
      const data = JSON.parse(evt.data);

      if (!data || !data.chat_id || !data.resposta) {
        logger.warn('[NOTIFIER_SSE] Mensagem SSE malformada', { perfil, raw: evt.data });
        stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_msg_malformed', perfil, raw: evt.data });
        return;
      }

      const respostaSan = String(data.resposta || '').trim();
      const key = `${data.chat_id}||${respostaSan}`;
      // Deduplificação ultra forte: pendingKeysPorPerfil do Virtus
      let perfilKeySet = null;
      try {
        perfilKeySet = virtus.getPendingSet ? virtus.getPendingSet(perfil) : null;
      } catch {}

      if (perfilKeySet && perfilKeySet.has(key)) {
        logger.debug('[NOTIFIER_SSE] Resposta duplicada ignorada', { perfil, chatId: data.chat_id, key });
        stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_msg_dup', perfil, chatId: data.chat_id, key });
        return;
      }

      // Chama queueMessengerSend do Virtus
      if (typeof virtus.queueMessengerSend === 'function') {
        await virtus.queueMessengerSend(perfil, {
          chatId: data.chat_id,
          resposta: respostaSan,
          key,
          origin: 'notifier_sse'
          // cursorSig pode ser preenchido no Virtus com base no state atual, se necessário!
        });
      } else {
        logger.error('[NOTIFIER_SSE] virtus.queueMessengerSend não disponível');
        stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_queue_fn_missing', perfil, chatId: data.chat_id });
      }

      if (perfilKeySet) perfilKeySet.add(key);

      stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_msg_accepted', perfil, chatId: data.chat_id, key });
    } catch (e) {
      logger.error('[NOTIFIER_SSE] Erro processando mensagem SSE', { perfil, error: e && e.message || e });
      stepLog.appendJSONL(perfil, 'virtus', { step: 'notifier_sse_msg_error', perfil, err: (e && e.message) || String(e) });
    }
  };
}

/**
 * Fecha/desconecta SSE para um perfil (se necessário).
 */
function stopSSE(perfil) {
  if (!activeSSE.has(perfil)) return;
  try {
    activeSSE.get(perfil).close();
    logger.info(`[NOTIFIER_SSE] SSE desconectada para perfil=${perfil}`);
  } catch {}
  activeSSE.delete(perfil);
}

module.exports = { iniciarSSE, stopSSE };

