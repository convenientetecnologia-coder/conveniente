'use strict';

function buildSystemPrompt() {
  return `
Você é o melhor atendente do mundo, especialista em fretes e mudanças. Atua via Messenger. Sua personalidade é:

- Extremamente educado, empático, paciente, alto astral, inteligente, prestativo, detalhista, alegre, feliz, motivado, preparado, intuitivo, ultra confiável.

- Sempre transmite segurança, resolve rápido, com agilidade impecável (mas nunca apressado), ética inabalável, organização máxima.

- Se adapta instantaneamente ao perfil do cliente: consegue ser formal, informal, técnico ou leigo, sempre no tom perfeito.

- Melhora constantemente, aprende com cada interação e visa tornar cada atendimento memorável e encantador.

REGRAS DE OURO DO ATENDIMENTO (impossíveis de quebrar):

- Nunca responde de forma robótica: cada resposta é natural, acolhedora, humana.

- Cada mensagem é orientada à resolução imediata e plena da necessidade do cliente — SEM nunca jogar o cliente para outro setor.

- Transparência total: só responde aquilo que realmente pode cumprir, nunca promete o impossível.

ORIENTAÇÕES DE CONVERSA (BURST/CONSOLIDADO):

- Ao receber várias mensagens do cliente em sequência (burst), consolide todas em uma ÚNICA resposta humana, considerando todo o contexto, mesmo que haja informações Overlap.

- PRIMA PELA SAUDAÇÃO NA PRIMEIRA RESPOSTA: sempre cumprimente (bom dia/boa tarde/boa noite) se for a primeira vez que atende (vale para burst também).

- Se o cliente perguntar "faz frete?" (ou variação), responda com alegria que sim! ("Sim, fazemos frete!" ou similar).

- Se responder um burst, reforce: "Entendi: [resumo do que o cliente já informou]." e já avance para a próxima pergunta PRIORITÁRIA do fluxo.

- Jamais ecoe literalmente o cliente; use suas palavras.

- Nunca repita perguntas já feitas.

- NUNCA fale da cidade do cliente, mesmo que ele diga.

FLUXO LÓGICO (SEM ESCAPES):

1. O que precisa transportar (itens)?

2. Bairro/local de saída?

3. Bairro/local de destino?

4. Ajudante?

5. Saída: casa ou apartamento?

6. Destino: casa ou apartamento?

REGRAS DE WHATSAPP:

- Só peça WhatsApp: a) se o cliente perguntar preço/valor/orçamento; b) se já obteve itens, saída e destino; c) sempre ao final, quando coletou tudo.

- NUNCA peça/comente sobre DDD explicitamente. Se faltar, peça em OUTRA mensagem.

- Nunca peça WhatsApp em mensagens consecutivas; só uma vez por atendimento.

- Jamais confirme número de WhatsApp enviado.

REGRAS DE ORÇAMENTO/VALORES:

- Você é apenas o atendente ultra profissional. NÃO passa valores/condições/datas.

- Explique: "Quem passa o orçamento é o motorista e ele entrará em contato pelo WhatsApp que você informar." Assim o cliente sente confiança e propósito.

COMUNICAÇÃO:

- 1 pergunta por mensagem (exceto se burst inicial).

- Mais de um dado do cliente por burst? Responda a tudo no mesmo ciclo, resumindo e direcionando para o próximo item do fluxo.

- Nunca trave o ciclo; sempre saiba o que perguntar depois.

- Se já recebeu todos os dados do cliente, encerre em tom alegre ("Perfeito! Vou registrar seu pedido, obrigado pela confiança!") e peça WhatsApp se ainda não foi coletado.

FINALIZAÇÃO:

- O atendimento só fecha com WhatsApp válido.

- Retorne marcação "finalizado=true" só se todos os dados e telefone foram obtidos.

FORMATOS E PROIBIÇÕES:

- Sempre retorne apenas um JSON puro no padrão:

  {
    "resposta": "texto completo para o cliente",
    "telefone_extraido": "11999999999" ou null,
    "finalizado": true/false,
    "dados": { ... }
  }

- Nunca retorne mensagens fora desse JSON!

- Nunca ecoe as frases:

  - "Sim, estou aqui para te ajudar"

  - "Ah, ótimo..."

  - "Perfeito!" (no início)

  - "Claro!" (no início)

  - "Bom dia! Bom dia! ..." (repetido)

  - Nem confirmações óbvias ao WhatsApp.

EXEMPLOS DE BOA RESPOSTA (BURST):

Cliente: "oi boa noite"
Cliente: "tudo bem"
Cliente: "faz frete?"
Cliente: "pra levar uma cama"

<= Boa: "Boa noite! Sim, fazemos sim. Entendi: levar uma cama. Qual bairro de saída?"

Cliente: "oi boa tarde tudo bem? vc faz frete?"

<= Boa: "Boa tarde! Tudo bem sim. Fazemos frete, sim. O que você precisa transportar?"

Cliente: "Preciso de frete para mudar uma geladeira saindo do Centro para o Jardim Ana Paula. Quanto fica?"

<= Boa: "Claro! Entendi: frete de geladeira, do Centro para o Jardim Ana Paula. Quem passa o orçamento é o motorista, que vai te chamar no WhatsApp. Pode me passar seu WhatsApp para que ele entre em contato?"

Cliente: "pra trazer um sofá do Bosque para o Centro, com ajudante, preciso de preço"

<= Boa: "Entendi: sofá do Bosque para o Centro, com ajudante. Quem faz orçamento é o motorista e ele vai te chamar no WhatsApp. Pode enviar seu WhatsApp para eu registrar?"

Cliente: "obrigado!"

<= Boa: "Eu que agradeço! Precisando de algo mais, conte comigo. Tenha uma ótima noite! 😊"
`.trim();
}

function buildUserPrompt({ cidade, historico }) {
  // Apenas concatena histórico do cliente e atendente, sem branch
  return (historico || [])
    .map(m => {
      const autor = (m.autor === 'ia' || m.autor === 'sistema') ? 'Atendente' : 'Cliente';
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString('pt-BR') : '';
      return `[${autor}]${ts ? ' [' + ts + ']' : ''}: ${m.texto || ''}`;
    })
    .join('\n');
}

function parseModelAnswerToDomain(rawText) {
  try {
    let txt = String(rawText || '').trim();
    txt = txt.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    
    let match = txt.match(/\{[\s\S]*\}/);
    if (!match) {
      match = txt.match(/\{.*\}/s);
    }
    if (!match) {
      return {
        resposta: '',
        telefone_extraido: null,
        finalizado: false,
        dados: {}
      };
    }

    const obj = JSON.parse(match[0]);
    const safeDados = obj.dados && typeof obj.dados === 'object' ? obj.dados : {};

    return {
      resposta: obj.resposta || '',
      telefone_extraido: obj.telefone_extraido || null,
      finalizado: obj.finalizado === true,
      dados: {
        ajudante: safeDados.ajudante ?? null,
        saida_tipo: safeDados.saida_tipo ?? null,
        saida_elevador: safeDados.saida_elevador ?? null,
        destino_tipo: safeDados.destino_tipo ?? null,
        destino_elevador: safeDados.destino_elevador ?? null,
        bairro_saida: safeDados.bairro_saida ?? null,
        bairro_destino: safeDados.bairro_destino ?? null,
        itens: safeDados.itens ?? null
      }
    };
  } catch (e) {
    return {
      resposta: '',
      telefone_extraido: null,
      finalizado: false,
      dados: {}
    };
  }
}

function buildFinalOrderPayload(nomePerfil, chatId, dados = {}, servidor = null) {
  // Apenas formata para backend externo
  return {
    servidor: servidor || 'servidor1',
    perfil: nomePerfil,
    chat_id: chatId,
    cidade: dados && dados.cidade || null,
    telefone: dados && dados.telefone || null,
    itens: dados && dados.itens || null,
    bairro_saida: dados && dados.bairro_saida || null,
    bairro_destino: dados && dados.bairro_destino || null,
    saida_tipo: dados && dados.saida_tipo || null,
    saida_elevador: dados && dados.saida_elevador || null,
    destino_tipo: dados && dados.destino_tipo || null,
    destino_elevador: dados && dados.destino_elevador || null,
    ajudante: dados && dados.ajudante || null,
    timestamp: Date.now()
  };
}

function buildFinalMessage(flowState = {}, dados = {}) {
  return 'Perfeito! Recebi todas as informações. Já vou processar seu pedido e te chamar no WhatsApp. Obrigado pela confiança! 🙌\n\nSiga nosso Instagram: @seu_instagram';
}

function parseCityUfFromText(candidates) {
  // candidates: string[] - lista de textos candidatos extraídos do DOM
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const CITYUF_EXACT_RE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'´.\-\s]{1,60}?),\s*([A-Z]{2})$/;
  const CITYUF_FIND_RE = /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'´.-\s]{1,60}?),\s*([A-Z]{2})/g;

  function limparEValidarCidade(cidade) {
    if (!cidade || typeof cidade !== 'string') return null;
    let s = String(cidade).trim();
    // Remove prefixos e lixo mais comuns (SUPER abrangente)
    s = s
      .replace(/^(uma\s+hora\s+em|há\s+\d+\s*(km|kms|quil[oô]metros?)\s+de|a\s+\d+\s*(km|kms|quil[oô]metros?)\s+de|em\s+|de\s+|para\s+|até\s+)/i, '')
      .replace(/^\s+|\s+$/g, '');
    // rejeita conteúdos obviamente inválidos
    if (/\d+/.test(s)) return null;
    if (!/^[A-Za-zÀ-ÿ]/.test(s)) return null;
    if (s.length < 2 || s.length > 60) return null;
    // não deve começar por palavras temporais/destino
    if (/^(uma\s+hora|há|a\s+\d+|em|de|para|até)/i.test(s)) return null;
    return s;
  }

  function candidateFromText(txt) {
    const t = (txt || '').trim();
    const m = CITYUF_EXACT_RE.exec(t);
    if (!m) return null;
    const cidade = limparEValidarCidade(m[1] || '');
    const uf = (m[2] || '').toUpperCase();
    if (!cidade || !/^[A-Z]{2}$/.test(uf)) return null;
    return { cidade, estado: uf };
  }

  // Tenta cada candidato em ordem
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    
    const t = candidate.trim();
    if (!t) continue;

    // Tenta match exato primeiro
    const cand = candidateFromText(t);
    if (cand) return cand;

    // Se não encontrou exato, tenta encontrar padrão "Cidade, UF" dentro do texto
    CITYUF_FIND_RE.lastIndex = 0;
    let mm, last = null;
    while ((mm = CITYUF_FIND_RE.exec(t)) !== null) last = mm;
    if (last) {
      const c2 = candidateFromText(last[0]);
      if (c2) return c2;
    }
  }

  return null;
}

// Validação e extração ultra-rígida de telefone BR (com DDD)
function normalizeBRPhone(raw) {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  const noPlus = s.replace(/^\+/, '');
  const br = noPlus.replace(/^55/, '');
  return br;
}

function isValidBRPhoneWithDDD(digitsOnly) {
  const d = String(digitsOnly || '').replace(/\D/g, '');
  if (d.length === 11) {
    const ddd = d.slice(0,2);
    const n9 = d[2] === '9';
    return /^[1-9]{2}$/.test(ddd) && n9;
  }
  if (d.length === 10) {
    const ddd = d.slice(0,2);
    const first = d[2];
    return /^[1-9]{2}$/.test(ddd) && /^[2-9]$/.test(first);
  }
  return false;
}

function extractPhonesBRStrict(text) {
  if (!text) return [];
  const cleaned = String(text).replace(/[^\d+]/g, ' ');
  const candidates = cleaned.match(/(?:\+?55)?\s*\d{10,11}/g) || [];
  const out = [];
  const seen = new Set();
  for (const c of candidates) {
    const norm = normalizeBRPhone(c);
    const d = norm.replace(/\D/g, '');
    if (!isValidBRPhoneWithDDD(d)) continue;
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
}

module.exports = {
  buildSystemPrompt,
  buildUserPrompt,
  parseModelAnswerToDomain,
  buildFinalOrderPayload,
  buildFinalMessage,
  parseCityUfFromText,
  normalizeBRPhone,
  isValidBRPhoneWithDDD,
  extractPhonesBRStrict
};
