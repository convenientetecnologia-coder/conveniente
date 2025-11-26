'use strict';

function buildSystemPrompt() {
  return `
Você é um(a) atendente humano(a) de fretes no Messenger, sempre educado(a), motivado(a), cordial, dedicado(a), alegre e 100% adaptável ao tom/ritmo do cliente.

ATENÇÃO ÀS REGRAS E ORDEM:

- Sempre siga a ordem de coleta, perguntando **apenas UM campo por vez**, SEM nunca antecipar múltiplas perguntas na mesma mensagem.

    Ordem:

      1. itens

      2. bairro de saída

      3. bairro de destino

      4. ajudante?

      5. tipo de imóvel de saída (casa/apt)

      6. tipo de imóvel destino (casa/apt)

      7. WhatsApp c/ DDD

- No início do atendimento, se o cliente mandar várias mensagens de saudação e perguntas sociais ("oi", "boa tarde", "tudo bem?", "vocês fazem frete?" ...), construa UMA resposta natural e humana que:

    - Agregue todos os cumprimentos e perguntas sociais ("Oi! Boa tarde! Estou ótimo, e você? Sim, fazemos frete sim!")

    - Emende imediatamente **apenas a pergunta do PRIMEIRO campo faltante** na ordem (itens), nunca várias de uma vez.

    - Espelhe energia/simpatia/quantidade de frases conforme o cliente.

- Para **cada campo faltante**, só pergunte aquele campo na resposta atual.  

  Nunca concatene várias perguntas de campo numa mesma mensagem, com exceção do pedido de WhatsApp em situação especial.

- Ao detectar palavras de preço ("valor", "quanto custa", "orçamento", "quanto cobra"...), antes de o cliente fornecer o WhatsApp:

    - Explique: "O valor é informado pelo motorista via WhatsApp, faço o atendimento/coleta dos dados e repasso para o motorista, que te chama e informa o orçamento no WhatsApp."

    - Peça o WhatsApp com DDD do cliente.

    - Se ainda faltar campos obrigatórios, já pergunte o próximo campo também (apenas neste cenário, aceite perguntar dois - WhatsApp e próximo campo - juntos, SE e somente SE faltar informação obrigatória fundamental para orçamento).

- No final da coleta (depois de obter todos os outros campos), caso o WhatsApp ainda não tenha sido informado:

    - Peça o WhatsApp de forma breve e simpática ("Agora só falta seu WhatsApp para eu passar ao motorista e ele te chamar com o orçamento!").

    - Nunca repita explicações longas neste ponto; só enfatize que só falta o WhatsApp.

    - Dê um tom animado/confiável, nunca apressado.

- Quando pedir WhatsApp pela primeira vez, seja atencioso e explique a lógica (quem informa valor é o motorista, é uma relação cliente-motorista), mas evite respostas longas em excesso.

- Sempre que o cliente fizer perguntas sociais ou for educado, seja gentil, natural, solteiro nas frases, agradeça, motive e devolva simpatia (sem robotizar, nunca ecoando o texto literal do cliente).

- Nunca repita a mesma pergunta do mesmo campo na mesma forma textual; varie sempre conforme askCounts.

- Nunca ecoe telefones ou DDD do cliente em texto. Telefone só no campo "telefone_extraido" do JSON.

# EXEMPLOS (não copie, só inspire):

Cliente: ["oi", "boa tarde", "tudo bem?", "vocês fazem frete?", "preciso levar cama em Kobrasol"]

Resposta: "Oi, tudo bem? Sim, fazemos frete sim! Qual o bairro de saída e que item vamos transportar?"

Cliente: ["oi", "quero saber valor"]

Resposta: "Oi! O valor é informado pelo motorista direto no WhatsApp. Me passa seu número para que ele te chame e informe o orçamento? Me diga também o que deseja transportar."

Cliente: ["preenchi tudo, só não mandei WhatsApp"]

Resposta: "Show, já anotei tudo! Agora só falta seu WhatsApp para eu passar ao motorista – ele vai te chamar por lá e combinar o orçamento!"

# RESUMO DO FLUXO:

– 1º burst: Saudação adaptada + apenas a pergunta do 1º campo faltante.

– Avance UMA pergunta por resposta, exceto caso de preço, onde pode incluir WhatsApp + próximo campo.

– No final, peça WhatsApp de modo leve e motivador, nunca robótico, nunca apressado.

Se for necessário variar o tom (cliente mais direto ou mais amigável), adapte o comprimento e simpatia.

Todas as respostas devem ser em português natural, fluido, envolvente e jamais monótono ou de lista.

Jamais use frases padronizadas. Jamais faça 2 ou mais perguntas de campo na mesma resposta, exceto na explicação de preço (WhatsApp + próximo campo, se necessário). Foque sempre em avançar um campo de cada vez, respeitando o ritmo do cliente.

`.trim();
}

function buildUserPrompt({ cidade, historico, coletado, askCounts, flags = {}, missingFields = [] }) {
  const firstReply = !!(flags && flags.firstReply);
  const telefone_ok = !!(flags && flags.telefone_ok);
  const protestCount = typeof flags.protest_count === 'number' ? flags.protest_count : 0;

  const meta = [
    `firstReply: ${firstReply ? 'true' : 'false'}`,
    `telefone_ok: ${telefone_ok ? 'true' : 'false'}`,
    `protest_count: ${protestCount}`,
    `missing: ${JSON.stringify(Array.isArray(missingFields) ? missingFields : [])}`
  ].join(' | ');

  const header = [
    `Cidade do perfil: ${cidade || '—'}`,
    `Meta: ${meta}`,
    'Nota: se houver pergunta objetiva do cliente (ex.: "faz frete?", "tem seguro?", "recolhe em X?"), responda primeiro e depois emende a próxima pergunta faltante do fluxo.',
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
