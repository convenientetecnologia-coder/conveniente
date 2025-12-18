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

module.exports = { appendJSONL, attemptId };