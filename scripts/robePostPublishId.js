'use strict';

/**
 * ROBE pós-publicação / overlay humano — verificação de documento Marketplace (id.png).
 *
 * Contrato forense:
 * - Default: ID - nao (nem foto nem celular feitos hoje, America/Sao_Paulo).
 * - Foto concluida marca so robeIdDocDoneDay (ID - sim).
 * - Celular concluido marca so robeIdPhoneDoneDay (ID celular sim).
 * - Os dois pulam a verificacao no mesmo dia. Na meia-noite de SP os dois voltam a ID - nao.
 * - ID - nao: cada postagem olha acao necessaria de hoje. Sem acao, nao marca e tenta de novo no proximo post.
 * - runHumanVerifyId NUNCA marca a flag.
 * - Falha/timeout NUNCA invalida publish_ok (caller engole erros).
 * - Auto: se ID - sim → encerra na hora (sem selling/scan).
 * - pageHandle: aba fechada != navegacao. Redirect create→selling nao e page_gone.
 * - Auto: se ID - nao → olha banner no TOPO do selling (sem scroll-hunt);
 *   tem ação → só segue se "Anunciado em" for HOJE (America/Sao_Paulo);
 *   anúncio de dia anterior → skip (falso positivo / já tratado ontem);
 *   sem banner → skip rápido e fecha o fluxo.
 * - Humano (Verificar ID): pode abrir qualquer ação (firstAny); NÃO marca flag.
 */

const fs = require('fs');
const path = require('path');
const manifestStore = require('./manifestStore.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');
const provisionAudit = require('./provisionAudit.js');
const textverified = require('./textverifiedClient.js');
const fileStore = require('./fileStore.js');

const ID_PNG_PATH = path.join(__dirname, '..', 'dados', 'id.png');
const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';

const BUDGET_TOTAL_MS = 900000;
const BUDGET_SKIP_MS = 25000;
const WAIT_POST_SETTLE_MS = 4000;
const WAIT_STEP_MS = 5000;
const WAIT_FEED_SETTLE_MS = 10000;
const WAIT_AFTER_UPLOAD_MS = 7000;
const POLL_SUCCESS_MS = 180000;
const POLL_AFTER_REFRESH_MS = 60000;
const NAV_TIMEOUT_MS = 120000;
/** Banner “ação necessária” fica no topo — sem caça por scroll. */
const TOP_SCAN_ATTEMPTS_AUTO = 3;
const TOP_SCAN_ATTEMPTS_HUMAN = 4;
const TOP_SCAN_GAP_MS = 3500;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

function norm(s) {
  try {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return String(s || '').toLowerCase().trim();
  }
}

// Frases antigas continuam. A tela nova diz "Confirme sua identidade para publicar...".
// A palavra identidade cobre uma frase futura que mude o resto e mantenha essa palavra.
const MARKETPLACE_ACTION_RE = /uma\s+acao\s+e\s+necessaria(\s+para\s+esse\s+classificado)?|acao\s+necessaria|confirme\s+sua\s+identidade|verifique\s+sua\s+identidade\s+para\s+publicar|verify\s+your\s+identity\s+to\s+publish|action\s+required|se\s+requiere\s+una\s+accion|\bidentidade\b/;

function isMarketplaceActionText(text) {
  return MARKETPLACE_ACTION_RE.test(norm(text));
}

function isIdentityConfirmLabel(text) {
  const n = norm(text);
  if (!n || n.length > 80) return false;
  if (!n.includes('identidade') && !n.includes('identity')) return false;
  return /\b(confirme|confirmar|confirma|confirm|verifique|verificar|verifica|verify)\b/.test(n);
}

function isIdentityDocumentLabel(text) {
  const n = norm(text);
  if (!n || n.length > 120) return false;
  const hasThing = n.includes('identidade') || n.includes('identity') || n.includes('documento') || n.includes('document');
  if (!hasThing) return false;
  return /\b(carregar|carregue|envie|enviar|upload|adicionar|add)\b/.test(n);
}

function isIdentityReviewText(text) {
  const n = norm(text);
  if (!n) return false;
  const hasId = n.includes('identidade') || n.includes('identity');
  if (!hasId) return false;
  return n.includes('em andamento') || n.includes('analis') || n.includes('enviad') || n.includes('submitted');
}

function isIdentityRetryText(text) {
  const n = norm(text);
  if (!n.includes('identidade') && !n.includes('identity')) return false;
  return n.includes('nao foi possivel') || n.includes('nao conseguimos validar');
}

function isIdentityDocIntroText(text) {
  const n = norm(text);
  if (!n.includes('identidade') && !n.includes('identity')) return false;
  return n.includes('com um documento') || n.includes('reconhecimento facial') || n.includes('facial recognition');
}

function isAdvanceLabel(text) {
  const n = norm(text);
  if (!n || n.length > 40) return false;
  return n === 'avancar' || n === 'next';
}

function isCnhChoiceLabel(text) {
  const n = norm(text);
  if (!n || n.length > 40) return false;
  return n === 'carteira de habilitacao' || n === 'driver license' || n === "driver's license" || n === 'drivers license';
}

function rgbParts(color) {
  const m = String(color || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isBlueFill(color) {
  const rgb = rgbParts(color);
  if (!rgb) return false;
  const [r, g, b] = rgb;
  return b >= 80 && b > r + 25 && b >= g - 15;
}

function buttonLooksEnabled(state) {
  if (!state || state.found !== true || state.disabled === true) return false;
  if (Number(state.opacity) < 0.75) return false;
  return isBlueFill(state.bg);
}

function isUnitedStatesDialOption(text) {
  const n = norm(text);
  if (!n) return false;
  if (n.includes('minor') || n.includes('virgin') || n.includes('islands')) return false;
  return n.includes('united states (+1)');
}

function extractMarketplacePhoneConfirmInfoFromText(text) {
  const body = norm(text);
  const marketplaceTitle = body.includes('confirme sua identidade no marketplace');
  const unusualActivity = body.includes('detectamos atividade incomum na sua conta');
  const phonePrompt = body.includes('confirme seu numero de celular');
  const smsPrompt = body.includes('enviaremos um sms com um codigo de confirmacao');
  const phoneVerification = body.includes('continue para a verificacao do telefone') || body.includes('verificacao do telefone');
  const detected = !!(phonePrompt && (smsPrompt || marketplaceTitle || unusualActivity || phoneVerification));
  const parts = [];
  if (marketplaceTitle) parts.push('Confirme sua identidade no Marketplace');
  if (unusualActivity) parts.push('Detectamos atividade incomum na sua conta');
  if (phonePrompt) parts.push('Confirme seu numero de celular');
  if (smsPrompt) parts.push('Enviaremos um SMS com um codigo de confirmacao');
  return {
    detected,
    marketplaceTitle,
    unusualActivity,
    phonePrompt,
    smsPrompt,
    phoneVerification,
    title: phonePrompt ? 'Confirme seu numero de celular' : (marketplaceTitle ? 'Confirme sua identidade no Marketplace' : ''),
    snippet: parts.join(' | ').slice(0, 240)
  };
}

async function readMarketplacePhoneConfirmInfo(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const body = normLocal(document.body && (document.body.innerText || document.body.textContent) || '');
      const marketplaceTitle = body.includes('confirme sua identidade no marketplace');
      const unusualActivity = body.includes('detectamos atividade incomum na sua conta');
      const phonePrompt = body.includes('confirme seu numero de celular');
      const smsPrompt = body.includes('enviaremos um sms com um codigo de confirmacao');
      const phoneVerification =
        body.includes('continue para a verificacao do telefone') ||
        body.includes('verificacao do telefone') ||
        !!Array.from(document.querySelectorAll('[aria-label]')).find((el) => {
          const label = normLocal(el.getAttribute('aria-label') || '');
          return (
            label.includes('confirme seu numero de celular') ||
            label.includes('continue para a verificacao do telefone')
          );
        });
      const detected = !!(phonePrompt && (smsPrompt || marketplaceTitle || unusualActivity || phoneVerification));
      const parts = [];
      if (marketplaceTitle) parts.push('Confirme sua identidade no Marketplace');
      if (unusualActivity) parts.push('Detectamos atividade incomum na sua conta');
      if (phonePrompt) parts.push('Confirme seu numero de celular');
      if (smsPrompt) parts.push('Enviaremos um SMS com um codigo de confirmacao');
      return {
        detected,
        marketplaceTitle,
        unusualActivity,
        phonePrompt,
        smsPrompt,
        phoneVerification,
        title: phonePrompt ? 'Confirme seu numero de celular' : (marketplaceTitle ? 'Confirme sua identidade no Marketplace' : ''),
        snippet: parts.join(' | ').slice(0, 240)
      };
    });
  } catch {
    return extractMarketplacePhoneConfirmInfoFromText('');
  }
}

function todaySP(now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(now));
  } catch {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function isDoneTodayFromDay(doneDay, now = Date.now()) {
  return String(doneDay || '').trim() === todaySP(now);
}

function isSameSpDay(atMs, now = Date.now()) {
  const at = Number(atMs);
  if (!Number.isFinite(at) || at <= 0) return false;
  return todaySP(at) === todaySP(now);
}

function phoneAlertFlagsForToday(flags, now = Date.now()) {
  const f = (flags && typeof flags === 'object') ? flags : {};
  const errorOn = f.marketplacePhoneError === true;
  const noBalanceOn = f.marketplacePhoneNoBalance === true;
  const errorToday = errorOn && isSameSpDay(f.marketplacePhoneErrorAt, now);
  const noBalanceToday = noBalanceOn && isSameSpDay(f.marketplacePhoneNoBalanceAt, now);
  const docOn = f.marketplaceDocError === true;
  const docToday = docOn && isSameSpDay(f.marketplaceDocErrorAt, now);
  return {
    marketplacePhoneError: errorToday,
    marketplacePhoneNoBalance: noBalanceToday,
    marketplaceDocError: docToday,
    staleError: errorOn && !errorToday,
    staleNoBalance: noBalanceOn && !noBalanceToday,
    staleDocError: docOn && !docToday
  };
}

function shouldMarkDocError(result) {
  if (!result || result.ok === true || result.skipped === true) return false;
  if (result.marketplacePhoneError === true) return false;
  if (result.marketplacePhoneNoBalance === true) return false;
  if (result.marketplacePhoneVerified === true) return false;
  const reason = String(result.error || result.reason || '');
  if(/^account_cycle_|^account_security:/.test(reason))return false;
  if (
    reason === 'no_action_needed' ||
    reason === 'no_action_needed_today' ||
    reason === 'action_stale_not_today' ||
    reason === 'page_gone' ||
    reason === 'already_done_today'
  ) return false;
  return true;
}

function classifyIdToday(docDay, phoneDay, now = Date.now()) {
  if (isDoneTodayFromDay(phoneDay, now)) return 'phone';
  if (isDoneTodayFromDay(docDay, now)) return 'doc';
  return 'none';
}

function idFlagsForToday(docDay, phoneDay, now = Date.now()) {
  const kind = classifyIdToday(docDay, phoneDay, now);
  return {
    skip: kind !== 'none',
    robeIdDocDoneToday: kind === 'doc',
    robeIdPhoneDoneToday: kind === 'phone'
  };
}

function getIdPngPath() {
  return ID_PNG_PATH;
}

function idPngExists() {
  try {
    return fs.existsSync(ID_PNG_PATH) && fs.statSync(ID_PNG_PATH).isFile();
  } catch {
    return false;
  }
}

function deadlineLeft(deadlineAt) {
  const d = Number(deadlineAt) || 0;
  if (!d) return BUDGET_TOTAL_MS;
  return Math.max(0, require('./carrierV2/clock').effective(d) - Date.now());
}

function assertBudget(deadlineAt, where) {
  if (deadlineLeft(deadlineAt) <= 0) {
    const err = new Error(`id_doc_budget_exhausted:${where || 'unknown'}`);
    err.code = 'ID_DOC_BUDGET';
    throw err;
  }
}

function logEvt(nome, source, step, extra) {
  const payload = Object.assign(
    {
      ts: Date.now(),
      source: String(source || ''),
      step: String(step || ''),
      day: todaySP()
    },
    extra || {}
  );
  try {
    stepLog.appendJSONL(nome, 'robe', Object.assign({ event: 'robe_id_doc', attempt: 0 }, payload));
  } catch {}
  try {
    provisionAudit.append(
      Object.assign({ event: `robe_id_doc_${step}`, nome: String(nome || '') }, payload)
    );
  } catch {}
  try {
    logger.info('[ROBE_ID_DOC]', Object.assign({ nome }, payload));
  } catch {}
}

async function readIdDays(nome) {
  try {
    const man = await manifestStore.read(nome);
    const flags = (man && man.accountFlags) || {};
    return {
      docDay: flags.robeIdDocDoneDay ? String(flags.robeIdDocDoneDay) : '',
      phoneDay: flags.robeIdPhoneDoneDay ? String(flags.robeIdPhoneDoneDay) : ''
    };
  } catch {
    return { docDay: '', phoneDay: '' };
  }
}

async function isDoneToday(nome, now = Date.now()) {
  const days = await readIdDays(nome);
  return classifyIdToday(days.docDay, days.phoneDay, now) !== 'none';
}

async function markDoneToday(nome, { via = 'doc' } = {}) {
  const day = todaySP();
  const now = Date.now();
  await manifestStore.update(nome, (m) => {
    m = m || {};
    m.accountFlags = m.accountFlags || {};
    if (via === 'phone') {
      m.accountFlags.robeIdPhoneDoneDay = day;
      m.accountFlags.robeIdPhoneDoneAt = now;
      if (String(m.accountFlags.robeIdDocDoneDay || '') === day) {
        delete m.accountFlags.robeIdDocDoneDay;
        delete m.accountFlags.robeIdDocDoneAt;
      }
    } else {
      m.accountFlags.robeIdDocDoneDay = day;
      m.accountFlags.robeIdDocDoneAt = now;
    }
    return m;
  });
  return day;
}

async function clearStaleMarketplacePhoneFlags(nome, now = Date.now()) {
  try {
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const f = (m.accountFlags && typeof m.accountFlags === 'object') ? m.accountFlags : null;
      if (!f) return m;
      const view = phoneAlertFlagsForToday(f, now);
      if (view.staleError) {
        delete f.marketplacePhoneError;
        delete f.marketplacePhoneErrorAt;
        delete f.marketplacePhoneErrorReason;
        delete f.marketplacePhoneErrorText;
      }
      if (view.staleNoBalance) {
        delete f.marketplacePhoneNoBalance;
        delete f.marketplacePhoneNoBalanceAt;
        delete f.marketplacePhoneNoBalanceReason;
        delete f.marketplacePhoneNoBalanceText;
      }
      if (view.staleDocError) {
        delete f.marketplaceDocError;
        delete f.marketplaceDocErrorAt;
        delete f.marketplaceDocErrorReason;
        delete f.marketplaceDocErrorText;
      }
      if (Object.keys(f).length) m.accountFlags = f;
      else delete m.accountFlags;
      return m;
    });
  } catch {}
}

async function clearMarketplacePhoneFlags(nome) {
  try {
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const f = (m.accountFlags && typeof m.accountFlags === 'object') ? m.accountFlags : {};
      delete f.marketplacePhoneError;
      delete f.marketplacePhoneErrorAt;
      delete f.marketplacePhoneErrorReason;
      delete f.marketplacePhoneErrorText;
      delete f.marketplacePhoneNoBalance;
      delete f.marketplacePhoneNoBalanceAt;
      delete f.marketplacePhoneNoBalanceReason;
      delete f.marketplacePhoneNoBalanceText;
      delete f.marketplaceDocError;
      delete f.marketplaceDocErrorAt;
      delete f.marketplaceDocErrorReason;
      delete f.marketplaceDocErrorText;
      if (Object.keys(f).length) m.accountFlags = f;
      else delete m.accountFlags;
      return m;
    });
  } catch {}
}

async function setMarketplaceDocFlag(nome, { reason = '', text = '' } = {}) {
  const now = Date.now();
  try {
    await manifestStore.update(nome, (m) => {
      m = m || {};
      m.accountFlags = m.accountFlags || {};
      m.accountFlags.marketplaceDocError = true;
      m.accountFlags.marketplaceDocErrorAt = now;
      m.accountFlags.marketplaceDocErrorReason = require('./flowFailureKind').reason(reason || 'marketplace_doc_error', text).slice(0, 140);
      m.accountFlags.marketplaceDocErrorText = String(text || '').slice(0, 400);
      return m;
    });
  } catch {}
}

async function setMarketplacePhoneFlag(nome, kind, { reason = '', text = '' } = {}) {
  const now = Date.now();
  try {
    await manifestStore.update(nome, (m) => {
      m = m || {};
      m.accountFlags = m.accountFlags || {};
      delete m.accountFlags.marketplacePhoneError;
      delete m.accountFlags.marketplacePhoneErrorAt;
      delete m.accountFlags.marketplacePhoneErrorReason;
      delete m.accountFlags.marketplacePhoneErrorText;
      delete m.accountFlags.marketplacePhoneNoBalance;
      delete m.accountFlags.marketplacePhoneNoBalanceAt;
      delete m.accountFlags.marketplacePhoneNoBalanceReason;
      delete m.accountFlags.marketplacePhoneNoBalanceText;
      if (kind === 'no_balance') {
        m.accountFlags.marketplacePhoneNoBalance = true;
        m.accountFlags.marketplacePhoneNoBalanceAt = now;
        m.accountFlags.marketplacePhoneNoBalanceReason = String(reason || 'textverified_no_balance').slice(0, 140);
        m.accountFlags.marketplacePhoneNoBalanceText = String(text || '').slice(0, 400);
      } else {
        m.accountFlags.marketplacePhoneError = true;
        m.accountFlags.marketplacePhoneErrorAt = now;
        m.accountFlags.marketplacePhoneErrorReason = String(reason || 'marketplace_phone_error').slice(0, 140);
        m.accountFlags.marketplacePhoneErrorText = String(text || '').slice(0, 400);
      }
      return m;
    });
  } catch {}
}

async function clearMarketplacePhoneNoBalanceAllAccounts() {
  try {
    const perfis = fileStore && typeof fileStore.loadPerfisJson === 'function'
      ? (fileStore.loadPerfisJson() || [])
      : [];
    for (const p of perfis) {
      const nome = String(p && p.nome || '').trim();
      if (!nome) continue;
      try {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          const f = (m.accountFlags && typeof m.accountFlags === 'object') ? m.accountFlags : {};
          delete f.marketplacePhoneNoBalance;
          delete f.marketplacePhoneNoBalanceAt;
          delete f.marketplacePhoneNoBalanceReason;
          delete f.marketplacePhoneNoBalanceText;
          if (Object.keys(f).length) m.accountFlags = f;
          else delete m.accountFlags;
          return m;
        });
      } catch {}
    }
  } catch {}
}

function pageHandleState(page) {
  if (!page) return { ok: false, reason: 'no_page', url: '' };
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      return { ok: false, reason: 'closed', url: '' };
    }
  } catch {
    return { ok: false, reason: 'closed_throw', url: '' };
  }
  let url = '';
  try {
    url = typeof page.url === 'function' ? String(page.url() || '') : '';
  } catch {}
  return { ok: true, reason: 'open', url };
}

function isSellingUrl(url) {
  return /marketplace\/(you\/selling|you\/dashboard|profile)/i.test(String(url || ''));
}

async function clickByText(page, patterns, { withinDialog = false, exact = false } = {}) {
  const result=await require('./interactionReadiness').clickControl(page,patterns,{withinDialog,exact,timeoutMs:15000});
  return result.ok===true;
}

/** Espera calma até conseguir clicar (páginas de checkpoint são pesadas). */
async function waitClickByText(page, patterns, { maxMs = 90000, deadlineAt, withinDialog = false, exact = false, settleMs = WAIT_STEP_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    const ok = await clickByText(page, patterns, { withinDialog, exact });
    if (ok) {
      await sleep(settleMs);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function detectIdWizardScreen(page) {
  try {
    const screen = await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const body = normLocal(document.body && (document.body.innerText || document.body.textContent) || '');
      const networkCode = body.match(/\berr_(?:timed_out|connection_[a-z_]+|tunnel_[a-z_]+|proxy_[a-z_]+|name_not_resolved)\b/);
      if (networkCode && (body.includes('nao e possivel acessar esse site') || body.includes('this site') || String(document.URL || '').startsWith('chrome-error:'))) {
        return 'network_error:' + networkCode[0].toUpperCase();
      }
      const hasAria = (re) =>
        !!Array.from(document.querySelectorAll('[aria-label]')).find((el) =>
          re.test(normLocal(el.getAttribute('aria-label') || ''))
        );
      const marketplaceTitle = body.includes('confirme sua identidade no marketplace');
      const unusualActivity = body.includes('detectamos atividade incomum na sua conta');
      const phonePrompt = body.includes('confirme seu numero de celular');
      const smsPrompt = body.includes('enviaremos um sms com um codigo de confirmacao');
      const phoneVerification =
        body.includes('continue para a verificacao do telefone') ||
        body.includes('verificacao do telefone') ||
        hasAria(/continue para a verificacao do telefone/) ||
        hasAria(/confirme seu numero de celular/);
      const hasFile = !!document.querySelector('input[type="file"]');
      if (body.includes('sua conta foi verificada')) {
        return 'marketplace_phone_success';
      }
      if (
        body.includes('insira o codigo de confirmacao') ||
        body.includes('reenviar codigo')
      ) {
        return 'marketplace_phone_code';
      }
      if (body.includes('insira o numero do seu celular')) {
        return 'marketplace_phone_entry';
      }
      if (phonePrompt && (smsPrompt || marketplaceTitle || unusualActivity || phoneVerification)) {
        return 'marketplace_phone_confirm';
      }
      if (body.includes('numero de telefone') && body.includes('enviar codigo') && !body.includes('reenviar codigo')) {
        return 'marketplace_phone_entry';
      }
      if (
        body.includes('suas informacoes foram enviadas') ||
        body.includes('enviadas para verificacao') ||
        body.includes('your information was submitted')
      ) {
        return 'success';
      }
      // Pós-Enviar: “Confirmação de identidade em andamento” + Pronto
      if (
        body.includes('confirmacao de identidade em andamento') ||
        body.includes('normalmente analisamos suas informacoes') ||
        (body.includes('em andamento') && body.includes('48 horas')) ||
        (hasAria(/^pronto$/) && body.includes('em andamento'))
      ) {
        return 'pending_review';
      }
      const cnhChoice = Array.from(document.querySelectorAll('span,div,label')).some((el) => {
        const own = normLocal(el.innerText || el.textContent || '');
        if (own !== 'carteira de habilitacao' && own !== 'driver license' && own !== "driver's license" && own !== 'drivers license') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight;
      });
      if (cnhChoice) return 'doc_type';
      if (body.includes('carregue uma foto do seu documento') || body.includes('carregue uma foto do documento')) return 'upload_photo';
      // A política de retenção de 30 dias também aparece na tela Continuar.
      // O controle real visível tem precedência sobre esse texto informativo.
      const continueVisible = Array.from(document.querySelectorAll('[role="button"],button')).some(el => {
        const label = normLocal(el.getAttribute('aria-label') || el.innerText || el.textContent);
        if (label !== 'continuar' && label !== 'continue') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 2 && rect.height > 2 && !el.closest('[aria-hidden="true"]') &&
          !el.disabled && el.getAttribute('aria-disabled') !== 'true';
      });
      if (continueVisible && (body.includes('verificacao de identidade') || body.includes('identity verification'))) return 'continuar';
      if (
        (body.includes('com um documento') || body.includes('reconhecimento facial') || body.includes('facial recognition')) &&
        (body.includes('identidade') || body.includes('identity'))
      ) {
        return 'identity_doc_intro';
      }
      if (
        (body.includes('identidade') || body.includes('identity')) &&
        (body.includes('nao foi possivel') || body.includes('nao conseguimos validar'))
      ) {
        return 'identity_retry';
      }
      if (body.includes('carregue uma foto do seu documento') || body.includes('carregue uma foto do documento')) return 'upload_photo';
      // doc_type: exige o título da lista (não basta “carteira…” solto no body)
      if (
        body.includes('escolha um tipo de documento') ||
        (body.includes('carteira de habilitacao') &&
          !!document.querySelector('[role="radio"], [role="listbox"]'))
      ) {
        return 'doc_type';
      }
      const docVerb = /\b(carregar|carregue|envie|enviar|upload|adicionar|add)\b/;
      const buttonSaysDocument = Array.from(document.querySelectorAll('[role="button"],button,a,[role="link"]')).some((el) => {
        const label = normLocal(`${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`).slice(0, 120);
        if (!label) return false;
        const hasThing = label.includes('identidade') || label.includes('identity') || label.includes('documento') || label.includes('document');
        return hasThing && docVerb.test(label);
      });
      if (buttonSaysDocument) {
        return 'carregar_doc';
      }
      if (
        body.includes('verificacao de identidade') ||
        body.includes('verificação de identidade') ||
        hasAria(/^continuar$/)
      ) {
        if (!hasAria(/carregar documento/)) return 'continuar';
      }
      const confirmLabels=/^(?:confirme|confirmar|verificar|verifique)(?: sua)? identidade$|^(?:confirm|verify)(?: your)? identity$/;
      const buttonSaysIdentity=Array.from(document.querySelectorAll('[role="button"],button,a,[role="link"]')).some(el=>{
        const label=normLocal(el.getAttribute('aria-label')||el.innerText||el.textContent);
        const rect=el.getBoundingClientRect();
        return confirmLabels.test(label)&&rect.width>2&&rect.height>2&&!el.closest('[aria-hidden="true"],[inert]');
      });
      if(buttonSaysIdentity)return 'confirm';
      if(/confirme sua identidade|confirmar identidade|verifique sua identidade|verificar identidade|verify your identity|confirm your identity/.test(body))return 'listing_identity_required';
      return 'unknown';
    });
    if (screen.startsWith('network_error:')) {
      const isolated = require('./isolatedAccountFlow').context(page, 'id');
      const prefix = isolated && isolated.proxyRequired && isolated.rail.isProxyArmed ? 'identity_proxy_navigation_failed:' : 'identity_navigation_failed:';
      throw new Error(prefix + screen.slice('network_error:'.length));
    }
    return screen;
  } catch (error) {
    if (/^identity_(?:proxy_)?navigation_failed:/.test(String(error && error.message))) throw error;
    return 'unknown';
  }
}

async function recordIdFailure(page, nome, source, error) {
  try {
    const snapshot = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      text: String(document.body && document.body.innerText || '').slice(-7000),
      controls: Array.from(document.querySelectorAll('button,[role="button"],[role="radio"],input')).map(el => ({
        role: el.getAttribute('role'), aria: el.getAttribute('aria-label'),
        text: String(el.innerText || '').slice(0, 100), type: el.type,
        tabindex: el.getAttribute('tabindex'), disabled: el.disabled || el.getAttribute('aria-disabled'),
        visible: !!(el.getBoundingClientRect().width && el.getBoundingClientRect().height)
      }))
    }));
    const dir = path.join(__dirname, '..', 'dados', 'diag', 'id', String(nome));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}_failure.json`);
    fs.writeFileSync(file, JSON.stringify({ error, snapshot }, null, 2));
    logEvt(nome, source, 'wizard_failure_snapshot', { error, file });
  } catch {}
}

async function clickConfirmeSuaIdentidade(page) {
 const labels=['confirmar identidade','confirme sua identidade','verificar identidade','verifique sua identidade','confirm identity','confirm your identity','verify your identity'];
 const result=await require('./interactionReadiness').clickControl(page,labels,{exact:true,withinDialog:true,timeoutMs:15000});return result.ok===true;
}

async function clickIdentityDocument(page) {
 const labels=['carregar documento de identidade','carregar seu documento de identidade','enviar documento de identidade','upload identity document','upload your id'];
 const result=await require('./interactionReadiness').clickControl(page,labels,{exact:true,withinDialog:true,timeoutMs:15000});return result.ok===true;
}

async function pageHasNorm(page, testFnSource) {
  try {
    return await page.evaluate((src) => {
      const raw = String((document.body && (document.body.innerText || document.body.textContent)) || '');
      const n = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return (new Function('n', `return (${src});`))(n);
    }, testFnSource);
  } catch {
    return false;
  }
}

async function identityRetryStillOpen(page) {
  return pageHasNorm(page, "(n.includes('nao foi possivel') || n.includes('nao conseguimos validar')) && n.includes('identidade')");
}

function armIdPageHold(page, on) {
  if (!page) return;
  try { page.__virtusDeltaHumanHold = !!on; } catch {}
  try {
    const g = page.__virtusDeltaMarketplaceGuard || {};
    page.__virtusDeltaMarketplaceGuard = {
      ...g,
      outsideMessagesSince: 0,
      marketplaceInactiveSince: 0
    };
  } catch {}
}

async function takeIdentityTab(page) {
  const pause = page && page.__ctVirtusQueuePause;
  const running = page && page.__ctVirtusQueueRunning;
  const pausedNow = page && page.__ctVirtusQueuePaused;
  let alreadyPaused = false;
  try { alreadyPaused = typeof pausedNow === 'function' && pausedNow() === true; } catch {}
  let wePaused = false;
  if (typeof pause === 'function' && !alreadyPaused) {
    try { pause(true); wePaused = true; } catch {}
  }
  const start = Date.now();
  while (Date.now() - start < 120000) {
    let busy = false;
    try { busy = !!(page && page.__virtusDeltaReplyInFlight); } catch {}
    try { if (!busy && typeof running === 'function') busy = running() === true; } catch {}
    if (!busy) break;
    await sleep(200);
  }
  const holdAlready = !!(page && page.__virtusDeltaHumanHold === true);
  armIdPageHold(page, true);
  return { wePaused, holdAlready };
}

function releaseIdentityTab(page, taken) {
  if (!page || !taken) return;
  if (!taken.holdAlready) armIdPageHold(page, false);
  if (taken.wePaused && typeof page.__ctVirtusQueuePause === 'function') {
    try { page.__ctVirtusQueuePause(false); } catch {}
  }
}

function pageIsMarketplaceDocCheckpoint(page) {
  try {
    return /\/checkpoint\/1501092823525282\/\d+/i.test(String(page.url() || ''));
  } catch {
    return false;
  }
}

async function revealMarketplaceDocCheckpoint(page) {
  const on = pageIsMarketplaceDocCheckpoint(page);
  let glass;
  try { glass = require('./glassViewer.js'); } catch { return on; }
  try {
    if (typeof glass.suppressGlassForIdentity === 'function') await glass.suppressGlassForIdentity(page, on);
  } catch {}
  return on;
}

async function cnhChoiceVisible(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      return Array.from(document.querySelectorAll('span,div,label')).some((el) => {
        const own = normLocal(el.innerText || el.textContent || '');
        if (own !== 'carteira de habilitacao' && own !== 'driver license' && own !== "driver's license" && own !== 'drivers license') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight;
      });
    });
  } catch {
    return false;
  }
}

async function identityDocIntroStillOpen(page) {
  if (await cnhChoiceVisible(page)) return false;
  return pageHasNorm(page, "(n.includes('com um documento') || n.includes('reconhecimento facial')) && (n.includes('identidade') || n.includes('identity'))");
}

async function clickAvancar(page) {
  const result=await require('./interactionReadiness').clickControl(page,['avancar','next','a seguir: continue para a verificacao'],{exact:true,withinDialog:true,timeoutMs:15000});
  return result.ok===true;
}

async function readNamedButton(page, labels) {
  try {
    return await page.evaluate((wanted) => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const want = new Set(Array.isArray(wanted) ? wanted : []);
      const visible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return false;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
        const style = window.getComputedStyle(el);
        return !!(style && style.display !== 'none' && style.visibility !== 'hidden');
      };
      const paint = (el) => {
        if (!el) return '';
        const bg = String(window.getComputedStyle(el).backgroundColor || '');
        if (!bg || bg === 'transparent' || /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(bg)) return '';
        return bg;
      };
      const hits = [];
      for (const el of Array.from(document.querySelectorAll('span,div,button,[role="button"]'))) {
        const aria = normLocal(el.getAttribute('aria-label') || '');
        const own = normLocal(el.innerText || el.textContent || '');
        if (!want.has(aria) && !want.has(own)) continue;
        if ((own && own.length > 40) || (aria && aria.length > 40)) continue;
        if (!visible(el)) continue;
        const rect = el.getBoundingClientRect();
        hits.push({ el, area: rect.width * rect.height });
      }
      hits.sort((a, b) => a.area - b.area);
      const label = hits[0] && hits[0].el;
      if (!label) return { found: false };
      let box = label;
      let walk = label;
      while (walk && walk !== document.body) {
        const role = walk.getAttribute ? String(walk.getAttribute('role') || '') : '';
        const overlay = Array.from(walk.children || []).find((child) => child.getAttribute && child.getAttribute('data-visualcompletion') === 'ignore');
        if (overlay || role === 'button' || String(walk.tagName || '') === 'BUTTON') {
          const probe = overlay || walk;
          const rect = probe.getBoundingClientRect();
          if (rect.width <= 500 && rect.height <= 220) box = walk;
          break;
        }
        walk = walk.parentElement;
      }
      let disabled = false;
      let p = box;
      for (let i = 0; i < 6 && p; i++) {
        if (p.getAttribute && (p.getAttribute('aria-disabled') === 'true' || p.getAttribute('disabled') != null)) disabled = true;
        p = p.parentElement;
      }
      const style = window.getComputedStyle(box);
      const opacity = Number(style && style.opacity);
      const bg = paint(box) || paint(box.parentElement) || paint(box.firstElementChild) || '';
      return {
        found: true,
        disabled,
        opacity: Number.isFinite(opacity) ? opacity : 1,
        bg
      };
    }, labels);
  } catch {
    return { found: false };
  }
}

async function readVisibleButtonLabels(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const el of Array.from(document.querySelectorAll('button,[role="button"],span,div'))) {
        const text = normLocal(el.innerText || el.getAttribute('aria-label') || '');
        if (!text || text.length > 40) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8 || rect.top > window.innerHeight || rect.bottom < 0) continue;
        out.push(text);
        if (out.length >= 12) break;
      }
      return out;
    });
  } catch {
    return [];
  }
}

async function clickExactWord(page, words) {
 const result=await require('./interactionReadiness').clickControl(page,words,{exact:true,withinDialog:true,timeoutMs:15000});return result.ok===true;
}

async function clickBlueOverlay(page, labels) {
  const result=await require('./interactionReadiness').clickControl(page,labels,{exact:true,timeoutMs:30000});
  return result.ok===true;
}

async function uploadPromptOpen(page) {
  const byText = await pageHasNorm(
    page,
    "n.includes('carregue uma foto') || n.includes('escolher arquivo') || n.includes('adicionar arquivo') || n.includes('upload a photo')"
  );
  if (byText) return true;
  try {
    return await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"],[aria-modal="true"]');
      return !!(dialog && dialog.querySelector('input[type="file"]'));
    });
  } catch {
    return false;
  }
}

async function advanceBlueAndSeeUpload(page, deadlineAt) {
  const clicked = await clickBlueOverlay(page, ['avancar', 'next']);
  if (!clicked) return false;
  const start = Date.now();
  while (Date.now() - start < 60000 && deadlineLeft(deadlineAt) > 0) {
    if (await uploadPromptOpen(page)) return true;
    await sleep(800);
  }
  return false;
}

async function readUploadProblem(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      const root = document.querySelector('[role="dialog"],[aria-modal="true"]') || document.querySelector('[role="main"]') || document.body;
      const raw = String((root && root.innerText) || '').replace(/\s+/g, ' ').trim();
      const n = normLocal(raw);
      const bad = [
        'nao foi possivel',
        'nao conseguimos carregar',
        'ocorreu um erro',
        'tente novamente',
        'formato nao suportado',
        'formato de arquivo',
        'arquivo invalido',
        'muito pequena',
        'pelo menos 1500',
        'problemas tecnicos',
        'could not upload',
        'something went wrong'
      ];
      let hit = '';
      for (const item of bad) {
        if (n.includes(item)) { hit = item; break; }
      }
      const preview = Array.from(root.querySelectorAll('img')).some((img) => img.naturalWidth >= 200 && img.naturalHeight >= 120);
      let fileSize = 0;
      for (const el of Array.from(document.querySelectorAll('input[type="file"]'))) {
        const size = el.files && el.files[0] ? el.files[0].size : 0;
        if (size > fileSize) fileSize = size;
      }
      return { hit, preview, fileSize, snippet: raw.slice(0, 320) };
    });
  } catch {
    return { hit: '', preview: false, fileSize: 0, snippet: '' };
  }
}

async function waitPhotoAttached(page, deadlineAt) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 90000 && deadlineLeft(deadlineAt) > 0) {
    const problem = await readUploadProblem(page);
    const enviar = await readNamedButton(page, ['enviar', 'submit', 'send']);
    const enabled = buttonLooksEnabled(enviar);
    last = {
      ok: !problem.hit && (problem.preview || problem.fileSize > 0) && enabled,
      error: problem.hit ? `foto_recusada:${problem.hit}` : '',
      preview: !!problem.preview,
      fileSize: problem.fileSize || 0,
      enviar: !!enabled,
      snippet: String(problem.snippet || '').slice(0, 180)
    };
    if (problem.hit) return last;
    if (last.ok) return last;
    await sleep(800);
  }
  if (!last) return { ok: false, error: 'foto_nao_entrou', preview: false, fileSize: 0, enviar: false, snippet: '' };
  last.ok = false;
  if (!last.error) last.error = 'foto_nao_entrou';
  return last;
}

async function clickRoleAria(page, label) {
  const result=await require('./interactionReadiness').clickControl(page,[label],{exact:true,withinDialog:true,timeoutMs:15000});
  return result.ok===true;
}

async function carregarButtonVisible(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      for (const el of Array.from(document.querySelectorAll('[role="button"],button'))) {
        if (el.getAttribute('aria-disabled') === 'true') continue;
        const aria = normLocal(el.getAttribute('aria-label') || '');
        const own = normLocal(el.innerText || '').replace(/^\+\s*/, '');
        if (aria !== 'carregar' && own !== 'carregar') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function waitCarregarStable(page, deadlineAt) {
  const start = Date.now();
  let seenAt = 0;
  while (Date.now() - start < 60000 && deadlineLeft(deadlineAt) > 0) {
    if (await carregarButtonVisible(page)) {
      if (!seenAt) seenAt = Date.now();
      if (Date.now() - seenAt >= 2500) return true;
    } else {
      seenAt = 0;
    }
    await sleep(400);
  }
  return false;
}

async function clickDocIntroAvancar(page, deadlineAt) {
  const start = Date.now();
  while ((Date.now() - start) < 60000 && deadlineLeft(deadlineAt) > 0) {
    if (await cnhChoiceVisible(page)) return true;
    if (await pageHasNorm(page, "n.includes('carregue uma foto')")) return true;
    const clicked = await clickRoleAria(page, 'avancar');
    if (!clicked) await clickAvancar(page);
    await sleep(1200);
    if (await cnhChoiceVisible(page)) return true;
    if (await pageHasNorm(page, "n.includes('carregue uma foto')")) return true;
    if (!(await identityDocIntroStillOpen(page))) return true;
  }
  return false;
}

async function waitForScreenAfterConfirmIdentity(page, { deadlineAt, minMs = 8000, maxMs = 60000 } = {}) {
  const start = Date.now();
  const readyScreens = new Set([
    'marketplace_phone_confirm',
    'marketplace_phone_entry',
    'continuar',
    'carregar_doc',
    'doc_type',
    'upload_photo',
    'success',
    'pending_review',
    'identity_retry',
    'identity_doc_intro'
  ]);
  let last = '';
  let streak = 0;
  while ((Date.now() - start) < maxMs && deadlineLeft(deadlineAt) > 0) {
    await revealMarketplaceDocCheckpoint(page);
    const info = await readMarketplacePhoneConfirmInfo(page);
    const scr = (info && info.detected) ? 'marketplace_phone_confirm' : await detectIdWizardScreen(page);
    const ready = readyScreens.has(scr);
    if (ready && scr === last && (Date.now() - start) >= minMs) {
      streak += 1;
      if (streak >= 2) return { ready: true, screen: scr };
    } else if (ready) {
      last = scr;
      streak = 1;
    } else {
      last = scr;
      streak = 0;
    }
    await sleep(1500);
  }
  const info = await readMarketplacePhoneConfirmInfo(page);
  const scr = (info && info.detected) ? 'marketplace_phone_confirm' : await detectIdWizardScreen(page);
  return { ready: readyScreens.has(scr), screen: scr };
}

async function recoverEmptyIdCheckpoint(page, { elapsedMs, deadlineAt } = {}) {
  if (elapsedMs < 15000 || page.__ctIdEmptyReloaded || !pageIsMarketplaceDocCheckpoint(page) || deadlineLeft(deadlineAt) < 20000) return false;
  const empty = await page.evaluate(() => {
    const text = String(document.body && document.body.innerText || '').trim();
    if (document.readyState !== 'complete' || text.length > 80 || /erro|error|tente|try again|bloquead|suspens|não foi|nao foi/i.test(text)) return false;
    if (document.querySelector('input[type="file"]')) return false;
    return !Array.from(document.querySelectorAll('button,[role="button"]')).some(el =>
      /continuar|continue|avançar|avancar|next|enviar|submit|carregar|upload/i.test(el.getAttribute('aria-label') || el.innerText || ''));
  }).catch(() => false);
  if (!empty) return false;
  page.__ctIdEmptyReloaded = true;
  const ctx = page.__ctIdWizardContext || {};
  logEvt(ctx.nome, ctx.source, 'wizard_empty_checkpoint_reload', { elapsedMs });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(NAV_TIMEOUT_MS, deadlineLeft(deadlineAt)) });
  return true;
}

async function waitForWizardScreen(page, wanted, { maxMs = 90000, deadlineAt } = {}) {
  const want = new Set(Array.isArray(wanted) ? wanted : [wanted]);
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    await revealMarketplaceDocCheckpoint(page);
    const scr = await detectIdWizardScreen(page);
    if (want.has(scr)) return scr;
    if (scr === 'success' || scr === 'pending_review') return scr;
    if (scr === 'unknown') await recoverEmptyIdCheckpoint(page, { elapsedMs: Date.now() - start, deadlineAt });
    await sleep(2000);
  }
  return detectIdWizardScreen(page);
}

function stripUsNationalNumber(raw) {
  const d = textverified.digitsOnly(raw);
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  if (d.length === 10) return d;
  return '';
}

async function readMarketplacePhoneEntryState(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const body = normLocal(document.body && (document.body.innerText || document.body.textContent) || '');
      const phoneInputs = Array.from(document.querySelectorAll('input[type="text"]'));
      const phoneInput = phoneInputs.find((el) => {
        const label = normLocal(
          `${el.getAttribute('aria-label') || ''} ${el.closest('label')?.innerText || ''}`
        );
        return label.includes('numero de telefone');
      }) || null;
      const combo = Array.from(document.querySelectorAll('[role="combobox"]')).find((el) => {
        const txt = normLocal(el.innerText || el.textContent || '');
        return txt.includes('codigo de chamada do pais') || txt.includes('united states (+1)') || txt.includes('brazil (+55)');
      }) || null;
      const visibleDial = combo
        ? Array.from(combo.querySelectorAll('span')).map((el) => String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()).find((txt) => /\(\+\d+\)/.test(txt))
        : '';
      const send = Array.from(document.querySelectorAll('button,[role="button"],div[tabindex="0"]')).find((el) => {
        const txt = normLocal(`${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`);
        return txt === 'enviar codigo' || txt.includes('enviar codigo');
      }) || null;
      const usedText = Array.from(document.querySelectorAll('span,div,p')).find((el) => {
        const txt = normLocal(el.innerText || el.textContent || '');
        return txt.includes('foi usado recentemente por uma conta diferente') || txt.includes('tente um outro numero');
      });
      return {
        hasPhoneEntry: body.includes('insira o numero do seu celular'),
        countryText: normLocal(visibleDial || (combo ? (combo.innerText || combo.textContent || '') : '')),
        hasPhoneInput: !!phoneInput,
        hasSendCode: !!send,
        usedRecently: !!usedText,
        usedRecentlyText: usedText ? String(usedText.innerText || usedText.textContent || '').trim().slice(0, 220) : '',
        phoneValue: phoneInput ? String(phoneInput.value || '').trim() : ''
      };
    });
  } catch {
    return { hasPhoneEntry: false, countryText: '', hasPhoneInput: false, hasSendCode: false, usedRecently: false, usedRecentlyText: '', phoneValue: '' };
  }
}

async function waitForBrazilPhoneField(page, { deadlineAt } = {}) {
  const start = Date.now();
  while ((Date.now() - start) < 20000 && deadlineLeft(deadlineAt) > 0) {
    const state = await readMarketplacePhoneEntryState(page);
    if (state && isUnitedStatesDialOption(state.countryText)) return state;
    if (state && state.hasPhoneEntry && (state.countryText.includes('brazil') || state.countryText.includes('(+55)'))) {
      return state;
    }
    await sleep(500);
  }
  return readMarketplacePhoneEntryState(page);
}

async function tapKey(page, key) {
  await page.keyboard.down(key);
  await sleep(50);
  await page.keyboard.up(key);
}

async function selectMarketplacePhoneCountryUnitedStates(page, { deadlineAt } = {}) {
  for (let attempt = 1; attempt <= 3 && deadlineLeft(deadlineAt) > 0; attempt++) {
    const state = await waitForBrazilPhoneField(page, { deadlineAt });
    if (state && isUnitedStatesDialOption(state.countryText)) return true;
    if (!(state && state.hasPhoneEntry)) {
      await sleep(1000);
      continue;
    }
    try { await page.bringToFront(); } catch {}
    await sleep(800);
    try {
      await tapKey(page, 'u');
      await sleep(1000);
      await tapKey(page, 'u');
      await sleep(400);
      await tapKey(page, 'Enter');
    } catch {
      await sleep(1000);
      continue;
    }
    await sleep(1800);
    const after = await readMarketplacePhoneEntryState(page);
    if (after && isUnitedStatesDialOption(after.countryText)) return true;
    const stillBrazil = !!(after && (after.countryText.includes('brazil') || after.countryText.includes('(+55)')));
    if (!stillBrazil) return false;
  }
  const finalState = await readMarketplacePhoneEntryState(page);
  return !!(finalState && isUnitedStatesDialOption(finalState.countryText));
}

async function typeMarketplacePhoneNumber(page, nationalDigits, { deadlineAt } = {}) {
  const digits = String(nationalDigits || '').replace(/\D/g, '');
  if (digits.length !== 10) return false;
  try {
    const ok = await page.evaluate((value) => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const inp = Array.from(document.querySelectorAll('input[type="text"]')).find((el) => {
        const label = normLocal(`${el.getAttribute('aria-label') || ''} ${el.closest('label')?.innerText || ''}`);
        return label.includes('numero de telefone');
      });
      if (!inp) return false;
      inp.focus();
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }, digits);
    if (!ok) return false;
  } catch {
    return false;
  }
  for (const ch of digits) {
    assertBudget(deadlineAt, 'tv_type_phone_digit');
    try { await page.keyboard.type(ch, { delay: 250 }); } catch { return false; }
    await sleep(220);
  }
  await sleep(1500);
  const state = await readMarketplacePhoneEntryState(page);
  return !!(state && textverified.digitsOnly(state.phoneValue) === digits);
}

async function readMarketplacePhoneLaterError(page) {
  try {
    return await page.evaluate(() => {
      const raw = String(document.body && (document.body.innerText || document.body.textContent) || '');
      const body = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return body.includes('ocorreu um erro') && body.includes('tente novamente mais tarde');
    });
  } catch {
    return false;
  }
}

async function waitSendCodeOutcome(page, { deadlineAt, maxMs = 12000 } = {}) {
  const start = Date.now();
  while ((Date.now() - start) < maxMs && deadlineLeft(deadlineAt) > 0) {
    const scr = await detectIdWizardScreen(page);
    if (scr === 'marketplace_phone_code' || scr === 'marketplace_phone_success') {
      return { screen: scr, laterError: false };
    }
    const laterError = await readMarketplacePhoneLaterError(page);
    if (laterError) return { screen: scr, laterError: true };
    await sleep(1000);
  }
  const scr = await detectIdWizardScreen(page);
  return { screen: scr, laterError: await readMarketplacePhoneLaterError(page) };
}

async function clickMarketplacePhoneSendCode(page, { deadlineAt } = {}) {
  return waitClickByText(page, ['enviar codigo'], {
    maxMs: 120000,
    deadlineAt,
    withinDialog: false,
    exact: false,
    settleMs: WAIT_STEP_MS + 3000
  });
}

async function focusMarketplaceSmsInputs(page) {
  try {
    return await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[aria-label="Texto para código SMS"]'));
      if (!inputs.length) return false;
      for (const inp of inputs) {
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      inputs[0].focus();
      return true;
    });
  } catch {
    return false;
  }
}

async function typeMarketplaceSmsCode(page, code, { deadlineAt } = {}) {
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length !== 6) return false;
  const focused = await focusMarketplaceSmsInputs(page);
  if (!focused) return false;
  await sleep(1000);
  for (const ch of digits) {
    assertBudget(deadlineAt, 'tv_type_sms_digit');
    try { await page.keyboard.type(ch, { delay: 260 }); } catch { return false; }
    await sleep(180);
  }
  await sleep(1200);
  return true;
}

async function clickMarketplaceSendFinal(page, { deadlineAt } = {}) {
  return waitClickByText(page, ['enviar'], {
    maxMs: 90000,
    deadlineAt,
    withinDialog: false,
    exact: true,
    settleMs: WAIT_STEP_MS + 2000
  });
}

async function clickMarketplaceReturnToListing(page, { deadlineAt } = {}) {
  return waitClickByText(page, ['retornar ao classificado'], {
    maxMs: 90000,
    deadlineAt,
    withinDialog: false,
    exact: false,
    settleMs: WAIT_STEP_MS
  });
}

async function readMarketplaceSmsMessageIds(page, verificationNumber) {
  const sms = await textverified.listSms({ toNumber: verificationNumber });
  if (!sms.ok) return { ok: false, error: sms.error || 'sms_list_failed' };
  return {
    ok: true,
    ids: (sms.messages || []).map((m) => String(m.id || '').trim()).filter(Boolean)
  };
}

async function createTextverifiedVerificationRobust({ nome, source } = {}) {
  const minUsd = 0.75;
  const acct = await textverified.getAccount();
  if (!acct.ok) {
    return { ok: false, error: acct.error || 'textverified_account_failed' };
  }
  if (!(Number(acct.currentBalance || 0) >= minUsd)) {
    return {
      ok: false,
      marketplacePhoneNoBalance: true,
      error: 'marketplace_phone_no_balance',
      balance: Number(acct.currentBalance || 0) || 0
    };
  }
  await clearMarketplacePhoneNoBalanceAllAccounts();

  const beforeBalance = Number(acct.currentBalance || 0) || 0;
  const startedAt = Date.now();
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const created = await textverified.createVerification({});
    if (created.ok && created.verification && created.verification.id) {
      return { ok: true, verification: created.verification };
    }
    lastErr = created;
    const errText = String((created && created.error) || '').toLowerCase();
    const transient = !!(created && (
      /timeout|network|http_408|http_429|http_5\d\d/.test(errText) ||
      Number(created.status || 0) === 408 ||
      Number(created.status || 0) === 429 ||
      Number(created.status || 0) >= 500
    ));
    if (created && created.noBalance) {
      return {
        ok: false,
        marketplacePhoneNoBalance: true,
        error: 'marketplace_phone_no_balance',
        balance: beforeBalance
      };
    }
    if (!transient) break;

    const listed = await textverified.listVerifications({ pages: 3 });
    const afterAcct = await textverified.getAccount();
    if (!listed.ok || !afterAcct.ok) {
      return { ok: false, error: 'marketplace_phone_purchase_uncertain', textverifiedError: (listed.error || afterAcct.error || created.error || 'unknown') };
    }
    const pending = (listed.verifications || []).find((v) => {
      const createdMs = Date.parse(String(v.createdAt || ''));
      const nearNow = Number.isFinite(createdMs) && Math.abs(createdMs - startedAt) <= 60000;
      const st = String(v.state || '').toLowerCase();
      const svc = String(v.serviceName || '').toLowerCase();
      return nearNow && st === 'verificationpending' && (!svc || svc === 'facebook' || svc === 'servicenotlisted');
    });
    if (pending) {
      if (pending.numberDigits) return { ok: true, verification: pending };
      const det = await textverified.getVerificationDetails(pending.id);
      if (det.ok && det.verification && det.verification.numberDigits) return { ok: true, verification: det.verification };
      return { ok: false, error: 'marketplace_phone_order_without_number', orderId: pending.id };
    }

    const afterBalance = Number(afterAcct.currentBalance || 0) || 0;
    if (!Number.isFinite(afterBalance) || ((beforeBalance - afterBalance) > 0.20)) {
      return { ok: false, error: 'marketplace_phone_purchase_uncertain_balance_drop', balanceBefore: beforeBalance, balanceAfter: afterBalance };
    }
    if (attempt < 2) await sleep(2500);
  }
  return {
    ok: false,
    error: lastErr && lastErr.error ? String(lastErr.error) : 'marketplace_phone_create_failed',
    marketplacePhoneNoBalance: !!(lastErr && lastErr.noBalance)
  };
}

/** Probe forense da lista de documentos (radios). */
async function probeDocTypeRadios(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const radios = Array.from(document.querySelectorAll('[role="radio"]'));
      const isCnhLabel = (t) =>
        t === 'carteira de habilitacao' ||
        t === 'driver license' ||
        t === "driver's license" ||
        t === 'drivers license';
      const cnhLabelEl = Array.from(document.querySelectorAll('span,div,label')).find((el) => {
        const own = normLocal(el.innerText || el.textContent || '');
        if (!isCnhLabel(own)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight;
      });
      const cnhRowChecked = (() => {
        if (!cnhLabelEl) return false;
        let row = cnhLabelEl;
        let walk = cnhLabelEl;
        for (let i = 0; i < 8 && walk && walk.parentElement && walk.parentElement !== document.body; i++) {
          const parent = walk.parentElement;
          const text = normLocal(parent.innerText || parent.textContent || '');
          if (text.length > 80) break;
          row = parent;
          walk = parent;
        }
        let p = cnhLabelEl;
        while (p) {
          if (p.getAttribute && (p.getAttribute('aria-checked') === 'true' || p.getAttribute('aria-selected') === 'true' || p.getAttribute('aria-pressed') === 'true')) return true;
          if (p === row) break;
          p = p.parentElement;
        }
        const input = row.querySelector && row.querySelector('input[type="radio"], input[type="checkbox"]');
        return !!(input && input.checked);
      })();
      return {
        radioCount: radios.length || (cnhLabelEl ? 1 : 0),
        cnhLabel: !!cnhLabelEl,
        items: radios.slice(0, 12).map((el) => {
          const txt = normLocal(el.innerText || el.textContent || '').slice(0, 80);
          return {
            txt,
            checked: el.getAttribute('aria-checked') === 'true',
            selected:
              el.getAttribute('aria-selected') === 'true' ||
              (el.closest('[role="option"]') &&
                el.closest('[role="option"]').getAttribute('aria-selected') === 'true')
          };
        }),
        cnhChecked: radios.some((el) => {
          const t = normLocal(el.innerText || el.textContent || '');
          const isCnh =
            t.includes('carteira de habilitacao') ||
            t.includes('driver license') ||
            t.includes("driver's license");
          if (!isCnh) return false;
          const opt = el.closest('[role="option"]');
          return (
            el.getAttribute('aria-checked') === 'true' ||
            (opt && opt.getAttribute('aria-selected') === 'true')
          );
        }) || cnhRowChecked,
        avancarEnabled: (() => {
          const nodes = Array.from(
            document.querySelectorAll('button,[role="button"],a,[role="link"],div[tabindex="0"]')
          );
          for (const el of nodes) {
            const aria = normLocal(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
            if (aria !== 'avancar' && aria !== 'next') continue;
            if (el.disabled || el.closest('[aria-disabled="true"],[aria-busy="true"]')) continue;
            if (el.getAttribute('aria-hidden') === 'true') continue;
            if(el.closest){const hidden=el.closest('[aria-hidden="true"]');if(hidden&&!(hidden.id==='scrollview'&&/^\/checkpoint\/1501092823525282\//.test(location.pathname)&&!hidden.parentElement?.closest('[aria-hidden="true"]')))continue;}
            const rect=el.getBoundingClientRect(),style=getComputedStyle(el);
            if(rect.width<2||rect.height<2||style.visibility==='hidden'||style.display==='none')continue;
            return true;
          }
          return false;
        })()
      };
    });
  } catch (e) {
    return { radioCount: 0, items: [], cnhChecked: false, avancarEnabled: false, error: String((e && e.message) || e) };
  }
}

async function clickCnhChoice(page) {
  require('./interactionLease').assert(page);
  const out = { clicked: false, verified: false, method: 'cnh_label', label: null };
  let point = null;
  try {
    point = await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const isCnhLabel = (t) =>
        t === 'carteira de habilitacao' ||
        t === 'driver license' ||
        t === "driver's license" ||
        t === 'drivers license';
      const hits = [];
      for (const el of Array.from(document.querySelectorAll('span,div,label'))) {
        const own = normLocal(el.innerText || el.textContent || '');
        if (!isCnhLabel(own)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
        hits.push({
          x: rect.left + (rect.width / 2),
          y: rect.top + (rect.height / 2),
          area: rect.width * rect.height,
          label: own
        });
      }
      hits.sort((a, b) => a.area - b.area);
      return hits[0] || null;
    });
  } catch {}
  if (!point) return out;
  try {
    await page.mouse.click(point.x, point.y, { delay: 80 });
    out.clicked = true;
    out.label = point.label || 'Carteira de habilitação';
  } catch {}
  await sleep(700);
  try {
    out.verified = await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      return Array.from(document.querySelectorAll('[role="button"],button')).some((el) => {
        const aria = normLocal(el.getAttribute('aria-label') || '');
        if (aria !== 'avancar' && aria !== 'next') return false;
        if (el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-hidden') === 'true') return false;
        if(el.closest){const hidden=el.closest('[aria-hidden="true"]');if(hidden&&!(hidden.id==='scrollview'&&/^\/checkpoint\/1501092823525282\//.test(location.pathname)&&!hidden.parentElement?.closest('[aria-hidden="true"]')))return false;}
        if (String(el.getAttribute('tabindex') || '') === '-1') return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 8 && rect.height >= 8 && rect.bottom > 0 && rect.top < window.innerHeight;
      });
    });
  } catch {}
  return out;
}

/**
 * Seleciona CNH. A lista nova é o texto "Carteira de habilitação" com o ícone ao lado,
 * sem role=radio. O radio antigo continua valendo quando ele existe.
 * Sem marca de seleção, não segue: clique solto já gerou Avançar apagado.
 */
async function selectDocTypeCnh(page) {
  require('./interactionLease').assert(page);
  const out = { clicked: false, verified: false, method: null, label: null };
  const labelHit = await clickCnhChoice(page);
  if (labelHit && labelHit.clicked) return Object.assign(out, labelHit);
  try {
    const evalClick = await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const isCnh = (t) =>
        t.includes('carteira de habilitacao') ||
        t.includes('driver license') ||
        t.includes("driver's license") ||
        t.includes('drivers license');
      const radios = Array.from(document.querySelectorAll('[role="radio"]'));
      for (const el of radios) {
        const label = normLocal(
          `${el.getAttribute('aria-label') || ''} ${el.innerText || ''} ${el.textContent || ''}`
        );
        if (!isCnh(label)) continue;
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        // Sequência de ponteiro — FB lista controlada por React
        try {
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        } catch {
          try {
            el.click();
          } catch {}
        }
        const checked = el.getAttribute('aria-checked') === 'true';
        const opt = el.closest('[role="option"]');
        const selected = opt && opt.getAttribute('aria-selected') === 'true';
        return {
          clicked: true,
          verified: !!(checked || selected),
          label: label.slice(0, 80),
          checked,
          selected: !!selected
        };
      }
      return { clicked: false, verified: false, label: null };
    });
    Object.assign(out, evalClick || {});
    out.method = 'radio_pointer';

    if (out.clicked && !out.verified) {
      // Fallback Puppeteer: click no handle do radio CNH
      const handle = await page.evaluateHandle(() => {
        const normLocal = (s) => {
          try {
            return String(s || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
          } catch {
            return String(s || '').toLowerCase().trim();
          }
        };
        const isCnh = (t) =>
          t.includes('carteira de habilitacao') ||
          t.includes('driver license') ||
          t.includes("driver's license");
        return (
          Array.from(document.querySelectorAll('[role="radio"]')).find((el) =>
            isCnh(normLocal(`${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`))
          ) || null
        );
      });
      const el = handle && handle.asElement && handle.asElement();
      if (el) {
        try {
          await el.click({ delay: 40 });
          out.method = 'puppeteer_handle_click';
        } catch {}
        try {
          const box = await el.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 });
            out.method = 'puppeteer_mouse';
          }
        } catch {}
      }
      try {
        if (handle) await handle.dispose();
      } catch {}
      await sleep(800);
      const probe = await probeDocTypeRadios(page);
      out.verified = !!(probe && probe.cnhChecked);
    }

    if (out.clicked) {
      await sleep(600);
      const probe2 = await probeDocTypeRadios(page);
      out.verified = !!(probe2 && probe2.cnhChecked) || !!out.verified;
      out.avancarEnabled = !!(probe2 && probe2.avancarEnabled);
      out.radioCount = probe2 && probe2.radioCount;
    }
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 160);
  }
  return out;
}

async function waitCnhSelected(page, { maxMs = 90000, deadlineAt } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    const probe = await probeDocTypeRadios(page);
    last = probe;
    if (probe && probe.radioCount === 0 && !probe.cnhLabel) {
      await clickByText(page, ['ver mais', 'see more'], { withinDialog: false });
      await sleep(2000);
      continue;
    }
    if (probe && probe.cnhChecked && probe.avancarEnabled) {
      return { ok: true, probe };
    }
    const sel = await selectDocTypeCnh(page);
    const avancarBlue = buttonLooksEnabled(await readNamedButton(page, ['avancar', 'next']));
    last = Object.assign({}, probe || {}, sel || {}, { avancarBlue });
    await sleep(700);
    const p2=await probeDocTypeRadios(page);
    if(p2?.cnhChecked&&p2?.avancarEnabled)return {ok:true,probe:p2,sel,avancarBlue};
    if (!(probe && probe.cnhLabel)) {
    await clickByText(page, ['ver mais', 'see more'], { withinDialog: false });
    }
    await sleep(1500);
  }
  return { ok: false, probe: last };
}

async function dismissTurbineUpsell(page, { deadlineAt } = {}) {
  assertBudget(deadlineAt, 'dismiss_start');
  const start = Date.now();
  while (Date.now() - start < 20000 && deadlineLeft(deadlineAt) > 0) {
    let state = null;
    try {
      state = await page.evaluate(() => {
        const normLocal = (s) => {
          try {
            return String(s || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
          } catch {
            return String(s || '').toLowerCase().trim();
          }
        };
        const dialogs = Array.from(
          document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')
        );
        for (const d of dialogs) {
          const al = normLocal(d.getAttribute('aria-label') || '');
          const txt = normLocal(d.innerText || d.textContent || '').slice(0, 400);
          const isTurbine =
            al.includes('turbine seu classificado') ||
            txt.includes('turbine seu classificado') ||
            txt.includes('promover agora');
          if (!isTurbine) continue;
          const close =
            d.querySelector('[aria-label="Fechar"]') ||
            d.querySelector('[aria-label*="Fechar"]') ||
            d.querySelector('[aria-label*="Close"]') ||
            Array.from(d.querySelectorAll('button,[role="button"]')).find((b) => {
              const t = normLocal(
                `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`
              );
              return (
                t.includes('fechar dialogo para turbinar') ||
                t.includes('fechar dialogo') ||
                t === 'fechar' ||
                t.includes('fechar')
              );
            });
          if (close && typeof close.click === 'function') {
            try {
              close.click();
              return { found: true, closed: true };
            } catch {
              return { found: true, closed: false };
            }
          }
          return { found: true, closed: false };
        }
        return { found: false, closed: false };
      });
    } catch {
      state = null;
    }

    if (!state || !state.found) return { ok: true, dismissed: false };
    if (state.closed) {
      await sleep(1500);
      return { ok: true, dismissed: true };
    }
    try {
      await page.keyboard.press('Escape');
    } catch {}
    await sleep(1200);
  }
  try {
    await page.keyboard.press('Escape');
  } catch {}
  await sleep(800);
  return { ok: true, dismissed: true, via: 'escape_timeout' };
}

async function waitForSellingRedirect(page, { maxMs = 14000 } = {}) {
  const t0 = Date.now();
  const cap = Math.max(2000, Number(maxMs) || 14000);
  let last = pageHandleState(page);
  while ((Date.now() - t0) < cap) {
    last = pageHandleState(page);
    if (!last.ok) return last;
    if (isSellingUrl(last.url)) return { ok: true, reason: 'redirect', url: last.url };
    await sleep(400);
  }
  last = pageHandleState(page);
  if (!last.ok) return last;
  if (isSellingUrl(last.url)) return { ok: true, reason: 'redirect', url: last.url };
  return { ok: false, reason: 'not_selling_yet', url: last.url };
}

async function ensureSellingFeed(page, { deadlineAt } = {}) {
  assertBudget(deadlineAt, 'selling_start');
  const handle = pageHandleState(page);
  if (!handle.ok) {
    const err = new Error('selling_page_closed');
    err.code = 'ID_DOC_PAGE_CLOSED';
    throw err;
  }
  let onSelling = isSellingUrl(handle.url);
  if (!onSelling) {
    const landed = await waitForSellingRedirect(page, { maxMs: 14000 });
    if (!landed.ok && landed.reason !== 'not_selling_yet') {
      const err = new Error('selling_page_closed');
      err.code = 'ID_DOC_PAGE_CLOSED';
      throw err;
    }
    onSelling = !!(landed && landed.ok);
  }
  if (!onSelling) {
    const connectLane = require('./connectLane.js');
    await connectLane.withHeavyNav({ kind: 'id_selling_goto' }, async () => {
      await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    });
  }
  // DOM do selling é bem pesado — settle gordo.
  await sleep(5000);
  assertBudget(deadlineAt, 'selling_settle');
  return true;
}

/**
 * Partes de data de hoje em America/Sao_Paulo (para comparar "Anunciado em DD/MM").
 * NÃO inclui ontem — ontem é stale de propósito (anti falso-positivo).
 */
function dateHintsSP(now = Date.now()) {
  const fmt = (ts, opts) => {
    try {
      return new Intl.DateTimeFormat('pt-BR', Object.assign({ timeZone: 'America/Sao_Paulo' }, opts)).format(new Date(ts));
    } catch {
      return '';
    }
  };
  let todayDay = 0;
  let todayMonth = 0;
  let todayYear = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric'
    }).formatToParts(new Date(now));
    const get = (type) => {
      const p = parts.find((x) => x.type === type);
      return p ? Number(p.value) || 0 : 0;
    };
    todayDay = get('day');
    todayMonth = get('month');
    todayYear = get('year');
  } catch {
    const d = new Date(now);
    todayDay = d.getDate();
    todayMonth = d.getMonth() + 1;
    todayYear = d.getFullYear();
  }
  return {
    todayDay,
    todayMonth,
    todayYear,
    todayLabel: fmt(now, { day: 'numeric', month: 'long' }),
    todayShort: `${String(todayDay).padStart(2, '0')}/${String(todayMonth).padStart(2, '0')}`,
    todayDayMonth: `${todayDay}/${todayMonth}`
  };
}

/**
 * Classifica se o texto do card é anúncio de HOJE (SP).
 * Retorno: true | false | null (null = data não determinada).
 * Exportada para forense/teste — mesma regra do evaluate no browser.
 */
function classifyListedToday(text, hintsIn) {
  const hints = hintsIn || dateHintsSP();
  const t = norm(text);
  if (!t) return null;

  // Explícito: "Anunciado em 23/07" / "Listed on 7/23"
  const mPt = t.match(/anunciado\s+em\s+(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})(?:\s*[\/\-\.]\s*(\d{2,4}))?/);
  if (mPt) {
    const day = parseInt(mPt[1], 10);
    const month = parseInt(mPt[2], 10);
    return day === Number(hints.todayDay) && month === Number(hints.todayMonth);
  }
  const mEn = t.match(/listed\s+on\s+(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})(?:\s*[\/\-\.]\s*(\d{2,4}))?/);
  if (mEn) {
    // EN costuma ser M/D; se day>12 assume D/M
    let a = parseInt(mEn[1], 10);
    let b = parseInt(mEn[2], 10);
    let day = a;
    let month = b;
    if (a <= 12 && b > 12) {
      month = a;
      day = b;
    } else if (a > 12) {
      day = a;
      month = b;
    } else {
      // ambíguo M/D vs D/M: aceita se bater em qualquer ordem com hoje
      const hit =
        (a === Number(hints.todayMonth) && b === Number(hints.todayDay)) ||
        (a === Number(hints.todayDay) && b === Number(hints.todayMonth));
      return hit;
    }
    return day === Number(hints.todayDay) && month === Number(hints.todayMonth);
  }

  if (/\banunciado\s+ontem\b|\blisted\s+yesterday\b|\banunciado\s+ayer\b/.test(t)) return false;
  if (/\b(ha|há)\s+\d+\s+dias?\b|\b\d+\s+dias?\s+atras\b|\b\d+\s+days?\s+ago\b/.test(t)) return false;

  if (/\banunciado\s+hoje\b|\blisted\s+today\b|\banunciado\s+hoy\b/.test(t)) return true;
  // Relativo curto = hoje (minutos/horas). NÃO dias.
  if (/\b(ha|há)\s+(uma|um|1|\d+)\s+(minuto|minutos|hora|horas)\b/.test(t)) return true;
  if (/\b(a\s+minute|an?\s+hour|\d+\s+(minutes?|hours?))\s+ago\b/.test(t)) return true;
  if (/\banunciado\s+agora\b|\blisted\s+just\s+now\b|\bagora\s+mesmo\b/.test(t)) return true;

  return null;
}

/**
 * Abre o classificado com "Uma ação é necessária…".
 * DOM real (selling): NÃO usa <a href="/marketplace/item/…"> no card.
 * Usa role=button aria-label=título + banner de ação; fallback: ⋮ → Ver classificado.
 *
 * mode=today (auto): só cards com data de HOJE (ou preferTitle sem data conflitante).
 * mode=firstAny (humano): qualquer ação; ainda reporta listedToday.
 */
async function openActionNeededListing(page, { mode = 'today', preferTitle = '', dryRun = false } = {}) {
  const prefer = String(preferTitle || '').trim();
  const hints = dateHintsSP();

  try {
    return await page.evaluate(
      (modeIn, preferIn, hintsIn, actionSource, dryRunIn) => {
        const normLocal = (s) => {
          try {
            return String(s || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
          } catch {
            return String(s || '').toLowerCase().trim();
          }
        };

        const classifyListedTodayLocal = (text) => {
          const t = normLocal(text);
          if (!t) return null;
          const mPt = t.match(/anunciado\s+em\s+(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})(?:\s*[\/\-\.]\s*(\d{2,4}))?/);
          if (mPt) {
            const day = parseInt(mPt[1], 10);
            const month = parseInt(mPt[2], 10);
            return day === Number(hintsIn.todayDay) && month === Number(hintsIn.todayMonth);
          }
          const mEn = t.match(/listed\s+on\s+(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})(?:\s*[\/\-\.]\s*(\d{2,4}))?/);
          if (mEn) {
            const a = parseInt(mEn[1], 10);
            const b = parseInt(mEn[2], 10);
            if (a <= 12 && b > 12) {
              return b === Number(hintsIn.todayDay) && a === Number(hintsIn.todayMonth);
            }
            if (a > 12) {
              return a === Number(hintsIn.todayDay) && b === Number(hintsIn.todayMonth);
            }
            return (
              (a === Number(hintsIn.todayMonth) && b === Number(hintsIn.todayDay)) ||
              (a === Number(hintsIn.todayDay) && b === Number(hintsIn.todayMonth))
            );
          }
          if (/\banunciado\s+ontem\b|\blisted\s+yesterday\b|\banunciado\s+ayer\b/.test(t)) return false;
          if (/\b(ha|há)\s+\d+\s+dias?\b|\b\d+\s+dias?\s+atras\b|\b\d+\s+days?\s+ago\b/.test(t)) return false;
          if (/\banunciado\s+hoje\b|\blisted\s+today\b|\banunciado\s+hoy\b/.test(t)) return true;
          if (/\b(ha|há)\s+(uma|um|1|\d+)\s+(minuto|minutos|hora|horas)\b/.test(t)) return true;
          if (/\b(a\s+minute|an?\s+hour|\d+\s+(minutes?|hours?))\s+ago\b/.test(t)) return true;
          if (/\banunciado\s+agora\b|\blisted\s+just\s+now\b|\bagora\s+mesmo\b/.test(t)) return true;
          return null;
        };

        const extractListedLabel = (text) => {
          const t = String(text || '');
          const m =
            t.match(/Anunciado em\s+\d{1,2}\s*[\/\-\.]\s*\d{1,2}(?:\s*[\/\-\.]\s*\d{2,4})?/i) ||
            t.match(/Listed on\s+\d{1,2}\s*[\/\-\.]\s*\d{1,2}/i) ||
            t.match(/anunciado\s+(hoje|ontem|agora|hoy)/i) ||
            t.match(/há\s+\d+\s+(minuto|minutos|hora|horas|dias?)/i);
          return m ? String(m[0]).slice(0, 40) : null;
        };

        const actionRe = new RegExp(actionSource);
        const preferN = normLocal(preferIn).slice(0, 48);

        const actionNodes = Array.from(
          document.querySelectorAll('div, span, h2, h3, p, a, [role="button"]')
        ).filter((el) => {
          const t = normLocal(el.innerText || el.textContent || '');
          if (!t || t.length > 180) return false;
          return actionRe.test(t);
        });

        const cards = [];
        for (const node of actionNodes) {
          let root = node;
          for (let i = 0; i < 14 && root && root !== document.body; i++) {
            const txt = normLocal(root.innerText || root.textContent || '').slice(0, 1200);
            const hasAction = actionRe.test(txt);
            const hasMore =
              !!root.querySelector('[aria-label*="Mais opções"], [aria-label*="Mais opcoes"], [aria-label*="More options"]') ||
              /marcar como indisponivel|promover agora|anunciado em|turbinar classificado/.test(txt);
            if (hasAction && hasMore && (root.innerText || '').length < 3500) {
              break;
            }
            root = root.parentElement;
          }
          if (!root || root === document.body) root = node.parentElement || node;

          const rawTxt = String(root.innerText || root.textContent || '').slice(0, 1500);
          const txt = normLocal(rawTxt);
          const preferHit = preferN
            ? txt.includes(preferN) ||
              Array.from(root.querySelectorAll('[aria-label]')).some((b) =>
                normLocal(b.getAttribute('aria-label') || '').includes(preferN)
              )
            : false;

          const listedToday = classifyListedTodayLocal(rawTxt);
          const listedLabel = extractListedLabel(rawTxt);
          // stale = data explícita de outro dia
          const stale = listedToday === false;
          // elegível auto: hoje confirmado, OU (título do post recém-publicado sem data conflitante)
          const eligibleToday =
            listedToday === true || (preferHit && listedToday !== false);

          cards.push({
            root,
            txt,
            preferHit,
            listedToday,
            listedLabel,
            stale,
            weak: !eligibleToday
          });
        }

        if (!cards.length) return { found: false, reason: 'no_action_banner' };

        const uniq = [];
        const seen = new Set();
        for (const c of cards) {
          if (seen.has(c.root)) continue;
          seen.add(c.root);
          uniq.push(c);
        }

        const staleCount = uniq.filter((c) => c.stale).length;
        let pool = [];
        if (modeIn === 'firstAny') {
          // Humano: qualquer ação (ainda prioriza hoje / prefer).
          pool = uniq.slice();
        } else {
          // Auto: só hoje (ou preferTitle sem data stale).
          pool = uniq.filter((c) => !c.weak && !c.stale);
        }

        if (!pool.length) {
          if (staleCount > 0) {
            const sample = uniq
              .filter((c) => c.stale)
              .slice(0, 3)
              .map((c) => c.listedLabel || 'stale');
            return {
              found: false,
              reason: 'action_stale_not_today',
              staleCount,
              totalBanners: uniq.length,
              listedLabel: sample[0] || null,
              listedToday: false,
              sampleStale: sample
            };
          }
          return {
            found: false,
            reason: 'action_filtered_out',
            totalBanners: uniq.length,
            listedToday: null
          };
        }

        pool.sort((a, b) => {
          if (a.preferHit !== b.preferHit) return a.preferHit ? -1 : 1;
          const aToday = a.listedToday === true ? 1 : 0;
          const bToday = b.listedToday === true ? 1 : 0;
          if (aToday !== bToday) return bToday - aToday;
          return 0;
        });
        const pick = pool[0];
        try {
          pick.root.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}

        const meta = {
          preferHit: !!pick.preferHit,
          listedToday: pick.listedToday,
          listedLabel: pick.listedLabel || null,
          todayHint: `${hintsIn.todayDay}/${hintsIn.todayMonth}`
        };
        if (dryRunIn) return { found: true, clicked: false, method: 'scan_only', ...meta };

        const badCardAria = (al) => {
          if (!al) return true;
          if (al.includes('marcar como') || al.includes('promover') || al.includes('turbinar')) return true;
          if (al.includes('mais opcoes') || al.includes('more options')) return true;
          if (al.includes('visualizaram') || al.includes('people viewed') || al.includes('viewed the')) return true;
          if (al.includes('mensagem') || al.includes('message') || al.includes('messenger') || al.includes('conversar')) return true;
          return false;
        };
        const cardBtns = [];
        let walk = pick.root;
        for (let up = 0; up < 4 && walk; up++) {
          if (walk.getAttribute && walk.getAttribute('role') === 'button') cardBtns.push(walk);
          walk = walk.parentElement;
        }
        cardBtns.push(...pick.root.querySelectorAll('[role="button"][aria-label]'));
        const cardBtn = cardBtns.find((b) => {
          const al = normLocal(b.getAttribute('aria-label') || '');
          if (badCardAria(al)) return false;
          if (preferN && al.includes(preferN)) return true;
          return al.includes('anunciado') || al.includes('listed');
        });
        if (cardBtn) {
          try {
            cardBtn.scrollIntoView({ block: 'center', inline: 'nearest' });
            cardBtn.click();
            return {
              found: true,
              clicked: true,
              method: 'listing_card',
              aria: String(cardBtn.getAttribute('aria-label') || '').slice(0, 80),
              ...meta
            };
          } catch {}
        }

        const itemLink = pick.root.querySelector('a[href*="/marketplace/item/"]');
        if (itemLink) {
          try {
            itemLink.scrollIntoView({ block: 'center', inline: 'nearest' });
            itemLink.click();
            return { found: true, clicked: true, method: 'item_link', ...meta };
          } catch {}
        }

        const moreBtn =
          pick.root.querySelector('[aria-label*="Mais opções"], [aria-label*="Mais opcoes"], [aria-label*="More options"]') ||
          Array.from(pick.root.querySelectorAll('[role="button"][aria-label]')).find((b) =>
            /mais opcoes|mais opções|more options/i.test(normLocal(b.getAttribute('aria-label') || ''))
          );

        // 2) Fallback seguro: ⋮ Mais opções → Ver classificado
        const more = moreBtn;
        if (more) {
          try {
            more.click();
            return {
              found: true,
              clicked: true,
              method: 'more_options_opened',
              needVerClassificado: true,
              ...meta
            };
          } catch {}
        }

        // O texto laranja não abre o classificado. Sem o botão do card, tenta de novo.
        return { found: true, clicked: false, method: 'card_not_ready', ...meta };
      },
      mode,
      prefer,
      hints,
      MARKETPLACE_ACTION_RE.source,
      dryRun
    );
  } catch (e) {
    return { found: false, error: 'open_evaluate_failed:' + String((e && e.message) || e).slice(0, 120) };
  }
}

async function clickVerClassificadoMenu(page) {
  await sleep(2500);
  try {
    const clicked = await page.evaluate(() => {
      const normLocal = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const items = Array.from(document.querySelectorAll('[role="menuitem"], a[role="menuitem"], a'));
      for (const el of items) {
        const t = normLocal(`${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`);
        if (t.includes('ver classificado') || t.includes('view listing') || t.includes('ver anuncio')) {
          try {
            el.click();
            return true;
          } catch {}
        }
        const href = el.getAttribute && el.getAttribute('href');
        if (href && /\/marketplace\/item\//.test(href) && t.includes('ver')) {
          try {
            el.click();
            return true;
          } catch {}
        }
      }
      return false;
    });
    return !!clicked;
  } catch {
    return false;
  }
}

async function waitListingIdentityPrompt(page, { maxMs = 45000, deadlineAt } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    try {
      const st = await page.evaluate(() => {
        const normLocal = (s) => {
          try {
            return String(s || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .trim();
          } catch {
            return String(s || '').toLowerCase().trim();
          }
        };
        const body = normLocal(document.body && (document.body.innerText || '') || '');
        const verb = /\b(confirme|confirmar|confirma|confirm|verifique|verificar|verifica|verify)\b/;
        const exactBtn = Array.from(document.querySelectorAll('[role="button"],button')).some((el) => {
          const aria = normLocal(el.getAttribute('aria-label') || '');
          const own = normLocal(el.innerText || el.textContent || '');
          const rect=el.getBoundingClientRect();if(rect.width<2||rect.height<2||el.closest('[aria-hidden="true"],[inert]'))return false;
          return aria === 'confirmar identidade' || aria === 'confirm identity' || own === 'confirmar identidade' || own === 'confirm identity';
        });
        const onCheckpoint = /\/checkpoint\/1501092823525282\/\d+/.test(String(location.pathname || ''));
        return {
          hasBtn: exactBtn, onCheckpoint,
          hasText: verb.test(body) && (body.includes('identidade') || body.includes('identity')),
          onItem: /\/marketplace\/item\//.test(location.pathname || '')
        };
      });
      if(st?.hasBtn)return st;
      if(st?.onCheckpoint){const screen=await detectIdWizardScreen(page);if(['confirm','identity_retry','identity_doc_intro','continuar','carregar_doc','doc_type','upload_photo','success','pending_review','marketplace_phone_confirm','marketplace_phone_entry'].includes(screen))return {...st,screen};}
    } catch {}
    await sleep(2000);
  }
  return null;
}

/** Compat: scan antigo → agora abre o classificado. */
async function scanActionNeeded(page, opts) {
  return openActionNeededListing(page, opts);
}

async function findFileInputEverywhere(page) {
  const findInFrame = async (frame) => {
    try {
      const handle = await frame.$('input[type="file"]');
      if (handle) return handle;
    } catch {}
    return null;
  };
  let input = await findInFrame(page).catch(() => null);
  if (input) return input;
  for (const fr of page.frames()) {
    if (!fr || fr === page.mainFrame()) continue;
    input = await findInFrame(fr).catch(() => null);
    if (input) return input;
  }
  return null;
}

async function isPendingReviewScreen(page) {
  try { const e=await require('./idSubmissionEvidence').read(page); return e.confirmed && e.kind==='pending'; } catch { return false; }
}
async function isClassicSubmittedScreen(page) {
  try { const e=await require('./idSubmissionEvidence').read(page); return e.confirmed && e.kind==='submitted'; } catch { return false; }
}
/** Sucesso pós-envio: tela clássica OU “em andamento” (Pronto). */
async function isSuccessScreen(page) {
  if (await isPendingReviewScreen(page)) return true;
  return isClassicSubmittedScreen(page);
}

async function waitForSuccessScreen(page, { maxMs, deadlineAt }) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    if (await isSuccessScreen(page)) return true;
    await sleep(2000);
  }
  return false;
}

async function clickProntoIfPresent(page, { maxMs = 30000, deadlineAt } = {}) {
  if (!(await isPendingReviewScreen(page))) return false;
  const ok = await waitClickByText(page, ['pronto', 'done'], {
    maxMs,
    deadlineAt,
    withinDialog: true,
    exact: true,
    settleMs: WAIT_STEP_MS
  });
  if (!ok) {
    // Fallback: aria-label exato no dialog
    try {
      const clicked = await page.evaluate(() => {
        const el =
          document.querySelector('[aria-label="Pronto"]') ||
          document.querySelector('[aria-label="Done"]');
        if (el && typeof el.click === 'function') {
          el.click();
          return true;
        }
        return false;
      });
      if (clicked) await sleep(WAIT_STEP_MS);
      return !!clicked;
    } catch {
      return false;
    }
  }
  return true;
}

async function closeSuccessDialog(page, { deadlineAt } = {}) {
  // Variante nova: “em andamento” → Pronto → depois Fechar
  const pronto = await clickProntoIfPresent(page, {
    maxMs: 45000,
    deadlineAt: deadlineAt || Date.now() + 45000
  });
  if (pronto) {
    // Após Pronto, esperar a tela com Fechar (calma — FB pesado)
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const classic = await isClassicSubmittedScreen(page);
      const hasFechar = await clickByText(page, ['fechar', 'close'], { withinDialog: true });
      if (hasFechar) {
        await sleep(1500);
        return true;
      }
      if (classic) break;
      await sleep(2000);
    }
  }

  let clicked = await clickByText(page, ['fechar', 'close', 'concluido', 'ok'], {
    withinDialog: true
  });
  if (!clicked) {
    clicked = await clickByText(page, ['fechar', 'close', 'pronto'], { withinDialog: false, exact: true });
  }
  if (clicked) {
    await sleep(1500);
    return true;
  }
  try {
    await page.keyboard.press('Escape');
  } catch {}
  await sleep(1000);
  return true;
}

/**
 * Pós-Enviar: espera 1–120s+ → (Pronto se “em andamento”) → Fechar.
 */
async function finishAfterEnviar(page, { nome, source, deadlineAt } = {}) {
  const sendError = await readUploadProblem(page);
  if (sendError && (sendError.hit === 'ocorreu um erro' || sendError.hit === 'problemas tecnicos')) {
    logEvt(nome, source, 'wizard_enviar_erro', { snippet: sendError.snippet || '' });
    return { ok: false, error: 'facebook_erro_tecnico' };
  }
  let success = await waitForSuccessScreen(page, { maxMs: POLL_SUCCESS_MS, deadlineAt });
  if (!success && deadlineLeft(deadlineAt) > 15000) {
    logEvt(nome, source, 'wizard_refresh_retry', {});
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch {}
    await sleep(WAIT_FEED_SETTLE_MS);
    success = await waitForSuccessScreen(page, { maxMs: POLL_AFTER_REFRESH_MS, deadlineAt });
  }
  if (!success) return { ok: false, error: 'success_screen_timeout' };

  const pending = await isPendingReviewScreen(page);
  logEvt(nome, source, 'wizard_post_enviar_screen', {
    pending,
    classic: await isClassicSubmittedScreen(page)
  });

  if (pending) {
    const pronto = await clickProntoIfPresent(page, { maxMs: 60000, deadlineAt });
    logEvt(nome, source, 'wizard_pronto', { ok: !!pronto });
    if (!pronto) return { ok: false, error: 'pronto_not_clicked' };
    // Após Pronto: tela final com Fechar
    const fecharStart = Date.now();
    let closed = false;
    while (Date.now() - fecharStart < 90000 && deadlineLeft(deadlineAt) > 0) {
      closed = await clickByText(page, ['fechar', 'close'], { withinDialog: true });
      if (!closed) closed = await clickByText(page, ['fechar', 'close'], { withinDialog: false, exact: true });
      if (closed) break;
      // Às vezes ainda “Suas informações…” sem Fechar imediato
      if (await isClassicSubmittedScreen(page)) {
        await sleep(2000);
        continue;
      }
      await sleep(2000);
    }
    logEvt(nome, source, 'wizard_fechar', { ok: !!closed });
    if (closed) await sleep(1500);
    else {
      // Último recurso: Escape não invalida o envio já feito
      try {
        await page.keyboard.press('Escape');
      } catch {}
      await sleep(1000);
    }
  } else {
    await closeSuccessDialog(page, { deadlineAt });
    logEvt(nome, source, 'wizard_fechar', { ok: true, via: 'classic' });
  }

  return { ok: true };
}

async function finishAlreadySubmitted(page, { nome, source, where, deadlineAt } = {}) {
  const evidence=await require('./idSubmissionEvidence').read(page);
  logEvt(nome, source, 'identity_submission_evidence', { confirmed:evidence.confirmed, kind:evidence.kind, reason:evidence.reason, controls:evidence.sample?.controls, text:evidence.sample?.text?.slice(0,1500) });
  if(!evidence.confirmed)return {ok:false,error:'already_submitted_not_confirmed'};
  logEvt(nome, source, 'already_submitted_after_' + String(where || 'step'), { ok: true, evidence: evidence.kind });
  // Mesmo atalho: pode ser “em andamento” (Pronto) ou clássico (Fechar)
  if (await isPendingReviewScreen(page)) {
    const pronto = await clickProntoIfPresent(page, {
      maxMs: 45000,
      deadlineAt: deadlineAt || Date.now() + 45000
    });
    logEvt(nome, source, 'wizard_pronto', { ok: !!pronto, alreadySubmitted: true });
    if(!pronto){await recordIdFailure(page,nome,source,'pronto_not_clicked');return {ok:false,error:'pronto_not_clicked'}}
    await sleep(WAIT_STEP_MS);
  }
  await closeSuccessDialog(page, { deadlineAt: deadlineAt || Date.now() + 60000 });
  return { ok: true, alreadySubmitted: true, submissionEvidence: evidence.kind };
}

async function scrollSellingToTop(page) {
  try {
    await page.evaluate(() => {
      try {
        window.scrollTo(0, 0);
        const main =
          document.querySelector('[role="main"]') ||
          document.scrollingElement ||
          document.documentElement;
        if (main && typeof main.scrollTo === 'function') main.scrollTo(0, 0);
      } catch {}
    });
  } catch {}
}

/**
 * Abre o classificado com “ação necessária” se o banner estiver no topo do selling.
 * Sem scroll-hunt: poucas leituras calmas no topo; se não houver banner, encerra.
 */
async function tryOpenActionNeededAtTop(
  page,
  { nome, source, mode = 'today', preferTitle = '', attempts = TOP_SCAN_ATTEMPTS_AUTO, deadlineAt } = {}
) {
  let scan = { found: false };
  let openedOk = false;

  for (let i = 0; i < attempts && deadlineLeft(deadlineAt) > 0; i++) {
    await scrollSellingToTop(page);
    if (i > 0) await sleep(TOP_SCAN_GAP_MS);

    const isolated = require('./isolatedAccountFlow').context(page, 'id');
    scan = null;
    if (isolated && isolated.proxyRequired && !isolated.rail.isProxyArmed) {
      const probe = await openActionNeededListing(page, { mode, preferTitle: preferTitle || '', dryRun: true });
      if (probe && probe.found && probe.reason !== 'action_stale_not_today') {
        await require('./isolatedAccountFlow').armIdentity(page);
      } else {
        scan = probe;
      }
    }
    if (!scan) scan = await openActionNeededListing(page, { mode, preferTitle: preferTitle || '' });
    if (scan && scan.error) throw new Error(scan.error);
    logEvt(nome, source, 'open_attempt', {
      found: !!(scan && scan.found),
      method: (scan && scan.method) || null,
      aria: (scan && scan.aria) ? String(scan.aria).slice(0, 80) : null,
      reason: (scan && scan.reason) || null,
      preferHit: !!(scan && scan.preferHit),
      listedToday: scan && Object.prototype.hasOwnProperty.call(scan, 'listedToday')
        ? scan.listedToday
        : null,
      listedLabel: (scan && scan.listedLabel) || null,
      staleCount: Number(scan && scan.staleCount || 0) || 0,
      attempt: i + 1,
      attempts,
      topOnly: true
    });

    // Ação existe mas anúncio NÃO é de hoje → não abre, não faz wizard.
    if (scan && scan.reason === 'action_stale_not_today') {
      return { openedOk: false, scan };
    }

    if (!(scan && scan.found && scan.clicked)) continue;

    await sleep(4000);
    if (scan.needVerClassificado || scan.method === 'more_options_opened') {
      const ver = await clickVerClassificadoMenu(page);
      logEvt(nome, source, 'ver_classificado', { ok: !!ver });
      await sleep(5000);
    }

    const prompt = await waitListingIdentityPrompt(page, { maxMs: 12000, deadlineAt });
    if (prompt) {
      openedOk = true;
      break;
    }
    try {
      logEvt(nome, source, 'open_no_prompt', { url: String(page.url() || '').slice(0, 180) });
    } catch {}

    // Título pode ter aberto painel sem navegar — plano B: ⋮ → Ver classificado
    if (scan.method === 'title_button') {
      try {
        await page.evaluate(() => {
          const more = document.querySelector(
            '[aria-label*="Mais opções"], [aria-label*="Mais opcoes"], [aria-label*="More options"]'
          );
          if (more) more.click();
        });
      } catch {}
      await sleep(2500);
      await clickVerClassificadoMenu(page);
      await sleep(5000);
      const prompt2 = await waitListingIdentityPrompt(page, { maxMs: 12000, deadlineAt });
      if (prompt2) {
        openedOk = true;
        break;
      }
    }
    // O card foi clicado e o botão azul ainda não apareceu. Tenta o mesmo topo de novo.
  }

  return { openedOk, scan };
}

async function runMarketplacePhoneVerification(page, { nome, source, deadlineAt, skipAdvance = false } = {}) {
  let phoneVerified = false;
  try {
  logEvt(nome, source, 'marketplace_phone_flow_start', { skipAdvance: !!skipAdvance });

  let screenNow = await detectIdWizardScreen(page);
  if (!skipAdvance && screenNow !== 'marketplace_phone_entry' && screenNow !== 'marketplace_phone_code' && screenNow !== 'marketplace_phone_success') {
    await sleep(2000);
    const firstAdvance = await waitClickByText(
      page,
      ['a seguir: continue para a verificacao do telefone', 'a seguir: continue para a verificação do telefone', 'avancar', 'avançar'],
      { maxMs: 60000, deadlineAt, withinDialog: false, exact: false, settleMs: WAIT_STEP_MS + 2000 }
    );
    logEvt(nome, source, 'marketplace_phone_flow_avancar', { ok: !!firstAdvance });
    if (!firstAdvance) {
      await setMarketplacePhoneFlag(nome, 'error', { reason: 'marketplace_phone_advance_missing', text: 'Nao foi possivel avancar para a verificacao de telefone.' });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_advance_missing' };
    }
  }

  let screen = await waitForWizardScreen(page, ['marketplace_phone_entry', 'marketplace_phone_code', 'marketplace_phone_success'], {
    maxMs: 120000,
    deadlineAt
  });
  if (screen === 'marketplace_phone_success') {
    phoneVerified = true;
    await clearMarketplacePhoneFlags(nome);
    let backOk = false;
    try { backOk = await clickMarketplaceReturnToListing(page, { deadlineAt }); } catch { backOk = false; }
    logEvt(nome, source, 'marketplace_phone_success_direct', { ok: true, returnClicked: !!backOk });
    return { ok: true, marketplacePhoneVerified: true, returnClicked: !!backOk };
  }
  if (screen !== 'marketplace_phone_entry') {
    let markers = null;
    try {
      markers = await page.evaluate(() => {
        const raw = String(document.body && (document.body.innerText || document.body.textContent) || '');
        const normLocal = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const body = normLocal(raw);
        const combo = document.querySelector('[role="combobox"]');
        return {
          hasInsira: body.includes('insira o numero do seu celular'),
          hasPhonePrompt: body.includes('confirme seu numero de celular'),
          hasBrazil: body.includes('brazil'),
          hasEnviarCodigo: body.includes('enviar codigo'),
          comboExpanded: combo ? combo.getAttribute('aria-expanded') : null,
          textLen: raw.length
        };
      });
    } catch {}
    logEvt(nome, source, 'marketplace_phone_entry_missing', { screen, markers });
    await setMarketplacePhoneFlag(nome, 'error', { reason: 'marketplace_phone_entry_missing', text: `Tela inesperada: ${String(screen || 'unknown')}` });
    return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_entry_missing' };
  }

  let usedRecentCount = 0;
  for (let attempt = 1; attempt <= 10; attempt++) {
    assertBudget(deadlineAt, 'marketplace_phone_attempt');
    const countryOk = await selectMarketplacePhoneCountryUnitedStates(page, { deadlineAt });
    logEvt(nome, source, 'marketplace_phone_country', { attempt, ok: !!countryOk });
    if (!countryOk) {
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_country_failed',
        text: 'Nao confirmou United States no campo de pais.'
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_country_failed' };
    }
    const purchase = await createTextverifiedVerificationRobust({ nome, source });
    if (!purchase.ok) {
      if (purchase.marketplacePhoneNoBalance) {
        await setMarketplacePhoneFlag(nome, 'no_balance', {
          reason: purchase.error || 'marketplace_phone_no_balance',
          text: `Saldo insuficiente no Textverified${Number.isFinite(Number(purchase.balance)) ? ` (${Number(purchase.balance).toFixed(2)})` : ''}.`
        });
        logEvt(nome, source, 'marketplace_phone_no_balance', {
          balance: Number.isFinite(Number(purchase.balance)) ? Number(purchase.balance) : null
        });
        return { ok: false, marketplacePhoneNoBalance: true, error: 'marketplace_phone_no_balance' };
      }
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: purchase.error || 'marketplace_phone_purchase_failed',
        text: String(purchase.textverifiedError || purchase.error || 'Falha ao comprar numero no Textverified').slice(0, 220)
      });
      logEvt(nome, source, 'marketplace_phone_purchase_failed', {
        attempt,
        error: String(purchase.error || 'unknown').slice(0, 180)
      });
      return { ok: false, marketplacePhoneError: true, error: purchase.error || 'marketplace_phone_purchase_failed' };
    }

    const verification = purchase.verification;
    const orderIdMasked = textverified.maskIdTail(verification.id);
    const phoneNational = stripUsNationalNumber(verification.numberDigits || verification.numberRaw || '');
    const phoneMasked = textverified.maskLast4(phoneNational);
    logEvt(nome, source, 'marketplace_phone_number_acquired', {
      attempt,
      orderTail: orderIdMasked,
      phoneTail: phoneMasked,
      totalCost: verification.totalCost != null ? Number(verification.totalCost) : null
    });

    if (phoneNational.length !== 10) {
      try { await textverified.reportVerification(verification.id); } catch {}
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_invalid_number',
        text: `Numero invalido retornado pela ordem ${orderIdMasked}.`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_invalid_number' };
    }

    const typedOk = await typeMarketplacePhoneNumber(page, phoneNational, { deadlineAt });
    const beforeSms = await readMarketplaceSmsMessageIds(page, verification.numberDigits || verification.numberRaw || phoneNational);
    const sendAt = Date.now();
    let sendOk = false;
    let laterError = false;
    screen = '';
    for (let sendTry = 1; sendTry <= 3 && deadlineLeft(deadlineAt) > 0; sendTry++) {
      if (sendTry > 1) {
        const waitMs = 5000 + Math.floor(Math.random() * 5001);
        logEvt(nome, source, 'marketplace_phone_send_code_retry', {
          attempt,
          sendTry,
          waitMs,
          orderTail: orderIdMasked,
          phoneTail: phoneMasked
        });
        await sleep(waitMs);
      }
      sendOk = (sendTry === 1 ? typedOk : true) && await clickMarketplacePhoneSendCode(page, { deadlineAt });
      logEvt(nome, source, 'marketplace_phone_send_code', {
        attempt,
        sendTry,
        orderTail: orderIdMasked,
        phoneTail: phoneMasked,
        countryOk: !!countryOk,
        typedOk: !!typedOk,
        sendOk: !!sendOk
      });
      if (!sendOk) break;
      const outcome = await waitSendCodeOutcome(page, { deadlineAt, maxMs: 12000 });
      screen = outcome.screen;
      laterError = outcome.laterError === true;
      if (screen === 'marketplace_phone_code' || screen === 'marketplace_phone_success' || !laterError) break;
    }
    if (!countryOk || !typedOk || !sendOk) {
      try { await textverified.reportVerification(verification.id); } catch {}
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_send_code_failed',
        text: `Falha ao preparar envio do codigo (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_send_code_failed' };
    }
    if (laterError && screen !== 'marketplace_phone_code' && screen !== 'marketplace_phone_success') {
      try { await textverified.reportVerification(verification.id); } catch {}
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_try_later',
        text: `Facebook pediu para tentar de novo mais tarde apos 3 envios (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_try_later' };
    }

    logEvt(nome, source, 'marketplace_phone_after_send_screen', {
      attempt,
      screen,
      laterError: !!laterError,
      orderTail: orderIdMasked,
      phoneTail: phoneMasked
    });
    if (screen === 'marketplace_phone_success') {
      phoneVerified = true;
      await clearMarketplacePhoneFlags(nome);
      let backOk = false;
      try { backOk = await clickMarketplaceReturnToListing(page, { deadlineAt }); } catch { backOk = false; }
      logEvt(nome, source, 'marketplace_phone_success_fast', { ok: true, returnClicked: !!backOk, orderTail: orderIdMasked, phoneTail: phoneMasked });
      return { ok: true, marketplacePhoneVerified: true, returnClicked: !!backOk };
    }
    if (screen === 'marketplace_phone_entry') {
      const state = await readMarketplacePhoneEntryState(page);
      if (state && state.usedRecently) {
        usedRecentCount += 1;
        logEvt(nome, source, 'marketplace_phone_used_recently', {
          attempt,
          usedRecentCount,
          orderTail: orderIdMasked,
          phoneTail: phoneMasked,
          text: String(state.usedRecentlyText || '').slice(0, 180)
        });
        try { await textverified.reportVerification(verification.id); } catch {}
        try { await textverified.cancelVerification(verification.id); } catch {}
        if (usedRecentCount >= 10) {
          await setMarketplacePhoneFlag(nome, 'error', {
            reason: 'marketplace_phone_used_recently_10x',
            text: 'Textverified retornou 10 numeros rejeitados como usados recentemente.'
          });
          return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_used_recently_10x' };
        }
        await sleep(4000);
        continue;
      }
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_unexpected_return_to_entry',
        text: `Tela voltou para numero sem mensagem clara (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_unexpected_return_to_entry' };
    }
    if (screen !== 'marketplace_phone_code') {
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_code_screen_missing',
        text: `Tela do codigo nao apareceu (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_code_screen_missing' };
    }

    const knownIds = new Set(beforeSms.ok ? beforeSms.ids : []);
    const smsDeadline = Date.now() + 120000;
    let resendCount = 0;
    let nextResendAt = Date.now() + 30000;
    let code = '';
    while (Date.now() < smsDeadline && deadlineLeft(deadlineAt) > 0) {
      const sms = await textverified.listSms({ toNumber: verification.numberDigits || verification.numberRaw || phoneNational });
      if (sms.ok) {
        for (const msg of (sms.messages || [])) {
          if (!msg || !msg.id || knownIds.has(msg.id)) continue;
          if (msg.createdAtMs && msg.createdAtMs < (sendAt - 30000)) continue;
          if (msg.code && String(msg.code).length === 6) {
            code = String(msg.code);
            break;
          }
        }
      }
      if (code) break;
      if (Date.now() >= nextResendAt && resendCount < 3) {
        const resent = await waitClickByText(page, ['reenviar codigo', 'reenviar código'], {
          maxMs: 30000,
          deadlineAt,
          withinDialog: false,
          exact: false,
          settleMs: WAIT_STEP_MS
        });
        resendCount += 1;
        nextResendAt += 30000;
        logEvt(nome, source, 'marketplace_phone_resend_code', {
          ok: !!resent,
          resendCount,
          orderTail: orderIdMasked,
          phoneTail: phoneMasked
        });
      }
      await sleep(5000);
    }

    if (!code) {
      try { await textverified.reportVerification(verification.id); } catch {}
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_sms_timeout',
        text: `Codigo SMS nao chegou a tempo (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_sms_timeout' };
    }

    const typedCode = await typeMarketplaceSmsCode(page, code, { deadlineAt });
    const sentCode = typedCode && await clickMarketplaceSendFinal(page, { deadlineAt });
    logEvt(nome, source, 'marketplace_phone_submit_code', {
      ok: !!sentCode,
      typedCode: !!typedCode,
      orderTail: orderIdMasked,
      phoneTail: phoneMasked
    });
    if (!typedCode || !sentCode) {
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_submit_code_failed',
        text: `Falha ao enviar codigo SMS (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_submit_code_failed' };
    }

    const finalScreen = await waitForWizardScreen(page, ['marketplace_phone_success'], {
      maxMs: 120000,
      deadlineAt
    });
    if (finalScreen !== 'marketplace_phone_success') {
      try { await textverified.cancelVerification(verification.id); } catch {}
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_success_missing',
        text: `Confirmacao por SMS nao concluiu (${orderIdMasked}/${phoneMasked}).`
      });
      return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_success_missing' };
    }

    phoneVerified = true;
    await clearMarketplacePhoneFlags(nome);
    let backOk = false;
    try { backOk = await clickMarketplaceReturnToListing(page, { deadlineAt }); } catch { backOk = false; }
    logEvt(nome, source, 'marketplace_phone_verified', {
      ok: true,
      returnClicked: !!backOk,
      orderTail: orderIdMasked,
      phoneTail: phoneMasked
    });
    return { ok: true, marketplacePhoneVerified: true, returnClicked: !!backOk };
  }

  await setMarketplacePhoneFlag(nome, 'error', {
    reason: 'marketplace_phone_used_recently_10x',
    text: 'Textverified retornou 10 numeros rejeitados como usados recentemente.'
  });
  return { ok: false, marketplacePhoneError: true, error: 'marketplace_phone_used_recently_10x' };
  } catch (e) {
    if (phoneVerified) {
      return { ok: true, marketplacePhoneVerified: true, returnClicked: false };
    }
    const msg = (e && e.message) ? String(e.message) : String(e);
    try {
      await setMarketplacePhoneFlag(nome, 'error', {
        reason: 'marketplace_phone_exception',
        text: `Confirmacao de celular nao concluiu: ${msg.slice(0, 220)}`
      });
    } catch {}
    return { ok: false, marketplacePhoneError: true, error: msg.slice(0, 180) };
  }
}

async function submitEnviarOnPhone(page, nome, source, action, minBytes, network) {
  const isolated = require('./isolatedAccountFlow').context(page, 'id');
  if (isolated) {
    if (isolated.proxyRequired && !isolated.rail.isProxyArmed) return { ok: false, error: 'identity_proxy_required' };
    return action(); // Mantém a rota do navegador isolado durante todo o wizard.
  }
  if (network === 'neorede') {
    logEvt(nome, source, 'wizard_enviar_neorede', {});
    const direct = await action();
    return direct && (direct.ok || direct.navigated) ? direct : (direct || { ok: false, error: 'enviar_not_clicked' });
  }
  let phoneOn = false;
  try {
    const mode = require('./proxyMode').read();
    phoneOn = require('./phoneProxyMode').isEnabled() && mode === 'phone';
  } catch {}
  if (!phoneOn) return action();
  const sw = page.browser && page.browser().__ctDirectSwitch;
  if (!sw || typeof sw.flip !== 'function' || !sw.port()) {
    logEvt(nome, source, 'wizard_enviar_proxy', { ok: false, error: 'no_switch' });
    return { ok: false, error: 'proxy_mobile_unavailable' };
  }
  let hopped = false;
  try {
    const hop = await require('./phoneProxyMode').hopForPublish(nome);
    hopped = true;
    sw.flip(hop);
    await sleep(1500);
    let raw = '';
    try {
      raw = await require('./robeRail').proveThroughRail(sw.port());
    } catch {
      try { sw.flip(null); } catch {}
      try { await require('./phoneProxyMode').releaseSession(nome); } catch {}
      logEvt(nome, source, 'wizard_enviar_proxy', { ok: false, error: 'prove_failed' });
      return { ok: false, error: 'proxy_mobile_unavailable' };
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {}
    if (!parsed) {
      const blob = String(raw || '').match(/\{[\s\S]*\}/);
      if (blob) { try { parsed = JSON.parse(blob[0]); } catch {} }
    }
    const seen = require('./robeRail').readExit(parsed);
    if (!seen.ip || seen.asn === 'AS262481') {
      try { sw.flip(null); } catch {}
      try { await require('./phoneProxyMode').releaseSession(nome); } catch {}
      logEvt(nome, source, 'wizard_enviar_proxy', { ok: false, asn: seen.asn || '', ip: seen.ip || '' });
      return { ok: false, error: 'proxy_mobile_unavailable' };
    }
    logEvt(nome, source, 'wizard_enviar_proxy', { ok: true, asn: seen.asn, ip: seen.ip, via: 'phone_tab' });
    const mark = sw.bytesToProxy();
    let result = null;
    try {
      result = await action();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/execution context was destroyed|context was destroyed/i.test(msg)) {
        result = { ok: true, navigated: true };
        logEvt(nome, source, 'wizard_enviar', { ok: true, navigated: true });
      } else {
        throw e;
      }
    }
    const started = Date.now();
    let last = sw.bytesToProxy();
    let quiet = 0;
    while (Date.now() - started < 15000) {
      const now = sw.bytesToProxy();
      if (now > mark && now === last) {
        if (!quiet) quiet = Date.now();
        if (Date.now() - quiet >= 800) break;
      } else {
        quiet = 0;
        last = now;
      }
      await sleep(100);
    }
    const bytes = Math.max(0, sw.bytesToProxy() - mark);
    const need = Math.max(2048, Number(minBytes) || 0);
    logEvt(nome, source, 'wizard_enviar_left_proxy', {
      ok: !!(result && result.ok) && bytes >= need,
      bytes,
      need,
      clicked: !!(result && result.ok),
      asn: seen.asn,
      ip: seen.ip
    });
    try { sw.flip(null); } catch {}
    try { await require('./phoneProxyMode').releaseSession(nome); } catch {}
    hopped = false;
    if (bytes < need) {
      return { ok: false, error: 'enviar_photo_not_sent', bytes };
    }
    if (!(result && (result.ok || result.navigated))) return result || { ok: false, error: 'enviar_not_clicked', bytes };
    return { ok: true, bytes, navigated: !!(result && result.navigated) };
  } catch (e) {
    if (hopped) {
      try { if (sw) sw.flip(null); } catch {}
      try { await require('./phoneProxyMode').releaseSession(nome); } catch {}
    }
    const msg = String((e && e.message) || e);
    logEvt(nome, source, 'wizard_enviar_proxy', { ok: false, error: msg.slice(0, 160) });
    if (msg.indexOf('phone_proxy_required') === 0 || msg.indexOf('proxy_mobile') === 0) {
      return { ok: false, error: 'proxy_mobile_unavailable' };
    }
    throw e;
  }
}

async function runIdDocWizard(page, { idPath, deadlineAt, nome, source, network } = {}) {
  page.__ctIdWizardContext = { nome, source };
  assertBudget(deadlineAt, 'wizard_start');

  await sleep(WAIT_STEP_MS);

  // Já pode estar na tela final (ID feito antes).
  if (await isSuccessScreen(page)) {
    return finishAlreadySubmitted(page, { nome, source, where: 'open', deadlineAt });
  }

  const navigation=await require('./identityWizardNavigation').navigate({
    page,deadlineAt:Date.now()+deadlineLeft(deadlineAt),
    detect:()=>detectIdWizardScreen(page),
    selectCnh:()=>waitCnhSelected(page,{maxMs:Math.min(120000,deadlineLeft(deadlineAt)),deadlineAt}),
    reveal:()=>revealMarketplaceDocCheckpoint(page),
    record:({event,...entry})=>logEvt(nome,source,'wizard_navigation',{action:event,...entry})
  });
  logEvt(nome,source,'wizard_navigation_done',navigation);
  if(!navigation.ok)return navigation;
  if(navigation.screen==='success'||navigation.screen==='pending_review')return finishAlreadySubmitted(page,{nome,source,where:'navigation',deadlineAt});
  if(navigation.screen.startsWith('marketplace_phone_'))return runMarketplacePhoneVerification(page,{nome,source,deadlineAt,skipAdvance:navigation.screen!=='marketplace_phone_confirm'});
  if(!idPath||!fs.existsSync(idPath))return {ok:false,error:'id_png_missing'};

  // 7) Upload id.png via input[type=file] (mesmo padrão do ROBE de fotos)
  let input = null;
  let uploadedViaChooser = false;
  const findStart = Date.now();
  while (!input && !uploadedViaChooser && Date.now() - findStart < 120000 && deadlineLeft(deadlineAt) > 0) {
    await revealMarketplaceDocCheckpoint(page);
    if (await cnhChoiceVisible(page)) {
      const cnhWait = await waitCnhSelected(page, { maxMs: 25000, deadlineAt });
      logEvt(nome, source, 'wizard_cnh', {
        ok: !!(cnhWait && cnhWait.ok),
        where: 'file_loop',
        method: cnhWait && cnhWait.sel && cnhWait.sel.method,
        radioCount: cnhWait && cnhWait.probe && cnhWait.probe.radioCount
      });
      if (!(cnhWait && cnhWait.ok)) return { ok: false, error: 'cnh_not_selected' };
      const leftList = await advanceBlueAndSeeUpload(page, deadlineAt);
      logEvt(nome, source, 'wizard_avancar_pos_cnh', { ok: !!leftList, where: 'file_loop' });
      if (!leftList) return { ok: false, error: 'avancar_pos_cnh_not_clicked' };
      await sleep(1500);
      continue;
    }
    if (await identityDocIntroStillOpen(page) && !pageIsMarketplaceDocCheckpoint(page)) {
      const advanced = await clickDocIntroAvancar(page, deadlineAt);
      logEvt(nome, source, 'wizard_doc_intro_avancar_late', { ok: !!advanced });
      if (!advanced) return { ok: false, error: 'doc_intro_avancar_not_clicked' };
      await sleep(1500);
      continue;
    }
    if (await identityRetryStillOpen(page)) {
      const advanced = await clickAvancar(page);
      if (advanced) {
        await sleep(1500);
        continue;
      }
      if (!pageIsMarketplaceDocCheckpoint(page)) return { ok: false, error: 'avancar_not_clicked' };
    }
    if (pageIsMarketplaceDocCheckpoint(page)) {
      if (await identityDocIntroStillOpen(page)) {
        const advanced = await clickRoleAria(page, 'avancar');
        logEvt(nome, source, 'wizard_doc_intro_avancar', { ok: !!advanced, where: 'checkpoint_file_loop' });
        await sleep(1500);
        continue;
      }
      const photo = await pageHasNorm(page, "n.includes('carregue uma foto')");
      if (photo) {
        const stable = await waitCarregarStable(page, deadlineAt);
        logEvt(nome, source, 'wizard_carregar_pronto', { ok: !!stable });
        if (!stable) {
          await sleep(1000);
          continue;
        }
        const waiter = page.waitForFileChooser({ timeout: 30000 }).catch(() => null);
        const loaded = await clickRoleAria(page, 'carregar');
        logEvt(nome, source, 'wizard_carregar_documento', { ok: !!loaded, where: 'foto_carregar' });
        const got = loaded ? await waiter : null;
        if (got) await got.accept([idPath]);
        logEvt(nome, source, 'wizard_upload', { ok: !!got, via: 'file_chooser' });
        if (!got) {
          await sleep(1500);
          continue;
        }
        const attachedNow = await waitPhotoAttached(page, deadlineAt);
        logEvt(nome, source, 'wizard_foto_pronta', {
          ok: !!(attachedNow && attachedNow.ok),
          error: (attachedNow && attachedNow.error) || '',
          preview: !!(attachedNow && attachedNow.preview),
          fileSize: attachedNow && attachedNow.fileSize || 0,
          enviar: !!(attachedNow && attachedNow.enviar),
          snippet: (attachedNow && attachedNow.snippet) || '',
          where: 'depois_do_carregar'
        });
        if (attachedNow && attachedNow.ok) {
          uploadedViaChooser = true;
          break;
        }
        await sleep(1500);
        continue;
      }
    }
    input = await findFileInputEverywhere(page);
    if (input) break;
    await clickByText(page, ['carregar documento de identidade', 'enviar documento de identidade', 'escolher arquivo', 'adicionar arquivo'], {
      withinDialog: false,
      exact: false
    });
    await sleep(2500);
  }
  if (!uploadedViaChooser) {
    if (!input) {
      return { ok: false, error: 'file_input_not_found' };
    }
    try {
      await input.uploadFile(idPath);
    } catch (e) {
      return { ok: false, error: `upload_failed:${(e && e.message) || e}` };
    }
    logEvt(nome, source, 'wizard_upload', { ok: true });
  }
  const attached = await waitPhotoAttached(page, deadlineAt);
  logEvt(nome, source, 'wizard_foto_pronta', {
    ok: !!(attached && attached.ok),
    error: (attached && attached.error) || '',
    preview: !!(attached && attached.preview),
    fileSize: attached && attached.fileSize || 0,
    enviar: !!(attached && attached.enviar),
    snippet: (attached && attached.snippet) || ''
  });
  if (!(attached && attached.ok)) {
    return { ok: false, error: (attached && attached.error) || 'foto_nao_entrou' };
  }
  assertBudget(deadlineAt, 'wizard_after_upload');

  // 8) A foto está pronta. Toda a sessão isolada permanece na rota configurada.
  const fileBytes = (() => { try { return fs.statSync(idPath).size; } catch { return 0; } })();
  const sentWrap = await submitEnviarOnPhone(page, nome, source, async () => {
    let sent = false;
    let notedButtons = false;
    const sendStart = Date.now();
    while (!sent && Date.now() - sendStart < 90000 && deadlineLeft(deadlineAt) > 0) {
      try {
        const ready = (await require('./interactionReadiness').waitControl(page,['enviar','submit','send'],{exact:true,withinDialog:true,timeoutMs:Math.max(1,Math.min(15000,deadlineLeft(deadlineAt)))})).ok;
        if (!ready) {
          await sleep(800);
          continue;
        }
        sent = await clickBlueOverlay(page, ['enviar', 'submit', 'send']);
        if (!sent) sent = await clickExactWord(page, ['enviar', 'submit', 'send']);
        if (!sent && !notedButtons) {
          notedButtons = true;
          const labels = await readVisibleButtonLabels(page);
          logEvt(nome, source, 'wizard_enviar_buttons', { labels: labels.slice(0, 12) });
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (!/execution context was destroyed|context was destroyed/i.test(msg)) throw e;
        await sleep(1500);
        continue;
      }
      if (!sent) await sleep(1500);
    }
    logEvt(nome, source, 'wizard_enviar', { ok: !!sent });
    if (!sent) return { ok: false, error: 'enviar_not_clicked' };
    return { ok: true };
  }, Math.floor(fileBytes * 0.4), network === 'neorede' ? 'neorede' : 'phone');
  if (!(sentWrap && sentWrap.ok)) {
    return { ok: false, error: (sentWrap && sentWrap.error) || 'enviar_not_clicked' };
  }

  // 9) Pós-Enviar: 1–120s → (em andamento → Pronto) → Fechar
  const finished = await finishAfterEnviar(page, { nome, source, deadlineAt });
  if (!(finished && finished.ok)) {
    return { ok: false, error: (finished && finished.error) || 'post_enviar_failed' };
  }

  logEvt(nome, source, 'wizard_success', { ok: true });
  return { ok: true };
}

function phoneSendShouldRetry(wiz) {
  const err = String((wiz && wiz.error) || '');
  return err === 'facebook_erro_tecnico' || err === 'proxy_mobile_unavailable' || err === 'enviar_photo_not_sent';
}

async function reopenIdentityListing(page, { nome, source, deadlineAt, mode }) {
  await ensureSellingFeed(page, { deadlineAt });
  const opened = await tryOpenActionNeededAtTop(page, {
    nome,
    source,
    mode: mode === 'auto' ? 'today' : 'firstAny',
    preferTitle: '',
    attempts: mode === 'auto' ? TOP_SCAN_ATTEMPTS_AUTO : TOP_SCAN_ATTEMPTS_HUMAN,
    deadlineAt
  });
  if (opened && opened.openedOk) return true;
  if (mode === 'auto') return false;
  const probed = await openIdentityFromVisibleListings(page, { nome, source, deadlineAt });
  return !!probed;
}

async function runIdDocWithFallback(page, { idPath, deadlineAt, nome, source, mode }) {
  const isolated = require('./isolatedAccountFlow').context(page, 'id');
  if (isolated) {
    if (isolated.proxyRequired && !isolated.rail.isProxyArmed) return { ok: false, error: 'identity_proxy_required' };
    return runIdDocWizard(page, { idPath, deadlineAt, nome, source, network: isolated.proxyRequired ? 'isolated' : 'neorede' });
  }
  let wiz = await runIdDocWizard(page, { idPath, deadlineAt, nome, source, network: 'phone' });
  if (wiz && wiz.ok) return wiz;
  if (!phoneSendShouldRetry(wiz)) return wiz;

  logEvt(nome, source, 'wizard_proxy_rotate', { error: wiz.error || '' });
  try { await require('./phoneProxyMode').release(nome); } catch {}
  if (!(await reopenIdentityListing(page, { nome, source, deadlineAt, mode }))) return wiz;

  wiz = await runIdDocWizard(page, { idPath, deadlineAt, nome, source, network: 'phone' });
  if (wiz && wiz.ok) return wiz;
  if (!phoneSendShouldRetry(wiz)) return wiz;

  logEvt(nome, source, 'wizard_neorede_fallback', { error: wiz.error || '' });
  try { await require('./phoneProxyMode').release(nome); } catch {}
  if (!(await reopenIdentityListing(page, { nome, source, deadlineAt, mode }))) return wiz;
  return runIdDocWizard(page, { idPath, deadlineAt, nome, source, network: 'neorede' });
}

async function runRobeAutoId({ page, nome, titulo, deadlineAt } = {}) {
  // O marcador é consultado antes de abrir qualquer navegador/aba de identidade.
  if (await isDoneToday(nome)) return { ok: true, skipped: true, reason: 'already_done_today' };
  if (!require('./isolatedAccountFlow').context(page, 'id')) {
    try {
      const isolatedDeadline = Number(deadlineAt) || Date.now() + BUDGET_TOTAL_MS;
      return await require('./isolatedAccountFlow').run({ page, nome, kind: 'id', deadlineAt: isolatedDeadline },
        isolatedPage => runRobeAutoId({ page: isolatedPage, nome, titulo, deadlineAt: isolatedDeadline }));
    } catch (e) {
      const error = String(e.message || e);
      if(shouldMarkDocError({ok:false,error}))await setMarketplaceDocFlag(nome, { reason: error, text: error });
      return { ok: false, marked: false, error };
    }
  }
  const startedAt = Date.now();
  const source = 'auto';
  const parentDeadline=require('./isolatedAccountFlow').context(page,'id')?.deadlineAt||Infinity;
  const hardDeadline = Math.min(Number(deadlineAt) || Date.now() + BUDGET_TOTAL_MS,parentDeadline);

  let taken = null;
  try {
    taken = await takeIdentityTab(page);
    const handle0 = pageHandleState(page);
    logEvt(nome, source, 'page_handle', { reason: handle0.reason, url: String(handle0.url || '').slice(0, 180) });
    if (!handle0.ok) {
      logEvt(nome, source, 'skip_page_gone', { why: handle0.reason });
      return { ok: true, skipped: true, reason: 'page_gone' };
    }

    // ID - sim: encerra na hora. Sem selling, sem scan, sem scroll.
    const done = await isDoneToday(nome);
    if (done) {
      logEvt(nome, source, 'skip_already_done_today', { durationMs: Date.now() - startedAt });
      return { ok: true, skipped: true, reason: 'already_done_today' };
    }

    await sleep(WAIT_POST_SETTLE_MS);
    try {
      await dismissTurbineUpsell(page, { deadlineAt: Math.min(hardDeadline, Date.now() + 20000) });
    } catch (e) {
      logEvt(nome, source, 'dismiss_err', { error: String((e && e.message) || e).slice(0, 160) });
    }

    // Budget gordo para o restante (só se ID - nao).
    const workDeadline = Math.min(hardDeadline, Date.now() + BUDGET_TOTAL_MS);

    const handle1 = pageHandleState(page);
    if (!handle1.ok) {
      logEvt(nome, source, 'skip_page_gone_after_dismiss', { why: handle1.reason });
      return { ok: true, skipped: true, reason: 'page_gone' };
    }

    await ensureSellingFeed(page, { deadlineAt: workDeadline });
    assertBudget(workDeadline, 'auto_after_selling');
    await require('./accountSecurityGate').assertAllowed(page,nome);
    await require('./workAuthentication').assertAuthenticated(page,nome);

    // ID - nao: banner no topo. Sem scroll-hunt.
    const { openedOk, scan } = await tryOpenActionNeededAtTop(page, {
      nome,
      source,
      mode: 'today',
      preferTitle: titulo || '',
      attempts: TOP_SCAN_ATTEMPTS_AUTO,
      deadlineAt: workDeadline
    });

    if (!openedOk && !(scan && scan.found)) {
      const stale = scan && scan.reason === 'action_stale_not_today';
      logEvt(nome, source, stale ? 'action_stale_not_today' : 'no_action_needed_today', {
        durationMs: Date.now() - startedAt,
        topOnly: true,
        listedLabel: (scan && scan.listedLabel) || null,
        staleCount: Number(scan && scan.staleCount || 0) || 0,
        listedToday: false
      });
      return {
        ok: true,
        skipped: true,
        reason: stale ? 'action_stale_not_today' : 'no_action_needed_today',
        listedLabel: (scan && scan.listedLabel) || null
      };
    }
    if (!openedOk) {
      logEvt(nome, source, 'open_listing_failed', {
        method: (scan && scan.method) || null,
        durationMs: Date.now() - startedAt
      });
      const fail = { ok: false, error: 'open_listing_failed' };
      await setMarketplaceDocFlag(nome, { reason: fail.error, text: 'Nao abriu o anuncio com acao necessaria.' });
      return fail;
    }

    await sleep(WAIT_STEP_MS);

    const wiz = await runIdDocWithFallback(page, {
      idPath: ID_PNG_PATH,
      deadlineAt: workDeadline,
      nome,
      source,
      mode: 'auto'
    });

    if (wiz && (wiz.marketplacePhoneNoBalance === true || wiz.marketplacePhoneError === true)) {
      logEvt(nome, source, 'marketplace_phone_auto_abort', {
        reason: wiz.reason || null,
        noBalance: !!wiz.marketplacePhoneNoBalance,
        durationMs: Date.now() - startedAt
      });
      return Object.assign({ ok: true, marked: false, skipped: true }, wiz);
    }

    if (wiz && wiz.ok && wiz.marketplacePhoneVerified === true) {
      await clearMarketplacePhoneFlags(nome);
      const day = await markDoneToday(nome, { via: 'phone' });
      logEvt(nome, source, 'marked_phone_sim', {
        day,
        durationMs: Date.now() - startedAt
      });
      return { ok: true, marked: true, phone: true, day, marketplacePhoneVerified: true };
    }

    if (wiz && wiz.ok) {
      await clearMarketplacePhoneFlags(nome);
      const day = await markDoneToday(nome);
      logEvt(nome, source, 'marked_sim', {
        day,
        alreadySubmitted: !!wiz.alreadySubmitted,
        durationMs: Date.now() - startedAt
      });
      return { ok: true, marked: true, day, alreadySubmitted: !!wiz.alreadySubmitted };
    }

    const fail = { ok: false, error: (wiz && wiz.error) || 'wizard_failed' };
    await recordIdFailure(page, nome, source, fail.error);
    logEvt(nome, source, 'wizard_failed', {
      error: fail.error,
      durationMs: Date.now() - startedAt
    });
    if (shouldMarkDocError(fail)) {
      await setMarketplaceDocFlag(nome, { reason: fail.error, text: `ID de documento nao concluiu: ${fail.error}` });
    }
    return fail;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logEvt(nome, source, 'auto_exception', { error: String(msg).slice(0, 220), durationMs: Date.now() - startedAt });
    const fail = { ok: false, error: msg };
    if (shouldMarkDocError(fail)) {
      await setMarketplaceDocFlag(nome, { reason: 'marketplace_doc_error', text: String(msg).slice(0, 400) });
    }
    return fail;
  } finally {
    releaseIdentityTab(page, taken);
  }
}

async function openIdentityFromVisibleListings(page, { nome, source, deadlineAt } = {}) {
  let labels = [];
  try {
    labels = await page.evaluate(() => {
      const normLocal = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      const skip = /marcar como|promover|turbinar|mais opcoes|more options|visualizaram|criar classificado|anunciar|enviar mensagem/;
      const out = [];
      const seen = new Set();
      for (const el of Array.from(document.querySelectorAll('[role="button"][aria-label], a[aria-label]'))) {
        const al = String(el.getAttribute('aria-label') || '').trim();
        const n = normLocal(al);
        if (!al || al.length < 8 || al.length > 180 || skip.test(n) || /voltar|pagina anterior|^back$|^facebook$/.test(n) || seen.has(n)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        seen.add(n);
        out.push(al);
        if (out.length >= 6) break;
      }
      return out;
    });
  } catch {
    return '';
  }
  for (const label of labels) {
    if (deadlineLeft(deadlineAt) < 20000) break;
    let clicked = false;
    try {
      clicked = await page.evaluate((wanted) => {
        const el = Array.from(document.querySelectorAll('[role="button"][aria-label], a[aria-label]')).find((node) => {
          return String(node.getAttribute('aria-label') || '').trim() === wanted;
        });
        if (!el) return false;
        el.click();
        return true;
      }, label);
    } catch {
      clicked = false;
    }
    if (!clicked) continue;
    await sleep(5000);
    let screen = '';
    try { screen = await detectIdWizardScreen(page); } catch {}
    logEvt(nome, source, 'listing_probe', { label: String(label).slice(0, 60), screen: screen || 'unknown' });
    if (['identity_retry', 'upload_photo', 'doc_type', 'carregar_doc', 'identity_doc_intro', 'continuar', 'confirm'].includes(screen)) {
      return screen;
    }
    try {
      await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch {}
    await sleep(4000);
  }
  return '';
}

async function runHumanVerifyId({ page, nome, deadlineAt } = {}) {
  if(await isDoneToday(nome))return {ok:true,skipped:true,marked:false,reason:'already_done_today'};
  if (!require('./isolatedAccountFlow').context(page, 'id')) {
    try {
      const isolatedDeadline = Number(deadlineAt) || Date.now() + BUDGET_TOTAL_MS;
      return await require('./isolatedAccountFlow').run({ page, nome, kind: 'id', deadlineAt: isolatedDeadline },
        isolatedPage => runHumanVerifyId({ page: isolatedPage, nome, deadlineAt: isolatedDeadline }));
    } catch (e) {
      const error = String(e.message || e);
      await setMarketplaceDocFlag(nome, { reason: error, text: error });
      return { ok: false, marked: false, error };
    }
  }
  const startedAt = Date.now();
  const source = 'human';
  const workDeadline = Number(deadlineAt) || Date.now() + BUDGET_TOTAL_MS;

  let taken = null;
  try {
    taken = await takeIdentityTab(page);
    if (!pageHandleState(page).ok) {
      logEvt(nome, source, 'human_page_gone', {});
      return { ok: false, error: 'page_gone' };
    }

    try {
      await dismissTurbineUpsell(page, { deadlineAt: Math.min(workDeadline, Date.now() + 20000) });
    } catch {}

    const here = await detectIdWizardScreen(page).catch(() => '');
    const wizardHere = ['identity_retry', 'upload_photo', 'doc_type', 'carregar_doc', 'identity_doc_intro', 'continuar', 'confirm'].includes(here);
    let openedOk = false;
    let scan = null;
    if (wizardHere) {
      await require('./isolatedAccountFlow').armIdentity(page);
      openedOk = true;
      scan = { found: true, method: 'already_open' };
      logEvt(nome, source, 'wizard_already_open', { screen: here });
    } else {
      await ensureSellingFeed(page, { deadlineAt: workDeadline });

      // Humano força o fluxo, mas banner também fica no topo — sem scroll-hunt.
      const opened = await tryOpenActionNeededAtTop(page, {
        nome,
        source,
        mode: 'today',
        preferTitle: '',
        attempts: TOP_SCAN_ATTEMPTS_HUMAN,
        deadlineAt: workDeadline
      });
      openedOk = opened.openedOk;
      scan = opened.scan;
    }

    if (!openedOk) {
      logEvt(nome, source, 'human_no_action', {
        durationMs: Date.now() - startedAt,
        found: !!(scan && scan.found),
        method: (scan && scan.method) || null,
        topOnly: true
      });
      const fail = { ok: false, error: (scan && scan.found) ? 'open_listing_failed' : 'no_action_needed' };
      if (shouldMarkDocError(fail)) {
        await setMarketplaceDocFlag(nome, { reason: fail.error, text: 'Nao abriu o anuncio com acao necessaria.' });
      }
      return fail;
    }

    await sleep(WAIT_STEP_MS);
    const wiz = await runIdDocWithFallback(page, {
      idPath: ID_PNG_PATH,
      deadlineAt: workDeadline,
      nome,
      source,
      mode: 'human'
    });

    // CONTRATO: humano NUNCA marca robeIdDocDoneDay
    logEvt(nome, source, wiz && wiz.ok ? 'human_wizard_ok_no_mark' : 'human_wizard_fail', {
      error: wiz && wiz.error ? wiz.error : null,
      durationMs: Date.now() - startedAt,
      markSim: false
    });
    if (wiz && wiz.ok) {
      await clearMarketplacePhoneFlags(nome);
      return { ok: true, marked: false, identityFlowConfirmed: true };
    }
    const fail = { ok: false, error: (wiz && wiz.error) || 'wizard_failed', marked: false, marketplacePhoneError: !!(wiz && wiz.marketplacePhoneError), marketplacePhoneNoBalance: !!(wiz && wiz.marketplacePhoneNoBalance) };
    await recordIdFailure(page, nome, source, fail.error);
    if (shouldMarkDocError(fail)) {
      await setMarketplaceDocFlag(nome, { reason: fail.error, text: `ID de documento nao concluiu: ${fail.error}` });
    }
    return fail;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logEvt(nome, source, 'human_exception', { error: String(msg).slice(0, 220) });
    const fail = { ok: false, error: msg, marked: false };
    if (shouldMarkDocError(fail)) {
      await setMarketplaceDocFlag(nome, { reason: 'marketplace_doc_error', text: String(msg).slice(0, 400) });
    }
    return fail;
  } finally {
    releaseIdentityTab(page, taken);
  }
}

module.exports = {
  BUDGET_TOTAL_MS,
  BUDGET_SKIP_MS,
  ID_PNG_PATH,
  todaySP,
  isMarketplaceActionText,
  isIdentityConfirmLabel,
  isIdentityDocumentLabel,
  isIdentityReviewText,
  isIdentityRetryText,
  isIdentityDocIntroText,
  isAdvanceLabel,
  isCnhChoiceLabel,
  isBlueFill,
  buttonLooksEnabled,
  extractMarketplacePhoneConfirmInfoFromText,
  isUnitedStatesDialOption,
  isDoneTodayFromDay,
  isSameSpDay,
  phoneAlertFlagsForToday,
  shouldMarkDocError,
  clearStaleMarketplacePhoneFlags,
  setMarketplaceDocFlag,
  classifyIdToday,
  idFlagsForToday,
  isDoneToday,
  markDoneToday,
  getIdPngPath,
  idPngExists,
  dateHintsSP,
  classifyListedToday,
  dismissTurbineUpsell,
  ensureSellingFeed,
  scanActionNeeded,
  openActionNeededListing,
  clickVerClassificadoMenu,
  waitListingIdentityPrompt,
  runIdDocWizard,
  detectIdWizardScreen,
  waitCnhSelected,
  runRobeAutoId,
  runHumanVerifyId,
  pageHandleState,
  isSellingUrl
};
