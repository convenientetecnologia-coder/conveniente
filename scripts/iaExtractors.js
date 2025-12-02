'use strict';

const { chatCompletion } = require('./inteligenciaArtificial.js');
const { computeMissing } = require('./missing.js');

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

// Validação específica para WhatsApp (só aceita 11 dígitos começando com 9 após DDD)
function isValidWhatsAppTelefone(d) {
  const s = String(d || '').replace(/\D/g, '');
  if (s.length !== 11) return false;
  // DDD (2 dígitos) + 9 (celular) + 8 dígitos
  return /^[1-9]{2}9\d{8}$/.test(s);
}

// REMOVIDO: computeMissing local - agora importado de ./missing.js

// Detecção simples de protesto (apenas para extração pura)
const RE_PROTESTO = /(ja\s+falei|já\s+falei|ja\s+passei|já\s+passei|leia\s+acima|olha\s+acima|pare\s+de\s+perguntar|para\s+de\s+perguntar|n[aã]o\s+insista|de\s+novo)/i;

// Proteção contra ruídos: palavras que não devem ser extraídas como item/endereço
// AMPLIADO: inclui mais variações e termos relacionados ao serviço
const RE_NOISE_ITEM = /\b(conveniente|atendente|motorista|fretes?|frete|pedido|orçamento|orçamento|preço|preco|valor|quanto\s+custa|whatsapp|wpp|ddd|telefone|número|numero|contato|chamar|ligar|entrar\s+em\s+contato|disponivel|disponível|tem\s+agora|faz\s+frete|como\s+funciona)\b/i;
const RE_NOISE_ADDRESS = /\b(conveniente|atendente|motorista|fretes?|frete|pedido|orçamento|preço|preco|valor|quanto\s+custa|whatsapp|wpp|ddd|telefone|número|numero|contato|chamar|ligar|entrar\s+em\s+contato|disponivel|disponível|tem\s+agora|faz\s+frete|como\s+funciona)\b/i;

// HEURÍSTICA DE ITENS - LEXICON para detectar itens (nunca extrair como endereço)
const ITEM_LEXICON = [
  'cama','sof[aá]','mesa','geladeira','fog[aã]o','guarda-roupa','arm[aá]rio','c[áa]ixa[s]?',
  'colch[aã]o','cadeira[s]?','prateleira[s]?', 'm[aá]quina de lavar','micro-ondas',
  'm[óo]vel','m[óo]veis','eletrodom[ée]stico','eletrodom[ée]sticos','tv','televis[ãa]o',
  'computador','notebook','geladeira','freezer','lavadora','secadora'
];
const RX_ITEM = new RegExp(`\\b(${ITEM_LEXICON.join('|')})\\b`, 'i');
function looksLikeItem(val) {
  if (!val) return false;
  return RX_ITEM.test(String(val).trim());
}

// HEURÍSTICA DE DESTINO - Marcadores de direção (para/pro/pra/até/no/na/destino/entrega)
const RX_DESTINO_MARKER = /\b(at[eé]\s+|para\s+|pro\s+|pra\s+|no\s+|na\s+|ao\s+|a\s+|destino|entrega)\b/i;
function isMarker(txt) {
  if (!txt) return false;
  return RX_DESTINO_MARKER.test(String(txt));
}

// Função auxiliar: verifica se o texto é APENAS ruído (sem conteúdo válido)
function isOnlyNoise(text, noiseRegex) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  // Se o texto inteiro é apenas palavras de ruído (com ou sem pontuação), é ruído
  const cleaned = trimmed.replace(/[.,!?;:]/g, '').trim();
  return noiseRegex.test(cleaned) && cleaned.split(/\s+/).length <= 3; // Máximo 3 palavras de ruído
}

// Detecção de tom da saudação do cliente
function analyzeClientTone(firstMsg) {
  try {
    const msg = String(firstMsg || '').trim();
    if (!msg) return 'neutro';
    
    const lower = msg.toLowerCase();
    
    // Análise de energia/animado
    const animado = /(!!+|!{2,}|😊|😁|kk|haha|rsrs|hehe|bom\s+dia{3,}|boa\s+tarde{3,}|salve{3,}|e\s+a[ií]{3,})/i.test(msg);
    if (animado) return 'animado';
    
    // Análise de empolgado (múltiplas vogais, letras repetidas)
    const empolgado = /([aá]{3,}|[eê]{3,}|[ií]{3,}|[oô]{3,}|[uú]{3,}|bom\s+dia{4,}|boa\s+tarde{4,})/i.test(msg);
    if (empolgado) return 'empolgado';
    
    // Análise de formalidade
    const formal = /^(bom\s+dia|boa\s+tarde|boa\s+noite|olá|senhor|senhora|boa\s+noite)/i.test(msg);
    if (formal) return 'formal';
    
    return 'neutro';
  } catch {
    return 'neutro';
  }
}

// Extração do texto da saudação do cliente (primeiros 1-2 cumprimentos)
function extractClientGreeting(mensagens = []) {
  try {
    const clientMsgs = (Array.isArray(mensagens) ? mensagens : [])
      .filter(m => m && m.autor === 'cliente')
      .slice(0, 2); // Primeiras 1-2 mensagens
    
    if (!clientMsgs.length) return null;
    
    const greetings = [];
    for (const msg of clientMsgs) {
      const texto = String(msg.texto || '').trim();
      if (!texto) continue;
      
      // Detecta se é saudação (primeiras palavras)
      const saudacaoMatch = texto.match(/^(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|e\s+a[ií]|salve|opa|fala)[!.,\s]*/i);
      if (saudacaoMatch) {
        greetings.push(texto.slice(0, 100).trim()); // Primeiros 100 caracteres
      }
    }
    
    return greetings.length > 0 ? greetings.join(' | ') : null;
  } catch {
    return null;
  }
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
    descricao: null,
    missing: [],
    protesto: false,
    tom_cliente: 'neutro', // animado, formal, empolgado, neutro (SEMPRE presente, nunca null)
    saudacao_cliente: null // texto dos primeiros cumprimentos (pode ser null se não houver)
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

    // Proteção contra ruídos: filtra palavras que não devem ser extraídas
    // Só rejeita se for APENAS ruído (não bloqueia "cama do conveniente" ou "rua do motorista")
    // PROTEÇÃO EXTRA: nunca extrai item se for apenas marcador de destino ou ruído
    let itensRaw = pickStr(obj.itens);
    if (itensRaw) {
      // Rejeita se for APENAS ruído
      if (isOnlyNoise(itensRaw, RE_NOISE_ITEM)) {
        itensRaw = null;
      }
      // Rejeita se for APENAS marcador de destino (sem conteúdo válido)
      else if (isMarker(itensRaw) && itensRaw.split(/\s+/).length <= 3) {
        itensRaw = null;
      }
    }
    out.itens = itensRaw;
    
    let enderecoSaidaRaw = pickStr(obj.endereco_saida);
    // Aceita informalidade: "ali no parque", "centro", "aqui perto do mercado" são válidos
    // Só rejeita se for APENAS palavra de ruído
    if (enderecoSaidaRaw && isOnlyNoise(enderecoSaidaRaw, RE_NOISE_ADDRESS)) {
      enderecoSaidaRaw = null; // Não extrai ruídos como endereço se for apenas isso
    }
    out.endereco_saida = enderecoSaidaRaw;     // aceita informal (nunca normaliza)
    
    let enderecoDestinoRaw = pickStr(obj.endereco_destino);
    // Aceita informalidade: "ali no parque", "centro", "aqui perto do mercado" são válidos
    // Só rejeita se for APENAS palavra de ruído
    if (enderecoDestinoRaw && isOnlyNoise(enderecoDestinoRaw, RE_NOISE_ADDRESS)) {
      enderecoDestinoRaw = null; // Não extrai ruídos como endereço se for apenas isso
    }
    out.endereco_destino = enderecoDestinoRaw; // aceita informal (nunca normaliza)
    
    out.ajudante = pickBool(obj.ajudante);                // opcional
    out.cidade = pickStr(obj.cidade);
    out.descricao = pickStr(obj.descricao);
    
    // Extração de tom e saudação do cliente (SEMPRE extrai, mesmo se não vier do JSON)
    const primeiraMsg = Array.isArray(mensagensFull) 
      ? mensagensFull.find(m => m && m.autor === 'cliente')?.texto || ''
      : '';
    out.tom_cliente = analyzeClientTone(primeiraMsg);
    out.saudacao_cliente = extractClientGreeting(mensagensFull);
    
    // Log quando extrai tom/saudação (para auditoria)
    if (out.tom_cliente || out.saudacao_cliente) {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL('default', 'ia_extract_tom_saudacao_in_sanitize', {
          tom_cliente: out.tom_cliente,
          saudacao_cliente: out.saudacao_cliente ? out.saudacao_cliente.slice(0, 50) : null,
          primeiraMsgPreview: primeiraMsg.slice(0, 50)
        });
      } catch {}
    }

    const telFull = onlyDigits(obj.telefone);
    const ddd = onlyDigits(obj.ddd);
    const parcial = onlyDigits(obj.telefone_parcial);
    const isValidBR = isValidBRPhoneWithDDD;

    // VALIDAÇÃO WHATSAPP: só aceita telefone válido se for WhatsApp (11 dígitos, celular com 9)
    if (telFull && isValidWhatsAppTelefone(telFull)) {
      out.telefone = telFull;
      // Limpa ddd e parcial se telefone completo é válido
      out.ddd = null;
      out.telefone_parcial = null;
    } else {
      // Se não é WhatsApp válido, preenche ddd e parcial mas NUNCA monta telefone
      if (ddd && ddd.length === 2) out.ddd = ddd;
      if (parcial && (parcial.length === 8 || parcial.length === 9)) out.telefone_parcial = parcial;
      
      // Se tem DDD + parcial, verifica se é WhatsApp válido antes de montar
      const comb = (out.ddd || '') + (out.telefone_parcial || '');
      if (comb && isValidWhatsAppTelefone(comb)) {
        out.telefone = comb;
        out.ddd = null;
        out.telefone_parcial = null;
      } else if (comb && isValidBR(comb)) {
        // Telefone fixo (10 dígitos) ou inválido: NUNCA monta telefone, mantém ddd e parcial
        // O FSM vai perguntar explicitamente se é WhatsApp ou pedir número correto
        out.telefone = null;
        // Mantém ddd e parcial para o FSM decidir
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

    Endereços informais e curtos são SEMPRE válidos: aceite exemplos como "parque", "centro", "aldeião", "ali pro kobrasol", "mercado", "aqui perto do mercado", "ali no parque", "no centro", etc.
    
    NUNCA normalize para "casa/apartamento/elevador". NUNCA pedir ou sugerir formato "rua/número/bairro".
    
    NUNCA rejeite endereços informais válidos — eles são aceitos como estão.

    NÃO extraia/normalize tipo de imóvel ou elevador.

    PROTEÇÃO CONTRA RUÍDOS:
        NÃO extraia palavras como "Conveniente", "atendente", "motorista", "frete", "pedido", "orçamento", "preço", "valor", "whatsapp", "wpp", "ddd", "telefone", "número", "contato", "chamar", "disponível", "faz frete", "como funciona" como itens ou endereços.
        Se o texto contiver APENAS essas palavras (sem conteúdo válido), retorne null para o campo.
        Mas se tiver conteúdo válido junto (ex: "cama do conveniente"), aceite o conteúdo válido.

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
"protesto": true|false,
"tom_cliente": "animado|formal|empolgado|neutro",
"saudacao_cliente": "string|null"
}

Observações:
- "tom_cliente" deve SEMPRE estar presente (nunca null).
- "saudacao_cliente" é o texto literal das primeiras 1-2 saudações do cliente.
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
    let phoneFallbackType = null;

    if (!sanitized.telefone) {
      const fb = fallbackPhoneFromMessages(mensagens);
      if (fb && fb.telefone) {
        // VALIDAÇÃO WHATSAPP: só aceita se for WhatsApp válido (11 dígitos, celular com 9)
        if (isValidWhatsAppTelefone(fb.telefone)) {
          sanitized.telefone = fb.telefone;
          sanitized.ddd = null;
          sanitized.telefone_parcial = null;
          phoneFallbackUsed = true;
          phoneFallbackType = 'whatsapp_valid';
        } else if (isValidBRPhoneWithDDD(fb.telefone)) {
          // Telefone fixo (10 dígitos) ou inválido: NUNCA monta telefone, mantém ddd e parcial
          // Extrai DDD e parcial separadamente
          const s = String(fb.telefone).replace(/\D/g, '');
          if (s.length === 10) {
            sanitized.ddd = s.slice(0, 2);
            sanitized.telefone_parcial = s.slice(2);
            sanitized.telefone = null; // NUNCA preenche telefone se não for WhatsApp
            phoneFallbackUsed = true;
            phoneFallbackType = 'fixed_phone_ddd_parcial';
          }
        }
      } else if (fb && fb.telefone_parcial && !sanitized.telefone_parcial && !sanitized.telefone) {
        sanitized.telefone_parcial = fb.telefone_parcial;
        phoneFallbackUsed = true;
        phoneFallbackType = 'parcial_only';
      }
    }

    // Montagem automática de telefone caso tenha DDD + parcial (após fallback) - SÓ SE FOR WHATSAPP
    if (!sanitized.telefone && sanitized.ddd && sanitized.telefone_parcial) {
      const comb = String(sanitized.ddd).replace(/\D/g,'') + String(sanitized.telefone_parcial).replace(/\D/g,'');
      // VALIDAÇÃO WHATSAPP: só monta se for WhatsApp válido
      if (isValidWhatsAppTelefone(comb)) {
        sanitized.telefone = comb;
        sanitized.ddd = null;
        sanitized.telefone_parcial = null;
        phoneFallbackType = phoneFallbackType || 'whatsapp_assembled';
      } else {
        // Telefone fixo ou inválido: NUNCA monta telefone, mantém ddd e parcial
        sanitized.telefone = null;
        phoneFallbackType = phoneFallbackType || 'fixed_phone_not_assembled';
      }
    }

    if (phoneFallbackUsed) {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL(perfil, 'ia_extract_phone_fallback', {
          chatId,
          used: true,
          hasFull: !!sanitized.telefone,
          hasPartial: !!sanitized.telefone_parcial,
          hasDDD: !!sanitized.ddd,
          fallbackType: phoneFallbackType,
          isWhatsApp: sanitized.telefone ? isValidWhatsAppTelefone(sanitized.telefone) : false
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

    const beforeSaida = sanitized.endereco_saida;
    const beforeDestino = sanitized.endereco_destino;

    if (!sanitized.endereco_saida) {
      const mSaida = joined.match(/\b(?:buscar|retirar|pegar|coletar)\s+(?:em|no|na|aqui|ali)?\s*([^|,.\n]{3,60})/i);
      if (mSaida && mSaida[1]) {
        const addr = mSaida[1].trim();
        // Proteção contra ruídos: não aceita se for APENAS palavra de ruído
        // Aceita informalidades válidas como "ali no parque", "centro", "mercado"
        if (addr && !isOnlyNoise(addr, RE_NOISE_ADDRESS)) {
          sanitized.endereco_saida = addr;
          
          // Log de endereço informal extraído via heurística
          try {
            const stepLog = require('./stepLog.js');
            stepLog.appendJSONL(perfil, 'ia_extract_addr_heuristic_informal', {
              chatId,
              campo: 'endereco_saida',
              valor: addr.slice(0, 50),
              metodo: 'heuristica_verbo'
            });
          } catch {}
        }
      }
    }

    if (!sanitized.endereco_destino) {
      // HEURÍSTICA BLINDADA: só extrai destino se tiver marcador de direção E não for item
      const mDest = joined.match(/\b(?:levar|entregar|para|pra|pro|at[eé]|no|na|ao|a)\s+(?:o|a|no|na|ali|lá|la)?\s*([^|,.\n]{3,60})/i);
      if (mDest && mDest[1]) {
        const addr = mDest[1].trim();
        // PROTEÇÃO CRÍTICA: nunca extrai item como destino
        if (addr && !looksLikeItem(addr) && !isOnlyNoise(addr, RE_NOISE_ADDRESS)) {
          // Verifica se há marcador de direção antes do endereço (segurança extra)
          const contextBefore = joined.slice(0, joined.indexOf(addr));
          if (isMarker(contextBefore) || /(?:levar|entregar|para|pra|pro|at[eé])\s+/i.test(contextBefore)) {
            sanitized.endereco_destino = addr;
            
            // Log de endereço informal extraído via heurística
            try {
              const stepLog = require('./stepLog.js');
              stepLog.appendJSONL(perfil, 'ia_extract_addr_heuristic_informal', {
                chatId,
                campo: 'endereco_destino',
                valor: addr.slice(0, 50),
                metodo: 'heuristica_verbo_blindado'
              });
            } catch {}
          }
        }
      }
    }

    const addrSet = (!!sanitized.endereco_saida && !beforeSaida) || (!!sanitized.endereco_destino && !beforeDestino);
    if (addrSet) {
      try {
        const stepLog = require('./stepLog.js');
        stepLog.appendJSONL(perfil, 'ia_extract_addr_heuristic', {
          chatId,
          set_saida: (!!sanitized.endereco_saida && !beforeSaida) || false,
          set_destino: (!!sanitized.endereco_destino && !beforeDestino) || false
        });
      } catch {}
    }
  } catch {}

  // Extração de tom e saudação do cliente (SEMPRE garante que estão presentes)
  const primeiraMsg = Array.isArray(mensagens) 
    ? mensagens.find(m => m && m.autor === 'cliente')?.texto || ''
    : '';
  
  // Garante que tom_cliente sempre está presente (nunca null)
  if (!sanitized.tom_cliente) {
    sanitized.tom_cliente = analyzeClientTone(primeiraMsg);
  }
  // Garante que tom_cliente nunca seja null (fallback para 'neutro')
  if (!sanitized.tom_cliente) {
    sanitized.tom_cliente = 'neutro';
  }
  
  // Garante que saudacao_cliente está extraída (pode ser null se não houver saudação)
  if (sanitized.saudacao_cliente === undefined) {
    sanitized.saudacao_cliente = extractClientGreeting(mensagens);
  }
  
  // Log quando extrai tom/saudação (SEMPRE loga para auditoria)
  try {
    const stepLog = require('./stepLog.js');
    stepLog.appendJSONL(perfil, 'ia_extract_tom_saudacao', {
      chatId,
      tom_cliente: sanitized.tom_cliente,
      saudacao_cliente: sanitized.saudacao_cliente ? sanitized.saudacao_cliente.slice(0, 50) : null,
      primeiraMsgPreview: primeiraMsg.slice(0, 50)
    });
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
  
  // Log de extração de endereços informais para auditoria (SEMPRE loga quando detecta informalidade)
  if (sanitized.endereco_saida || sanitized.endereco_destino) {
    try {
      const stepLog = require('./stepLog.js');
      const isInformal = (addr) => {
        if (!addr) return false;
        const a = String(addr).toLowerCase();
        // Endereços informais são curtos e não têm padrão rígido
        // Aceita: "ali no parque", "centro", "aqui perto do mercado", "kobrasol", etc
        return a.length < 50 && !/\d{4,5}-?\d{3}/.test(a) && !/rua\s+\w+\s+n[úu]mero/i.test(a);
      };
      
      const saidaInformal = isInformal(sanitized.endereco_saida);
      const destinoInformal = isInformal(sanitized.endereco_destino);
      
      if (saidaInformal || destinoInformal) {
        stepLog.appendJSONL(perfil, 'ia_extract_informal_address', {
          chatId,
          endereco_saida: sanitized.endereco_saida ? sanitized.endereco_saida.slice(0, 80) : null,
          endereco_destino: sanitized.endereco_destino ? sanitized.endereco_destino.slice(0, 80) : null,
          isInformal: true,
          saidaInformal: saidaInformal,
          destinoInformal: destinoInformal
        });
      }
    } catch {}
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

    // Fallback: usa texto da última mensagem do cliente como itens se não houver (com proteção contra ruídos)
    if (!sanitized.itens) {
      const lastClient = Array.isArray(mensagens) ? mensagens.slice().reverse().find(m => m && m.autor === 'cliente') : null;
      if (lastClient && lastClient.texto) {
        const texto = String(lastClient.texto).slice(0, 60);
        // Proteção: não usa se for APENAS ruído (mas aceita se tiver conteúdo válido)
        if (texto && !isOnlyNoise(texto, RE_NOISE_ITEM)) {
          sanitized.itens = texto;
          
          // Log quando usa fallback de item
          try {
            const stepLog = require('./stepLog.js');
            stepLog.appendJSONL(perfil, 'ia_extract_item_fallback', {
              chatId,
              item: texto.slice(0, 50),
              metodo: 'ultima_mensagem_cliente'
            });
          } catch {}
        }
      }
    }

  }

  if (!sanitized.cidade && contexto && contexto.cidade) sanitized.cidade = String(contexto.cidade);
  sanitized.missing = computeMissing(sanitized);
  return sanitized;
}

module.exports = { extractOrderFieldsLLM };
