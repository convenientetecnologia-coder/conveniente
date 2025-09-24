'use strict';

const fs = require('fs');
const path = require('path');

const DADOS_DIR  = path.join(__dirname, '..', 'dados');
const PERFIS_DIR = path.join(DADOS_DIR, 'perfis');
const MAX_ISSUES = parseInt(process.env.ISSUES_MAX || '200', 10);

// Somente os tipos abaixo são considerados ERROS de operação (Virtus/Robe)
const ERROR_TYPES = new Set([
  'browser_disconnected',
  'robe_error',
  'robe_no_photo',
  'virtus_blocked',
  'virtus_no_composer',
  'virtus_send_failed',
  'virtus_page_dead',
  'chrome_memory_spike',
  'cpu_memory_spike'
]);

function isErrorType(t) {
  try { return ERROR_TYPES.has(String(t || '')); } catch { return false; }
}

// IO helpers locais (atômicos e seguros)
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}
function getFilePath(nome) {
  const n = String(nome || '').trim();
  return path.join(PERFIS_DIR, n, 'issues.json');
}
function sanitizeMessage(msg) {
  try {
    let s = String(msg == null ? '' : msg);
    // Uma linha, sem quebras; trim e limite de tamanho
    s = s.replace(/[\r\n]+/g, ' ').trim();
    // Limite defensivo de 400 chars
    if (s.length > 400) s = s.slice(0, 400);
    return s;
  } catch {
    return '';
  }
}

// Serialização simples por conta para evitar corrida entre chamadas concorrentes
const _locks = new Map();
function _serialize(nome, fn) {
  const key = String(nome || '');
  const prev = _locks.get(key) || Promise.resolve();
  const next = prev.then(() => Promise.resolve(fn()).catch(()=>{}));
  _locks.set(key, next);
  return next;
}

// Tipos padronizados de issues
const ISSUE_TYPES_SET = new Set([
  'browser_disconnected',
  'robe_error',
  'robe_no_photo',
  'virtus_blocked',
  'virtus_no_composer',
  'virtus_send_failed',
  'virtus_page_dead',
  'chrome_memory_spike',
  'cpu_memory_spike',
  // Logs militares (ação/saúde de sistema - não contam como "erro" no painel principal)
  'mil_action',
  'mem_block_signup',
  'mem_block_activate',
  'open_rollback_memory',
  'light_enter',
  'light_exit',
  'nurse_kill',
  'nurse_restart'
]);

function padronizaType(type) {
  try {
    const t = String(type || '').trim();
    if (ISSUE_TYPES_SET.has(t)) return t;
    // fallback padrão se tipo não padronizado
    return 'misc';
  } catch {
    return 'misc';
  }
}

// API
function append(nome, type, message) {
  const file = getFilePath(nome);
  const entry = {
    ts: Date.now(),
    type: padronizaType(type),
    message: sanitizeMessage(message)
  };
  return _serialize(nome, () => {
    try {
      const arr = readJsonSafe(file, []);
      const list = Array.isArray(arr) ? arr : [];
      list.push(entry);
      if (list.length > MAX_ISSUES) {
        // mantêm apenas os últimos MAX_ISSUES
        list.splice(0, list.length - MAX_ISSUES);
      }
      const ok = writeJsonAtomic(file, list);
      return ok ? { ok: true, file, size: list.length, entry } :
        { ok: false, error: 'write failed', file };
    } catch (e) {
      return { ok: false, error: e && e.message || String(e), file };
    }
  });
}

function list(nome) {
  try {
    const file = getFilePath(nome);
    const arr = readJsonSafe(file, []);
    // Ordena pelo timestamp decrescente (mais novo no topo)
    const issuesArr = Array.isArray(arr) ? arr.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)) : [];
    return { ok: true, issues: issuesArr, file };
  } catch (e) {
    return { ok: false, issues: [], error: e && e.message || String(e) };
  }
}

function clear(nome) {
  const file = getFilePath(nome);
  return _serialize(nome, () => {
    try {
      const ok = writeJsonAtomic(file, []);
      return ok ? { ok: true, file } : { ok: false, error: 'write failed', file };
    } catch (e) {
      return { ok: false, error: e && e.message || String(e), file };
    }
  });
}

function count(nome) {
  try {
    const file = getFilePath(nome);
    const arr = readJsonSafe(file, []);
    return { ok: true, count: Array.isArray(arr) ? arr.length : 0, file };
  } catch (e) {
    return { ok: false, count: 0, error: e && e.message || String(e) };
  }
}

function countErrors(nome) {
  try {
    const file = getFilePath(nome);
    const arr = readJsonSafe(file, []);
    if (!Array.isArray(arr)) return { ok: true, count: 0, file };
    let n = 0;
    for (const it of arr) {
      const t = it && it.type ? String(it.type) : '';
      if (isErrorType(t)) n++;
    }
    return { ok: true, count: n, file };
  } catch (e) {
    return { ok: false, count: 0, error: e && e.message || String(e) };
  }
}

// Adicionei countActionable conforme solicitado
function countActionable(nome) {
  try {
    const file = getFilePath(nome);
    const arr = readJsonSafe(file, []);
    if (!Array.isArray(arr)) return { ok: true, count: 0, file };
    let n = 0;
    for (const it of arr) {
      const t = it && it.type ? String(it.type) : '';
      const m = it && it.message ? String(it.message) : '';
      if (isErrorType(t)) { n++; continue; }
      if (t === 'mil_action' && /frozen|blocked|mem_block|reopen|rollback|nurse|stuck|fail/i.test(m)) { n++; }
    }
    return { ok: true, count: n, file };
  } catch (e) {
    return { ok: false, count: 0, error: e && e.message || String(e) };
  }
}

module.exports = {
  append,
  list,
  clear,
  count,
  countErrors,
  countActionable,
  getFilePath
};