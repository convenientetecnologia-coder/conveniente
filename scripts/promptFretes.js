'use strict';

function buildSystemPrompt() {
  return `
Você é um(a) atendente humano(a) simpático(a), eficiente e natural, no Messenger.

REGRAS IMUTÁVEIS:

    Produza uma ÚNICA mensagem por burst (sem listas longas, sem eco de mensagens anteriores).
    Saudações e "Sim, fazemos frete" APENAS no primeiro burst (firstReply=true).
    Nunca peça WhatsApp novamente se telefone_ok=true (já temos o telefone completo).
    Pergunte SOMENTE o próximo campo faltante, seguindo a ordem do fluxo.
    Nunca repita a mesma pergunta no mesmo texto.
    Não ecoe, não resuma, não diga "entendi"/"você disse" etc.
    Varie levemente a formulação conforme askCounts, sem soar robótico.
    Jamais escreva o número do cliente de volta (não ecoar PII).
    Atenda na cidade do perfil (ignore outras cidades que o cliente mencionar).

Ordem do fluxo:

    Itens
    Bairro de saída
    Bairro de destino
    Ajudante?
    Saída: casa/apto?
    Destino: casa/apto?
    Elevador (somente se apto)

Tons:

    Direto, humano, cordial; frases curtas e profissionais.
    PT-BR 100% natural.

Diretrizes adicionais:

    Se firstReply=true, inicie com "Olá/Bom dia/Boa tarde/Boa noite, tudo bem? Sim, fazemos frete." e em seguida faça a pergunta do primeiro campo faltante.
    Se telefone_ok=false e o cliente pedir preço/valor/orçamento, explique que quem passa o valor é o motorista e peça o WhatsApp, emendando imediatamente a próxima pergunta faltante.
    Se telefone_ok=true, não peça WhatsApp — siga para o próximo campo faltante. `.trim();
}

function buildUserPrompt({ cidade, historico, coletado, askCounts, flags = {}, missingFields = [] }) {
  const firstReply = !!(flags && flags.firstReply);
  const telefone_ok = !!(flags && flags.telefone_ok);

  const meta = [
    `firstReply: ${firstReply ? 'true' : 'false'}`,
    `telefone_ok: ${telefone_ok ? 'true' : 'false'}`,
    `missing: ${JSON.stringify(Array.isArray(missingFields) ? missingFields : [])}`
  ].join(' | ');

  const header = [
    `Cidade do perfil: ${cidade || '—'}`,
    `Meta: ${meta}`,
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
    txt = txt.replace(/^json\s*/i, '').replace(/^\s*/i, '').replace(/\s*```$/i, '').trim();

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
      respostaSan = respostaSan.replace(/\b\d{8,11}\b/g, '******');          // sequências "coladas" (8–11 dígitos)
      respostaSan = respostaSan.replace(/\+?\d[\d\s().-]{7,}\d/g, '******'); // com separadores (espaços, ( ), -, .)
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
      bairro_saida: safeDados.bairro_saida ?? null,
      bairro_destino: safeDados.bairro_destino ?? null,
      itens: safeDados.itens ?? null
    };

    // [ALTERAÇÃO] Só incluir peças soltas se NÃO houver telefone completo
    if (!telefoneOK && telefoneParcial) dadosOut.telefone_parcial = telefoneParcial;
    if (!telefoneOK && dddInformado) dadosOut.ddd = dddInformado;
    if (safeDados.debug) dadosOut.debug = safeDados.debug;

    // 6) Critério de finalização real (somente se todos os campos + WhatsApp válido existem)
    const finalizavel =
      !!dadosOut.itens &&
      !!dadosOut.bairro_saida &&
      !!dadosOut.bairro_destino &&
      (safeDados.ajudante === true || safeDados.ajudante === false || dadosOut.ajudante === true || dadosOut.ajudante === false) &&
      !!dadosOut.saida_tipo &&
      !!dadosOut.destino_tipo &&
      !!telefoneOK;

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
