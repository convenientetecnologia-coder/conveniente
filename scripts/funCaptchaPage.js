'use strict';

const logger = require('./logger.js');
const provisionAudit = require('./provisionAudit.js');

const DEFAULT_SUBDOMAIN = 'meta-api.arkoselabs.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function funLog(level, msg, ctx) {
  const safe = ctx && typeof ctx === 'object' ? ctx : {};
  try { logger[level === 'warn' ? 'warn' : 'info'](msg, safe); } catch {}
  try {
    provisionAudit.append({ ts: Date.now(), event: 'funcaptcha', level: level || 'info', msg, ...safe });
  } catch {}
}

function normText(raw) {
  try { return String(raw || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  catch { return String(raw || '').toLowerCase(); }
}

function pageUrl(page) {
  try { return (typeof page.url === 'function') ? String(page.url() || '') : ''; }
  catch { return ''; }
}

async function pageText(page) {
  const raw = await page.evaluate(() => String((document.body && (document.body.innerText || document.body.textContent)) || '')).catch(() => '');
  return normText(raw);
}

function securityVerificationText(text) {
  const t = normText(text);
  return t.includes('executando verificacoes de seguranca')
    || t.includes('aguarde enquanto verificamos essa tentativa de login')
    || t.includes('complete um desafio para verificar se voce e humano')
    || t.includes('resolva um quebra-cabeca para continuar');
}

function accountHumanStopText(text) {
  const t = normText(text);
  const human = t.includes('confirme que voce e humano') || t.includes('confirm you are human') || t.includes('confirm that you are human');
  const account = t.includes('para usar sua conta') || t.includes('para usar seu perfil') || t.includes('to use your account') || t.includes('to use your profile');
  return human && account;
}

function funRejectedText(text) {
  const t = normText(text);
  return t.includes('falha na confirmacao')
    || t.includes('dispositivo que voce ja usou')
    || t.includes('confirmation failed')
    || t.includes('device you already used')
    || t.includes('device you\'ve already used');
}

async function bothLoginFieldsVisible(page) {
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

function isArkoseUrl(url) {
  const u = String(url || '').toLowerCase();
  return u.includes('arkoselabs') || u.includes('arkose') || u.includes('/captcha/arkose');
}

function pkFromUrl(src) {
  const raw = String(src || '');
  let pk = '';
  try { pk = new URL(raw).searchParams.get('pk') || ''; }
  catch {
    const m = raw.match(/[?&]pk=([^&#]+)/i);
    if (m) {
      try { pk = decodeURIComponent(m[1]); } catch { pk = m[1]; }
    }
  }
  pk = String(pk || '').trim();
  if (pk.length < 32 || pk.length > 40) return '';
  return pk;
}

function hostFromUrl(src) {
  try { return new URL(String(src || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function websiteUrlFor(url) {
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch {}
  if (host === 'm.facebook.com' || host === 'mbasic.facebook.com') return 'https://m.facebook.com/login/';
  if (host === 'www.facebook.com') return 'https://www.facebook.com/login/';
  if (host.startsWith('m.') || host.startsWith('mbasic.')) return 'https://m.facebook.com/login/';
  return 'https://www.facebook.com/login/';
}

async function securityVerificationScreen(page) {
  if (await bothLoginFieldsVisible(page)) return false;
  const text = await pageText(page);
  if (accountHumanStopText(text)) return false;
  return securityVerificationText(text);
}

async function readArkose(page) {
  const frames = (page && typeof page.frames === 'function') ? page.frames() : [];
  let publicKey = '';
  let subdomain = '';
  for (const frame of frames) {
    let src = '';
    try { src = typeof frame.url === 'function' ? String(frame.url() || '') : ''; } catch {}
    if (!isArkoseUrl(src)) continue;
    if (!publicKey) publicKey = pkFromUrl(src);
    const host = hostFromUrl(src);
    if (!subdomain && host.includes('arkoselabs.com')) subdomain = host;
    if (!publicKey) {
      const fromHtml = await frame.evaluate(() => {
        const html = document.documentElement ? String(document.documentElement.innerHTML || '') : '';
        const m = html.match(/publicKey["']?\s*[:=]\s*["']([A-Za-z0-9-]{32,40})["']/i);
        return m ? m[1] : '';
      }).catch(() => '');
      if (fromHtml && fromHtml.length >= 32 && fromHtml.length <= 40) publicKey = fromHtml;
    }
  }
  if (!publicKey || !subdomain) {
    const srcs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('iframe')).map((el) => el.src || el.getAttribute('src') || '');
    }).catch(() => []);
    for (const src of srcs || []) {
      if (!isArkoseUrl(src)) continue;
      if (!publicKey) publicKey = pkFromUrl(src);
      const host = hostFromUrl(src);
      if (!subdomain && host.includes('arkoselabs.com')) subdomain = host;
    }
  }
  if (!subdomain) subdomain = DEFAULT_SUBDOMAIN;
  return { publicKey, subdomain };
}

async function readArkoseWithPatience(page) {
  let widget = { publicKey: '', subdomain: DEFAULT_SUBDOMAIN };
  for (let i = 0; i < 4; i++) {
    widget = await readArkose(page);
    if (widget && widget.publicKey) return widget;
    if (i < 3) await sleep(1000);
  }
  return widget;
}

async function applyFunToken(page, token) {
  const frames = (page && typeof page.frames === 'function') ? page.frames() : [];
  const targets = frames.length ? frames : [page];
  let called = false;
  let filled = false;
  for (const frame of targets) {
    const res = await frame.evaluate((value) => {
      let didCall = false;
      let didFill = false;
      try {
        if (typeof window.successCallback === 'function') {
          window.successCallback(value);
          didCall = true;
        }
      } catch (e) {}
      const nodes = Array.from(document.querySelectorAll('input[name="fc-token"], input[name="verification-token"], #FunCaptcha-Token'));
      for (const el of nodes) {
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        didFill = true;
      }
      return { didCall, didFill };
    }, token).catch(() => null);
    if (res && res.didCall) called = true;
    if (res && res.didFill) filled = true;
  }
  return { called, filled, applied: called || filled };
}

async function waitAfterFunToken(page) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const text = await pageText(page);
    if (funRejectedText(text)) return 'rejected';
    if (!securityVerificationText(text)) return 'passed';
    await sleep(400);
  }
  const text = await pageText(page);
  if (funRejectedText(text)) return 'rejected';
  if (!securityVerificationText(text)) return 'passed';
  return 'still';
}

function buyStop(error) {
  return error === 'anticaptcha_key_missing'
    || error === 'anticaptcha_config_missing'
    || error === 'ERROR_ZERO_BALANCE'
    || error === 'ERROR_KEY_DOES_NOT_EXIST';
}

async function watchAndSolveFunCaptcha(page, nome) {
  if (accountHumanStopText(await pageText(page))) return { ok: false, reason: 'human_confirm' };
  if (!(await securityVerificationScreen(page))) return { ok: true, skipped: true };

  let purchases = 0;
  while (purchases < 2) {
    if (funRejectedText(await pageText(page))) return { ok: false, reason: 'funcaptcha_rejected' };
    if (!(await securityVerificationScreen(page))) return { ok: true, solved: purchases > 0 };
    const widget = await readArkoseWithPatience(page);
    if (!widget || !widget.publicKey) {
      funLog('warn', '[LOGIN][pc] verificacao Arkose sem chave publica no quadro', { nome: nome || '' });
      return { ok: false, reason: 'funcaptcha_no_key' };
    }
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
    const websiteURL = websiteUrlFor(pageUrl(page));
    funLog('info', '[LOGIN][pc] verificacao Arkose. Compro o token sem abrir o jogo.', {
      nome: nome || '',
      attempt: purchases + 1,
      keyLen: widget.publicKey.length,
      subdomain: widget.subdomain,
      page: websiteURL
    });
    const solved = await require('./antiCaptchaClient.js').solveFunCaptcha({
      websiteURL,
      websitePublicKey: widget.publicKey,
      funcaptchaApiJSSubdomain: widget.subdomain,
      userAgent,
      timeoutMs: 120000
    });
    purchases += 1;
    if (buyStop(solved && solved.error)) {
      funLog('warn', '[LOGIN][pc] verificacao Arkose parou na API', { nome: nome || '', error: solved.error });
      return { ok: false, reason: solved.error };
    }
    const token = solved && solved.ok ? String(solved.token || '') : '';
    if (token.length < 20) {
      funLog('warn', '[LOGIN][pc] verificacao Arkose nao devolveu token', { nome: nome || '', error: (solved && solved.error) || 'empty_token' });
      if (funRejectedText(await pageText(page))) return { ok: false, reason: 'funcaptcha_rejected' };
      if (await securityVerificationScreen(page) && purchases < 2) continue;
      if (await securityVerificationScreen(page)) return { ok: false, reason: (solved && solved.error) || 'funcaptcha_failed' };
      return { ok: true, skipped: true };
    }
    const applied = await applyFunToken(page, token);
    funLog(applied.applied ? 'info' : 'warn', '[LOGIN][pc] token Arkose aplicado', {
      nome: nome || '',
      called: !!applied.called,
      filled: !!applied.filled
    });
    if (!applied.applied) {
      if (funRejectedText(await pageText(page))) return { ok: false, reason: 'funcaptcha_rejected' };
      if (await securityVerificationScreen(page) && purchases < 2) continue;
      if (await securityVerificationScreen(page)) return { ok: false, reason: 'token_not_applied' };
      return { ok: true, skipped: true };
    }
    const verdict = await waitAfterFunToken(page);
    if (verdict === 'passed') {
      funLog('info', '[LOGIN][pc] verificacao Arkose saiu', { nome: nome || '' });
      return { ok: true, solved: true };
    }
    if (verdict === 'rejected') {
      funLog('warn', '[LOGIN][pc] Facebook recusou o token Arkose', { nome: nome || '' });
      return { ok: false, reason: 'funcaptcha_rejected' };
    }
    if (purchases >= 2) {
      funLog('warn', '[LOGIN][pc] verificacao Arkose continua depois da segunda compra', { nome: nome || '' });
      return { ok: false, reason: 'funcaptcha_still_there' };
    }
  }
  return { ok: false, reason: 'funcaptcha_still_there' };
}

module.exports = {
  pkFromUrl,
  websiteUrlFor,
  securityVerificationText,
  securityVerificationScreen,
  watchAndSolveFunCaptcha
};
