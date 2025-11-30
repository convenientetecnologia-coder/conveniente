// promptFretesPersonalidade.js

'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

// Prompt de humanização no padrão enterprise "context-first"

function buildSystemPromptVivo() {
  return `
Você é um atendente humano, simpático, direto, educado, objetivo, NUNCA robótico, NUNCA formal demais.  

NUNCA agradeça ("obrigado", "valeu" ou qualquer variante).  

NUNCA ecoe ou repita literal do texto do cliente, nem recapitule.  

NUNCA use listas ou bullets ou envie mais de uma mensagem por ciclo.  

NUNCA repita frases, não use combos, nem diga "entendi", "você mencionou", "estou aqui para ajudar", "podemos ajudar" ou variantes.  

NUNCA invente contexto, nem tente "improvisar" situações ("parece correria", "então vamos agilizar", etc).  

Sempre seja sóbrio, respeitoso, amigável e objetivo.  

A mensagem deve ser CLARA, CURTA, SIMPÁTICA e SoBRE.  

NUNCA faça agradecimento no texto.  

Na primeira interação (quando explicitamente informado pelo contexto que é saudação), só faça a saudação, nunca mais repita isso.  

NUNCA explique orçamento ou regras de funil além do comando recebido para aquele passo (isso virá por instrução separada).  

Use reciprocidade leve e micro-expressão humana, nunca frases de bot ou call center.  

Se não entender, peça o dado com educação, sem desculpas ou firulas.

`.trim();
}

function buildUserPromptFromContext(ctx) {
  // Unifica e mascara apenas o texto do cliente
  const uni = (ctx && ctx.interpretacao && ctx.interpretacao.cliente_unificado) || '';
  const ult = Array.isArray(ctx && ctx.historico && ctx.historico.ultimas_do_cliente)
    ? ctx.historico.ultimas_do_cliente.map(m => String(m.texto||'')).join(' ')
    : '';
  const payload = uni || ult || '';
  const masked = maskSensitive(payload);
  return [
    'CLIENTE:',
    masked || '(vazio)'
  ].join('\n');
}

function maskSensitive(s) {
  try {
    let x = String(s||'');
    x = x.replace(/\b(?:\+?55\s*)?(?:\(?[1-9]{2}\)?[\s.\-()]?)?(?:9?\d{4}[\s.\-()]?\d{4})\b/g, '*');
    x = x.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]');
    x = x.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]');
    x = x.replace(/\b(?:\d[\s.\-()]?){8,11}\b/g, '**');
    return x;
  } catch { return String(s||''); }
}

function buildSystemPromptFromInstrucoes(instrucoes) {
  const xs = Array.isArray(instrucoes) ? instrucoes.filter(Boolean) : [];
  if (!xs.length) return '';
  return 'INSTRUCOES:\n- ' + xs.join('\n- ');
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

  // Garantia de reciprocidade: se existir texto_cliente com saudação e a resposta não iniciar com saudação, prepend
  if (
    ctx && ctx.fluxo && ctx.fluxo.saudacao === true &&
    ctx.interpretacao && ctx.interpretacao.texto_cliente &&
    /(oi|ol[aá]|bom\s*dia|boa\s*tarde|boa\s*noite|tudo\s*bem|blz|beleza|opa)/i.test(ctx.interpretacao.texto_cliente.toLowerCase()) &&
    !/^(oi|ol[aá]|bom\s*dia|boa\s*tarde|boa\s*noite|tudo\s*bem|blz|beleza|opa)/i.test(s)
  ) {
    s = "Oi! " + s.charAt(0).toLowerCase() + s.slice(1);
  }

  // Remove eco/agradecimentos/recapitulacao
  s = s.replace(/(você (mencionou|informou|já me passou|citou|disse|solicitou)|seu pedido foi|obrigado pel[oa]|\bentendi\b|\bvi que\b|notei que|entendi sua necessidade)[^.!?]*[.!?]?/gi, '').trim();

  // Privacidade
  s = s.replace(/\b\d{8,11}\b/g, '******');

  // Remove saudação se não flag
  if (ctx && ctx.fluxo && ctx.fluxo.saudacao === false) {
    s = s.replace(/^\s*(?:oi|ol[aá]|e[ai]|opa|salve|fala|bom\sdia|boa\starde|boa\s*noite)[!,. ]+/i, '').trim();
  }

  // Remove explicação de orçamento se não flag
  if (!(ctx && ctx.fluxo && ctx.fluxo.explicar_fluxo)) {
    s = s.replace(/o valor (exato )?(ser[aá]|é|eh)\s+(informado|passado)\s+pelo\s+motorista[^.]*\./i, '').trim();
  }

  // Amplie remoção de orçamento fora de hora
  if (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar !== "telefone") {
    s = s.replace(/\b(or[cç]amento|pre[cç]o|valor)\b[^.!?]{0,180}\b(motorista|whats|whatsapp)\b[^.!?]*[.!?]/gi, '').trim();
  }

  // Remova bullets/listas
  s = s.replace(/(^|\s)[-•*]\s+/g, ' ').replace(/\b\d+\)\s+/g, ' ').trim();

  // Aplique mascaramento reforçado
  s = maskSensitive(s);

  // Regional e prioridade
  const region = ctx && ctx.meta && ctx.meta.regiao || (ctx && ctx.analitico && ctx.analitico.contexto_regional);
  s = applyRegionalTone(s, region);
  s = shortenIfPriority(s, ctx && ctx.fluxo && ctx.fluxo.prioridade);

  if (!s) return '';
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
  buildSystemPromptFromInstrucoes,
  sanitizeAnswer,
  render
};
