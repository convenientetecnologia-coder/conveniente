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
  if (!d.bairro_saida) missing.push('bairro_saida');
  if (!d.bairro_destino) missing.push('bairro_destino');
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
    bairro_saida: null,
    bairro_destino: null,
    ajudante: null,
    saida_tipo: null,
    saida_elevador: null,
    destino_tipo: null,
    destino_elevador: null,
    telefone: null,
    ddd: null,
    telefone_parcial: null,
    cidade: null,
    missing: []
  };

  try {
    if (!obj || typeof obj !== 'object') return out;

    const pickStr = (v) => {
      if (v == null) return null;
      let s = String(v).trim();
      if (!s) return null;
      if (s.length > 180) s = s.slice(0, 180);
      return s;
    };
    const pickBool = (v) => {
      if (v === true) return true;
      if (v === false) return false;
      return null;
    };
    const pickTipo = (v) => {
      const t = normTxt(v);
      if (t === 'casa' || t === 'apartamento') return t;
      if (/apto|apt/.test(t)) return 'apartamento';
      if (/casa/.test(t)) return 'casa';
      return null;
    };

    out.itens = pickStr(obj.itens);
    out.bairro_saida = pickStr(obj.bairro_saida);
    out.bairro_destino = pickStr(obj.bairro_destino);
    out.ajudante = pickBool(obj.ajudante);
    out.saida_tipo = pickTipo(obj.saida_tipo);
    out.destino_tipo = pickTipo(obj.destino_tipo);
    out.saida_elevador = pickBool(obj.saida_elevador);
    out.destino_elevador = pickBool(obj.destino_elevador);
    out.cidade = pickStr(obj.cidade);

    // Telefones
    const telFull = onlyDigits(obj.telefone);
    const ddd = onlyDigits(obj.ddd);
    const parcial = onlyDigits(obj.telefone_parcial);

    if (isValidBRPhoneWithDDD(telFull)) {
      out.telefone = telFull;
      out.ddd = null;
      out.telefone_parcial = null;
    } else {
      if (ddd && ddd.length === 2) out.ddd = ddd;
      if (parcial && (parcial.length === 8 || parcial.length === 9)) out.telefone_parcial = parcial;

      if (!out.telefone && out.ddd && out.telefone_parcial) {
        const comb = out.ddd + out.telefone_parcial;
        if (isValidBRPhoneWithDDD(comb)) {
          out.telefone = comb;
          out.ddd = null;
          out.telefone_parcial = null;
        }
      }
    }

    // Missing fields
    out.missing = Array.isArray(obj.missing) ? (obj.missing || []).map(String) : computeMissing(out);

  } catch {
    out.missing = computeMissing(out);
  }

  return out;
}

function buildSystemPrompt() {
  return `
Você é um extrator de dados determinístico. Sempre responda com um único JSON válido, sem texto fora do JSON.

Objetivo: Dado o histórico recente de uma conversa sobre frete (cliente/ia), extraia e consolide os campos a seguir e informe "missing":

    itens: string|null
    bairro_saida: string|null
    bairro_destino: string|null
    ajudante: true|false|null
    saida_tipo: "casa"|"apartamento"|null
    saida_elevador: true|false|null
    destino_tipo: "casa"|"apartamento"|null
    destino_elevador: true|false|null
    telefone: string de 10–11 dígitos (somente números) ou null (apenas completo com DDD)
    ddd: string com 2 dígitos ou null (use apenas quando cliente enviar DDD isolado)
    telefone_parcial: 8–9 dígitos ou null (use apenas se cliente enviar número sem DDD)
    cidade: string|null (se disponível no contexto)
    missing: array com nomes de campos ausentes para concluir o pedido

Regras de telefone:

    Se cliente enviar de uma vez o número com DDD (10–11 dígitos), normalize para "telefone" (somente números).
    Se enviar DDD isolado (2 dígitos) em uma mensagem e depois o número parcial (8–9), componha "telefone" quando possível.
    Não inclua caracteres que não sejam dígitos nos campos de telefone.
    telefone deve estar completo (DDD + número válido BR) para preencher "telefone".

Outras regras:

    Normalize "apto", "apt" para "apartamento".
    "ajudante" deve ser true/false quando a conversa indica claramente, senão null.
    Considere apenas as últimas 15 mensagens relevantes do cliente e o contexto fornecido.
    Missing deve considerar obrigatórios: itens, bairro_saida, bairro_destino, ajudante, saida_tipo, destino_tipo, (saida_elevador e destino_elevador se tipo for "apartamento"), cidade, telefone.
    Saída estritamente JSON. Nenhuma explicação ou texto fora do JSON.

Formato de saída OBRIGATÓRIO:
{
"itens": "...|null",
"bairro_saida": "...|null",
"bairro_destino": "...|null",
"ajudante": true|false|null,
"saida_tipo": "casa"|"apartamento"|null,
"saida_elevador": true|false|null,
"destino_tipo": "casa"|"apartamento"|null,
"destino_elevador": true|false|null,
"telefone": "10-11 dígitos ou null",
"ddd": "2 dígitos ou null",
"telefone_parcial": "8-9 dígitos ou null",
"cidade": "...|null",
"missing": ["lista de campos faltantes"]
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
  // Determinístico: temperature 0, sem texto fora do JSON
  const system = buildSystemPrompt();
  const user = buildUserPrompt({ mensagens, contexto });

  let raw = '{}';
  try {
    raw = await chatCompletion({ system, user, provider: 'groq', task: 'extract', timeoutMs: 22000, retries: 2 });
  } catch (e) {
    raw = '{}';
  }
  // Tolerância: tenta extrair o primeiro JSON do texto (se vier algo indevido)
  let firstJson = '{}';
  try {
    const m = String(raw || '').match(/{[\s\S]*}/);
    firstJson = m ? m[0] : '{}';
  } catch { firstJson = '{}'; }

  let parsed = {};
  try { parsed = JSON.parse(firstJson); } catch { parsed = {}; }

  const sanitized = sanitizeExtracted(parsed);
  // Aplica contexto de cidade se extrator não trouxe
  if (!sanitized.cidade && contexto && contexto.cidade) sanitized.cidade = String(contexto.cidade);
  // Recalcula missing coerente
  sanitized.missing = computeMissing(sanitized);

  return sanitized;
}

module.exports = { extractOrderFieldsLLM };

