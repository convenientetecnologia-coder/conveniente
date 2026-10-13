'use strict';

/**
 * Pills de monitoramento do dia (America/Sao_Paulo).
 * Robe erro: a postagem abriu o criar item e nao publicou.
 * Renovacao erro: o renovador entrou no fluxo e nao concluiu.
 * Sucesso do proprio fluxo apaga a pill. Meia-noite apaga as duas.
 * Limite, login, Marketplace desativado, rate limit, sem foto e pulo
 * (nao estava na hora, sem pagina, humano) nao acendem pill.
 */

const manifestStore = require('./manifestStore.js');

function todaySP(now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(now));
  } catch {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function isSameSpDay(atMs, now = Date.now()) {
  const at = Number(atMs);
  if (!Number.isFinite(at) || at <= 0) return false;
  return todaySP(at) === todaySP(now);
}

function flagsForToday(flags, now = Date.now()) {
  const f = (flags && typeof flags === 'object') ? flags : {};
  const robeOn = f.robePostError === true;
  const renewOn = f.renewError === true;
  const robeToday = robeOn && isSameSpDay(f.robePostErrorAt, now);
  const renewToday = renewOn && isSameSpDay(f.renewErrorAt, now);
  return {
    robePostError: robeToday,
    renewError: renewToday,
    staleRobePostError: robeOn && !robeToday,
    staleRenewError: renewOn && !renewToday
  };
}

function shouldMarkRobePostError(input) {
  const x = (input && typeof input === 'object') ? input : {};
  if (x.started !== true) return false;
  if (x.published === true) return false;
  if (x.limitPosting === true) return false;
  if (x.loginRequired === true) return false;
  if (x.marketplaceDisabled === true) return false;
  if (x.rateLimit === true) return false;
  if (x.noPhoto === true) return false;
  return true;
}

function shouldMarkRenewError(result) {
  if (!result || result.ok === true || result.skipped === true) return false;
  if (result.started === false) return false;
  const reason = String(result.reason || '').trim();
  const error = String(result.error || '').trim();
  const benign = new Set([
    'browser_not_connected',
    'renew_already_in_flight',
    'no_main_page',
    'no_page',
    'human_control',
    'human_hold',
    'not_due',
    'page_gone',
    'auto_gate_error',
    'robe_in_flight',
    'empty_result'
  ]);
  if (benign.has(reason) || benign.has(error)) return false;
  return true;
}

function shouldClearRenewError(result) {
  return !!(result && result.ok === true && result.skipped !== true);
}

async function setRobePostError(nome, { reason = '', text = '' } = {}) {
  const now = Date.now();
  const n = String(nome || '').trim();
  if (!n) return { ok: false };
  try {
    await manifestStore.update(n, (m) => {
      m = m || {};
      m.accountFlags = m.accountFlags || {};
      m.accountFlags.robePostError = true;
      m.accountFlags.robePostErrorAt = now;
      m.accountFlags.robePostErrorReason = String(reason || 'robe_post_error').slice(0, 140);
      m.accountFlags.robePostErrorText = String(text || '').slice(0, 400);
      return m;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function clearRobePostError(nome) {
  const n = String(nome || '').trim();
  if (!n) return { ok: false };
  try {
    await manifestStore.update(n, (m) => {
      m = m || {};
      const f = (m.accountFlags && typeof m.accountFlags === 'object') ? m.accountFlags : {};
      delete f.robePostError;
      delete f.robePostErrorAt;
      delete f.robePostErrorReason;
      delete f.robePostErrorText;
      if (Object.keys(f).length) m.accountFlags = f;
      else delete m.accountFlags;
      return m;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function setRenewError(nome, { reason = '', text = '' } = {}) {
  const now = Date.now();
  const n = String(nome || '').trim();
  if (!n) return { ok: false };
  try {
    await manifestStore.update(n, (m) => {
      m = m || {};
      m.accountFlags = m.accountFlags || {};
      m.accountFlags.renewError = true;
      m.accountFlags.renewErrorAt = now;
      m.accountFlags.renewErrorReason = String(reason || 'renew_error').slice(0, 140);
      m.accountFlags.renewErrorText = String(text || '').slice(0, 400);
      return m;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function clearRenewError(nome) {
  const n = String(nome || '').trim();
  if (!n) return { ok: false };
  try {
    await manifestStore.update(n, (m) => {
      m = m || {};
      const f = (m.accountFlags && typeof m.accountFlags === 'object') ? m.accountFlags : {};
      delete f.renewError;
      delete f.renewErrorAt;
      delete f.renewErrorReason;
      delete f.renewErrorText;
      if (Object.keys(f).length) m.accountFlags = f;
      else delete m.accountFlags;
      return m;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function clearStaleFlowAlertFlags(nome, now = Date.now()) {
  const n = String(nome || '').trim();
  if (!n) return { ok: false };
  try {
    await manifestStore.update(n, (m) => {
      m = m || {};
      const f = (m.accountFlags && typeof m.accountFlags === 'object') ? m.accountFlags : null;
      if (!f) return m;
      const view = flagsForToday(f, now);
      if (view.staleRobePostError) {
        delete f.robePostError;
        delete f.robePostErrorAt;
        delete f.robePostErrorReason;
        delete f.robePostErrorText;
      }
      if (view.staleRenewError) {
        delete f.renewError;
        delete f.renewErrorAt;
        delete f.renewErrorReason;
        delete f.renewErrorText;
      }
      if (Object.keys(f).length) m.accountFlags = f;
      else delete m.accountFlags;
      return m;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

module.exports = {
  todaySP,
  isSameSpDay,
  flagsForToday,
  shouldMarkRobePostError,
  shouldMarkRenewError,
  shouldClearRenewError,
  setRobePostError,
  clearRobePostError,
  setRenewError,
  clearRenewError,
  clearStaleFlowAlertFlags
};
