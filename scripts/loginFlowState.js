'use strict';
const retry = require('./stockProvisionRetry');
const labels = {
  queued: 'Login: na fila', waiting_proxy: 'Login: aguardando proxy', cookies: 'Login: cookies',
  continue: 'Login: continuar', continue_loading: 'Login: carregando após continuar', password: 'Login: senha', credentials: 'Login: e-mail e senha',
  verifying: 'Login: verificando', welcome_loading: 'Login: concluindo boas-vindas', technical_wait: 'Login: falha técnica',
  password_rejected: 'Login: senha rejeitada', credentials_rejected: 'Login: dados rejeitados',
  missing_credentials: 'Login: dados ausentes', incomplete: 'Login: tentativa não concluída'
};
function evolve(previous, event, now = Date.now()) {
  const state = { ...(event.stage === 'queued' ? {} : previous || {}), version: 1, at: now };
  if (event.entry && ['continue', 'password', 'credentials', 'cookies'].includes(event.entry)) state.entry = state.entry || event.entry;
  if (event.stage) state.stage = event.stage;
  if (event.cookiesAttempted) state.cookiesAttempted = true;
  if (event.cookiesInjected) state.cookiesInjected = true;
  if (event.cookieAttempts) state.cookieAttempts = event.cookieAttempts;
  if (event.cookiesRejected && state.cookieAttempts>=3) state.cookiesRejected = true;
  if (event.credentialRejected) state.credentialRejections=(Number(state.credentialRejections)||0)+1;
  if (event.cookiesRefreshed) {state.cookiesRejected=false;state.cookiesRestored=true;state.cookiesRefreshedAt=now;}
  if (typeof event.cookiesRestored === 'boolean') state.cookiesRestored = event.cookiesRestored;
  if (event.submitted) state.credentialsSubmitted = true;
  if (event.error) {
    state.error = String(event.error).slice(0, 240);
    state.stage = retry.isTransient(event.error) ? 'technical_wait' : ['password_rejected', 'credentials_rejected', 'missing_credentials'].includes(event.error) ? event.error : 'incomplete';
  }
  if (event.verified) { state.stage = 'verified'; state.verifiedAt = now; delete state.error; }
  return state;
}
function summarize(profile) {
  const p = profile || {}, reason = String(p.loginReason || '').toLowerCase();
  if (p.banned || p.captchaCheckpoint || p.marketplaceDisabled || p.twoFactor || p.idVirtus || p.identityRequired || p.identitySubmitted || /captcha|checkpoint|identity|two_factor|2fa|consent/.test(reason)) return null;
  const flow = p.loginFlow || {};
  if (flow.stage === 'verified' && !p.loginRequired && !p.loginRemediateFailed) return null;
  let key = flow.stage;
  if (!labels[key]) {
    if (p.loginRemediateFailed) key = retry.isTransient(p.loginRemediateFailedReason) ? 'technical_wait' : 'incomplete';
    else if (/aymh|continuar|pre_screen/.test(reason)) key = 'continue';
    else if (reason === 'password_only') key = 'password';
    else if (/login_form|login_wall/.test(reason)) key = 'credentials';
    else if (p.loginRequired) key = 'incomplete';
    else return null;
  }
  // Never infer a rejected password from an old generic failure flag.
  const label=flow.cookiesRejected&&flow.credentialRejections>=3&&['password_rejected','credentials_rejected'].includes(key)?'Login: cookies e dados de login rejeitados':labels[key];
  return { key, label, entry: flow.entry || null, error: flow.error || p.loginRemediateFailedReason || null,
    cls: ['technical_wait', 'incomplete', 'missing_credentials', 'password_rejected', 'credentials_rejected'].includes(key) ? 'bad' : 'warn',
    cookiesAttempted: flow.cookiesAttempted === true, cookiesRejected:flow.cookiesRejected===true, cookieAttempts:flow.cookieAttempts||0, credentialRejections:flow.credentialRejections||0, cookiesRefreshedAt:flow.cookiesRefreshedAt||null, credentialsSubmitted: flow.credentialsSubmitted === true, at: flow.at || null };
}
module.exports = { evolve, summarize, labels };
