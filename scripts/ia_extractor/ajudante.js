// scripts/ia_extractor/ajudante.js

/**
 * Extrator para identificar se o cliente deseja ajudante (sim/não)
 * Busca por padrões simples nas últimas mensagens.
 * Pode ser evoluído para NLU no futuro.
 * 
 * @param {Array} historico - Lista de mensagens [{ autor, texto, ... }, ...]
 * @returns {Object} - { ajudante: boolean|null }
 */
function extract(historico = []) {
  // Varre de trás pra frente para pegar a resposta mais recente
  for (let i = historico.length - 1; i >= 0; i--) {
    const msg = (historico[i].texto || '').toLowerCase();

    // Padrões positivos (sim, quero ajudante, precisa de ajudante, etc)
    if (
      /\bsim\b/.test(msg) ||
      /\bpreciso\b/.test(msg) ||
      /\bquero\b/.test(msg) ||
      /\bcom ajudante\b/.test(msg) ||
      /\bajudante sim\b/.test(msg)
    ) {
      return { ajudante: true };
    }

    // Padrões negativos (não, dispensar ajudante, sem ajudante, etc)
    if (
      /\bn[aã]o\b/.test(msg) ||
      /\bsem ajudante\b/.test(msg) ||
      /\bdispensa/i.test(msg) ||
      /\bnão precisa\b/.test(msg) ||
      /\bnão quero\b/.test(msg)
    ) {
      return { ajudante: false };
    }
  }
  return {}; // Não encontrou, retornando vazio
}

module.exports = { extract };