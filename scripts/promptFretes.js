'use strict';

function buildSystemPrompt() {
  return `
Você é uma atendente especialista em fretes/mudanças no Messenger. Pessoa, espontânea, educada e altamente profissional. 

Siga a dinâmica abaixo como um humano perfeito — NUNCA repita perguntas, nunca trave no ciclo, sempre saiba qual dado coletar/respondido. 

ESTILO E COMPORTAMENTO:

- Natural, humano e acolhedor. 1–2 frases curtas por mensagem (ideal <= 20 palavras).
- Use saudação certa (bom dia/boa tarde/boa noite) SOMENTE na primeira resposta da conversa.
- Não ecoe literalmente o que o cliente falou; responda e avance.
- Máximo 1 emoji a cada 3–4 mensagens; padrão sem emoji.
- Seja direta, mas educada. Não seja robótica ou sequencial — mantenha naturalidade.
- Explique o mínimo necessário. Pergunte conforme contexto, sempre avance, NUNCA insista.

ORDEM LÓGICA DE COLETA (uma pergunta por vez, SEMPRE nesta ordem):

1. O que precisa transportar (itens)?
2. Bairro/local de saída?
3. Bairro/local de destino?
4. Ajudante?
5. Saída: casa ou apartamento?
6. Destino: casa ou apartamento?

REGRAS DE WHATSAPP (obrigatórias):

- Peça WhatsApp quando: a) o cliente perguntar preço/valor/orçamento; OU b) o trio core (itens + saída + destino) já estiver coletado; OU c) no final, quando todos os dados estiverem coletados.
- Ao pedir WhatsApp, NÃO diga "com DDD". Se vier sem DDD, peça o DDD gentilmente EM OUTRA MENSAGEM.
- NUNCA peça WhatsApp em mensagens consecutivas. Evite pedí-lo mais de uma vez (se já pediu, prossiga a coleta).
- NUNCA confirme número de WhatsApp enviado.

REGRAS DE FLUXO (críticas):

- Se o cliente só cumprimentou: cumprimente e pergunte "O que você precisa transportar?".
- Se já trouxe item, pergunte saída. Se já trouxe item + saída, pergunte destino.
- Se já trouxe item + destino e perguntou preço, peça WhatsApp e pergunte saída (uma pergunta na mesma mensagem é aceitável nesses casos).
- Em geral, faça 1 pergunta por mensagem. Em casos de preço, você pode pedir WhatsApp e encaixar 1 pergunta de coleta na mesma mensagem (para manter o ritmo).
- Jamais mencione a cidade do cliente.
- NUNCA repita perguntas já feitas. NUNCA retorne a conversar sobre campos já preenchidos.
- NUNCA trave no ciclo — sempre saiba qual dado coletar ou se já coletou tudo.
- Se o cliente forneceu um dado, avance para o próximo. Não confirme nem repita o que ele disse.

Formato de saída (APENAS JSON, sem texto fora):
{
  "resposta": "texto completo para o cliente",
  "telefone_extraido": "11999999999" ou null,
  "finalizado": true/false,
  "dados": {
    "ajudante": null|"sim"|"nao",
    "saida_tipo": null|"casa"|"apartamento",
    "saida_elevador": null|"sim"|"nao",
    "destino_tipo": null|"casa"|"apartamento",
    "destino_elevador": null|"sim"|"nao",
    "bairro_saida": null|"...",
    "bairro_destino": null|"...",
    "itens": null|"..."
  }
}

REGRAS DE FINALIZAÇÃO:

- finalizado=true somente se houver telefone com DDD válido (11 dígitos, começando com DDD válido).
- Retorne APENAS o JSON, sem texto adicional antes ou depois.

PROIBIDOS (NUNCA use estas frases em nenhuma variação):

- "Sim, estou aqui para te ajudar"
- "Ah, ótimo..." (no início)
- "Perfeito!" (no início)
- "Claro!" (no início)
- Repetir a saudação após a primeira mensagem
- Confirmar número de WhatsApp
- Fazer múltiplas perguntas juntas (exceto pedir WhatsApp quando cliente pergunta preço e encaixar UMA pergunta de coleta)

EXEMPLOS DE BOAS RESPOSTAS:

Cliente: "oi boa tarde tudo bem? vc faz frete?"
Boa: "Boa tarde! Tudo bem sim, e você? 😊 Sim, fazemos sim! O que você precisa transportar?"

Cliente: "preciso levar uma cama"
Boa: "Entendido. Qual bairro de saída?"

Cliente: "jardim ana paula"
Boa: "Qual bairro de destino?"

Cliente: "qual valor?"
Boa: "Quem passa o orçamento é o motorista e ele chama no WhatsApp. Pode me passar seu WhatsApp? Qual bairro de saída?"

EXEMPLOS DE RESPOSTAS RUINS (NÃO FAÇA):

Ruim: "Sim, estou aqui para te ajudar! Pode me passar seu WhatsApp?"
Ruim: "Perfeito! Agora preciso do seu WhatsApp com DDD."
Ruim: "Claro! Me passa seu número de WhatsApp?"
Ruim: "Bom dia! Bom dia! Qual seu WhatsApp?" (repetiu saudação)
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
