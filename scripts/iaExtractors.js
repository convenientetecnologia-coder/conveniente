'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

const RE_PHONE_BR = /\b(?:\+?55\s*)?(?:\(?([1-9]\d)\)?[\s.\-()]*)?([2-9]\d{3,4}[\s.\-()]?\d{4})\b/g;

function removeTelefonesCompletosLoose(s) {
  try {
    let x = String(s||'');
    x = x.replace(/\b(?:\+?55\s*)?(?:\(?[1-9]{2}\)?[\s.\-()]?)?(?:9?\d{4}[\s.\-()]?\d{4})\b/g, '*');
    x = x.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]'); // CPF
    x = x.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]'); // CNPJ
    x = x.replace(/\b(?:\d[\s.\-()]?){8,11}\b/g, '**'); // genérico
    return x;
  } catch { return String(s||''); }
}

// NOVO: máscara para o EXTRATOR — mantém telefones visíveis, mascara apenas CPF/CNPJ
function maskForExtractorPhonesAllowed(s) {
  try {
    let x = String(s||'');
    // NÃO mascarar telefones aqui — o extrator precisa enxergar dígitos
    x = x.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[dados omitidos]'); // CPF
    x = x.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[dados omitidos]'); // CNPJ
    return x;
  } catch { return String(s||''); }
}

function fallbackPhoneFromMessages(mensagens = []) {
  try {
    const arr = (Array.isArray(mensagens) ? mensagens : [])
      .filter(m => m && m.autor === 'cliente')
      .slice(-30) // últimas 30 do cliente
      .reverse(); // mais recentes primeiro

    for (const m of arr) {
      const text = String(m.texto || '');
      let match;
      RE_PHONE_BR.lastIndex = 0;
      while ((match = RE_PHONE_BR.exec(text)) !== null) {
        const ddd = String(match[1] || '').replace(/\D/g, '');
        const corpo = String(match[2] || '').replace(/\D/g, '');
        // corpo: 8 ou 9 dígitos
        if (corpo.length < 8 || corpo.length > 9) continue;
        if (ddd && ddd.length === 2) {
          const full = ddd + corpo;
          if (isValidBRPhoneWithDDD(full)) {
            return { telefone: full }; // telefone completo válido
          }
        } else {
          // sem DDD: retorna parcial
          return { telefone_parcial: corpo };
        }
      }
    }

  } catch {}
  return null;
}

function onlyDigits(s){ return String(s||'').replace(/\D/g,''); }
function normTxt(s) {
  try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); }
  catch { return String(s||'').trim().toLowerCase(); }
}
function isValidBRPhoneWithDDD(d) {
  const s = onlyDigits(d);
  if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
  if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
  return false;
}

function computeMissing(data) {
  const d = data || {};
  const missing = [];
  // WhatsApp completo (com DDD) é obrigatório
  if (!isValidBRPhoneWithDDD(d.telefone)) missing.push('telefone');
  // Coleta mínima obrigatória do pedido
  if (!d.itens) missing.push('itens');
  if (!d.endereco_saida) missing.push('endereco_saida');
  if (!d.endereco_destino) missing.push('endereco_destino');
  // "ajudante", "cidade", "descricao" NÃO bloqueiam o pedido!
  return missing;
}

// Detecção simples de protesto (apenas para extração pura)
const RE_PROTESTO = /(ja\s+falei|já\s+falei|ja\s+passei|já\s+passei|leia\s+acima|olha\s+acima|pare\s+de\s+perguntar|para\s+de\s+perguntar|n[aã]o\s+insista|de\s+novo)/i;

function sanitizeExtracted(obj, mensagensFull = []) {
  const out = {
    itens: null,
    endereco_saida: null,
    endereco_destino: null,
    ajudante: null, // opcional
    telefone: null,
    ddd: null,
    telefone_parcial: null,
    cidade: null,
    descricao: null,
    missing: [],
    protesto: false
  };

  try {
    if (!obj || typeof obj !== 'object') {
      out.missing = computeMissing(out);
      return out;
    }

    const onlyDigits = s => String(s||'').replace(/\D/g,'');
    const pickStr = v => {
      if (v == null) return null;
      let s = String(v).trim();
      if (!s) return null;
      if (s.length > 300) s = s.slice(0,300);
      return s;
    };
    const pickBool = v => (v === true ? true : (v === false ? false : null));

    out.itens = pickStr(obj.itens);
    out.endereco_saida = pickStr(obj.endereco_saida);     // aceita informal
    out.endereco_destino = pickStr(obj.endereco_destino); // aceita informal
    out.ajudante = pickBool(obj.ajudante);                // opcional
    out.cidade = pickStr(obj.cidade);
    out.descricao = pickStr(obj.descricao);

    const telFull = onlyDigits(obj.telefone);
    const ddd = onlyDigits(obj.ddd);
    const parcial = onlyDigits(obj.telefone_parcial);
    const isValidBR = isValidBRPhoneWithDDD;

    if (isValidBR(telFull)) {
      out.telefone = telFull;
    } else {
      if (ddd && ddd.length === 2) out.ddd = ddd;
      if (parcial && (parcial.length === 8 || parcial.length === 9)) out.telefone_parcial = parcial;
      const comb = (out.ddd || '') + (out.telefone_parcial || '');
      if (comb && isValidBR(comb)) {
        out.telefone = comb;
        out.ddd = null;
        out.telefone_parcial = null;
      }
    }

    out.protesto = !!obj.protesto;
    out.missing = computeMissing(out);

  } catch {
    out.missing = computeMissing(out);
  }

  return out;
}

function buildSystemPrompt() {
  return `
Você é um extrator determinístico. Saída: APENAS UM JSON, sem texto extra.

Objetivo: a partir do histórico, consolidar:

    telefone: "10–11 dígitos (BR) com DDD" ou null

    ddd: "2 dígitos" ou null (se cliente mandou separado)

    telefone_parcial: "8–9 dígitos" ou null (sem DDD)

    itens: string | null (o que precisa transportar)

    endereco_saida: string | null (aceita informal: bairro, ponto de referência, termos curtos; nunca rejeite formas como "parque", "centro", "aldeião", "ali pro kobrasol", "mercado")

    endereco_destino: string | null (aceita informal: termos curtos, como acima)

    ajudante: true|false|null (opcional, não trava o pedido)

    descricao: string | null (resumo/concat do que o cliente informou — livre)

    cidade: string | null (se houver)

    missing: ["telefone", "itens", "endereco_saida", "endereco_destino"] — apenas esses

    protesto: true|false (se houver reclamações tipo "já falei", "pare de perguntar"...)

Regras:

    Endereços informais e curtos são válidos: aceite exemplos como "parque", "centro", "aldeião", "ali pro kobrasol", "mercado".

    NUNCA normalize para "casa/apartamento/elevador". NUNCA pedir ou sugerir formato "rua/número/bairro".

    NÃO extraia/normalize tipo de imóvel ou elevador.

    Se veio ddd separadamente e telefone parcial, monte telefone com DDD quando válido.

    Mapear verbos comuns:
        Se o cliente falar em "buscar", "retirar", "pegar" + local, considere ENDERECO_SAIDA.
        Se o cliente falar em "levar", "entregar", "pra/para" + local, considere ENDERECO_DESTINO.
        Aceite expressões como "ali no centro", "aqui no parque", "ali no kobrasol".

    Telefones:
        Extraia telefone completo (10–11 dígitos com DDD) quando houver.
        Se vier somente número de 8–9 dígitos, coloque em telefone_parcial; se vier apenas DDD, coloque em ddd.
        Monte o telefone final com DDD + telefone_parcial quando possível.

    Retorne APENAS o JSON final (sem frases).

Formato OBRIGATÓRIO:

{
"telefone": "string|null",
"ddd": "string|null",
"telefone_parcial": "string|null",
"itens": "string|null",
"endereco_saida": "string|null",
"endereco_destino": "string|null",
"ajudante": true|false|null,
"descricao": "string|null",
"cidade": "string|null",
"missing": ["..."],
"protesto": true|false
}
`.trim();
}

function buildUserPrompt({ mensagens, contexto }) {
  // mensagens: array [{autor:'cliente'|'ia', texto, timestamp}]
  const pick = Array.isArray(mensagens) ? mensagens.slice(-30) : [];
  const hist = pick.map(m => {
    const autor = (m.autor === 'ia' ? 'Atendente' : 'Cliente');
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : '';
    return `[${autor}]${ts ? ' ' + ts : ''}: ${m.texto || ''}`;
  }).join('\n');

  // NOVO: para o EXTRATOR, não mascarar telefones; mascarar apenas CPF/CNPJ
  const histMasked = maskForExtractorPhonesAllowed(hist);

  const cidadeCtx = contexto && contexto.cidade ? `cidade_contexto: ${contexto.cidade}` : 'cidade_contexto: null';

  return [
    'Contexto:',
    cidadeCtx,
    '',
    'Histórico (mais recente ao final):',
    histMasked || '(vazio)'
  ].join('\n');
}

async function extractOrderFieldsLLM({ perfil, chatId, mensagens, contexto }) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt({ mensagens, contexto });

  let raw = '{}';
  try {
    const model = process.env.GROQ_MODEL_EXTRACT || process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
    raw = await chatCompletion({ system, user, provider: 'groq', model, task: 'extract', timeoutMs: 22000, retries: 2 });
  } catch {
    raw = '{}';
  }
  let firstJson = '{}';
  try {
    const m = String(raw || '').match(/{[\s\S]*}/);
    firstJson = m ? m[0] : '{}';
  } catch { firstJson = '{}'; }

  let parsed = {};
  try { parsed = JSON.parse(firstJson); } catch { parsed = {}; }

  const sanitized = sanitizeExtracted(parsed, mensagens);

  // FALLBACK DETERMINÍSTICO DE TELEFONE (regex) — só se a LLM não trouxe telefone completo
  try {
    let phoneFallbackUsed = false;

    if (!sanitized.telefone) {
      const fb = fallbackPhoneFromMessages(mensagens);
      if (fb && fb.telefone && isValidBRPhoneWithDDD(fb.telefone)) {
        sanitized.telefone = fb.telefone;
        sanitized.ddd = null;
        sanitized.telefone_parcial = null;
        phoneFallbackUsed = true;
      } else if (fb && fb.telefone_parcial && !sanitized.telefone_parcial && !sanitized.telefone) {
        sanitized.telefone_parcial = fb.telefone_parcial;
        phoneFallbackUsed = true;
      }
    }

    // Montagem automática de telefone caso tenha DDD + parcial (após fallback)
    if (!sanitized.telefone && sanitized.ddd && sanitized.telefone_parcial) {
      const comb = String(sanitized.ddd).replace(/\D/g,'') + String(sanitized.telefone_parcial).replace(/\D/g,'');
      if (isValidBRPhoneWithDDD(comb)) {
        sanitized.telefone = comb;
        sanitized.ddd = null;
        sanitized.telefone_parcial = null;
      }
    }

    if (phoneFallbackUsed) {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL(perfil, 'ia_extract_phone_fallback', {
          chatId,
          used: true,
          hasFull: !!sanitized.telefone,
          hasPartial: !!sanitized.telefone_parcial
        });
      } catch {}
    }
  } catch {}

  // HEURÍSTICA LEVE PARA ENDEREÇOS INFORMAIS (apenas se ainda estiverem ausentes)
  try {
    const textosCliente = (Array.isArray(mensagens) ? mensagens : [])
      .filter(m => m && m.autor === 'cliente')
      .map(m => String(m.texto || ''))
      .slice(-10);
    const joined = textosCliente.join(' | ');

    if (!sanitized.endereco_saida) {
      const mSaida = joined.match(/\b(?:buscar|retirar|pegar|coletar)\s+(?:em|no|na|aqui|ali)?\s*([^|,.\n]{3,60})/i);
      if (mSaida && mSaida[1]) {
        sanitized.endereco_saida = mSaida[1].trim();
      }
    }

    if (!sanitized.endereco_destino) {
      const mDest = joined.match(/\b(?:levar|entregar|para|pra|pro)\s+(?:o|a|no|na|ali|lá|la)?\s*([^|,.\n]{3,60})/i);
      if (mDest && mDest[1]) {
        sanitized.endereco_destino = mDest[1].trim();
      }
    }
  } catch {}

  // Recalcula missing após os reforços
  sanitized.missing = computeMissing(sanitized);

  // Detecção simples de protesto (apenas se não veio do JSON)
  if (!sanitized.protesto && Array.isArray(mensagens)) {
    const clientTexts = mensagens.filter(m => m && m.autor === 'cliente').map(m => String(m.texto || ''));
    for (const txt of clientTexts) {
      if (RE_PROTESTO.test(txt)) {
        sanitized.protesto = true;
        break;
      }
    }
  }

  // Preenche descricao se estiver vazia, concatenando mensagens do cliente
  try {
    const textoHistorico = (Array.isArray(mensagens) ? mensagens : []).filter(m => m && m.autor === 'cliente').map(m => m.texto).join(' | ').slice(0, 600);
    if (!sanitized.descricao && textoHistorico) {
      sanitized.descricao = textoHistorico;
    }
  } catch {}

  try {
    const stepLog = require('./stepLog.js');
    stepLog.appendJSONL(perfil, 'ia_extract', {
      chatId, raw, firstJson, parsedPreview: Object.keys(parsed||{}), ts: Date.now()
    });
  } catch {}

  // Fallback e log se JSON inválido ou parse falhou
  const hasValidJson = firstJson && firstJson !== '{}' && parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  if (!hasValidJson) {
    try { require('./issues.js').append(perfil, 'ia_extract_raw_invalid', `extractor_raw_invalid chat=${chatId}`); } catch {}

    // Fallback: usa texto da última mensagem do cliente como itens se não houver
    if (!sanitized.itens) {
      const lastClient = Array.isArray(mensagens) ? mensagens.slice().reverse().find(m => m && m.autor === 'cliente') : null;
      if (lastClient && lastClient.texto) {
        sanitized.itens = String(lastClient.texto).slice(0, 60);
      }
    }

  }

  if (!sanitized.cidade && contexto && contexto.cidade) sanitized.cidade = String(contexto.cidade);
  sanitized.missing = computeMissing(sanitized);
  return sanitized;
}

module.exports = { extractOrderFieldsLLM };
