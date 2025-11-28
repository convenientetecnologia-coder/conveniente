// promptFretes.js

'use strict';

function periodoAgora() {
  try {
    const h = new Date().getHours();
    if (h >= 5 && h <= 11) return 'manha';
    if (h >= 12 && h <= 17) return 'tarde';
    return 'noite';
  } catch {
    return 'manha';
  }
}

function buildSystemPrompt({ askField = null, allowSecondQuestion = false, nextField = null, phoneMode = 'lite', askReason = 'missing' } = {}) {
  return `
Você é um(a) atendente humano(a) de fretes. Gere a resposta e metadados em JSON e somente JSON, exatamente no formato abaixo.

Parâmetros de controle:

ask_field: ${askField === null ? 'null' : String(askField)}
next_field: ${nextField === null ? 'null' : String(nextField)}
allow_second_question: ${allowSecondQuestion ? 'true' : 'false'}
phone_mode: ${String(phoneMode || 'lite')}
ask_reason: ${String(askReason || 'missing')}

Valores permitidos para ask_field:

"itens" | "endereco_saida" | "endereco_destino" | "ajudante" | "saida_tipo" | "destino_tipo" | "saida_elevador" | "destino_elevador" | "telefone" | "ddd"

Regras determinísticas e de obediência:

Saudação inicial (obrigatório):
  - Se firstReply=true: inicie com uma saudação calorosa (ex.: bom dia/boa tarde/boa noite, conforme fizer sentido no histórico) e uma frase objetiva de disponibilidade (ex.: "sim, fazemos frete e podemos te atender agora"). Em seguida, vá direto às perguntas desta virada.
  - Use a saudação exata de acordo com "periodo" informado no User Prompt: Bom dia (05:00–11:59), Boa tarde (12:00–17:59), Boa noite (18:00–04:59).
  - Se firstReply=false: não cumprimente de novo.

Leitura e antirrepetição:
  - Leia o histórico E leia o que você mesmo(a) já respondeu. Não repita conteúdo do cliente e não repita suas próprias respostas anteriores. Não recapitule dados já informados.
  - Evite frases de confirmação ("Entendi", "Perfeito", "Recebi", "Ok", "Certo"). Seja humano(a) e direto(a).

Privacidade:
  - Nunca ecoe números de telefone/DDD no texto da "resposta" (nem mascarado). Telefones/DDD só podem aparecer nos metadados apropriados.

Atendimento de dúvidas (responder antes de perguntar):
  - Se o cliente trouxe alguma dúvida fora da coleta nas últimas mensagens (ex.: atende agora? quanto tempo? valor? como funciona? pagamento? nota fiscal?), responda primeiro em UMA frase objetiva.
  - Para "tempo/atende agora": • Se telefone_ok=true (no User Prompt): diga "Sim, o motorista te chama agora." (ou equivalente objetivo). • Se ainda NÃO houver telefone completo: diga "Assim que você me enviar o WhatsApp, o motorista te chama agora." e em seguida peça o WhatsApp conforme phone_mode (sem ecoar números).
  - Para "valor": explique brevemente que quem informa o valor é o motorista no WhatsApp e peça o WhatsApp conforme as diretivas (sem mencionar DDD no modo lite e sem ecoar números).
  - Após responder a dúvida, faça as perguntas desta virada conforme as diretivas (veja seção a seguir). Não adicione perguntas extras.

Número de perguntas (obediência rígida às diretivas):
  - ask_field NUNCA será null. Sempre haverá um campo para perguntar. O backend é quem determina o fim do ciclo, não a IA.
  - Se allow_second_question=true E next_field!=null: faça EXATAMENTE DUAS perguntas, nesta ordem:
      1) Pergunta sobre ask_field.
      2) Em seguida, pergunta sobre next_field. Não adicione nenhuma outra pergunta além dessas duas.
  - Se allow_second_question=false: faça EXATAMENTE UMA pergunta, sobre ask_field.
  - Sua resposta NUNCA pode ser apenas 'Ok', 'Anotado', 'Certo' ou variantes sem fazer perguntas. Se ask_field for fornecido (sempre será), a resposta DEVE conter explicitamente a(s) pergunta(s) exigida(s).
  - Nunca finalize ou pare a coleta por decisão própria. Nunca declare 'finalizado', 'atendimento concluído', 'já coletei tudo', etc.
  - Se não houver dúvidas do cliente para responder, siga direto para a(s) pergunta(s) determinada(s), sem frases soltas ou respostas 'neutras'.

Telefone:
  - Quando ask_field="telefone" e phone_mode="lite":
      - Se ask_reason="price_intent" OU se, pela lista "missing" (no User Prompt), os únicos campos faltantes forem de telefone (telefone/ddd): Inclua antes uma explicação breve: "Quem informa o valor é o motorista pelo WhatsApp; eu anoto o pedido e repasso para ele." Em seguida, peça o WhatsApp (não mencione DDD no modo lite).
      - Se allow_second_question=true e next_field!=null: emende a pergunta do next_field logo após pedir o WhatsApp.
  - Quando ask_field="telefone" e phone_mode="full":
      - Peça explicitamente o "WhatsApp com DDD" de forma direta.
      - Se allow_second_question=true e next_field!=null: mantenha duas perguntas (telefone com DDD + next_field). Se next_field for null (fim do fluxo), mantenha o pedido consolidado "com DDD" no próprio enunciado.
  - Quando ask_field="ddd":
      - Peça SOMENTE o DDD e, se allow_second_question=true e next_field!=null, emende a pergunta do next_field.

Tri-state obrigatório para os campos perguntados:
  - Para cada campo perguntado nesta virada (ask_field e, se houver, next_field), você DEVE preencher o valor correspondente em "dados" usando um dos seguintes tri-states (quando aplicável): • ajudante: true | false | "nao_respondeu" • saida_tipo: "casa" | "apartamento" | "nao_respondeu" • destino_tipo: "casa" | "apartamento" | "nao_respondeu" • saida_elevador: true | false | "nao_respondeu" • destino_elevador: true | false | "nao_respondeu"
  - Use "nao_respondeu" EXCLUSIVAMENTE quando o cliente não tiver fornecido informação suficiente para o campo perguntado.
  - Para campos de TEXTO (itens, endereco_saida, endereco_destino), não use "nao_respondeu": quando não houver informação, deixe null.

Intenção de preço (sem telefone completo):
  - Explique brevemente que o valor é informado pelo motorista no WhatsApp e peça o WhatsApp (aplique phone_mode conforme indicado). Não mencione DDD no modo lite.

SAÍDA OBRIGATÓRIA (um único objeto JSON válido):

{
"resposta": "texto a ser enviado ao cliente (humano, direto, sem redundâncias; antes das perguntas, responda em 1 frase qualquer dúvida do cliente; ao final, faça exatamente 1 ou 2 perguntas conforme ask_field/allow_second_question/next_field)",
"telefone_extraido": "se detectar nº BR 10-11 dígitos completo (somente dígitos); senão null",
"dados": {
"itens": "...|null",
"endereco_saida": "...|null",
"endereco_destino": "...|null",
"ajudante": true|false|"nao_respondeu",
"saida_tipo": "casa"|"apartamento"|"nao_respondeu",
"saida_elevador": true|false|"nao_respondeu",
"destino_tipo": "casa"|"apartamento"|"nao_respondeu",
"destino_elevador": true|false|"nao_respondeu",
"telefone_parcial": "8-9 dígitos ou null",
"ddd": "2 dígitos ou null"
}
}

IMPORTANTE: Nunca inclua o campo 'finalizado' na saída JSON. O backend é quem controla o fim do ciclo.

Restrições:

resposta nunca vazia.

Nunca inclua texto fora do JSON.

Nunca inclua Markdown, comentários ou cercas de código. `.trim();
}

function buildUserPrompt({ cidade, historico, coletado, askCounts, flags = {}, missingFields = [], askField = null, nextField = null, allowSecondQuestion = false, phoneMode = 'lite', askReason = 'missing' }) {
  const firstReply = !!(flags && flags.firstReply);
  const telefone_ok = !!(flags && flags.telefone_ok);
  const protestCount = typeof flags.protest_count === 'number' ? flags.protest_count : 0;
  const periodo = periodoAgora();

  const meta = [
    `ask_field: ${askField === null ? 'null' : String(askField)}`,
    `next_field: ${nextField === null ? 'null' : String(nextField)}`,
    `allow_second_question: ${allowSecondQuestion ? 'true' : 'false'}`,
    `phone_mode: ${String(phoneMode || 'lite')}`,
    `ask_reason: ${String(askReason || 'missing')}`,
    `firstReply: ${firstReply ? 'true' : 'false'}`,
    `telefone_ok: ${telefone_ok ? 'true' : 'false'}`,
    `protest_count: ${protestCount}`,
    `missing: ${JSON.stringify(Array.isArray(missingFields) ? missingFields : [])}`,
    `periodo: ${periodo}`
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
    let txt = String(rawText || '').trim();

    // Remoção forte de cercas de código e prefixos
    txt = txt.replace(/^\s*(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Remove prefixo "json" solto em início de linha
    txt = txt.replace(/^\s*json\s*$/im, '').trim();

    // Remoção robusta de cercas de código e prefixos "json"
    txt = txt.replace(/^\s*(?:json)?\s*/i, '').replace(/\s*$/i, '').replace(/^json\s*/i, '').trim();

    // Fallback: se não há JSON, usa o texto inteiro como resposta
    if (!/{[\s\S]*}/.test(txt)) {
      const fallback = String(txt).trim();
      // Tenta extrair apenas a propriedade "resposta" se houver no texto
      let respostaOnly = null;
      try {
        const m = fallback.match(/"resposta"\s*:\s*"((?:\\.|[^"\\])*)"/i);
        if (m && m[1]) {
          respostaOnly = m[1].replace(/\\"/g, '"');
        }
      } catch {}
      const base = respostaOnly || fallback;
      const baseSan = String(base)
        .replace(/\b\d{8,11}\b/g, '')          // bloqueia sequências coladas de 8–11 dígitos
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '') // bloqueia números com separadores
        .replace(/(\d[\s-]?){4,}/g, '*****')  // defensivo extra
        .replace(/[{}[\]]/g, ' ')              // remove colchetes/chaves se sobraram
        .replace(/\r?\n+/g, ' ')               // achata múltiplas linhas
        .trim();
      return {
        resposta: baseSan,
        telefone_extraido: null,
        finalizado: false,
        dados: {}
      };
    }

    let match = txt.match(/\{[\s\S]*\}/);
    if (!match) match = txt.match(/\{.*\}/s);
    if (!match) {
      const respostaFinal = String(rawText || '').trim();
      return { resposta: respostaFinal, telefone_extraido: null, finalizado: false, dados: {} };
    }

    const obj = JSON.parse(match[0]);

    function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
    function norm(s) {
      try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
      catch { return String(s||'').toLowerCase().trim(); }
    }

    // Sempre mascarar qualquer número no texto de resposta (não ecoar telefone do cliente)
    const originalResposta = String(obj.resposta || '');
    let respostaSan = String(originalResposta || '');
    try {
      respostaSan = respostaSan
        .replace(/\b\d{8,11}\b/g, '******')          // bloqueia sequências coladas de 8–11 dígitos
        .replace(/\+?\d[\d\s().-]{7,}\d/g, '******') // bloqueia números com separadores
        .replace(/(\d[\s-]?){4,}/g, '******');       // ainda mais defensivo
    } catch {}
    try {
      respostaSan = respostaSan
        .replace(/(?:^|\n)\srecebi\s+o\s+ddd[\s\S]?(?:.|\n|$)/gi, ' ')
        .replace(/(?:^|\n)\srecebi\s+seu\s+(?:whats|whatsapp)[\s\S]?(?:.|\n|$)/gi, ' ')
        .replace(/(?:^|\n)\sanotei\s+seu\s+(?:whats|whatsapp)[\s\S]?(?:.|\n|$)/gi, ' ')
        .replace(/(?:^|\n)\sconfirmo[\s\S]?(?:.|\n|$)/gi, ' ')
        .replace(/(?:^|\n)\s*(?:ok|certo|perfeito|entendi)[,!\s]\s/gi, ' ')
        .trim();
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

    // 5) Consolidar e normalizar campos "dados" (tri-state -> domínio)
    const safeDados = obj.dados && typeof obj.dados === 'object' ? obj.dados : {};

    function toTriBool(v) {
      if (v === true) return true;
      if (v === false) return false;
      const s = norm(v);
      if (s === 'sim' || s === 'true' || s === 'verdadeiro') return true;
      if (s === 'nao' || s === 'não' || s === 'false' || s === 'falso' || s === 'nao.') return false;
      if (s === 'nao_respondeu') return null;
      return (v == null) ? null : null;
    }

    function toCasaApto(v) {
      const s = norm(v);
      if (s === 'casa') return 'casa';
      if (s === 'apartamento' || s === 'ap' || s === 'apto' || s === 'apt' || s === 'apt.') return 'apartamento';
      if (s === 'nao_respondeu') return null;
      return (v == null) ? null : null;
    }

    const dadosOut = {
      ajudante: toTriBool(safeDados.ajudante),
      saida_tipo: toCasaApto(safeDados.saida_tipo),
      saida_elevador: toTriBool(safeDados.saida_elevador),
      destino_tipo: toCasaApto(safeDados.destino_tipo),
      destino_elevador: toTriBool(safeDados.destino_elevador),
      endereco_saida: safeDados.endereco_saida ?? null,
      endereco_destino: safeDados.endereco_destino ?? null,
      itens: safeDados.itens ?? null
    };

    // Só incluir peças soltas se NÃO houver telefone completo
    if (!telefoneOK && (safeDados.telefone_parcial != null)) {
      const tp = onlyDigits(safeDados.telefone_parcial);
      if (tp && (tp.length === 8 || tp.length === 9)) dadosOut.telefone_parcial = tp;
    }
    if (!telefoneOK && (safeDados.ddd != null)) {
      const dd = onlyDigits(safeDados.ddd);
      if (/^[1-9]\d$/.test(dd)) dadosOut.ddd = dd;
    }
    if (safeDados.debug) dadosOut.debug = safeDados.debug;

    // Fallback duro — nunca devolve resposta vazia
    // Garantir que mesmo respostas vazias/"ok"/"anotado"/"certo" retornem no campo resposta
    let respostaFinal = respostaSan || '';
    if (!respostaFinal || respostaFinal.trim().length === 0) {
      respostaFinal = String(rawText || '').trim();
    }
    // Se a resposta for apenas "ok"/"anotado"/"certo" (após sanitização), manter o texto original
    const respostaLower = respostaFinal.toLowerCase().trim();
    if (respostaLower === 'ok' || respostaLower === 'anotado' || respostaLower === 'certo' || respostaLower === 'perfeito' || respostaLower === 'entendi') {
      respostaFinal = String(rawText || '').trim() || respostaFinal;
    }

    // Guarda final: se por algum motivo "resposta" parecer JSON, extraia texto humano
    try {
      if (typeof respostaFinal === 'string' && /{.*"resposta"\s*:/.test(txt)) {
        const m = txt.match(/"resposta"\s*:\s*"((?:\\.|[^"\\])*)"/i);
        if (m && m[1]) {
          respostaFinal = m[1].replace(/\\"/g, '"').replace(/\r?\n+/g, ' ').trim();
        }
      }
      // Evita enviar JSON ou blocos grandes por engano
      if (/^\s*[{[]/.test(respostaFinal) || /"dados"\s*:/.test(respostaFinal)) {
        respostaFinal = respostaFinal.replace(/[{}[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      }
    } catch {}

    return {
      resposta: respostaFinal,
      telefone_extraido: telefoneOK || null,
      finalizado: false,
      dados: dadosOut
    };

  } catch (e) {
    const respostaFinal = String(rawText || '').trim();
    return { resposta: respostaFinal, telefone_extraido: null, finalizado: false, dados: {} };
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
