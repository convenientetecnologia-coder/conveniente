// scripts/ia_scripts/descricao.js

// Importa o micro-extractor (configurável depois) e prompt JSON deste step
const descricaoExtractor = require('../ia_extractor/descricao');
const promptJson = require('../ia_json/descricao.json');

const handler = {
  id: 'descricao',
  version: 1,
  meta: { label: 'Descrição', questionBudget: 1 },

  // Extrator: tenta encontrar descrição relevante nas últimas interações (opcional)
  extract: async (ctx) => {
    if (descricaoExtractor && typeof descricaoExtractor.extract === 'function') {
      return await descricaoExtractor.extract(ctx.historico || []);
    }
    return {};
  },

  // Validador: aceita mínimo 5 caracteres como descrição razoável, ou ajusta conforme regra de negócio
  validate: (ctx, ext) => {
    const val = (ctx.data && ctx.data.descricao) || (ext && ext.descricao);
    if (typeof val === 'string' && val.trim().length >= 5) return { ok: true };
    return { ok: false, reason: 'Descreva com algumas palavras o frete.' };
  },

  // Prompt builder, preferencialmente do JSON
  prompt: (ctx) => {
    if (promptJson && promptJson.text) {
      return {
        text: promptJson.text,
        variants: promptJson.variants || [],
        questionBudget: promptJson.rules && promptJson.rules.questionBudget || 1
      };
    }
    return { text: 'Pode descrever com algumas palavras o que precisa (ex: mudança, retirada, objeto especial)?', variants: [], questionBudget: 1 };
  },

  // Sanitizador do texto da pergunta
  sanitize: (text, ctx) => String(text || '').trim(),

  // onAnswer aplica a descrição, caso válida
  onAnswer: async (ctx, parsed) => {
    if (typeof parsed.descricao === 'string' && parsed.descricao.trim().length > 0) {
      return { patch: { data: { descricao: parsed.descricao.trim() } } };
    }
    return { patch: null };
  },

  // Finaliza o funil aqui (pode customizar fluxo no flowDef depois, se quiser outros campos)
  next: (ctx) => ({ stepId: null }),
};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);