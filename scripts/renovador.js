\\ renovador.js

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
getBodyText
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
const rx = /anunciado\s+em\s+(\d{1,2})/(\d{1,2})/g;
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

async function ensureOnSelling(page, nome, attempt) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'goto_selling_start' });
const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
try {
await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
} catch {}
const okUrl = await waitUrlContains(page, '/marketplace/you/selling', 15000);
if (!okUrl) {
// fallback: esperar por texto no corpo
const okTxt = await waitForText(page, 'gerenciar classificados', { timeoutMs: 10000 }).catch(()=>false);
if (!okTxt) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'goto_selling_fail' });
return false;
}
}
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'goto_selling_ok' });
return true;
}

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
// Aguarde aparecer elementos da barra de gerenciamento: "Selecionar tudo" ou "Ações"
const okManage = await (async () => {
const t0 = Date.now();
while ((Date.now()-t0) < 20000) {
const a = await clickByAriaLabel(page, { label: 'Selecionar tudo', timeoutMs: 500 }).catch(()=>false);
if (a) return true;
const v = await waitVisibleAndEnabledBySpan(page, 'Ações', { timeoutMs: 500 }).catch(()=>null);
if (v) return true;
// Tentativa idempotente — não é problema: só para observar se existe na tela
await sleep(300);
}
return false;
})();
if (!okManage) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'manage_ui_not_ready' });
return false;
}
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'click_gerenciar_ok' });
return true;
}

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

async function selectAllItems(page, nome, attempt) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_start' });
// Subir ao topo para garantir que os botões fiquem acessíveis
try { await scrollToTop(page); } catch {}
// Clique em "Selecionar tudo"
// Use aria-label primeiro, depois texto
const okAria = await clickByAriaLabel(page, { label: 'Selecionar tudo', timeoutMs: 10000 }).catch(()=>false);
let ok = okAria;
if (!ok) {
ok = await clickByInnerText(page, { text: 'Selecionar tudo', tag: '*', timeoutMs: 10000 }).catch(()=>false);
}
if (!ok) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_fail' });
return false;
}
await sleep(600);
// Verifica se "Ações" ficou habilitado
const btnActions = await waitVisibleAndEnabledBySpan(page, 'Ações', { timeoutMs: 12000 }).catch(()=>null);
if (!btnActions) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'actions_button_disabled' });
return false;
}
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'select_all_ok' });
return true;
}

async function openActionsAndClickRenew(page, nome, attempt) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'actions_open_start' });
const btnActions = await waitVisibleAndEnabledBySpan(page, 'Ações', { timeoutMs: 12000 }).catch(()=>null);
if (!btnActions) {
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'actions_open_fail_not_found' });
return false;
}
try { await btnActions.click({ delay: 60 }); } catch {}
await sleep(400);
stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'menu_click_renovar_start' });
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

async function startRenovacao(browser, nome, opts = {}) {
const attempt = stepLog.attemptId();
const diasLimite = Number(opts.diasLimite || 46);
const waitListMs = Number(opts.waitListMs || 70000);
const renewWaitMs = Number(opts.renewWaitMs || 70000);
const maxScrollLoops = Number(opts.maxScrollLoops || 40);

stepLog.appendJSONL(nome, 'renovador', { attempt, step: 'start', diasLimite, waitListMs, renewWaitMs, maxScrollLoops });
try { issues && issues.append(nome, 'mil_action', renovador_start attempt=${attempt}); } catch {}

let page = null;
let renewedCount = null;

try {
// Nova aba isolada
page = await browser.newPage();
// Patch de page
try {
const coords = utils.getCoords && utils.getCoords('') || null;
await patchPage(nome, page, coords);
} catch {}
// Ir para Selling
const okSelling = await ensureOnSelling(page, nome, attempt);
if (!okSelling) {
try { issues && issues.append(nome, 'renovador_error', 'goto_selling_failed'); } catch {}
return { ok: false, error: 'goto_selling_failed' };
}

// Clicar em Gerenciar classificados
const okGerenciar = await clickGerenciar(page, nome, attempt);
if (!okGerenciar) {
  try { issues && issues.append(nome, 'renovador_error', 'gerenciar_click_failed'); } catch {}
  return { ok: false, error: 'gerenciar_click_failed' };
}

// Rolar ao final e avaliar datas
const assess = await scrollAndAssess(page, nome, attempt, diasLimite, maxScrollLoops);
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
try { if (page) await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
}
}

module.exports = {
startRenovacao
};