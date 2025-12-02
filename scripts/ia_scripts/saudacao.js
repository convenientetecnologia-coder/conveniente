// scripts/ia_scripts/saudacao.js

const promptJson = require('../ia_json/saudacao.json');

const handler = {
  id: 'saudacao',
  version: 1,
  meta: { label: 'Saudação', questionBudget: 2 },

  // Saudação normalmente não extrai nada específico; só responde
  extract: async (ctx) => ({}),

  // Saudação é sempre válida (primeiro step, não trava o fluxo)
  validate: (ctx, ext) => ({ ok: true }),

  // Prompt builder (do JSON com fallback)
  prompt: (ctx) => {
    if(promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules?.questionBudget || 2
      };
    }
    // Padrão se prompt JSON não existir
    return { 
      text: 'Olá! Sim, fazemos fretes. O motorista envia o valor no WhatsApp após eu anotar os dados. Pode me passar o seu WhatsApp com DDD?', 
      variants: [],
      questionBudget: 2
    };
  },

  // Sanitiza a mensagem para garantir texto limpo
  sanitize: (text, ctx) => String(text || '').trim(),

  // Saudação não altera nada, apenas avança o funil
  onAnswer: async (ctx, parsed) => ({ patch: null }),

  // Próximo passo: telefone
  next: (ctx) => ({ stepId: 'telefone' }),
};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);