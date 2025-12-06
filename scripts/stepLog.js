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

// Alterado conforme instrução: agora chama capRotate antes de gravar
function appendJSONL(perfil, flow, obj) {
  try {
    const file = fileFor(perfil, flow);
    capRotate(file);
    const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
    fs.appendFileSync(file, line);
  } catch {}
}

function attemptId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function audit(perfil, flow, level, tag, ctx = {}) {
  const payload = { ts: Date.now(), step: tag, ...ctx };
  try { appendJSONL(perfil, flow, payload); } catch {}
  try {
    const line = `[${flow.toUpperCase()}][${tag.toUpperCase()}] ` + 
      Object.entries({ perfil, ...ctx })
        .map(([k,v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v).slice(0,200)}`)
        .join(' ');
    if (level === 'error') require('./logger.js').error(line);
    else if (level === 'warn') require('./logger.js').warn(line);
    else if (level === 'debug') require('./logger.js').debug(line);
    else require('./logger.js').info(line);
  } catch {}
}

module.exports = { appendJSONL, attemptId, audit };