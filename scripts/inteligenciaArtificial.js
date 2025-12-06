'use strict';

// scripts/inteligenciaArtificial.js
// Implementação única OpenAI GPT-5.1 para ciclo mestre de atendimento
// Função principal: masterExtractAnswer

const fetch = global.fetch || require('node-fetch');

const logger = require('./logger.js');
let issues = null;
try { issues = require('./issues.js'); } catch {}
// Funções de persistência removidas: loadState, saveState, appendLog não são mais usadas
// TODO estado relevante é mantido exclusivamente pelo chatStateStore (virtus.js)

// ========== VALIDAÇÃO E NORMALIZAÇÃO DE TELEFONE ==========

function isValidBRPhoneWithDDD(num) {
  try {
    const s = String(num || '').replace(/\D/g, '');
    if (s.length === 11) return /^[1-9]{2}9\d{8}$/.test(s);
    if (s.length === 10) return /^[1-9]{2}[2-9]\d{7}$/.test(s);
    return false;
  } catch {
    return false;
  }
}

// === INÍCIO: Funções de extração de telefone via regex/heurística (fallback militar) ===

function normalizeBrazilDigits(d) {
  try {
    let s = String(d || '').replace(/\D/g, '');
    if (!s) return '';
    if (s.startsWith('55') && s.length > 11) s = s.slice(2);
    if (s.length > 13) s = s.slice(-11);
    return s;
  } catch { return ''; }
}

function classifyPhoneDigits(d) {
  const s = normalizeBrazilDigits(d);
  if (!s) return null;
  if (/^[1-9]{2}$/.test(s)) return { kind: 'ddd', value: s };
  if (/^\d{8,9}$/.test(s)) return { kind: 'partial', value: s };
  if (isValidBRPhoneWithDDD(s)) return { kind: 'full', value: s };
  return null;
}

function extractPhoneCandidatesFromText(text) {
  try {
    const s = String(text || '');
    const hits = s.match(/(\+?\d[\d\s().-]{7,})/g) || [];
    const candidates = new Set();
    for (const seg of hits) {
      const digits = seg.replace(/\D/g, '');
      if (digits && digits.length >= 8 && digits.length <= 14) {
        candidates.add(digits);
      }
    }
    // Se a mensagem for só dígitos sem espaços e tiver tamanho plausível, captura também
    const onlyDigits = s.replace(/\D/g, '');
    if (onlyDigits && onlyDigits.length >= 8 && onlyDigits.length <= 14) {
      candidates.add(onlyDigits);
    }
    return Array.from(candidates);
  } catch {
    return [];
  }
}

function findLatestFullPhoneFromMessages(historico) {
  try {
    const arr = Array.isArray(historico) ? historico.slice().reverse() : [];
    for (const m of arr) {
      if (!m || m.autor !== 'cliente' || !m.texto) continue;
      const candidates = extractPhoneCandidatesFromText(m.texto);
      for (const c of candidates) {
        const cls = classifyPhoneDigits(c);
        if (cls && cls.kind === 'full') return cls.value;
      }
    }
  } catch {}
  return null;
}

function findLatestPartialAndDDDFromMessages(historico) {
  const res = { ddd: null, parcial: null };
  try {
    const arr = Array.isArray(historico) ? historico.slice().reverse() : [];
    for (const m of arr) {
      if (!m || m.autor !== 'cliente' || !m.texto) continue;
      const candidates = extractPhoneCandidatesFromText(m.texto);
      for (const c of candidates) {
        const cls = classifyPhoneDigits(c);
        if (!cls) continue;
        if (cls.kind === 'ddd' && !res.ddd) res.ddd = cls.value;
        if (cls.kind === 'partial' && !res.parcial) res.parcial = cls.value;
        if (res.ddd && res.parcial) return res;
      }
    }
  } catch {}
  return res;
}
// === FIM: Funções de extração de telefone via regex/heurística ===

function combinePhoneParts(ddd, parcial) {
  try {
    const d = String(ddd || '').replace(/\D/g, '');
    const p = String(parcial || '').replace(/\D/g, '');
    if (!d || !p) return null;
    const full = d + p;
    return isValidBRPhoneWithDDD(full) ? full : null;
  } catch { return null; }
}

function findLatestDDDFromMessages(historico) {
  try {
    const arr = Array.isArray(historico) ? historico.slice().reverse() : [];
    for (const m of arr) {
      if (!m || m.autor !== 'cliente' || !m.texto) continue;
      const t = String(m.texto).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      // Padrões: "48", "(48)", "ddd 48"
      let mm = t.match(/\b(?:ddd\s*)?\(?([1-9]{2})\)?\b/);
      if (mm && mm[1]) return mm[1];
    }
  } catch {}
  return null;
}

function mergeWithPrevExtraction(prev, cur, historico) {
  const out = Object.assign({}, cur || {});
  const prevSafe = Object.assign({}, prev || {});

  // Herdar DDD/Parcial anteriores
  if (!out.ddd) {
    const heur = findLatestDDDFromMessages(historico);
    if (heur) out.ddd = heur;
  }
  if (!out.ddd && prevSafe.ddd) out.ddd = prevSafe.ddd;
  if (!out.telefone_parcial && prevSafe.telefone_parcial) out.telefone_parcial = prevSafe.telefone_parcial;

  // 1) Se já temos telefone válido, só complete ddd/parcial se faltar
  if (out.telefone && isValidBRPhoneWithDDD(out.telefone)) {
    out.ddd = out.ddd || out.telefone.slice(0,2);
    out.telefone_parcial = out.telefone_parcial || out.telefone.slice(2);
    return out;
  }

  // 2) Tentar combinar DDD + parcial do estado atual/anterior
  if (!out.telefone) {
    const d1 = out.ddd || prevSafe.ddd || null;
    const p1 = out.telefone_parcial || prevSafe.telefone_parcial || null;
    if (d1 && p1) {
      const full = String(d1).replace(/\D/g, '') + String(p1).replace(/\D/g, '');
      if (isValidBRPhoneWithDDD(full)) {
        out.telefone = full;
        out.ddd = full.slice(0,2);
        out.telefone_parcial = full.slice(2);
        return out;
      }
    }
  }

  // 3) Fallback militar: procurar telefone COMPLETO no histórico (últimas mensagens do cliente)
  if (!out.telefone) {
    const fromHistFull = findLatestFullPhoneFromMessages(historico);
    if (fromHistFull && isValidBRPhoneWithDDD(fromHistFull)) {
      out.telefone = fromHistFull;
      out.ddd = out.ddd || fromHistFull.slice(0,2);
      out.telefone_parcial = out.telefone_parcial || fromHistFull.slice(2);
      return out;
    }
  }

  // 4) Fallback secundário: capturar parcial e/ou DDD dispersos no histórico e tentar combinar
  if (!out.telefone) {
    const partialPack = findLatestPartialAndDDDFromMessages(historico);
    const d = out.ddd || partialPack.ddd || prevSafe.ddd || null;
    const p = out.telefone_parcial || partialPack.parcial || prevSafe.telefone_parcial || null;

    if (d && p) {
      const full = String(d).replace(/\D/g, '') + String(p).replace(/\D/g, '');
      if (isValidBRPhoneWithDDD(full)) {
        out.telefone = full;
        out.ddd = full.slice(0,2);
        out.telefone_parcial = full.slice(2);
        return out;
      }
    }
    if (!out.ddd && partialPack.ddd) out.ddd = partialPack.ddd;
    if (!out.telefone_parcial && partialPack.parcial) out.telefone_parcial = partialPack.parcial;
  }

  return out;
}

function chooseNextMissingField(extraction, prev = {}) {
  const ext = extraction || {};
  const agg = {
    telefone: ext.telefone || prev.telefone || null,
    item: ext.item || prev.item || null,
    endereco_saida: ext.endereco_saida || prev.endereco_saida || null,
    endereco_destino: ext.endereco_destino || prev.endereco_destino || null
  };
  if (!isValidBRPhoneWithDDD(agg.telefone)) return 'telefone';
  if (!agg.item) return 'item';
  if (!agg.endereco_saida) return 'endereco_saida';
  if (!agg.endereco_destino) return 'endereco_destino';
  return null;
}

function buildAskTextFor(field) {
  if (field === 'telefone') {
    return 'Pode enviar o WhatsApp completo com DDD (apenas números)?';
  }
  if (field === 'item') {
    return 'O que você deseja transportar?';
  }
  if (field === 'endereco_saida') {
    return 'Qual é o endereço completo de onde o item será retirado?';
  }
  if (field === 'endereco_destino') {
    return 'E qual é o endereço completo de destino?';
  }
  return 'Pode detalhar um pouco mais, por favor?';
}

function normalizePhoneExtraction(raw) {
  // Somente campos permitidos: telefone, ddd, telefone_parcial, item, endereco_saida, endereco_destino
  // NUNCA inclua ajudante, missing, descricao, obs, itens (apenas singular "item")
  // Caso raw.itens venha, use apenas se raw.item não vier
  const out = {
    telefone: null,
    ddd: null,
    telefone_parcial: null,
    item: (raw.item || (raw.itens && !raw.item ? raw.itens : null) || null),
    endereco_saida: raw.endereco_saida || null,
    endereco_destino: raw.endereco_destino || null
  };

  // Aliases comuns
  const aliasTel = raw.whatsapp || raw.celular || raw.telefone || null;
  let tel = String(aliasTel || '').toString().replace(/\D/g, '');
  let ddd = (raw.ddd || '').toString().replace(/\D/g, '');
  let parcial = (raw.telefone_parcial || '').toString().replace(/\D/g, '');

  if (tel) {
    if (isValidBRPhoneWithDDD(tel)) {
      // Telefone completo OK
    } else {
      if (tel.length === 8 || tel.length === 9) {
        parcial = tel;
      }
      tel = '';
    }
  }

  if (!tel && ddd && parcial) {
    const combined = ddd + parcial;
    if (isValidBRPhoneWithDDD(combined)) {
      tel = combined;
    }
  }

  if (!isValidBRPhoneWithDDD(tel)) {
    tel = '';
  }

  if (tel) {
    out.telefone = tel;
    out.ddd = ddd || tel.slice(0, 2);
    out.telefone_parcial = tel.slice(2);
  } else {
    out.telefone = null;
    out.ddd = ddd || null;
    out.telefone_parcial = parcial || null;
  }

  return out;
}

// ========== SANITIZAÇÃO DE SEGREDOS ==========

function sanitizeSecrets(text) {
  try {
    let s = String(text || '');
    s = s.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]');
    s = s.replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]');
    return s;
  } catch {
    return String(text || '');
  }
}

// ========== BLINDAGEM CONTRA PROMPT INJECTION E ECO ==========

function detectPromptInjection(text) {
  try {
    const s = String(text || '').toLowerCase();
    const patterns = [
      /ignore\s+(previous|all|above|instructions)/i,
      /forget\s+(everything|all|previous)/i,
      /you\s+are\s+now/i,
      /system\s*:?\s*you/i,
      /assistant\s*:?\s*you/i,
      /role\s*:?\s*(system|assistant)/i,
      /act\s+as\s+if/i,
      /pretend\s+to\s+be/i
    ];
    return patterns.some(rx => rx.test(s));
  } catch {
    return false;
  }
}

function preventEcho(lastClientMsg, answer) {
  try {
    if (!lastClientMsg || !answer) return answer;

    const clean = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().toLowerCase();

    const a = clean(answer), c = clean(lastClientMsg);

    if (!c) return answer;

    // similaridade simples por inclusão e tamanho
    const includes = a.includes(c) || c.includes(a);
    const lenClose = Math.abs(a.length - c.length) <= 6;

    if (includes && (c.length <= 50) && lenClose) {
      // força pergunta direta do próximo campo
      return null;
    }

    return answer;
  } catch {
    return answer;
  }
}

// ========== CONSTRUÇÃO DE PROMPTS ==========

const { promptFretes } = require('./promptFretes.js');

function buildSystemPrompt(contexto = {}) {
  const header = promptFretes.trim();
  const jsonSpec = `
FORMATO DE RESPOSTA OBRIGATÓRIO (JSON):
{
  "extraction": {
    "telefone": "string|null",
    "ddd": "string|null",
    "telefone_parcial": "string|null",
    "item": "string|null",
    "endereco_saida": "string|null",
    "endereco_destino": "string|null"
  },
  "answer": "string|null",
  "control": {
    "shouldReply": true|false,
    "askField": "telefone|item|endereco_saida|endereco_destino|null",
    "finalMessage": true|false
  },
  "meta": {
    "confidence": 0.0-1.0,
    "tokensUsed": number
  }
}

REGRAS CRÍTICAS:

Primeira resposta ao cliente DEVE afirmar explicitamente: "eu apenas anoto o pedido e quem informa valores é o motorista pelo WhatsApp".

NUNCA cite cidade, UF, nome do perfil, nome da loja ou local do atendimento nas respostas, mesmo que o cliente mencione ou o contexto venha do sistema.

DDD é obrigatório: nunca preencha "telefone" se não for DDD+corpo validado (10 ou 11 dígitos). Se receber apenas telefone parcial (8 ou 9 dígitos), preencha "telefone_parcial" e mantenha "telefone" = null. Só peça DDD se tiver parcial.

Se receber WhatsApp completo (10 ou 11 dígitos com DDD validado), inicie uma janela de 10 minutos para coletar o que faltar (item, saída, destino); avance campo a campo, um por vez.

Se receber apenas DDD ou telefone parcial, preencha "ddd" e "telefone_parcial"; mantenha "telefone" = null até ter ambos validados.

Quando faltar somente WhatsApp (com DDD), peça APENAS o WhatsApp (não reabra campos já coletados).

Se o WhatsApp foi coletado (com DDD validado) e o tempo (10min) expirou sem todos os campos, finalize marcando faltantes como "não informado" (control.finalMessage=true).

A mensagem final de fechamento é enviada AUTOMATICAMENTE pelo sistema backend, não por você. NUNCA envie mensagem de fechamento, agradecimento final ou convite para seguir no Instagram.

Não ecoe literalmente a última mensagem do cliente na resposta (anti-eco).

Responda APENAS com o JSON válido, sem explicações adicionais.`;

  return [header, jsonSpec].join('\n\n');
}

function buildMessages(historico = [], maxMessages = 30) {
  try {
    const arr = Array.isArray(historico) ? historico : [];
    const recent = arr.slice(-maxMessages);
    const messages = [];
    for (const m of recent) {
      const role = (m.autor === 'ia' || m.autor === 'assistant') ? 'assistant' : 'user';
      const content = sanitizeSecrets(String(m.texto || ''));
      if (!content.trim()) continue;
      if (detectPromptInjection(content)) continue;
      messages.push({ role, content });
    }
    return messages;
  } catch {
    return [];
  }
}

// ========== CHAMADA OPENAI ==========

async function callOpenAI(messages, systemPrompt, respond) {
  const apiKey = process.env.OPENAI_API_KEY;
  const apiUrl = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
  const model = process.env.OPENAI_MODEL_MASTER || 'gpt-5.1';

  if (!apiKey) throw new Error('OPENAI_API_KEY ausente');

  const allMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  const params = {
    model,
    messages: allMessages,
    temperature: respond ? 0.6 : 0.0,
    top_p: respond ? 0.9 : 1.0,
    max_completion_tokens: respond ? 900 : 1200,
    response_format: { type: 'json_object' }
  };

  console.log(`[IA][HTTP][POST] model=${model} messages=${allMessages.length} timeout=30000ms`);

  const Controller = global.AbortController || require('node-abort-controller');
  const controller = new Controller();
  const timeoutMs = 30000;
  const t = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(params),
      signal: controller.signal
    });

    clearTimeout(t);

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`OpenAI HTTP ${resp.status}: ${text.substring(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';

    if (!content || !String(content).trim()) throw new Error('openai_empty_response');

    const usage = data.usage || {};
    console.log(`[IA][HTTP][OK] tokens_prompt=${usage.prompt_tokens||0} tokens_completion=${usage.completion_tokens||0}`);

    return { content: String(content).trim(), usage };
  } catch (e) {
    clearTimeout(t);
    console.log(`[IA][HTTP][ERR] ${e && e.message || String(e)}`);
    throw e;
  }
}

// ========== PARSING E VALIDAÇÃO DE RESPOSTA ==========

function parseResponse(rawContent, lastClientMsg) {
  try {
    let parsed = null;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('no_json_found');
      }
    }

    const rawExtraction = parsed.extraction || {};
    let answer = parsed.answer || null;
    const control = parsed.control || {};
    const meta = parsed.meta || {};

    if (answer && lastClientMsg) {
      answer = preventEcho(lastClientMsg, answer);
    }

    if (answer && typeof answer !== 'string') answer = null;
    if (answer) answer = answer.trim() || null;

    // Se o resultado do anti-eco (answer) for null, então imediatamente retorne a próxima pergunta pendente pelo campo faltante
    if (!answer) {
      const normalized = normalizePhoneExtraction(rawExtraction);
      const fieldToAsk = chooseNextMissingField(normalized, {});
      if (fieldToAsk) {
        answer = buildAskTextFor(fieldToAsk);
      }
    }

    const normalized = normalizePhoneExtraction(rawExtraction);

    // Retorno padronizado: ajuste askField para nunca ser "itens", sempre "item"
    let askField = control.askField || null;
    if (askField === 'itens') {
      askField = 'item';
    }
    // Garantir que askField seja apenas um dos campos permitidos
    const allowedFields = ['telefone', 'item', 'endereco_saida', 'endereco_destino', null];
    if (askField && !allowedFields.includes(askField)) {
      askField = null;
    }

    return {
      extraction: normalized,
      answer,
      control: {
        shouldReply: !!answer,
        askField: askField,
        finalMessage: control.finalMessage === true
      },
      meta: {
        confidence: typeof meta.confidence === 'number' ? Math.max(0, Math.min(1, meta.confidence)) : 0.8,
        tokensUsed: typeof meta.tokensUsed === 'number' ? meta.tokensUsed : 0
      }
    };
  } catch (e) {
    return {
      extraction: {},
      answer: null,
      control: { shouldReply: false, askField: null, finalMessage: false },
      meta: { confidence: 0.0, tokensUsed: 0, error: (e && e.message) || String(e) }
    };
  }
}

// ========== FUNÇÃO PRINCIPAL ==========

async function masterExtractAnswer({ perfil, chatId, mensagens, contexto, respond = false }) {
  try {
    const historico = Array.isArray(mensagens) ? mensagens : [];
    const lastClientMsg = historico.filter(m => m.autor === 'cliente').slice(-1)[0]?.texto || null;

    const sysPrompt = buildSystemPrompt(contexto || {});
    const messages = buildMessages(historico, 30);

    if (!messages.length) {
      return {
        extraction: {},
        answer: null,
        control: { shouldReply: false, askField: null, finalMessage: false },
        meta: { confidence: 0.0, tokensUsed: 0, error: 'no_messages' }
      };
    }

    try {
      console.log(`[IA][CALL_START] perfil=${perfil} chat=${chatId} mensagens=${messages.length}`);
      const out = await callOpenAI(messages, sysPrompt, respond);
      const result = parseResponse(out.content || '', lastClientMsg);
      
      const summary = result
        ? `askField=${result?.control?.askField||null} shouldReply=${!!result?.control?.shouldReply} answer=${String(result.answer||'').slice(0,40)}`
        : '(parse fail)';
      console.log(`[IA][CALL_END] perfil=${perfil} chat=${chatId} ${summary}`);
      
      return result;
    } catch (e) {
      console.log(`[IA][HTTP][ERR] ${e && e.message || String(e)}`);
      return {
        extraction: {},
        answer: 'Desculpa, não consegui entender direito sua última mensagem. Pode enviar novamente, por gentileza?',
        control: { shouldReply: true, askField: null, finalMessage: false },
        meta: { confidence: 0.0, tokensUsed: 0, error: (e && e.message) || String(e) }
      };
    }
  } catch (e) {
    return {
      extraction: {},
      answer: 'Desculpa, não consegui entender direito sua última mensagem. Pode enviar novamente, por gentileza?',
      control: { shouldReply: true, askField: null, finalMessage: false },
      meta: { confidence: 0.0, tokensUsed: 0, error: (e && e.message) || String(e) }
    };
  }
}

module.exports = { masterExtractAnswer };
