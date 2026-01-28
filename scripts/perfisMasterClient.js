// scripts/perfisMasterClient.js
// Cliente IPC para mutações do perfis.json no processo master (clusterMaster).
// Objetivo: blindagem máxima — workers NUNCA escrevem perfis.json diretamente.

const logger = require('./logger.js');

const isChild = (process && process.env && process.env.IS_WORKER_CHILD === '1');

function newMsgId(){ return Math.random().toString(36).slice(2); }

function _sendIpc(type, payload, { timeoutMs = 12000 } = {}) {
  if (!isChild) return Promise.resolve({ ok: false, error: 'not_child' });
  return new Promise((resolve) => {
    const msgId = newMsgId();
    const onMsg = (m) => {
      if (m && m.replyTo === msgId) {
        try { process.off('message', onMsg); } catch {}
        resolve(m.data);
      }
    };
    try { process.on('message', onMsg); } catch {}
    try { process.send({ type, msgId, payload: payload || {} }); } catch (e) {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok: false, error: 'ipc_send_failed' });
      return;
    }
    setTimeout(() => {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, Math.max(2000, Number(timeoutMs || 0) || 12000));
  });
}

async function remove(nome, { reason = 'worker_remove', caller = 'worker' } = {}) {
  const n = String(nome || '').trim();
  if (!n) return { ok: false, error: 'missing_nome' };
  if (!isChild) return { ok: false, error: 'not_child' };
  const r = await _sendIpc('perfis:remove', { nome: n, reason: String(reason||'').slice(0, 140), caller: String(caller||'').slice(0, 80) });
  if (!r || r.ok === false) {
    try { logger.warn('[perfisMasterClient] remove failed', { nome: n, error: r && r.error }); } catch {}
  }
  return r;
}

async function upsert(perfil, { reason = 'worker_upsert', caller = 'worker' } = {}) {
  const p = (perfil && typeof perfil === 'object') ? perfil : null;
  const nome = p ? String(p.nome || '').trim() : '';
  if (!p || !nome) return { ok: false, error: 'invalid_perfil' };
  if (!isChild) return { ok: false, error: 'not_child' };
  const safePerfil = Object.assign({}, p);
  // Hard cap: evita payload gigante por acidente
  try { if (safePerfil.cookies && Array.isArray(safePerfil.cookies) && safePerfil.cookies.length > 0) delete safePerfil.cookies; } catch {}
  const r = await _sendIpc('perfis:upsert', { perfil: safePerfil, reason: String(reason||'').slice(0, 140), caller: String(caller||'').slice(0, 80) }, { timeoutMs: 15000 });
  if (!r || r.ok === false) {
    try { logger.warn('[perfisMasterClient] upsert failed', { nome, error: r && r.error }); } catch {}
  }
  return r;
}

async function patch(nome, patchObj, { reason = 'worker_patch', caller = 'worker' } = {}) {
  const n = String(nome || '').trim();
  const patch = (patchObj && typeof patchObj === 'object') ? patchObj : null;
  if (!n || !patch) return { ok: false, error: 'invalid_args' };
  if (!isChild) return { ok: false, error: 'not_child' };
  const r = await _sendIpc('perfis:patch', { nome: n, patch, reason: String(reason||'').slice(0, 140), caller: String(caller||'').slice(0, 80) }, { timeoutMs: 15000 });
  if (!r || r.ok === false) {
    try { logger.warn('[perfisMasterClient] patch failed', { nome: n, error: r && r.error }); } catch {}
  }
  return r;
}

module.exports = { remove, upsert, patch };

