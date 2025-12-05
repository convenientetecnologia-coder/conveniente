'use strict';

// scripts/inteligenciaArtificial.js
// Implementação única OpenAI GPT-5.1 para ciclo mestre de atendimento
// Função principal: masterExtractAnswer

const fetch = global.fetch || require('node-fetch');
const fs = require('fs');
const path = require('path');

const logger = require('./logger.js');
let issues = null;
try { issues = require('./issues.js'); } catch {}

// ========== HELPERS DE PERSISTÊNCIA ==========

function getStatePath(perfil, chatId) {
  return path.join(__dirname, '..', 'dados', 'perfis', String(perfil || ''), 'chats', `${String(chatId || '')}.state.json`);
}

function getLogPath(perfil, chatId) {
  return path.join(__dirname, '..', 'dados', 'perfis', String(perfil || ''), 'chats', `${String(chatId || '')}.master.jsonl`);
}

async function loadState(perfil, chatId) {
  try {
    const file = getStatePath(perfil, chatId);
    if (!fs.existsSync(file)) return {};
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveState(perfil, chatId, state) {
  try {
    const file = getStatePath(perfil, chatId);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try { fs.unlinkSync(file); } catch {}
    fs.renameSync(tmp, file);
  } catch (e) {
    try { logger.warn('[MASTER][STATE] save error', { perfil, chatId, error: (e && e.message) || e }); } catch {}
  }
}

function appendLog(perfil, chatId, entry) {
  try {
    const file = getLogPath(perfil, chatId);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch (e) {
    try { logger.warn('[MASTER][LOG] append error', { perfil, chatId, error: (e && e.message) || e }); } catch {}
  }
}

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
    const clientNorm = String(lastClientMsg).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const answerNorm = String(answer).normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    if (clientNorm.length < 10) return answer;
    if (answerNorm.includes(clientNorm) || clientNorm.includes(answerNorm)) {
      return answer; // NÃO retorne null, o fallback humana vai tratar caso necessário
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

    return { content: String(content).trim(), usage: data.usage || {} };
  } catch (e) {
    clearTimeout(t);
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
  const startTs = Date.now();
  let stateBefore = {};
  let stateAfter = {};

  try {
    stateBefore = await loadState(perfil, chatId);

    const historico = Array.isArray(mensagens) ? mensagens : [];
    const lastClientMsg = historico.filter(m => m.autor === 'cliente').slice(-1)[0]?.texto || null;

    let basePrompt = buildSystemPrompt(contexto || {});
    const forcedInjection = '\n\nATENÇÃO: Proibido repetir ou recapitular o que já foi entendido. Apenas pergunte o próximo campo faltante, sem mencionar os campos já informados. Se o cliente enviar DDD e parcial separados, junte internamente e avance para o próximo campo. Nunca peça dados já informados; pergunte somente o que falta. Você nunca deve dizer frases como "já anotei", "já registrei", "perfeito, já anotei", "já confirmei", "já foi", etc. Seja sempre objetivo e direto. Não use muletas tipo "perfeito", "certo", "ótimo" no início da resposta. Não ecoe, não recapitule. Dê sempre apenas a próxima pergunta.';

    const messages = buildMessages(historico, 30);

    if (!messages.length) {
      const result = {
        extraction: {},
        answer: null,
        control: { shouldReply: false, askField: null, finalMessage: false },
        meta: { confidence: 0.0, tokensUsed: 0, error: 'no_messages' }
      };
      appendLog(perfil, chatId, { ts: Date.now(), type: 'request', perfil, chatId, respond, messagesCount: 0, stateBefore, result, durationMs: Date.now() - startTs });
      return result;
    }

    let content = '';
    let usage = {};
    let result = null;
    let attempts = 0;
    let lastErr = null;
    for (attempts = 1; attempts <= 2; attempts++) {
      try {
        const sysPrompt = attempts === 1 ? basePrompt : (basePrompt + forcedInjection);
        const callStartTs = Date.now();
        const out = await callOpenAI(messages, sysPrompt, respond);
        content = out.content || '';
        usage = out.usage || {};
        if (!content || !String(content).trim()) throw new Error('openai_empty_response');
        result = parseResponse(content, lastClientMsg);
        break; // sucesso
      } catch (e) {
        lastErr = e;
        if (attempts === 2) {
          // manter último erro
        } else {
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    // Salva trace do ciclo (opcional, se desejado pode logar)
    stateAfter = Object.assign({}, stateBefore, {
      lastCallAt: Date.now(),
      lastExtraction: result && result.extraction || {},
      lastAnswer: result && result.answer || null,
      totalCalls: (stateBefore.totalCalls || 0) + 1
    });

    await saveState(perfil, chatId, stateAfter);

    // Pós-processamento determinístico (junção DDD + parcial + avanço)
    const prevExtraction = (stateBefore && stateBefore.lastExtraction)
      || (stateBefore && stateBefore.data && stateBefore.data.extraction)
      || {};
    const mergedExtraction = mergeWithPrevExtraction(prevExtraction, result ? result.extraction : {}, historico);

    let finalResult = result || {
      extraction: mergedExtraction,
      answer: null,
      control: { shouldReply: false, askField: null, finalMessage: false },
      meta: { confidence: 0.0, tokensUsed: 0 }
    };

    finalResult.extraction = mergedExtraction;

    const hasTel = isValidBRPhoneWithDDD(mergedExtraction.telefone);
    let askField = finalResult.control && typeof finalResult.control.askField !== 'undefined'
      ? finalResult.control.askField
      : null;
    const nextByState = chooseNextMissingField(mergedExtraction, prevExtraction);

    if (hasTel && askField === 'telefone') {
      askField = nextByState;
      finalResult.control.askField = askField;
      finalResult.control.shouldReply = true;
      finalResult.answer = buildAskTextFor(askField);
    }

    if (!finalResult.answer || !finalResult.control || finalResult.control.shouldReply === false) {
      const fieldToAsk = nextByState;
      if (fieldToAsk) {
        finalResult.answer = buildAskTextFor(fieldToAsk);
        finalResult.control = finalResult.control || {};
        finalResult.control.shouldReply = true;
        finalResult.control.askField = fieldToAsk;
      } else {
        finalResult.control = finalResult.control || {};
        finalResult.control.shouldReply = false;
      }
    }

    // Anti-redundância: se o modelo insistir em "já anotei / já registrei", trocamos pela próxima pergunta faltante
    try {
      const prevExtraction = (stateBefore && stateBefore.lastExtraction) || (stateBefore && stateBefore.data && stateBefore.data.extraction) || {};
      if (
        finalResult.answer &&
        /j[áa]\s+(anotei|registrei|notei|peguei|adicionei)/i.test(finalResult.answer)
      ) {
        const askField = chooseNextMissingField(finalResult.extraction, prevExtraction);
        if (askField) {
          finalResult.answer = buildAskTextFor(askField);
          finalResult.control = finalResult.control || {};
          finalResult.control.shouldReply = true;
          finalResult.control.askField = askField;
        }
      }
      // Também remove prefixos de muleta ("Perfeito", "Certo", "Ótimo") se existirem
      if (finalResult.answer) {
        finalResult.answer = String(finalResult.answer).replace(/^(perfeito|certo|ótimo|otimo)[,!.\s]+/i, '').trim();
      }
    } catch {}

    return finalResult;
  } catch (e) {
    const errorMsg = (e && e.message) || String(e);
    const result = {
      extraction: {},
      answer: 'Desculpa, não consegui entender direito sua última mensagem. Pode enviar novamente, por gentileza?',
      control: { shouldReply: true, askField: null, finalMessage: false },
      meta: { confidence: 0.0, tokensUsed: 0, error: errorMsg }
    };

    appendLog(perfil, chatId, { ts: Date.now(), type: 'error', perfil, chatId, respond, stateBefore, stateAfter, error: errorMsg, result, durationMs: Date.now() - startTs });

    if (issues && typeof issues.append === 'function') {
      try { await issues.append(perfil, 'master_error', `chat=${chatId} err=${errorMsg}`); } catch {}
    }

    try { logger.error('[MASTER] error', { perfil, chatId, error: errorMsg }); } catch {}

    // NUNCA propague erro para fora — sempre retorna resposta ao sistema.
    return result;
  }
}

module.exports = { masterExtractAnswer };
