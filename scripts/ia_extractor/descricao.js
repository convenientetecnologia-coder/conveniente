// scripts/ia_extractor/descricao.js

/**
 * Extrai uma possível descrição do serviço/frete da conversa do cliente.
 * Estratégia simples: pega a última mensagem do cliente que não é só "sim/não" ou resposta de campo óbvio.
 * @param {Array} historico 
 * @returns {Object} - { descricao: string|null }
 */
function extract(historico = []) {
  for (let i = historico.length - 1; i >= 0; i--) {
    const txt = (historico[i].texto || '').trim();
    // Ignorar mensagens muito curtas ou claramente não descritivas
    if (
      txt.length >= 5 &&
      !/^(sim|não|ok|tá bom|pode ser)$/i.test(txt)
    ) {
      return { descricao: txt };
    }
  }
  return {};
}

module.exports = { extract };