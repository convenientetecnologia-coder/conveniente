'use strict';

function inspect() {
  const visible = el => {
    if (!el || el.disabled || el.closest('[aria-hidden="true"],[inert]')) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 2 && r.height > 2 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  if (!document.body || document.readyState === 'loading') return { kind: 'loading' };
  const text = String(document.body.innerText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/err_(internet_disconnected|proxy_connection_failed|tunnel_connection_failed|connection_reset)/.test(text)) return { kind: 'network_error' };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  if (inputs.some(e => /pin/i.test(e.getAttribute('aria-label') || '') || e.id === 'mw-numeric-code-input-prevent-composer-focus-steal')) return { kind: 'pin' };
  const password = inputs.find(e => e.name === 'pass' || e.id === 'pass' || e.type === 'password');
  const email = inputs.find(e => e.name === 'email' || e.id === 'email' || e.type === 'email' || e.autocomplete === 'username');
  if (password) return { kind: email ? 'credentials' : 'password' };
  if (/usar outro perfil|use another profile/.test(text)) return { kind: 'continue' };
  return { kind: 'unknown' };
}

async function submit(page, { login, password, openFresh, onProgress = async () => {}, timeoutMs = 180000, settleMs = 60000 } = {}) {
  const guard = () => require('./interactionLease').assert(page);
  const readiness = require('./interactionReadiness');
  let stageStarted = Date.now();
  let stageTimeoutMs=require('./interactionBudget').timeout(page,timeoutMs);
  const report = async value => { try { await onProgress(value); } catch {} };
  const probe = async () => {
    while(Date.now()-stageStarted<stageTimeoutMs){
      await require('./interactionLease').wait(page);
      try { return await page.evaluate(inspect); }
      catch(error){
        if(!/execution context was destroyed|cannot find context|cannot find execution context|inspected target navigated|context.*destroyed/i.test(String(error.message||error)))throw error;
        await new Promise(r=>setTimeout(r,250));
      }
    }
    return {kind:'loading'};
  };
  let state = await probe(), entry = state.kind;
  if (state.kind === 'network_error') return { ok: false, error: 'login_transport_not_ready' };
  if (state.kind === 'pin') return { ok: false, error: 'messenger_pin_pending' };
  if (!['continue', 'password', 'credentials'].includes(state.kind)) {
    // Give an existing navigation time to mount before considering a fresh login.
    const until = stageStarted + stageTimeoutMs;
    while (!['continue', 'password', 'credentials', 'pin', 'network_error'].includes(state.kind) && Date.now() < until) {
      await new Promise(r => setTimeout(r, 250)); state = await probe();
    }
    if (state.kind === 'pin') return { ok: false, error: 'messenger_pin_pending' };
    if (state.kind === 'network_error') return { ok: false, error: 'login_transport_not_ready' };
    if (!['continue', 'password', 'credentials'].includes(state.kind)) {
      if (!openFresh) return { ok: false, error: 'login_surface_not_ready' };
      guard(); await openFresh(); state = await probe();
    }
    entry = state.kind;
  }
  if (state.kind === 'continue') {
    await report({ entry: 'continue', stage: 'continue' });
    const clicked = await readiness.clickControl(page, ['Continuar', 'Continue'], { exact: true, timeoutMs: Math.min(30000, timeoutMs) });
    if (!clicked.ok) return { ok: false, error: 'login_continue_not_ready', entry };
    stageStarted=Date.now();
    stageTimeoutMs=require('./interactionBudget').timeout(page,timeoutMs);
    await report({entry,stage:'continue_loading'});
  }
  while (!['password', 'credentials'].includes(state.kind) && Date.now() - stageStarted < stageTimeoutMs) {
    await new Promise(r => setTimeout(r, 250)); state = await probe();
    if (state.kind === 'pin') return { ok: false, error: 'messenger_pin_pending', entry };
    if (state.kind === 'network_error') return { ok: false, error: 'login_transport_not_ready', entry };
  }
  if (!['password', 'credentials'].includes(state.kind)) return { ok: false, error: 'login_form_not_found', entry };
  if (!String(password || '').trim() || state.kind === 'credentials' && !String(login || '').trim()) return { ok: false, error: 'missing_credentials', entry };
  await report({ entry, stage: state.kind });
  const pick = async type => {
    const handle = await page.evaluateHandle(type => {
      const nodes = [...document.querySelectorAll('input')];
      return nodes.find(e => {
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        if (r.width < 2 || r.height < 2 || e.disabled || s.display === 'none' || s.visibility === 'hidden' || e.closest('[aria-hidden="true"],[inert]')) return false;
        return type === 'password' ? (e.name === 'pass' || e.id === 'pass' || e.type === 'password') && !/pin/i.test(e.getAttribute('aria-label') || '') : e.name === 'email' || e.id === 'email' || e.type === 'email' || e.autocomplete === 'username';
      }) || null;
    }, type);
    return handle;
  };
  const handles = [];
  try {
    const fill = async (type, value) => {
      guard(); const handle = await pick(type); handles.push(handle); const el = handle.asElement();
      if (!el || !(await readiness.waitElement(page, el, { timeoutMs: 30000 })).ok) throw Error('login_input_not_ready');
      guard(); await el.click({ clickCount: 3 }); guard(); await page.keyboard.press('Backspace');
      for(const char of String(value)){guard();if(!await page.evaluate(input=>input.isConnected&&document.activeElement===input,el))throw Error('login_input_fill_unconfirmed');await el.type(char,{delay:20});}
      guard();
      if (!await page.evaluate((input, expected) => input.isConnected && input.value === expected, el, String(value))) throw Error('login_input_fill_unconfirmed');
      return el;
    };
    if (state.kind === 'credentials') await fill('email', login);
    const pass = await fill('password', password);
    const buttonHandle = await page.evaluateHandle(input => {
      const root = input.closest('form') || document;
      return [...root.querySelectorAll('button,input[type="submit"],[role="button"]')].find(e => {
        const r = e.getBoundingClientRect(), t = String(e.getAttribute('aria-label') || e.innerText || e.value || '').trim().toLowerCase();
        const style=getComputedStyle(e);
        return r.width > 2 && r.height > 2 && style.visibility!=='hidden'&&style.display!=='none'&&!e.closest('[aria-hidden="true"],[inert]')&&!e.disabled && e.getAttribute('aria-disabled') !== 'true' && (e.name === 'login' || e.type === 'submit' || e.id === 'loginbutton' || ['entrar', 'log in', 'login', 'continuar', 'continue'].includes(t));
      }) || null;
    }, pass);
    handles.push(buttonHandle); const button = buttonHandle.asElement();
    if (!button || !(await readiness.waitElement(page, button, { timeoutMs: 30000 })).ok) return { ok: false, error: 'login_submit_not_ready', entry };
    const from = page.url(); guard(); await button.click();
    await report({ entry, stage: 'verifying', submitted: true });
    try {
      await page.waitForFunction(from => location.href !== from || !document.querySelector('input[name="pass"],input#pass,input[type="password"]') || /senha incorreta|incorrect password|informacoes de login incorretas|incorrect login|ocorreu um erro|an error occurred/i.test(String(document.body?.innerText || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')), { timeout: settleMs }, from);
    } catch {}
    guard(); return { ok: true, submitted: true, entry };
  } catch (error) { return { ok: false, error: String(error.message || error), entry }; }
  finally { for (const handle of handles) await handle.dispose().catch(() => {}); }
}

module.exports = { inspect, submit };
