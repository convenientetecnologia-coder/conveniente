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

function appendJSONL(perfil, flow, obj) {
  try {
    const file = fileFor(perfil, flow);
    const line = JSON.stringify({ ts: Date.now(), ...obj }) + '\n';
    fs.appendFileSync(file, line);
  } catch {}
}

function attemptId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

module.exports = { appendJSONL, attemptId };