'use strict';

function buildSystemPrompt({ askField = null, allowSecondQuestion = false } = {}) {
  return `
Você é um(a) atendente humano(a) de fretes. Gere a resposta e metadados em JSON e somente JSON, exatamente no formato abaixo.

Parâmetros de controle:

ask_field: ${askField === null ? 'null' : String(askField)}
allow_second_question: false

Valores permitidos para ask_field:

null | "itens" | "endereco_saida" | "endereco_destino" | "ajudante" | "saida_tipo" | "destino_tipo" | "saida_elevador" | "destino_elevador" | "telefone" | "ddd"

Regras determinísticas:

    Cumprimente apenas se firstReply=true; caso contrário, não cumprimente e não use "Oi, tudo bem?" repetido.

    Responda naturalmente a tudo o que o cliente escreveu nesta virada, sem repetir informações que já foram coletadas, sem re-sumários a cada resposta e sem agradecer repetidas vezes. No máximo agradeça uma vez na conversa ou no encerramento.

    Se ask_field for null: não faça perguntas.

    Se ask_field NÃO for null: faça exatamente UMA pergunta, no final da resposta, sobre o campo ask_field.

    Se ask_field="telefone": peça apenas o WhatsApp (nunca peça "WhatsApp com DDD"). Não mencione DDD.

    Se ask_field="ddd": peça somente o DDD (não peça o número completo novamente).

    Nunca combine perguntas (ex.: "WhatsApp + outra coisa") na mesma mensagem. Uma pergunta por mensagem.

    Se perguntarem preço/valor antes do WhatsApp e o telefone completo ainda não foi informado: explique brevemente que quem informa o valor é o motorista no WhatsApp e peça o WhatsApp (somente). Não mencione DDD.

    Nunca ecoe números de telefone na "resposta". Telefones só nos metadados.

    Confirme somente o que for novo. Não fique recapitulando tudo que já foi informado a cada virada.

SAÍDA OBRIGATÓRIA (um único objeto JSON válido):

{
"resposta": "texto a ser enviado ao cliente (humano, natural, sem redundâncias; inclua ao final exatamente UMA pergunta definida por ask_field)",
"telefone_extraido": "se detectar nº BR 10-11 dígitos completo (somente dígitos); senão null",
"dados": {
"itens": "...|null",
"endereco_saida": "...|null",
"endereco_destino": "...|null",
"ajudante": true|false|null,
"saida_tipo": "casa"|"apartamento"|null,
"saida_elevador": true|false|null,
"destino_tipo": "casa"|"apartamento"|null,
"destino_elevador": true|false|null,
"telefone_parcial": "8-9 dígitos ou null",
"ddd": "2 dígitos ou null"
},
"finalizado": true|false
}

Restrições:

    resposta nunca vazia.

    Nunca inclua texto fora do JSON.

    Nunca inclua Markdown, comentários ou cercas de código. `.trim();
}

function buildUserPrompt({ cidade, historico, coletado, askCounts, flags = {}, missingFields = [], askField = null, nextField = null, allowSecondQuestion = false }) {
  const firstReply = !!(flags && flags.firstReply);
  const telefone_ok = !!(flags && flags.telefone_ok);
  const protestCount = typeof flags.protest_count === 'number' ? flags.protest_count : 0;

  const meta = [
    `ask_field: ${askField === null ? 'null' : String(askField)}`,
    `next_field: ${nextField === null ? 'null' : String(nextField)}`,
    `allow_second_question: ${allowSecondQuestion ? 'true' : 'false'}`,
    `firstReply: ${firstReply ? 'true' : 'false'}`,
    `telefone_ok: ${telefone_ok ? 'true' : 'false'}`,
    `protest_count: ${protestCount}`,
    `missing: ${JSON.stringify(Array.isArray(missingFields) ? missingFields : [])}`
  ].join(' | ');

  const header = [
    `Cidade do perfil: ${cidade || '—'}`,
    `Meta: ${meta}`,
    'Nota: cumprimente apenas se firstReply=true; evite qualquer saudação repetida. Responda a tudo o que o cliente falou nesta virada de forma natural e enxuta. Ao final, faça exatamente 1 pergunta definida por ask_field. A pergunta deve ficar no FINAL da resposta. Não adicione perguntas de cortesia nem repita a mesma pergunta com sinônimos. Quando ask_field="telefone", peça somente o WhatsApp. Quando ask_field="ddd", peça somente o DDD. Se ask_field for null, não faça nenhuma pergunta.',
    '',
    (coletado && typeof coletado === 'object'
      ? (() => {
          const ja = [
            coletado.itens ? `itens=${coletado.itens}` : null,
            coletado.endereco_saida ? `endereco_saida=${coletado.endereco_saida}` : null,
            coletado.endereco_destino ? `endereco_destino=${coletado.endereco_destino}` : null,
            typeof coletado.ajudante === 'boolean' ? `ajudante=${coletado.ajudante ? 'sim' : 'não'}` : null,
            coletado.saida_tipo ? `saida_tipo=${coletado.saida_tipo}` : null,
            (typeof coletado.saida_elevador === 'boolean' ? `saida_elevador=${coletado.saida_elevador ? 'sim' : 'não'}` : null),
            coletado.destino_tipo ? `destino_tipo=${coletado.destino_tipo}` : null,
            (typeof coletado.destino_elevador === 'boolean' ? `destino_elevador=${coletado.destino_elevador ? 'sim' : 'não'}` : null),
            (coletado.telefone && String(coletado.telefone).trim().length >= 10) ? 'telefone_ok=sim' : null
          ].filter(Boolean);
          return ja.length ? ('Já coletado: ' + ja.join(', ')) : 'Já coletado: —';
        })()
      : 'Já coletado: —'
    ),
    '',
    'Histórico de mensagens (mais recente ao final):'
  ].join('\n');

  const corpo = (historico || [])
    .map(m => {
      const autor = (m.autor === 'ia' || m.autor === 'sistema') ? 'Atendente' : 'Cliente';
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleString('pt-BR') : '';
      return `[${autor}]${ts ? ' [' + ts + ']' : ''}: ${m.texto || ''}`;
    })
    .join('\n');

  const askCountsStr = `askCounts: ${JSON.stringify(askCounts || {})}`;

  return [header, corpo, '', askCountsStr].join('\n');
}

function parseModelAnswerToDomain(rawText, lastClientText) {
  try {
    let txt = String(rawText || '').trim();

    // Remoção robusta de cercas de código e prefixos "json"
    txt = txt.replace(/^\s*(?:json)?\s*/i, '').replace(/\s*$/i, '').replace(/^json\s*/i, '').trim();

    // Fallback: se não há JSON, usa o texto inteiro como resposta
    if (!/{[\s\S]*}/.test(txt)) {
      // Modelo não retornou JSON — fallback: usa o texto inteiro como resposta
      const fallback = String(txt).trim();
      const fallbackSan = fallback
        .replace(/\b\d{8,11}\b/g, '')          // bloqueia sequências coladas de 8–11 dígitos
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '') // bloqueia números com separadores
        .replace(/(\d[\s-]?){4,}/g, '******');       // defensivo
      return {
        resposta: fallbackSan,
        telefone_extraido: null,
        finalizado: false,
        dados: {}
      };
    }

    let match = txt.match(/\{[\s\S]*\}/);
    if (!match) match = txt.match(/\{.*\}/s);
    if (!match) {
      return { resposta: '', telefone_extraido: null, finalizado: false, dados: {} };
    }

    const obj = JSON.parse(match[0]);

    function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }

    // Sempre mascarar qualquer número no texto de resposta (não ecoar telefone do cliente)
    const originalResposta = String(obj.resposta || '');
    let respostaSan = String(originalResposta || '');
    try {
      respostaSan = respostaSan
        .replace(/\b\d{8,11}\b/g, '******')          // bloqueia sequências coladas de 8–11 dígitos
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '******') // bloqueia números com separadores
        .replace(/(\d[\s-]?){4,}/g, '******');       // ainda mais defensivo
    } catch {}

    // Base de extração (sem sanitizar), para não prejudicar detecção de números
    const combinedText = String(txt || '');

    // Regex canônicas
    const dddIsoladoRe = /^[1-9]\d$/;
    const telParcialRe = /\b(\d{8,9})\b/;
    const telComDDDRe = /\b(\d{10,11})\b/;

    // 1) Extrair telefone completo (10–11 dígitos) – prioridade: campo do JSON > fallback no texto
    let telefoneOK = null;
    const telObj = obj.telefone_extraido ? onlyDigits(obj.telefone_extraido) : '';
    const pickObj = (telObj && (telObj.length === 10 || telObj.length === 11) && isValidBRPhoneWithDDD(telObj)) ? telObj : null;
    if (pickObj) {
      telefoneOK = pickObj;
    } else {
      const fallbackFull = (combinedText.match(telComDDDRe) || []).map(onlyDigits).filter(isValidBRPhoneWithDDD);
      telefoneOK = Array.isArray(fallbackFull) ? (fallbackFull[0] || null) : null;
    }

    // 2) Telefone parcial (8–9 dígitos)
    let telefoneParcial = null;
    if (!telefoneOK) {
      const m = combinedText.match(telParcialRe);
      if (m && m[1]) {
        const digits = onlyDigits(m[1]);
        if (digits.length === 8 || digits.length === 9) telefoneParcial = digits;
      }
      try {
        if (!telefoneParcial && obj.dados && obj.dados.telefone_parcial) {
          const tp = onlyDigits(obj.dados.telefone_parcial);
          if (tp && (tp.length === 8 || tp.length === 9)) telefoneParcial = tp;
        }
      } catch {}
    }

    // 3) DDD isolado do lastClientText (ou do próprio JSON, se vier)
    let dddInformado = null;
    try {
      const lastTrim = String(lastClientText || '').trim();
      if (dddIsoladoRe.test(lastTrim)) dddInformado = lastTrim;
      else if (obj.dados && obj.dados.ddd && dddIsoladoRe.test(String(obj.dados.ddd))) dddInformado = String(obj.dados.ddd);
    } catch {}

    // 4) Montagem local: DDD + telefone parcial → telefone completo válido
    if (!telefoneOK && dddInformado && telefoneParcial) {
      const combinado = String(dddInformado) + String(telefoneParcial);
      if (isValidBRPhoneWithDDD(combinado)) {
        telefoneOK = combinado;
        telefoneParcial = null;
      }
    }

    // 5) Consolidar campos "dados"
    const safeDados = obj.dados && typeof obj.dados === 'object' ? obj.dados : {};
    const dadosOut = {
      ajudante: safeDados.ajudante ?? null,
      saida_tipo: safeDados.saida_tipo ?? null,
      saida_elevador: safeDados.saida_elevador ?? null,
      destino_tipo: safeDados.destino_tipo ?? null,
      destino_elevador: safeDados.destino_elevador ?? null,
      endereco_saida: safeDados.endereco_saida ?? null,
      endereco_destino: safeDados.endereco_destino ?? null,
      itens: safeDados.itens ?? null
    };

    // Só incluir peças soltas se NÃO houver telefone completo
    if (!telefoneOK && telefoneParcial) dadosOut.telefone_parcial = telefoneParcial;
    if (!telefoneOK && dddInformado) dadosOut.ddd = dddInformado;
    if (safeDados.debug) dadosOut.debug = safeDados.debug;

    // 6) Critério de finalização real (obrigatório levantar elevador nos aptos)
    const isAptSaida = (dadosOut.saida_tipo === 'apartamento');
    const isAptDestino = (dadosOut.destino_tipo === 'apartamento');
    const elevSaidaOk = !isAptSaida || (safeDados.saida_elevador === true || safeDados.saida_elevador === false || dadosOut.saida_elevador === true || dadosOut.saida_elevador === false);
    const elevDestinoOk = !isAptDestino || (safeDados.destino_elevador === true || safeDados.destino_elevador === false || dadosOut.destino_elevador === true || dadosOut.destino_elevador === false);

    const finalizavel =
      !!dadosOut.itens &&
      !!dadosOut.endereco_saida &&
      !!dadosOut.endereco_destino &&
      (safeDados.ajudante === true || safeDados.ajudante === false || dadosOut.ajudante === true || dadosOut.ajudante === false) &&
      !!dadosOut.saida_tipo &&
      !!dadosOut.destino_tipo &&
      elevSaidaOk &&
      elevDestinoOk &&
      !!telefoneOK;

    // Fallback duro — nunca devolve resposta vazia
    if (!respostaSan || respostaSan.trim().length === 0) {
      const fallback = String(rawText || '').trim();
      return {
        resposta: fallback,
        telefone_extraido: telefoneOK || null,
        finalizado: false,
        dados: dadosOut
      };
    }

    return {
      resposta: respostaSan || '',
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
    itens: (() => {
      if (!dados) return null;
      if (Array.isArray(dados.itens)) return dados.itens.join(', ');
      return dados.itens || null;
    })(),
    endereco_saida: dados && dados.endereco_saida || null,
    endereco_destino: dados && dados.endereco_destino || null,
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

  const CITYUF_EXACT_RE = /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'´.-\s]{1,60}?),\s*([A-Z]{2})$/;
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

// Observação (sanidade): As regex canônicas usadas no parser:
// Price intent (usada no virtus.js): /(pre[cç]o|valor|quanto\s+(custa|fica|sai)|cobra|or[cç]amento)/i
// DDD isolado válido: /^[1-9]\d$/
// Telefone parcial: /\b(\d{8,9})\b/
// Telefone com DDD: /\b(\d{10,11})\b/
