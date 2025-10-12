// renovador.js

'use strict';

const {
  patchPage,
  normalizeText,
  waitForText,
  clickByInnerText,
  clickByAriaLabel,
  clickMenuItemByText,
  waitVisibleAndEnabledBySpan,
  scrollToTop,
  scrollToBottomIncremental,
  getInnerText,
  getBodyText,
  ensureFocusAndInteractable,                  // NOVO
  scrollMarketplaceManageIncremental,          // NOVO
  invocarHumano                               // <<< ADICIONADO conforme instrução
} = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function todayLocalMidnight() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d;
}

function parseDDMMToDate(dd, mm) {
  const now = new Date();
  const year = now.getFullYear();
  const d = new Date(year, Number(mm)-1, Number(dd), 0, 0, 0, 0);
  // Se a data ficar no futuro (ex: 01/01 quando hoje é 31/12), assume ano anterior
  const today = todayLocalMidnight();
  if (d > new Date(today.getTime() + 86400000)) {
    d.setFullYear(year - 1);
  }
  return d;
}

function daysDiffFromToday(dd, mm) {
  try {
    const target = parseDDMMToDate(dd, mm);
    const today = todayLocalMidnight();
    const diffMs = today.getTime() - target.getTime();
    return Math.floor(diffMs / 86400000);
  } catch { return null; }
}

async function scanAnunciadoDates(page) {
  try {
    const matches = await page.evaluate(() => {
      try {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const txt = norm(document && document.body && document.body.innerText || '');
        const rx = /anunciado\s+em\s+(\d{1,2})\/(\d{1,2})/g;
        const out = [];
        let m;
        while ((m = rx.exec(txt)) !== null) {
          out.push([m[1], m[2]]);
        }
        // Dedup
        const seen = new Set();
        const res = [];
        for (const [d, mo] of out) {
          const key = d + '/' + mo;
          if (!seen.has(key)) { seen.add(key); res.push([d, mo]); }
        }
        return res;
      } catch { return []; }
    });
    return Array.isArray(matches) ? matches : [];
  } catch { return []; }
}

async function waitUrlContains(page, substr, timeoutMs) {
  const t0 = Date.now();
  while ((Date.now()-t0) < timeoutMs) {
    try {
      const u = typeof page.url === 'function' ? (page.url() || '') : '';
      if (u.includes(substr)) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

// **************** ALTERADO - PATCH MILITAR diagnósticador ****************

async function dumpPageDiag(page, nome, label) {
  try {
    const ua = await page.evaluate(() => navigator.userAgent).catch(()=> '');
    const url = (typeof page.url === 'function') ? page.url() : '';
    const title = await page.title().catch(()=> '');
    const body = await page.evaluate(() => (document && document.body && document.body.innerText || '')).catch(()=> '');
    const head400 = (body || '').slice(0, 400).replace(/\s+/g, ' ').trim();

    // Coleta de storage (sem vazar tokens inteiros)
    const stor = await page.evaluate(() => {
      const redact = v => {
        const s = String(v==null?'':v);
        return s.length > 32 ? (s.slice(0,16)+'...('+s.length+'c)') : s;
      };
      const ls = {};
      try { for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); ls[k]=redact(localStorage.getItem(k)); } } catch{}
      const ss = {};
      try { for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); ss[k]=redact(sessionStorage.getItem(k)); } } catch{}
      return { ls, ss };
    }).catch(()=>({ls:{},ss:{}}));

    const loggedHeu = await page.evaluate(() => {
      try {
        const hasTop = !!document.querySelector('div[role="banner"],[aria-label*="Facebook"][role="navigation"]');
        const hasAccount = !!document.querySelector('a[href*="profile"],[aria-label*="Conta"],[aria-label*="Account"]');
        return { hasTop, hasAccount };
      } catch { return { hasTop:false, hasAccount:false }; }
    }).catch(()=>({hasTop:false,hasAccount:false}));

    const msg = `[RENOVADOR][DIAG][${nome}] ${label}
URL: ${url}
TITLE: ${title}
BODY(400): ${head400}
UA: ${ua}
localStorage: ${Object.keys(stor.ls||{}).join(',')}
sessionStorage: ${Object.keys(stor.ss||{}).join(',')}
loggedHeu: ${JSON.stringify(loggedHeu)}
`;
    console.log(msg);
    try { issues && issues.append(nome,'mil_action', msg); } catch {}
  } catch {}
}
function attachNavTracer(page, nome, tag) {
  const onResp = async (res) => {
    try {
      const url = res.url();
      if (!/facebook.com/i.test(url)) return;
      const st = res.status();
      if (st >= 300 || st < 200) {
        console.log(`[RENOVADOR][TRACE][${nome}] ${tag} ${st} ${url}`);
        try { issues && issues.append(nome, 'mil_action', `[trace:${tag}] ${st} ${url}`); } catch {}
      }
    } catch {}
  };
  const onFail = (req) => {
    try {
      console.log(`[RENOVADOR][TRACE][${nome}] ${tag} requestfailed ${req.failure() && req.failure().errorText} ${req.url()}`);
      issues && issues.append(nome, 'mil_action', `[trace:${tag}] requestfailed ${req.failure() && req.failure().errorText} ${req.url()}`);
    } catch {}
  };
  const onCons = (msg) => {
    try {
      if (msg && msg.type && msg.type()==='error') {
        issues && issues.append(nome,'mil_action',`[trace:${tag}] console.error ${msg.text()}`);
      }
    } catch {}
  };
  const onPageErr = (err) => {
    try { issues && issues.append(nome,'mil_action',`[trace:${tag}] pageerror ${err && err.message}`); } catch {}
  };
  page.on('response', onResp);
  page.on('requestfailed', onFail);
  page.on('console', onCons);
  page.on('pageerror', onPageErr);
  return () => {
    try { page.off('response', onResp); } catch{}
    try { page.off('requestfailed', onFail); } catch{}
    try { page.off('console', onCons); } catch{}
    try { page.off('pageerror', onPageErr); } catch{}
  };
}
function looksLikeSellingDOMText(textNorm) {
  if (!textNorm) return false;
  return (
    textNorm.includes('gerenciar classificados') ||
    textNorm.includes('seus classificados') ||
    textNorm.includes('painel do vendedor') ||
    textNorm.includes('your listings') ||
    textNorm.includes('manage listings') ||
    textNorm.includes('seller dashboard')
  );
}
function detectBlockingPage(textNorm, url) {
  const u = String(url||'').toLowerCase();
  if (/checkpoint|recover|twofactor|login/i.test(u)) return 'checkpoint_or_login';
  if (/onboarding|commerce_manager|resale|verification|account_quality/i.test(u)) return 'marketplace_onboarding_or_quality';
  if (textNorm.includes('voce nao tem acesso ao marketplace') || textNorm.includes("you don't have access to marketplace")) return 'marketplace_denied';
  if (textNorm.includes('temporariamente bloqueado') || textNorm.includes('temporarily blocked')) return 'temporarily_blocked';
  return null;
}
async function ensureOnSelling(browser, page, nome, attempt) {
  const SELL = 'https://www.facebook.com/marketplace/you/selling';
  const SELL_M = 'https://m.facebook.com/marketplace/you/selling';
  const successByUrl = (u) => /marketplace\/you\/selling\b/i.test(String(u||''));
  const successByDom = async (p) => {
    const t = await p.evaluate(() => (document && document.body && document.body.innerText || '')).catch(()=> '');
    const n = (t || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    return looksLikeSellingDOMText(n);
  };
  async function gotoTry(p, url, label) {
    const detach = attachNavTracer(p, nome, label);
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
      const okUrl = successByUrl(p.url());
      const okDom = okUrl ? true : await successByDom(p);
      if (okUrl || okDom) {
        await dumpPageDiag(p, nome, `${label}: success`);
        return { ok: true };
      }
      const txt = await p.evaluate(()=> (document && document.body && document.body.innerText)||'').catch(()=> '');
      const norm = (txt||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const why = detectBlockingPage(norm, p.url());
      await dumpPageDiag(p, nome, `${label}: not-selling (why=${why||'unknown'})`);
      if (why) return { ok:false, why };
      return { ok: false };
    } finally { detach(); }
  }
  // 3 tentativas na mainPage
  for (let i=0;i<3;i++) {
    const lab = `main_try_${i+1}`;
    console.log(`[RENOVADOR][${nome}][NAVIGATE] ${lab}`);
    let r = await gotoTry(page, SELL, lab);
    if (r.ok) return { ok:true, page, usedNewTab:false };
    r = await gotoTry(page, SELL_M, `${lab}_m`);
    if (r.ok) return { ok:true, page, usedNewTab:false };
    await dumpPageDiag(page, nome, `${lab}_fail`);
    await page.goto('https://www.facebook.com/', { waitUntil:'domcontentloaded', timeout: 25000 }).catch(()=>{});
    await page.reload({ waitUntil:'domcontentloaded', timeout:15000 }).catch(()=>{});
  }
  // fallback: fecha main e cria nova aba
  console.log(`[RENOVADOR][${nome}][FALLBACK] new tab + close mainPage`);
  try { await page.close({ runBeforeUnload:false }).catch(()=>{}); } catch {}
  const np = await browser.newPage();
  try {
    const coords = utils.getCoords && utils.getCoords('') || null;
    await patchPage(nome, np, coords);
  } catch {}
  await ensureFocusAndInteractable(np);
  let r = await gotoTry(np, SELL, 'new_tab_main');
  if (r.ok) return { ok:true, page:np, usedNewTab:true };
  r = await gotoTry(np, SELL_M, 'new_tab_m');
  if (r.ok) return { ok:true, page:np, usedNewTab:true };
  // CDP final
  try {
    const cdp = await np.target().createCDPSession();
    await cdp.send('Page.stopLoading').catch(()=>{});
    await cdp.send('Page.navigate', { url: SELL }).catch(()=>{});
    await np.waitForNavigation({ waitUntil:'domcontentloaded', timeout:15000 }).catch(()=>{});
  } catch {}
  const okFinal = successByUrl(np.url()) || await successByDom(np);
  if (okFinal) {
    await dumpPageDiag(np, nome, 'new_tab_cdp: success');
    return { ok:true, page:np, usedNewTab:true };
  }
  await dumpPageDiag(np, nome, 'goto_selling_failed_final');
  // Classifica motivo
  const body = await np.evaluate(()=> (document && document.body && document.body.innerText)||'').catch(()=> '');
  const norm = (body||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const why = detectBlockingPage(norm, np.url());
  try { issues && issues.append(nome,'renovador_error', `goto_selling_failed (why=${why||'unknown'}) url=${np.url()}`); } catch {}
  return { ok:false, page:np, usedNewTab:true, why: why||'unknown' };
}
// ******************************************************************

async function clickGerenciar(page, nome, attempt) {
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_gerenciar_start' });
  // Tente por innerText
  const clickedByText = await clickByInnerText(page, { text: 'Gerenciar classificados', tag: '*' , timeoutMs: 12000 }).catch(()=>false);
  if (!clickedByText) {
    // Fallback por aria-label
    const clickedByAria = await clickByAriaLabel(page, { label: 'Gerenciar classificados', timeoutMs: 12000 }).catch(()=>false);
    if (!clickedByAria) {
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_gerenciar_fail' });
      return false;
    }
  }
  // <---- ALTERAÇÃO: foco após clique em Gerenciar com params ----->
  await ensureFocusAndInteractable(page, { clickBody: false, pressEscape: false });
  // <--------------------------------------------------->
  // Aguarde aparecer elementos da barra de gerenciamento: "Selecionar tudo" ou "Ações"
  // <---- ALTERAÇÃO: toolbarReady robusto ----------->
  const toolbarReady = await (async () => {
    const t0 = Date.now();
    while ((Date.now()-t0) < 20000) {
      const selAll = await clickByAriaLabel(page, { label: 'Selecionar tudo', timeoutMs: 500 }).catch(()=>false);
      if (selAll) { await sleep(300); break; }
      const visibleActions = await waitVisibleAndEnabledBySpan(page, 'Ações', { timeoutMs: 800 }).catch(()=>null);
      if (visibleActions) break;
      await sleep(300);
    }
    return true;
  })();
  await ensureFocusAndInteractable(page);
  // <----------------------------------------------->
  // NOVO BLOCO: Diagnóstico adicional e snapshot
  if (!toolbarReady) {
    try {
      const diag = await page.evaluate(() => {
        const pick = (sel, max=8) => Array.from(document.querySelectorAll(sel)).slice(0, max).map(el => (el.outerHTML || '').slice(0, 600));
        return { headers: pick('h1,h2,h3'), links: pick('a'), buttons: pick('div[role="button"],button') };
      });
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'manage_ui_not_ready_diag', diag });
    } catch {}
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'manage_ui_not_ready' });
    return false;
  }

  // NOVO BLOCO: Snapshot pós-toolbarReady
  try {
    const snap = await page.evaluate(() => {
      const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      return {
        url: location.href,
        title: document.title,
        hasPainelVendedor: norm(document.body && document.body.innerText || '').includes('painel do vendedor')
      };
    });
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'post_gerenciar_state', snap });
  } catch {}

  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_gerenciar_ok' });
  return true;
}

// Obsoleto, substituído!
/*
async function scrollAndAssess(page, nome, attempt, diasLimite, maxScrollLoops) {
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'scroll_bottom_start', diasLimite, maxScrollLoops });
  // Vamos rolar até o final com helper (robusto, anti-stuck). Isso garante carregar todos os itens.
  try {
    await scrollToBottomIncremental(page, { maxLoops: maxScrollLoops || 40, minDelta: 200, idleLoopsToStop: 3 });
  } catch {}
  // Escaneia datas
  const found = await scanAnunciadoDates(page);
  let daysMin = null, daysMax = null, reached = false;
  for (const [dd, mm] of found) {
    const k = daysDiffFromToday(dd, mm);
    if (k != null) {
      if (daysMin == null || k < daysMin) daysMin = k;
      if (daysMax == null || k > daysMax) daysMax = k;
      if (k >= diasLimite) reached = true;
    }
  }
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'dates_scan', count: found.length, daysMin, daysMax, reached });
  return { reached, daysMin, daysMax, count: found.length };
}
*/

// Selecionar tudo -- CRÍTICO
async function selectAllItems(page, nome, attempt) {
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_start' });
  try { await scrollToTop(page); } catch {}

  await ensureFocusAndInteractable(page);

  // 1) Preferir localizar o host do botão via span (tolerante a contadores e includes)
  let host = await waitVisibleAndEnabledBySpan(page, 'Selecionar tudo', { timeoutMs: 12000 }).catch(()=>null);
  if (!host) {
    // Tentativa com sinônimo frequente
    host = await waitVisibleAndEnabledBySpan(page, 'Selecionar todos', { timeoutMs: 6000 }).catch(()=>null);
  }

  if (host) {
    try { await host.click({ delay: 60 }); } catch {}
  } else {
    // 2) Fallback: aria-label que contenha "Selecionar" e "tudo"
    const clicked = await page.evaluate(() => {
      const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const btns = Array.from(document.querySelectorAll('[aria-label],[role="button"],button,div[role="button"]'));
      const cand = btns.find(el => {
        const al = norm(el.getAttribute && el.getAttribute('aria-label') || '');
        return al.includes('selecionar') && al.includes('tudo');
      });
      if (cand) { cand.click(); return true; }
      return false;
    });
    if (!clicked) {
      // Diagnóstico: snapshot dos botões/labels próximos
      try {
        const diag = await page.evaluate(() => {
          const pick = (sel, max=6) => Array.from(document.querySelectorAll(sel)).slice(0, max).map(el => (el.outerHTML || '').slice(0, 500));
          return {
            buttons: pick('div[role="button"],button'),
            spans: pick('span'),
            aria: pick('[aria-label]')
          };
        });
        stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_diag', diag });
      } catch {}
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_fail' });
      return false;
    }
  }

  await sleep(600);

  // 3) Verifica se “Ações” ficou habilitado
  const btnActions = await waitVisibleAndEnabledBySpan(page, 'Ações', { timeoutMs: 12000 }).catch(()=>null);
  if (!btnActions) {
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'actions_button_disabled' });
    return false;
  }
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_ok' });
  return true;
}

// Abrir Ações/Renovar -- CRÍTICO
async function openActionsAndClickRenew(page, nome, attempt) {
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'actions_open_start' });
  // <------- Alteração CRÍTICA: garantir foco antes de critical click
  await ensureFocusAndInteractable(page);
  // ---------------------------------------------->
  const btnActions = await waitVisibleAndEnabledBySpan(page, 'Ações', { timeoutMs: 12000 }).catch(()=>null);
  if (!btnActions) {
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'actions_open_fail_not_found' });
    return false;
  }
  try { await btnActions.click({ delay: 60 }); } catch {}
  await sleep(400);
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'menu_click_renovar_start' });
  // <------- Alteração CRÍTICA: garantir foco antes de critical click (segunda chamada - modificado)
  await ensureFocusAndInteractable(page, { clickBody: false, pressEscape: false });
  // ---------------------------------------------->
  const clicked = await clickMenuItemByText(page, 'Renovar no Marketplace', { timeoutMs: 15000 }).catch(()=>false);
  if (!clicked) {
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'menu_click_renovar_fail' });
    return false;
  }
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'menu_click_renovar_ok' });
  return true;
}

async function waitRenewList(page, nome, attempt, waitListMs) {
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'wait_list_start' });
  const t0 = Date.now();
  let count = null;
  while ((Date.now()-t0) < (waitListMs || 70000)) {
    // Tenta pegar H2 com “serão renovados”
    try {
      const body = await getBodyText(page);
      const normalized = normalizeText(body);
      const m = normalized.match(/(\d+)\s+classificados?\s+ser[aã]o\s+renovados/);
      if (m && m[1]) {
        count = parseInt(m[1], 10);
        stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'list_count_detected', count });
        break;
      }
    } catch {}
    // Se o botão "Renovar" está disponível, podemos seguir mesmo sem o número
    const btn = await waitVisibleAndEnabledBySpan(page, 'Renovar', { timeoutMs: 800 }).catch(()=>null);
    if (btn) {
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'list_ready_no_count' });
      break;
    }
    await sleep(400);
  }
  if ((Date.now()-t0) >= (waitListMs || 70000)) {
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'wait_list_timeout' });
    return { ok: false, count: null };
  }
  return { ok: true, count: count };
}

async function clickRenewAndWaitBack(page, nome, attempt, renewWaitMs) {
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_renovar_start' });
  // <------- Alteração CRÍTICA: garantir foco antes de critical click
  await ensureFocusAndInteractable(page);
  // ---------------------------------------------->
  const btn = await waitVisibleAndEnabledBySpan(page, 'Renovar', { timeoutMs: 15000 }).catch(()=>null);
  if (!btn) {
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_renovar_fail_not_found' });
    return { ok: false };
  }
  try { await btn.click({ delay: 60 }); } catch {}
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_renovar_clicked' });
  // Aguarde retorno para selling
  const okUrl = await waitUrlContains(page, '/marketplace/you/selling', renewWaitMs || 70000);
  if (!okUrl) {
    // Fallback: detectar “Gerenciar classificados” de novo
    const okTxt = await waitForText(page, 'gerenciar classificados', { timeoutMs: 5000 }).catch(()=>false);
    if (!okTxt) {
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'wait_back_selling_timeout' });
      return { ok: false };
    }
  }
  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'wait_back_selling_ok' });
  return { ok: true };
}

// ---------------------------------------------
// INÍCIO ALTERAÇÃO startRenovacao (helpers e gating)
// ---------------------------------------------

async function startRenovacao(browser, nome, opts = {}) {
  const attempt = stepLog.attemptId();
  const diasLimite = Number(opts.diasLimite || 46);

  // **************** ALTERADO (patch ultra-cirúrgico) ****************
  const waitListMs = Number(opts.waitListMs || 120000);
  const renewWaitMs = Number(opts.renewWaitMs || 120000);
  // ******************************************************************
  const maxScrollLoops = Number(opts.maxScrollLoops || 40);

  stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'start', diasLimite, waitListMs, renewWaitMs, maxScrollLoops });
  try { issues && issues.append(nome, 'mil_action', `renovador_start attempt=${attempt}`); } catch {}

  let page = null;
  let renewedCount = null;

  // --- INÍCIO ALTERAÇÃO para suporte à aba 0/mainPage (opts.useMainPage)

  // PATCH: useMainPage default TRUE  
  const useMainPage = (opts.useMainPage !== false); // default true

  let toClose = true;
  if (useMainPage) {
    const pagesNow = await browser.pages().catch(()=>[]);
    if (pagesNow && pagesNow[0] && typeof pagesNow[0].isClosed === 'function' && pagesNow[0].isClosed()) {
      // ABA 0 EXISTE, MAS ESTÁ FECHADA
      if (issues) await issues.append(nome, 'mil_action', 'renovador_main_closed_new_tab (aba0 fechada, nova aba aberta)');
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'new_tab_due_main_closed' });
      page = await browser.newPage();
      toClose = true;
    } else if (pagesNow && pagesNow[0]) {
      // ABA 0 VIVA
      page = pagesNow[0];
      toClose = false;
    } else {
      // ABA 0 NÃO EXISTE
      if (issues) await issues.append(nome, 'mil_action', 'renovador_new_tab_due_to_missing_main (nenhuma aba, nova aberta)');
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'new_tab_due_main_missing' });
      page = await browser.newPage();
      toClose = true;
    }
  } else {
    // useMainPage = false explicitamente
    if (issues) await issues.append(nome, 'mil_action', 'renovador_forced_new_tab (useMainPage=false)');
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'new_tab_forced' });
    page = await browser.newPage();
    toClose = true;
  }
  // --- FIM ALTERAÇÃO

  try {
    // Patch de page
    try {
      const coords = utils.getCoords && utils.getCoords('') || null;
      await patchPage(nome, page, coords);
    } catch {}

    // <----- ALTERAÇÃO: garantir foco antes de qualquer navegação -------->
    await ensureFocusAndInteractable(page);
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'focus_ready' });
    // <--------------------------------------------------------------->

    // ===================== PATCH CENTRAL: NAVEGAR COMO O HUMANO =====================
    try {
      console.log(`[RENOVADOR][${nome}][HUMAN_EQUIV] calling invocarHumano(...)`);
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'human_equiv_invocar_start' });
      await invocarHumano(browser, nome);
      await sleep(600);
      // Reconciliar page com a mainPage real, pois o próprio humano pode reabrir a main (SPA).
      const p2 = await browser.pages().catch(()=>[]);
      if (p2 && p2[0]) page = p2[0];
      const urlAfter = (typeof page.url === 'function') ? page.url() : '';
      const titleAfter = await page.title().catch(()=> '');
      console.log(`[RENOVADOR][${nome}][HUMAN_EQUIV] after goto url=${urlAfter} title="${titleAfter}"`);
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'human_equiv_invocar_done', url: urlAfter, title: titleAfter });
    } catch (e) {
      console.log(`[RENOVADOR][${nome}][HUMAN_EQUIV] invocarHumano ERROR: ${(e && e.message) || e}`);
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'human_equiv_invocar_error', err: (e && e.message) || String(e) });
    }
    
    // Se por algum motivo não estamos em /marketplace/you/selling, tenta um goto direto (como no humano)
    let curUrl = (typeof page.url === 'function') ? page.url() : '';
    if (!/facebook\.com\/marketplace\/you\/selling/i.test(curUrl)) {
      try {
        console.log(`[RENOVADOR][${nome}][HUMAN_EQUIV] direct_goto_retry to Selling`);
        await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
        await sleep(500);
        curUrl = (typeof page.url === 'function') ? page.url() : '';
        const curTitle = await page.title().catch(()=> '');
        stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'human_equiv_direct_retry', url: curUrl, title: curTitle });
      } catch {}
    }
    
    if (!/facebook\.com\/marketplace\/you\/selling/i.test(curUrl)) {
      const sellingRes = await ensureOnSelling(browser, page, nome, attempt);
      if (!sellingRes || !sellingRes.ok || !sellingRes.page) {
        try { issues && issues.append(nome, 'renovador_error', 'goto_selling_failed'); } catch {}
        console.log(`[RENOVADOR][${nome}][NAVIGATE] goto_selling_failed`);
        return { ok: false, error: 'goto_selling_failed' };
      }
      page = sellingRes.page;
      if (sellingRes.usedNewTab === true) toClose = true;
    } else {
      // Estamos na mainPage em Selling: não fechar no finally
      toClose = false;
    }
    // ===================== FIM PATCH CENTRAL =====================

    // Clicar em Gerenciar classificados
    const okGerenciar = await clickGerenciar(page, nome, attempt);
    if (!okGerenciar) {
      try { issues && issues.append(nome, 'renovador_error', 'gerenciar_click_failed'); } catch {}
      return { ok: false, error: 'gerenciar_click_failed' };
    }

    // <--- ALTERAÇÃO: scrollAndAssess substituído por scrollMarketplaceManageIncremental ----->
    const assess = await (async () => {
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'scroll_list_start', maxScrollLoops });
      await ensureFocusAndInteractable(page);
      const stats = await scrollMarketplaceManageIncremental(page, { maxLoops: maxScrollLoops, idleLoopsToStop: 4, settleMs: 550 });
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'scroll_list_end', stats });
      return { reached: stats.reachedEligible, exhausted: stats.exhausted, count: stats.totalCards };
    })();
    // <--------------------------------------------------------------->

    // --- INÍCIO ALTERAÇÃO: Gate por elegíveis antes de SELECT ALL
    if (!assess.reached) {
      if (assess.exhausted && (!assess.count || assess.count <= 0)) {
        stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'no_eligible_exhausted' });
        try { issues && issues.append(nome, 'mil_action', 'renovador_no_eligible_exhausted'); } catch {}
        return { ok: false, error: 'no_eligible', renewedCount: 0 };
      }
      // Caso contrário, forcinha: continue para SelectAll/Ações/Renovar e deixe o FB decidir a lista (com logs)
      stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'no_eligible_but_continue' });
    }
    // --- FIM ALTERAÇÃO GATE

    // Subir
    try { await scrollToTop(page); } catch {}

    // Selecionar tudo
    const okSelectAll = await selectAllItems(page, nome, attempt);
    if (!okSelectAll) {
      try { issues && issues.append(nome, 'renovador_error', 'select_all_failed'); } catch {}
      return { ok: false, error: 'select_all_failed' };
    }

    // Abrir "Ações" e clicar em "Renovar no Marketplace"
    const okClickRenewMenu = await openActionsAndClickRenew(page, nome, attempt);
    if (!okClickRenewMenu) {
      try { issues && issues.append(nome, 'renovador_error', 'menu_renew_click_failed'); } catch {}
      return { ok: false, error: 'menu_renew_click_failed' };
    }

    // Esperar a lista de renovação aparecer (ou o botão “Renovar”)
    const listRes = await waitRenewList(page, nome, attempt, waitListMs);
    if (!listRes.ok) {
      try { issues && issues.append(nome, 'renovador_error', 'wait_list_timeout'); } catch {}
      return { ok: false, error: 'wait_list_timeout' };
    }
    renewedCount = listRes.count != null ? listRes.count : null;

    // Clicar em "Renovar" e aguardar retorno
    const renewRes = await clickRenewAndWaitBack(page, nome, attempt, renewWaitMs);
    if (!renewRes.ok) {
      try { issues && issues.append(nome, 'renovador_error', 'renew_click_or_back_timeout'); } catch {}
      return { ok: false, error: 'renew_click_or_back_timeout' };
    }

    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'end', renewedCount });
    try { issues && issues.append(nome, 'mil_action', `renovador_end ok count=${renewedCount!=null?renewedCount:'?'} attempt=${attempt}`); } catch {}
    return { ok: true, renewedCount: renewedCount != null ? renewedCount : 0 };

  } catch (e) {
    const msg = (e && e.message) || String(e);
    stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'error', err: msg });
    try { issues && issues.append(nome, 'renovador_error', msg); } catch {}
    return { ok: false, error: msg };
  } finally {
    // --- INÍCIO ALTERAÇÃO: Fechar aba só se não for a mainPage/aba 0
    if (page && toClose) {
      console.log(`[RENOVADOR][${nome}][FINALLY] Fechando aba auxiliar`);
      try { await page.close({ runBeforeUnload: false }); } catch {}
    }
    // --- FIM ALTERAÇÃO
  }
}

// ---------------------------------------------
// FIM ALTERAÇÃO
// ---------------------------------------------

module.exports = {
  startRenovacao
};