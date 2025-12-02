// scripts/ia_scripts/flowDef.js

// Definição versionada do fluxo do atendimento
module.exports = {
  version: 1,

  // Ordem dos passos do funil
  order: [
    'saudacao',
    'telefone',
    'itens',
    'endereco_saida',
    'endereco_destino',
    'ajudante',
    'descricao'
  ],

  // Quais campos são obrigatórios para o funil ser finalizado
  required: [
    'telefone',
    'itens',
    'endereco_saida',
    'endereco_destino'
  ],

  /**
   * Regra: pode finalizar se todos os required estão presentes
   * @param {Object} data 
   * @returns {boolean}
   */
  canFinalize: (data) => {
    const req = ['telefone', 'itens', 'endereco_saida', 'endereco_destino'];
    return req.every((k) => data && data[k]);
  }
};