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

function normalizePhoneExtraction(raw) {
  const out = {
    telefone: null,
    ddd: null,
    telefone_parcial: null,
    item: (raw.item || raw.itens || null),
    endereco_saida: raw.endereco_saida || null,
    endereco_destino: raw.endereco_destino || null
  };

  let tel = (raw.telefone || '').toString().replace(/\D/g, '');
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

    return {
      extraction: normalized,
      answer,
      control: {
        shouldReply: !!answer,
        askField: (control.askField === 'itens') ? 'item' : (control.askField || null),
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

    const systemPrompt = buildSystemPrompt(contexto || {});
    const messages = buildMessages(historico, 30);

    if (!messages.length) {
      const result = {
        extraction: {},
        answer: null,
        control: { shouldReply: false, askField: null, finalMessage: false },
        meta: { confidence: 0.0, tokensUsed: 0, error: 'no_messages' }
      };
      const DEBUG_MASTER = process.env.AI_DEBUG_MASTER === '1';
      if (respond || DEBUG_MASTER) {
        appendLog(perfil, chatId, {
          ts: Date.now(),
          type: 'request',
          perfil,
          chatId,
          respond,
          messagesCount: 0,
          stateBefore,
          result,
          durationMs: Date.now() - startTs
        });
      }
      return result;
    }

    const { content, usage } = await callOpenAI(messages, systemPrompt, respond);
    const result = parseResponse(content, lastClientMsg);

    stateAfter = Object.assign({}, stateBefore, {
      lastCallAt: Date.now(),
      lastExtraction: result.extraction,
      lastAnswer: result.answer,
      totalCalls: (stateBefore.totalCalls || 0) + 1
    });

    await saveState(perfil, chatId, stateAfter);

    const DEBUG_MASTER = process.env.AI_DEBUG_MASTER === '1';
    if (respond || DEBUG_MASTER) {
      appendLog(perfil, chatId, {
        ts: Date.now(),
        type: 'request',
        perfil,
        chatId,
        respond,
        messagesCount: messages.length,
        systemPromptLength: systemPrompt.length,
        requestTokens: usage.prompt_tokens || 0,
        responseTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        stateBefore,
        stateAfter,
        rawResponse: content,
        result,
        durationMs: Date.now() - startTs
      });
    }

    if (issues && typeof issues.append === 'function') {
      try {
        await issues.append(perfil, 'master_call', `chat=${chatId} tokens=${usage.total_tokens || 0} respond=${respond}`);
      } catch {}
    }

    return result;

  } catch (e) {
    const errorMsg = (e && e.message) || String(e);
    const result = {
      extraction: {},
      answer: null,
      control: { shouldReply: false, askField: null, finalMessage: false },
      meta: { confidence: 0.0, tokensUsed: 0, error: errorMsg }
    };

    appendLog(perfil, chatId, {
      ts: Date.now(),
      type: 'error',
      perfil,
      chatId,
      respond,
      stateBefore,
      stateAfter,
      error: errorMsg,
      result,
      durationMs: Date.now() - startTs
    });

    if (issues && typeof issues.append === 'function') {
      try {
        await issues.append(perfil, 'master_error', `chat=${chatId} err=${errorMsg}`);
      } catch {}
    }

    try { logger.error('[MASTER] error', { perfil, chatId, error: errorMsg }); } catch {}

    throw e;
  }
}

module.exports = { masterExtractAnswer };
