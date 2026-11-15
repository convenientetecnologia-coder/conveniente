'use strict';

const crypto = require('crypto');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');
const utils = require('./utils.js');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOGIN_URL = 'https://mbasic.facebook.com/login/';
const HOME_URL = 'https://www.facebook.com/';
const FBSBX = 'https://www.fbsbx.com/';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function pageUrl(page) {
  try { return (typeof page.url === 'function') ? String(page.url() || '') : ''; }
  catch { return ''; }
}

function blockedSaveUrl(url) {
  return /facebook\.com\/login|messenger\.com\/login|remember_browser|two_step_verification|\/two_factor\/|\/checkpoint\//i.test(String(url || ''));
}

function stripCheckpointSrc(url) {
  return String(url || '').replace(/([?&])checkpoint_src=[^&#]*/ig, '$1');
}

function cookiesHaveSession(cookies) {
  const arr = Array.isArray(cookies) ? cookies : [];
  const has = (name) => arr.some((c) => c && c.name === name && String(c.value || '').trim());
  return has('c_user') && has('xs');
}

function normalizeSecret(secret) {
  return String(secret || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function totpRemainingSec(nowMs = Date.now()) {
  return 30 - (Math.floor(Number(nowMs) / 1000) % 30);
}

function generateTotp(secret, nowMs = Date.now()) {
  const cleaned = normalizeSecret(secret);
  let bits = '';
  for (const c of cleaned) {
    const val = BASE32.indexOf(c);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const key = Buffer.from(bytes);
  if (!key.length) throw new Error('totp_secret_invalid');
  const counter = Math.floor(Number(nowMs) / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

async function freshTotp(secret) {
  if (totpRemainingSec() < 8) await sleep((totpRemainingSec() + 1) * 1000);
  return generateTotp(secret);
}

function formatSecretGrouped(secret) {
  return normalizeSecret(secret).replace(/(.{4})/g, '$1 ').trim();
}

function extractSixDigitsAfterPipe(raw) {
  const s = String(raw || '').trim();
  const pipe = s.lastIndexOf('|');
  if (pipe < 0) return '';
  const m = s.slice(pipe + 1).replace(/\s+/g, '').match(/(\d{6})/);
  return m ? m[1] : '';
}

async function codeFrom2faLive(page, secret, nome) {
  let browser = null;
  try { browser = typeof page.browser === 'function' ? page.browser() : null; } catch {}
  if (!browser || typeof browser.newPage !== 'function') return '';
  if (totpRemainingSec() < 8) await sleep((totpRemainingSec() + 1) * 1000);
  let extra = null;
  try {
    extra = await browser.newPage();
    try { await extra.bringToFront(); } catch {}
    await extra.goto('https://2fa.live/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(1600);
    const pasted = await extra.evaluate((val) => {
      const box = document.querySelector('#listToken, textarea.form-control');
      if (!box) return false;
      box.focus();
      const proto = window.HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(box, val);
      else box.value = val;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, formatSecretGrouped(secret));
    if (!pasted) {
      logger.warn('[LOGIN][pc] 2fa.live: campo do segredo não apareceu', { nome });
      return '';
    }
    await sleep(700);
    const submitted = await extra.evaluate(() => {
      const btn = document.querySelector('#submit, a[aria-label="Submit Form"]');
      if (!btn) return false;
      try { btn.click(); return true; } catch { return false; }
    });
    if (!submitted) {
      logger.warn('[LOGIN][pc] 2fa.live: botão Submit não apareceu', { nome });
      return '';
    }
    const end = Date.now() + 20000;
    let code = '';
    while (Date.now() < end) {
      const raw = await extra.evaluate(() => {
        const out = document.querySelector('#output');
        return out ? String(out.value || out.textContent || '') : '';
      }).catch(() => '');
      if (String(raw || '').indexOf('|') >= 0) code = extractSixDigitsAfterPipe(raw);
      if (code) break;
      await sleep(400);
    }
    if (code) logger.info('[LOGIN][pc] 2fa.live devolveu o código', { nome });
    else logger.warn('[LOGIN][pc] 2fa.live não devolveu os 6 dígitos', { nome });
    return code;
  } catch (e) {
    logger.warn('[LOGIN][pc] 2fa.live falhou', { nome, error: (e && e.message) || String(e) });
    return '';
  } finally {
    try { if (extra && !extra.isClosed()) await extra.close(); } catch {}
    try { await page.bringToFront(); } catch {}
  }
}

function readTotpSecret(man) {
  const raw = man && (man.totpSecret || man.twoFa || man.two_fa);
  const secret = normalizeSecret(raw);
  if (secret.length < 16) return '';
  return secret;
}

async function clearFacebookSessionCookies(page) {
  if (!page) return { ok: false, cleared: 0 };
  const urls = ['https://www.facebook.com/', 'https://facebook.com/', 'https://m.facebook.com/', 'https://web.facebook.com/'];
  let cleared = 0;
  for (const url of urls) {
    const cookies = await page.cookies(url).catch(() => []);
    for (const c of cookies || []) {
      if (!c || !c.name) continue;
      const dom = String(c.domain || '').toLowerCase();
      if (!dom.includes('facebook.com') && !dom.includes('messenger.com')) continue;
      try {
        await page.deleteCookie({ name: c.name, domain: c.domain, path: c.path || '/' });
        cleared += 1;
      } catch {}
    }
  }
  return { ok: true, cleared };
}

async function markSessionRejected(nome) {
  await manifestStore.update(String(nome || ''), (m) => {
    m = m || {};
    const prev = Array.isArray(m.cookies) ? m.cookies : [];
    m.cookies = prev.filter((c) => c && c.name !== 'c_user' && c.name !== 'xs');
    m.sessionRejected = true;
    return m;
  });
  logger.info('[LOGIN][pc] sessão recusada. O jar velho não volta.', { nome });
  return { ok: true };
}

async function prepareFreshLogin(page, nome) {
  await clearFacebookSessionCookies(page);
  await markSessionRejected(nome);
  return { ok: true };
}

async function openFreshLoginPage(page, nome) {
  await prepareFreshLogin(page, nome);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(700);
  logger.info('[LOGIN][pc] cookie velho apagado. Login aberto antes de digitar.', { nome });
  return LOGIN_URL;
}

async function loginFormStillVisible(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      const st = window.getComputedStyle(el);
      return !!(st && st.visibility !== 'hidden' && st.display !== 'none');
    }
    const email = document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="username"]');
    const pass = document.querySelector('input[name="pass"], input#pass, input[type="password"]');
    return visible(email) && visible(pass);
  }).catch(() => false);
}

async function pageText(page) {
  return page.evaluate(() => {
    const raw = String((document.body && (document.body.innerText || document.body.textContent)) || '');
    try { return raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
    catch { return raw.toLowerCase(); }
  }).catch(() => '');
}

async function badLoginText(page) {
  const t = await pageText(page);
  return t.includes('ocorreu um erro')
    || t.includes('an error occurred')
    || t.includes('senha incorreta')
    || t.includes('incorrect password')
    || t.includes('informacoes de login incorretas')
    || t.includes('incorrect login')
    || t.includes('login information you entered is incorrect');
}

async function humanConfirmScreen(page) {
  const t = await pageText(page);
  return (t.includes('confirme que voce e humano') && t.includes('para usar sua conta'))
    || t.includes('confirm that you are human')
    || t.includes('confirm you are human to use your account');
}

async function hackedScreen(page) {
  const t = await pageText(page);
  return t.includes('pode ter sido invadida')
    || t.includes('may have been hacked')
    || (t.includes('troque a senha') && (t.includes('invadida') || t.includes('hacked') || t.includes('protegida')))
    || (t.includes('change your password') && (t.includes('hacked') || t.includes('secure')));
}

function isWhatsappDeviceLockText(raw) {
  const t = String(raw || '');
  if (t.includes('aplicativo de autenticacao') || t.includes('app de autenticacao') || t.includes('authentication app') || t.includes('authenticator app')) return false;
  const smsChoice = t.includes('whatsapp ou sms') || t.includes('whatsapp or sms');
  const phoneEntry = t.includes('insira seu numero de celular') || t.includes('insira um numero de celular') || t.includes('digite seu numero de celular') || t.includes('insira o numero de celular') || t.includes('adicione um numero de celular');
  if (phoneEntry) return false;
  if (
    t.includes('insira o codigo de confirmacao')
    && t.includes('codigo de 5 digitos')
    && t.includes('nao recebi o codigo')
  ) return true;
  if (t.includes('verifique suas mensagens do whatsapp') || t.includes('codigo que enviamos para sua conta do whatsapp')) return true;
  if (t.includes('check your whatsapp') || t.includes('code we sent to your whatsapp')) return true;
  const asksWhatsapp =
    t.includes('receber um codigo no whatsapp') ||
    t.includes('receba um codigo no whatsapp') ||
    t.includes('codigo por whatsapp') ||
    t.includes('code via whatsapp') ||
    t.includes('confirmacao no whatsapp') ||
    t.includes('confirme no whatsapp') ||
    t.includes('confirmar no whatsapp') ||
    t.includes('codigo no whatsapp') ||
    t.includes('confirmation on whatsapp');
  if (asksWhatsapp && !smsChoice) return true;
  const codeAsk = t.includes('codigo de verificacao') || t.includes('verification code') || t.includes('enviamos um codigo') || t.includes('we sent a code') || t.includes('we sent you a code');
  if (codeAsk && t.includes('whatsapp') && !smsChoice) return true;
  const own = t.includes('confirme que esta conta e sua');
  const ownPhone = t.includes('receba um codigo no seu telefone') || t.includes('receber um codigo no seu telefone');
  return !!(own && (t.includes('receber um codigo no whatsapp') || t.includes('receba um codigo no whatsapp')) && ownPhone);
}

async function whatsappScreen(page) {
  return isWhatsappDeviceLockText(await pageText(page));
}

async function markWhatsappConfirm(nome) {
  await manifestStore.update(String(nome || ''), (m) => {
    m = m || {};
    m.accountFlags = m.accountFlags || {};
    m.accountFlags.whatsappConfirm = true;
    m.accountFlags.whatsappConfirmAt = Date.now();
    return m;
  });
  logger.info('[LOGIN][pc] pediu código no WhatsApp. Paro e deixo a conta invocada.', { nome });
  return { ok: true };
}

async function savedProfileOnly(page) {
  return page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
      catch { return String(s || '').toLowerCase(); }
    }
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      const st = window.getComputedStyle(el);
      return !!(st && st.visibility !== 'hidden' && st.display !== 'none');
    }
    const text = n((document.body && (document.body.innerText || document.body.textContent)) || '');
    const email = document.querySelector('input[name="email"], input#email, input[type="email"], input[autocomplete="username"]');
    const pass = document.querySelector('input[name="pass"], input#pass, input[type="password"]');
    return !!((text.includes('usar outro perfil') || text.includes('use another profile'))
      && (text.includes('continuar') || text.includes('continue'))
      && !visible(email) && !visible(pass));
  }).catch(() => false);
}

async function clickUseOtherProfile(page) {
  return page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
      catch { return String(s || '').toLowerCase().trim(); }
    }
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      const st = window.getComputedStyle(el);
      return st && st.visibility !== 'hidden' && st.display !== 'none';
    }
    const nodes = Array.from(document.querySelectorAll('a,button,[role="button"],div[tabindex="0"],span'));
    for (const el of nodes) {
      if (!visible(el)) continue;
      const t = n(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
      if (t === 'usar outro perfil' || t === 'use another profile') {
        try { el.click(); return true; } catch {}
      }
    }
    return false;
  }).catch(() => false);
}

async function findLoginInputs(page) {
  const picked = await page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 2 || r.height < 2) return false;
      const st = window.getComputedStyle(el);
      return !!(st && st.visibility !== 'hidden' && st.display !== 'none');
    }
    document.querySelectorAll('[data-cc-login-email],[data-cc-login-pass]').forEach((el) => {
      el.removeAttribute('data-cc-login-email');
      el.removeAttribute('data-cc-login-pass');
    });
    const emails = ['input[name="email"]', 'input#email', 'input[type="email"]', 'input[autocomplete="username"]'];
    const passes = ['input[name="pass"]', 'input#pass', 'input[type="password"]'];
    const all = (sels) => {
      const out = [];
      sels.forEach((sel) => document.querySelectorAll(sel).forEach((el) => out.push(el)));
      return out.find(visible) || null;
    };
    const email = all(emails);
    const pass = all(passes);
    if (email) email.setAttribute('data-cc-login-email', '1');
    if (pass) pass.setAttribute('data-cc-login-pass', '1');
    return !!(email && pass);
  }).catch(() => false);
  if (!picked) return null;
  const email = await page.$('[data-cc-login-email="1"]').catch(() => null);
  const pass = await page.$('[data-cc-login-pass="1"]').catch(() => null);
  if (!email || !pass) return null;
  return { email, pass };
}

async function waitForLoginForm(page, nome) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const found = await findLoginInputs(page);
    if (found) return found;
    if (await savedProfileOnly(page)) {
      logger.info('[LOGIN][pc] só Continuar e Usar outro perfil. Clico em Usar outro perfil.', { nome });
      await clickUseOtherProfile(page);
    }
    await sleep(400);
  }
  return findLoginInputs(page);
}

async function feedOpened(page) {
  const url = pageUrl(page);
  if (!url || blockedSaveUrl(url)) return false;
  if (await loginFormStillVisible(page)) return false;
  if (await badLoginText(page)) return false;
  if (await humanConfirmScreen(page)) return false;
  if (await hackedScreen(page)) return false;
  const www = await page.cookies('https://www.facebook.com').catch(() => []);
  const basic = await page.cookies('https://mbasic.facebook.com').catch(() => []);
  if (!cookiesHaveSession(www) && !cookiesHaveSession(basic)) return false;
  if (/mbasic\.facebook\.com/i.test(url)) return true;
  if (/^https?:\/\/(www\.)?facebook\.com\/?$/i.test(url.split('?')[0]) && !(await pageHasSessionChrome(page))) return false;
  return pageHasSessionChrome(page);
}

async function pageHasSessionChrome(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return !!(r && r.width > 2 && r.height > 2);
    }
    const email = document.querySelector('input[name="email"], input[type="email"]');
    const pass = document.querySelector('input[type="password"]');
    if (visible(email) && visible(pass)) return false;
    return !!(
      document.querySelector('[role="feed"]')
      || document.querySelector('[role="navigation"]')
      || document.querySelector('[aria-label="Facebook"]')
      || document.querySelector('div[role="main"]')
    );
  }).catch(() => false);
}

async function placeCookies(page, cookies) {
  const list = utils.normalizeCookies(cookies).filter((c) => c && c.name && c.value && c.domain);
  if (!list.length) return 0;
  await page.setCookie(...list);
  return list.length;
}

async function tryExistingPcSession(page, nome) {
  const man = await manifestStore.read(String(nome || '')).catch(() => null);
  if (man && man.sessionRejected === true) return { ok: false, loggedOut: true, reason: 'rejected' };
  const cookies = man && Array.isArray(man.cookies) ? man.cookies : [];
  if (!cookiesHaveSession(cookies)) return { ok: false, loggedOut: true, reason: 'no_session' };
  await placeCookies(page, cookies);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(1200);
  if (await feedOpened(page)) {
    logger.info('[LOGIN][pc] o feed abriu com o jar salvo. Não digito senha.', { nome });
    return { ok: true, in: true };
  }
  return { ok: false, loggedOut: true, reason: 'feed_closed' };
}

async function collectFreshCookies(page) {
  try {
    if (!page || typeof page.cookies !== 'function') return { ok: false, error: 'no_page' };
    const url = pageUrl(page);
    if (blockedSaveUrl(url)) return { ok: false, skipped: true, reason: 'on_login_page' };
    const current = await page.cookies().catch(() => []);
    const www = await page.cookies('https://www.facebook.com').catch(() => []);
    const msg = await page.cookies('https://www.messenger.com').catch(() => []);
    const map = new Map();
    for (const c of [...current, ...www, ...msg]) {
      if (!c || !c.name || c.value == null || String(c.value) === '') continue;
      const dom = String(c.domain || '').toLowerCase();
      if (dom && !dom.includes('facebook.com') && !dom.includes('messenger.com')) continue;
      map.set(`${c.name}|${c.domain || ''}|${c.path || '/'}`, c);
    }
    const cookies = utils.normalizeCookies(Array.from(map.values()));
    if (!cookiesHaveSession(cookies)) return { ok: false, skipped: true, reason: 'missing_essentials', cookies };
    return { ok: true, cookies };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function persistFreshSessionCookies(page, nome) {
  const url = pageUrl(page);
  if (blockedSaveUrl(url)) {
    logger.info('[LOGIN][pc] não gravo cookie nesta URL', { nome, url: url.slice(0, 180) });
    return { ok: false, skipped: true, reason: 'on_login_page' };
  }
  if (await loginFormStillVisible(page) || await badLoginText(page) || await humanConfirmScreen(page) || await hackedScreen(page)) {
    return { ok: false, skipped: true, reason: 'not_success' };
  }
  if (!(await feedOpened(page))) return { ok: false, skipped: true, reason: 'not_in' };
  const fresh = await collectFreshCookies(page);
  if (!fresh || !fresh.ok || !cookiesHaveSession(fresh.cookies)) {
    return { ok: false, skipped: true, reason: 'missing_essentials' };
  }
  await manifestStore.update(String(nome || ''), (m) => {
    m = m || {};
    m.cookies = fresh.cookies;
    m.sessionRejected = false;
    m.cookiesUpdatedAt = Date.now();
    if (m.accountFlags) {
      delete m.accountFlags.whatsappConfirm;
      delete m.accountFlags.whatsappConfirmAt;
    }
    return m;
  });
  logger.info('[LOGIN][pc] jar inteiro gravado', { nome, count: fresh.cookies.length });
  return { ok: true, count: fresh.cookies.length };
}

async function readWidget(page) {
  const enterprise = require('./recaptchaEnterprisePage.js');
  return enterprise.readWidget(page);
}

function onLoginOrTwoStep(url) {
  return /\/login|two_step_verification/i.test(String(url || ''));
}

function onAuthentication(url) {
  return /\/authentication\//i.test(String(url || ''));
}

function captchaBuyStop(error) {
  return error === 'aborted'
    || error === 'anticaptcha_key_missing'
    || error === 'ERROR_ZERO_BALANCE'
    || error === 'ERROR_KEY_DOES_NOT_EXIST';
}

async function waitUntilLeaveAuthentication(page, ms) {
  const until = Date.now() + ms;
  let saw = onAuthentication(pageUrl(page));
  while (Date.now() < until) {
    const url = pageUrl(page);
    if (onAuthentication(url)) saw = true;
    else if (saw || !onLoginOrTwoStep(url)) return true;
    await sleep(500);
  }
  const url = pageUrl(page);
  if (onAuthentication(url)) return false;
  if (saw) return true;
  return !onLoginOrTwoStep(url);
}

async function boxIsOnScreen(page) {
  const url = pageUrl(page);
  if (onAuthentication(url)) return true;
  if (!/two_step_verification/i.test(url)) return false;
  const text = await pageText(page);
  if (text.includes('recaptcha') || text.includes('nao sou um robo')) return true;
  const frame = await page.$('iframe[src*="recaptcha"], iframe[src*="fbsbx.com"]').catch(() => null);
  return !!frame;
}

async function readSitekeyWithPatience(page, nome, attempt) {
  const enterprise = require('./recaptchaEnterprisePage.js');
  let widget = null;
  for (let i = 0; i < 4; i++) {
    widget = await readWidget(page);
    if (widget && widget.sitekey) return widget;
    enterprise.recaptchaLog('warn', '[RECAPTCHA] sem sitekey', {
      nome: nome || '',
      attempt,
      read: i + 1,
      source: (widget && widget.source) || 'missing',
      anchorPath: (widget && widget.anchorPath) || '',
      frames: (widget && widget.frames) || [],
      page: (widget && widget.websiteURL) || ''
    });
    if (i < 3) await sleep(1500);
  }
  return widget;
}

function tokenLanded(result) {
  return !!(result && result.applied && (result.applied.areas || result.applied.called));
}

function onBareLoginUrl(url) {
  return /\/login\.php|\/login\/|\/login\?/i.test(String(url || ''));
}

async function waitForRobotBox(page) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const url = pageUrl(page);
    if (!onLoginOrTwoStep(url) && !onAuthentication(url)) return false;
    if (await boxIsOnScreen(page)) return true;
    await sleep(400);
  }
  return false;
}

async function classifyAfterCaptchaToken(page) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (onAuthentication(pageUrl(page))) {
      await sleep(400);
      continue;
    }
    if (await loginFormStillVisible(page)) return 'form_back';
    if (onBareLoginUrl(pageUrl(page))) {
      await sleep(400);
      continue;
    }
    return 'passed';
  }
  if (onAuthentication(pageUrl(page))) return 'still_box';
  if (await loginFormStillVisible(page)) return 'form_back';
  if (onBareLoginUrl(pageUrl(page))) return 'not_settled';
  return 'passed';
}

async function buyCaptcha(page, nome, { v2, attempt }) {
  const enterprise = require('./recaptchaEnterprisePage.js');
  const widget = await readSitekeyWithPatience(page, nome, attempt);
  if (!widget || !widget.sitekey) {
    enterprise.recaptchaLog('warn', '[RECAPTCHA] enterprise não resolveu', { nome: nome || '', error: 'no_sitekey' });
    return { ok: false, error: 'no_sitekey' };
  }
  const solved = v2
    ? await enterprise.solveOnceV2(page, { nome, timeoutMs: 120_000 })
    : await enterprise.solveOnce(page, { nome, attempt, timeoutMs: 120_000 });
  return solved || { ok: false, error: 'anticaptcha_failed' };
}

async function watchAndSolveLoginCheckbox(page, nome, user, pass) {
  let purchases = 0;
  let reloaded = false;
  let nextIsV2 = false;

  const typeAndSubmit = async () => {
    await openFreshLoginPage(page, nome);
    const inputs = await waitForLoginForm(page, nome);
    if (!inputs) return { ok: false, error: 'login_form_not_found' };
    const typeInto = async (handle, value) => {
      try { await handle.click({ clickCount: 3 }); } catch {}
      try { await page.keyboard.press('Backspace'); } catch {}
      try { await handle.type(String(value || ''), { delay: 15 }); } catch {}
    };
    await typeInto(inputs.email, user);
    await typeInto(inputs.pass, pass);
    await sleep(120);
    let submitted = false;
    for (const sel of ['button[name="login"]', 'button[type="submit"]', '#loginbutton', 'input[type="submit"]']) {
      const btn = await page.$(sel).catch(() => null);
      if (!btn) continue;
      try { await btn.click({ delay: 30 }); submitted = true; break; } catch {}
    }
    if (!submitted) {
      try { await page.keyboard.press('Enter'); submitted = true; } catch {}
    }
    if (!submitted) return { ok: false, error: 'login_submit_failed' };
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await sleep(800);
    return { ok: true };
  };

  while (purchases < 2) {
    const present = await waitForRobotBox(page);
    if (!present) {
      if (reloaded && await loginFormStillVisible(page)) return { ok: false, reason: 'captcha_back_to_login' };
      if (reloaded) return { ok: false, reason: 'login_not_accepted' };
      return { ok: true, skipped: true };
    }
    const solved = await buyCaptcha(page, nome, { v2: nextIsV2, attempt: purchases + 1 });
    nextIsV2 = false;
    purchases += 1;
    if (captchaBuyStop(solved && solved.error)) return { ok: false, reason: solved.error };
    if (solved && solved.error === 'anticaptcha_timeout') {
      if (reloaded || purchases >= 2) return { ok: false, reason: 'anticaptcha_timeout' };
      reloaded = true;
      require('./recaptchaEnterprisePage.js').recaptchaLog('warn', '[RECAPTCHA] tempo esgotado. Volto ao login e tento outra vez.', { nome: nome || '' });
      const again = await typeAndSubmit();
      if (!again.ok) return { ok: false, reason: again.error || 'login_submit_failed' };
      if (await badLoginText(page)) return { ok: false, reason: 'login_not_accepted' };
      continue;
    }
    const landed = tokenLanded(solved);
    if (!landed) {
      if (!onAuthentication(pageUrl(page)) && !(await loginFormStillVisible(page))) {
        return { ok: true, solved: true };
      }
      if (await loginFormStillVisible(page)) {
        if (reloaded || purchases >= 2) return { ok: false, reason: 'captcha_back_to_login' };
        reloaded = true;
        const again = await typeAndSubmit();
        if (!again.ok) return { ok: false, reason: again.error || 'login_submit_failed' };
        if (await badLoginText(page)) return { ok: false, reason: 'login_not_accepted' };
        if (solved.error && solved.error !== 'token_not_applied' && solved.error !== 'no_sitekey') nextIsV2 = true;
        continue;
      }
      if (purchases >= 2) return { ok: false, reason: solved.error || 'recaptcha_enterprise_failed' };
      if (solved.error && solved.error !== 'token_not_applied' && solved.error !== 'no_sitekey') nextIsV2 = true;
      continue;
    }
    const kind = await classifyAfterCaptchaToken(page);
    if (kind === 'passed') return { ok: true, solved: true };
    if (kind === 'still_box') {
      if (purchases >= 2) return { ok: false, reason: 'captcha_still_there' };
      continue;
    }
    if (kind === 'form_back') {
      if (reloaded || purchases >= 2) return { ok: false, reason: 'captcha_back_to_login' };
      reloaded = true;
      const again = await typeAndSubmit();
      if (!again.ok) return { ok: false, reason: again.error || 'login_submit_failed' };
      if (await badLoginText(page)) return { ok: false, reason: 'login_not_accepted' };
      continue;
    }
    return { ok: false, reason: 'login_not_accepted' };
  }
  return { ok: false, reason: 'captcha_still_there' };
}

async function markAuthField(page) {
  return page.evaluate(() => {
    function vis(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width < 8 || r.height < 8) return false;
      const st = window.getComputedStyle(el);
      return !!(st && st.visibility !== 'hidden' && st.display !== 'none');
    }
    document.querySelectorAll('[data-cc-auth-code]').forEach((el) => el.removeAttribute('data-cc-auth-code'));
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    const boxes = inputs.filter((input) => vis(input) && Number(input.getAttribute('maxlength') || 0) === 1);
    if (boxes.length >= 6) {
      boxes[0].setAttribute('data-cc-auth-code', 'boxes');
      return 'boxes';
    }
    const one = inputs.find((input) => {
      if (!vis(input)) return false;
      const max = Number(input.getAttribute('maxlength') || 0);
      if (max === 6 || max === 8) return true;
      const hint = `${input.getAttribute('aria-label') || ''} ${input.getAttribute('name') || ''} ${input.getAttribute('placeholder') || ''}`.toLowerCase();
      return hint.includes('code') || hint.includes('codigo') || hint.includes('código') || input.type === 'tel' || input.inputMode === 'numeric';
    });
    if (one) {
      one.setAttribute('data-cc-auth-code', 'one');
      return 'one';
    }
    const texts = inputs.filter((input) => vis(input) && (input.type === 'text' || input.type === 'tel' || input.type === '' || !input.type));
    if (texts.length === 1) {
      texts[0].setAttribute('data-cc-auth-code', 'one');
      return 'one';
    }
    return '';
  }).catch(() => '');
}

async function clickContinue(page) {
  return page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
      catch { return String(s || '').toLowerCase().trim(); }
    }
    function pressable(el) {
      let cur = el;
      while (cur && cur !== document.body) {
        const role = (cur.getAttribute && cur.getAttribute('role')) || '';
        const tag = (cur.tagName || '').toLowerCase();
        if (tag === 'button' || tag === 'a' || role === 'button') return cur;
        cur = cur.parentElement;
      }
      return el;
    }
    const wanted = ['continuar', 'continue', 'confirmar', 'confirm', 'avancar'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a, div, span'));
    const hits = [];
    for (const el of nodes) {
      if (el.disabled) continue;
      const text = n(el.getAttribute('aria-label') || el.innerText || el.value || '');
      if (!wanted.includes(text)) continue;
      const target = pressable(el);
      const r = target.getBoundingClientRect();
      if (r.width < 48 || r.height < 18) continue;
      const role = (target.getAttribute && target.getAttribute('role')) || '';
      hits.push({ el: target, button: role === 'button' || (target.tagName || '').toLowerCase() === 'button' });
    }
    if (!hits.length) return false;
    hits.sort((a, b) => (a.button === b.button ? 0 : (a.button ? -1 : 1)));
    try { hits[0].el.click(); return true; } catch { return false; }
  }).catch(() => false);
}

async function fillAuthCode(page, code, kind) {
  if (kind === 'boxes') {
    return page.evaluate((val) => {
      const boxes = Array.from(document.querySelectorAll('input')).filter((input) => {
        const r = input.getBoundingClientRect();
        return r.width >= 8 && r.height >= 8 && Number(input.getAttribute('maxlength') || 0) === 1;
      });
      if (boxes.length < 6) return false;
      const digits = String(val || '').replace(/\D/g, '').slice(0, 6).split('');
      boxes.slice(0, 6).forEach((el, i) => {
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, digits[i] || '');
        else el.value = digits[i] || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return true;
    }, String(code)).catch(() => false);
  }
  const handle = await page.$('[data-cc-auth-code]');
  if (!handle) return false;
  try {
    await handle.click({ clickCount: 3 });
    await handle.type(String(code), { delay: 35 });
    return true;
  } catch {
    return false;
  }
}

async function confirmAuthApp(page, nome) {
  const man = await manifestStore.read(String(nome || '')).catch(() => null);
  const secret = readTotpSecret(man);
  if (!secret) {
    logger.warn('[LOGIN][pc] pediu o app de autenticação e a conta não tem a chave. Paro. Não excluo.', { nome });
    return { ok: false, outcome: 'skipped', error: 'auth_app_no_secret' };
  }
  let code = await codeFrom2faLive(page, secret, nome);
  if (!/^\d{6}$/.test(code)) {
    try { code = await freshTotp(secret); } catch { code = ''; }
  }
  if (!/^\d{6}$/.test(code)) return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
  let kind = await markAuthField(page);
  if (!kind) {
    await sleep(800);
    kind = await markAuthField(page);
  }
  if (!kind) return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
  const typed = await fillAuthCode(page, code, kind);
  if (!typed) return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
  try { await page.keyboard.press('Enter'); } catch {}
  await sleep(700);
  let continued = false;
  for (let i = 0; i < 8 && !continued; i++) {
    continued = await clickContinue(page);
    if (!continued) await sleep(400);
  }
  if (!continued) {
    await sleep(1200);
    if (await isTrustScreen(page)) return { ok: true, outcome: 'auth_app_ok' };
    const url = pageUrl(page);
    const stillCode = /two_step_verification\/two_factor/i.test(url) && !/remember_browser/i.test(url);
    const field = await markAuthField(page);
    if (!field && !stillCode) return { ok: true, outcome: 'auth_app_ok' };
    return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
  }
  await sleep(800);
  return { ok: true, outcome: 'auth_app_ok' };
}

async function clickLabeled(page, labels, { forbid = [] } = {}) {
  return page.evaluate((wanted, blocked) => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
      catch { return String(s || '').toLowerCase().trim(); }
    }
    function pressable(el) {
      let cur = el;
      while (cur && cur !== document.body) {
        const role = (cur.getAttribute && cur.getAttribute('role')) || '';
        const tag = (cur.tagName || '').toLowerCase();
        const text = n(cur.innerText || cur.getAttribute('aria-label') || '');
        if (blocked.some((b) => text.includes(b))) break;
        if (tag === 'button' || tag === 'a' || role === 'button' || role === 'radio' || tag === 'label') return cur;
        cur = cur.parentElement;
      }
      return el;
    }
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], [role="radio"], label, div, span, a'));
    const hits = [];
    for (const el of nodes) {
      if (el.disabled) continue;
      const text = n(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
      if (!text) continue;
      if (blocked.some((b) => text.includes(b))) continue;
      const exact = wanted.some((w) => text === w);
      const partial = wanted.some((w) => text.includes(w));
      if (!exact && !partial) continue;
      const target = pressable(el);
      const r = target.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      const role = (target.getAttribute && target.getAttribute('role')) || '';
      hits.push({ el: target, area: r.width * r.height, exact, choice: role === 'radio' || role === 'button' });
    }
    if (!hits.length) return false;
    hits.sort((a, b) => (a.choice === b.choice ? a.area - b.area : (a.choice ? -1 : 1)));
    try { hits[0].el.click(); return true; } catch { return false; }
  }, labels, forbid).catch(() => false);
}

function otherDeviceApprovalText(text) {
  const t = String(text || '');
  return t.includes('verifique suas notificacoes')
    || t.includes('aguardando aprovacao')
    || t.includes('notificacao em outro dispositivo')
    || t.includes('check your notifications')
    || t.includes('waiting for approval');
}

async function leaveOtherDeviceApproval(page, nome) {
  const until = Date.now() + 8000;
  let otherDevice = false;
  while (Date.now() < until) {
    if (await markAuthField(page)) return { ok: true, skipped: true };
    const text = await pageText(page);
    if (otherDeviceApprovalText(text)) {
      otherDevice = true;
      break;
    }
    const url = pageUrl(page);
    if (!/two_factor|two_step_verification/i.test(url)) return { ok: true, skipped: true };
    await sleep(400);
  }
  if (await markAuthField(page)) return { ok: true, skipped: true };
  if (!otherDevice && !otherDeviceApprovalText(await pageText(page))) return { ok: true, skipped: true };

  const man = await manifestStore.read(String(nome || '')).catch(() => null);
  if (!readTotpSecret(man)) {
    logger.warn('[LOGIN][pc] pediu aprovação em outro aparelho e a conta não tem a chave. Paro.', { nome });
    return { ok: false, error: 'auth_app_no_secret' };
  }

  const opened = await clickLabeled(page, ['tentar outra forma', 'try another way']);
  if (!opened) return { ok: false, error: 'other_device_no_switch' };
  await sleep(800);

  const picked = await clickLabeled(page, ['app de autenticacao', 'authentication app', 'authenticator app'], {
    forbid: ['notificacao em outro dispositivo', 'notification on another device', 'another device']
  });
  if (!picked) return { ok: false, error: 'other_device_no_app' };
  await sleep(400);

  const continued = await clickContinue(page);
  if (!continued) return { ok: false, error: 'other_device_no_continue' };

  const codeUntil = Date.now() + 8000;
  while (Date.now() < codeUntil) {
    if (await markAuthField(page)) {
      logger.info('[LOGIN][pc] saí da aprovação em outro aparelho e abri o app de autenticação.', { nome });
      return { ok: true, switched: true };
    }
    await sleep(400);
  }
  return { ok: false, error: 'auth_app_code_failed' };
}

async function passAuthenticatorCode(page, nome) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (await isTrustScreen(page)) {
      await clickTrustThisDevice(page, nome);
      return { asked: true, ok: true };
    }
    const url = pageUrl(page);
    const text = await pageText(page);
    const onCodeUrl = /two_step_verification\/two_factor/i.test(url)
      || (/\/two_factor\//i.test(url) && !/remember_browser/i.test(url));
    const asked = onCodeUrl
      || text.includes('ir para o app de autenticacao')
      || text.includes('app de autenticacao')
      || text.includes('authentication app')
      || text.includes('aplicativo de autenticacao')
      || text.includes('codigo de autenticacao');
    if (!asked) return { asked: attempt > 1, ok: true };
    const auth = await confirmAuthApp(page, nome);
    if (auth && auth.error === 'auth_app_no_secret') {
      return { asked: true, ok: false, error: 'auth_app_no_secret' };
    }
    if (auth && auth.ok !== false) return { asked: true, ok: true };
    if (attempt === 2 && await markAuthField(page)) {
      return { asked: true, ok: false, error: (auth && auth.error) || 'auth_app_code_failed' };
    }
  }
  return { asked: true, ok: false, error: 'auth_app_code_failed' };
}

async function isTrustScreen(page) {
  return page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
      catch { return String(s || '').toLowerCase(); }
    }
    const url = String(location.href || '');
    const txt = n((document.body && (document.body.innerText || document.body.textContent)) || '');
    return url.indexOf('remember_browser') >= 0
      || txt.indexOf('confiar neste dispositivo') >= 0
      || txt.indexOf('trust this device') >= 0;
  }).catch(() => false);
}

async function clickTrustButton(page) {
  return page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
      catch { return String(s || '').toLowerCase().trim(); }
    }
    function pressable(el) {
      let cur = el;
      while (cur && cur !== document.body) {
        const role = (cur.getAttribute && cur.getAttribute('role')) || '';
        const tag = (cur.tagName || '').toLowerCase();
        const text = n(cur.innerText || cur.getAttribute('aria-label') || '');
        if (text.indexOf('sempre confirmar') >= 0 || text.indexOf('always confirm') >= 0) break;
        if (tag === 'button' || tag === 'a' || role === 'button') return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    const wanted = ['confiar neste dispositivo', 'trust this device'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
    const hits = [];
    for (const el of nodes) {
      if (el.disabled) continue;
      const text = n(el.getAttribute('aria-label') || el.innerText || '');
      if (!wanted.includes(text)) continue;
      const target = pressable(el);
      if (!target || target.disabled) continue;
      const targetText = n(target.getAttribute('aria-label') || target.innerText || '');
      if (!targetText || targetText.indexOf('sempre confirmar') >= 0 || targetText.indexOf('always confirm') >= 0) continue;
      if (!wanted.some((w) => targetText === w || targetText.indexOf(w) >= 0)) continue;
      const r = target.getBoundingClientRect();
      if (r.width < 48 || r.height < 18) continue;
      const role = (target.getAttribute && target.getAttribute('role')) || '';
      hits.push({ el: target, button: role === 'button' || (target.tagName || '').toLowerCase() === 'button' });
    }
    if (!hits.length) return false;
    hits.sort((a, b) => (a.button === b.button ? 0 : (a.button ? -1 : 1)));
    try { hits[0].el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    try { hits[0].el.click(); return true; } catch (e) { return false; }
  }).catch(() => false);
}

async function clickTrustThisDevice(page, nome) {
  const until = Date.now() + 15000;
  let seen = false;
  while (Date.now() < until) {
    if (await isTrustScreen(page)) { seen = true; break; }
    const url = stripCheckpointSrc(pageUrl(page));
    const pastGate = /facebook\.com|messenger\.com/i.test(url)
      && !/two_step_verification|remember_browser|\/two_factor\/|\/login|\/checkpoint/i.test(url);
    if (pastGate) return { seen: false, clicked: false, left: true };
    await sleep(400);
  }
  if (!seen) return { seen: false, clicked: false };

  let clicked = false;
  for (let i = 0; i < 4; i++) {
    const hit = await clickTrustButton(page);
    if (hit) clicked = true;
    const leftUntil = Date.now() + (hit ? 8000 : 600);
    while (Date.now() < leftUntil) {
      const url = pageUrl(page);
      if (url && !/remember_browser/i.test(url) && !(await isTrustScreen(page))) {
        logger.info('[LOGIN][pc] confiei neste dispositivo', { nome });
        return { seen: true, clicked: true, left: true };
      }
      if (!hit) break;
      await sleep(400);
    }
    if (!hit) await sleep(400);
  }
  if (!clicked) {
    logger.warn('[LOGIN][pc] tela de confiar no dispositivo sem o botão azul', { nome });
    return { seen: true, clicked: false };
  }
  logger.info('[LOGIN][pc] confiei neste dispositivo', { nome });
  return { seen: true, clicked: true, left: !/remember_browser/i.test(pageUrl(page)) };
}

async function waitForLoginImageCaptcha(page) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const image = await page.$('img[src*="/captcha/tfbimage/"]').catch(() => null);
    if (image) return image;
    const url = pageUrl(page);
    if (!onLoginOrTwoStep(url) && !/\/checkpoint/i.test(stripCheckpointSrc(url))) return null;
    await sleep(1000);
  }
  return page.$('img[src*="/captcha/tfbimage/"]').catch(() => null);
}

async function attemptCredentialRelogin(page, nome, { login, password } = {}) {
  const user = String(login || '').trim();
  const pass = String(password || '').trim();
  if (!user || !pass) return { ok: false, error: 'missing_credentials' };
  if (await hackedScreen(page)) return { ok: false, error: 'hacked_review', terminal: 'hacked_review' };
  if (await whatsappScreen(page)) {
    await markWhatsappConfirm(nome);
    return { ok: false, error: 'whatsapp_confirm', terminal: 'whatsapp_confirm' };
  }

  await openFreshLoginPage(page, nome);
  let inputs = await waitForLoginForm(page, nome);
  if (!inputs) return { ok: false, error: 'login_form_not_found' };

  const typeInto = async (handle, value) => {
    try { await handle.click({ clickCount: 3 }); } catch {}
    try { await page.keyboard.press('Backspace'); } catch {}
    try { await handle.type(String(value || ''), { delay: 15 }); } catch {}
  };
  await typeInto(inputs.email, user);
  await typeInto(inputs.pass, pass);
  await sleep(120);

  let submitted = false;
  for (const sel of ['button[name="login"]', 'button[type="submit"]', '#loginbutton', 'input[type="submit"]']) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn) continue;
    try { await btn.click({ delay: 30 }); submitted = true; break; } catch {}
  }
  if (!submitted) {
    try { await page.keyboard.press('Enter'); submitted = true; } catch {}
  }
  if (!submitted) return { ok: false, error: 'login_submit_failed' };
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(800);

  if (await badLoginText(page)) return { ok: false, error: 'login_not_accepted' };
  if (await hackedScreen(page)) return { ok: false, error: 'hacked_review', terminal: 'hacked_review' };

  const box = await watchAndSolveLoginCheckbox(page, nome, user, pass);
  if (box && box.ok === false) return { ok: false, error: box.reason || 'recaptcha_failed' };
  const image = await waitForLoginImageCaptcha(page);
  if (image) {
    const solvedImage = await require('./browser.js').solveFacebookImageCaptcha(page, {
      nome,
      operator: 'pc_login',
      maxAttempts: 2
    });
    if (!solvedImage || solvedImage.ok !== true) {
      return { ok: false, error: (solvedImage && solvedImage.error) || 'image_captcha_failed' };
    }
  }
  if (await hackedScreen(page)) return { ok: false, error: 'hacked_review', terminal: 'hacked_review' };
  if (await whatsappScreen(page)) {
    await markWhatsappConfirm(nome);
    return { ok: false, error: 'whatsapp_confirm', terminal: 'whatsapp_confirm' };
  }

  const switched = await leaveOtherDeviceApproval(page, nome);
  if (switched && switched.ok === false) return { ok: false, error: switched.error || 'other_device_switch_failed' };
  const auth = await passAuthenticatorCode(page, nome);
  if (auth && auth.error === 'auth_app_no_secret') return { ok: false, error: 'auth_app_no_secret' };
  const trust = await clickTrustThisDevice(page, nome);
  if (auth && auth.asked && !auth.ok && !(trust && trust.clicked)) {
    return { ok: false, error: auth.error || 'auth_app_code_failed' };
  }

  if (await whatsappScreen(page)) {
    await markWhatsappConfirm(nome);
    return { ok: false, error: 'whatsapp_confirm', terminal: 'whatsapp_confirm' };
  }
  if (blockedSaveUrl(pageUrl(page)) || await loginFormStillVisible(page) || await badLoginText(page) || await humanConfirmScreen(page) || await hackedScreen(page)) {
    return { ok: false, error: 'login_not_accepted' };
  }
  const saved = await persistFreshSessionCookies(page, nome);
  if (!saved || saved.ok !== true) return { ok: false, error: (saved && saved.reason) || 'session_not_saved' };
  return { ok: true };
}

module.exports = {
  tryExistingPcSession,
  attemptCredentialRelogin,
  passAuthenticatorCode,
  readTotpSecret,
  clickTrustThisDevice,
  watchAndSolveLoginCheckbox,
  persistFreshSessionCookies,
  collectFreshCookies,
  humanConfirmScreen,
  hackedScreen,
  whatsappScreen,
  markWhatsappConfirm,
  openFreshLoginPage
};
