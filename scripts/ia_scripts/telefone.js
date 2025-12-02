// scripts/ia_scripts/telefone.js

const telefoneExtractor = require('../ia_extractor/telefone');
const { isValidBRPhone } = require('../ia_extractor/telefone');
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

// Valida: WhatsApp BR (11 dígitos, DDD + celular iniciando com 9)
validate: (ctx, ext) => {
const val = (ctx.data && ctx.data.telefone) || (ext && ext.telefone);
const digits = String(val || '').replace(/\D/g, '');
if (digits && isValidBRPhone(digits)) return { ok: true };
return { ok: false, reason: 'Por favor, envie o seu WhatsApp com DDD (11 dígitos, começando com 9).' };
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

// Aplica telefone extraído (se WhatsApp válido) ao data FSM
onAnswer: async (ctx, parsed) => {
const raw = (parsed && parsed.telefone) ? String(parsed.telefone) : '';
const digits = raw.replace(/\D/g, '');
if (digits && isValidBRPhone(digits)) {
return { patch: { data: { telefone: digits } } };
}
return { patch: null };
},

// Próximo passo do fluxo: itens
next: (ctx) => ({ stepId: 'itens' }),

};

module.exports = handler;
module.exports.register = (reg) => reg.register(handler);
