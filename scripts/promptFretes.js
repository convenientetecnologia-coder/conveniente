// scripts/promptFretes.js — PATCH ULTRA-CIRÚRGICO (ANTI-ECO • BLINDAGEM • FLUXO NOTA 10)
// Não inclua enforceAnswer aqui. Exporte somente as quatro funções pedidas.

'use strict';

/* ========= Utils internas ========= */
const INTRO_PATTERNS = [
  /ol[aá]!?\s+sim,\s+fazemos\s+fretes.?/i,
  /sim,\s+fazemos\s+fretes.?/i,
  /vou\s+anotar\s+seus\s+dados\s+e\s+encaminhar\s+pro\s+motorista.*whatsapp/i
];

const ORCAMENTO_PATTERNS = [
  /quem\s+(define|passa)\s+o\s+valor\s+é\s+o\s+motorista/i,
  /o\s+motorista\s+(envia|passa)\s+o\s+valor\s+no\s+whatsapp/i,
  /o\s+valor\s+(exato|final)\s+é\s+passado\s+pelo\s+motorista\s+no\s+whatsapp/i
];

const SENTENCE_BLACKLIST = [
  /você\s+já\s+mencionou/i,
  /como\s+você\s+disse/i,
  /conforme\s+(dito|falado|mencionado)/i,
  /você\s+falou\s+que/i,
  /como\s+falamos\s+antes/i,
  /conforme\s+informado/i
];

// perguntas padrão para fallback (quando dedupe aciona)
const ASKS = {
telefone: 'Qual é o seu WhatsApp com DDD?',
ddd: 'Qual é o DDD do seu WhatsApp?',
numero_whats: 'Qual é o número do seu WhatsApp?',
confirmWhatsapp: 'Esse número tem WhatsApp? Se for celular, envie com o 9. Se for fixo, me informe um número com WhatsApp.',
itens: 'O que você precisa transportar?',
endereco_saida: 'Qual é o endereço de saída? Pode ser bairro ou ponto de referência.',
endereco_destino: 'Qual é o endereço de destino? Pode ser bairro ou ponto de referência.'
};

function normalizeForFingerprint(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s?]/g, '')
    .replace(/\d+/g, '0')
    .trim();
}

function removeBlacklistedPhrases(text) {
  let t = text;
  SENTENCE_BLACKLIST.forEach(rx => { t = t.replace(rx, ''); });
  return t;
}

function removeRepeatedBlocksByFlags(text, ctx) {
  let t = text;

  if (ctx?.flags?.greetDone) {
    INTRO_PATTERNS.forEach(rx => { t = t.replace(rx, ''); });
  }
  if (ctx?.flags?.explainedOrcamentoOnce) {
    ORCAMENTO_PATTERNS.forEach(rx => { t = t.replace(rx, ''); });
  }

  // limpeza de pontuação/espaços estranhos pós-recortes
  t = t.replace(/\s{2,}/g, ' ')
    .replace(/\.\s*\./g, '.')
    .replace(/,\s*,/g, ',')
    .replace(/\?\s*\?/g, '?')
    .trim();

  // remover conectivos soltos após cortes
  t = t.replace(/^\s*(e|mas|tamb[ée]m|ent[aã]o)\s*,?\s*/i, '').trim();

  return t;
}

function clampQuestions(text, maxQuestions) {
  if (!maxQuestions || maxQuestions < 1) return text.trim();

  const parts = text.split('?');
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i].trim();
    if (!seg) continue;
    kept.push(seg);
    if (kept.length >= maxQuestions) break;
  }
  return kept.length ? (kept.join('? ') + '?') : text.trim();
}

function countQuestions(text) {
  return (text.match(/\?/g) || []).length;
}

function fallbackAsk(ctx) {
const nf = (ctx && (ctx.funil?.step || ctx.render?.nextField)) || null;
const data = ctx && ctx.data ? ctx.data : {};

if (nf === 'telefone') {
// Se veio número sem DDD (8–9 dígitos), peça o DDD
if (data.telefone_parcial && !data.ddd && !data.telefone) {
  return ASKS.ddd;
}
// Se veio somente DDD, peça o número
if (data.ddd && !data.telefone && !data.telefone_parcial) {
  return ASKS.numero_whats;
}
// Se o número completo existe mas não é WhatsApp válido, confirmar
if (data.telefone && ctx?.validations && ctx.validations.telefoneWhatsAppOk === false) {
  return ASKS.confirmWhatsapp;
}
// Caso padrão
return ASKS.telefone;
}

if (nf && ASKS[nf]) return ASKS[nf];
return 'Pode me informar o próximo dado que falta, por favor?';
}

/* ========= 1) sanitizeAnswerUnico — Blacklist, Dedup, Clamp, Flags, Validação de Ask ========= */
function sanitizeAnswerUnico(raw, ctx = {}) {
  let text = String(raw || '');

  // 1) Remoção de frases proibidas (anti-eco)
  text = removeBlacklistedPhrases(text);

  // 2) Remoção de blocos de intro/orçamento conforme flags
  text = removeRepeatedBlocksByFlags(text, ctx);

  // 3) Clamp rigoroso de perguntas pelo orçamento
  const budget = (ctx.render && Number.isInteger(ctx.render.questionBudget))
    ? ctx.render.questionBudget
    : (ctx.flags && ctx.flags.greetDone ? 1 : 2);
  text = clampQuestions(text, budget);

  // 4) Anti-eco via fingerprint (comparação com últimas 2 respostas)
  const fp = normalizeForFingerprint(text);
  const last = (ctx.audit && ctx.audit.lastIAFingerprints) ? ctx.audit.lastIAFingerprints : [];
  const isDuplicate = last.includes(fp);

  if (isDuplicate) {
    const fb = fallbackAsk(ctx);
    text = clampQuestions(fb, 1);
  }

  // 5) Persistência imediata do fingerprint no ctx/audit (para persistir via FSM depois)
  ctx._nextFingerprint = normalizeForFingerprint(text);

  // 6) Validação obrigatória de pergunta (regex obrigatória)
  // Política: se questionBudget > 0, a resposta deve conter ao menos 1 pergunta.
  if (budget > 0) {
    // Regex mínima para presença de pergunta válida
    const ASK_FIELD_RX = ctx.render?.ask_field_regex
      ? new RegExp(ctx.render.ask_field_regex, 'i')
      : /(?:^qual\b|^pode\s+me\s+passar\b|^me\s+informe\b|^informe\b|^envie\b|^me\s+envia\b)/i;

    const qCount = countQuestions(text);
    const hasAskField = ASK_FIELD_RX.test(text);

    if (!hasAskField || qCount < 1) {
      if (ctx.logger && typeof ctx.logger.error === 'function') {
        ctx.logger.error('sanitize_invalidated_ask', { text, budget, hasAskField, qCount });
      }
      const err = new Error('sanitize_invalidated_ask');
      err.code = 'sanitize_invalidated_ask';
      err.meta = { text, budget, hasAskField, qCount };
      throw err;
    }

    // Quando o budget for 2, opcionalmente validar segunda pergunta (se ctx.render.ask_next_field_regex existir)
    if (budget >= 2 && ctx.render?.ask_next_field_regex) {
      const ASK_NEXT_RX = new RegExp(ctx.render.ask_next_field_regex, 'i');
      const hasAskNext = ASK_NEXT_RX.test(text);
      const qNum = countQuestions(text);
      if (!hasAskNext || qNum < 2) {
        if (ctx.logger && typeof ctx.logger.error === 'function') {
          ctx.logger.error('sanitize_invalidated_ask', { text, budget, hasAskNext, qNum, phase: 'next_field' });
        }
        const err2 = new Error('sanitize_invalidated_ask');
        err2.code = 'sanitize_invalidated_ask';
        err2.meta = { text, budget, hasAskNext, qNum, phase: 'next_field' };
        throw err2;
      }
    }

  }

  return text.trim();
}

/* ========= 2) renderUnico — Composição Modular, Flags, Clamp, Dedup ========= */
function renderUnico(ctx = {}) {
// Orçamento de perguntas: 2 somente na abertura; depois 1
const questionBudget = (ctx.render && Number.isInteger(ctx.render.questionBudget))
? ctx.render.questionBudget
: (ctx.flags && ctx.flags.greetDone ? 1 : 2);

const out = [];
const flags = ctx.flags || {};
const data = ctx.data || {};
const validations = ctx.validations || {};
const missingOrdered = Array.isArray(ctx.missingOrdered) ? ctx.missingOrdered : null;

// Intro + orçamento (somente se ainda não disparados)
if (!flags.greetDone) {
out.push('Olá! Sim, fazemos fretes.');
}
if (!flags.explainedOrcamentoOnce) {
out.push('O motorista envia o valor no WhatsApp após eu anotar os dados.');
}

// Determina o(s) ask(s) respeitando o budget e sem decidir passo aqui
const asks = [];
const nextField =
(ctx.funil && ctx.funil.step) ||
(ctx.render && ctx.render.nextField) ||
(missingOrdered && missingOrdered[0]) ||
null;

// Pergunta principal
if (nextField === 'telefone') {
if (data.telefone && validations.telefoneWhatsAppOk === false) {
  asks.push(ASKS.confirmWhatsapp);
} else if (data.telefone_parcial && !data.ddd && !data.telefone) {
  // Número sem DDD -> pedir DDD
  asks.push(ASKS.ddd);
} else if (data.ddd && !data.telefone && !data.telefone_parcial) {
  // DDD sem número -> pedir número
  asks.push(ASKS.numero_whats);
} else {
  asks.push(ASKS.telefone);
}
} else if (nextField && ASKS[nextField]) {
asks.push(ASKS[nextField]);
} else {
asks.push(fallbackAsk(ctx));
}

// Pergunta adicional (somente se budget >= 2 e soubermos o próximo pendente)
if (questionBudget >= 2) {
let second = null;

if (missingOrdered && missingOrdered.length > 1) {
  const idx = missingOrdered.indexOf(nextField);
  const nextIdx = idx >= 0 ? idx + 1 : 1;
  const secondField = missingOrdered[nextIdx];
  if (secondField && ASKS[secondField]) {
    second = ASKS[secondField];
  }
}

if (second) asks.push(second);

}

// Monta a saída crua
const raw = [...out, ...asks].filter(Boolean).join(' ').trim();

// Prepara ctx.render e fallback para sanitize (anti-eco)
ctx.render = ctx.render || {};
ctx.render.questionBudget = questionBudget;
ctx.render.fallbackQuestion = fallbackAsk(ctx);

// Sanitize final (dedupe/clamp/blacklist/validação de ask)
const text = sanitizeAnswerUnico(raw, ctx);

// Persistência imediata das flags (greet/orçamento) antes de retornar
if (!flags.greetDone) ctx.flags.greetDone = true;
if (!flags.explainedOrcamentoOnce) ctx.flags.explainedOrcamentoOnce = true;

// Persistência do fingerprint no audit (para anti-flood)
if (ctx._nextFingerprint) {
ctx.audit = ctx.audit || {};
const prev = ctx.audit.lastIAFingerprints || [];
ctx.audit.lastIAFingerprints = [ctx._nextFingerprint, ...prev].slice(0, 2);
}

return text;
}

/* ========= 3) buildSystemPromptUnico ========= */
function buildSystemPromptUnico(ctx = {}) {
  return [
    'Você é um atendente de fretes focado em coletar dados por etapas, com regras rígidas.',
    'Proibições absolutas: nunca ecoar o que o cliente disse; nunca usar frases como "Você já mencionou", "Como você disse", "Conforme informado".',
    'Nunca repetir saudação nem explicação de orçamento após a primeira resposta (bloqueadas por flags).',
    'Sempre no máximo 2 perguntas na primeira resposta; depois, no máximo 1 pergunta.',
    'Se um campo já foi coletado, não volte nele; pergunte somente o próximo pendente.',
    'Telefone só avança se for WhatsApp (11 dígitos, celular iniciando em 9). Caso contrário, pergunte apenas sobre WhatsApp.',
    'Nunca concatenar múltiplas explicações; apenas um bloco de intro (uma vez) e a(s) pergunta(s) conforme orçamento.',
    'Mensagens devem ser curtas, diretas e sem repetições.'
  ].join(' ');
}

/* ========= 4) buildUserPromptUnico (INSTRUÇÃO HARD PARA LLM) ========= */
function buildUserPromptUnico(ctx = {}) {
  // Esta instrução é injetada ao modelo para garantir o comportamento limitado e preciso
  return [
    'Regras obrigatórias para sua resposta AGORA:',
    '- NUNCA ecoe/recapitule o que o cliente disse; não use "Você já mencionou…", "Como você disse…", "Conforme dito…".',
    '- NUNCA repita saudação nem explicação do orçamento após a primeira resposta (flags greetDone e explainedOrcamentoOnce bloqueiam).',
    '- Na primeira resposta do fluxo: no máximo 2 perguntas. Nas demais: no máximo 1 pergunta.',
    '- Se um campo já foi coletado, nunca volte nele; pergunte apenas o PRÓXIMO campo pendente.',
    '- Telefone: só avance quando for WhatsApp (11 dígitos, celular com 9). Se não estiver nesse formato, pergunte apenas sobre WhatsApp explicitamente.',
    '- NÃO concatene explicação/papel/saudação com múltiplas perguntas. Um bloco de intro (apenas na primeira interação) e somente a(s) pergunta(s) permitida(s) pelo orçamento.',
    '- NÃO repita orçamento/explicação em respostas subsequentes.',
    '- Varie levemente a formulação, mas mantenha apenas uma pergunta-chave (ou duas na primeira mensagem).',
    'Produza uma mensagem curta, direta e com a pergunta certa para o próximo campo.'
  ].join(' ');
}

/* ========= Exports ========= */
module.exports = {
  buildSystemPromptUnico,
  buildUserPromptUnico,
  sanitizeAnswerUnico,
  renderUnico
};
