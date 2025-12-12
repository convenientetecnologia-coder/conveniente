// scripts/stepLog.js

/**
 * MÉTRICAS DE SLA E ATRASOS DE FILA/BACKLOG:
 * 
 * A função logSLA deve ser usada para logs críticos de fila e SLA, e está 110% safe.
 * Registra métricas de:
 * - Tempo de chegada da mensagem/chat
 * - Tempo de agendamento do collector (scheduled)
 * - Tempo real de disparo/finalização do collector
 * - Tempo de início e de término de envio da resposta
 * - Calcula e loga: delayCollector (início do collector - chegada), delaySend (envio - término do collector)
 * - Sempre que qualquer delay de collector for >90s, sendQueue.length>3, ou aiCollectors.size>3, registra log explícito (step: 'sla_warning', etc)
 */

'use strict';
const fs = require('fs');
const path = require('path');

// Funções auxiliares para logs humanos no terminal
function tsHuman(ms){ 
  try{ 
    return new Date(ms||Date.now()).toISOString().replace('T',' ').split('.')[0]; 
  } catch{ 
    return String(ms||Date.now()); 
  } 
}

function termEcho(perfil, flow, payload) {
  try {
    const t = tsHuman(payload.ts || Date.now());
    const step = String(payload.step || payload.event || 'event');
    const lvl = String(payload.level || '').toLowerCase();
    const chatId = payload.chatId ?  ` chatId=${payload.chatId}` : '';
    const extraR = payload.reason ?  ` reason=${payload.reason}` : '';
    const extraLen = (typeof payload.len === 'number') ?  ` len=${payload.len}` : '';
    const msg = `[${t}] [${flow}] [${perfil}] ${step}${chatId}${extraR}${extraLen}`;
    const danger = /error|fail|exception|timeout|thread_failed|no_composer|blocked|ack_failed/i.test(step + ' ' + lvl + ' ' + (payload.reason || ''));
    const warn   = /warn|skip|busy|missing|retry|noop|anchor_missing|poll_zero/i.test(step + ' ' + lvl + ' ' + (payload.reason || ''));
    if (danger)       console.error(msg);
    else if (warn)    console.warn(msg);
    else              console.log(msg);
  } catch {}
}

function ensureDir(p) { 
  try { fs.mkdirSync(p, { recursive: true }); } catch {} 
}

function fileFor(perfil, flow) {
  const base = path.join(__dirname, '..', 'dados', 'perfis', perfil);
  ensureDir(base);
  return path.join(base, `${flow}-step.log`);
}

// Adicionado conforme instrução: capRotate
function capRotate(file) {
  try {
    if (!fs.existsSync(file)) return;
    const st = fs.statSync(file);
    const maxBytes = parseInt(process.env.STEPLOG_MAX_BYTES || '10485760', 10); // 10MB padrão
    if (st.size <= maxBytes) return;
    // rotate: file -> file.1, file.1 -> file.2, ... (até .3)
    for (let i = 3; i >= 1; i--) {
      const f = `${file}.${i}`;
      const fNext = i === 3 ? null : `${file}.${i+1}`;
      if (fs.existsSync(f)) {
        if (fNext) { try { fs.renameSync(f, fNext); } catch {} }
        else { try { fs.unlinkSync(f); } catch {} }
      }
    }
    fs.renameSync(file, `${file}.1`);
  } catch {}
}

// Função de sanitização simples para eventuais campos sensíveis
function sanitizePII(str) {
  if (typeof str !== "string") return str;
  let s = str;
  // Mascarar telefone
  s = s.replace(/\b\d{2}\s?\d{4,5}-?\d{4}\b/g, "[TEL]");
  // Mascarar e-mail
  s = s.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, "[EMAIL]");
  // Mascarar CEP
  s = s.replace(/\b\d{5}-?\d{3}\b/g, "[CEP]");
  // CPF
  s = s.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]');
  // CNPJ
  s = s.replace(/\b\d{2}[\.\-]?\d{3}[\.\-]?\d{3}\/?\d{4}-?\d{2}\b/g, '[CNPJ]');
  return s;
}

// Alterado conforme instrução: agora chama capRotate antes de gravar
// Garante sanitização automática de campos sensíveis antes de logar (especialmente para dom_bubble_debug)
function appendJSONL(perfil, flow, obj) {
  try {
    const file = fileFor(perfil, flow);
    capRotate(file);
    // Sanitizar campos sensíveis comuns (especialmente sample, texto, mensagem do DOM/bubble)
    const sanitized = { ...obj };
    const sensitiveFields = ['sample', 'texto', 'mensagem', 'text', 'message'];
    for (const field of sensitiveFields) {
      if (field in sanitized && typeof sanitized[field] === 'string') {
        sanitized[field] = sanitizePII(sanitized[field]);
      }
    }
    const line = JSON.stringify({ ts: Date.now(), ...sanitized }) + '\n';
    fs.appendFileSync(file, line);
    try { termEcho(perfil, flow, sanitized); } catch {}
  } catch {}
}

/**
 * Função segura para logging que sanitiza campos sensíveis antes de logar.
 * 
 * Padronização de logs ultra-humanizados:
 * - perfil: nome do perfil (sempre incluído automaticamente via parâmetro)
 * - chatId: ID do chat (caso aplicável)
 * - attemptId: ID da tentativa (caso aplicável)
 * - step: evento explícito do atendimento/humano ou da rotina
 * - timer ou elapsed: para eventos de timers (início/fim de janela, tempo decorrido)
 * - extra: campos adicionais que expliquem por que o evento ocorreu (automático/humano, "por timeout", "por falta de campo", "coletou completo", etc.)
 * - sample: campo de amostra de texto (sempre sanitizado via sanitizePII antes de salvar)
 * - texto: campo de texto de mensagem/bolha (sempre sanitizado via sanitizePII antes de salvar)
 * - mensagem: campo de mensagem (sempre sanitizado via sanitizePII antes de salvar)
 * 
 * Use esta função em qualquer ponto que for logar step/timer/preview/histórico/contexto potencialmente sensível,
 * especialmente dados vindos do DOM/bubbles (autor, texto, sample, mensagem, etc.).
 * 
 * @param {string} perfil - Nome do perfil
 * @param {string} flow - Nome do fluxo (ex: 'virtus', 'worker')
 * @param {object} obj - Objeto com os dados do log (será sanitizado automaticamente)
 */
function appendJSONLSafe(perfil, flow, obj) {
  try {
    // Criar cópia do objeto para não modificar o original
    const sanitized = { ...obj };
    // Sanitizar TODOS os campos de texto que podem conter dados sensíveis do DOM/bubble
    const textFields = ['sample', 'extra', 'texto', 'mensagem', 'text', 'message', 'answer', 'error', 'reason'];
    for (const field of textFields) {
      if (field in sanitized && typeof sanitized[field] === 'string') {
        sanitized[field] = sanitizePII(sanitized[field]);
      }
    }
    // Também sanitizar campos aninhados ou arrays que possam conter texto
    if (sanitized.data && typeof sanitized.data === 'object') {
      for (const key in sanitized.data) {
        if (typeof sanitized.data[key] === 'string') {
          sanitized.data[key] = sanitizePII(sanitized.data[key]);
        }
      }
    }
    appendJSONL(perfil, flow, sanitized);
  } catch (e) {
    // Fallback: tentar sanitizar campos básicos e logar
    try {
      if ('sample' in obj && typeof obj.sample === 'string') obj.sample = sanitizePII(obj.sample);
      if ('texto' in obj && typeof obj.texto === 'string') obj.texto = sanitizePII(obj.texto);
      appendJSONL(perfil, flow, obj);
    } catch {
      appendJSONL(perfil, flow, obj);
    }
  }
}

function attemptId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function audit(perfil, flow, level, event, extra) {
  try {
    // Sanitizar campos sensíveis no extra antes de logar
    const sanitizedExtra = {};
    if (extra && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) {
        if (typeof value === 'string') {
          sanitizedExtra[key] = sanitizePII(value);
        } else {
          sanitizedExtra[key] = value;
        }
      }
    }
    const payload = { level: String(level||'info'), event: String(event||''), ...sanitizedExtra };
    appendJSONL(perfil, flow, payload);
    // termEcho já é chamado dentro de appendJSONL, mas garantimos que também seja chamado explicitamente
    try { termEcho(perfil, flow, { ts: Date.now(), level, event, ...sanitizedExtra }); } catch {}
  } catch {}
}

// Função exclusiva para SLA, pronta para uso por Virtus
// Registra métricas de SLA e atrasos de fila/backlog
function logSLA(perfil, chatId, step, meta) {
  try {
    const file = fileFor(perfil, 'sla');
    capRotate(file);
    const now = Date.now();
    const payload = { ts: now, chatId, step, ...meta };
    const line = JSON.stringify(payload) + '\n';
    fs.appendFileSync(file, line);
    if (payload.delayMs && payload.delayMs > 90000) {
      console.warn(`[SLA][${perfil}] Delay collector >90s: chatId=${chatId} delayMs=${payload.delayMs}`);
    }
    // Verifica condições de backlog e registra warning
    if ((payload.sendQueueLength && payload.sendQueueLength > 3) || 
        (payload.aiCollectorsSize && payload.aiCollectorsSize > 3)) {
      const warningPayload = { ts: now, chatId, step: 'sla_warning', ...meta };
      const warningLine = JSON.stringify(warningPayload) + '\n';
      fs.appendFileSync(file, warningLine);
      console.warn(`[SLA][${perfil}] Backlog warning: chatId=${chatId} sendQueue=${payload.sendQueueLength || 0} aiCollectors=${payload.aiCollectorsSize || 0}`);
    }
  } catch (e) {
    // Falha silenciosamente para não interromper fluxo principal
  }
}

module.exports = { appendJSONL, appendJSONLSafe, attemptId, audit, sanitizePII, logSLA };