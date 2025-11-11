// autoLogin.js

"use strict";

/**

    Módulo militar de Auto-Login — stand-alone
        Centraliza 100% da lógica de auto-login, tentativas, desbloqueio (Virtus/Robe), verificação pós-login e escalonamento humano.
        Não depende de escopo do worker. Toda persistência/log é feita aqui (manifestStore/issues/status.json).
        O worker apenas injeta um adapter com funções mínimas para iniciar Virtus, acionar Robe e escalar Humano.
    API:
    const autoLogin = require('./autoLogin.js');
    await autoLogin.tryAutoLogin({ nome, adapter });
    Parâmetros:
    nome: string (slug do perfil)
    adapter: {

getController(nome) -> ctrl { browser, mainPage? } (obrigatório)

startVirtus(nome)   -> Promise<{ok:boolean}>

robePlay(nome)      -> Promise<{ok:boolean}>

    escalateToHuman(nome)-> Promise<{ok:boolean}> (ativa humanHold + invocar humano)

    }
    Retorno:
    { sucesso: boolean, escalonouHumano: boolean, tentativas: number, motivo: string } */

const fs = require('fs');
const path = require('path');

const manifestStore = require('./manifestStore.js');
const issues        = require('./issues.js');
const utils         = require('./utils.js');
const browserHelper = require('./browser.js');

const STATUS_PATH = path.join(__dirname, '..', 'dados', 'status.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitUntil(fn, { timeoutMs = 20000, intervalMs = 350 } = {}) {
const t0 = Date.now();
while ((Date.now() - t0) < timeoutMs) {
try { if (await fn()) return true; } catch {}
await sleep(intervalMs);
}
return false;
}
function readStatusSafe() {
try {
const raw = fs.readFileSync(STATUS_PATH, 'utf8');
return JSON.parse(raw);
} catch { return { perfis: [], robes: {}, robeQueue: [], ts: Date.now() }; }
}
function getRobeStateFromStatus(nome) {
try {
const st = readStatusSafe();
const r = st && st.robes && st.robes[nome];
if (r && typeof r === 'object') {
return {
emExecucao: !!r.emExecucao,
estado: String(r.estado || ''),
cooldownSec: Number(r.cooldownSec || 0)
};
}
} catch {}
return { emExecucao: false, estado: '', cooldownSec: 0 };
}
function isRobeActive(state) {
try {
if (!state) return false;
// Estado "ok" indica ciclo executado; cooldownSec > 0 indica ciclo recente; emExecucao = true indica rodando agora.
if (state.emExecucao) return true;
if (/ok|normal|idle/i.test(state.estado || '')) return true;
if ((state.cooldownSec || 0) > 0) return true;
} catch {}
return false;
}
async function evaluateMessengerGridOk(page) {
try {
const res = await page.evaluate(() => {
try {
// Detectores estáveis para Messenger — grid de conversas Marketplace
let grid = Array.from(document.querySelectorAll('div[role="grid"]')).find(g => {
const al = (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby') || '');
const t  = (al || '').toLowerCase();
return t.includes('conversas') || t.includes('conversations');
});
if (!grid) {
const pagelet = document.querySelector('div[data-pagelet="MWThreadList"]');
if (pagelet) {
const g2 = pagelet.querySelector('div[role="grid"]');
if (g2) grid = g2;
}
}
let rows = 0, anchors = 0, skeletons = 0;
if (grid) {
rows     = grid.querySelectorAll('div[role="row"]').length;
anchors  = grid.querySelectorAll('a[href^="/marketplace/t/"]').length;
skeletons= grid.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
} else {
skeletons = document.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
}
// Ok se há grid e (linhas ou anchors) > 0, e poucos skeletons
return { ok: !!grid && (rows > 0 || anchors > 0), rows, anchors, skeletons };
} catch {
return { ok:false, rows:0, anchors:0, skeletons:0 };
}
});
return !!(res && res.ok);
} catch { return false; }
}
async function detectLoginStillRequired(page) {
try {
const lr = await browserHelper.detectLoginRequired(page);
return !!(lr && lr.loginRequired);
} catch { return false; }
}
async function getMainPageFromCtrl(ctrl) {
try {
if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return null;
if (ctrl.mainPage) return ctrl.mainPage;
const pages = await ctrl.browser.pages().catch(() => []);
return (pages && pages[0]) ? pages[0] : null;
} catch { return null; }
}
async function ensurePostAttemptAutomation(adapter, nome) {
// Dispara Virtus e Robe imediatamente (não espera retorno confirmado). Política: fire-and-forget.
try { adapter && adapter.startVirtus && adapter.startVirtus(nome).catch(()=>{}); } catch {}
try { adapter && adapter.robePlay && adapter.robePlay(nome).catch(()=>{}); } catch {}
}

async function clearLoginFlagsSuccess(nome) {
await manifestStore.update(nome, (m) => {
m = m || {};
m.accountFlags = m.accountFlags || {};
// Zera flags de login/erros/pos-login
m.accountFlags.loginRequired = false;
delete m.accountFlags.loginReason;
delete m.accountFlags.loginSource;
delete m.accountFlags.lastLoginRequiredAt;

m.accountFlags.loginAutoAttemptCount = 0;
delete m.accountFlags.lastLoginTryError;
delete m.accountFlags.lastLoginTryReasonCode;
delete m.accountFlags.lastLoginTrySource;

m.accountFlags.lastLoginSuccessAt = Date.now();

delete m.accountFlags.autoLoginEscalatedAt;
delete m.accountFlags.loginBackoffUntil;
delete m.accountFlags.postLoginAutomationFail;
delete m.accountFlags.humanRecommended;
delete m.accountFlags.humanReason;

if (m.accountFlags.problemaConta) {
  delete m.accountFlags.problemaConta;
  delete m.accountFlags.problemaContaMsg;
}
return m;

});
}

async function markPostFail(nome, { reasonCode = 'unknown', message = '' } = {}) {
await manifestStore.update(nome, (m) => {
m = m || {};
m.accountFlags = m.accountFlags || {};
m.accountFlags.postLoginAutomationFail = true;
m.accountFlags.lastLoginTryError = `${String(reasonCode||'unknown')}${message ? (':' + String(message).slice(0,160)) : ''}`;
m.accountFlags.lastLoginTryReasonCode = String(reasonCode||'unknown');
m.accountFlags.lastLoginTrySource = 'messenger';
return m;
});
}

async function markAttempt(nome, { idx, total, loginMasked, reasonCode, message }) {
await manifestStore.update(nome, (m) => {
m = m || {};
m.accountFlags = m.accountFlags || {};
const c = Number(m.accountFlags.loginAutoAttemptCount || 0) || 0;
const next = Math.max(c, idx); // garante incremento
m.accountFlags.loginAutoAttemptCount = next;
m.accountFlags.lastLoginAutoAttemptAt = Date.now();
m.accountFlags.lastLoginTryError = `${String(reasonCode||'unknown')}${message ? (':' + String(message).slice(0,160)) : ''}`;
m.accountFlags.lastLoginTryReasonCode = String(reasonCode||'unknown');
m.accountFlags.lastLoginTrySource = 'messenger';
return m;
});
await issues.append(
nome,
'auto_login_attempt',
`try=${idx}/${total} loginMasked=${loginMasked} reason=${reasonCode||''} msg=${(message||'').slice(0,80)}`
);
}

async function markEscalationToHuman(nome) {
await manifestStore.update(nome, (m) => {
m = m || {};
m.accountFlags = m.accountFlags || {};
m.accountFlags.autoLoginEscalatedAt = Date.now();
m.accountFlags.humanRecommended = true;
m.accountFlags.humanReason = 'Auto-login falhou 3x';
// PIL problema conta
m.accountFlags.problemaConta = true;
m.accountFlags.problemaContaMsg = 'Problemas na conta — Auto-login falhou 3x (programático)';
return m;
});
await issues.append(nome, 'auto_login_escalate_human', 'after=3 tries');
}

async function checkVirtusOk(page) {
// Considere Messenger grid pronta como critério de Virtus OK
return await evaluateMessengerGridOk(page);
}

async function checkRobeOk(nome, { waitMs = 5000 } = {}) {
const t0 = Date.now();
let ok = false;
while ((Date.now() - t0) < waitMs) {
const st = getRobeStateFromStatus(nome);
if (isRobeActive(st)) { ok = true; break; }
await sleep(300);
}
return ok;
}

function ensureAdapter(adapter) {
if (!adapter || typeof adapter.getController !== 'function') {
throw new Error('adapter inválido: getController(nome) obrigatório');
}
// startVirtus/robePlay/escalateToHuman são desejáveis; se ausentes, stub.
if (typeof adapter.startVirtus !== 'function') adapter.startVirtus = async () => ({ ok: true });
if (typeof adapter.robePlay   !== 'function') adapter.robePlay   = async () => ({ ok: true });
if (typeof adapter.escalateToHuman !== 'function') adapter.escalateToHuman = async () => ({ ok: true });
return adapter;
}

async function tryAutoLogin({ nome, adapter, maxTentativas = 3 } = {}) {
const result = { sucesso: false, escalonouHumano: false, tentativas: 0, motivo: '' };
try {
if (!nome) throw new Error('nome_obrigatorio');
adapter = ensureAdapter(adapter);

// Pré-carrega manifest + credenciais
const man = await manifestStore.read(nome);
if (!man || !man.credentials || !man.credentials.login || !man.credentials.password) {
  result.motivo = 'sem_credenciais';
  return result;
}

const ctrl = await adapter.getController(nome);
if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
  result.motivo = 'sem_browser';
  return result;
}

// Resolve page principal (pode mudar ao longo das tentativas)
let page = await getMainPageFromCtrl(ctrl);
if (!page) {
  result.motivo = 'sem_page';
  return result;
}

const total = Math.max(1, Math.min(3, maxTentativas));
const loginMasked = utils.maskLogin(man.credentials.login);

for (let i = 1; i <= total; i++) {
  result.tentativas = i;

  // Marca a tentativa imediatamente (PIL)
  await markAttempt(nome, {
    idx: i,
    total,
    loginMasked,
    reasonCode: 'init',
    message: 'start_attempt'
  });

  // Executa tentativa de login
  let loginRes = null;
  try {
    loginRes = await browserHelper.loginWithCredentials(
      page,
      { login: man.credentials.login, password: man.credentials.password, keepLogged: true, preferMessenger: true },
      { timeoutMs: 60000, singleDomain: true }
    );
  } catch (e) {
    loginRes = { ok: false, reason: 'exception', message: (e && e.message) || String(e) };
  }

  // Atualiza marcação textual da tentativa com reason real
  await markAttempt(nome, {
    idx: i,
    total,
    loginMasked,
    reasonCode: (loginRes && loginRes.reason) || 'unknown',
    message: (loginRes && loginRes.message) || ''
  });

  // Desbloqueia automações IMEDIATAMENTE (não espera confirmação)
  ensurePostAttemptAutomation(adapter, nome).catch(()=>{});

  // Reobtem controller/page (pode ter mudado a mainPage)
  {
    const ctrlNow = await adapter.getController(nome);
    const pageNow = await getMainPageFromCtrl(ctrlNow);
    if (pageNow) page = pageNow;
  }

  // Pós-tentativa: pequena janela para a página estabilizar
  await sleep(1200);

  // Confirmação pós-login:
  const stillLogin = await detectLoginStillRequired(page);
  const virtusOk = await checkVirtusOk(page);
  const robeOk   = await checkRobeOk(nome, { waitMs: 6000 });

  if (!stillLogin && virtusOk && robeOk) {
    // SUCESSO — limpa flags e registra
    await clearLoginFlagsSuccess(nome);
    await issues.append(nome, 'auto_login_success', `try=${i}/${total} grid_ok=true robe_ok=true`);
    result.sucesso = true;
    result.motivo = 'ok';
    return result;
  }

  // Falha parcial — mantém PILs, marca pós login fail
  await markPostFail(nome, { reasonCode: (loginRes && loginRes.reason) || 'post_fail', message: (loginRes && loginRes.message) || '' });
  await issues.append(
    nome,
    'auto_login_fail',
    `try=${i}/${total} postOk=false stillLogin=${stillLogin} virtusOk=${virtusOk} robeOk=${robeOk}`
  );

  if (i < total) {
    await sleep(1000);
    continue;
  }

  // Estourou 3 tentativas — escalona para Humano + problema na conta
  await markEscalationToHuman(nome);
  result.escalonouHumano = true;
  result.motivo = 'falhou_3x';
  try { await adapter.escalateToHuman(nome); } catch {}
  return result;
}

// Fallback
result.motivo = 'loop_finalizado_sem_sucesso';
return result;

} catch (e) {
// Falha de execução do módulo — log e retorna insucesso
try { await issues.append(nome || 'system', 'auto_login_fail_exception', (e && e.message) || String(e)); } catch {}
result.motivo = 'exception';
return result;
}
}

module.exports = { tryAutoLogin };