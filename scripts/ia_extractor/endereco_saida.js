// scripts/ia_extractor/endereco_saida.js

/**
 * Extrai possível endereço de SAÍDA (origem) da conversa do cliente.
 * Estratégia: busca padrões básicos de endereço (rua, avenida, n°, bairro, etc).
 * @param {Array} historico 
 * @returns {Object} - { endereco_saida: string|null }
 */
function extract(historico = []) {
  const ENDERECO_PATTERNS = [
    /\b(rua|av(enida)?|travessa|estrada|rodovia|praça|r\.)\b/i,
    /\bapto\b|\bapt\b|\blote\b|\bbloco\b|\bedif\b/i,
    /\bcep[:\s]*\d{5}-?\d{3}\b/i,
    /\bn[úu]mero?[:\s]*\d+/i,
    /\b\d{5}-\d{3}\b/i // CEP “12345-678”
  ];

  for (let i = historico.length - 1; i >= 0; i--) {
    const txt = (historico[i].texto || '').trim();
    if (txt.length >= 5 && ENDERECO_PATTERNS.some(re => re.test(txt))) {
      return { endereco_saida: txt };
    }
  }

  // Se não encontrou, tenta uma mensagem longa como fallback
  for (let i = historico.length - 1; i >= 0; i--) {
    const txt = (historico[i].texto || '').trim();
    if (txt.length > 12) {
      return { endereco_saida: txt };
    }
  }

  return {};
}

module.exports = { extract };