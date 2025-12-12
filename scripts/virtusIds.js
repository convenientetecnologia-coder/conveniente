'use strict';

/**
 * Virtus V2 - Deterministic IDs
 * 
 * Gera IDs determinísticos baseados em hash SHA1.
 * Isso garante deduplicação perfeita: mesmo histórico = mesmo ID.
 * 
 * Propriedades:
 * - Idempotente: mesma entrada sempre gera mesmo ID
 * - Determinístico: sem aleatoriedade
 * - Colisão-resistente: SHA1 tem baixíssima probabilidade de colisão
 */

const crypto = require('crypto');

/**
 * Normaliza string para comparação consistente
 * 
 * Processo:
 * 1. Remove acentos (NFD normalization)
 * 2. Normaliza espaços (múltiplos espaços vira um)
 * 3. Trim (remove espaços nas bordas)
 */
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Remove acentos
    .replace(/\s+/g, ' ')              // Normaliza espaços
    .trim();
}

/**
 * Gera hash SHA1 do histórico de mensagens
 * 
 * Usado para:
 * - Detectar histórico duplicado
 * - Criar IDs determinísticos
 * - Cancelar respostas quando histórico muda
 * 
 * @param {Array} history - Array de mensagens { autor, texto }
 * @returns {string} Hash SHA1 hexadecimal (40 caracteres)
 */
function historySig(history) {
  const slim = (Array.isArray(history) ? history : []).map(m => ({
    a: String(m.autor || ''),
    t: norm(m.texto || '')
  }));
  
  const json = JSON.stringify(slim);
  return crypto.createHash('sha1').update(json).digest('hex');
}

/**
 * Gera ID determinístico único para um evento de coleta
 * 
 * Estrutura: virtus_v2|perfil|chatId|histSig
 * 
 * Propriedades:
 * - Mesmo perfil + chatId + histórico = mesmo ID
 * - Diferente histórico = diferente ID
 * - Permite deduplicação perfeita
 * 
 * @param {Object} params
 * @param {string} params.perfil - Nome do perfil
 * @param {string} params.chatId - ID do chat no Messenger
 * @param {string} params.histSig - Hash do histórico (gerado por historySig)
 * @returns {string} ID determinístico (hash SHA1 hexadecimal)
 */
function eventId({ perfil, chatId, histSig }) {
  const s = `virtus_v2|${perfil}|${chatId}|${histSig}`;
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * Gera hash SHA1 de um texto
 * 
 * Usado para:
 * - Comparar textos de resposta
 * - Detectar duplicatas de envio
 * - Verificar se mensagem já foi enviada
 * 
 * @param {string} text - Texto a ser hasheado
 * @returns {string} Hash SHA1 hexadecimal (40 caracteres)
 */
function textSha1(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

module.exports = {
  historySig,
  eventId,
  textSha1
};

