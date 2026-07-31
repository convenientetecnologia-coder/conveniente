'use strict';

/**
 * Limpeza diária de contas TERMINAIS no ABRIR automático da config (dueOpen).
 * NÃO deve ser chamada pelo botão Abrir tudo / open-all-24h manual.
 *
 * Allowlist positiva:
 * - banned
 * - twoFactor
 * - captcha/checkpoint BLOQUEANTE
 *
 * Nunca exclui: login_form, session, login_other, identity, consent, checkpoint recuperável.
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
 * Ordem (militar):
 * 1) banned / 2FA → delete
 * 2) motivos explicitamente recuperáveis → keep (mesmo com captchaCheckpoint=true)
 * 3) captcha/checkpoint bloqueante → delete
 * 4) resto (login_form/session/login_other/identity/consent/...) → keep
 */
function isExplicitlyRecoverableReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  if (!r) return false;
  if (r.includes('checkpoint_back_to_facebook') || r.includes('back_to_facebook')) return true;
  if (r === 'non_lr_automation_paused' || r.includes('non_lr_automation_paused')) return true;
  if (r.includes('password_reset')) return true;
  if (r.includes('hacked_review')) return true;
  if (r.includes('appeal')) return true;
  if (r.includes('identity')) return true;
  if (r === 'login_form' || r.includes('login_form')) return true;
  if (r === 'aymh_continue' || r.includes('aymh_continue')) return true;
  if (r.includes('session')) return true;
  if (r === 'login_other' || r.includes('login_other')) return true;
  if (r.includes('consent')) return true;
  return false;
}

function classifyTerminalDelete(flags) {
  const f = (flags && typeof flags === 'object') ? flags : {};
  const loginReason = String(f.loginReason || '').trim().toLowerCase();
  const captchaReason = String(f.captchaCheckpointReason || '').trim().toLowerCase();
  const combined = captchaReason || loginReason;

  if (f.banned === true) {
    return { delete: true, category: 'banned', detail: String(f.bannedReason || 'banned').slice(0, 120) };
  }

  if (f.twoFactor === true) {
    return { delete: true, category: 'two_factor', detail: String(f.twoFactorReason || 'two_factor').slice(0, 120) };
  }

  // Legado: 2FA só via loginReason
  if (f.loginRequired === true && (loginReason.includes('two_factor') || loginReason.includes('2fa'))) {
    return { delete: true, category: 'two_factor', detail: `login_reason:${loginReason}`.slice(0, 120) };
  }

  // Recuperáveis: NÃO excluir (mesmo se captchaCheckpoint ficou sujo por substring "checkpoint")
  if (isExplicitlyRecoverableReason(captchaReason) || isExplicitlyRecoverableReason(loginReason)) {
    return {
      delete: false,
      category: 'recoverable',
      detail: String(combined || 'recoverable').slice(0, 120)
    };
  }

  const captchaBlockingReasons = [
    'captcha_persona',
    'captcha_persona_pre_screen',
    'checkpoint_captcha',
    'captcha_checkpoint'
  ];

  if (f.captchaCheckpoint === true) {
    const r = combined;
    // Flag sem motivo = terminal (setCaptchaCheckpointFlag só sobe em fluxo bloqueante).
    // Motivo com captcha/checkpoint (já filtrado recuperável acima) = terminal.
    if (
      !r ||
      captchaBlockingReasons.some((x) => r === x || r.includes(x)) ||
      r.includes('captcha') ||
      r.includes('checkpoint')
    ) {
      return { delete: true, category: 'captcha', detail: `captchaCheckpoint:${r || 'flag'}`.slice(0, 120) };
    }
  }

  if (f.loginRequired === true) {
    if (captchaBlockingReasons.some((x) => loginReason === x || loginReason.includes(x))) {
      return { delete: true, category: 'captcha', detail: `login_reason:${loginReason}`.slice(0, 120) };
    }
    // login_form / session / login_other / identity / consent → NÃO
  }

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
    lastByCategory: { banned: 0, two_factor: 0, captcha: 0 },
    lastClaimedAt: now()
  });

  let deleted = 0;
  let failed = 0;
  const byCategory = { banned: 0, two_factor: 0, captcha: 0 };
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
