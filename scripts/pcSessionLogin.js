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

async function watchAndSolveLoginCheckbox(page, nome) {
  const enterprise = require('./recaptchaEnterprisePage.js');
  const deadline = Date.now() + 30000;
  let widget = null;
  while (Date.now() < deadline) {
    const url = pageUrl(page);
    if (!onLoginOrTwoStep(url) && !onAuthentication(url)) return { ok: true, skipped: true };
    widget = await readWidget(page);
    if (widget && widget.sitekey) break;
    await sleep(1500);
  }
  const urlNow = pageUrl(page);
  if (!onLoginOrTwoStep(urlNow) && !onAuthentication(urlNow)) return { ok: true, skipped: true };
  if (!widget || !widget.sitekey) {
    if (!onAuthentication(urlNow)) return { ok: true, skipped: true };
    return { ok: false, reason: 'no_sitekey' };
  }

  const first = await enterprise.solveOnce(page, { nome, attempt: 1, timeoutMs: 90_000 });
  const firstApplied = !!(first && first.applied && (first.applied.areas || first.applied.called));
  if (await waitUntilLeaveAuthentication(page, firstApplied ? 20000 : 4000)) {
    return { ok: true, solved: true };
  }
  if (firstApplied || captchaBuyStop(first && first.error)) {
    if (await waitUntilLeaveAuthentication(page, 15000)) return { ok: true, solved: true };
    return { ok: false, reason: (first && first.error) || 'still_on_authentication' };
  }
  if (!first || first.ok !== true) {
    const second = await enterprise.solveOnceV2(page, { nome, timeoutMs: 90_000 });
    const secondApplied = !!(second && second.applied && (second.applied.areas || second.applied.called));
    if (await waitUntilLeaveAuthentication(page, secondApplied ? 20000 : 8000)) {
      return { ok: true, solved: true };
    }
    return { ok: false, reason: (second && second.error) || (first && first.error) || 'recaptcha_failed' };
  }
  if (await waitUntilLeaveAuthentication(page, 15000)) return { ok: true, solved: true };
  return { ok: false, reason: 'still_on_authentication' };
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
      const hint = `${input.getAttribute('aria-label') || ''} ${input.getAttribute('name') || ''} ${input.getAttribute('placeholder') || ''}`.toLowerCase();
      return hint.includes('code') || hint.includes('codigo') || hint.includes('código') || input.type === 'tel' || input.inputMode === 'numeric';
    });
    if (one) {
      one.setAttribute('data-cc-auth-code', 'one');
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
    const wanted = ['continuar', 'continue', 'confirmar', 'avancar'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a, div, span'));
    for (const label of wanted) {
      for (const el of nodes) {
        if (el.disabled) continue;
        const text = n(el.getAttribute('aria-label') || el.innerText || el.value || '');
        if (text !== label) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 48 || r.height < 18) continue;
        try { el.click(); return true; } catch {}
      }
    }
    return false;
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
  let kind = await markAuthField(page);
  if (!kind) {
    await sleep(800);
    kind = await markAuthField(page);
  }
  if (!kind) return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
  let code = '';
  try { code = await freshTotp(secret); } catch { code = ''; }
  if (!/^\d{6}$/.test(code)) return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
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
    const url = pageUrl(page);
    const still = /two_step_verification\/two_factor|\/two_factor\//i.test(url);
    const field = await markAuthField(page);
    if (!field && !still) return { ok: true, outcome: 'auth_app_ok' };
    return { ok: false, outcome: 'failed', error: 'auth_app_code_failed' };
  }
  await sleep(800);
  return { ok: true, outcome: 'auth_app_ok' };
}

async function passAuthenticatorCode(page, nome) {
  const url = pageUrl(page);
  const text = await pageText(page);
  const asked = /\/two_factor\/|two_step_verification\/two_factor/i.test(url)
    || text.includes('app de autenticacao')
    || text.includes('authentication app')
    || text.includes('aplicativo de autenticacao')
    || text.includes('codigo de autenticacao');
  if (!asked) return { asked: false, ok: true };
  const auth = await confirmAuthApp(page, nome);
  if (!auth || auth.ok === false) {
    return { asked: true, ok: false, error: (auth && auth.error) || 'auth_app_code_failed' };
  }
  return { asked: true, ok: true };
}

async function clickTrustThisDevice(page, nome) {
  const seen = await page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
      catch { return String(s || '').toLowerCase(); }
    }
    const url = String(location.href || '');
    const txt = n((document.body && (document.body.innerText || '')) || '');
    return url.indexOf('remember_browser') >= 0 || txt.indexOf('confiar neste dispositivo') >= 0 || txt.indexOf('trust this device') >= 0;
  }).catch(() => false);
  if (!seen) return { seen: false, clicked: false };
  const clicked = await page.evaluate(() => {
    function n(s) {
      try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }
      catch { return String(s || '').toLowerCase(); }
    }
    const wanted = ['confiar neste dispositivo', 'trust this device'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], div, span, [tabindex="0"]'));
    const hits = [];
    for (const el of nodes) {
      if (el.disabled) continue;
      const text = n(el.innerText || el.getAttribute('aria-label') || '');
      if (!text || text.indexOf('sempre confirmar') >= 0 || text.indexOf('always confirm') >= 0) continue;
      const exact = wanted.some((w) => text === w);
      if (!exact && !wanted.some((w) => text.indexOf(w) >= 0)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 16) continue;
      hits.push({ el, area: r.width * r.height, exact });
    }
    if (!hits.length) return false;
    hits.sort((a, b) => (a.exact === b.exact ? a.area - b.area : (a.exact ? -1 : 1)));
    try { hits[0].el.click(); return true; } catch { return false; }
  }).catch(() => false);
  if (!clicked) return { seen: true, clicked: false };
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    if (!/remember_browser/i.test(pageUrl(page))) break;
    await sleep(400);
  }
  return { seen: true, clicked: true, left: !/remember_browser/i.test(pageUrl(page)) };
}

async function waitForLoginImageCaptcha(page) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const image = await page.$('img[src*="/captcha/tfbimage/"]').catch(() => null);
    if (image) return image;
    const url = pageUrl(page);
    if (!onLoginOrTwoStep(url) && !/checkpoint/i.test(url)) return null;
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

  const box = await watchAndSolveLoginCheckbox(page, nome);
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

  const auth = await passAuthenticatorCode(page, nome);
  if (auth && auth.asked && !auth.ok) return { ok: false, error: auth.error || 'auth_app_code_failed' };
  await clickTrustThisDevice(page, nome);
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await sleep(800);

  const boxAgain = await watchAndSolveLoginCheckbox(page, nome);
  if (boxAgain && boxAgain.ok === false) return { ok: false, error: boxAgain.reason || 'recaptcha_failed' };

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
