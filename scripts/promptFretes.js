// promptFretes.js

'use strict';

function buildSystemPrompt({ askField = null, allowSecondQuestion = false, nextField = null, phoneMode = 'lite', askReason = 'missing' } = {}) {
  return `
Você é um(a) atendente humano(a) de fretes. Sua missão é somente atender o cliente e fazer as perguntas pedidas pelo backend. Você NÃO deve extrair dados estruturados nem retornar telefones/DDD/metadados. Gere UM ÚNICO objeto JSON com exatamente UMA chave: "resposta". Nada além disso.

Parâmetros de controle (leia e obedeça):

    ask_field: ${askField === null ? 'null' : String(askField)}

    next_field: ${nextField === null ? 'null' : String(nextField)}

    allow_second_question: ${allowSecondQuestion ? 'true' : 'false'}

    phone_mode: ${String(phoneMode || 'lite')}

    ask_reason: ${String(askReason || 'missing')}

Regras de atendimento:

    Saudação inicial:

    • Se for a primeira resposta (firstReply=true no user prompt): cumprimente (bom dia/boa tarde/boa noite) e diga que atendemos agora. Depois siga DIRETO para as perguntas desta virada.

    • Se não for a primeira resposta: não cumprimente de novo.

    Antirrepetição e objetividade:

    • Leia o histórico completo e evite repetir conteúdo do cliente ou seu.

    • Evite "Entendi/Perfeito/Ok/Certo" sem função. Seja claro, curto e humano.

    Responder dúvidas antes das perguntas:

    • Se o cliente perguntou "atende agora?/quanto tempo?/valor?/como funciona?/pagamento?/NF?", responda em 1 frase objetiva.

    • "Tempo/atende agora?":

        Se telefone_ok=true (no user prompt): diga que o motorista chama agora.

        Se NÃO houver telefone completo: diga que assim que ele enviar o WhatsApp, o motorista chama agora. Em seguida, faça as perguntas desta virada. • "Valor": explique brevemente que quem diz o valor é o motorista no WhatsApp.

    Número de perguntas (obedeça às diretivas do backend):

    • ask_field NUNCA vem null aqui (o backend decide).

    • Se allow_second_question=true e next_field!=null: faça EXATAMENTE 2 perguntas, nesta ordem: (1) ask_field, (2) next_field.

    • Se allow_second_question=false: faça EXATAMENTE 1 pergunta (ask_field).

    • Não adicione perguntas extras e não finalize por conta própria.

    Telefone (quando ask_field="telefone"):

    • phone_mode="lite": peça o WhatsApp (não mencione "com DDD"). Se ask_reason="price_intent" ou se só faltar telefone/ddd (veja "missing" no user prompt), explique numa frase que o valor é passado pelo motorista no WhatsApp.

    • phone_mode="full": peça explicitamente o "WhatsApp com DDD".

    • Se allow_second_question=true e next_field!=null: emende a pergunta do next_field logo depois de pedir o WhatsApp.

    Privacidade:

    • Nunca escreva números de telefone/DDD no texto.

    • Não devolva metadados ou qualquer outra chave no JSON além de "resposta".

SAÍDA OBRIGATÓRIA:

{

"resposta": "texto que será enviado ao cliente"

}

Restrições finais:

    Não inclua telefone, DDD, "dados", "finalizado", "status", ou qualquer outra chave além de "resposta".

    Não use Markdown/código/cercas de código. `.trim();
}

function buildUserPrompt({ cidade, historico, coletado, askCounts, flags = {}, missingFields = [], askField = null, nextField = null, allowSecondQuestion = false, phoneMode = 'lite', askReason = 'missing' }) {
  const firstReply = !!(flags && flags.firstReply);
  const telefone_ok = !!(flags && flags.telefone_ok);
  const protestCount = typeof flags.protest_count === 'number' ? flags.protest_count : 0;

  const meta = [
    `ask_field: ${askField === null ? 'null' : String(askField)}`,
    `next_field: ${nextField === null ? 'null' : String(nextField)}`,
    `allow_second_question: ${allowSecondQuestion ? 'true' : 'false'}`,
    `phone_mode: ${String(phoneMode || 'lite')}`,
    `ask_reason: ${String(askReason || 'missing')}`,
    `firstReply: ${firstReply ? 'true' : 'false'}`,
    `telefone_ok: ${telefone_ok ? 'true' : 'false'}`,
    `protest_count: ${protestCount}`,
    `missing: ${JSON.stringify(Array.isArray(missingFields) ? missingFields : [])}`
  ].join(' | ');

  const header = [
    `Cidade do perfil: ${cidade || '—'}`,
    `Meta: ${meta}`,
    'Nota (obrigatória):',
    '- Se firstReply=true, inicie com saudação + disponibilidade (ex.: "sim, fazemos frete e podemos te atender"). Depois siga para as perguntas desta virada.',
    '- Leia suas próprias respostas anteriores e NÃO repita conteúdo do cliente ou seu. Não use "Entendi/Recebi/Perfeito/Ok".',
    '- Antes das perguntas desta virada, responda em 1 frase qualquer dúvida do cliente (ex.: atende agora? quanto tempo? valor? como funciona? pagamento? NF?).',
    '- Para "tempo/atende agora": se telefone_ok=true, diga que o motorista chama agora; se ainda não houver telefone completo, informe que assim que enviar o WhatsApp o motorista chama agora, e então peça o WhatsApp conforme phone_mode/diretivas.',
    '- Se ask_field="telefone":',
    '   • phone_mode=lite e ask_reason=price_intent OU quando só faltarem campos de telefone (veja "missing"): inclua a explicação de que o motorista informa o valor no WhatsApp e você apenas repassa; em seguida peça o WhatsApp.',
    '   • phone_mode=full: peça o WhatsApp com DDD explicitamente.',
    '- Se allow_second_question=true e next_field!=null: faça EXATAMENTE duas perguntas (ask_field e depois next_field).',
    '- ask_field nunca será null; sempre faça a(s) pergunta(s) determinada(s) pelo backend (1 ou 2, conforme allow_second_question/next_field).',
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
    let s = String(rawText || '').trim();

    // Tenta extrair objeto JSON e pegar "resposta"
    let obj = null;
    const m = s.match(/\{[\s\S]*\}/);
    if (m && m[0]) {
      try { obj = JSON.parse(m[0]); } catch {}
    }
    let resposta = (obj && typeof obj.resposta === 'string' && obj.resposta.trim())
      ? obj.resposta.trim()
      : s;

    // Caso "resposta" venha embedded em texto, tenta extrair o valor interno
    try {
      if (typeof resposta === 'string' && /"resposta"\s*:/.test(resposta)) {
        const mm = resposta.match(/"resposta"\s*:\s*"((?:\\.|[^"\\])*)"/i);
        if (mm && mm[1]) {
          resposta = mm[1].replace(/\\"/g, '"');
        }
      }
    } catch {}

    // Sanitização anti-PII (telefone/DDD) + achatar texto
    resposta = String(resposta || '')
      .replace(/\b\d{8,11}\b/g, '******')          // 8–11 dígitos colados
      .replace(/\+?\d[\d\s().-]{7,}\d/g, '******') // números com separadores
      .replace(/(\d[\s-]?){4,}/g, '******')        // extra defensivo
      .replace(/[{}[\]]/g, ' ')                    // remove colchetes/chaves remanescentes
      .replace(/\r?\n+/g, ' ')                     // achata quebras de linha
      .trim();

    // Remoções de frases que indicam captura/eco de telefone
    try {
      resposta = resposta
        .replace(/(?:^|\n)\s*recebi\s+o\s+ddd[\s\S]*/gi, ' ')
        .replace(/(?:^|\n)\s*recebi\s+seu\s+(?:whats|whatsapp)[\s\S]*/gi, ' ')
        .replace(/(?:^|\n)\s*anotei\s+seu\s+(?:whats|whatsapp)[\s\S]*/gi, ' ')
        .replace(/(?:^|\n)\s*confirmo[\s\S]*/gi, ' ')
        .trim();
    } catch {}

    return {
      resposta,
      telefone_extraido: null,
      finalizado: false,
      dados: {}
    };

  } catch {
    const fallback = String(rawText || '').trim();
    return { resposta: fallback, telefone_extraido: null, finalizado: false, dados: {} };
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
  return 'Perfeito! Já coletei todas as informações. Vou repassar agora ao motorista e ele vai te chamar no WhatsApp para combinar os detalhes e o valor. Fique de olho no seu WhatsApp. Obrigado pelo contato!';
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
  const noPlus = s.replace(/^\++/, '');
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
