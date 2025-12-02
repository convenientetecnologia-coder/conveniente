// scripts/ia_extractor/itens.js

/**
 * Extrai itens a serem transportados a partir das mensagens do cliente.
 * Estratégia básica: pega mensagem razoável, diferente de endereço, saudação ou resposta de sim/não.
 * @param {Array} historico 
 * @returns {Object} - { itens: string|null }
 */
function extract(historico = []) {
  for (let i = historico.length - 1; i >= 0; i--) {
    const txt = (historico[i].texto || '').trim();

    // Ignora mensagens muito curtas ou genéricas
    if (txt.length < 3 || /^(sim|não|nao|endereco|ajudante|ok|blz|beleza|confirmado)$/i.test(txt)) {
      continue;
    }
    // Ignora mensagens que parecem endereço (para evitar mistura)
    if (/\b(rua|av(enida)?|n[úu]mero?|cep|bairro|praça|r\.)\b/i.test(txt)) {
      continue;
    }
    // Considera a mensagem como descrição de itens
    return { itens: txt };
  }
  return {};
}

module.exports = { extract };