// scripts/ia_scripts/endereco_saida.js

const extractor = require('../ia_extractor/endereco_saida');
const promptJson = require('../ia_json/endereco_saida.json');

const handler = {
  id: 'endereco_saida',
  version: 1,
  meta: { label: 'Endereço de origem', questionBudget: 1 },

  // Extrai endereço de origem das mensagens recentes do cliente
  extract: async (ctx) => {
    if (extractor && typeof extractor.extract === 'function') {
      return await extractor.extract(ctx.historico || []);
    }
    return {};
  },

  // Valida campo endereco_saida: pelo menos 5 caracteres, ajuste conforme necessário (regex etc)
  validate: (ctx, ext) => {
    const val = (ctx.data && ctx.data.endereco_saida) || (ext && ext.endereco_saida);
    if (typeof val === 'string' && val.trim().length >= 5) return { ok: true };
    return { ok: false, reason: 'Por favor, informe o endereço de retirada/origem completo.' };
  },

  // Prompt do JSON; fallback hardcoded se não houver arquivo/config ainda
  prompt: (ctx) => {
    if (promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules?.questionBudget || 1
      };
    }
    return { text: 'Qual é o endereço de retirada/origem?', variants: [], questionBudget: 1 };
  },

  // Sanitiza o texto exibido ao cliente
  sanitize: (text, ctx) => String(text || '').trim(),

  // Aplica no patch FSM somente endereco_saida, se válido
  onAnswer: async (ctx, parsed) => {
    if (typeof parsed.endereco_saida === 'string' && parsed.endereco_saida.trim().length > 0) {
      return { patch: { data: { endereco_saida: parsed.endereco_saida.trim() } } };
    }
    return { patch: null };
  },

  // Próximo step conforme flowDef/order; aqui normalmente segue para 'endereco_destino'
  next: (ctx) => ({ stepId: 'endereco_destino' }),
};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);