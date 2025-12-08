// scripts/virtusDom.js

'use strict';

const stepLog = require('./stepLog.js');
const logger = require('./logger.js');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function garantirMarketplace(page, { timeoutMs = 25000 } = {}) {
  if (!page || typeof page.url !== 'function') throw new Error('Page inválida');
  let url = '';
  try { url = page.url() || ''; } catch {}
  if (!/messenger.com\/marketplace/i.test(url)) {
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
  }
  // Cura nonce/continuar como
  try {
    const browserJs = require('./browser.js');
    if (browserJs && typeof browserJs.resolveNonceIfPresent === 'function') {
      await browserJs.resolveNonceIfPresent(page).catch(()=>{});
    }
    if (browserJs && typeof browserJs.clickContinuarComo === 'function') {
      await browserJs.clickContinuarComo(page, { timeout: 12000 }).catch(()=>{});
    }
  } catch {}
  // Espera por algum grid/anchor
  const ok = await Promise.race([
    page.waitForFunction(() => {
      const hasAnchor = !!document.querySelector('a[href^="/marketplace/t/"]');
      const hasGrid = !!document.querySelector('div[role="grid"]') || !!document.querySelector('div[role="rowgroup"]');
      const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
      return hasAnchor || hasGrid || hasRow;
    }, { timeout: timeoutMs }),
    page.waitForSelector('a[href^="/marketplace/t/"]', { timeout: timeoutMs }).catch(() => null)
  ]);
  if (!ok) throw new Error('Marketplace UI não ficou pronta a tempo');
}

async function scrollChatsToTop(page, nome='') {
  try {
    const b = (typeof page.browser === 'function') ? page.browser() : null;
    if (b && ((b._sendLock && b._sendLock.active) || (b._virtusCritical && b._virtusCritical.active))) {
      return false;
    }
  } catch {}
  if (!page) return false;
  try {
    const res = await page.evaluate(() => {
      let grid = document.querySelector('div[role="grid"]');
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf[data-virtualized="false"]');
      if (!grid) grid = document.querySelector('div[role="rowgroup"]');
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf');
      if (!grid) grid = Array.from(document.querySelectorAll('div')).find(d => d.scrollHeight > 400 && d.scrollHeight > d.clientHeight + 30);
      if (!grid) grid = document.body;
      if (!grid) return false;
      grid.scrollTop = 0;
      let node = grid.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if (node.scrollHeight > node.clientHeight + 30) node.scrollTop = 0;
        node = node.parentElement;
      }
      setTimeout(() => { if (grid.scrollTop > 0) grid.scrollTop = 0; }, 250);
      return grid.scrollTop === 0;
    });
    return !!res;
  } catch (err) {
    return false;
  }
}

async function findScrollContainerSelector(p) {
  try {
    const sel = await p.evaluate(() => {
      const cands = ['div[role="grid"]','div[role="rowgroup"]','div.x78zum5.xdt5ytf'];
      for (const s of cands) {
        const el = document.querySelector(s);
        if (el && el.scrollHeight > el.clientHeight) return s;
      }
      return 'body';
    });
    return sel || 'body';
  } catch { return 'body'; }
}

async function waitForChatAnchor(p, chatId, { timeoutMs = 12000 } = {}) {
  const sel = `a[href^="/marketplace/t/${chatId}"]`;
  const t0 = Date.now();
  while ((Date.now() - t0) < timeoutMs) {
    const h = await p.$(sel).catch(()=>null);
    if (h) return h;
    // Scroll incremental
    try {
      const contSel = await findScrollContainerSelector(p);
      await p.evaluate((selector) => {
        const el = document.querySelector(selector) || document.scrollingElement || document.body;
        if (!el) return;
        const delta = Math.max(400, Math.floor(el.clientHeight * 0.8));
        el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight);
      }, contSel);
    } catch {}
    await sleep(200);
  }
  return null;
}

async function clickChatInFeed(p, chatId, { timeoutMs = 20000, attemptId = null, nome = 'GLOBAL' } = {}) {
  await garantirMarketplace(p, { timeoutMs: 25000 }).catch(()=>{});
  stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId || stepLog.attemptId(), step: 'open_click_begin', chatId });
  try { await scrollChatsToTop(p, nome); } catch {}
  await sleep(200);

  const anchor = await waitForChatAnchor(p, chatId, { timeoutMs: 16000 });
  if (!anchor) {
    stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId || stepLog.attemptId(), step: 'open_click_anchor_missing', chatId });
    return false;
  }
  stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId || stepLog.attemptId(), step: 'open_click_anchor_found', chatId });
  try {
    await p.evaluate((el) => {
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, anchor);
  } catch {
    try { await anchor.click({ delay: 50 }); } catch {}
  }
  const okPath = await p.evaluate((id)=>location.pathname.includes('/marketplace/t/'+id), chatId).catch(()=>false);
  if (!okPath) {
    const ready = await ensureConversationReady(p, chatId, { timeoutMs: 16000 });
    if (!ready) {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId || stepLog.attemptId(), step: 'open_click_thread_failed', chatId });
      return false;
    }
  }
  stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId || stepLog.attemptId(), step: 'open_click_thread_active', chatId });
  return true;
}

async function ensureConversationReady(p, chatId, { timeoutMs = 20000 } = {}) {
  try {
    const browserJs = require('./browser.js');
    await browserJs.resolveNonceIfPresent(p).catch(()=>{});
    await browserJs.clickContinuarComo(p, { timeout: 8000 }).catch(()=>{});
  } catch {}
  const selConversation = [
    'div[aria-label^="Mensagens na conversa"]',
    'div[role="grid"][aria-label*="conversa"]',
    'div[role="grid"][aria-label*="Mensagens"]'
  ];
  for (const sel of selConversation) {
    const h = await p.waitForSelector(sel, { timeout: timeoutMs }).catch(()=>null);
    if (h) return true;
  }
  return await p.waitForFunction(() => {
    const a = document.querySelector('div[aria-label^="Mensagens na conversa"]');
    const b = document.querySelector('div[role="grid"][aria-label]');
    return !!(a || b);
  }, { timeout: timeoutMs }).then(()=>true).catch(()=>false);
}

async function scrapeChatHistory(p) {
  try {
    await p.waitForFunction(() =>
      Array.from(document.querySelectorAll('div[dir="auto"]')).some(d => (d.innerText || d.textContent || '').trim().length > 0),
      { timeout: 4000 }
    ).catch(()=>{});
  } catch {}
  try {
    return await p.evaluate(() => {
      function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }catch{return String(s||'').trim();} }
      const candidates = Array.from(document.querySelectorAll('div[dir="auto"]'))
        .map(el => ({
          text: norm(el.innerText || el.textContent || ''),
          el
        }))
        .filter(x => x.text && x.text.length > 0);
      const rows = Array.from(document.querySelectorAll('div[role="row"]')).slice(-200);
      const meHints = new Set();
      rows.forEach(r => {
        const t = norm(r.innerText || r.textContent || '');
        if (/voce enviou|você enviou|you sent/i.test(t)) meHints.add(r);
      });
      function isMine(el) {
        try {
          let n = el;
          for (let i=0; i<6 && n; i++, n = n.parentElement) {
            if (meHints.has(n)) return true;
          }
          const st = window.getComputedStyle(el.closest('div[role="row"]') || el);
          const jc = (st && st.justifyContent) || '';
          const ta = (st && st.textAlign) || '';
          return (jc.includes('flex-end') || ta === 'right');
        } catch { return false; }
      }
      const blacklist = /^(inserir|saiba mais|thiago iniciou essa conversa|mensagem enviada|cuidado com golpes|ver perfil do comprador)$/i;
      const msgs = [];
      for (const c of candidates.slice(-120)) {
        if (!c.text || blacklist.test(c.text)) continue;
        const autor = isMine(c.el) ? 'ia' : 'cliente';
        msgs.push({ autor, texto: c.text });
      }
      return msgs.slice(-30);
    });
  } catch {
    return [];
  }
}

async function waitForComposer(p, timeoutMs = 10000) {
  const COMPOSER_SELECTORS = [
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
    'div[role="combobox"][contenteditable="true"]',
    'div[aria-label="Mensagem"]',
    'div[aria-label*="mensagem"]'
  ];
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    for (const sel of COMPOSER_SELECTORS) {
      try {
        const h = await p.$(sel);
        if (h) {
          const ok = await p.evaluate(el => {
            const st = window.getComputedStyle(el);
            const vis = st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
            const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
            return vis && !disabled;
          }, h);
          if (ok) return h;
        }
      } catch {}
    }
    await sleep(250);
  }
  return null;
}

async function sendMessageSafe(p, campo, msg, nome, chatId) {
  try {
    if (!campo || (await campo.evaluate(el => !el.isConnected).catch(()=>true))) {
      const sels = [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][aria-label]',
        'div[contenteditable="true"]',
        'div[role="combobox"][contenteditable="true"]',
        'div[aria-label="Mensagem"]',
        'div[aria-label*="mensagem"]'
      ];
      for (const sel of sels) {
        const h = await p.$(sel).catch(()=>null);
        if (h) {
          const ok = await h.evaluate(el => {
            const st = window.getComputedStyle(el);
            return el.isConnected && st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
          }).catch(()=>false);
          if (ok) { campo = h; break; }
        }
      }
    }
  } catch {}
  if (!campo) throw new Error('composer_missing');

  if (!(await p.evaluate((id) => {
    try { return location.pathname.includes(`/marketplace/t/`+id); }
    catch { return false; }
  }, chatId).catch(()=>false))) {
    throw new Error('not_on_thread');
  }

  const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';

  try { stepLog.appendJSONL(nome, 'virtus', { step: 'composer_guard_begin', chatId }); } catch {}
  try {
    await campo.click({ delay: 20 }).catch(()=>{});
    try {
      await p.keyboard.down(ctrlKey);
      await p.keyboard.press('KeyA');
      await p.keyboard.up(ctrlKey);
    } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
    await p.waitForFunction(
      el => ((el.innerText || el.textContent || '').trim().length === 0),
      { timeout: 1200 },
      campo
    ).catch(()=>{});

    await p.keyboard.type(String(msg || ''), { delay: 0 });
    if (!(await p.evaluate((id) => location.pathname.includes(`/marketplace/t/`+id), chatId).catch(()=>false))) {
      throw new Error('not_on_thread_before_enter');
    }
    await p.keyboard.press('Enter');

    // Confirma envio bolha "Você enviou" ou composer vazio
    const sent = await Promise.race([
      (async () => {
        try {
          return await p.waitForFunction(() => {
            const norm = s => String(s||'').toLowerCase();
            const nodes = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-25);
            return nodes.some(el => /you\s+sent|v[ou]c[eê]\s+enviou/.test(norm(el.innerText||el.textContent||'')));
          }, { timeout: 7000 }).then(()=>true).catch(()=>false);
        } catch { return false; }
      })(),
      (async () => {
        try {
          return await p.waitForFunction((el) => ((el.innerText || el.textContent || '').trim().length === 0), { timeout: 7000 }, campo)
            .then(()=>true).catch(()=>false);
        } catch { return false; }
      })()
    ]);
    if (!sent) {
      throw new Error('send_confirmation_timeout');
    }
  } finally {
    try { stepLog.appendJSONL(nome, 'virtus', { step: 'composer_guard_end', chatId }); } catch {}
  }
}

module.exports = {
  garantirMarketplace,
  clickChatInFeed,
  ensureConversationReady,
  scrapeChatHistory,
  waitForComposer,
  sendMessageSafe,
  scrollChatsToTop
};

