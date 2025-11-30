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

TEMPLATE OBRIGATÓRIO DE SAÍDA (quando aplicável no ciclo):

    Saudação curta (somente se "fluxo.saudacao" = true).
    Informação objetiva (apenas se pertinente ao texto do cliente):
        Se perguntarem disponibilidade (ex.: "está disponível?"): "Sim, está disponível!"
        Se mencionarem urgência "agora/hoje/para já": "Consigo te atender agora."
    Orçamento/fluxo: Só quando "fluxo.explicar_orcamento" = true, inclua exatamente: "O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Repasso para ele, e você recebe o orçamento certinho."
    Pedido de WhatsApp conforme ask_field:
        telefone: peça "o WhatsApp com DDD" (ou somente DDD/número, conforme status dos dados).
        ddd: peça APENAS o DDD (2 dígitos).
        telefone_parcial: peça APENAS o número (8–9 dígitos, sem DDD).
    Próxima pergunta do funil (ask_next_field, se existir).

SEM EXCEÇÕES: uma única mensagem integrando os 5 itens necessários daquele ciclo (alguns itens podem não aparecer se a flag do fluxo não exigir).

Campos do funil (controle virá no ORK):

    telefone (WhatsApp BR): completo OU partes (ddd 2 dígitos, telefone_parcial 8–9 dígitos).
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
    Nunca invente contexto ("parece correria"…).
    Endereço: aceite informal; NÃO peça "rua/número/bairro".
    Não normalize tipo de imóvel/elevador.
    Não repita números do cliente no texto. Peça só o que estiver faltando (DDD ou número).
    Orçamento: siga estritamente "fluxo.explicar_orcamento" (true/false). Fora isso, não fale de orçamento.
    Não repita saudação; não repita explicação do orçamento em ciclos seguintes.

Telefone (BR):

    ask_field = "telefone":
        Se "dados.telefone_parcial = presente" e "dados.ddd = ausente": peça APENAS o DDD (2 dígitos).
        Se "dados.ddd = presente" e "dados.telefone_parcial = ausente": peça APENAS o número (8–9 dígitos, sem DDD).
        Se ambos ausentes: peça WhatsApp com DDD numa frase curta.
    Não recite/reforme o número informado pelo cliente.

Dúvidas:

    Preço/valor/orçamento: responda apenas quando "fluxo.explicar_orcamento" = true.
    Quando o motorista chama: "em alguns minutinhos".
    Disponibilidade: responda "Sim, está disponível!" (se a mensagem do cliente indicar essa pergunta padrão do Marketplace).
    "Faz frete?": responda "Sim, fazemos fretes." (uma frase curta antes do pedido de WhatsApp).

Estilo:

    Frases curtas e claras; micro-variação leve; no máx. 0–1 emoji.
    Ajuste de tom conforme "fluxo.nivel": acolhedor | objetivo | direto.
    Prioridade "alta" encurta a mensagem.

Precedência:

    Se houver conflito, siga o ORK (ask_field e ask_next_field).
    Nunca pergunte além do que o ORK determinou.

Saída final:

    Apenas o texto único para o cliente, sem bullets e sem segunda mensagem. `.trim();
}

function buildUserPromptUnico(ctx) {
  const clienteUni = (ctx && ctx.interpretacao && ctx.interpretacao.cliente_unificado) || '';
  const masked = maskSensitive(clienteUni);

  // Sinalização explícita de coleta (COLETADO / URGENTE / PENDENTE)
  const jf = (ctx && ctx.dados && ctx.dados.ja_fornecidos) || {};
  const ask = (ctx && ctx.fluxo && ctx.fluxo.ordem) || {};
  const coleta_status = {
    telefone: jf.telefone ? 'COLETADO' : (ask.perguntar === 'telefone' || ask.perguntar === 'ddd' || ask.perguntar === 'telefone_parcial' ? 'URGENTE' : 'PENDENTE'),
    ddd: jf.ddd ? 'COLETADO' : (ask.perguntar === 'ddd' ? 'URGENTE' : 'PENDENTE'),
    telefone_parcial: jf.telefone_parcial ? 'COLETADO' : (ask.perguntar === 'telefone_parcial' ? 'URGENTE' : 'PENDENTE'),
    itens: jf.itens ? 'COLETADO' : (ask.perguntar === 'itens' ? 'URGENTE' : 'PENDENTE'),
    endereco_saida: jf.endereco_saida ? 'COLETADO' : (ask.perguntar === 'endereco_saida' ? 'URGENTE' : 'PENDENTE'),
    endereco_destino: jf.endereco_destino ? 'COLETADO' : (ask.perguntar === 'endereco_destino' ? 'URGENTE' : 'PENDENTE'),
    ajudante: (typeof jf.ajudante === 'boolean') ? 'COLETADO' : (ask.perguntar === 'ajudante' ? 'URGENTE' : 'PENDENTE')
  };

  // Políticas de atendimento para o ciclo
  const politicas = {
    pedir_whats_na_saudacao: !!(ctx && ctx.fluxo && ctx.fluxo.saudacao && (ask.perguntar === 'telefone' || ask.perguntar === 'ddd' || ask.perguntar === 'telefone_parcial')),
    pedir_whats_apos_destino_se_faltando: true,
    saltar_pergunta_itens_se_jafornecido: !!jf.itens
  };

  const ork = {
    meta: {
      perfil: (ctx && ctx.meta && ctx.meta.perfil) || null,
      chatId: (ctx && ctx.meta && ctx.meta.chatId) || null,
      cidade: (ctx && ctx.meta && ctx.meta.cidade) || null,
      regiao: (ctx && ctx.meta && ctx.meta.regiao) || null
    },
    fluxo: {
      saudacao: !!(ctx && ctx.fluxo && ctx.fluxo.saudacao),
      explicar_orcamento: !!(ctx && ctx.fluxo && (ctx.fluxo.explicar_fluxo || ctx.fluxo.explicar_orcamento)),
      ask_field: (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar) || (ctx && ctx.directive && ctx.directive.field) || null,
      ask_next_field: (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar_tambem) || null,
      nivel: (ctx && ctx.fluxo && ctx.fluxo.estilo) || 'objetivo',
      prioridade: (ctx && ctx.fluxo && ctx.fluxo.prioridade) || 'normal',
      politicas
    },
    dados: {
      telefone: jf.telefone ? 'presente' : 'ausente',
      ddd: jf.ddd ? 'presente' : 'ausente',
      telefone_parcial: jf.telefone_parcial ? 'presente' : 'ausente',
      itens: jf.itens ? 'presente' : 'ausente',
      endereco_saida: jf.endereco_saida ? 'presente' : 'ausente',
      endereco_destino: jf.endereco_destino ? 'presente' : 'ausente',
      ajudante: ((typeof jf.ajudante === 'boolean') ? String(jf.ajudante) : 'indefinido')
    },
    coleta_status,
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
