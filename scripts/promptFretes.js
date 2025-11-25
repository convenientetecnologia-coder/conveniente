'use strict';

function buildSystemPrompt() {
  return `
Você é um(a) atendente humano(a) ultra simpático(a), eficiente, resolutivo(a) e natural, operando no Messenger.

REGRAS CRISTALINAS:

- PROIBIDO eco (não use "entendi", "ok", "você disse", "resumindo", nem repetição do pedido).

- Uma única resposta por burst — sempre considerando todo o contexto, mas nunca ecoando ou recitando detalhes desnecessários.

- Saudação só na primeira resposta (no burst inicial).

- Pergunte só o que falta. Não pergunte o que já foi respondido, nem elabore listas ou resumos do pedido.

- WhatsApp: peça APENAS (1) se cliente pedir preço/valor; (2) após itens+saída+destino; (3) no final se ainda não tem. Se já pediu, nunca peça de novo.

- DDD: Se número vier sem DDD (8–9 dígitos), peça apenas o DDD ("Me confirma só o DDD do seu WhatsApp?"), sem pedir o número inteiro de novo; nunca pede DDD junto de outras perguntas.

- NUNCA confirme ou repita o número do cliente.

- Inferência obrigatória: "de/do/desde X" = saída; "para/pra/em/no/na/lá/ali Y" = destino; verbos ("buscar em...", "levar para...") habilitam inferência.

- Ignore qualquer cidade diferente do perfil; só atenda na cidade do perfil.

- Seja objetivo(a), humano(a); varie frases: "claro", "show", "beleza", "legal", "tudo certo", mas SEM cacoetes constantes. Pergunta = frase seca, só próxima etapa.

- Feche só após todos os dados e WhatsApp com DDD. Ao finalizar, agradeça com alegria e, se fizer sentido, um único emoji. Nunca encerre antes.

ORDEM/FLOW:

1. Itens

2. Bairro de saída

3. Bairro de destino

4. Ajudante?

5. Saída: casa/apto?

6. Destino: casa/apto?

7. Elevadores (se apto)

JSON OBRIGATÓRIO:

{
"resposta":"texto natural único ao cliente",
"telefone_extraido":"apenas se 10–11 dígitos (com DDD), senão null",
"finalizado":true/false,
"dados":{
  "itens":"...",
  "bairro_saida":"...",
  "bairro_destino":"...",
  "ajudante":true/false/null,
  "saida_tipo":"casa|apartamento|null",
  "saida_elevador":true/false/null,
  "destino_tipo":"casa|apartamento|null",
  "destino_elevador":true/false/null,
  "telefone_parcial":"(caso venha 8/9 dígitos, sem DDD; else omitir)"
 }
}

NUNCA inclua texto fora do JSON; só envie fields relevantes.

EXEMPLOS PERFEITOS:

Cliente: "oi boa noite" / "faz frete?" / "preciso levar uma cama"

<= "Boa noite! Sim, fazemos. Qual bairro para buscar a cama?"

Cliente: "uma cama lá no Kobrasol, perto do Giassi"

<= "Perfeito! Para buscar a cama, qual o bairro de saída?"

Cliente: "trazer sofá do Bosque para o Centro"

<= "Legal! Precisa de ajudante para carregar?"

Cliente: "quanto para levar uma geladeira pro Zanelato?"

<= "Quem faz o orçamento é o motorista. Me passa seu WhatsApp com DDD que ele já te chama rapidinho. Onde busco a geladeira?"

Cliente: "91985634"

<= "Me confirma só o DDD do seu WhatsApp?"

Cliente: "obrigado!"

<= "Eu que agradeço! Se precisar, conte comigo. 😊"

Cliente: "levar colchão ali no Centro"

<= "Qual o bairro de saída para pegar o colchão?"

Cliente: "bairro José"

<= "Beleza! Vai levar para qual bairro?"

Cliente: "Kobrasol"

<= "Precisa de ajudante?"

Cliente: "não"

<= "O item sairá de casa ou apartamento?"

Cliente: "apartamento"

<= "Tem elevador no local de saída?"

Cliente: "destino apartamento"

<= "Tem elevador no destino?"

Cliente: "48999998888"

<= "Pronto! O motorista vai te chamar no WhatsApp. Obrigado pela confiança!"
`.trim();
}

function buildUserPrompt({ cidade, historico, coletado, flags = {} }) {
  const pedidoPreco = flags.pedidoPreco ? 'SIM' : 'NÃO';
  const jaTemTelefone = (coletado && coletado.telefone) ? 'SIM' : 'NÃO';

  const cabecalho = [
    'Contexto do atendimento:',
    `- Cidade do perfil (atendimento): ${cidade || 'desconhecida'}`,
    '- Importante: ignore cidades diferentes que o cliente mencionar; atenda sempre na cidade do perfil.',
    '',
    `Sinalizadores: pedido_preco=${pedidoPreco} | telefone_ok=${jaTemTelefone}`,
    '',
    (coletado && typeof coletado === 'object'
      ? (() => {
          const ja = [
            coletado.itens ? `itens=${coletado.itens}` : null,
            coletado.bairro_saida ? `bairro_saida=${coletado.bairro_saida}` : null,
            coletado.bairro_destino ? `bairro_destino=${coletado.bairro_destino}` : null,
            typeof coletado.ajudante === 'boolean' ? `ajudante=${coletado.ajudante ? 'sim' : 'não'}` : null,
            coletado.saida_tipo ? `saida_tipo=${coletado.saida_tipo}` : null,
            (typeof coletado.saida_elevador === 'boolean' ? `saida_elevador=${coletado.saida_elevador ? 'sim' : 'não'}` : null),
            coletado.destino_tipo ? `destino_tipo=${coletado.destino_tipo}` : null,
            (typeof coletado.destino_elevador === 'boolean' ? `destino_elevador=${coletado.destino_elevador ? 'sim' : 'não'}` : null),
            (coletado.telefone && String(coletado.telefone).trim().length >= 10) ? 'telefone_ok=sim' : null,
            (!coletado.telefone && coletado.telefone_parcial ? `telefone_parcial=${String(coletado.telefone_parcial).length} dígitos` : null)
          ].filter(Boolean);
          return ja.length ? 'O que já temos: ' + ja.join(', ') : 'O que já temos: —';
        })()
      : 'O que já temos: —'),
    '',
    'Histórico de mensagens:'
  ].join('\n');

  const corpo = (historico || [])
    .map(m => {
      const autor = (m.autor === 'ia' || m.autor === 'sistema') ? 'Atendente' : 'Cliente';
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString('pt-BR') : '';
      return `[${autor}]${ts ? ' [' + ts + ']' : ''}: ${m.texto || ''}`;
    })
    .join('\n');
  return cabecalho + '\n' + corpo;
}

function parseModelAnswerToDomain(rawText) {
  try {
    let txt = String(rawText || '').trim();
    txt = txt.replace(/^json\s*/i, '').replace(/^\s*/i, '').replace(/\s*```$/i, '').trim();

    let match = txt.match(/\{[\s\S]*\}/);
    if (!match) match = txt.match(/\{.*\}/s);
    if (!match) {
      return { resposta: '', telefone_extraido: null, finalizado: false, dados: {} };
    }

    const obj = JSON.parse(match[0]);

    function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
    const telRaw = obj.telefone_extraido ? onlyDigits(obj.telefone_extraido) : '';
    let telefoneOK = null;
    if (telRaw && (telRaw.length === 10 || telRaw.length === 11)) {
      telefoneOK = telRaw;
    } else {
      const fallback = extractPhonesBRStrict((obj.resposta || '') + ' ' + txt);
      const pick = Array.isArray(fallback) ? fallback.find(d => d && (d.length === 10 || d.length === 11)) : null;
      telefoneOK = pick || null;
    }

    // Detecta telefone parcial (8–9 dígitos) para orientar a conversa sem marcar finalizado
    let telefoneParcial = null;
    if (!telefoneOK) {
      const partialMatch = String((obj.resposta||'') + ' ' + txt).match(/(^|\D)(\d{8,9})(\D|$)/);
      if (partialMatch && partialMatch[2]) {
        telefoneParcial = onlyDigits(partialMatch[2]);
        if (telefoneParcial && (telefoneParcial.length < 8 || telefoneParcial.length > 9)) {
          telefoneParcial = null;
        }
      }
      try {
        if (!telefoneParcial && obj.dados && obj.dados.telefone_parcial) {
          const tp = onlyDigits(obj.dados.telefone_parcial);
          if (tp && (tp.length === 8 || tp.length === 9)) telefoneParcial = tp;
        }
      } catch {}
    }

    const safeDados = obj.dados && typeof obj.dados === 'object' ? obj.dados : {};
    const dadosOut = {
      ajudante: safeDados.ajudante ?? null,
      saida_tipo: safeDados.saida_tipo ?? null,
      saida_elevador: safeDados.saida_elevador ?? null,
      destino_tipo: safeDados.destino_tipo ?? null,
      destino_elevador: safeDados.destino_elevador ?? null,
      bairro_saida: safeDados.bairro_saida ?? null,
      bairro_destino: safeDados.bairro_destino ?? null,
      itens: safeDados.itens ?? null
    };

    if (telefoneParcial) dadosOut.telefone_parcial = telefoneParcial;
    if (safeDados.debug) dadosOut.debug = safeDados.debug;

    const finalizavel =
      !!dadosOut.itens &&
      !!dadosOut.bairro_saida &&
      !!dadosOut.bairro_destino &&
      (safeDados.ajudante === true || safeDados.ajudante === false || dadosOut.ajudante === true || dadosOut.ajudante === false) &&
      !!dadosOut.saida_tipo &&
      !!dadosOut.destino_tipo &&
      !!telefoneOK;

    return {
      resposta: obj.resposta || '',
      telefone_extraido: telefoneOK || null,
      finalizado: obj.finalizado === true && finalizavel,
      dados: dadosOut
    };

  } catch (e) {
    return { resposta: '', telefone_extraido: null, finalizado: false, dados: {} };
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
