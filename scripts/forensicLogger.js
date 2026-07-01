// scripts/forensicLogger.js
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'dados');

function _safeMkdirp(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function _isoDayUtc(ts = Date.now()) {
  try {
    return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  } catch {
    return '1970-01-01';
  }
}

function getActiveForensicLogPath() {
  _safeMkdirp(DATA_DIR);
  const day = _isoDayUtc();
  return path.join(DATA_DIR, `forensic_edge_${day}.log`);
}

function rotateForensicLogs24h() {
  try {
    _safeMkdirp(DATA_DIR);
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    for (const ent of entries) {
      try {
        if (!ent || !ent.isFile || !ent.isFile()) continue;
        const name = String(ent.name || '');
        const lower = name.toLowerCase();
        // Segurança máxima: só rotaciona os logs forenses gerados por este módulo.
        // Não remove outros .log/.jsonl do diretório dados/ (podem conter evidências/produtivo).
        if (!(lower.startsWith('forensic_edge_') && (lower.endsWith('.log') || lower.endsWith('.jsonl')))) continue;
        const fp = path.join(DATA_DIR, name);
        const st = fs.statSync(fp);
        const m = Number(st && st.mtimeMs || 0) || 0;
        if (m > 0 && m < cutoff) {
          try { fs.unlinkSync(fp); } catch {}
        }
      } catch {}
    }
  } catch {}
}

function forensicLog(tag, msg, ctx) {
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      iso: new Date().toISOString(),
      tag: String(tag || '').slice(0, 48),
      msg: String(msg || '').slice(0, 1200),
      ctx: (ctx && typeof ctx === 'object') ? ctx : null
    }) + '\n';
    const fp = getActiveForensicLogPath();
    fs.appendFileSync(fp, line, 'utf8');
  } catch {
    // nunca quebrar produção por log
  }
}

module.exports = {
  forensicLog,
  rotateForensicLogs24h,
  getActiveForensicLogPath,
};

