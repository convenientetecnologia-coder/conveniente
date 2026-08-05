'use strict';

/**
 * Limpeza diária de contas TERMINAIS (ban / 2FA / captcha / checkpoint / ID Virtus / MKT).
 * Acionada pelo terminalAccountCleanupScheduler (config própria no servidor).
 * NÃO acoplada a renovar/fechar/abrir. NÃO deve ser chamada pelo botão Abrir tudo.
 *
 * Allowlist positiva (DELETE) filtrada por terminalAccountCleanup.deleteKinds:
 * - banned
 * - twoFactor / 2FA
 * - captcha / checkpoint
 * - marketplaceDisabled
 * - idVirtus (Messenger "para enviar mensagens")
 *
 * Nunca exclui: login requerido genérico (login_form, session, aymh, login_other,
 * identity selfie/vídeo, consent, appeal, password_reset, hacked_review).
 */

const fs = require('fs');
const path = require('path');
const manifestStore = require('./manifestStore.js');
const provisionAudit = require('./provisionAudit.js');
const logger = require('./logger.js');

const STATE_PATH = path.join(__dirname, '..', 'dados', 'daily_terminal_cleanup_state.json');

const DEFAULT_DELETE_KINDS = Object.freeze({
  banned: true,
  captcha: true,
  two_factor: true,
  marketplace_disabled: true,
  id_virtus: true
});

function now() { return Date.now(); }

function readJsonSafe(fp, fallback = null) {
  try { return JSON.parse(String(fs.readFileSync(fp, 'utf8') || '')); } catch { return fallback; }
}

function writeJsonAtomic(fp, obj) {
  try { fs.mkdirSync(path.dirname(fp), { recursive: true }); } catch {}
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

function todayKeySaoPaulo(ts = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(ts));
  } catch {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function loadState() {
  const j = readJsonSafe(STATE_PATH, null);
  return (j && typeof j === 'object') ? j : {};
}

function saveState(patch) {
  const next = { ...loadState(), ...(patch || {}), updatedAt: now() };
  writeJsonAtomic(STATE_PATH, next);
  return next;
}

/**
 * Resolve deleteKinds a partir da config.
 * Sem deleteKinds (config antiga) → default legado + id_virtus.
 * Com deleteKinds → só true explícito.
 */
function resolveDeleteKinds(termCleanOrKinds) {
  const raw = (termCleanOrKinds && typeof termCleanOrKinds === 'object')
    ? termCleanOrKinds
    : {};
  const dk = (raw.deleteKinds && typeof raw.deleteKinds === 'object')
    ? raw.deleteKinds
    : ((raw.banned !== undefined || raw.captcha !== undefined || raw.id_virtus !== undefined)
      ? raw
      : null);
  if (!dk) {
    return { ...DEFAULT_DELETE_KINDS };
  }
  return {
    banned: dk.banned === true,
    captcha: dk.captcha === true,
    two_factor: dk.two_factor === true,
    marketplace_disabled: dk.marketplace_disabled === true,
    id_virtus: dk.id_virtus === true
  };
}

function deleteKindsSignature(kinds) {
  const k = resolveDeleteKinds(kinds);
  return [
    k.banned ? '1' : '0',
    k.captcha ? '1' : '0',
    k.two_factor ? '1' : '0',
    k.marketplace_disabled ? '1' : '0',
    k.id_virtus ? '1' : '0'
  ].join('');
}

/** Motivos de LOGIN (não-terminal). Nunca inclui captcha/checkpoint/2fa/ban/id_virtus. */
function isLoginOnlyKeepReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return false;
  if (r === 'non_lr_automation_paused' || r.includes('non_lr_automation_paused')) return false;
  if (r.includes('password_reset')) return true;
  if (r.includes('hacked_review')) return true;
  if (r.includes('appeal')) return true;
  // identity selfie/vídeo — NÃO é ID Virtus
  if (r.includes('identity')) return true;
  if (r === 'login_form' || r.includes('login_form')) return true;
  if (r === 'aymh_continue' || r.includes('aymh_continue')) return true;
  if (r.includes('session')) return true;
  if (r === 'login_other' || r.includes('login_other')) return true;
  if (r.includes('consent')) return true;
  return false;
}

function isCaptchaOrCheckpointReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return false;
  if (r.includes('captcha')) return true;
  if (r.includes('checkpoint')) return true;
  return false;
}

function isTwoFactorReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return false;
  return r.includes('two_factor') || r.includes('2fa') || r.includes('two factor');
}

/** @deprecated nome antigo — mantido p/ imports; equivale a login-only keep. */
function isExplicitlyRecoverableReason(reason) {
  return isLoginOnlyKeepReason(reason);
}

/**
 * Decide se a conta deve ser excluída nesta limpeza.
 * @param {object} flags
 * @param {{ deleteKinds?: object }} [opts]
 */
function classifyTerminalDelete(flags, opts = {}) {
  const f = (flags && typeof flags === 'object') ? flags : {};
  const kinds = resolveDeleteKinds(opts.deleteKinds || opts);
  const loginReason = String(f.loginReason || '').trim().toLowerCase();
  const captchaReason = String(f.captchaCheckpointReason || '').trim().toLowerCase();
  const combined = captchaReason || loginReason;

  // 1) BAN
  if (f.banned === true) {
    if (!kinds.banned) {
      return { delete: false, category: 'banned_skipped', detail: 'kind_disabled' };
    }
    return { delete: true, category: 'banned', detail: String(f.bannedReason || 'banned').slice(0, 120) };
  }

  // 2) 2FA
  if (f.twoFactor === true) {
    if (!kinds.two_factor) {
      return { delete: false, category: 'two_factor_skipped', detail: 'kind_disabled' };
    }
    return { delete: true, category: 'two_factor', detail: String(f.twoFactorReason || 'two_factor').slice(0, 120) };
  }
  if (f.loginRequired === true && isTwoFactorReason(loginReason)) {
    if (!kinds.two_factor) {
      return { delete: false, category: 'two_factor_skipped', detail: 'kind_disabled' };
    }
    return { delete: true, category: 'two_factor', detail: `login_reason:${loginReason}`.slice(0, 120) };
  }

  // 3) MKT Desativado
  if (f.marketplaceDisabled === true) {
    if (!kinds.marketplace_disabled) {
      return { delete: false, category: 'marketplace_disabled_skipped', detail: 'kind_disabled' };
    }
    return {
      delete: true,
      category: 'marketplace_disabled',
      detail: String(f.marketplaceDisabledReason || 'marketplace_disabled').slice(0, 120)
    };
  }

  // 4) CAPTCHA / CHECKPOINT
  if (f.captchaCheckpoint === true) {
    if (!kinds.captcha) {
      return { delete: false, category: 'captcha_skipped', detail: 'kind_disabled' };
    }
    return {
      delete: true,
      category: 'captcha',
      detail: `captchaCheckpoint:${combined || 'flag'}`.slice(0, 120)
    };
  }
  if (isCaptchaOrCheckpointReason(captchaReason) || isCaptchaOrCheckpointReason(loginReason)) {
    if (!kinds.captcha) {
      return { delete: false, category: 'captcha_skipped', detail: 'kind_disabled' };
    }
    const detailSrc = isCaptchaOrCheckpointReason(captchaReason)
      ? `captcha_reason:${captchaReason}`
      : `login_reason:${loginReason}`;
    return {
      delete: true,
      category: 'captcha',
      detail: detailSrc.slice(0, 120)
    };
  }

  // 5) ID Virtus (Messenger send-identity) — NÃO confundir com identity selfie
  if (f.idVirtus === true) {
    if (!kinds.id_virtus) {
      return { delete: false, category: 'id_virtus_skipped', detail: 'kind_disabled' };
    }
    return {
      delete: true,
      category: 'id_virtus',
      detail: String(f.idVirtusReason || 'id_virtus').slice(0, 120)
    };
  }

  // 6) Login requerido genérico → NÃO excluir
  if (f.loginRequired === true) {
    if (isLoginOnlyKeepReason(loginReason) || !loginReason) {
      return {
        delete: false,
        category: 'login_required_keep',
        detail: String(loginReason || 'login_required').slice(0, 120)
      };
    }
    return {
      delete: false,
      category: 'login_required_keep',
      detail: String(loginReason || 'login_required_unknown').slice(0, 120)
    };
  }

  // 7) Resto (inclui identityRequired/Submitted)
  return { delete: false, category: 'keep', detail: null };
}

async function httpDeletePerfil({ localPort, nome, by }) {
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, 180_000);
  try {
    const r = await fetch(`http://127.0.0.1:${Number(localPort) || 8088}/api/perfis/${encodeURIComponent(nome)}`, {
      method: 'DELETE',
      headers: {
        'x-operator': String(by || 'daily_terminal_cleanup').slice(0, 120)
      },
      signal: ac.signal
    });
    const j = await r.json().catch(() => null);
    return j;
  } finally {
    clearTimeout(t);
  }
}

async function runDailyTerminalCleanup({
  fileStore,
  localPort,
  by = 'daily_window_open',
  force = false,
  deleteKinds = null
} = {}) {
  const day = todayKeySaoPaulo();
  const st = loadState();
  if (!force && String(st.lastTerminalCleanupDay || '') === day) {
    return {
      ok: true,
      skipped: true,
      reason: 'already_ran_today',
      day,
      deleted: 0,
      failed: 0,
      scanned: 0
    };
  }

  if (!fileStore || typeof fileStore.loadPerfisJson !== 'function') {
    return { ok: false, error: 'missing_file_store' };
  }

  const kinds = resolveDeleteKinds(deleteKinds || {});
  const loaded = fileStore.loadPerfisJson();
  const perfis = Array.isArray(loaded) ? loaded : [];
  const candidates = [];
  for (const p of perfis) {
    const nome = String(p && p.nome || '').trim();
    if (!nome) continue;
    let flags = {};
    try {
      const man = await manifestStore.read(nome).catch(() => null);
      flags = (man && man.accountFlags && typeof man.accountFlags === 'object') ? man.accountFlags : {};
    } catch {
      flags = {};
    }
    const decision = classifyTerminalDelete(flags, { deleteKinds: kinds });
    if (decision.delete) {
      candidates.push({ nome, category: decision.category, detail: decision.detail });
    }
  }

  try {
    provisionAudit.append({
      ts: now(),
      event: 'daily_terminal_cleanup_begin',
      by: String(by || '').slice(0, 120),
      day,
      scanned: perfis.length,
      candidates: candidates.length,
      deleteKinds: kinds,
      preview: candidates.slice(0, 30).map((c) => ({ nome: c.nome, category: c.category }))
    });
  } catch {}

  saveState({
    lastTerminalCleanupDay: day,
    lastTerminalCleanupAt: now(),
    lastDeleted: 0,
    lastFailed: 0,
    lastScanned: perfis.length,
    lastCandidates: candidates.length,
    lastByCategory: { banned: 0, two_factor: 0, captcha: 0, marketplace_disabled: 0, id_virtus: 0 },
    lastDeleteKinds: kinds,
    lastClaimedAt: now()
  });

  let deleted = 0;
  let failed = 0;
  const byCategory = { banned: 0, two_factor: 0, captcha: 0, marketplace_disabled: 0, id_virtus: 0 };
  const failures = [];

  try {
    for (const c of candidates) {
      try {
        const r = await httpDeletePerfil({
          localPort,
          nome: c.nome,
          by: `daily_terminal_cleanup:${c.category}`
        });
        if (r && r.ok === true) {
          deleted += 1;
          if (byCategory[c.category] != null) byCategory[c.category] += 1;
          try {
            provisionAudit.append({
              ts: now(),
              event: 'daily_terminal_cleanup_deleted',
              by: String(by || '').slice(0, 120),
              day,
              nome: c.nome,
              category: c.category,
              detail: c.detail,
              alreadyDeleted: !!(r && r.alreadyDeleted)
            });
          } catch {}
        } else {
          failed += 1;
          const err = String((r && r.error) || 'delete_failed').slice(0, 180);
          if (failures.length < 20) failures.push({ nome: c.nome, error: err, category: c.category });
          try {
            provisionAudit.append({
              ts: now(),
              event: 'daily_terminal_cleanup_delete_failed',
              by: String(by || '').slice(0, 120),
              day,
              nome: c.nome,
              category: c.category,
              error: err
            });
          } catch {}
        }
      } catch (e) {
        failed += 1;
        const err = String((e && e.message) || e).slice(0, 180);
        if (failures.length < 20) failures.push({ nome: c.nome, error: err, category: c.category });
      }
    }
  } finally {
    saveState({
      lastTerminalCleanupDay: day,
      lastTerminalCleanupAt: now(),
      lastDeleted: deleted,
      lastFailed: failed,
      lastScanned: perfis.length,
      lastCandidates: candidates.length,
      lastByCategory: byCategory,
      lastDeleteKinds: kinds
    });
  }

  try {
    provisionAudit.append({
      ts: now(),
      event: 'daily_terminal_cleanup_done',
      by: String(by || '').slice(0, 120),
      day,
      scanned: perfis.length,
      candidates: candidates.length,
      deleted,
      failed,
      byCategory,
      deleteKinds: kinds
    });
  } catch {}

  try {
    logger.info('[DAILY-TERMINAL-CLEANUP] done', {
      day,
      scanned: perfis.length,
      candidates: candidates.length,
      deleted,
      failed,
      byCategory,
      deleteKinds: kinds
    });
  } catch {}

  return {
    ok: true,
    skipped: false,
    day,
    scanned: perfis.length,
    candidates: candidates.length,
    deleted,
    failed,
    byCategory,
    deleteKinds: kinds,
    failures
  };
}

module.exports = {
  classifyTerminalDelete,
  runDailyTerminalCleanup,
  resolveDeleteKinds,
  deleteKindsSignature,
  DEFAULT_DELETE_KINDS,
  todayKeySaoPaulo,
  STATE_PATH
};
