// scripts/ia_scripts/ajudante.js

// Importando micro-extractor e prompt para o step "ajudante"
const ajudanteExtractor = require('../ia_extractor/ajudante');
const promptJson = require('../ia_json/ajudante.json');

const handler = {
  id: 'ajudante',
  version: 1,
  meta: { label: 'Ajudante', questionBudget: 1 },

  // Extrai resposta do histórico/chat: espera sim/não
  extract: async (ctx) => {
    // Usa micro-extractor (você vai modularizar depois)
    if (typeof ajudanteExtractor.extract === 'function') {
      return await ajudanteExtractor.extract(ctx.historico || []);
    }
    return {};
  },

  // Validação: só aceita true/false explícito (sim/não)
  validate: (ctx, ext) => {
    const val = (ctx.data && typeof ctx.data.ajudante === 'boolean')
      ? ctx.data.ajudante
      : ext && typeof ext.ajudante === 'boolean'
        ? ext.ajudante
        : null;
    if (typeof val === 'boolean') return { ok: true };
    return { ok: false, reason: 'preciso saber se precisa de ajudante, responda sim ou não' };
  },

  // Prompt builder: preferencialmente carrega do json
  prompt: (ctx) => {
    // Usa promptJson se presente; fallback texto simples
    if (promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules && promptJson.rules.questionBudget || 1
      };
    }
    return { text: 'Precisa de ajudante para carregar/descarregar?', variants: [], questionBudget: 1 };
  },

  // Sanitização do texto para exibir (remove eco/palavras proibidas, etc)
  sanitize: (text, ctx) => String(text || '').trim(),

  // onAnswer aplica o valor somente em "ajudante"
  onAnswer: async (ctx, parsed) => {
    // parsed = valor extraído (ideal: true/false)
    if (typeof parsed.ajudante === 'boolean') {
      return { patch: { data: { ajudante: parsed.ajudante } } };
    }
    return { patch: null };
  },

  // Passo seguinte do funil (por padrão, 'descricao'; mas pode ser configurado no flowDef)
  next: (ctx) => ({ stepId: 'descricao' })
};

module.exports = handler;
// Função para registrar no registry!
module.exports.register = (reg) => reg.register(handler);