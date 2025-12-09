// scripts/stepLog.js

'use strict';
const fs = require('fs');
const path = require('path');

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
function appendJSONL(perfil, flow, obj) {
  try {
    const file = fileFor(perfil, flow);
    capRotate(file);
    const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
    fs.appendFileSync(file, line);
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
 * 
 * Use esta função em qualquer ponto que for logar step/timer/preview/histórico/contexto potencialmente sensível.
 * 
 * @param {string} perfil - Nome do perfil
 * @param {string} flow - Nome do fluxo (ex: 'virtus', 'worker')
 * @param {object} obj - Objeto com os dados do log (será sanitizado automaticamente)
 */
function appendJSONLSafe(perfil, flow, obj) {
  // Antes de logar, sanitize "sample", "extra", etc.
  if ('sample' in obj && typeof obj.sample === 'string') obj.sample = sanitizePII(obj.sample);
  if ('extra' in obj && typeof obj.extra === 'string') obj.extra = sanitizePII(obj.extra);
  appendJSONL(perfil, flow, obj);
}

function attemptId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function audit(perfil, flow, level, event, extra) {
  try {
    appendJSONL(perfil, flow, { level: String(level||'info'), event: String(event||''), ...(extra||{}) });
  } catch {}
}

module.exports = { appendJSONL, appendJSONLSafe, attemptId, audit, sanitizePII };