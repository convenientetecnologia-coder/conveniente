'use strict';

/**
 * Limpeza diária de contas TERMINAIS (ban / 2FA / captcha / checkpoint).
 * Acionada pelo terminalAccountCleanupScheduler (config própria no servidor).
 * NÃO acoplada a renovar/fechar/abrir. NÃO deve ser chamada pelo botão Abrir tudo.
 *
 * Allowlist positiva (DELETE):
 * - banned
 * - twoFactor / 2FA
 * - captcha / checkpoint (flag ou motivo) — inclusive se houver mascara de política (non_lr)
 *
 * Nunca exclui: login requerido genérico (login_form, session, aymh, login_other,
 * identity, consent, appeal, password_reset, hacked_review).
 */

const fs = require('fs');
const path = require('path');
const manifestStore = require('./manifestStore.js');
const provisionAudit = require('./provisionAudit.js');
const logger = require('./logger.js');

const STATE_PATH = path.join(__dirname, '..', 'dados', 'daily_terminal_cleanup_state.json');

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
 * Decide se a conta deve ser excluída nesta limpeza.
 * Allowlist positiva — nunca “loginRequired genérico”.
 *
 * Ordem (militar — NÃO inverter):
 * 1) banned → delete
 * 2) 2FA → delete
 * 3) marketplaceDisabled (MKT Desativado) → delete
 * 4) captcha / checkpoint (flag OU motivo) → delete
 * 5) login requerido genérico → keep
 * 6) resto → keep
 */

/** Motivos de LOGIN (não-terminal). Nunca inclui captcha/checkpoint/2fa/ban. */
function isLoginOnlyKeepReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return false;
  // Política de host — ruído, NÃO é motivo de keep por si só.
  if (r === 'non_lr_automation_paused' || r.includes('non_lr_automation_paused')) return false;
  if (r.includes('password_reset')) return true;
  if (r.includes('hacked_review')) return true;
  if (r.includes('appeal')) return true;
  if (r.includes('identity')) return true;
  if (r === 'login_form' || r.includes('login_form')) return true;
  if (r === 'aymh_continue' || r.includes('aymh_continue')) return true;
  // session expirada = login; se vier "session"+"checkpoint/captcha", o detector de captcha vence antes.
  if (r.includes('session')) return true;
  if (r === 'login_other' || r.includes('login_other')) return true;
  if (r.includes('consent')) return true;
  return false;
}

function isCaptchaOrCheckpointReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return false;
  // Qualquer captcha/checkpoint é terminal (inclui checkpoint_back_to_facebook).
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

function classifyTerminalDelete(flags) {
  const f = (flags && typeof flags === 'object') ? flags : {};
  const loginReason = String(f.loginReason || '').trim().toLowerCase();
  const captchaReason = String(f.captchaCheckpointReason || '').trim().toLowerCase();
  const combined = captchaReason || loginReason;

  // 1) BAN
  if (f.banned === true) {
    return { delete: true, category: 'banned', detail: String(f.bannedReason || 'banned').slice(0, 120) };
  }

  // 2) 2FA
  if (f.twoFactor === true) {
    return { delete: true, category: 'two_factor', detail: String(f.twoFactorReason || 'two_factor').slice(0, 120) };
  }
  if (f.loginRequired === true && isTwoFactorReason(loginReason)) {
    return { delete: true, category: 'two_factor', detail: `login_reason:${loginReason}`.slice(0, 120) };
  }

  // 3) MKT Desativado (marketplace create permanente)
  if (f.marketplaceDisabled === true) {
    return {
      delete: true,
      category: 'marketplace_disabled',
      detail: String(f.marketplaceDisabledReason || 'marketplace_disabled').slice(0, 120)
    };
  }

  // 4) CAPTCHA / CHECKPOINT — SEMPRE delete. Vence mascara non_lr / qualquer keep de login.
  if (f.captchaCheckpoint === true) {
    return {
      delete: true,
      category: 'captcha',
      detail: `captchaCheckpoint:${combined || 'flag'}`.slice(0, 120)
    };
  }
  if (isCaptchaOrCheckpointReason(captchaReason)) {
    return {
      delete: true,
      category: 'captcha',
      detail: `captcha_reason:${captchaReason}`.slice(0, 120)
    };
  }
  if (isCaptchaOrCheckpointReason(loginReason)) {
    return {
      delete: true,
      category: 'captcha',
      detail: `login_reason:${loginReason}`.slice(0, 120)
    };
  }

  // 4) Login requerido genérico → NÃO excluir
  if (f.loginRequired === true) {
    if (isLoginOnlyKeepReason(loginReason) || !loginReason) {
      return {
        delete: false,
        category: 'login_required_keep',
        detail: String(loginReason || 'login_required').slice(0, 120)
      };
    }
    // Motivo de login desconhecido (sem captcha/2fa/ban) → keep seguro
    return {
      delete: false,
      category: 'login_required_keep',
      detail: String(loginReason || 'login_required_unknown').slice(0, 120)
    };
  }

  // 5) Resto
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
  force = false
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
    const decision = classifyTerminalDelete(flags);
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
      preview: candidates.slice(0, 30).map((c) => ({ nome: c.nome, category: c.category }))
    });
  } catch {}

  // Claim 1×/dia ANTES do loop: se crashar no meio, não re-roda (evita double-delete)
  // e também não “perde o dia” por throw após o scan.
  saveState({
    lastTerminalCleanupDay: day,
    lastTerminalCleanupAt: now(),
    lastDeleted: 0,
    lastFailed: 0,
    lastScanned: perfis.length,
    lastCandidates: candidates.length,
    lastByCategory: { banned: 0, two_factor: 0, captcha: 0, marketplace_disabled: 0 },
    lastClaimedAt: now()
  });

  let deleted = 0;
  let failed = 0;
  const byCategory = { banned: 0, two_factor: 0, captcha: 0, marketplace_disabled: 0 };
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
      lastByCategory: byCategory
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
      byCategory
    });
  } catch {}

  try {
    logger.info('[DAILY-TERMINAL-CLEANUP] done', {
      day,
      scanned: perfis.length,
      candidates: candidates.length,
      deleted,
      failed,
      byCategory
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
    failures
  };
}

module.exports = {
  classifyTerminalDelete,
  runDailyTerminalCleanup,
  todayKeySaoPaulo,
  STATE_PATH
};
