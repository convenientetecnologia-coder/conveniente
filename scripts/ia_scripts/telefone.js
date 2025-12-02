// scripts/ia_scripts/telefone.js

const telefoneExtractor = require('../ia_extractor/telefone');
const promptJson = require('../ia_json/telefone.json');

const handler = {
  id: 'telefone',
  version: 1,
  meta: { label: 'Telefone', questionBudget: 1 },

  // Extrai o telefone das últimas mensagens do cliente
  extract: async (ctx) => {
    if (telefoneExtractor && typeof telefoneExtractor.extract === 'function') {
      return await telefoneExtractor.extract(ctx.historico || []);
    }
    return {};
  },

  // Valida se temos um telefone válido (ajuste a regra para seu formato BR, ex: 11 dígitos)
  validate: (ctx, ext) => {
    const val = (ctx.data && ctx.data.telefone) || (ext && ext.telefone);
    // Exemplo: aceita telefone se for string de 11 dígitos (celular com DDD)
    const onlyDigits = s => String(s || '').replace(/\D/g, '');
    if (typeof val === 'string' && onlyDigits(val).length === 11) return { ok: true };
    return { ok: false, reason: 'Por favor, envie o seu WhatsApp com DDD completo.' };
  },

  // Prompt builder: preferencialmente do JSON, fallback padrão
  prompt: (ctx) => {
    if (promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules?.questionBudget || 1
      };
    }
    return { text: 'Qual é o seu WhatsApp com DDD?', variants: [], questionBudget: 1 };
  },

  // Sanitiza o texto exibido ao cliente
  sanitize: (text, ctx) => String(text || '').trim(),

  // Aplica telefone extraído (se válido) ao data FSM
  onAnswer: async (ctx, parsed) => {
    if (typeof parsed.telefone === 'string' && parsed.telefone.replace(/\D/g, '').length === 11) {
      return { patch: { data: { telefone: parsed.telefone.replace(/\D/g, '') } } };
    }
    return { patch: null };
  },

  // Próximo passo do fluxo: itens
  next: (ctx) => ({ stepId: 'itens' }),
};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);