// promptFretes.js

'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

// ============================================================================
// POOLS DE FRASES - VARIEDADE E PERSONALIZAÇÃO
// ============================================================================

const POOLS = {
  saudacao: {
    formal: [
      'Bom dia!',
      'Boa tarde!',
      'Boa noite!',
      'Olá!',
      'Olá, tudo bem?'
    ],
    animado: [
      'Oi! Tudo bem?',
      'Olá! Que bom falar contigo!',
      'Oi, oi! Pronto pra agilizar!',
      'Bom dia! Vamos lá!',
      'Boa tarde! Bora resolver isso!',
      'Boa noite! Vamos agilizar!'
    ],
    empolgado: [
      'Oi! Que bom!',
      'Olá! Vamos resolver isso!',
      'Opa! Bora agilizar!',
      'Bom dia! Vamos lá!',
      'Boa tarde! Vamos resolver!',
      'Boa noite! Vamos agilizar!'
    ],
    casual: [
      'Oi!',
      'Olá!',
      'E aí!',
      'Opa!',
      'Salve!'
    ]
  },

  papelAtendente: [
    'Faço o primeiro atendimento e anoto seus dados; depois repasso pro motorista.',
    'Eu anoto o pedido aqui e repasso pro motorista; ele entra em contato direto com você.',
    'Vou anotar seus dados e encaminhar pro motorista; ele te chama no WhatsApp.',
    'Meu papel é anotar o pedido e repassar pro motorista; ele te passa os detalhes direto.',
    'Anoto aqui e envio pro motorista; ele te chama pra combinar tudo.'
  ],

  orcamentoMotorista: [
    'Quem passa o orçamento é o motorista no WhatsApp; eu apenas anoto o pedido e repasso pra ele.',
    'O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Repasso para ele, e você recebe o orçamento certinho.',
    'O motorista que informa o preço direto no WhatsApp; eu só registro e encaminho.',
    'Quem define o valor é o motorista, pelo WhatsApp; eu anoto tudo e repasso pra ele.'
  ],

  pedirWhatsapp: {
    completo: [
      'Pode me passar o seu WhatsApp com DDD?',
      'Me envia seu WhatsApp com DDD, por favor?',
      'Qual seu WhatsApp com DDD?',
      'Preciso do seu WhatsApp com DDD para repassar ao motorista.',
      'Me manda seu número do WhatsApp com DDD?'
    ],
    ddd: [
      'Me passa só o DDD (2 dígitos) para completar o WhatsApp?',
      'Falta só o DDD (2 dígitos) do seu WhatsApp?',
      'Qual o DDD do seu WhatsApp?',
      'Me envia o DDD para completar o número?'
    ],
    parcial: [
      'Me envia o número do WhatsApp (sem DDD), com 8 ou 9 dígitos?',
      'Falta só o número (8 ou 9 dígitos, sem DDD)?',
      'Qual o número do WhatsApp (sem DDD)?',
      'Me manda o número completo, sem o DDD?'
    ]
  },

  perguntaItens: [
    'O que você precisa transportar?',
    'Qual ou quais itens você precisa levar?',
    'Me fala o que você quer transportar?',
    'Quais são os itens do frete?',
    'O que vamos transportar?',
    'Quais objetos ou móveis você precisa levar?'
  ],

  perguntaEnderecoSaida: [
    'Qual é o endereço completo de saída? Pode ser bairro ou ponto de referência.',
    'De onde vamos buscar? Pode ser só o bairro ou uma referência.',
    'Qual o endereço de retirada? Aceito bairro ou ponto conhecido.',
    'Onde vamos coletar os itens? Pode ser só a região ou referência.',
    'Me passa o endereço de saída? Pode ser informal, só bairro ou referência.'
  ],

  perguntaEnderecoDestino: [
    'Qual é o endereço completo de destino? Pode ser bairro ou ponto de referência.',
    'Para onde vamos entregar? Pode ser só o bairro ou uma referência.',
    'Qual o endereço de entrega? Aceito bairro ou ponto conhecido.',
    'Onde vamos levar os itens? Pode ser só a região ou referência.',
    'Me passa o endereço de destino? Pode ser informal, só bairro ou referência.'
  ],

  pendenteWhatsapp: [
    'Para seguir, preciso do seu WhatsApp com DDD – sem ele não consigo repassar o pedido para o motorista.',
    'Assim que enviar o WhatsApp completo, seguimos rapidinho! Ficarei aguardando.',
    'Seu pedido ficará pendente enquanto não recebemos o WhatsApp certo. Assim que enviar o número completo, finalizamos para você!'
  ]
};

// ============================================================================
// FUNÇÕES AUXILIARES - SELEÇÃO E MATCHING
// ============================================================================

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// Memória de picks para evitar repetição absoluta na mesma sessão
function pickVar(ctx, key, arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  
  // Inicializa memória se não existir
  if (!ctx.memory) ctx.memory = {};
  if (!ctx.memory.used) ctx.memory.used = {};
  if (!ctx.memory.used[key]) ctx.memory.used[key] = [];
  
  // Filtra opções já usadas
  const available = arr.filter(item => !ctx.memory.used[key].includes(item));
  
  // Se todas foram usadas, reseta e começa de novo
  const pool = available.length > 0 ? available : arr;
  
  // Escolhe aleatoriamente
  const picked = pickRandom(pool);
  
  // Registra na memória
  if (picked) {
    ctx.memory.used[key].push(picked);
  }
  
  return picked;
}

function analyzeClientTone(firstMsg) {
  try {
    const msg = String(firstMsg || '').toLowerCase();
    if (!msg) return 'casual';

    // Análise de empolgado (repetições de vogais, textos longos, vários pontos de exclamação, emojis de alegria)
    const empolgado = /(a{3,}|e{3,}|i{3,}|o{3,}|u{3,}|!{3,}|😊|😁|kkk|hahaha|rsrsrs)/i.test(msg);
    if (empolgado) return 'empolgado';

    // Análise de energia/animado (moderado)
    const animado = /(!!+|!{2,}|😊|😁|kk|haha|rsrs|hehe|bom\s+dia{3,}|boa\s+tarde{3,})/i.test(msg);
    if (animado) return 'animado';

    // Análise de formalidade
    const formal = /^(bom\s+dia|boa\s+tarde|boa\s+noite|olá|senhor|senhora)/i.test(msg);
    if (formal) return 'formal';

    return 'casual';
  } catch {
    return 'casual';
  }
}

function getSaudacaoFromCliente(msgCliente, horario) {
  const tone = analyzeClientTone(msgCliente);
  const pool = POOLS.saudacao[tone] || POOLS.saudacao.casual;
  
  let saud = pickRandom(pool);
  
  // Ajusta saudação pelo horário se necessário
  if (horario) {
    const h = new Date(String(horario || '')).getHours();
    if (h >= 0 && h < 12 && !saud.includes('dia')) {
      saud = saud.replace(/^(oi|olá|opa)/i, 'Bom dia');
    } else if (h >= 12 && h < 18 && !saud.includes('tarde')) {
      saud = saud.replace(/^(oi|olá|opa)/i, 'Boa tarde');
    } else if (h >= 18 && !saud.includes('noite')) {
      saud = saud.replace(/^(oi|olá|opa)/i, 'Boa noite');
    }
  }
  
  // EMOJI: SOMENTE para tom "animado" ou "empolgado"
  if (tone === 'animado' || tone === 'empolgado') {
    // Se não tem emoji, adiciona um
    if (!/[😊😁👍]/.test(saud)) {
      const emojis = ['😊', '😁'];
      const emoji = pickRandom(emojis);
      saud = saud.replace(/([!?.])?$/, ` ${emoji}$1`).trim();
    }
  } else {
    // Remove emojis se for "casual" ou "formal"
    saud = saud.replace(/[😊😁👍]/g, '').trim();
  }
  
  return saud || 'Oi!';
}

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

// ============================================================================
// PROMPTS PARA LLM
// ============================================================================

function buildSystemPromptUnico() {
  return `
Você é o Atendente Conveniente. Seu texto soa humano, acolhedor e direto, nunca robótico.

IMPORTANTE: VARIEDADE E MATCHING DE TOM
- SEMPRE varie suas frases e tom, evitando repetir texto igual na mesma sessão.
- NUNCA ecoe a frase do cliente, evite frase pronta robótica.
- Combine a energia/tom do cliente conforme analisado no histórico (se veio animado, responda animado; se formal, responda formal).
- Use variações naturais: diferentes formas de saudar, pedir dados, explicar o processo.

TEMPLATE OBRIGATÓRIO DE SAÍDA (quando aplicável no ciclo):

    Saudação breve e calorosa (somente se "fluxo.saudacao" = true), variando conforme tom do cliente.
    Informação objetiva, conforme "ORK_JSON.sinais":
        Se sinais.disponibilidade = true: "Sim, está disponível!"
        Se sinais.urgencia_agora = true: "Consigo te atender agora."
    Orçamento (somente quando "fluxo.explicar_orcamento" = true): insira EXATAMENTE as linhas:
        "fluxo.motorista_linha"
        "fluxo.orcamento_linha"
    Pedido de WhatsApp conforme ask_field:
        telefone: peça "o WhatsApp com DDD" (varie a forma de pedir).
        ddd: peça APENAS o DDD (2 dígitos).
        telefone_parcial: peça APENAS o número (8–9 dígitos, sem DDD).
        Nunca repita ou reforme o número do cliente no texto.
    Pergunte OBRIGATORIAMENTE também "ask_next_field" (se existir). Ordem: primeiro ask_field; depois ask_next_field. A última frase DEVE ser a pergunta do ask_next_field, se ele existir.

Campos do funil:

    telefone (WhatsApp BR) — completo OU partes (ddd 2 dígitos, telefone_parcial 8–9 dígitos).
    itens — varie a forma de perguntar "O que você precisa transportar?"
    endereco_saida — peça "Qual é o endereço completo de saída?" (ACEITE resposta informal).
    endereco_destino — peça "Qual é o endereço completo de destino?" (ACEITE resposta informal).
    descricao — observação breve (opcional).

Regras duras:

    Nunca agradeça ("obrigado", "valeu" etc.).
    Nunca ecoe/recapitule o que o cliente disse (ex.: não escreva "Você precisa levar…").
    Nunca use listas/bullets ou envie segunda mensagem.
    Nunca diga "entendi", "vi que", "estou aqui para ajudar", "podemos ajudar".
    Endereço: peça "endereço completo", mas ACEITE informal (bairro/referência).
    Não normalize tipo de imóvel/elevador.
    Orçamento: siga estritamente "fluxo.explicar_orcamento". Fora isso, não fale de orçamento.
    Não repita saudação; não repita explicação de orçamento em ciclos seguintes.
    SEMPRE varie suas frases - nunca repita exatamente a mesma mensagem.

Dúvidas:

    "Quando chama?": responda "em alguns minutinhos".
    "Faz frete?": responda "Sim, fazemos fretes." numa frase antes do pedido do funil.

    Estilo:

    Frases curtas, claras, com calor humano.
    EMOJI: Use EXATAMENTE 1 emoji (😊 ou 😁) APENAS se tom_cliente for "animado" ou "empolgado". Jamais use emoji para "formal" ou "casual".
    "fluxo.nivel": acolhedor | objetivo | direto.
    "fluxo.prioridade" = alta → mensagem mais curta.
    Varie sempre: diferentes formas de saudar, pedir dados, explicar.
    NUNCA repita a mesma frase de respostas anteriores - SEMPRE varie.

Precedência:

    Se houver conflito, siga o ORK (ask_field e ask_next_field). Não invente campos.

Saída final:

    Texto único ao cliente, sem bullets e sem segunda mensagem. `.trim(); 
}

function buildUserPromptUnico(ctx) {
  const clienteUni = (ctx && ctx.interpretacao && ctx.interpretacao.cliente_unificado) || '';
  const masked = maskSensitive(clienteUni);
  const primeiraMsg = Array.isArray(ctx && ctx.historico && ctx.historico.ultimas_do_cliente) 
    ? ctx.historico.ultimas_do_cliente[0]?.texto || ''
    : '';

  const jf = (ctx && ctx.dados && ctx.dados.ja_fornecidos) || {};
  const ask = (ctx && ctx.fluxo && ctx.fluxo.ordem) || {};

  const coleta_status = {
    telefone: jf.telefone ? 'COLETADO' : (ask.perguntar === 'telefone' || ask.perguntar === 'ddd' || ask.perguntar === 'telefone_parcial' ? 'URGENTE' : 'PENDENTE'),
    ddd: jf.ddd ? 'COLETADO' : (ask.perguntar === 'ddd' ? 'URGENTE' : 'PENDENTE'),
    telefone_parcial: jf.telefone_parcial ? 'COLETADO' : (ask.perguntar === 'telefone_parcial' ? 'URGENTE' : 'PENDENTE'),
    itens: jf.itens ? 'COLETADO' : (ask.perguntar === 'itens' ? 'URGENTE' : 'PENDENTE'),
    endereco_saida: jf.endereco_saida ? 'COLETADO' : (ask.perguntar === 'endereco_saida' ? 'URGENTE' : 'PENDENTE'),
    endereco_destino: jf.endereco_destino ? 'COLETADO' : (ask.perguntar === 'endereco_destino' ? 'URGENTE' : 'PENDENTE')
  };

  const politicas = {
    pedir_whats_na_saudacao: !!(ctx && ctx.fluxo && ctx.fluxo.saudacao && (ask.perguntar === 'telefone' || ask.perguntar === 'ddd' || ask.perguntar === 'telefone_parcial')),
    pedir_whats_apos_destino_se_faltando: true,
    saltar_pergunta_itens_se_jafornecido: !!jf.itens
  };

  const sinais = {
    disponibilidade: !!(ctx && ctx.interpretacao && ctx.interpretacao.disponibilidade),
    urgencia_agora: !!(ctx && ctx.interpretacao && ctx.interpretacao.urgencia_agora)
  };

  const motoristaLinha = pickRandom(POOLS.orcamentoMotorista) || 'Quem passa o orçamento é o motorista no WhatsApp; eu apenas anoto o pedido e repasso pra ele.';
  const orcamentoLinha = pickRandom(POOLS.orcamentoMotorista) || 'O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Repasso para ele, e você recebe o orçamento certinho.';
  
  // Usa tom_cliente do contexto se disponível, senão analisa
  const tomCliente = (ctx && ctx.interpretacao && ctx.interpretacao.tom_cliente) || 
                     (ctx && ctx.meta && ctx.meta.tom_cliente) || 
                     analyzeClientTone(primeiraMsg);

  const ork = {
    meta: {
      perfil: (ctx && ctx.meta && ctx.meta.perfil) || null,
      chatId: (ctx && ctx.meta && ctx.meta.chatId) || null,
      cidade: (ctx && ctx.meta && ctx.meta.cidade) || null,
      regiao: (ctx && ctx.meta && ctx.meta.regiao) || null,
      tom_cliente: tomCliente,
      primeira_mensagem: primeiraMsg || ''
    },
    fluxo: {
      saudacao: !!(ctx && ctx.fluxo && ctx.fluxo.saudacao),
      explicar_orcamento: !!(ctx && ctx.fluxo && (ctx.fluxo.explicar_fluxo || ctx.fluxo.explicar_orcamento)),
      motorista_linha: motoristaLinha,
      orcamento_linha: orcamentoLinha,
      ask_field: (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar) || (ctx && ctx.directive && ctx.directive.field) || null,
      ask_next_field: (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar_tambem) || null,
      nivel: (ctx && ctx.fluxo && ctx.fluxo.estilo) || 'acolhedor',
      prioridade: (ctx && ctx.fluxo && ctx.fluxo.prioridade) || 'normal',
      politicas
    },
    dados: {
      telefone: jf.telefone ? 'presente' : 'ausente',
      ddd: jf.ddd ? 'presente' : 'ausente',
      telefone_parcial: jf.telefone_parcial ? 'presente' : 'ausente',
      itens: jf.itens ? 'presente' : 'ausente',
      endereco_saida: jf.endereco_saida ? 'presente' : 'ausente',
      endereco_destino: jf.endereco_destino ? 'presente' : 'ausente'
    },
    coleta_status,
    sinais,
    duvidas_detectadas: (ctx && ctx.interpretacao && Array.isArray(ctx.interpretacao.duvidas)) ? ctx.interpretacao.duvidas : [],
    cliente: {
      texto_unificado: masked || '',
      ultimas: Array.isArray(ctx && ctx.historico && ctx.historico.ultimas_do_cliente) ? ctx.historico.ultimas_do_cliente.map(m => String(m.texto||'')).slice(-4) : [],
      primeira_mensagem: primeiraMsg || '',
      tom_cliente: tomCliente
    }
  };

  // Exemplos para few-shot learning com mais variações
  const exemplos = `
EXEMPLOS DE CONVERSAS (varie sempre conforme o tom do cliente - NUNCA repita igual):

Exemplo 1 - Cliente animado:
Cliente: "Oi!! Preciso de um frete pra agora!!"
Resposta: "Oi! Que bom! 😊 Consigo te atender agora. Faço o primeiro atendimento e anoto seus dados; depois repasso pro motorista. Quem passa o orçamento é o motorista no WhatsApp; eu apenas anoto o pedido e repasso pra ele. O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Pode me passar o seu WhatsApp com DDD? O que você precisa transportar?"

Exemplo 2 - Cliente formal:
Cliente: "Bom dia. Gostaria de solicitar um frete."
Resposta: "Bom dia! Sim, está disponível! Eu anoto o pedido aqui e repasso pro motorista; ele entra em contato direto com você. O motorista que informa o preço direto no WhatsApp; eu só registro e encaminho. O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Me envia seu WhatsApp com DDD, por favor? Qual ou quais itens você precisa levar?"

Exemplo 3 - Cliente casual:
Cliente: "Opa, faz frete?"
Resposta: "Opa! Sim, fazemos fretes. Vou anotar seus dados e encaminhar pro motorista; ele te chama no WhatsApp. Quem define o valor é o motorista, pelo WhatsApp; eu anoto tudo e repasso pra ele. O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Qual seu WhatsApp com DDD? Me fala o que você quer transportar?"

INSTRUÇÕES CRÍTICAS:
- NUNCA ecoe frases do cliente (ex: não diga "Você precisa de um frete" se cliente disse isso).
- NUNCA agradeça ("obrigado", "valeu").
- NUNCA repita exatamente a mesma resposta de ciclos anteriores - SEMPRE varie.
- Use o tom detectado (${tomCliente}) para adequar sua resposta.
- EMOJI: Use EXATAMENTE 1 emoji (😊 ou 😁) APENAS se tom_cliente for "animado" ou "empolgado". Jamais use emoji para "formal" ou "casual".
- Sempre use variações diferentes das frases acima - não copie literalmente.
`;

  return [
    'CLIENTE:',
    masked || '(vazio)',
    '',
    exemplos,
    '',
    'ORK_JSON:',
    JSON.stringify(ork, null, 2)
  ].join('\n');
}

// ============================================================================
// SANITIZAÇÃO E ENFORCEMENT
// ============================================================================

function sanitizeAnswerUnico(out, ctx) {
  let s = String(out || '').replace(/\s+/g, ' ').trim();

  // Remover eco/agradecimentos/recapitulações
  s = s.replace(/(obrigad[oa]|valeu|entendi|vi que|você mencionou|você informou|já me passou|notei que|seu pedido foi)[^.!?][.!?]?/gi, '').trim();
  // Remover restatements do tipo "Você precisa ..."
  s = s.replace(/^\s*(v[ou]c[eê]|você|vc)\s+precisa[^.!?]*[.!?]\s*/gim, '').trim();
  // Corrigir frase estranha
  s = s.replace(/\bqual\s+é\s+o\s+que\s+você\s+precisa\s+transportar\??/gi, 'O que você precisa transportar?');

  // Cortar pedidos de reconfirmação ou repetição
  s = s.replace(/\b(me\s+confirma\s+novamente|pode\s+me\s+confirmar\s+novamente|me\s+passa\s+novamente|me\s+envia\s+de\s+novo|manda\s+de\s+novo|reenvia|reenvie|repete\s+por\s+favor)\b[^.!?]*[.!?]/gi, '').trim();

  // Cortar frases de meta-conversa proibidas
  s = s.replace(/\b(aguarde|vou te chamar|vou\s+te\s+chamar|já\s+volto|volto\s+já|vou\s+chamar|te\s+chamo)\b[^.!?]*[.!?]/gi, '').trim();

  // Privacidade
  s = s.replace(/\b(?:\+?55\s*)?(?:\(?[1-9]{2}\)?[\s.\-()]?)?(?:9?\d{4}[\s.\-()]?\d{4})\b/g, '*');
  s = s.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]');
  s = s.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]');
  s = s.replace(/\b(?:\d[\s.\-()]?){8,11}\b/g, '**');

  // Remove saudação quando não permitido
  if (ctx && ctx.fluxo && ctx.fluxo.saudacao === false) {
    s = s.replace(/^\s*(?:oi|ol[aá]|e[ai]|opa|salve|fala|bom\sdia|boa\starde|boa\s*noite)[!,. ]+/i, '').trim();
  }

  // Remove orçamento fora de hora (APENAS se não for obrigatório)
  const podeExplicar = !!(ctx && ctx.fluxo && (ctx.fluxo.explicar_fluxo || ctx.fluxo.explicar_orcamento));
  if (!podeExplicar) {
    const beforeBudget = s;
    s = s.replace(/o valor (exato )?(ser[aá]|é|eh)\s+(informado|passado)\s+pelo\s+motorista[^.]./i, '').trim();
    s = s.replace(/\b(or[cç]amento|pre[cç]o|valor)\b[^.!?]{0,180}\b(motorista|whats|whatsapp)\b[^.!?][.!?]/gi, '').trim();
    s = s.replace(/\b(motorista)\b[^.!?]{0,80}\b(or[cç]amento|pre[cç]o|valor|passa|informa)\b[^.!?]*[.!?]/gi, '').trim();
    
    // Log quando remove orçamento (auditoria)
    if (beforeBudget !== s) {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL('default', 'sanitize_removed_budget', {
          before: beforeBudget.slice(0, 100),
          after: s.slice(0, 100)
        });
      } catch {}
    }
  }
  // NÃO remove orçamento se ctx.fluxo.explicar_orcamento=true (é obrigatório)

  // Remove bullets/listas (inclui "1." e "1)")
  s = s.replace(/(^|\s)[-•*]\s+/g, ' ')
    .replace(/\b\d+[.)]\s+/g, ' ')
    .trim();

  // FAILSAFE DO EMOJI: baseado no tom do cliente
  const tomCliente = (ctx && ctx.interpretacao && ctx.interpretacao.tom_cliente) || 
                     (ctx && ctx.meta && ctx.meta.tom_cliente) || 
                     'casual';
  
  // Remove todos os emojis se tom não for "animado" ou "empolgado"
  if (tomCliente !== 'animado' && tomCliente !== 'empolgado') {
    const beforeEmoji = s;
    s = s.replace(/[😊😁👍😀😃😄😅😆😉😋😎😍😘😗😙😚😜😝😛😟😠😡😢😣😤😥😦😧😨😩😪😫😬😭😮😯😰😱😲😳😴😵😶😷😸😹😺😻😼😽😾😿🙀🙁🙂🙃🙄🙅🙆🙇🙈🙉🙊🙋🙌🙍🙎🙏]/g, '').trim();
    
    // Log quando remove emoji
    if (beforeEmoji !== s && process.env.LOG_EMOJI_SANITIZE === 'true') {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL('default', 'emoji_removed_sanitize', {
          tom_cliente: tomCliente,
          before: beforeEmoji.slice(0, 50),
          after: s.slice(0, 50)
        });
      } catch {}
    }
  } else {
    // Garante máximo 1 emoji (😊 ou 😁) para tom animado/empolgado
    const emojiMatches = s.match(/[😊😁]/g);
    if (emojiMatches && emojiMatches.length > 1) {
      // Mantém apenas o primeiro emoji válido
      let firstEmojiIndex = -1;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '😊' || s[i] === '😁') {
          firstEmojiIndex = i;
          break;
        }
      }
      if (firstEmojiIndex >= 0) {
        const firstEmoji = s[firstEmojiIndex];
        s = s.replace(/[😊😁]/g, '');
        // Reinsere o primeiro emoji no final
        s = s.trim() + ' ' + firstEmoji;
      }
    }
    
    // Log quando ajusta emoji
    if (emojiMatches && emojiMatches.length > 1 && process.env.LOG_EMOJI_SANITIZE === 'true') {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL('default', 'emoji_normalized_sanitize', {
          tom_cliente: tomCliente,
          count_before: emojiMatches.length,
          after: s.slice(0, 50)
        });
      } catch {}
    }
  }

  // Tom regional e prioridade
  const region = (ctx && ctx.meta && ctx.meta.regiao) || null;
  s = applyRegionalTone(s, region);
  const prio = ctx && ctx.fluxo && ctx.fluxo.prioridade;
  s = shortenIfPriority(s, prio);

  // POLICIAMENTO: Verifica se contém pergunta obrigatória (ask_field e ask_next_field se existir)
  const askField = (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar) || null;
  const askNextField = (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar_tambem) || null;
  
  // Verifica se ask_field está presente
  if (askField && !hasAskFor(s, askField)) {
    // Log erro antes de lançar
    try {
      const stepLog = require('./stepLog.js');
      stepLog.appendJSONL('default', 'sanitize_invalidated_ask', {
        askField: askField,
        askNextField: askNextField || null,
        texto_preview: s.slice(0, 100),
        missing_ask_field: true
      });
    } catch {}
    
    // Lança erro para o FSM tratar
    throw Object.assign(new Error('sanitize_invalidated_ask'), { 
      code: 'sanitize_invalidated_ask',
      askField: askField,
      askNextField: askNextField
    });
  }
  
  // Verifica se ask_next_field está presente (se existir)
  if (askNextField && !hasAskFor(s, askNextField)) {
    // Log erro antes de lançar
    try {
      const stepLog = require('./stepLog.js');
      stepLog.appendJSONL('default', 'sanitize_invalidated_ask', {
        askField: askField || null,
        askNextField: askNextField,
        texto_preview: s.slice(0, 100),
        missing_ask_next_field: true
      });
    } catch {}
    
    // Lança erro para o FSM tratar
    throw Object.assign(new Error('sanitize_invalidated_ask'), { 
      code: 'sanitize_invalidated_ask',
      askField: askField,
      askNextField: askNextField
    });
  }

  return s || '';
}

function hasAskFor(text, field) {
  const s = String(text || '');
  switch (String(field || '')) {
    case 'telefone':
      return /whats\sapp|whatsapp|wpp/i.test(s) && /\bddd\b/i.test(s);
    case 'ddd':
      return /\bddd\b/i.test(s);
    case 'telefone_parcial':
      return /\bsem\sddd\b/i.test(s) || /\b8\sou\s9\sd[ií]gitos\b/i.test(s);
    case 'itens':
      return /o que (você|voce)?\sprecisa\stransportar?/i.test(s) || /o que\sprecisa\s*transportar?/i.test(s) || /qual.*item/i.test(s) || /quais.*itens/i.test(s);
    case 'endereco_saida':
      return /endere[cç]o\s+completo\s+de\s+sa[ií]da/i.test(s) || /onde\s+(buscar|retirar)/i.test(s) || /endere[cç]o\s+de\s+sa[ií]da/i.test(s) || /de\s+onde/i.test(s);
    case 'endereco_destino':
      return /endere[cç]o\s+completo\s+de\s+destino/i.test(s) || /\bpara\s+onde\b/i.test(s) || /local\s+de\s+entrega/i.test(s) || /destino/i.test(s);
    default:
      return false;
  }
}

function shouldExplainBudget(ctx) {
  const fluxoOk = !!(ctx && ctx.fluxo && (ctx.fluxo.explicar_fluxo || ctx.fluxo.explicar_orcamento));
  const priceIntent = !!(ctx && ctx.interpretacao && Array.isArray(ctx.interpretacao.duvidas) &&
    ctx.interpretacao.duvidas.some(d => /valor|or[cç]amento/i.test(String(d||''))));
  return fluxoOk || priceIntent;
}

function hasBudgetLines(text) {
  const s = String(text || '');
  const l1 = /quem\s+passa\s+(o\s+)?or[cç]amento\s+é\s+o\s+motorista/i;
  const l2 = /o\s+valor\s+exato\s+é\s+passado\s+pelo\s+motorista/i;
  return l1.test(s) && l2.test(s);
}

function timePartFromISO(iso) {
  try {
    const h = new Date(String(iso || '')).getHours();
    if (h >= 0 && h < 12) return 'bom dia';
    if (h >= 12 && h < 18) return 'boa tarde';
    return 'boa noite';
  } catch { return 'olá'; }
}

// ============================================================================
// COMPOSIÇÃO DETERMINÍSTICA COM VARIEDADE
// ============================================================================

function composeDeterministic(ctx) {
  // Inicializa memória se não existir
  if (!ctx.memory) ctx.memory = { used: {} };
  
  // Campos e sinais
  const ask = (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar) || null;
  const askNext = (ctx && ctx.fluxo && ctx.fluxo.ordem && ctx.fluxo.ordem.perguntar_tambem) || null;
  const saudacaoFlag = !!(ctx && ctx.fluxo && ctx.fluxo.saudacao);
  const disp = !!(ctx && ctx.interpretacao && ctx.interpretacao.disponibilidade);
  const urgente = !!(ctx && ctx.interpretacao && ctx.interpretacao.urgencia_agora);
  const precisaOrcamento = shouldExplainBudget(ctx);
  
  // Primeira mensagem do cliente para matching de tom
  const primeiraMsg = Array.isArray(ctx && ctx.historico && ctx.historico.ultimas_do_cliente) 
    ? ctx.historico.ultimas_do_cliente[0]?.texto || ''
    : '';

  // Verifica se é mensagem final de pendente WhatsApp
  const isPendenteWhatsapp = (ctx && ctx.fluxo && ctx.fluxo.finalizacao_pendente_whatsapp) || false;
  
  if (isPendenteWhatsapp) {
    // Usa pool de mensagem final e retorna imediatamente
    const mensagemFinal = pickVar(ctx, 'pendenteWhatsapp', POOLS.pendenteWhatsapp) || POOLS.pendenteWhatsapp[0];
    return mensagemFinal;
  }

  function perguntaDoCampo(f) {
    switch (String(f || '')) {
      case 'telefone':
        return pickVar(ctx, 'pedirWhatsapp_completo', POOLS.pedirWhatsapp.completo) || 'Pode me passar o seu WhatsApp com DDD?';
      case 'ddd':
        return pickVar(ctx, 'pedirWhatsapp_ddd', POOLS.pedirWhatsapp.ddd) || 'Me passa só o DDD (2 dígitos) para completar o WhatsApp?';
      case 'telefone_parcial':
        return pickVar(ctx, 'pedirWhatsapp_parcial', POOLS.pedirWhatsapp.parcial) || 'Me envia o número do WhatsApp (sem DDD), com 8 ou 9 dígitos?';
      case 'itens':
        return pickVar(ctx, 'perguntaItens', POOLS.perguntaItens) || 'O que você precisa transportar?';
      case 'endereco_saida':
        return pickVar(ctx, 'perguntaEnderecoSaida', POOLS.perguntaEnderecoSaida) || 'Qual é o endereço completo de saída? Pode ser bairro ou ponto de referência.';
      case 'endereco_destino':
        return pickVar(ctx, 'perguntaEnderecoDestino', POOLS.perguntaEnderecoDestino) || 'Qual é o endereço completo de destino? Pode ser bairro ou ponto de referência.';
      default:
        return '';
    }
  }

  const partes = [];

  // Saudação com matching de tom (SEMPRE usa getSaudacaoFromCliente para variar)
  if (saudacaoFlag) {
    // Usa tom do contexto se disponível, senão analisa da primeira mensagem
    const tomCliente = (ctx && ctx.interpretacao && ctx.interpretacao.tom_cliente) || 
                       (ctx && ctx.meta && ctx.meta.tom_cliente) || 
                       analyzeClientTone(primeiraMsg);
    const saud = getSaudacaoFromCliente(primeiraMsg, ctx && ctx.meta && ctx.meta.horario);
    partes.push(saud);
  }

  // Papel do atendente (apenas na primeira resposta) - usa pickVar para evitar repetição
  if (saudacaoFlag && precisaOrcamento) {
    const papel = pickVar(ctx, 'papelAtendente', POOLS.papelAtendente);
    if (papel) partes.push(papel);
  }

  // Disponibilidade e urgência
  if (disp) partes.push('Sim, está disponível!');
  if (urgente) partes.push('Consigo te atender agora.');

  // Orçamento (variações - usa pickVar para evitar repetição)
  if (precisaOrcamento) {
    // Pega duas frases diferentes do pool para variar
    const orc1 = pickVar(ctx, 'orcamentoMotorista_1', POOLS.orcamentoMotorista) || 'Quem passa o orçamento é o motorista no WhatsApp; eu apenas anoto o pedido e repasso pra ele.';
    let orc2 = pickVar(ctx, 'orcamentoMotorista_2', POOLS.orcamentoMotorista) || 'O valor exato é passado pelo motorista no WhatsApp assim que coletarmos seus dados. Repasso para ele, e você recebe o orçamento certinho.';
    // Garante que são diferentes
    if (orc1 === orc2 && POOLS.orcamentoMotorista.length > 1) {
      const filtered = POOLS.orcamentoMotorista.filter(f => f !== orc1);
      orc2 = pickVar(ctx, 'orcamentoMotorista_2_alt', filtered) || orc2;
    }
    partes.push(orc1);
    partes.push(orc2);
  }

  // Ordem: ask_field depois ask_next_field (se houver), sendo a última frase
  if (ask) partes.push(perguntaDoCampo(ask));
  if (askNext) partes.push(perguntaDoCampo(askNext));

  // Monta uma única mensagem (máximo 250 caracteres)
  let out = partes.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  
  // Limita a 250 caracteres se exceder, cortando de forma inteligente em ponto natural
  if (out.length > 250) {
    // Tenta cortar em um ponto natural (ponto, vírgula, espaço) antes de 250
    const candidate = out.slice(0, 250);
    const lastSpace = candidate.lastIndexOf(' ');
    const lastComma = candidate.lastIndexOf(',');
    const lastDot = candidate.lastIndexOf('.');
    const lastExcl = candidate.lastIndexOf('!');
    const lastInter = candidate.lastIndexOf('?');
    const cutPoint = Math.max(lastSpace, lastComma, lastDot, lastExcl, lastInter);
    
    if (cutPoint > 200) {
      out = candidate.slice(0, cutPoint + 1).trim();
    } else {
      // Se não encontrou ponto natural, corta no último espaço antes de 250
      out = candidate.slice(0, lastSpace > 0 ? lastSpace : 250).trim();
    }
  }
  
  // Log opcional para acompanhamento da variedade
  if (process.env.LOG_COMPOSE_DETERMINISTIC === 'true') {
    try {
      console.log('[composeDeterministic]', {
        tom: analyzeClientTone(primeiraMsg),
        saudacao: saudacaoFlag,
        ask: ask,
        askNext: askNext,
        length: out.length,
        preview: out.slice(0, 100),
        memory_keys: Object.keys(ctx.memory.used || {})
      });
    } catch {}
  }
  
  return out;
}

// REMOVIDO: enforceAnswer() - NUNCA pode decidir/pular step, perguntar novo campo, corrigir step, inventar pergunta
// Toda decisão de ciclo agora pertence ao FSM

// ============================================================================
// RENDER PRINCIPAL
// ============================================================================

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

  // 1) Sanitiza saída do modelo (pode lançar erro 'sanitize_invalidated_ask' se faltar pergunta obrigatória)
  let s = sanitizeAnswerUnico(raw, ctx);

  // 2) REMOVIDO: enforceAnswer() - não pode mais decidir/corrigir ciclo
  // Se sanitizeAnswerUnico lançar erro, o FSM deve tratar

  return s;
}

module.exports = { buildSystemPromptUnico, buildUserPromptUnico, sanitizeAnswerUnico, renderUnico };
