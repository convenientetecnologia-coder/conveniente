// scripts/ia_scripts/endereco_destino.js

// Importando micro-extractor e prompt json específicos deste step
const extractor = require('../ia_extractor/endereco_destino');
const promptJson = require('../ia_json/endereco_destino.json');

const handler = {
  id: 'endereco_destino',
  version: 1,
  meta: { label: 'Endereço de destino', questionBudget: 1 },

  // Extrai endereço das últimas mensagens do cliente
  extract: async (ctx) => {
    if (extractor && typeof extractor.extract === 'function') {
      return await extractor.extract(ctx.historico || []);
    }
    return {};
  },

  // Validação: exige string não vazia com pelo menos 5 caracteres (ajuste se quiser mais rigor — ex: regex de endereço)
  validate: (ctx, ext) => {
    const val = (ctx.data && ctx.data.endereco_destino) || (ext && ext.endereco_destino);
    if (typeof val === 'string' && val.trim().length >= 5) return { ok: true };
    return { ok: false, reason: 'Por favor, informe o endereço de destino completo.' };
  },

  // Prompt do arquivo JSON, fallback default hardcoded
  prompt: (ctx) => {
    if (promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules?.questionBudget || 1
      };
    }
    return { text: 'Qual é o endereço de entrega/destino?', variants: [], questionBudget: 1 };
  },

  // Sanitize da pergunta renderizada
  sanitize: (text, ctx) => String(text || '').trim(),

  // Aplica somente campo de endereco_destino no patch de dados
  onAnswer: async (ctx, parsed) => {
    if (typeof parsed.endereco_destino === 'string' && parsed.endereco_destino.trim().length > 0) {
      return { patch: { data: { endereco_destino: parsed.endereco_destino.trim() } } };
    }
    return { patch: null };
  },

  // Próximo step conforme flowDef/order (exemplo: ajudante, ou descricao?)
  next: (ctx) => ({ stepId: 'ajudante' }),
};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);