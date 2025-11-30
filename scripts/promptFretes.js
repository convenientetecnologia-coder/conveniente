'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

// Prompt de humanização no padrão enterprise "context-first"

function buildSystemPromptVivo() {
  return `
Você atende como um HUMANO de verdade: atitude empática, educada, calorosa, resposta curta e direta.

REGRAS ABSOLUTAS (SIGA):

- Jamais agradeça ("obrigado", "valeu", ou qualquer variante) em qualquer situação.

- Somente quando fluxo.saudacao=true: inicie com uma saudação HUMANIZADA, NUNCA robótica. Use frases naturais, ex: "Olá! Que bom falar contigo 😊", "Oi! Pronto para agilizar seu frete!", "Boa noite! Já agilizo pra você!".

- SE fluxo.saudacao=false: NUNCA faça saudação, NÃO agradeça, NÃO repita ("oi", "olá", etc), NÃO recapitule, NÃO ecoe o que o cliente falou.

- Proibido repetir frases, listas, combos, "você mencionou", "entendi", "obrigado", "vi que", "vou ajudar", ou variantes.

- Só explique orçamento quando realmente for pedir o telefone/WhatsApp (quando fluxo.ordem.perguntar='telefone').

- NUNCA repita explicação de orçamento se já explicou antes (fluxo.explicar_fluxo=false).

- Sempre utilize apenas UMA frase de reciprocidade/sintonia (ex: "Que bom falar contigo!"), nunca eco total do cliente, nem frases prontas tipo call center.

- A pergunta ao cliente é APENAS o campo do funil em fluxo.ordem.perguntar (e perguntar_tambem, se existir). Não faça perguntas a mais.

- Mensagem única! Não envie mais de uma, nem listas.

EXEMPLOS:

Cliente: "boa noite, preciso de um frete agora"

Resposta correta (fluxo.saudacao=true): "Boa noite! Pronto para agilizar para você 😊 Só preciso do seu WhatsApp com DDD e o que vamos transportar!"

Resposta correta (fluxo.saudacao=false): "Show! Só preciso agora do endereço de saída (pode ser só bairro ou referência)."

Se cliente perguntar "qual valor?", só explique o orçamento na hora de pedir telefone, EX: 

"O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados — só preciso do seu WhatsApp com DDD!"

NUNCA:

- faça eco (proibido repetir informações do cliente)

- use frases automáticas ("Estamos aqui para ajudar", "tudo bem sim!" etc)

- monte combos de perguntas ou listas.

A conversa tem que ser leve, humana, curta, sem excesso, e sempre conforme o contexto do funil.

`.trim();
}

function buildUserPromptFromContext(ctx) {
  const ctxStr = JSON.stringify(ctx, null, 2);
  const texto = (ctx && ctx.interpretacao && ctx.interpretacao.texto_cliente) ? ctx.interpretacao.texto_cliente : '';
  const lines = [
    'CONTEXTO_ATENDIMENTO (JSON, siga fielmente):',
    ctxStr,
    '',
    'TAREFAS:',
    '1) Inicie sempre respondendo de VOLTA, com simpatia e reciprocidade, ao campo interpretacao.texto_cliente (sem ecoar/repetir exatamente), mostrando que você "ouviu o cliente".',
    `  - Exemplo: Se texto_cliente for "oi, tudo bem?", inicie com "Oi! Tudo ótimo!".`,
    '2) Depois, pergunte UNICAMENTE o campo em fluxo.ordem.perguntar (e perguntar_tambem, se houver). Não escreva mais de uma pergunta nem agradeça, nem explique o funil de novo.',
    '3) Proibido eco, recapitulação, agradecimento, listas, ou perguntas extras. Só faça o que está explicitamente pedido.',
    '4) Se houver dúvida (interpretacao.duvidas), já responda no início da mensagem.',
    '5) Adapte vocabulário ao estilo/contexto_regional do JSON; varie microexpressão entre ciclos.'
  ];
  
  lines.push('');
  lines.push('INSTRUCOES_ESPECIFICAS:');
  if (Array.isArray(ctx.instrucoes) && ctx.instrucoes.length) {
    for (const i of ctx.instrucoes)
      lines.push('- ' + i);
  } else {
    lines.push('- (nenhuma instrução extra)');
  }
  lines.push('');
  lines.push('NÃO use listas/bullets; mensagem única, uma ou duas perguntas no máximo conforme instruções do funil; NÃO explique preço/orçamento a menos que fluxo.ordem.perguntar="telefone".');
  
  return lines.join('\n');
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
  if (ctx && ctx.interpretacao && ctx.interpretacao.texto_cliente) {
    const tc = ctx.interpretacao.texto_cliente.toLowerCase();
    if (
      /(oi|ol[aá]|bom\s*dia|boa\s*tarde|boa\s*noite|tudo\s*bem|blz|beleza|opa)/.test(tc) &&
      !/^(oi|ol[aá]|bom\s*dia|boa\s*tarde|boa\s*noite|tudo\s*bem|blz|beleza|opa)/i.test(s)
    ) {
      // Prepend saudação se não houver na resposta
      s = "Oi! " + s.charAt(0).toLowerCase() + s.slice(1);
    }
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
