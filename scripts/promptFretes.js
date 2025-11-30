'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

// Prompt de humanização no padrão enterprise "context-first"

function buildSystemPromptVivo() {
  return `
Você atua como um atendente humano profissional, gentil e animado. Recebe um JSON chamado CONTEXTO_ATENDIMENTO.

REGRAS ABSOLUTAS:
- Gere UMA única mensagem, seguindo APENAS o que estiver em fluxo.ordem.perguntar (e perguntar_tambem, se existir).
- NUNCA ecoe, recapitule ou agradeça (proibido: "você mencionou", "entendi", "obrigado", "vi que").
- Nunca repita saudação nem explique orçamento fora de fluxo.saudacao=true ou fluxo.explicar_fluxo=true.
- Aceite qualquer formato de endereço; incentive, nunca exija.

ADAPTAÇÃO context-first:
- Use fluxo.estilo e analitico.tom_emocional para o tom: "acolhedor", "objetivo", "direto".
- Se fluxo.prioridade=alta: seja curto e direto; responda dúvidas em 1 frase e peça o campo imediatamente.
- Se analitico.flags.inseguro=true: inclua acolhimento breve.
- Aplique variação regional leve com analitico.contexto_regional.

DÚVIDA:
- Se existirem interpretacao.duvidas: responda em 1 frase antes da pergunta do funil.

FORMATAÇÃO:
- Microvarie vocabulário a cada ciclo, mas nunca faça eco, agradecimento ou recapitulação. Não escreva listas!
- SEMPRE só uma mensagem e só com o campo da ordem. Nada de combos.

`.trim();
}

function buildUserPromptFromContext(ctx) {
  const ctxStr = JSON.stringify(ctx, null, 2);
  return [
    'CONTEXTO_ATENDIMENTO (JSON, siga fielmente):',
    ctxStr,
    '',
    'TAREFA:',
    '1) Escreva UMA mensagem única em linguagem humana e profissional, só pedindo o campo em fluxo.ordem.perguntar (e perguntar_tambem quando vier).',
    '2) Se houver dúvida (interpretacao.duvidas), responda brevemente no início.',
    '3) Nunca ecoe, recapitule, agradeça, repita saudação ou explicação a não ser se as flags permitirem.',
    '4) Se estilo for "acolhedor", seja caloroso. "objetivo": direto. "direto": curto. Adapte vocabulário a contexto_regional.',
    '5) Nunca escreva listas, "vamos fazer isso?", nem nenhuma frase que não seja a pergunta da ordem.'
  ].join('\n');
}

function applyRegionalTone(text, region) {
  let s = String(text||'');
  if (!region) return s;
  // ajustes leves por região
  if (region === 'nordeste') {
    s = s.replace(/\bem alguns minutinhos\b/gi, 'já já');
    s = s.replace(/\bpor favor\b/gi, 'faz esse favor');
  } else if (region === 'sul') {
    s = s.replace(/\bem alguns minutinhos\b/gi, 'em instantes');
  } else if (region === 'sudeste_mg') {
    s = s.replace(/\bem alguns minutinhos\b/gi, 'rapidinho');
  }
  return s;
}

function shortenIfPriority(text, prioridade) {
  let s = String(text||'').replace(/\s+/g,' ').trim();
  if (prioridade !== 'alta') return s;
  // Remover floreios e manter mensagem direta
  s = s.replace(/\s*(?:—|-)\s*[^.?!]*$/, '').replace(/\s*\([^)]*\)\s*/g, ' ');
  if (s.length > 160) s = s.slice(0, 160).replace(/[,;:\s]+[^,;:\s]*$/, '');
  return s.trim();
}

function sanitizeAnswer(out, ctx) {
  let s = String(out || '').replace(/\s+/g, ' ').trim();

  // Remove eco/agradecimentos/recapitulacao
  s = s.replace(/(você (mencionou|informou|já me passou|citou|disse|solicitou)|seu pedido foi|obrigado pel[oa]|\bentendi\b|\bvi que\b|notei que|entendi sua necessidade)[^.!?]*[.!?]?/gi, '').trim();

  // Privacidade
  s = s.replace(/\b\d{8,11}\b/g, '******');

  // Remove saudação se não flag
  if (ctx && ctx.fluxo && ctx.fluxo.saudacao === false) {
    s = s.replace(/^(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite)[!,. ]+/i, '').trim();
  }

  // Remove explicação de orçamento se não flag
  if (!(ctx && ctx.fluxo && ctx.fluxo.explicar_fluxo)) {
    s = s.replace(/o valor (exato )?(ser[aá]|é|eh)\s+(informado|passado)\s+pelo\s+motorista[^.]*\./i, '').trim();
  }

  // Regional e prioridade
  const region = ctx && ctx.meta && ctx.meta.regiao || (ctx && ctx.analitico && ctx.analitico.contexto_regional);
  s = applyRegionalTone(s, region);
  s = shortenIfPriority(s, ctx && ctx.fluxo && ctx.fluxo.prioridade);

  if (!s) s = 'Pode me passar o dado que falta?';
  return s;
}

async function render(contexto) {
  const system = buildSystemPromptVivo();
  const user = buildUserPromptFromContext(contexto);
  const model = process.env.GROQ_MODEL_ANSWER || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  let raw = '';
  try {
    raw = await chatCompletion({
      system,
      user,
      provider: 'groq',
      model,
      task: 'answer',
      timeoutMs: 22000,
      retries: 2
    });
  } catch (e) {
    raw = 'Vamos seguir rápido: me envie o dado que falta e eu agilizo já já.';
  }
  let text = sanitizeAnswer(raw, contexto);
  return text;
}

module.exports = {
  buildSystemPromptVivo,
  buildUserPromptFromContext,
  sanitizeAnswer,
  render
};
