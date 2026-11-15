'use strict';

const logger = require('./logger.js');

function originFromCo(co) {
  const raw = String(co || '').trim();
  if (!raw) return '';
  try {
    let b = raw.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const decoded = Buffer.from(b, 'base64').toString('utf8');
    const m = decoded.match(/^(https?:\/\/[^/:]+)/i);
    return m ? (m[1] + '/') : '';
  } catch {
    return '';
  }
}

async function readEnterpriseS(page) {
  const frames = [];
  try { frames.push.apply(frames, page.frames()); } catch {}
  let best = '';
  for (let i = 0; i < frames.length; i++) {
    let found = '';
    try {
      found = await frames[i].evaluate(() => {
        const html = String((document.documentElement && document.documentElement.innerHTML) || '');
        const patterns = [
          /[?&]s=([^&"'<>\s]{8,})/,
          /data-s="([^"]{8,})"/,
          /"s"\s*:\s*"([^"]{8,})"/
        ];
        for (let p = 0; p < patterns.length; p++) {
          const m = html.match(patterns[p]);
          if (m && m[1]) return m[1];
        }
        const el = document.querySelector('[data-s]');
        return (el && el.getAttribute('data-s')) || '';
      });
    } catch {}
    if (found && found.length > best.length) best = found;
  }
  return best;
}

async function readWidget(page) {
  let fromDom = await page.evaluate(() => {
    const iframe = document.querySelector(
      'iframe[src*="recaptcha/enterprise"], iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha/api2"], iframe[src*="recaptcha.net"]'
    );
    let sitekey = '';
    let s = '';
    let size = '';
    let anchorPath = '';
    let enterprise = false;
    let source = 'missing';
    if (iframe && iframe.src) {
      try {
        const u = new URL(iframe.src, location.href);
        sitekey = u.searchParams.get('k') || '';
        s = u.searchParams.get('s') || '';
        size = u.searchParams.get('size') || '';
        anchorPath = u.host + u.pathname;
        enterprise = u.pathname.indexOf('enterprise') >= 0;
        if (sitekey) source = 'iframe';
      } catch {}
    }
    if (!sitekey) {
      const el = document.querySelector('[data-sitekey]');
      if (el) {
        sitekey = el.getAttribute('data-sitekey') || '';
        if (sitekey) source = 'data-sitekey';
      }
    }
    return { sitekey, s, size, url: String(location.href || '').split('#')[0], source, anchorPath, enterprise };
  }).catch(() => null);

  const framePaths = [];
  let anchorOrigin = '';
  try {
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    for (const frame of frames) {
      const src = String(frame.url() || '');
      let path = 'about:blank';
      let sitekey = '';
      let s = '';
      let size = '';
      let enterprise = false;
      if (src && src !== 'about:blank') {
        try {
          const u = new URL(src);
          path = u.host + u.pathname;
          if (/google\.com\/recaptcha|recaptcha\.net\/recaptcha/i.test(src)) {
            sitekey = u.searchParams.get('k') || '';
            s = u.searchParams.get('s') || '';
            size = u.searchParams.get('size') || '';
            enterprise = u.pathname.indexOf('enterprise') >= 0;
            if (!anchorOrigin) anchorOrigin = originFromCo(u.searchParams.get('co'));
          }
        } catch {
          path = src.split('?')[0].slice(0, 80);
        }
      }
      framePaths.push(path);
      if (sitekey && !(fromDom && fromDom.sitekey)) {
        fromDom = {
          sitekey, s, size,
          url: String(page.url() || '').split('#')[0],
          source: 'frame',
          anchorPath: path,
          enterprise
        };
      }
    }
  } catch {}
  const widget = fromDom || { sitekey: '', s: '', size: '', url: '', source: 'missing', anchorPath: '', enterprise: false };
  widget.frames = framePaths.slice(0, 12);
  widget.coOrigin = anchorOrigin || '';
  // www.facebook.com e m.facebook.com voltam domínio inválido se a compra for em fbsbx.
  // O domínio que a API aceita é o do quadro, gravado no parâmetro co.
  widget.websiteURL = anchorOrigin || 'https://www.fbsbx.com/';
  if (!widget.s) {
    const fromFrame = await readEnterpriseS(page);
    if (fromFrame) widget.s = fromFrame;
  }
  return widget;
}

function framePath(frame) {
  try {
    const raw = String((frame && frame.url && frame.url()) || '');
    if (!raw || raw === 'about:blank') return 'about:blank';
    const u = new URL(raw);
    return (u.host + u.pathname).slice(0, 120);
  } catch {
    return 'about:blank';
  }
}

function applyTokenInDocument(value) {
  const areas = document.querySelectorAll('#g-recaptcha-response, textarea[name="g-recaptcha-response"], textarea.g-recaptcha-response');
  const setter = window.HTMLTextAreaElement && Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  areas.forEach((el) => {
    try {
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
    } catch {
      try { el.value = value; } catch {}
    }
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
  });
  let called = 0;
  const used = new Set();
  function invoke(fn) {
    if (typeof fn !== 'function' || used.has(fn)) return;
    used.add(fn);
    try { fn(value); called += 1; } catch {}
  }
  const named = document.querySelector('[data-callback]');
  const cbName = named && named.getAttribute('data-callback');
  if (cbName && typeof window[cbName] === 'function') invoke(window[cbName]);
  const cfg = window.___grecaptcha_cfg;
  const seen = new Set();
  function walk(obj, depth) {
    if (!obj || depth > 8 || typeof obj !== 'object') return;
    if (obj === window || obj === document || obj.nodeType) return;
    if (seen.has(obj)) return;
    seen.add(obj);
    if (typeof obj.callback === 'function') invoke(obj.callback);
    let keys;
    try { keys = Object.keys(obj); } catch { return; }
    for (let i = 0; i < keys.length && i < 40; i++) {
      const child = obj[keys[i]];
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  }
  if (cfg && cfg.clients) walk(cfg.clients, 0);
  return { areas: areas.length, called, dataCallback: cbName || '', hasClients: !!(cfg && cfg.clients), hasWidget: !!(cfg || window.grecaptcha) };
}

async function applyToken(page, token) {
  const frames = [];
  try { frames.push.apply(frames, page.frames()); } catch {}
  const hits = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    let result = null;
    try { result = await frame.evaluate(applyTokenInDocument, token); } catch { continue; }
    if (!result || (!result.areas && !result.called && !result.hasClients && !result.hasWidget)) continue;
    hits.push({
      path: framePath(frame),
      areas: result.areas || 0,
      called: result.called || 0,
      dataCallback: result.dataCallback || '',
      hasClients: !!result.hasClients
    });
  }
  const placed = hits.filter((h) => h.areas || h.called);
  const best = placed[0] || hits[0] || null;
  return {
    areas: placed.reduce((sum, h) => sum + h.areas, 0),
    called: placed.reduce((sum, h) => sum + h.called, 0),
    dataCallback: (best && best.dataCallback) || '',
    hasClients: hits.some((h) => h.hasClients),
    frame: (best && best.path) || ''
  };
}

async function solveOnce(page, { nome, timeoutMs = 90_000, attempt } = {}) {
  const widget = await readWidget(page);
  if (!widget || !widget.sitekey) {
    return { ok: false, error: 'no_sitekey', widget };
  }
  logger.info('[RECAPTCHA] widget lido', {
    nome,
    attempt: attempt || 1,
    source: widget.source || '',
    sitekeyLen: String(widget.sitekey).length
  });
  const anti = require('./antiCaptchaClient.js');
  let userAgent = '';
  try { userAgent = await page.evaluate(() => navigator.userAgent); } catch {}
  const buy = {
    websiteURL: captchaWebsiteUrl(widget.websiteURL),
    websiteKey: widget.sitekey,
    enterpriseS: widget.s,
    isInvisible: widget.size === 'invisible',
    userAgent,
    timeoutMs
  };
  const solved = await anti.solveRecaptchaEnterprise(buy);
  if (!solved || !solved.ok) return Object.assign({ widget }, solved || { ok: false, error: 'anticaptcha_failed' });
  const applied = await applyToken(page, solved.token);
  if (!(applied && applied.areas) && !(applied && applied.called)) {
    return { ok: false, error: 'token_not_applied', taskId: solved.taskId, widget };
  }
  return { ok: true, taskId: solved.taskId, cost: solved.cost, applied, widget };
}

function captchaWebsiteUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return 'https://www.fbsbx.com/';
  if (/^https?:\/\/([a-z0-9-]+\.)?facebook\.com/i.test(raw)) return 'https://www.fbsbx.com/';
  return raw;
}

async function solveOnceV2(page, opts) {
  const widget = await readWidget(page);
  if (!widget || !widget.sitekey) return { ok: false, error: 'no_sitekey', widget };
  const anti = require('./antiCaptchaClient.js');
  let userAgent = '';
  try { userAgent = await page.evaluate(() => navigator.userAgent); } catch {}
  const solved = await anti.solveRecaptchaV2({
    websiteURL: captchaWebsiteUrl(widget.websiteURL),
    websiteKey: widget.sitekey,
    enterpriseS: widget.s,
    isInvisible: widget.size === 'invisible',
    userAgent,
    timeoutMs: opts && opts.timeoutMs
  });
  if (!solved || !solved.ok) return Object.assign({ widget }, solved || { ok: false, error: 'anticaptcha_failed' });
  const applied = await applyToken(page, solved.token);
  if (!(applied && applied.areas) && !(applied && applied.called)) {
    return { ok: false, error: 'token_not_applied', taskId: solved.taskId, widget, applied };
  }
  return { ok: true, taskId: solved.taskId, cost: solved.cost, applied, widget };
}

module.exports = { readWidget, applyToken, solveOnce, solveOnceV2 };
