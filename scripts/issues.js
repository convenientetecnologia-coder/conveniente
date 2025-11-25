// issues.js

'use strict';

const fs = require('fs');
const path = require('path');

const DADOS_DIR  = path.join(__dirname, '..', 'dados');
const PERFIS_DIR = path.join(DADOS_DIR, 'perfis');
const MAX_ISSUES = parseInt(process.env.ISSUES_MAX || '200', 10);

// Bufferização para I/O otimizado (flush em bloco a cada 80ms)
const _buffers = new Map(); // file -> array de entries
let _flushTimer = null;

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    const entries = Array.from(_buffers.entries());
    _buffers.clear();
    _flushTimer = null;
    for (const [file, list] of entries) {
      try {
        // Lê o arquivo existente, adiciona novos entries, aplica limite MAX_ISSUES
        const arr = readJsonSafe(file, []);
        const existingList = Array.isArray(arr) ? arr : [];
        existingList.push(...list);
        // Mantém apenas os últimos MAX_ISSUES
        if (existingList.length > MAX_ISSUES) {
          existingList.splice(0, existingList.length - MAX_ISSUES);
        }
        // Escreve atomicamente
        const ok = writeJsonAtomic(file, existingList);
        if (!ok) {
          // Fallback: tente registrar em issues_fallback.log global (append-only)
          try {
            const fbFile = path.join(DADOS_DIR, 'issues_fallback.log');
            for (const entry of list) {
              fs.appendFileSync(fbFile, `[${path.basename(path.dirname(file))}] ${JSON.stringify(entry)}\n`);
            }
          } catch {}
        }
      } catch (e) {
        // Fallback em caso de erro
        try {
          const fbFile = path.join(DADOS_DIR, 'issues_fallback.log');
          for (const entry of list) {
            fs.appendFileSync(fbFile, `[${path.basename(path.dirname(file))}] ${JSON.stringify({fail: true, error: e && e.message || String(e), ...entry})}\n`);
          }
        } catch {}
      }
    }
  }, 80);
}

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
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      fs.fsyncSync(fd); // **militar: flush garantido no disco**
    } finally {
      fs.closeSync(fd);
    }
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch { fs.copyFileSync(tmp, file); try { fs.unlinkSync(tmp); } catch {} }
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
  const next = prev.then(() => Promise.resolve(fn()))
                   .finally(() => { if (_locks.get(key) === next) _locks.delete(key); });
  _locks.set(key, next);
  return next;
}

// Tipos especiais de issues (telemetria ultra-cirúrgica para controle de fotos):
// - photo_pick: Uma foto foi selecionada para uma conta
// - photo_attempt: Houve tentativa de postagem
// - photo_posted: A foto foi marcada como usada/postada
// - photo_ban: Foto banida para conta após tentativa falha ou erro
// - photo_delete: Deleção física e lógica de uma foto
// - photo_skip_banned: Foto pulada para conta devido a banimento persistente
// - photo_gc: Evento relacionado à limpeza automática (GC) do index

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
  'nurse_restart',
  'admin_activate_request', 'admin_deactivate_request', 'admin_configure_request', 'admin_start_work_request',
  'admin_invoke_human_request', 'admin_robe_play_request', 'admin_robe24h_request', 'admin_human_resume_request',
  'admin_rename_label', 'admin_rename_slug', 'admin_delete_perfil', 'admin_unfreeze', 'admin_unfreeze_all',

  // TIPOS MILITARES SWAP/OPEN/RELOAD
  'swap_kill',
  'swap_open_success',
  'swap_open_failed',
  'swap_open_failed_nenhum_sucesso',
  'open_backoff',
  'virtus_reload_per_idle2h',
  'virtus_reload_idle2h',
  'virtus_reload_fired',
  'virtus_reload_skip_held',

  // USO DE FOTOS: logs cirúrgicos para garantir rastreio e auditoria
  'photo_pick',
  'photo_attempt',
  'photo_posted',
  'photo_ban',
  'photo_delete',
  'photo_skip_banned',
  'photo_gc',
  // Novos tipos — evento tipado de login/ban
  'login_required_detected',
  'login_required_cleared',
  'account_banned_detected',
  'account_banned_cleared',
  // [NOVOS TIPOS] Pedidas de WhatsApp e composição de telefone (telemetria tipada)
  'phone_ask_price_intent',
  'phone_ask_ddd_isolado',
  'phone_ask_parcial_numero',
  'phone_ask_reminder',
  'phone_compose_ok'
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

// Padronização dos tipos conforme instrução
function prefixType(type, message) {
  let t = String(type || '').trim();

  // Already has prefix
  if (t.startsWith('suspect_') || t.startsWith('action_')) {
    return t;
  }

  // TIPOS MILITARES SWAP/OPEN/RELOAD — NÃO PREFIXAR, já estão militarizados
  if (
    t.startsWith('swap_') ||
    t.startsWith('virtus_reload') ||
    t === 'open_backoff'
  ) {
    // Não precisa prefixar, já está militarizado
    return t;
  }

  // Cases that must be action_
  if (
    t.startsWith('nurse_kill') ||
    t.startsWith('nurse_restart') ||
    t.startsWith('block_detected') ||
    t.startsWith('light_enter') ||
    t.startsWith('light_exit') ||
    t.startsWith('open_rollback_memory') ||
    t.startsWith('mem_block_signup') ||
    t.startsWith('mem_block_activate') ||
    t.startsWith('admin_')
  ) {
    return 'action_' + t;
  }

  // Suspect indicators (zumbi, bloqueio, etc)
  const suspectKeywords = ['no_pages', 'page_zumbi', 'messenger_block', 'fb_block', 'page_invisivel', 'autoban'];
  for (const kw of suspectKeywords) {
    if (t.indexOf(kw) >= 0) {
      if (
        /aviso|warn|suspect|suspeita|alert/i.test(message || t)
      ) {
        return 'suspect_' + t;
      } else {
        return 'action_' + t;
      }
    }
  }

  // Fallback: se não reconhecido, devolve o original padronizado ou misc.
  return t;
}

// API
function append(nome, type, message) {
  // FUTURO: suportar append estruturado para event stream com correlationId
  const file = getFilePath(nome);

  // Padronização militar conforme instrução (annotation ENRIQUECIMENTO)
  const origType = type;
  const enrichedType = prefixType(type, message);

  const entry = {
    ts: Date.now(),
    type: padronizaType(enrichedType),
    message: sanitizeMessage(message),
    context: {
      hostname: (() => { try { return require('os').hostname(); } catch { return ''; } })(),
      pid: process.pid,
      file: getFilePath(nome),
      name: nome,
      logType: padronizaType(enrichedType),
      message: sanitizeMessage(message),
      localTs: new Date().toISOString()
    }
  };

  // Bufferiza:
  const cur = _buffers.get(file) || [];
  cur.push(entry);
  _buffers.set(file, cur);
  scheduleFlush();
  return { ok: true, file };
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

// ATENÇÃO: clear deve ser chamado SOMENTE via issues.clear. Não escreva issues.json diretamente!
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

// Exportado: use sempre issues.clear(nome) para zerar issues com lock. Não sobrescreva issues.json manualmente fora deste módulo!
module.exports = {
  append,
  list,
  clear,
  count,
  countErrors,
  getFilePath
};