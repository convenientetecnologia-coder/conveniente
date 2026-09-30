"use strict";

const INGEST_CONTRACT_VERSION = 2;
const HISTORY_CONTRACT = "account_baseline_v2";

function normalizeMs(value) {
  const n = Number(value || 0) || 0;
  return n > 0 ? n : 0;
}

/**
 * Contrato soberano do ouvido:
 * - thread desconhecida + mensagem anterior à primeira escuta da conta = caixa histórica;
 * - thread conhecida + mensagem até a marca d'água = replay;
 * - qualquer mensagem posterior às marcas = atendimento, sem prazo máximo.
 */
function classifyInbound({
  messageAt,
  arrivalAt,
  initializedAt,
  baselineGraceMs = 3000,
  messageTimestampTrusted = true,
  threadKnown = false,
  threadHighWatermark = 0,
} = {}) {
  const msgAt = normalizeMs(messageAt);
  const arrivedAt = normalizeMs(arrivalAt);
  const initAt = normalizeMs(initializedAt);
  const grace = Math.max(0, Number(baselineGraceMs || 0) || 0);
  const highWatermark = normalizeMs(threadHighWatermark);

  if (!msgAt) {
    return { action: "accept", reason: "missing_message_time_fail_open" };
  }

  if (threadKnown && highWatermark > 0 && msgAt <= highWatermark) {
    return {
      action: "skip",
      reason: "thread_high_watermark_replay",
      highWatermark,
    };
  }

  // Timestamp real da Meta usa a fronteira exata. A folga de boot só vale
  // quando a Meta não forneceu relógio e tivemos de usar a chegada local.
  const baselineThrough = initAt > 0
    ? (initAt + (messageTimestampTrusted ? 0 : grace))
    : 0;
  const timeForBaseline = messageTimestampTrusted ? msgAt : (arrivedAt || msgAt);
  if (!threadKnown && baselineThrough > 0 && timeForBaseline <= baselineThrough) {
    return {
      action: "skip",
      reason: "predates_account_baseline",
      baselineThrough,
    };
  }

  return { action: "accept", reason: "new_after_persistent_marks" };
}

module.exports = {
  INGEST_CONTRACT_VERSION,
  HISTORY_CONTRACT,
  classifyInbound,
};
