// scripts/ia_extractor/saudacao.js

/**
 * Extrator para identificar se o cliente enviou uma saudação.
 * @param {Array} historico - Lista de mensagens [{autor, texto, ...}]
 * @returns {Object} - { saudacao: boolean|null }
 */
function extract(historico = []) {
  // Busca pelas principais saudações em português
  const SAUDACOES = /\b(ol[áa]|oi|boa\s?(noite|tarde|dia)|e[aií]|fala|salve|bom\s?(dia|tarde|noite))\b/i;
  for (let i = historico.length - 1; i >= 0; i--) {
    const txt = (historico[i].texto || '').trim().toLowerCase();
    if (txt && SAUDACOES.test(txt)) {
      return { saudacao: true };
    }
  }
  return {};
}

module.exports = { extract };