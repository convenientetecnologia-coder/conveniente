// scripts/ia_scripts/itens.js

const itensExtractor = require('../ia_extractor/itens');
const promptJson = require('../ia_json/itens.json');

const handler = {
  id: 'itens',
  version: 1,
  meta: { label: 'Itens', questionBudget: 1 },

  // Extrai informações dos itens transportados das últimas mensagens do cliente
  extract: async (ctx) => {
    if (itensExtractor && typeof itensExtractor.extract === 'function') {
      return await itensExtractor.extract(ctx.historico || []);
    }
    return {};
  },

  // Valida: deve existir campo itens não vazio (ajuste se quiser regex ou lista)
  validate: (ctx, ext) => {
    const val = (ctx.data && ctx.data.itens) || (ext && ext.itens);
    // Aqui exige pelo menos 3 caracteres (ajuste para sua regra)
    if (typeof val === 'string' && val.trim().length >= 3) return { ok: true };
    return { ok: false, reason: 'Informe o que será transportado.' };
  },

  // Prompt builder pelo JSON, fallback caso não haja ainda
  prompt: (ctx) => {
    if (promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules?.questionBudget || 1
      };
    }
    return { text: 'O que precisa transportar?', variants: [], questionBudget: 1 };
  },

  // Sanitize texto exibido ao usuário
  sanitize: (text, ctx) => String(text || '').trim(),

  // Aplica o valor extraído de itens, se válido
  onAnswer: async (ctx, parsed) => {
    if (typeof parsed.itens === 'string' && parsed.itens.trim().length > 0) {
      return { patch: { data: { itens: parsed.itens.trim() } } };
    }
    return { patch: null };
  },

  // Próximo passo, normalmente 'endereco_saida'
  next: (ctx) => ({ stepId: 'endereco_saida' }),
};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);