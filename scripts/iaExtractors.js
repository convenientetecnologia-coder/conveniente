// iaExtractors.js

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
  // WhatsApp completo (com DDD) é obrigatório
  if (!isValidBRPhoneWithDDD(d.telefone)) missing.push('telefone');
  // Coleta mínima obrigatória do pedido
  if (!d.itens) missing.push('itens');
  if (!d.endereco_saida) missing.push('endereco_saida');
  if (!d.endereco_destino) missing.push('endereco_destino');
  // "ajudante", "cidade", "descricao" NÃO bloqueiam o pedido!
  return missing;
}

// [PATCH] — Heurísticas de análise contextual (urgência, intenção, emoção, regionalismo, ciclo, etc.)

function _norm(s){ try{ return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); } catch { return String(s||'').toLowerCase().trim(); } }

function _isQuestion(s){ return /\?/.test(String(s||'')); }

const RE_VALOR = /(pre[cç]o|valor|quanto\s+(custa|fica|sai)|or[cç]amento|cobra)/i;

const RE_URGENCIA = /\b(agora|pra\s*hoje|hoje|urgente|agorinha|imediat[oa]|para\s+agora|daqui\s+agora)\b/i;

const RE_INSEGURANCA = /(nao\s+entendi|não\s+entendi|como\s+funciona|explica|pode\s+explicar|n[ãa]o\s+sei|nao\s+sei)/i;

const RE_PROTESTO = /(ja\s+falei|já\s+falei|ja\s+passei|já\s+passei|leia\s+acima|olha\s+acima|pare\s+de\s+perguntar|para\s+de\s+perguntar|n[aã]o\s+insista|de\s+novo)/i;

const RE_REG_SUL = /\b(bah|tri|guri|guria|capaz|tch[eê])\b/i;

const RE_REG_NE = /\b(oxe|visse|arretad[oa]|cabrunco|vixe|mizeravi)\b/i;

const RE_REG_MG = /\b(uai|trem|s[ôo])\b/i;

// Junta as últimas mensagens do cliente num texto único, limpo, para uso em conversação/acolhimento/contexto
function unifyClientMessages(novasMsgs = [], historico = []) {
  let blocos = [];

  if (Array.isArray(novasMsgs) && novasMsgs.length) {
    blocos = novasMsgs.filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim()).map(m => String(m.texto || '').trim());
  }

  if (!blocos.length) {
    const base = (Array.isArray(historico) ? historico : []).filter(m => m && m.autor === 'cliente' && String(m.texto || '').trim());
    blocos = base.slice(-5).map(m => String(m.texto || '').trim());
  }

  // Dedup simples dentro do bloco
  const seen = new Set();
  const uniq = [];
  for (const t of blocos) {
    const n = _norm(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    uniq.push(t);
  }

  return uniq.join(' ');
}

function analyzeInteraction(mensagens = [], contexto = {}) {
  const msgs = Array.isArray(mensagens) ? mensagens.slice(-30) : [];

  const clientes = msgs.filter(m => m && m.autor === 'cliente' && String(m.texto||'').trim());

  const ias = msgs.filter(m => m && m.autor === 'ia' && String(m.texto||'').trim());

  let valorCount = 0, telefoneCount = 0, enderecoCount = 0, duvidaFluxo = 0;

  let urgente = false, inseguro = false, impaciente = false, insistente = false, detalhista = false, protesto = false;

  let regiao = null;

  const seenClientTexts = clientes.map(m => String(m.texto||''));

  const lastClientText = seenClientTexts[seenClientTexts.length - 1] || '';

  for (const tRaw of seenClientTexts) {
    const t = String(tRaw||'');

    const n = _norm(t);
    if (RE_VALOR.test(t)) valorCount++;

    if (/\b(whats|whatsapp|ddd|telefone|celular|zap)\b/i.test(t)) telefoneCount++;

    if (/\b(endere[cç]o|endereço|saida|sa[ií]da|destino|entrega|bairro|refer[êe]ncia)\b/i.test(t)) enderecoCount++;

    if (RE_URGENCIA.test(t)) urgente = true;

    if (RE_INSEGURANCA.test(t)) inseguro = true;

    if (RE_PROTESTO.test(t)) protesto = true;

    if (RE_REG_NE.test(t)) regiao = 'nordeste';

    if (RE_REG_SUL.test(t)) regiao = regiao || 'sul';

    if (RE_REG_MG.test(t)) regiao = regiao || 'sudeste_mg';

    if (/como\s+funciona|nao\s+entendi|não\s+entendi/i.test(t)) duvidaFluxo++;

    if ((t.match(/[,:;-]\s*\w+/g) || []).length >= 3 || t.length > 180) detalhista = true;

  }

  // Impaciência: muitos "?" em mensagens curtas ou repetição de pedidos (valor, disponibilidade)

  const questCount = seenClientTexts.reduce((acc, s) => acc + (_isQuestion(s) ? 1 : 0), 0);

  impaciente = questCount >= 2 || valorCount >= 2;

  // Insistência: intenção repetida (valor ou telefone) 2+ vezes

  insistente = valorCount >= 2 || telefoneCount >= 2;

  // Intenção principal

  let intencao = null;

  if (valorCount > 0) intencao = 'valor';

  else if (/\b(dispon[ií]vel|disponivel|tem\s+agora|ainda\s+tem)\b/i.test(lastClientText)) intencao = 'disponibilidade';

  else if (enderecoCount > 0) intencao = 'endereco';

  else if (telefoneCount > 0) intencao = 'telefone';

  else if (duvidaFluxo > 0) intencao = 'funcionamento';

  else intencao = 'outro';

  // Prioridade e tom

  const prioridade = urgente ? 'alta' : 'normal';

  let tom_emocional = 'objetivo';

  if (inseguro) tom_emocional = 'acolhedor';

  if (insistente || impaciente || urgente) tom_emocional = 'direto';

  // Repetições

  const repeticoes = {

    valor: valorCount,

    telefone: telefoneCount,

    endereco: enderecoCount,

    duvida_fluxo: duvidaFluxo

  };

  // Ja respondeu X?

  const ja_respondeu = {

    endereco_saida: false,

    endereco_destino: false,

    telefone: false,

    itens: false

  };
  // heurística simples (se o cliente citou termos-chave)

  for (const t of seenClientTexts) {

    const n = _norm(t);

    if (/sa[ií]da|retirada|origem/.test(n)) ja_respondeu.endereco_saida = true;

    if (/destino|entrega|para\s+onde/.test(n)) ja_respondeu.endereco_destino = true;

    if (/whats|whatsapp|ddd|celular|zap|telefone/.test(n)) ja_respondeu.telefone = true;

    if (/levar|transportar|itens?/.test(n)) ja_respondeu.itens = true;

  }

  const meta = {

    ciclo: Math.max(1, ias.length + clientes.length ? Math.ceil((ias.length + clientes.length) / 2) : 1),

    mensagens_cliente: clientes.length,

    mensagens_ia: ias.length,

    last_cliente_ts: (clientes[clientes.length - 1] && Number(clientes[clientes.length - 1].timestamp || 0)) || null

  };

  const flags = {

    urgente,

    inseguro,

    impaciente,

    insistente,

    detalhista,

    regionalismo_detectado: !!regiao,

    protesto

  };

  const meta_instrucoes = [];

  if (urgente) meta_instrucoes.push('Seja direto e curto; responda em 1 frase o que der e peça o campo obrigatório imediatamente.');

  if (inseguro) meta_instrucoes.push('Use um tom acolhedor, passe segurança e clareza sem jargão.');

  if (insistente) meta_instrucoes.push('Evite explicações repetidas; foque na pergunta do funil com frase curta.');

  if (flags.regionalismo_detectado) meta_instrucoes.push('Aplique micro variação de linguagem regional leve (ex.: "já já", "rapidinho").');

  const sugestaoPrompt = {

    prioridade,

    tom_emocional,

    contexto_regional: regiao || null,

    intencao_principal: intencao,

    repeticoes,

    flags,

    ja_respondeu,

    meta,

    instrucoes: meta_instrucoes

  };

  return sugestaoPrompt;

}

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
    descricao: null, // NOVO campo, livre
    missing: [],
    protesto: false,
    sugestaoPrompt: null,
    texto_cliente_unificado: null // NOVO!
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

  out.texto_cliente_unificado = unifyClientMessages([], mensagensFull);

  return out;
}

function buildSystemPrompt() {
  return `
Você é um extrator determinístico. Saída: APENAS UM JSON, sem texto extra.

Objetivo: a partir do histórico, consolidar:

- telefone: "10–11 dígitos (BR) com DDD" ou null

- ddd: "2 dígitos" ou null (se cliente mandou separado)

- telefone_parcial: "8–9 dígitos" ou null (sem DDD)

- itens: string | null (o que precisa transportar)

- endereco_saida: string | null (aceita informal: bairro, ponto de referência, termos curtos; nunca rejeite formas como "parque", "centro", "aldeião", "ali pro kobrasol", "mercado")

- endereco_destino: string | null (aceita informal: termos curtos, como acima)

- ajudante: true|false|null (opcional, não trava o pedido)

- descricao: string | null (resumo/concat do que o cliente informou — livre)

- cidade: string | null (se houver)

- missing: ["telefone", "itens", "endereco_saida", "endereco_destino"] — apenas esses

- protesto: true|false (se houver reclamações tipo "já falei", "pare de perguntar"...)

Regras:

- Endereços informais e curtos são válidos: aceite exemplos como "parque", "centro", "aldeião", "ali pro kobrasol", "mercado".

- NUNCA normalize para "casa/apartamento/elevador". NUNCA pedir ou sugerir formato "rua/número/bairro".

- NÃO extraia/normalize tipo de imóvel ou elevador.

- Se veio ddd separadamente e telefone parcial, monte telefone com DDD quando válido.

- Retorne APENAS o JSON final (sem frases).

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

  // [PATCH] — análise de contexto
  const sugestao = analyzeInteraction(Array.isArray(mensagens) ? mensagens : [], contexto || {});
  sanitized.sugestaoPrompt = sugestao || null;

  // Harmoniza protesto
  if (!sanitized.protesto && sugestao && sugestao.flags && sugestao.flags.protesto) {
    sanitized.protesto = true;
  }

  try {
    const stepLog = require('./stepLog.js');
    stepLog.appendJSONL(perfil, 'ia_extract_analysis', {
      chatId,
      analise: sanitized.sugestaoPrompt,
      ts: Date.now()
    });
  } catch {}
  
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

