'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');

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
  if (!d.itens) missing.push('itens');
  if (!d.endereco_saida) missing.push('endereco_saida');
  if (!d.endereco_destino) missing.push('endereco_destino');
  if (typeof d.ajudante !== 'boolean') missing.push('ajudante');
  if (!d.saida_tipo) missing.push('saida_tipo');
  if (!d.destino_tipo) missing.push('destino_tipo');
  if (d.saida_tipo === 'apartamento' && typeof d.saida_elevador !== 'boolean') missing.push('saida_elevador');
  if (d.destino_tipo === 'apartamento' && typeof d.destino_elevador !== 'boolean') missing.push('destino_elevador');
  // Cidade e Telefone são obrigatórios para envio final
  if (!d.cidade) missing.push('cidade');
  if (!d.telefone) missing.push('telefone');
  return missing;
}

function sanitizeExtracted(obj) {
  const out = {
    itens: null,
    endereco_saida: null,
    endereco_destino: null,
    ajudante: null,
    saida_tipo: null,
    saida_elevador: null,
    destino_tipo: null,
    destino_elevador: null,
    telefone: null,
    ddd: null,
    telefone_parcial: null,
    cidade: null,
    missing: [],
    protesto: false
  };

  try {
    if (!obj || typeof obj !== 'object') {
      out.missing = computeMissing(out);
      return out;
    }

    const onlyDigits = s => String(s||'').replace(/\D/g,'');
    const normTxt = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
    const pickStr = v => {
      if (v == null) return null;
      let s = String(v).trim();
      if (!s) return null;
      if (s.length > 180) s = s.slice(0,180);
      return s;
    };
    const pickBool = v => (v === true ? true : (v === false ? false : null));
    const pickTipo = v => {
      const t = normTxt(v);
      if (/ap|apt|apto|apart/.test(t)) return 'apartamento';
      if (t.includes('apartamento')) return 'apartamento';
      if (t.includes('casa')) return 'casa';
      return null;
    };

    out.itens = pickStr(obj.itens);
    out.endereco_saida = pickStr(obj.endereco_saida);
    out.endereco_destino = pickStr(obj.endereco_destino);
    out.ajudante = pickBool(obj.ajudante);
    out.saida_tipo = pickTipo(obj.saida_tipo);
    out.destino_tipo = pickTipo(obj.destino_tipo);
    out.saida_elevador = pickBool(obj.saida_elevador);
    out.destino_elevador = pickBool(obj.destino_elevador);
    out.cidade = pickStr(obj.cidade);

    const telFull = onlyDigits(obj.telefone);
    const ddd = onlyDigits(obj.ddd);
    const parcial = onlyDigits(obj.telefone_parcial);

    const isValidBR = s => {
      if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
      if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
      return false;
    };

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

    out.missing = Array.isArray(obj.missing) && obj.missing.length
      ? obj.missing.map(String)
      : computeMissing(out);

  } catch {
    out.missing = computeMissing(out);
  }

  return out;
}

function buildSystemPrompt() {
  return `
Você é um extrator determinístico. Saída: um JSON ÚNICO e NADA mais.

Objetivo: Dado o histórico (cliente/ia), extraia e consolide os campos:

- itens: string|null

- endereco_saida: string|null (endereço completo)

- endereco_destino: string|null (endereço completo)

- ajudante: true|false|null

- saida_tipo: "casa"|"apartamento"|null (normalize: ap/apto/apt/apart → "apartamento")

- saida_elevador: true|false|null (somente se saida_tipo="apartamento")

- destino_tipo: "casa"|"apartamento"|null (normalize aptos etc.)

- destino_elevador: true|false|null (somente se destino_tipo="apartamento")

- telefone: string (10–11 dígitos, BR) ou null (somente completo + DDD)

- ddd: 2 dígitos ou null (se cliente mandou DDD isolado)

- telefone_parcial: 8–9 dígitos ou null (se cliente mandou apenas número sem DDD)

- cidade: string|null

- missing: array [campos faltantes]

- protesto: true|false (se houver sinais de irritação: "já falei", "olha acima", "você é burro?", "pare de perguntar", etc.)

Regras:

- Some mensagens fragmentadas. Se houver ddd e telefone_parcial, componha telefone se válido.

- Nunca ecoe PII ou números de telefone fora do campo correto.

- Normalize casa/apartamento (aceite variações: ap, apt, apto, apart).

- Se detectar protestos, marque protesto: true.

- Missing considera obrigatórios: itens, endereco_saida, endereco_destino, ajudante, saida_tipo, destino_tipo, (saida_elevador e destino_elevador se "apartamento"), cidade, telefone.

Saída OBRIGATÓRIA (apenas JSON, NUNCA TEXTO solto):

{
 "itens": "...|null",
 "endereco_saida": "...|null",
 "endereco_destino": "...|null",
 "ajudante": true|false|null,
 "saida_tipo": "casa"|"apartamento"|null,
 "saida_elevador": true|false|null,
 "destino_tipo": "casa"|"apartamento"|null,
 "destino_elevador": true|false|null,
 "telefone": "10-11 dígitos ou null",
 "ddd": "2 dígitos ou null",
 "telefone_parcial": "8-9 dígitos ou null",
 "cidade": "...|null",
 "missing": ["lista de campos faltantes"],
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
    return `[${autor}]${ts? ` ${ts}`:''}: ${m.texto || ''}`;
  }).join('\n');

  const cidadeCtx = contexto && contexto.cidade ? `cidade_contexto: ${contexto.cidade}` : 'cidade_contexto: null';

  return [
    'Contexto:',
    cidadeCtx,
    '',
    'Histórico (mais recente ao final):',
    hist || '(vazio)'
  ].join('\n');
}

async function extractOrderFieldsLLM({ perfil, chatId, mensagens, contexto }) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt({ mensagens, contexto });

  let raw = '{}';
  try {
    raw = await chatCompletion({ system, user, provider: 'groq', task: 'extract', timeoutMs: 22000, retries: 2 });
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

  const sanitized = sanitizeExtracted(parsed);
  
  try {
    const stepLog = require('./stepLog.js');
    stepLog.appendJSONL(perfil, 'ia_extract', {
      chatId, raw, firstJson, parsedPreview: Object.keys(parsed||{}), ts: Date.now()
    });
  } catch {}
  
  // Fallback e log se JSON inválido ou parse falhou
  const hasValidJson = firstJson && firstJson !== '{}' && parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  if (!hasValidJson) {
    try { require('./issues.js').append(perfil, 'pedidos_order_sent', `extractor_raw_invalid chat=${chatId}`); } catch {}
    
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

