'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

function maskSensitive(s) {
  try {
    let x = String(s||'');
    x = x.replace(/\b(?:\+?55\s*)?(?:\(?[1-9]{2}\)?[\s.\-()]?)?(?:9?\d{4}[\s.\-()]?\d{4})\b/g, '*'); // telefones
    x = x.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]'); // CPF
    x = x.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]'); // CNPJ
    x = x.replace(/\b(?:\d[\s.\-()]?){8,11}\b/g, '**'); // genérico
    return x;
  } catch { return String(s||''); }
}

function applyRegionalTone(text, region) {
  let s = String(text||'');
  if (!region) return s;
  if (region === 'nordeste') {
    s = s.replace(/\bem alguns minutinhos\b/gi, 'já já');
  } else if (region === 'sul') {
    s = s.replace(/\bem alguns minutinhos\b/gi, 'em instantes');
  } else if (region === 'sudeste_mg') {
    s = s.replace(/\bem alguns minutinhos\b/gi, 'rapidinho');
  }
  return s;
}

function shortenIfPriority(text, prioridade) {
  let s = String(text||'').replace(/\s+/g, ' ').trim();
  if (prioridade !== 'alta') return s;
  if (s.length > 220) s = s.slice(0, 220).replace(/[,;:\s]+[^,;:\s]*$/, '');
  return s.trim();
}

function buildSystemPromptUnico() {
  return `
Você é o Atendente Conveniente. Seu texto soa humano, simpático e direto, nunca robótico.

Objetivo do ciclo:

    Produzir UMA ÚNICA mensagem ao cliente.
    Opcional: saudação somente se "fluxo.saudacao" = true.
    Responder dúvidas/protestos em 1–2 frases no máximo, sem inventar.
    Fazer APENAS a(s) pergunta(s) definida(s) no ORK (ask_field e, se houver, ask_next_field), na ordem. Finalize com a pergunta do funil.
    Jamais envie duas mensagens no mesmo ciclo.

Campos do funil (controle virá no ORK):

    telefone (WhatsApp BR) — pode ser completo ou vir em partes: ddd (2 dígitos) e telefone_parcial (8–9 dígitos).
    itens (o que transportar).
    endereco_saida (aceita informal; bairro/referência).
    endereco_destino (aceita informal; bairro/referência).
    ajudante (sim/não — opcional).
    descricao (observação breve — opcional).

Regras duras:

    Nunca agradeça ("obrigado", "valeu" etc.).
    Nunca ecoe ou recapitule o que o cliente disse.
    Nunca use listas/bullets ou promova segunda mensagem ("vou te chamar", "aguarde"…).
    Nunca diga "entendi", "vi que", "estou aqui para ajudar", "podemos ajudar".
    Nunca invente contexto ("parece correria" etc.).
    Endereço: aceite informal; NÃO peça "rua/número/bairro".
    Não normalize tipo de imóvel/elevador.
    Não repita números do cliente no texto. Peça só o que estiver faltando (DDD ou número).
    Orçamento: só explique "o valor exato é passado pelo motorista no WhatsApp…" quando o ORK (fluxo.explicar_orcamento/excluir_fluxo=false) mandar neste ciclo. Fora isso, não fale de orçamento.
    Não repita saudação; não repita explicação de orçamento em ciclos seguintes.

Telefone (BR):

    ask_field = "telefone":
        Se "dados.telefone_parcial = presente" e "dados.ddd = ausente": peça APENAS o DDD (2 dígitos).
        Se "dados.ddd = presente" e "dados.telefone_parcial = ausente": peça APENAS o número (8–9 dígitos, sem DDD).
        Se ambos ausentes: peça WhatsApp com DDD numa frase curta.
    Não recite/reforme o número informado pelo cliente.

Dúvidas:

    Preço/valor/orçamento: responda apenas conforme o ORK autorizar neste ciclo; evite repetição futura.
    Quando o motorista chama: "em alguns minutinhos".
    Disponibilidade/como funciona: uma frase, objetiva.

Estilo:

    Frases curtas e claras; micro-variação leve; no máx. 0–1 emoji.
    Ajuste de tom conforme "fluxo.nivel": acolhedor | objetivo | direto.
    Prioridade "alta" encurta a mensagem.

Precedência:

    Se houver conflito, siga o ORK (INSTRUCOES DO CICLO) enviado no USER.
    Pergunte unicamente ask_field e, se houver, ask_next_field. Não crie nada além disso.

Padrões de pergunta (ajuste leve conforme tom):

    telefone: "Me passa seu WhatsApp com DDD?"
    ddd: "Me diz o DDD?"
    telefone_parcial: "Me envia o número (sem DDD)?"
    itens: "O que você precisa transportar?"
    endereco_saida: "Qual é o endereço de saída? Pode ser bairro ou referência."
    endereco_destino: "E o destino? Pode ser bairro ou referência."
    ajudante: "Precisa de ajudante (sim ou não)?"
    descricao: "Tem alguma observação rápida?"

Saída final:

    Apenas o texto único para o cliente, sem bullets e sem segunda mensagem. `.trim();
}

function buildUserPromptUnico(ctx) {
  const clienteUni = (ctx && ctx.interpretacao && ctx.interpretacao.cliente_unificado) || '';
  const masked = maskSensitive(clienteUni);

  const ork = {
    meta: {
      perfil: (ctx && ctx.meta && ctx.meta.perfil) || null,
      chatId: (ctx && ctx.meta && ctx.meta.chatId) || null,
      cidade: (ctx && ctx.meta && ctx.meta.cidade) || null,
      regiao: (ctx && ctx.meta && ctx.meta.regiao) || null
    },
    fluxo: {
      saudacao: !!(ctx && ctx.fluxo && ctx.fluxo.saudacao),
      // Aceita ambas as chaves por compatibilidade (explicar_fluxo ou explicar_orcamento)
      explicar_orcamento: !!(ctx && ctx.fluxo && (ctx.fluxo.explicar_fluxo || ctx.fluxo.explicar_orcamento)),
      ask_field: (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar) || (ctx && ctx.directive && ctx.directive.field) || null,
      ask_next_field: (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar_tambem) || null,
      nivel: (ctx && ctx.fluxo && ctx.fluxo.estilo) || 'objetivo',
      prioridade: (ctx && ctx.fluxo && ctx.fluxo.prioridade) || 'normal'
    },
    dados: {
      telefone: (ctx && ctx.dados && ctx.dados.ja_fornecidos && ctx.dados.ja_fornecidos.telefone) ? 'presente' : 'ausente',
      ddd: (ctx && ctx.dados && ctx.dados.ja_fornecidos && ctx.dados.ja_fornecidos.ddd) ? 'presente' : 'ausente',
      telefone_parcial: (ctx && ctx.dados && ctx.dados.ja_fornecidos && ctx.dados.ja_fornecidos.telefone_parcial) ? 'presente' : 'ausente',
      itens: (ctx && ctx.dados && ctx.dados.ja_fornecidos && ctx.dados.ja_fornecidos.itens) ? 'presente' : 'ausente',
      endereco_saida: (ctx && ctx.dados && ctx.dados.ja_fornecidos && ctx.dados.ja_fornecidos.endereco_saida) ? 'presente' : 'ausente',
      endereco_destino: (ctx && ctx.dados && ctx.dados.ja_fornecidos && ctx.dados.ja_fornecidos.endereco_destino) ? 'presente' : 'ausente',
      ajudante: ((ctx && ctx.dados && ctx.dados.ja_fornecidos && typeof ctx.dados.ja_fornecidos.ajudante === 'boolean') ? String(ctx.dados.ja_fornecidos.ajudante) : 'indefinido')
    },
    duvidas_detectadas: (ctx && ctx.interpretacao && Array.isArray(ctx.interpretacao.duvidas)) ? ctx.interpretacao.duvidas : [],
    cliente: {
      texto_unificado: masked || '',
      ultimas: Array.isArray(ctx && ctx.historico && ctx.historico.ultimas_do_cliente) ? ctx.historico.ultimas_do_cliente.map(m => String(m.texto||'')).slice(-4) : []
    }
  };

  return [
    'CLIENTE:',
    masked || '(vazio)',
    '',
    'ORK_JSON:',
    JSON.stringify(ork, null, 2)
  ].join('\n');
}

function sanitizeAnswerUnico(out, ctx) {
  let s = String(out || '').replace(/\s+/g, ' ').trim();

  // Remove eco/agradecimentos/recapitulações comuns
  s = s.replace(/(obrigad[oa]|valeu|entendi|vi que|você mencionou|você informou|já me passou|notei que|seu pedido foi)[^.!?]*[.!?]?/gi, '').trim();

  // Privacidade
  s = s.replace(/\b(?:\+?55\s*)?(?:\(?[1-9]{2}\)?[\s.\-()]?)?(?:9?\d{4}[\s.\-()]?\d{4})\b/g, '*');
  s = s.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]');
  s = s.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]');
  s = s.replace(/\b(?:\d[\s.\-()]?){8,11}\b/g, '**');

  // Remove saudação quando não permitido
  if (ctx && ctx.fluxo && ctx.fluxo.saudacao === false) {
    s = s.replace(/^\s*(?:oi|ol[aá]|e[ai]|opa|salve|fala|bom\sdia|boa\starde|boa\s*noite)[!,. ]+/i, '').trim();
  }

  // Remove explicação de orçamento fora de hora (aceita ambas flags)
  const podeExplicar = !!(ctx && ctx.fluxo && (ctx.fluxo.explicar_fluxo || ctx.fluxo.explicar_orcamento));
  if (!podeExplicar) {
    s = s.replace(/o valor (exato )?(ser[aá]|é|eh)\s+(informado|passado)\s+pelo\s+motorista[^.]./i, '').trim();
    s = s.replace(/\b(or[cç]amento|pre[cç]o|valor)\b[^.!?]{0,180}\b(motorista|whats|whatsapp)\b[^.!?][.!?]/gi, '').trim();
  }

  // Remove listas/bullets
  s = s.replace(/(^|\s)[-•*]\s+/g, ' ').replace(/\b\d+\)\s+/g, ' ').trim();

  // Tom regional e prioridade
  const region = (ctx && ctx.meta && ctx.meta.regiao) || null;
  s = applyRegionalTone(s, region);
  const prio = ctx && ctx.fluxo && ctx.fluxo.prioridade;
  s = shortenIfPriority(s, prio);

  return s || '';
}

async function renderUnico(ctx) {
  const system = buildSystemPromptUnico();
  const user = buildUserPromptUnico(ctx);
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
  return sanitizeAnswerUnico(raw, ctx);
}

module.exports = { buildSystemPromptUnico, buildUserPromptUnico, sanitizeAnswerUnico, renderUnico };
