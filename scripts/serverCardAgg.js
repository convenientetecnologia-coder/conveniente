'use strict';

/**
 * Agregador canônico do card CT/Servidores (accountsAgg + flagsAgg).
 * Espelha a precedência de sitechatbot/convenientetecnologia/lib/fbAccountState.js
 * + regra anti-redundância de human_invoked do CT (humano "puro" só se kind === ok
 *   e sem loginRemediateFailed / appealSubmitted).
 *
 * Uma fábrica só: poll leve, event bridge e qualquer outro produtor devem usar isto.
 * Precedência estado final:
 * banned > marketplace_disabled > captcha > two_factor > identity/consent/login/session/login_other > limit_exceeded > ok
 */

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function robeStateFor(perfil, robeRec) {
  try {
    const p = (perfil && typeof perfil === 'object') ? perfil : {};
    const r = (robeRec && typeof robeRec === 'object') ? robeRec : {};
    const estado = norm(p.robeEstado || p.estado || r.estado || '');
    const pauseReason = norm(r.pauseReason || '');
    const cooldownSec = Number(r.cooldownSec || 0) || 0;
    return { estado, pauseReason, cooldownSec };
  } catch {
    return { estado: '', pauseReason: '', cooldownSec: 0 };
  }
}

function classifyAccountKind(perfil, robeRec) {
  const p = (perfil && typeof perfil === 'object') ? perfil : {};
  const rs = robeStateFor(p, robeRec);

  if (p.banned === true) return 'banned';
  if (p.marketplaceDisabled === true) return 'marketplace_disabled';

  if (p.captchaCheckpoint === true) return 'captcha';
  if (p.twoFactor === true) return 'two_factor';

  if (p.loginRequired === true) {
    const rNorm = norm(p.loginReason || '') || 'login_required';
    if (
      rNorm === 'checkpoint_captcha' ||
      rNorm === 'captcha_persona' ||
      rNorm.includes('captcha') ||
      rNorm.includes('checkpoint')
    ) return 'captcha';
    if (rNorm === 'login_form' || rNorm === 'aymh_continue' || rNorm.includes('aymh_continue')) return 'login';
    if (rNorm.includes('session')) return 'session';
    if (rNorm.includes('2fa') || rNorm.includes('two_factor')) return 'two_factor';
    if (rNorm.includes('identity')) return 'identity';
    if (rNorm.includes('consent')) return 'consent';
    return 'login_other';
  }

  // Alinhado ao CT fbAccountState (sem exigir cooldownSec > 0).
  if (rs.estado === 'paused_limit' || rs.pauseReason === 'limit_posting') return 'limit_exceeded';
  return 'ok';
}

function isHumanAlreadyExplainedByCard(kind, perfil) {
  const p = (perfil && typeof perfil === 'object') ? perfil : {};
  return (
    String(kind || 'ok') !== 'ok' ||
    p.loginRemediateFailed === true ||
    p.appealSubmitted === true
  );
}

function emptyFlagsAgg() {
  return {
    totalPerfis: 0,
    human_invoked: 0,
    messenger_pin: 0,
    problem: 0,
    virtus_offline: 0,
    login_required: 0,
    login_cookies_failed: 0,
    appeal_submitted: 0,
    // Marketplace ID doc 1x/dia (pill conta "ID - sim"); ≠ Facebook identity checkpoint
    id_sim: 0,
    renovados: 0,
    renovados_qtd: 0
  };
}

/**
 * @param {object} status - status com perfis[] e robes{}
 * @param {object} [opts]
 * @param {boolean} [opts.includeLoginReasonsTop=false] - só CT snapshot costuma querer; edge poll/event não
 * @returns {{ accountsAgg: object, flagsAgg: object }}
 */
function buildServerCardAggs(status, opts = {}) {
  const includeLoginReasonsTop = opts && opts.includeLoginReasonsTop === true;
  const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
  const robes = (status && status.robes && typeof status.robes === 'object') ? status.robes : {};

  const accountsAgg = { total: 0 };
  const flagsAgg = emptyFlagsAgg();
  const reasons = includeLoginReasonsTop ? new Map() : null;

  for (const p of perfis) {
    if (!p) continue;
    const nome = String(p.nome || '').trim();
    const robeRec = nome ? (robes[nome] || null) : null;
    const kind = classifyAccountKind(p, robeRec);

    accountsAgg[kind] = (Number(accountsAgg[kind] || 0) || 0) + 1;
    accountsAgg.total = (Number(accountsAgg.total || 0) || 0) + 1;

    flagsAgg.totalPerfis++;
    const humanHold = (p.humanControl === true || p.humanHold === true);
    if (humanHold && !isHumanAlreadyExplainedByCard(kind, p)) {
      flagsAgg.human_invoked++;
    }
    if (p.messengerPin === true) flagsAgg.messenger_pin++;
    if (p.problem === true) flagsAgg.problem++;
    if (p.virtusOnline === false) flagsAgg.virtus_offline++;
    if (p.loginRequired === true) {
      flagsAgg.login_required++;
      if (reasons) {
        const r = String(p.loginReason || '').trim() || 'login_required';
        reasons.set(r, (Number(reasons.get(r) || 0) || 0) + 1);
      }
    }
    if (p.loginRemediateFailed === true) flagsAgg.login_cookies_failed++;
    if (p.appealSubmitted === true) flagsAgg.appeal_submitted++;
    if (p.robeIdDocDoneToday === true) flagsAgg.id_sim++;

    // Canônico (= CT snapshot + renewMetrics.aggregateRenovadosFromPerfis): renovadosLastCount.
    const renovN = Math.floor(Number(p.renovadosLastCount || 0) || 0);
    if (renovN > 0) {
      flagsAgg.renovados++;
      flagsAgg.renovados_qtd += renovN;
    }
  }

  accountsAgg.lr_total = ['captcha', 'login', 'session', 'two_factor', 'identity', 'consent', 'login_other']
    .reduce((acc, k) => acc + (Number(accountsAgg[k] || 0) || 0), 0);

  if (reasons) {
    flagsAgg.login_reasons_top = Array.from(reasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (b.count - a.count) || String(a.reason).localeCompare(String(b.reason)))
      .slice(0, 8);
  }

  return { accountsAgg, flagsAgg };
}

module.exports = {
  classifyAccountKind,
  isHumanAlreadyExplainedByCard,
  buildServerCardAggs,
  emptyFlagsAgg,
  robeStateFor
};
