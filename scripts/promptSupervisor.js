'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

/* ========= Padrões para limpeza e detecção ========= */
const INTRO_PATTERNS = [
/ol[aá]!?\s+sim,\s+fazemos\s+fretes.?/i,
/sim,\s+fazemos\s+fretes.?/i,
/oi!?\s+sim,\s+fazemos\s+fretes.?/i
];

const ORCAMENTO_PATTERNS = [
/o\s+motorista\s+envia\s+o\s+valor\s+no\s+whatsapp\s+ap[oó]s\s+eu\s+anotar\s+os\s+dados.?/i,
/quem\s+(define|passa)\s+o\s+valor\s+é\s+o\s+motorista/i,
/o\s+valor\s+(exato|final)\s+é\s+passado\s+pelo\s+motorista\s+no\s+whatsapp/i
];

const BLACKLIST = [
/você\s+já\s+mencionou/i,
/como\s+você\s+disse/i,
/conforme\s+(dito|falado|mencionado)/i,
/você\s+falou\s+que/i,
/como\s+falamos\s+antes/i,
/conforme\s+informado/i
];

/* ========= Helpers ========= */
function countQuestions(t) {
return (String(t || '').match(/\?/g) || []).length;
}

function clampQuestions(text, budget) {
if (!budget || budget < 1) return String(text || '').trim();
const parts = String(text || '').split('?');
const kept = [];
for (let i = 0; i < parts.length; i++) {
const seg = parts[i].trim();
if (!seg) continue;
kept.push(seg);
if (kept.length >= budget) break;
}
return kept.length ? (kept.join('? ') + '?') : String(text || '').trim();
}

function stripIntroByFlags(text, ctx) {
let t = String(text || '');
try {
if (ctx && ctx.flags && ctx.flags.greetDone) {
  INTRO_PATTERNS.forEach(rx => { t = t.replace(rx, ''); });
}
if (ctx && ctx.flags && ctx.flags.explainedOrcamentoOnce) {
  ORCAMENTO_PATTERNS.forEach(rx => { t = t.replace(rx, ''); });
}
} catch {}
return t.replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
}

function stripBlacklist(text) {
let t = String(text || '');
BLACKLIST.forEach(rx => { t = t.replace(rx, ''); });
return t.replace(/\s{2,}/g, ' ').trim();
}

function ensureAskFocus(text, ctx) {
try {
const ask = ctx && ctx.funil && ctx.funil.step ? String(ctx.funil.step) : null;
if (!ask) return text;

const v = (ctx && ctx.validations) ? ctx.validations : {};
const budget = (ctx && ctx.flags && ctx.flags.greetDone) ? 1 : 2;

let t = String(text || '');

if (ask === 'ddd') {
  // garantir pergunta explícita sobre DDD
  const hasDDDWord = /ddd/i.test(t);
  if (!hasDDDWord) {
    t = t.replace(/\?+$/,'').trim();
    t = t ? `${t} Qual é o DDD do seu WhatsApp?` : 'Qual é o DDD do seu WhatsApp?';
  }
} else if (ask === 'telefone') {
  // confirmação/ajuste quando DDD + parcial não formam WhatsApp
  const needConfirm = !!(v && v.hasDDD && v.hasTelefoneParcial && v.telefoneWhatsAppOk === false);
  if (needConfirm) {
    const hasConfirm = /whatsapp.*9/i.test(t);
    if (!hasConfirm) {
      t = t.replace(/\?+$/,'').trim();
      const msg = 'Esse número tem WhatsApp? Se for celular, envie com o 9. Se for fixo, me informe um número com WhatsApp.';
      t = t ? `${t} ${msg}` : msg;
    }
  } else {
    const hasWpp = /whatsapp/i.test(t);
    const hasDDD = /ddd/i.test(t);
    if (!hasWpp || !hasDDD) {
      t = t.replace(/\?+$/,'').trim();
      const msg = 'Qual é o seu WhatsApp com DDD?';
      t = t ? `${t} ${msg}` : msg;
    }
  }
} else if (ask === 'itens') {
  const hasAsk = /(o que|qual|quais).*(transportar|item|itens)/i.test(t);
  if (!hasAsk) {
    t = t.replace(/\?+$/,'').trim();
    const msg = 'O que você precisa transportar?';
    t = t ? `${t} ${msg}` : msg;
  }
} else if (ask === 'endereco_saida') {
  const hasAsk = /(endere[cç]o|endereço).*(sa[ií]da|retirada)|onde\s+(buscar|retirar)/i.test(t);
  if (!hasAsk) {
    t = t.replace(/\?+$/,'').trim();
    const msg = 'Qual é o endereço completo de saída?';
    t = t ? `${t} ${msg}` : msg;
  }
} else if (ask === 'endereco_destino') {
  const hasAsk = /(endere[cç]o|endereço).*(destino|entrega)|para\s+onde|levar\s+para/i.test(t);
  if (!hasAsk) {
    t = t.replace(/\?+$/,'').trim();
    const msg = 'Qual é o endereço de destino?';
    t = t ? `${t} ${msg}` : msg;
  }
} else if (ask === 'ajudante') {
  const hasAsk = /(ajudante|ajuda|aux[ií]lio)\b/i.test(t);
  if (!hasAsk) {
    t = t.replace(/\?+$/,'').trim();
    const msg = 'Vai precisar de ajudante para carregar?';
    t = t ? `${t} ${msg}` : msg;
  }
} else if (ask === 'descricao') {
  const hasAsk = /(observa[cç][aã]o|detalhe|algo\s+mais|informa[cç][aã]o)/i.test(t);
  if (!hasAsk) {
    t = t.replace(/\?+$/,'').trim();
    const msg = 'Deseja adicionar alguma observação?';
    t = t ? `${t} ${msg}` : msg;
  }
}

t = clampQuestions(t, budget);
return t.trim();

} catch {
return String(text || '').trim();
}
}

/* ========= LLM refinement ========= */
async function llmRefine(text, ctx) {
const budget = (ctx && ctx.flags && ctx.flags.greetDone) ? 1 : 2;
const ask = ctx && ctx.funil && ctx.funil.step ? String(ctx.funil.step) : '';

const system = [
'Você é um supervisor de mensagens de atendimento de fretes.',
'Sua tarefa: revisar e, se necessário, reescrever a mensagem do atendente para obedecer rigorosamente às regras:',
`- Máximo de ${budget} pergunta(s) nesta resposta; mantenha a mensagem curta e natural.`,
'- Não repita saudação nem explicação de orçamento se já foram enviadas.',
'- Não ecoe ou recapitule o que o cliente disse.',
'- Foque somente no PRÓXIMO campo do funil.',
'- Se ask_field = "ddd", a pergunta deve solicitar o DDD.',
'- Se ask_field = "telefone":',
'  • Se vier DDD + telefone parcial e isso não formar WhatsApp (11 dígitos iniciando com 9), peça confirmação/ajuste.',
'  • Caso contrário, peça "WhatsApp com DDD".',
'- Endereços: use "endereço completo de saída" ou "endereço de destino" (aceita informal).',
'Responda sempre em português do Brasil.'
].join(' ');

const flags = {
ask_field: ask,
budget,
saudacao_already: !!(ctx && ctx.flags && ctx.flags.greetDone),
orcamento_already: !!(ctx && ctx.flags && ctx.flags.explainedOrcamentoOnce),
validations: ctx && ctx.validations ? {
telefoneWhatsAppOk: !!ctx.validations.telefoneWhatsAppOk,
hasDDD: !!ctx.validations.hasDDD,
hasTelefoneParcial: !!ctx.validations.hasTelefoneParcial
} : {}
};

const user = [
'Contexto do funil (JSON):',
JSON.stringify(flags),
'',
'Candidato a resposta (edite somente se necessário, obedecendo as regras):',
String(text || '').trim(),
'',
'Forneça apenas a mensagem final, sem explicações.'
].join('\n');

const refined = await chatCompletion({
system,
user,
provider: 'groq',
model: process.env.GROQ_MODEL_ANSWER || process.env.GROQ_MODEL,
task: 'answer',
timeoutMs: 15000,
retries: 1
}).catch(() => null);

if (!refined) return text;

const out = String(refined || '').trim();
if (!out) return text;

return clampQuestions(out, budget).trim();
}

/* ========= API ========= */
async function superviseAndFix(text, ctx) {
try {
const budget = (ctx && ctx.flags && ctx.flags.greetDone) ? 1 : 2;

// 1) Remover repetições indevidas (saudação/orçamento) se flags já setadas
let t = stripIntroByFlags(text, ctx);

// 2) Blacklist de frases "robóticas"
t = stripBlacklist(t);

// 3) Foco no campo do funil
t = ensureAskFocus(t, ctx);

// 4) Orçamento de perguntas
t = clampQuestions(t, budget);

// 5) Refinamento via LLM (sempre tentado)
t = await llmRefine(t, ctx);

// 6) Orçamento novamente (garantia)
t = clampQuestions(t, budget);

return t.trim();

} catch {
return String(text || '').trim();
}
}

module.exports = { superviseAndFix };

