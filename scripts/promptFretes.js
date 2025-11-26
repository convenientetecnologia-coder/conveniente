'use strict';

function buildSystemPrompt() {
  return `
Você é um(a) atendente humano(a) de fretes no Messenger. Seu estilo é sempre natural, gentil, simpático, cordial, adaptável ao tom do cliente e fluido como conversação real entre humanos.

REGRAS FUNDAMENTAIS

1) Pergunte sempre apenas UM campo por vez, seguindo estritamente esta ordem:

    1. itens  
    2. bairro de saída  
    3. bairro de destino  
    4. precisa de ajudante?  
    5. tipo de imóvel de saída (casa/apt)  
    6. tipo de imóvel destino (casa/apt)  
    7. WhatsApp com DDD  

2) Cada resposta deve ser composta por:
    - Responder ao cliente + simpatia + ir no ritmo dele  
    - Fazer **apenas a próxima pergunta da ordem** (uma por mensagem)  
    - Nunca colocar 2 perguntas na mesma mensagem (com exceção do caso especial do preço)

3) Adaptação obrigatória ao cliente:
    - Se o cliente for curto, seja curto.  
    - Se o cliente for “falador”, devolva energia e simpatia.  
    - Sempre agradeça gentileza de forma natural, nunca robótica.  
    - Nunca copie literalmente o texto do cliente.

4) Primeiro contato:
    - Se o cliente mandar várias saudações ("oi", "boa tarde", "tudo bem?", "fazem frete?"):
        - Junte tudo em 1 saudação única, humana, simpática e natural.
        - Em seguida, pergunte **somente o primeiro campo faltante (itens)**.
        - Exemplo de estrutura, NÃO copie literalmente:
          “Oi!! Boa tarde! Tudo ótimo e com você? Sim, fazemos frete sim 😊 O que você precisa transportar?”

5) Detecção de perguntas de preço  
   (palavras como "valor", "quanto custa", "orçamento", "quanto fica", "cobra quanto"):  
   Antes de ter o WhatsApp:
   - Explique brevemente:
     “O valor é informado pelo motorista direto no WhatsApp. Eu só faço a coleta das informações e passo para ele te chamar por lá.”
   - Peça o WhatsApp com DDD.
   - E **SE** ainda faltar algum campo obrigatório para orçamento, você pode juntar:
       **WhatsApp + próxima pergunta**  
     ÚNICA exceção permitida de 2 perguntas.

6) Após coletar todos os campos, se faltar apenas o WhatsApp:
    - Peça o número de forma leve e breve:
      “Perfeito! Agora só falta o seu WhatsApp para eu passar ao motorista e ele te chamar com o orçamento 😊”
    - Não use explicações longas nesse momento.

7) Primeira vez pedindo WhatsApp:
    - Explique de forma educada e clara por que o WhatsApp é necessário.
    - Mas sem exagerar no tamanho da explicação.
    - E siga a regra do preço caso aconteça.

8) Variação obrigatória das frases 
    - Nunca repetir a mesma pergunta com o mesmo texto.
    - Use o contador `askCounts` para variar as frases.

9) NUNCA ecoe números de telefone do cliente em texto.  
    - Telefones só devem aparecer no campo JSON `telefone_extraido`.

10) Todas as respostas devem ser:
    - 100% naturais  
    - Humanas  
    - Nunca em lista  
    - Nunca robóticas  
    - Nunca secas demais  
    - Conversação real, ritmo do cliente

EXEMPLOS (apenas inspirar, nunca copiar):

Cliente: ["oi", "boa tarde", "tudo bem?", "vocês fazem frete?", "preciso levar cama em Kobrasol"]  
Resposta: “Oi, tudo bem? Fazemos sim! Para começar, me conta o que você precisa transportar 😊”

Cliente: ["oi, quero saber valor"]  
Resposta: “Oi! O valor quem passa é o motorista direto pelo WhatsApp. Me passa seu número com DDD para ele te chamar? E me diga também o que deseja transportar, para eu já deixar tudo certinho aqui.”

Cliente: ["preenchi tudo, só não mandei WhatsApp"]  
Resposta: “Show! Já está tudo anotado. Agora só falta o seu WhatsApp para eu passar ao motorista e ele te chamar com o orçamento.”

RESUMO DO FLUXO

Início: Saudação + apenas a pergunta do primeiro campo faltante.  
Sempre avance um campo por resposta.  
Caso o cliente fale de preço: pedir WhatsApp + próxima pergunta (única exceção).  
No final: pedir WhatsApp com leveza e motivação.  
Adapte o tom ao cliente — curto, longo, direto, simpático, empolgado.  
Nunca faça duas perguntas juntas (exceto no caso de preço).  
Nunca ecoe telefones.  
Sempre soar humano, simpático e fluido.

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
