// scripts/virtus.js
/**
Runner do Virtus: Mantém uma aba do Messenger aberta/ativa/logada e atende automaticamente os chats Marketplace.
Arquitetura:
- 1 instância de Virtus por perfil (navegador), totalmente independente.
- Polling de novos chats a cada 30s por perfil.
- Atendimento contínuo 1–2 min por chat, por perfil, sem depender do tick de 30s.
- Persistência segura do histórico no Windows (write tmp -> unlink final -> rename/copy) + cache em memória 24h.
- Snapshot:
  - Se NÃO existir chats_respondidos.json: cria arquivo e marca TODOS <24h atuais como respondidos (não cria backlog antigo).
  - Se JÁ existir: retoma e enfileira somente <24h ainda não respondidos, sem marcar nada nesse momento.
- Anti-duplicação por ID com TTL de 24h (não usa DOM para decidir).
*/

const fs = require('fs/promises');
const fsRaw = require('fs'); // Necessário para uso síncrono dentro de getPerfilManifest
const path = require('path');
const os = require('os');
const { patchPage, ensureMinimizedWindowForPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');
const provisionAudit = require('./provisionAudit.js');

// Locks por perfil de input
const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

// Helpers globais de send-lock/contexto
function getBrowserFromPage(p) { try { return typeof p.browser === 'function' ? p.browser() : null; } catch { return null; } }
function acquireSendGuardBrowser(browser, chatId) {
  try {
    if (!browser) return;
    browser._sendLock = { active: true, owner: 'virtus', chatId, since: Date.now() };
  } catch {}
}
function acquireSendGuard(p, chatId) { try { const b = getBrowserFromPage(p); if (b) acquireSendGuardBrowser(b, chatId); } catch {} }
function releaseSendGuardBrowser(browser) {
  try {
    if (!browser) return;
    if (browser._sendLock && browser._sendLock.owner === 'virtus') browser._sendLock.active = false;
  } catch {}
}
function releaseSendGuard(p) { try { const b = getBrowserFromPage(p); if (b) releaseSendGuardBrowser(b); } catch {} }
async function assertOnChat(p, chatId, { timeoutMs = 0 } = {}) {
  const t0 = Date.now();
  while (true) {
    const evalStartedAt = Date.now();
    const evalOrTimeout = await Promise.race([
      p.evaluate((id) => {
        try {
          const path = (location && typeof location.pathname === 'string') ? String(location.pathname || '') : '';
          const href = (location && typeof location.href === 'string') ? String(location.href || '') : '';
          if (path.includes('/marketplace/t/' + id) || path.includes('/messages/t/' + id)) return true;
          if (href.includes('/marketplace/t/' + id) || href.includes('/messages/t/' + id)) return true;
          const rowById = document.querySelector(`a[href*="/marketplace/t/${id}"], a[href*="/messages/t/${id}"]`);
          if (!rowById) return false;
          const selected = rowById.closest('[aria-current="page"], [aria-selected="true"]');
          if (selected) return true;
          return false;
        }
        catch { return false; }
      }, chatId).catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve('__virtus_eval_timeout__'), VIRTUS_ASSERT_ON_CHAT_EVAL_TIMEOUT_MS))
    ]).catch(() => false);
    const ok = (evalOrTimeout === true);
    if (ok) return true;
    if (!timeoutMs) return false;
    const elapsed = Date.now() - t0;
    if (elapsed >= timeoutMs) {
      try {
        if (VIRTUS_DETAILED_DEBUG) {
          logger.warn('[VIRTUS] assertOnChat timeout', { chatId: String(chatId || '').slice(0, 80), timeoutMs, waitedMs: elapsed });
        }
      } catch {}
      return false;
    }
    await sleep(120);
  }
}
async function clearComposerIfAny(p, campo) {
  try {
    if (!campo) return;
    const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';
    try { await campo.click({ delay: 20 }); } catch {}
    try { await p.keyboard.down(ctrlKey); await p.keyboard.press('KeyA'); await p.keyboard.up(ctrlKey); } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
  } catch {}
}

// Debug flags por variável de ambiente
const VIRTUS_SCROLL_DEBUG = process.env && process.env.VIRTUS_SCROLL_DEBUG === '1';
const VIRTUS_DETAILED_DEBUG = process.env && process.env.VIRTUS_DEBUG === '1';
const LEGACY_RUNTIME_DEBUG_ENABLED = String(process.env.LEGACY_RUNTIME_DEBUG || '').trim() === '1';
const VIRTUS_PAGE_HEAP_RECYCLE_MB = parseInt(process.env.VIRTUS_PAGE_HEAP_RECYCLE_MB || '75', 10);
const VIRTUS_PAGE_NODES_RECYCLE = parseInt(process.env.VIRTUS_PAGE_NODES_RECYCLE || '2600', 10);
const VIRTUS_PAGE_RECYCLE_COOLDOWN_MS = parseInt(process.env.VIRTUS_PAGE_RECYCLE_COOLDOWN_MS || '900000', 10); // 15 min
const VIRTUS_PAGE_RECYCLE_FOLLOWUP_MS = parseInt(process.env.VIRTUS_PAGE_RECYCLE_FOLLOWUP_MS || '45000', 10);
const VIRTUS_HOST_FREE_LOW_MB = parseInt(process.env.VIRTUS_HOST_FREE_LOW_MB || '12000', 10);
const VIRTUS_HOST_FREE_CRITICAL_MB = parseInt(process.env.VIRTUS_HOST_FREE_CRITICAL_MB || '8000', 10);
const VIRTUS_PAGE_HEAP_RECYCLE_LOW_MB = parseInt(process.env.VIRTUS_PAGE_HEAP_RECYCLE_LOW_MB || '55', 10);
const VIRTUS_PAGE_NODES_RECYCLE_LOW = parseInt(process.env.VIRTUS_PAGE_NODES_RECYCLE_LOW || '2100', 10);
const VIRTUS_PAGE_HEAP_RECYCLE_CRITICAL_MB = parseInt(process.env.VIRTUS_PAGE_HEAP_RECYCLE_CRITICAL_MB || '40', 10);
const VIRTUS_PAGE_NODES_RECYCLE_CRITICAL = parseInt(process.env.VIRTUS_PAGE_NODES_RECYCLE_CRITICAL || '1600', 10);
const VIRTUS_PAGE_RECYCLE_COOLDOWN_LOW_MS = parseInt(process.env.VIRTUS_PAGE_RECYCLE_COOLDOWN_LOW_MS || '180000', 10); // 3 min
const VIRTUS_PAGE_RECYCLE_COOLDOWN_CRITICAL_MS = parseInt(process.env.VIRTUS_PAGE_RECYCLE_COOLDOWN_CRITICAL_MS || '60000', 10); // 1 min
const VIRTUS_RECYCLE_GLOBAL_GAP_MS = parseInt(process.env.VIRTUS_RECYCLE_GLOBAL_GAP_MS || '4000', 10);
const VIRTUS_RECYCLE_LOCK_TTL_MS = parseInt(process.env.VIRTUS_RECYCLE_LOCK_TTL_MS || '45000', 10);
const VIRTUS_IDLE_COLD_MS = parseInt(process.env.VIRTUS_IDLE_COLD_MS || '3600000', 10); // 1h
const VIRTUS_IDLE_DEEP_MS = parseInt(process.env.VIRTUS_IDLE_DEEP_MS || '10800000', 10); // 3h
const VIRTUS_IDLE_SKIP_RECYCLE_UNTIL_PRESSURE = String(process.env.VIRTUS_IDLE_SKIP_RECYCLE_UNTIL_PRESSURE || '1').trim() !== '0';
const VIRTUS_PAGE_RECYCLE_REPLY_COUNT = Math.max(0, parseInt(process.env.VIRTUS_PAGE_RECYCLE_REPLY_COUNT || '0', 10) || 0);
const VIRTUS_HEAVY_ACTION_WINDOW_MS = Math.max(60000, parseInt(process.env.VIRTUS_HEAVY_ACTION_WINDOW_MS || '900000', 10) || 900000); // 15 min
const VIRTUS_HEAVY_ACTION_MAX_PER_WINDOW = Math.max(1, parseInt(process.env.VIRTUS_HEAVY_ACTION_MAX_PER_WINDOW || '2', 10) || 2);
const VIRTUS_HEAVY_ACTION_MIN_GAP_MS = Math.max(10000, parseInt(process.env.VIRTUS_HEAVY_ACTION_MIN_GAP_MS || '180000', 10) || 180000); // 3 min
const VIRTUS_PAGE_SWAP_RECYCLE_ENABLED = String(process.env.VIRTUS_PAGE_SWAP_RECYCLE_ENABLED || '0').trim() === '1';
const VIRTUS_PAGE_SWAP_WINDOW_MS = Math.max(8000, parseInt(process.env.VIRTUS_PAGE_SWAP_WINDOW_MS || '25000', 10) || 25000);
const VIRTUS_PAGE_SWAP_NAV_TIMEOUT_MS = Math.max(8000, parseInt(process.env.VIRTUS_PAGE_SWAP_NAV_TIMEOUT_MS || '20000', 10) || 20000);
const VIRTUS_PAGE_RECYCLE_ENABLED = String(process.env.VIRTUS_PAGE_RECYCLE_ENABLED || '0').trim() === '1';
const VIRTUS_ASSERT_ON_CHAT_EVAL_TIMEOUT_MS = Math.max(600, parseInt(process.env.VIRTUS_ASSERT_ON_CHAT_EVAL_TIMEOUT_MS || '2200', 10) || 2200);
const VIRTUS_RESP_CACHE_LOW_MAX = parseInt(process.env.VIRTUS_RESP_CACHE_LOW_MAX || '3000', 10);
const VIRTUS_RESP_CACHE_CRITICAL_MAX = parseInt(process.env.VIRTUS_RESP_CACHE_CRITICAL_MAX || '1800', 10);
const VIRTUS_FAIL_COUNTS_LOW_MAX = parseInt(process.env.VIRTUS_FAIL_COUNTS_LOW_MAX || '700', 10);
const VIRTUS_FAIL_COUNTS_CRITICAL_MAX = parseInt(process.env.VIRTUS_FAIL_COUNTS_CRITICAL_MAX || '350', 10);
const VIRTUS_FAST_MODE = String(process.env.VIRTUS_FAST_MODE || '0').trim() === '1';
const VIRTUS_TYPE_DELAY_MIN_MS = Math.max(
  0,
  parseInt(process.env.VIRTUS_TYPE_DELAY_MIN_MS || String(VIRTUS_FAST_MODE ? 0 : 25), 10) || (VIRTUS_FAST_MODE ? 0 : 25)
);
const VIRTUS_TYPE_DELAY_MAX_MS = Math.max(
  VIRTUS_TYPE_DELAY_MIN_MS,
  parseInt(process.env.VIRTUS_TYPE_DELAY_MAX_MS || String(VIRTUS_FAST_MODE ? 12 : 60), 10) || (VIRTUS_FAST_MODE ? 12 : 60)
);
const VIRTUS_ENTER_AFTER_TYPE_MIN_MS = Math.max(
  0,
  parseInt(process.env.VIRTUS_ENTER_AFTER_TYPE_MIN_MS || String(VIRTUS_FAST_MODE ? 50 : 180), 10) || (VIRTUS_FAST_MODE ? 50 : 180)
);
const VIRTUS_ENTER_AFTER_TYPE_MAX_MS = Math.max(
  VIRTUS_ENTER_AFTER_TYPE_MIN_MS,
  parseInt(process.env.VIRTUS_ENTER_AFTER_TYPE_MAX_MS || String(VIRTUS_FAST_MODE ? 120 : 450), 10) || (VIRTUS_FAST_MODE ? 120 : 450)
);
const VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS = Math.max(
  120,
  parseInt(process.env.VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS || String(VIRTUS_FAST_MODE ? 220 : 700), 10) || (VIRTUS_FAST_MODE ? 220 : 700)
);
const VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS = Math.max(
  VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS,
  parseInt(process.env.VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS || String(VIRTUS_FAST_MODE ? 450 : 1400), 10) || (VIRTUS_FAST_MODE ? 450 : 1400)
);
const VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS = Math.max(
  120,
  parseInt(process.env.VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS || String(VIRTUS_FAST_MODE ? 220 : 450), 10) || (VIRTUS_FAST_MODE ? 220 : 450)
);
const VIRTUS_CHAT_OPEN_DEADLINE_MS = Math.max(
  8000,
  parseInt(process.env.VIRTUS_CHAT_OPEN_DEADLINE_MS || String(VIRTUS_FAST_MODE ? 15000 : 30000), 10) || (VIRTUS_FAST_MODE ? 15000 : 30000)
);
const VIRTUS_COMPOSER_FAST_TIMEOUT_MS = Math.max(
  6000,
  parseInt(process.env.VIRTUS_COMPOSER_FAST_TIMEOUT_MS || String(VIRTUS_FAST_MODE ? 10000 : 22000), 10) || (VIRTUS_FAST_MODE ? 10000 : 22000)
);
const VIRTUS_COMPOSER_RECHECK_MS = Math.max(
  250,
  parseInt(process.env.VIRTUS_COMPOSER_RECHECK_MS || String(VIRTUS_FAST_MODE ? 550 : 1400), 10) || (VIRTUS_FAST_MODE ? 550 : 1400)
);
const VIRTUS_SEND_CONFIRM_TIMEOUT_MS = Math.max(
  1200,
  parseInt(process.env.VIRTUS_SEND_CONFIRM_TIMEOUT_MS || String(VIRTUS_FAST_MODE ? 3200 : 7000), 10) || (VIRTUS_FAST_MODE ? 3200 : 7000)
);
const VIRTUS_CHAT_OPEN_PRIMARY_MODE = (String(process.env.VIRTUS_CHAT_OPEN_PRIMARY_MODE || 'mouse').trim().toLowerCase() === 'dom') ? 'dom' : 'mouse';
const VIRTUS_DIRECT_SEND_ON_OPEN = String(process.env.VIRTUS_DIRECT_SEND_ON_OPEN || '1').trim() !== '0';
const __virtusGlobalRecycle = { owner: '', acquiredAt: 0, lastReleaseAt: 0 };
function __virtusAgentLog(hypothesisId, location, message, data, key = '', minIntervalMs = 0) {
  return;
}

// Debounce de log "Browser morto, não é possível garantir page." — 1x/60s por perfil
const virtusDeadLogTimes = {}; // { [nome]: timestamp }

// TTL periódica para virtusDeadLogTimes (limpeza de entradas >24h)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(virtusDeadLogTimes)) {
    if (now - v > 24 * 60 * 60 * 1000) delete virtusDeadLogTimes[k];
  }
}, 60 * 60 * 1000);

// Log de issues (robusto; falha silenciosa se o módulo não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Adicionado helper local para registrar issues
async function logIssue(nome, type, message) {
  try {
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, type, message);
    }
  } catch {
    // silencioso
  }
}

// Carrega JSON de atendimento.json (array de respostas randomizáveis)
let mensagensAtendimento = [];
(async () => {
  try {
    const file = await fs.readFile(path.join(__dirname, '../dados/atendimento.json'), 'utf8');
    const data = JSON.parse(file);
    if (Array.isArray(data)) {
      mensagensAtendimento = data;
    } else if (Array.isArray(data.messages)) {
      mensagensAtendimento = data.messages;
    } else {
      mensagensAtendimento = [];
    }
  } catch (e) {
    logger.error('[VIRTUS] ERRO ao carregar atendimento.json', {}, e);
    mensagensAtendimento = [];
  }
})();

function agoraEpoch() {
  return Math.floor(Date.now() / 1000);
}

const HIST_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_respondidos.json');

// ======= ADIÇÃO: Pending Ledger Helpers & Heurística =======
const PENDING_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_pending.json');

async function readJson(file, fb={}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fb; }
}
async function writeJsonAtomicFsync(file, obj){
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const fd = await fs.open(tmp, 'w');
  try {
    await fd.writeFile(JSON.stringify(obj, null, 2), 'utf8');
    await fd.sync();
  } finally { await fd.close(); }
  try { await fs.unlink(file); } catch {}
  try { await fs.rename(tmp, file); }
  catch { await fs.copyFile(tmp, file); try { await fs.unlink(tmp);} catch{} }
}
async function pendingAdd(perfil, chatId, attemptId) {
  const file = PENDING_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  cur[chatId] = { attemptId, startedAt: Date.now() };
  await writeJsonAtomicFsync(file, cur);
}
async function pendingDel(perfil, chatId) {
  const file = PENDING_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  if (cur[chatId]) { delete cur[chatId]; await writeJsonAtomicFsync(file, cur); }
}
async function pendingList(perfil) {
  const file = PENDING_JSON_NAME(perfil);
  return await readJson(file, {});
}
// Heurística: detecta bubble "você enviou/you sent"
async function wasRecentlySentByMe(page, maxAgeMs=10*60*1000) {
  try {
    return await page.evaluate((maxMs) => {
      const norm = s => (s||'').toLowerCase();
      const bubbles = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-50);
      const me = bubbles.reverse().find(b => {
        const txt = norm(b.innerText||b.textContent||'');
        if (/(você|voce|you)\s*(enviou|sent)/.test(txt)) return true;
        const style = getComputedStyle(b);
        return style && (style.justifyContent==='flex-end' || style.textAlign==='right');
      });
      if (!me) return false;
      // Se bubble fala em "agora", minutos, ou "há menos de 10min"
      const t = (me.innerText||'').toLowerCase();
      if (/agora|now/.test(t)) return true;
      if (/\b\d+\s*(min|m|minuto)\b/.test(t)) return true;
      if (/\b(\d+)\s*(h|hora)/.test(t)) {
        const m = t.match(/\b(\d+)\s*(h|hora)/);
        if (m && parseInt(m[1],10) <= 2) return true;
      }
      return false;
    }, maxAgeMs);
  } catch { return false; }
}

// Classificadores de tempo
// NOVO: Reduzido de 24h para 8h (menos scroll = menos RAM consumida)
function isVelho8h(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  if (/\b(ontem|yesterday)\b/.test(t)) return true;
  if (/\b(\d+)\s*(seman|sem|weeks?|w)\b/.test(t)) return true;
  const mDias = t.match(/\b(\d+)\s*(d|dias?)\b/);
  if (mDias) { if (parseInt(mDias[1],10) >= 1) return true; }
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) { if (parseInt(mH[1],10) >= 8) return true; } // NOVO: 8h ao invés de 24h
  return false;
}
// Mantido para compatibilidade (mas não usado mais)
function isVelho24h(tempoLabel) {
  return isVelho8h(tempoLabel); // Usa a nova função
}
function isChatRecente(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  if (isVelho8h(t)) return false; // NOVO: Usa isVelho8h
  if (/\b(agora|now)\b/.test(t)) return true;
  if (/\b\d+\s*(s|seg|secs?|seconds?)\b/.test(t)) return true;
  if (/\b\d+\s*(min|m|mins?|minutes?)\b/.test(t)) return true;
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) { if (parseInt(mH[1],10) < 8) return true; }
  return false;
}

// Extratores e coleta
function extraiIdDoHref(href) {
  try {
    const s = String(href || '');
    const keys = ['/marketplace/t/', '/messages/t/'];
    for (const key of keys) {
      const pos = s.indexOf(key);
      if (pos < 0) continue;
      const rest = s.slice(pos + key.length);
      const id = rest.split(/[/?#]/)[0];
      if (id && /^\d+$/.test(id)) return id;
    }
    return null;
  } catch { return null; }
}

async function coletaChatsMarketplaceTodos(page) {
  try {
    const items = await page.$$eval('a[href*="/marketplace/t/"], a[href*="/messages/t/"]', els => {
      function _extraiId(href) {
        try {
          const s = String(href || '');
          const keys = ['/marketplace/t/', '/messages/t/'];
          for (const key of keys) {
            const pos = s.indexOf(key);
            if (pos < 0) continue;
            const rest = s.slice(pos + key.length);
            const id = rest.split(/[/?#]/)[0];
            if (id && /^\d+$/.test(id)) return id;
          }
          return null;
        } catch { return null; }
      }
      function _extraiTempo(row) {
        if (!row) return '';
        try {
          const abbr = row.querySelector('abbr[aria-label]');
          if (abbr) {
            const t1 = (abbr.innerText || '').trim();
            if (t1) return t1;
            const t2 = (abbr.getAttribute('aria-label') || '').trim();
            if (t2) return t2;
          }
          const spans = Array.from(row.querySelectorAll('span'));
          for (const s of spans) {
            const txt = (s.innerText || s.textContent || '').trim();
            if (!txt) continue;
            if (/agora/i.test(txt)) return txt;
            if (/\d+\s*(s|min|m|seg|h|hora|hour|minute|minuto|dia|dias|d|sem|seman|week|w)/i.test(txt)) return txt;
          }
        } catch {}
        return '';
      }
      const arr = els.map(el => {
        const href = el.getAttribute('href') || el.href || '';
        const id = _extraiId(href);
        const row = el.closest('div[role="row"]') || el.parentElement;
        const tempo = _extraiTempo(row);
        return { id, tempo, href };
      }).filter(o => o.id);
      const map = new Map();
      for (const it of arr) if (!map.has(it.id)) map.set(it.id, it);
      return Array.from(map.values());
    });
    return items;
  } catch (err) {
    if (VIRTUS_DETAILED_DEBUG) { logger.debug('[VIRTUS] Erro em coletaChatsMarketplaceTodos', { err: String(err) }); }
    return [];
  }
}

// Messenger helpers
async function garantirMarketplace(page, { timeoutMs = 25000 } = {}) {
  if (!page || typeof page.url !== 'function') throw new Error('Page inválida');
  let url = '';
  try { url = page.url() || ''; } catch {}
  const browserJs = require('./browser.js');
  const isMarketplaceUnavailableError = (err) => {
    const msg = String((err && err.message) || err || '').toLowerCase();
    return msg.includes('marketplace_menu_not_available');
  };
  const isMarketplaceContextUrl = /messenger.com\/marketplace/i.test(url) || /facebook\.com\/messages/i.test(url);
  if (!isMarketplaceContextUrl) {
    if (browserJs && typeof browserJs.ensureMarketplaceMessagesContext === 'function') {
      try {
        const navState = await browserJs.ensureMarketplaceMessagesContext(page, { timeoutMs, reason: 'virtus_garantir_marketplace' });
        if (navState && navState.marketplaceAvailable === false) return false;
      } catch (err) {
        if (isMarketplaceUnavailableError(err)) return false;
        throw err;
      }
    } else {
      try { await page.goto('https://www.facebook.com/messages', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
    }
  }
  // Cura fluxos de nonce/continuar
  try {
    if (browserJs && typeof browserJs.resolveNonceIfPresent === 'function') {
      await browserJs.resolveNonceIfPresent(page).catch(()=>{});
    }
    if (browserJs && typeof browserJs.clickContinuarComo === 'function') {
      await browserJs.clickContinuarComo(page, { timeout: 12000 }).catch(()=>{});
    }
    if (browserJs && typeof browserJs.ensureMarketplaceMessagesContext === 'function') {
      const finalState = await browserJs.ensureMarketplaceMessagesContext(page, { timeoutMs, reason: 'virtus_garantir_marketplace_final' }).catch((err) => {
        if (isMarketplaceUnavailableError(err)) return { ok: true, marketplaceAvailable: false, reason: 'marketplace_menu_not_available' };
        throw err;
      });
      if (finalState && finalState.marketplaceAvailable === false) return false;
    }
  } catch {}
  // Espera robusta por UI
  const ok = await Promise.race([
    page.waitForFunction(() => {
      const hasAnchor = !!document.querySelector('a[href*="/marketplace/t/"], a[href*="/messages/t/"]');
      const hasGrid = !!document.querySelector('div[role="grid"]') || !!document.querySelector('div[role="rowgroup"]');
      const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
      return hasAnchor || hasGrid || hasRow;
    }, { timeout: timeoutMs }),
    page.waitForSelector('a[href*="/marketplace/t/"], a[href*="/messages/t/"]', { timeout: timeoutMs }).catch(() => null)
  ]);
  if (!ok) throw new Error('Marketplace UI não ficou pronta a tempo');
  return true;
}

// ========== INÍCIO DAS FUNÇÕES E GUARDRAILS SOLICITADAS ==========

/**
 * GUARD: manter top chats always visible to avoid drifting out of viewport.
 * Função utilitária para scrollar a lista de chats para o topo.
 * Executa direto via page.evaluate no Messenger.
 */
async function scrollChatsToTop(page, nome) {
  if (isVirtusLocked(nome)) return false;
  try {
    const b = getBrowserFromPage(page);
    if (b && b._sendLock && b._sendLock.active) return false;
  } catch {}
  if (!page) return false;
  try {
    const res = await page.evaluate(() => {
      // Procure vários elementos "scrolláveis"
      // 1. grid por role
      let grid = document.querySelector('div[role="grid"]');
      // 2. por data-virtualized e classes do FB
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf[data-virtualized="false"]');
      // 3. rowgroup
      if (!grid) grid = document.querySelector('div[role="rowgroup"]');
      // 4. fallback classe base
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf');
      // 5. heurística de altura
      if (!grid) grid = Array.from(document.querySelectorAll('div'))
        .find(d => d.scrollHeight > 400 && d.scrollHeight > d.clientHeight + 30);
      // 6. fallback body
      if (!grid) grid = document.body;
      if (!grid) return false;

      // Forçar scrollTop em grid e ancestrais
      grid.scrollTop = 0;
      let node = grid.parentElement;
      for (let i = 0; i < 4 && node; i++) {
        if (node.scrollHeight > node.clientHeight + 30) node.scrollTop = 0;
        node = node.parentElement;
      }

      // Tentativa extra: clicar em cima no topo para garantir foco no chat mais recente
      try {
        let firstA = grid.querySelector('a[role="link"], a[href*="/marketplace/t/"], a[href*="/messages/t/"]');
        if (firstA) {
          firstA.focus && firstA.focus();
          // Eventual scrollIntoView + toTop
          firstA.scrollIntoView({block: "start", behavior: "smooth"});
        }
      } catch {}

      // Se scroll ainda não foi suficiente (scrollTop > 0 depois do set), repete
      setTimeout(() => { if (grid.scrollTop > 0) grid.scrollTop = 0; }, 250);

      return grid.scrollTop === 0;
    });
    return !!res;
  } catch (err) {
    return false;
  }
}

// ========== FIM DOS GUARDRAILS E FUNÇÕES NOVAS ==========

// ========== INÍCIO DA FUNÇÃO sendMessageSafe ==========
async function sendMessageSafe(p, campo, msg, nome, chatId) {
  // 0) Reobtenha o composer se campo for ausente ou suspeito
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

  // Verificar contexto antes de digitar
  if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
    await logIssue(nome, 'mil_action', `virtus_context_abort: before_type (chat ${chatId})`);
    return;
  }

  const ctrlKey = (process.platform === 'darwin') ? 'Meta' : 'Control';

  setVirtusInputLock(nome, true);
  try {
    // Foco real no composer
    await campo.click({ delay: 20 }).catch(()=>{});
    // Limpeza: Select All + Backspace/Delete
    try {
      await p.keyboard.down(ctrlKey);
      await p.keyboard.press('KeyA');
      await p.keyboard.up(ctrlKey);
    } catch {}
    try { await p.keyboard.press('Backspace'); } catch {}
    try { await p.keyboard.press('Delete'); } catch {}
    // Aguarda esvaziar (tolerante)
    await p.waitForFunction(
      el => ((el.innerText || el.textContent || '').trim().length === 0),
      { timeout: 1200 },
      campo
    ).catch(()=>{});

    // Digita com atraso humano por caractere para reduzir assinatura robótica
    const typingDelayMs = randomBetween(VIRTUS_TYPE_DELAY_MIN_MS, VIRTUS_TYPE_DELAY_MAX_MS);
    await p.keyboard.type(String(msg || ''), { delay: typingDelayMs });

    // Revalidar contexto antes do Enter
    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(p, campo);
      await logIssue(nome, 'mil_action', `virtus_context_abort: before_enter (chat ${chatId})`);
      return;
    }

    // Pausa curta antes do Enter para humanização do envio
    await sleep(randomBetween(VIRTUS_ENTER_AFTER_TYPE_MIN_MS, VIRTUS_ENTER_AFTER_TYPE_MAX_MS));

    // Envia (um único Enter)
    await p.keyboard.press('Enter');

    // Aguarda confirmação: bolha “Você enviou” ou composer vazio
    const sent = await Promise.race([
      (async () => {
        try {
          return await p.waitForFunction(() => {
            const norm = s => String(s||'').toLowerCase();
            const nodes = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-25);
            return nodes.some(el => /you\s+sent|v[ou]c[eê]\s+enviou/.test(norm(el.innerText||el.textContent||'')));
          }, { timeout: VIRTUS_SEND_CONFIRM_TIMEOUT_MS }).then(()=>true).catch(()=>false);
        } catch { return false; }
      })(),
      (async () => {
        try {
          return await p.waitForFunction((el) => ((el.innerText || el.textContent || '').trim().length === 0), { timeout: VIRTUS_SEND_CONFIRM_TIMEOUT_MS }, campo)
            .then(()=>true).catch(()=>false);
        } catch { return false; }
      })()
    ]);

    if (!sent) {
      await logIssue(nome, 'virtus_send_failed', 'send_confirmation_timeout (no re-enter)');
    }

  } finally {
    setVirtusInputLock(nome, false);
  }
}
// ========== FIM DA FUNÇÃO sendMessageSafe ==========

async function sendMessageDirectIfFocused(p, msg, nome, chatId) {
  setVirtusInputLock(nome, true);
  const directMarker = `virtus_direct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  try {
    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) return false;
    const focusReady = await p.evaluate((marker) => {
      try {
        const ae = document.activeElement;
        if (!ae || !ae.getAttribute) return false;
        const ce = String(ae.getAttribute('contenteditable') || '').toLowerCase();
        const role = String(ae.getAttribute('role') || '').toLowerCase();
        const ok = (ce === 'true' || ce === 'plaintext-only') && role === 'textbox';
        if (!ok) return false;
        try { ae.setAttribute('data-virtus-direct-marker', String(marker || '')); } catch {}
        return true;
      } catch { return false; }
    }, directMarker).catch(() => false);
    if (!focusReady) return false;

    const typingDelayMs = randomBetween(VIRTUS_TYPE_DELAY_MIN_MS, VIRTUS_TYPE_DELAY_MAX_MS);
    await p.keyboard.type(String(msg || ''), { delay: typingDelayMs });
    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) return false;
    await sleep(randomBetween(VIRTUS_ENTER_AFTER_TYPE_MIN_MS, VIRTUS_ENTER_AFTER_TYPE_MAX_MS));
    await p.keyboard.press('Enter');

    const sent = await Promise.race([
      p.waitForFunction(() => {
        try {
          const norm = (s) => String(s || '').toLowerCase();
          const nodes = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-25);
          return nodes.some((el) => /you\s+sent|v[ou]c[eê]\s+enviou/.test(norm(el.innerText || el.textContent || '')));
        } catch { return false; }
      }, { timeout: VIRTUS_SEND_CONFIRM_TIMEOUT_MS }).then(() => true).catch(() => false),
      p.waitForFunction((marker) => {
        try {
          const sel = `[data-virtus-direct-marker="${String(marker || '').replace(/"/g, '\\"')}"]`;
          const el = document.querySelector(sel);
          if (!el) return false;
          const txt = (el.innerText || el.textContent || '').trim();
          return txt.length === 0;
        } catch { return false; }
      }, { timeout: VIRTUS_SEND_CONFIRM_TIMEOUT_MS }, directMarker).then(() => true).catch(() => false)
    ]);

    if (!sent) {
      await logIssue(nome, 'virtus_send_failed', 'send_confirmation_timeout_direct');
      return false;
    }
    return true;
  } finally {
    try {
      await p.evaluate((marker) => {
        try {
          const sel = `[data-virtus-direct-marker="${String(marker || '').replace(/"/g, '\\"')}"]`;
          const el = document.querySelector(sel);
          if (el) el.removeAttribute('data-virtus-direct-marker');
        } catch {}
      }, directMarker).catch(() => {});
    } catch {}
    setVirtusInputLock(nome, false);
  }
}

async function startVirtus(browser, nome, robeMeta = {}) {
  // Na primeira linha dentro de startVirtus, após argumentos:
  let requiredEpoch = 0;
  if (arguments.length >= 3 && arguments[2] && arguments[2].epoch != null) {
    requiredEpoch = arguments[2].epoch;
  }
  const cfg = (arguments.length >= 3 && arguments[2] && typeof arguments[2] === 'object') ? arguments[2] : {};
  const slowMode = !!cfg.slowMode;
  // Broker fence: sempre leia do browser._fenceEpochMap
  function epochOk() {
    try {
      if (browser && browser._fenceEpochMap && typeof browser._fenceEpochMap[nome] !== "undefined") {
        return browser._fenceEpochMap[nome] === requiredEpoch;
      }
      // Compat: se não definido, considera ok
      return true;
    } catch { return false; }
  }

  const attId = stepLog.attemptId();
  stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'start' });

  // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 1 ==========
  // Checagem ultra robusta de freezer
  let manifestFrozenUntil = 0;
  try {
    const manifest = await manifestStore.read(nome);
    manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
  } catch {}
  if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
    const log = (...args) => logger.info(args.join(' '), { nome });
    log(`[VIRTUS][${nome}] virtus_skip_frozen — perfil congelado até ${new Date(manifestFrozenUntil).toISOString()}`);
    if (issues) try { await logIssue(nome, 'virtus_skip_frozen', `perfil congelado até ${new Date(manifestFrozenUntil).toISOString()}`); } catch {}
    return { stop: async () => {} }; // Virtus runner no-op
  }
  // ========== FIM BLOCO FREEZER INSTRUÇÃO 1 ==========

  const log = (...args) => logger.info(args.join(' '), { nome });

  let running = true;
  let page = null;
  let fila = [];
  let historico = {};
  let chatAtivo = null;
  const replyRetryReasonByChat = new Map();
  const replyScheduleMetaByChat = new Map();

  const HIST_FILE = HIST_JSON_NAME(nome);
  const NO_REPEAT_WINDOW_SEC = 72 * 3600; // 72h de bloqueio hardcoded para blindagem absoluta antiflood
  const fastMode = VIRTUS_FAST_MODE && !slowMode;
  const POLL_INTERVAL_MS = Math.max(
    fastMode ? 5_000 : 15_000,
    Number(process.env.VIRTUS_POLL_INTERVAL_MS || (fastMode ? 9_000 : (slowMode ? 45_000 : 30_000))) || (fastMode ? 9_000 : (slowMode ? 45_000 : 30_000))
  );
  const MIN_REPLY_DELAY_MS = Math.max(
    fastMode ? 2_000 : 8_000,
    Number(process.env.VIRTUS_MIN_REPLY_DELAY_MS || (fastMode ? 4_500 : (slowMode ? 80_000 : 60_000))) || (fastMode ? 4_500 : (slowMode ? 80_000 : 60_000))
  );
  const MAX_REPLY_DELAY_MS = Math.max(
    MIN_REPLY_DELAY_MS,
    Number(process.env.VIRTUS_MAX_REPLY_DELAY_MS || (fastMode ? 9_000 : (slowMode ? 150_000 : 120_000))) || (fastMode ? 9_000 : (slowMode ? 150_000 : 120_000))
  );
  const RETRY_REPLY_DELAY_MS = Math.max(
    2_000,
    Number(process.env.VIRTUS_REPLY_RETRY_DELAY_MS || 3_000) || 3_000
  );
  const SCROLL_TOP_INTERVAL_MS = Math.max(
    120_000,
    Number(process.env.VIRTUS_SCROLL_TOP_INTERVAL_MS || (slowMode ? 8 * 60 * 1000 : 5 * 60 * 1000)) || (slowMode ? 8 * 60 * 1000 : 5 * 60 * 1000)
  );
  const SCROLL_TOP_IDLE_MIN_GAP_MS = Math.max(
    120_000,
    Number(process.env.VIRTUS_SCROLL_TOP_IDLE_MIN_GAP_MS || (10 * 60 * 1000)) || (10 * 60 * 1000)
  );
  const KEEPALIVE_MIN_GAP_MS = Math.max(
    60_000,
    Number(process.env.VIRTUS_KEEPALIVE_MIN_GAP_MS || (5 * 60 * 1000)) || (5 * 60 * 1000)
  );

  // cache em memória e timers
  const RESP_CACHE_MAX = 5000;
  let respCacheMaxDynamic = RESP_CACHE_MAX;
  function setResponded(id, ts) {
    if (!respondedCache.has(id) && respondedCache.size >= respCacheMaxDynamic) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
    }
    respondedCache.set(id, ts);
  }
  const respondedCache = new Map();

  // MILITAR: Timers unificados
  let filaInterval = null;
  let filaChatTimer = null;
  let scrollInterval = null; // Militar: cleaning interval to prevent interval leak

  let lastScrollToTop = 0;
  let lastKeepaliveAt = 0;
  let lastReplyAtMs = Date.now();
  let lastHeavyActionAt = 0;
  let lastMarketplaceEnsureAt = 0;
  let lastMarketplaceEnsureResult = false;
  let lastMarketplaceNoMenuAt = 0;
  let lastMarketplaceNoMenuLogAt = 0;
  let repliesSinceRecycle = 0;
  const heavyActionTimes = [];
  const MARKETPLACE_ENSURE_MIN_GAP_MS = Math.max(
    12_000,
    Number(process.env.VIRTUS_MARKETPLACE_ENSURE_MIN_GAP_MS || 30_000) || 30_000
  );
  const MARKETPLACE_MENU_ABSENT_RECHECK_MS = Math.max(
    45_000,
    Number(process.env.VIRTUS_MARKETPLACE_MENU_ABSENT_RECHECK_MS || 180_000) || 180_000
  );
  const MARKETPLACE_MENU_ABSENT_LOG_THROTTLE_MS = Math.max(
    30_000,
    Number(process.env.VIRTUS_MARKETPLACE_MENU_ABSENT_LOG_THROTTLE_MS || 300_000) || 300_000
  );

  // trackers
  let saveChain = Promise.resolve();
  let filaLoopBusy = false;
  let recoverBackoffMs = 0;
  const failCounts = new Map();
  const FAIL_COUNTS_MAX = 1000;
  let failCountsMaxDynamic = FAIL_COUNTS_MAX;
  let lastPageRecycleAt = 0;
  let lastPageRecycleMeta = null;
  let lastPressureModeLogAt = 0;
  // Limpeza/cap failCounts
  function setFailCount(chatId, n) {
    if (!failCounts.has(chatId) && failCounts.size >= failCountsMaxDynamic) {
      const first = failCounts.keys().next().value;
      if (first !== undefined) failCounts.delete(first);
    }
    failCounts.set(chatId, n);
  }
  function trimMapOldest(mapRef, maxSize) {
    let removed = 0;
    const target = Math.max(0, Number(maxSize || 0));
    while (mapRef && mapRef.size > target) {
      const first = mapRef.keys().next().value;
      if (first === undefined) break;
      mapRef.delete(first);
      removed += 1;
    }
    return removed;
  }
  function tryAcquireGlobalRecycle(nome, nowMs) {
    try {
      const owner = String(__virtusGlobalRecycle.owner || '');
      const acquiredAt = Number(__virtusGlobalRecycle.acquiredAt || 0);
      const lockExpired = !owner || ((nowMs - acquiredAt) > VIRTUS_RECYCLE_LOCK_TTL_MS);
      if (!lockExpired && owner && owner !== String(nome || '')) {
        return { ok: false, reason: 'locked', owner };
      }
      const sinceLast = nowMs - Number(__virtusGlobalRecycle.lastReleaseAt || 0);
      if (sinceLast < VIRTUS_RECYCLE_GLOBAL_GAP_MS) {
        return { ok: false, reason: 'gap', waitMs: VIRTUS_RECYCLE_GLOBAL_GAP_MS - sinceLast };
      }
      __virtusGlobalRecycle.owner = String(nome || '');
      __virtusGlobalRecycle.acquiredAt = nowMs;
      return { ok: true };
    } catch {
      return { ok: false, reason: 'exception' };
    }
  }
  function releaseGlobalRecycle(nome) {
    try {
      if (String(__virtusGlobalRecycle.owner || '') === String(nome || '')) {
        __virtusGlobalRecycle.owner = '';
        __virtusGlobalRecycle.acquiredAt = 0;
        __virtusGlobalRecycle.lastReleaseAt = Date.now();
      }
    } catch {}
  }

  function pruneHeavyActionWindow(nowMs) {
    const now = Number(nowMs || Date.now()) || Date.now();
    while (heavyActionTimes.length && (now - Number(heavyActionTimes[0] || 0)) > VIRTUS_HEAVY_ACTION_WINDOW_MS) {
      heavyActionTimes.shift();
    }
  }

  function canRunHeavyAction(nowMs) {
    const now = Number(nowMs || Date.now()) || Date.now();
    pruneHeavyActionWindow(now);
    if (lastHeavyActionAt > 0 && (now - lastHeavyActionAt) < VIRTUS_HEAVY_ACTION_MIN_GAP_MS) {
      return { ok: false, reason: 'min_gap', waitMs: VIRTUS_HEAVY_ACTION_MIN_GAP_MS - (now - lastHeavyActionAt), count: heavyActionTimes.length };
    }
    if (heavyActionTimes.length >= VIRTUS_HEAVY_ACTION_MAX_PER_WINDOW) {
      const oldest = Number(heavyActionTimes[0] || 0) || now;
      const waitMs = Math.max(0, VIRTUS_HEAVY_ACTION_WINDOW_MS - (now - oldest));
      return { ok: false, reason: 'window_budget', waitMs, count: heavyActionTimes.length };
    }
    return { ok: true, reason: 'ok', waitMs: 0, count: heavyActionTimes.length };
  }

  function markHeavyAction(nowMs) {
    const now = Number(nowMs || Date.now()) || Date.now();
    lastHeavyActionAt = now;
    heavyActionTimes.push(now);
    pruneHeavyActionWindow(now);
  }

  function getIdleMode(nowMs) {
    const now = Number(nowMs || Date.now()) || Date.now();
    if (chatAtivo || (Array.isArray(fila) && fila.length > 0)) return 'active';
    const idleForMs = Math.max(0, now - Number(lastReplyAtMs || 0));
    if (idleForMs >= VIRTUS_IDLE_DEEP_MS) return 'deep_idle';
    if (idleForMs >= VIRTUS_IDLE_COLD_MS) return 'cold_idle';
    return 'warm_idle';
  }

  async function ensureMarketplaceCalmo(p, { timeoutMs = 25000, force = false, reason = 'default' } = {}) {
    const now = Date.now();
    if (!force && (now - Number(lastMarketplaceEnsureAt || 0)) < MARKETPLACE_ENSURE_MIN_GAP_MS) {
      return !!lastMarketplaceEnsureResult;
    }
    const idleSafe = !chatAtivo && (!Array.isArray(fila) || fila.length === 0) && !isVirtusLocked(nome);
    if (!force && idleSafe) {
      if (!lastMarketplaceEnsureResult && (now - Number(lastMarketplaceNoMenuAt || 0)) < MARKETPLACE_MENU_ABSENT_RECHECK_MS) {
        return false;
      }
    }
    const ok = await garantirMarketplace(p, { timeoutMs });
    lastMarketplaceEnsureAt = Date.now();
    lastMarketplaceEnsureResult = !!ok;
    if (!ok) lastMarketplaceNoMenuAt = lastMarketplaceEnsureAt;
    if (VIRTUS_DETAILED_DEBUG) {
      logger.info('[VIRTUS] ensureMarketplaceCalmo', {
        nome,
        reason,
        ok: !!ok,
        force: !!force,
        idleSafe,
        cooldownMs: MARKETPLACE_ENSURE_MIN_GAP_MS
      });
    }
    return !!ok;
  }

  // Persistência segura no Windows
  async function salvaHistorico() {
    saveChain = saveChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(HIST_FILE), { recursive: true });
        const tmp = HIST_FILE + '.tmp';
        const fd = await fs.open(tmp, 'w');
        try {
          await fd.writeFile(JSON.stringify(historico, null, 2), 'utf8');
          await fd.sync();
        } finally { await fd.close(); }
        try { await fs.unlink(HIST_FILE); } catch {}
        try { await fs.rename(tmp, HIST_FILE); }
        catch { await fs.copyFile(tmp, HIST_FILE); try { await fs.unlink(tmp); } catch {} }
      } catch (e) {
        logger.error('Erro ao salvar histórico Virtus', { nome }, e);
      }
    }).catch(err => logger.error('Erro em cadeia de salvamento Virtus', { nome }, err));
    return saveChain;
  }

  async function carregaHistorico() {
    try {
      // Fallback .tmp órfão
      const tmp = HIST_FILE + '.tmp';
      try { await fs.access(HIST_FILE); }
      catch {
        if (await fs.access(tmp).then(()=>true).catch(()=>false)) {
          try { await fs.rename(tmp, HIST_FILE); }
          catch { await fs.copyFile(tmp, HIST_FILE); try { await fs.unlink(tmp);} catch{} }
        }
      }
      const txt = await fs.readFile(HIST_FILE, 'utf-8');
      historico = JSON.parse(txt);
    } catch {
      historico = {};
    }
    respondedCache.clear();
    const agora = agoraEpoch();
    for (const id of Object.keys(historico)) {
      const ts = Number(historico[id]) || 0;
      if (ts && (agora - ts) < NO_REPEAT_WINDOW_SEC) {
        setResponded(id, ts);
      }
    }
  }

  function limpaHistoricoVelho() {
    let mudanca = false;
    const agora = agoraEpoch();
    let removed = 0;
    Object.keys(historico).forEach(id => {
      const ts = Number(historico[id]) || 0;
      if (!ts || (agora - ts) >= NO_REPEAT_WINDOW_SEC) {
        delete historico[id];
        respondedCache.delete(id);
        removed += 1;
        mudanca = true;
        log(`Histórico limpo: ${id} removido (>24h)`);
      }
    });
    // Garantir cap adicional do respondedCache
    while (respondedCache.size > respCacheMaxDynamic) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
      mudanca = true;
    }
    return mudanca;
  }

  let ensurePagePromise = null;
  let lastDeadLogAt = 0;

  async function ensurePage() {
    if (!running || !epochOk()) return null;
    if (ensurePagePromise) {
      try { return await ensurePagePromise; } catch { return null; }
    }
    ensurePagePromise = (async () => {
      if (!running || !epochOk()) return null;
      if (!browser || (browser.isConnected && browser.isConnected() === false)) {
        const now = Date.now();
        if (!virtusDeadLogTimes[nome] || now - virtusDeadLogTimes[nome] > 60000) {
          virtusDeadLogTimes[nome] = now;
          logger.warn('Browser morto, não é possível garantir page', { nome });
          if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
        }
        return null;
      }
      try {
        let pages = await browser.pages();
        if (pages && pages[0]) {
          page = pages[0];
          if (page && typeof page.isClosed === 'function' && page.isClosed()) {
            page = null;
          }
        }
        // HARD GUARD: nunca feche abas durante o ciclo do Robe desta conta
        try {
          if (browser && browser._robeActiveFor === nome) {
            // Em ciclo de postagem — não tocar em abas
          } else {
            const allPages = await browser.pages();
            if (Array.isArray(allPages) && allPages.length > 1) {
              for (let i = allPages.length - 1; i >= 1; i--) {
                let u = '';
                try { u = await allPages[i].url(); } catch {}
                if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue; // NUNCA fechar create item
                try { await allPages[i].close({ runBeforeUnload:false }).catch(()=>{}); } catch {}
              }
            }
          }
        } catch {}
        if (!page) {
          if (!running || !epochOk()) return null;
          // cria nova aba
          const newP = await browser.newPage();
          try {
            const manifest = await manifestStore.read(nome);
            const coords = utils.getCoords((manifest && manifest.cidade) ? manifest.cidade : '');
            if (!running || !epochOk()) return null;
            await patchPage(nome, newP, coords);
            if (!running || !epochOk()) return null;
            await ensureMinimizedWindowForPage(newP);
          } catch (e) {
            logger.warn('ensurePage: falha patchPage/minimize na nova aba', { nome }, e);
          }
          try { newP.once && newP.once('close', () => { if (page === newP) page = null; }); } catch {}
          page = newP;
        }
        if (!running || !epochOk()) return null;
        if (!browser || (browser.isConnected && browser.isConnected() === false)) return null;
        if (page && typeof page.isClosed === 'function' && page.isClosed()) return null;

        try { page.removeAllListeners('dialog'); } catch {}
        try {
          page.on('dialog', async (dlg) => {
            try {
              const t = dlg.type && dlg.type();
              const m = (dlg.message && dlg.message()) || '';
              if (t === 'beforeunload' || /recarregar|atualizar|leave this page|continuar/i.test(m)) {
                await dlg.accept().catch(()=>{});
                stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'beforeunload_accept' });
              } else {
                await dlg.dismiss().catch(()=>{});
              }
            } catch {}
          });
        } catch {}

        return page;
      } catch (e) {
        logger.error('ensurePage falhou', { nome }, e);
        return null;
      }
    })();
    try { return await ensurePagePromise; }
    finally { ensurePagePromise = null; }
  }

  function bumpRecoverBackoff() {
    recoverBackoffMs = Math.min(32000, (recoverBackoffMs || 1000) * 2); // Backoff exponencial até 32s
  }
  function resetRecoverBackoff() {
    recoverBackoffMs = 0;
  }

  const COMPOSER_SELECTORS = [
    'div[contenteditable="true"][role="textbox"][aria-label="Mensagem"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"][aria-placeholder="Aa"][data-lexical-editor="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][aria-label]',
    'div[contenteditable="true"]',
    'div[role="combobox"][contenteditable="true"]',
    'div[aria-label="Mensagem"]',
    'div[aria-label*="mensagem"]'
  ];

  const CHAT_BLOCKED_PATTERNS = [
    /vo[cç]e\s+n[aã]o\s+pode\s+enviar\s+mensagens/i,
    /mensagem\s+indispon[íi]vel/i,
    /vo[cç]e\s+n[aã]o\s+est[aá]\s+mais\s+neste\s+grupo/i,
    /vo[cç]e\s+saiu\s+do\s+grupo/i,
    /you\s+can[’']?t\s+send\s+messages/i,
    /message\s+unavailable/i
  ];
  const CHAT_BLOCKED_ALERT_SELECTOR = 'div[role="alert"]';

  async function isChatBlocked(p) {
    try {
      const alertExists = await p.$(CHAT_BLOCKED_ALERT_SELECTOR);
      if (alertExists) {
        const txt = await p.evaluate(el => (el.innerText || el.textContent || '').trim(), alertExists);
        if (txt && CHAT_BLOCKED_PATTERNS.some(rx => rx.test(txt))) return true;
      }
      // Evita varredura pesada do DOM (Messenger é gigante e isso custava muito em VM lenta).
      const txts = await p.$$eval(
        'div[role="alert"], [role="alert"] span, [aria-live="polite"], [aria-live="assertive"]',
        els => els.slice(0, 60).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean)
      ).catch(() => []);
      for (const t of (txts || [])) {
        if (CHAT_BLOCKED_PATTERNS.some(rx => rx.test(t))) return true;
      }
    } catch {}
    return false;
  }

  async function waitForComposer(p, timeoutMs = 10000) {
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

  async function evalWithTimeout(p, fn, arg, timeoutMs = 2800) {
    const evalStart = Date.now();
    const exec = (typeof arg === 'undefined') ? p.evaluate(fn) : p.evaluate(fn, arg);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`eval_timeout_${timeoutMs}`)), Math.max(500, Number(timeoutMs || 0)));
    });
    try {
      const value = await Promise.race([exec, timeoutPromise]);
      return { ok: true, value, durMs: Date.now() - evalStart, error: null };
    } catch (err) {
      return {
        ok: false,
        value: null,
        durMs: Date.now() - evalStart,
        error: String((err && err.message) || err || 'eval_error').slice(0, 160)
      };
    }
  }

  function incFail(chatId) {
    const n = (failCounts.get(chatId) || 0) + 1;
    setFailCount(chatId, n);
    return n;
  }
  function resetFail(chatId) {
    failCounts.delete(chatId);
  }

  async function coletaChatsMarketplaceRecentes() {
    try {
      if (!running || !epochOk()) return [];
      let p = await ensurePage();
      if (!p) return [];
      try {
        if (!running || !epochOk()) return [];
        const marketReady = await ensureMarketplaceCalmo(p, { timeoutMs: 25000, force: false, reason: 'coleta_chats' });
        if (!marketReady) {
          const nowLog = Date.now();
          if (!lastMarketplaceNoMenuLogAt || (nowLog - lastMarketplaceNoMenuLogAt) >= MARKETPLACE_MENU_ABSENT_LOG_THROTTLE_MS) {
            lastMarketplaceNoMenuLogAt = nowLog;
            logger.info('[VIRTUS] Marketplace ainda não disponível para esta conta (menu ausente).', { nome });
          }
          await sleep(5000);
          return [];
        }
      } catch (err) {
        logger.warn('Não está no Marketplace ou erro ao garantir Marketplace', { nome }, err);
        await sleep(5000);
        return [];
      }
      try {
        await Promise.race([
          p.waitForSelector('a[href*="/marketplace/t/"], a[href*="/messages/t/"]', { timeout: 4000 }),
          p.waitForSelector('div[role="row"] span', { timeout: 4000 }),
        ]);
      } catch {}
      const todos = await coletaChatsMarketplaceTodos(p);
      const filtrados = todos.filter(c => c.id && isChatRecente(c.tempo));
      return filtrados;
    } catch (err) {
      logger.error('Erro ao coletar chats', { nome }, err);
      return [];
    }
  }

  // Reconciliação de pendências
  async function reconcilePendingsIfAny() {
    if (!running || !epochOk()) return;
    try {
      const pend = await pendingList(nome);
      const keys = Object.keys(pend||{});
      if (!keys.length) return;
      const p = await ensurePage();
      if (!p) return;
      for (const chatId of keys) {
        const rec = pend[chatId] || {};
        const age = Date.now() - (rec.startedAt || 0);
        if (age < 8*60*1000) continue; // deixa “aquecendo” 8min antes de reconciliar
        try {
          if (!running || !epochOk()) return;
          // Política anti-cutucada: não faz navegação direta por URL de chat em reconciliação.
          // Se o pending envelheceu, libera para reprocessamento normal pela fila.
          await pendingDel(nome, chatId);
          try { await logIssue(nome, 'mil_action', `virtus_pending_reconcile_release_no_goto: chat ${chatId} ageMs=${age}`); } catch {}
        } catch { /* segue próximo */ }
      }
    } catch {}
  }

  async function initHistoricoSePreciso() {
    if (!running || !epochOk()) return;
    try {
      await fs.access(HIST_FILE);
      await carregaHistorico();
      await reconcilePendingsIfAny();
      log('Histórico existente carregado. Retomando pendentes <8h.');
      return;
    } catch {}

    log('[SNAPSHOT] Primeiro boot sem histórico. Marcando <8h atuais como respondidos.');
    if (!running || !epochOk()) return;
    const p = await ensurePage();
    if (!p) { log('[SNAPSHOT] Falha ao garantir aba zero.'); return; }
    if (!running || !epochOk()) return;
    const marketReady = await ensureMarketplaceCalmo(p, { timeoutMs: 25000, force: true, reason: 'init_historico' });
    if (!marketReady) {
      historico = {};
      await salvaHistorico();
      await carregaHistorico();
      await reconcilePendingsIfAny();
      log('[SNAPSHOT] Marketplace sem menu disponível (conta nova/sem chats de marketplace). Snapshot inicial vazio aplicado.');
      return;
    }
    try {
      await Promise.race([
        p.waitForSelector('a[href*="/marketplace/t/"], a[href*="/messages/t/"]', { timeout: 8000 }),
        p.waitForSelector('div[role="row"] span', { timeout: 8000 })
      ]);
    } catch {}
    try { await scrollListaAte8h(p, { maxMs: 90000, quietLoops: 3 }); } catch {} // NOVO: Usa scrollListaAte8h
    const todos = await coletaChatsMarketplaceTodos(p);
    const recentes = todos.filter(c => isChatRecente(c.tempo));
    const agora = agoraEpoch();
    historico = {};
    for (const chat of recentes) historico[chat.id] = agora;
    await salvaHistorico();
    await carregaHistorico();
    await reconcilePendingsIfAny();
    log(`[SNAPSHOT] Concluído. ${recentes.length} chats <8h marcados como respondidos no primeiro boot.`);
  }

  // NOVO: Reduzido de 24h para 8h (menos scroll = menos RAM consumida)
  async function scrollListaAte8h(page, { maxMs = 90000, quietLoops = 3 } = {}) {
    const t0 = Date.now();
    let semNovos = 0;
    let vistos = new Set();

    while ((Date.now() - t0) < maxMs) {
      const todos = await coletaChatsMarketplaceTodos(page);
      let houveNovo = false, viuAntigo = false;
      for (const c of todos) {
        if (!vistos.has(c.id)) { vistos.add(c.id); houveNovo = true; }
        if (isVelho8h(c.tempo)) viuAntigo = true; // NOVO: Usa isVelho8h
      }
      if (viuAntigo) break;
      if (!houveNovo) {
        semNovos += 1;
        if (semNovos >= quietLoops) break;
      } else {
        semNovos = 0;
      }
      try {
        const contSel = await page.evaluate(() => {
          const cands = ['div[role="grid"]','div[role="rowgroup"]','div.x78zum5.xdt5ytf'];
          for (const sel of cands) {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight) return sel;
          }
          return 'body';
        });
        await page.evaluate((selector) => {
          const el = document.querySelector(selector) || document.scrollingElement || document.body;
          el.scrollTop = el.scrollHeight;
        }, contSel);
      } catch {
        try { await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight * 0.8))); } catch {}
      }
      await sleep(800 + Math.floor(Math.random() * 500));
    }
    return Array.from(vistos);
  }

  async function atualizaFila() {
    let mudancaFila = false;
    // Debug seed (opt-in): injeta chat(s) de chats_pending.json com startedAt=0 direto na fila.
    // Uso: laboratório / teste controlado sem depender de "chat recente".
    if (String(process.env.VIRTUS_ALLOW_PENDING_SEED || '0').trim() === '1') {
      try {
        const pend = await pendingList(nome);
        const agoraSeed = agoraEpoch();
        let changed = false;
        for (const [chatId, rec] of Object.entries(pend || {})) {
          if (!chatId) continue;
          if (!rec || Number(rec.startedAt || 0) !== 0) continue;
          const ts = respondedCache.get(chatId) || Number(historico[chatId] || 0);
          const jaRespondido = ts && (agoraSeed - ts) < NO_REPEAT_WINDOW_SEC;
          if (!jaRespondido && !fila.includes(chatId)) {
            fila.push(chatId);
            mudancaFila = true;
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'virtus_seed_enqueue',
                nome: String(nome || ''),
                chatId: String(chatId || '').slice(0, 80)
              });
            } catch {}
          }
          pend[chatId] = { ...(rec || {}), startedAt: Date.now() };
          changed = true;
        }
        if (changed) {
          await writeJsonAtomicFsync(PENDING_JSON_NAME(nome), pend);
        }
      } catch {}
    }
    const chatsNovos = await coletaChatsMarketplaceRecentes();
    let novosAti = 0;
    const agora = agoraEpoch();

    chatsNovos.forEach(c => {
      const ts = respondedCache.get(c.id) || Number(historico[c.id] || 0);
      const jaRespondido = ts && (agora - ts) < NO_REPEAT_WINDOW_SEC;
      if (!jaRespondido && !fila.includes(c.id)) {
        fila.push(c.id);
        novosAti++;
        log(`NOVO chat em Fila: ${c.id} (${c.tempo})`);
      }
    });

    const filaAnt = fila.slice(0);
    fila = fila.filter(id => {
      const ts = respondedCache.get(id) || Number(historico[id] || 0);
      return !(ts && (agora - ts) < NO_REPEAT_WINDOW_SEC);
    });
    filaAnt.forEach(id => {
      const ts = respondedCache.get(id);
      if (ts && (agora - ts) < NO_REPEAT_WINDOW_SEC) {
        log(`[FILA] Chat ${id} removido da fila (já respondido <8h)`);
        mudancaFila = true;
      }
    });

    if (novosAti > 0) {
      log(`[FILA] Atualizada: ${fila.length} chats pendentes para resposta.`);
      mudancaFila = true;
    }
    return mudancaFila;
  }

  function scheduleNextIfIdle() {
    if (!running) return;
    if (chatAtivo) return;
    if (filaChatTimer) return;
    if (!fila.length) {
      if (replyRetryReasonByChat.size > 0) replyRetryReasonByChat.clear();
      if (replyScheduleMetaByChat.size > 0) replyScheduleMetaByChat.clear();
      return;
    }

    const next = fila[0];
    const retryReason = replyRetryReasonByChat.get(next);
    const delay = retryReason ? RETRY_REPLY_DELAY_MS : randomBetween(MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS);
    const now = Date.now();
    const dueAt = now + delay;
    replyScheduleMetaByChat.set(next, { scheduledAt: now, dueAt, delay, retryReason: retryReason || null });
    try {
      provisionAudit.append({
        ts: now,
        event: 'virtus_reply_scheduled',
        nome: String(nome || ''),
        chatId: String(next || '').slice(0, 80),
        delayMs: Number(delay || 0),
        dueAt,
        retryReason: retryReason || null,
        queueLen: Number(fila.length || 0)
      });
    } catch {}
    if (retryReason) {
      replyRetryReasonByChat.delete(next);
      log(`[FILA] Retry chat ${next} em ${Math.round(delay/1000)}s (${retryReason})`);
    } else {
      log(`[FILA] Atendendo chat ${next} em ${Math.round(delay/1000)}s`);
    }
    filaChatTimer = setTimeout(async () => {
      if (!running || !epochOk()) return;
      const firedAt = Date.now();
      const sched = replyScheduleMetaByChat.get(next) || null;
      replyScheduleMetaByChat.delete(next);
      const timerDriftMs = (sched && Number(sched.dueAt || 0) > 0) ? (firedAt - Number(sched.dueAt || 0)) : null;
      stepLog.appendJSONL(nome, 'virtus', {
        attempt: attId,
        step: 'schedule_reply',
        chatId: next,
        in: delay,
        scheduledAt: sched ? Number(sched.scheduledAt || 0) : null,
        dueAt: sched ? Number(sched.dueAt || 0) : null,
        firedAt,
        timerDriftMs: (typeof timerDriftMs === 'number') ? Number(timerDriftMs) : null,
        retryReason: sched ? (sched.retryReason || null) : null
      });
      try {
        provisionAudit.append({
          ts: firedAt,
          event: 'virtus_reply_timer_fired',
          nome: String(nome || ''),
          chatId: String(next || '').slice(0, 80),
          scheduledAt: sched ? Number(sched.scheduledAt || 0) : null,
          dueAt: sched ? Number(sched.dueAt || 0) : null,
          firedAt,
          delayMs: sched ? Number(sched.delay || delay || 0) : Number(delay || 0),
          timerDriftMs: (typeof timerDriftMs === 'number') ? Number(timerDriftMs) : null,
          retryReason: sched ? (sched.retryReason || null) : null
        });
      } catch {}
      filaChatTimer = null;
      await responderChat(next, { scheduleMeta: sched, timerDriftMs });
      scheduleNextIfIdle();
    }, delay);
  }

  async function responderChat(chatId, opts = {}) {
    const tStartMs = Date.now();
    const timerDriftMs = Number(opts && opts.timerDriftMs);
    if (Number.isFinite(timerDriftMs) && timerDriftMs > 2500) {
      logger.warn('[VIRTUS] Timer drift acima do esperado antes de responder chat', {
        nome,
        chatId,
        timerDriftMs
      });
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'virtus_reply_timer_drift_high',
          nome: String(nome || ''),
          chatId: String(chatId || '').slice(0, 80),
          timerDriftMs: Number(timerDriftMs)
        });
      } catch {}
    }
    if (!running || !epochOk()) return;
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    let _chatLockAcquired = false;
    try {
      // === INÍCIO GUARD DE VIDA NO RESPONDERCHAT ===
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] Início responderChat: ${chatId}`); }
      if (!browser || browser.isConnected?.() === false) {
        logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }
      let p = await ensurePage();
      if (!p || (p.isClosed && p.isClosed())) {
        logger.error(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }
      // === FIM GUARD DE VIDA ===
      if (!chatId) return;

      // Lock de disco POR chatId!
      if (!chatLock.acquire(nome, chatId)) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'skip_locked', chatId, attempt: attId });
        // logging adicional de lock fail
        stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_busy', chatId, attempt: attId });
        try { await logIssue(nome, 'chat_lock_busy', `Falha ao adquirir lock para chat ${chatId}`); } catch {}
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }
      _chatLockAcquired = true;
      stepLog.appendJSONL(nome, 'virtus', { step: 'chat_lock_ok', chatId, attempt: attId });

      // Ledger: adiciona pending imediatamente após adquirir lock
      const attemptId2 = stepLog.attemptId();
      try { await pendingAdd(nome, chatId, attemptId2); } catch {}

      chatAtivo = chatId;

      try {
        p = await ensurePage();
        if (!p) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }
        if (!running || !epochOk()) { try { await pendingDel(nome, chatId); } catch {} fila = fila.filter(id => id !== chatId); chatAtivo = null; return; }
        const tsPrev = respondedCache.get(chatId) || Number(historico[chatId] || 0);
        if (tsPrev && (agoraEpoch() - tsPrev) < NO_REPEAT_WINDOW_SEC) {
          log(`[GUARD-ID] Já respondido (ID ${chatId}) <8h. Pulando envio.`);
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'virtus_skip_recently_responded',
              nome: String(nome || ''),
              chatId: String(chatId || '').slice(0, 80),
              tsPrev: Number(tsPrev || 0),
              nowEpoch: Number(agoraEpoch() || 0),
              noRepeatWindowSec: Number(NO_REPEAT_WINDOW_SEC || 0)
            });
          } catch {}
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        let found = null;
        let achou = await assertOnChat(p, chatId, { timeoutMs: 0 });
        let urlAtual = '';
        if (!achou) {
          let preClickCtx = null;
          try {
            preClickCtx = await p.evaluate(() => ({
              href: String(location.href || ''),
              hasMarketplaceMenu: !!document.querySelector('a[href*="/marketplace/"]'),
              hasMessageThreads: Number(document.querySelectorAll('a[href*="/marketplace/t/"], a[href*="/messages/t/"]').length || 0)
            }));
          } catch {}
          // Atendimento é estritamente click-only: não chamar ensureMarketplaceCalmo/goto nesse fluxo.
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'virtus_chat_open_click_only_mode',
              nome: String(nome || ''),
              chatId: String(chatId || '').slice(0, 80)
            });
          } catch {}

          let anchorSel = `a[href*="/marketplace/t/${chatId}"], a[href*="/messages/t/${chatId}"]`;
          await scrollChatsToTop(p, nome).catch(()=>{});
          await sleep(300);
          const pickBestAnchorHandle = async () => {
            const handles = await p.$$(anchorSel).catch(() => []);
            if (!Array.isArray(handles) || !handles.length) return null;

            // Importante: em `facebook.com/messages` há casos com âncoras duplicadas/clonadas (DOM),
            // e várias ficam fora do viewport (x negativo). Para não clicar em "clone invisível",
            // escolhemos o melhor candidato pelo DOM (getBoundingClientRect + estilos + elementFromPoint)
            // e retornamos o handle pelo índice (mesma ordem do querySelectorAll / $$).
            try {
              const pick = await p.evaluate((selector) => {
                try {
                  const els = Array.from(document.querySelectorAll(selector)).slice(0, 160);
                  const vw = Number(window.innerWidth || 1366);
                  const vh = Number(window.innerHeight || 768);
                  let bestIdx = -1;
                  let bestScore = -Infinity;

                  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
                  const normHrefPath = (h) => String(h || '').replace(/^https?:\/\/[^/]+/i, '');

                  for (let i = 0; i < els.length; i++) {
                    const el = els[i];
                    if (!el || !el.isConnected) continue;
                    const cs = window.getComputedStyle(el);
                    if (!cs) continue;
                    if (cs.display === 'none') continue;
                    if (cs.visibility === 'hidden') continue;
                    if (cs.pointerEvents === 'none') continue;
                    const op = Number(cs.opacity || '1');
                    if (!Number.isFinite(op) || op <= 0) continue;

                    const r = el.getBoundingClientRect();
                    if (!r || r.width < 4 || r.height < 4) continue;

                    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
                    const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
                    const visArea = visW * visH;
                    const inView = visArea > 0;

                    const cxRaw = r.left + (r.width / 2);
                    const cyRaw = r.top + (r.height / 2);
                    const cx = clamp(cxRaw, 0, vw - 1);
                    const cy = clamp(cyRaw, 0, vh - 1);
                    const top = document.elementFromPoint(cx, cy);
                    const topAnchor = top && top.closest ? top.closest('a[href]') : null;

                    const href = normHrefPath(el.getAttribute('href') || el.href || '');
                    const topHref = normHrefPath((topAnchor && (topAnchor.getAttribute('href') || topAnchor.href || '')) || '');
                    const topMatches = !!topAnchor && !!href && !!topHref && topHref.includes(href);

                    const centerInViewport = (cxRaw >= 0 && cxRaw <= vw && cyRaw >= 0 && cyRaw <= vh);
                    const distOutside = Math.abs(Math.min(0, r.left)) + Math.abs(Math.min(0, r.top)) + Math.max(0, r.right - vw) + Math.max(0, r.bottom - vh);

                    // Score:
                    // - dá preferência forte para candidato visível e com centro realmente clicável (topMatches)
                    // - penaliza fora do viewport (distOutside), mas ainda escolhe o "menos ruim" se todos estiverem fora
                    let score = 0;
                    score += inView ? (visArea * 10) : -1e9;
                    score += centerInViewport ? 5e6 : 0;
                    score += topMatches ? 5e9 : 0;
                    score -= distOutside * 1000;
                    score -= (Math.abs(r.x) * 10 + Math.abs(r.y));

                    if (score > bestScore) {
                      bestScore = score;
                      bestIdx = i;
                    }
                  }

                  return { bestIdx, count: els.length };
                } catch {
                  return { bestIdx: -1, count: 0 };
                }
              }, anchorSel).catch(() => null);

              if (pick && Number.isFinite(pick.bestIdx) && pick.bestIdx >= 0 && pick.bestIdx < handles.length) {
                return handles[pick.bestIdx] || handles[0] || null;
              }
            } catch {}

            return handles[0] || null;
          };
          try {
            const anchorProbe = await p.evaluate((id) => {
              try {
                const all = Array.from(document.querySelectorAll(`a[href*="/marketplace/t/${id}"], a[href*="/messages/t/${id}"]`));
                const hrefs = all.slice(0, 8).map(a => String((a && (a.getAttribute('href') || a.href || '')) || '').slice(0, 180));
                return { count: all.length, hrefs };
              } catch {
                return { count: 0, hrefs: [] };
              }
            }, chatId).catch(() => ({ count: 0, hrefs: [] }));
            provisionAudit.append({
              ts: Date.now(),
              event: 'virtus_chat_anchor_probe',
              nome: String(nome || ''),
              chatId: String(chatId || '').slice(0, 80),
              count: Number(anchorProbe && anchorProbe.count || 0),
              hrefs: Array.isArray(anchorProbe && anchorProbe.hrefs) ? anchorProbe.hrefs : []
            });
          } catch {}
          try {
            const anchorMetrics = await p.evaluate((id) => {
              try {
                const all = Array.from(document.querySelectorAll(`a[href*="/marketplace/t/${id}"], a[href*="/messages/t/${id}"]`)).slice(0, 12);
                return all.map((a, idx) => {
                  const r = a.getBoundingClientRect();
                  const cs = window.getComputedStyle(a);
                  return {
                    idx,
                    href: String((a.getAttribute('href') || a.href || '')).slice(0, 180),
                    w: Math.round(Number(r.width || 0)),
                    h: Math.round(Number(r.height || 0)),
                    x: Math.round(Number(r.x || 0)),
                    y: Math.round(Number(r.y || 0)),
                    display: String(cs.display || ''),
                    visibility: String(cs.visibility || ''),
                    opacity: String(cs.opacity || ''),
                    pointerEvents: String(cs.pointerEvents || ''),
                    isConnected: !!a.isConnected
                  };
                });
              } catch { return []; }
            }, chatId).catch(() => []);
            provisionAudit.append({
              ts: Date.now(),
              event: 'virtus_chat_anchor_metrics',
              nome: String(nome || ''),
              chatId: String(chatId || '').slice(0, 80),
              anchors: Array.isArray(anchorMetrics) ? anchorMetrics : []
            });
          } catch {}
          found = await pickBestAnchorHandle();
          if (found) {
            try {
              const selected = await found.evaluate((el) => {
                try {
                  const r = el.getBoundingClientRect();
                  const cx = r.left + (r.width / 2);
                  const cy = r.top + (r.height / 2);
                  const top = document.elementFromPoint(cx, cy);
                  const topAnchor = top && top.closest ? top.closest('a[href]') : null;
                  return {
                    href: String((el.getAttribute('href') || el.href || '')).slice(0, 180),
                    x: Math.round(Number(r.x || 0)),
                    y: Math.round(Number(r.y || 0)),
                    w: Math.round(Number(r.width || 0)),
                    h: Math.round(Number(r.height || 0)),
                    topTag: top ? String(top.tagName || '').toLowerCase() : '',
                    topHref: String((topAnchor && (topAnchor.getAttribute('href') || topAnchor.href || '')) || '').slice(0, 180)
                  };
                } catch {
                  return null;
                }
              }).catch(() => null);
              provisionAudit.append({
                ts: Date.now(),
                event: 'virtus_chat_anchor_selected',
                nome: String(nome || ''),
                chatId: String(chatId || '').slice(0, 80),
                selected: selected || null
              });
            } catch {}
          }

          if (!found) {
            logger.warn(`Âncora do chatId ${chatId} não encontrada. Retry curto (click-only).`, { nome, chatId });
            replyRetryReasonByChat.set(chatId, 'chat_anchor_missing');
            try { await pendingDel(nome, chatId); } catch {}
            chatAtivo = null;
            return;
          }

          const openDeadlineAt = Date.now() + VIRTUS_CHAT_OPEN_DEADLINE_MS;
          const clickOrder = VIRTUS_CHAT_OPEN_PRIMARY_MODE === 'dom' ? ['dom', 'mouse'] : ['mouse', 'dom'];
          for (let clickTry = 0; clickTry < 2 && !achou && Date.now() < openDeadlineAt; clickTry++) {
            try {
              await found.evaluate((el) => {
                try { el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }); } catch {}
              });
            } catch {}

            for (const clickMode of clickOrder) {
              if (achou) break;
              if (Date.now() >= openDeadlineAt) break;
              // Re-pick por tentativa/método para reduzir risco de handle stale/off-screen.
              const rePicked = await pickBestAnchorHandle().catch(() => null);
              if (rePicked) found = rePicked;
              try {
                const selectedForClick = await found.evaluate((el) => {
                  try {
                    const r = el.getBoundingClientRect();
                    return {
                      href: String((el.getAttribute('href') || el.href || '')).slice(0, 180),
                      x: Math.round(Number(r.x || 0)),
                      y: Math.round(Number(r.y || 0)),
                      w: Math.round(Number(r.width || 0)),
                      h: Math.round(Number(r.height || 0))
                    };
                  } catch {
                    return null;
                  }
                }).catch(() => null);
                provisionAudit.append({
                  ts: Date.now(),
                  event: 'virtus_chat_anchor_selected_for_click',
                  nome: String(nome || ''),
                  chatId: String(chatId || '').slice(0, 80),
                  clickTry: Number(clickTry + 1),
                  mode: String(clickMode || ''),
                  selected: selectedForClick || null
                });
              } catch {}
              try {
                const clickPreflight = await found.evaluate((el) => {
                  try {
                    const r = el.getBoundingClientRect();
                    const cs = window.getComputedStyle(el);
                    const cx = r.left + (r.width / 2);
                    const cy = r.top + (r.height / 2);
                    const top = document.elementFromPoint(cx, cy);
                    return {
                      href: String((el.getAttribute('href') || el.href || '')).slice(0, 180),
                      w: Math.round(Number(r.width || 0)),
                      h: Math.round(Number(r.height || 0)),
                      x: Math.round(Number(r.x || 0)),
                      y: Math.round(Number(r.y || 0)),
                      display: String(cs.display || ''),
                      visibility: String(cs.visibility || ''),
                      opacity: String(cs.opacity || ''),
                      pointerEvents: String(cs.pointerEvents || ''),
                      topTag: top ? String(top.tagName || '').toLowerCase() : '',
                      topRole: top ? String(top.getAttribute && top.getAttribute('role') || '') : '',
                      topHref: top ? String((top.getAttribute && top.getAttribute('href')) || (top.href || '') || '').slice(0, 180) : ''
                    };
                  } catch {
                    return null;
                  }
                }).catch(() => null);
                provisionAudit.append({
                  ts: Date.now(),
                  event: 'virtus_chat_click_preflight',
                  nome: String(nome || ''),
                  chatId: String(chatId || '').slice(0, 80),
                  clickTry: Number(clickTry + 1),
                  mode: String(clickMode || ''),
                  preflight: clickPreflight || null
                });
              } catch {}
              try {
                if (clickMode === 'dom') {
                  const rowClicked = await found.evaluate((el) => {
                    try {
                      const row = el.closest('div[role="row"]') || el;
                      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                      row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                      row.click();
                      return true;
                    } catch {
                      return false;
                    }
                  }).catch(() => false);
                  if (!rowClicked) {
                    await found.click({ delay: randomBetween(60, 140) }).catch(()=>{});
                  }
                } else {
                  let rowHandle = null;
                  try {
                    rowHandle = await found.evaluateHandle((el) => el.closest('div[role="row"]') || el);
                  } catch {}
                  const box = rowHandle ? await rowHandle.boundingBox().catch(() => null) : await found.boundingBox().catch(() => null);
                  try { if (rowHandle) await rowHandle.dispose(); } catch {}
                  if (box && box.width > 4 && box.height > 4) {
                    const x = box.x + (box.width / 2);
                    const y = box.y + (box.height / 2);
                    await p.mouse.move(x, y, { steps: randomBetween(4, 9) }).catch(()=>{});
                    await p.mouse.click(x, y, { delay: randomBetween(70, 160) }).catch(()=>{});
                  }
                }
              } catch {}
              try {
                provisionAudit.append({
                  ts: Date.now(),
                  event: 'virtus_chat_open_click_attempt',
                  nome: String(nome || ''),
                  chatId: String(chatId || '').slice(0, 80),
                  clickTry: Number(clickTry + 1),
                  mode: String(clickMode || '')
                });
              } catch {}

              await sleep(randomBetween(VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS, VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS));

              let attempts = 0;
              while (attempts < 6 && Date.now() < openDeadlineAt) {
                const urlEval = await evalWithTimeout(p, () => String(location.href || ''), undefined, 3000);
                if (urlEval.ok) {
                  urlAtual = String(urlEval.value || '');
                }
                const inThreadEval = await evalWithTimeout(p, (id) => {
                  try {
                    const href = String(location.href || '');
                    if (href.includes(`/marketplace/t/${id}`) || href.includes(`/messages/t/${id}`)) return true;
                    const rowById = document.querySelector(`a[href*="/marketplace/t/${id}"], a[href*="/messages/t/${id}"]`);
                    if (!rowById) return false;
                    if (rowById.closest('[aria-current="page"], [aria-selected="true"]')) return true;
                    return false;
                  } catch { return false; }
                }, chatId, 3200);
                const inThread = !!inThreadEval.ok && !!inThreadEval.value;
                if (inThread) {
                  achou = true;
                  break;
                }
                await sleep(VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS);
                attempts++;
              }

              try {
                provisionAudit.append({
                  ts: Date.now(),
                  event: 'virtus_chat_open_click_result',
                  nome: String(nome || ''),
                  chatId: String(chatId || '').slice(0, 80),
                  clickTry: Number(clickTry + 1),
                  mode: String(clickMode || ''),
                  ok: !!achou,
                  url: String(urlAtual || '').slice(0, 180)
                });
              } catch {}
              if (!achou) {
                try {
                  const currentHref = await found.evaluate((el) => String((el && (el.getAttribute('href') || el.href || '')) || '').slice(0, 180)).catch(() => '');
                  provisionAudit.append({
                    ts: Date.now(),
                    event: 'virtus_chat_open_click_target_href',
                    nome: String(nome || ''),
                    chatId: String(chatId || '').slice(0, 80),
                    clickTry: Number(clickTry + 1),
                    mode: String(clickMode || ''),
                    targetHref: String(currentHref || '').slice(0, 180)
                  });
                } catch {}
              }
            }

            // Rebusca a âncora antes da próxima tentativa (DOM pode reciclar após render virtualizada).
            if (!achou && clickTry < 1) {
              found = await pickBestAnchorHandle();
              if (!found) break;
            }
          }
          if (!achou && Date.now() < openDeadlineAt) {
            try {
              const forcedSelect = await p.evaluate((id) => {
                const all = Array.from(document.querySelectorAll(`a[href*="/marketplace/t/${id}"], a[href*="/messages/t/${id}"]`)).slice(0, 6);
                if (!all.length) return false;
                for (const a of all) {
                  try {
                    const row = a.closest('div[role="row"]') || a;
                    row.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    row.click();
                  } catch {}
                  try { a.click(); } catch {}
                }
                return true;
              }, chatId).catch(() => false);
              if (forcedSelect) {
                await sleep(1100);
                if (await assertOnChat(p, chatId, { timeoutMs: 2800 })) achou = true;
              }
            } catch {}
          }
        } else {
          logger.info('[VIRTUS] Chat já aberto no momento de responder. Fast-path para digitação.', { nome, chatId });
        }
        if (!achou) {
          logger.warn(`Não entrou no chat correto no prazo. Reagendando retry curto. (urlAtual=${urlAtual}, esperado=${chatId})`, { nome, chatId, openDeadlineMs: VIRTUS_CHAT_OPEN_DEADLINE_MS });
          replyRetryReasonByChat.set(chatId, 'chat_open_timeout');
          try { await pendingDel(nome, chatId); } catch {}
          chatAtivo = null;
          return;
        }

        // Ativa send-guard imediatamente após confirmar navegação correta.
        // P1 hardening: use o Browser (não a Page) para evitar leak quando a page fecha/desconecta.
        acquireSendGuardBrowser(browser, chatId);

        const blocked = await isChatBlocked(p);
        if (blocked) {
          logger.warn('Chat bloqueado/indisponível, marcado respondido', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          resetFail(chatId);
          return;
        }

        // Checagem de contexto antes de aguardar o composer
        const preSendOnChat = await assertOnChat(p, chatId, { timeoutMs: 1200 });
        if (!preSendOnChat) {
          try { await pendingDel(nome, chatId); } catch {}
          replyRetryReasonByChat.set(chatId, 'context_lost_before_send');
          chatAtivo = null;
          await logIssue(nome, 'mil_action', `virtus_context_abort: url divergiu antes do envio (chat ${chatId})`);
          return;
        }

        // 1) Verifica customização por manifest (mensagem personalizada Virtus)
        let msg = null;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          if (man && man.customVirtusMessageEnabled && String(man.customVirtusMessage || '').trim()) {
            msg = String(man.customVirtusMessage).trim();
          }
        } catch {}

        // 2) Se não houver custom, cai no atendimento.json como hoje
        if (!msg) {
          if (!Array.isArray(mensagensAtendimento) || !mensagensAtendimento.length) {
            logger.error('atendimento.json vazio. Não será enviada resposta!', { nome, chatId });
            try { await pendingDel(nome, chatId); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
          msg = mensagensAtendimento[randomBetween(0, mensagensAtendimento.length - 1)];
          if (Array.isArray(msg)) msg = msg.join('\n');
          if (typeof msg !== 'string') msg = String(msg);
        }

        if (!running) { try { await pendingDel(nome, chatId); } catch {} chatAtivo = null; return; }
        if (!browser || browser.isConnected?.() === false) { try { await pendingDel(nome, chatId); } catch {} chatAtivo = null; return; }
        if (!p || p.isClosed?.()) { try { await pendingDel(nome, chatId); } catch {} chatAtivo = null; return; }

        if (VIRTUS_DIRECT_SEND_ON_OPEN) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_prepare', chatId, mode: 'direct' });
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'virtus_send_prepare',
              nome: String(nome || ''),
              chatId: String(chatId || '').slice(0, 80),
              mode: 'direct'
            });
          } catch {}
          const sentDirect = await sendMessageDirectIfFocused(p, msg, nome, chatId).catch(() => false);
          if (sentDirect) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_ok', chatId, mode: 'direct' });
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'virtus_send_ok',
                nome: String(nome || ''),
                chatId: String(chatId || '').slice(0, 80),
                mode: 'direct'
              });
            } catch {}
            log(`Mensagem enviada para chat ${chatId}`);
            try { await pendingDel(nome, chatId); } catch {}
            const tsNowDirect = agoraEpoch();
            historico[chatId] = tsNowDirect;
            setResponded(chatId, tsNowDirect);
            await salvaHistorico();
            lastReplyAtMs = Date.now();
            repliesSinceRecycle += 1;
            // Fluxo direto também precisa liberar item ativo da fila.
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          }
        }

        const composerFastDeadlineAt = Date.now() + VIRTUS_COMPOSER_FAST_TIMEOUT_MS;
        let campo = await waitForComposer(p, 3500);
        if (!campo) {
          logger.warn('Composer não encontrado. Retry por click no mesmo chat (sem goto).', { nome, chatId });
          try {
            if (!running || !epochOk()) { try { await pendingDel(nome, chatId); } catch {} fila = fila.filter(id => id !== chatId); chatAtivo = null; return; }
            if (found) {
              try { await found.evaluate((el) => { try { el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }); } catch {} }); } catch {}
              try {
                const box2 = await found.boundingBox().catch(() => null);
                if (box2 && box2.width > 4 && box2.height > 4) {
                  const x2 = box2.x + (box2.width / 2);
                  const y2 = box2.y + (box2.height / 2);
                  await p.mouse.move(x2, y2, { steps: randomBetween(4, 9) }).catch(()=>{});
                  await p.mouse.click(x2, y2, { delay: randomBetween(70, 160) }).catch(()=>{});
                } else {
                  await found.click({ delay: randomBetween(60, 140) }).catch(()=>{});
                }
              } catch {}
              await sleep(800);
            }
          } catch {}
          if (await isChatBlocked(p)) {
            logger.warn('Chat bloqueado após retry de click, marcado respondido', { nome, chatId });
            try { await pendingDel(nome, chatId); } catch {}
            try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado (click_retry)`); } catch {}
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            resetFail(chatId);
            return;
          }
          campo = await waitForComposer(p, 3000);
        }

        while (!campo && Date.now() < composerFastDeadlineAt) {
          try {
            if (!running || !epochOk()) break;
            const stillOnChat = await assertOnChat(p, chatId, { timeoutMs: 700 });
            if (!stillOnChat && found) {
              try { await found.click({ delay: randomBetween(60, 120) }).catch(()=>{}); } catch {}
            }
            campo = await waitForComposer(p, VIRTUS_COMPOSER_RECHECK_MS);
            if (campo) break;
            if (found) {
              try {
                const box3 = await found.boundingBox().catch(() => null);
                if (box3 && box3.width > 4 && box3.height > 4) {
                  const x3 = box3.x + (box3.width / 2);
                  const y3 = box3.y + (box3.height / 2);
                  await p.mouse.click(x3, y3, { delay: randomBetween(50, 120) }).catch(()=>{});
                } else {
                  await found.click({ delay: randomBetween(50, 120) }).catch(()=>{});
                }
              } catch {}
            }
            await sleep(350);
          } catch {}
        }

        if (!campo) {
          const fails = incFail(chatId);
          stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'composer_missing', chatId, failCount: fails });
          logger.error(`Composer indisponível para chat ${chatId}. Tentativas: ${fails}`, { nome, chatId });
          if (fails >= 2) {
            logger.warn(`${chatId} falhou 2x. Marcando como respondido para não travar fila.`, { nome, chatId });
            try { await pendingDel(nome, chatId); } catch {}
            try { await logIssue(nome, 'virtus_no_composer', `composer ausente após 2 tentativas (chat ${chatId})`); } catch {}
            resetFail(chatId);
            fila = fila.filter(id => id !== chatId);
            chatAtivo = null;
            return;
          } else {
            replyRetryReasonByChat.set(chatId, 'composer_missing');
            try { await pendingDel(nome, chatId); } catch {}
            chatAtivo = null;
            return;
          }
        }
// REVALIDAÇÃO FINAL DE TTL: aborta se alguém marcou este chat < janela
{
  const tsPrev2 = respondedCache.get(chatId) || Number(historico[chatId] || 0);
  if (tsPrev2 && (agoraEpoch() - tsPrev2) < NO_REPEAT_WINDOW_SEC) {
    try { await pendingDel(nome, chatId); } catch {}
    fila = fila.filter(id => id !== chatId);
    chatAtivo = null;
    await logIssue(nome, 'mil_action', `virtus_ttl_recheck_abort: chat ${chatId} dentro da janela final`);
    return;
  }
}

        resetFail(chatId);

        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_prepare', chatId });
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'virtus_send_prepare',
            nome: String(nome || ''),
            chatId: String(chatId || '').slice(0, 80)
          });
        } catch {}
        try { await campo.focus(); } catch {}
        const isFocused = await p.evaluate((el)=> document.activeElement===el, campo).catch(()=>false);
        if (!isFocused) { try { await campo.focus(); } catch {} }

        // -------- SUBSTITUIR PELO USO sendMessageSafe --------
        await sendMessageSafe(p, campo, msg, nome, chatId);
        // -----------------------------------------------------
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_ok', chatId });
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'virtus_send_ok',
            nome: String(nome || ''),
            chatId: String(chatId || '').slice(0, 80)
          });
        } catch {}

        log(`Mensagem enviada para chat ${chatId}`);
        // Ledger: remove pending ANTES de gravar responded (commit)
        try { await pendingDel(nome, chatId); } catch {}
        const tsNow = agoraEpoch();
        historico[chatId] = tsNow;
        setResponded(chatId, tsNow);
        await salvaHistorico();
        lastReplyAtMs = Date.now();
        repliesSinceRecycle += 1;

      } catch (err) {
        const msgErr = (err && err.message) ? err.message : String(err);
        // Se alvo fechou, classificar corretamente e sair silenciosamente
        if (/Target closed|Protocol error.*Target closed|Session closed/i.test(msgErr)) {
          try { await logIssue(nome, 'browser_disconnected', `chat ${chatId}: target/page closed during send`); } catch {}
        } else {
          try { await logIssue(nome, 'virtus_send_failed', `chat ${chatId}: ${msgErr}`); } catch {}
        }
        logger.error('Erro ao responder chat', { nome, chatId }, err);
        // Rollback pending em caso de erro
        try { await pendingDel(nome, chatId); } catch {}
      }

      fila = fila.filter(id => id !== chatId);
      chatAtivo = null;
      if (VIRTUS_DETAILED_DEBUG) { log(`[DETAILED] ChatId ${chatId} removido da fila e finalizado.`); }
    } finally {
      if (chatAtivo === chatId) chatAtivo = null;
      // Garantia: nunca deixar pending zumbi
      try { await pendingDel(nome, chatId); } catch {}
      resetFail(chatId); // limpa failCounts quando fim do ciclo
      // P1 hardening: liberar via Browser (mesmo se a Page já morreu)
      try { releaseSendGuardBrowser(browser); } catch {}
      if (_chatLockAcquired) {
        try { chatLock.release(nome, chatId); } catch {}
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'chat_unlock', chatId });
      }
      // #region agent log
      __virtusAgentLog(
        'H9',
        'virtus.js:responderChat.finally',
        'virtus_reply_cycle_done',
        {
          nome: String(nome || ''),
          chatId: String(chatId || ''),
          durationMs: Date.now() - tStartMs,
          filaSize: Array.isArray(fila) ? fila.length : 0,
          historicoKeys: Object.keys(historico || {}).length,
          respondedCacheSize: respondedCache.size,
          failCountsSize: failCounts.size
        },
        `virtus.reply.done.${String(nome || '')}.${String(chatId || '')}`,
        15000
      );
      // #endregion
    }
  }

  // ========================
  // === BLOCO MODIFICADO ===
  // ========================
  async function filaManagerLoop() {
    if (!running || !epochOk()) return;
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    // === INÍCIO GUARD DE VIDA NO FILAMANAGERLOOP ===
    if (!browser || browser.isConnected?.() === false) {
      logger.error(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`, { nome });
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }
    // Fim guard de vida browser

    if (filaLoopBusy) return;
    filaLoopBusy = true;
    try {
      const p = await ensurePage();
      if (!p || (p.isClosed && p.isClosed())) {
        logger.error(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`, { nome });
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        running = false;
        if (filaInterval) clearInterval(filaInterval), filaInterval = null;
        if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
        if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
        return;
      }


      // ======= INSTRUÇÃO: REMOVER BLOCO REVIVE AQUI =======
      /*
      // --- INÍCIO DETECTOR/REVIVE ---
      try {
        const reviveTimeoutMs = 1000;
        const jsTest = await Promise.race([
          p.evaluate(() => 1+41),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), reviveTimeoutMs))
        ]);
      } catch (e) {
        try {
          log('[VIRTUS][REVIVE] Navegador detectado travado/sem resposta — abrindo aba fantasma para tentar reviver.');
          const tmp = await browser.newPage();
          setTimeout(() => { try { tmp.close(); } catch {} }, 1000);
        } catch (e2) {
        }
      }
      // --- FIM DETECTOR/REVIVE ---
      */
      // === BLOCO REMOVIDO CONFORME INSTRUÇÃO ===

      // Não dispare keepalive durante inserção de mensagem
      if (!isVirtusLocked(nome)) {
        const idleModeKeepalive = getIdleMode(Date.now());
        const allowKeepalive = (idleModeKeepalive !== 'deep_idle');
        const nowKeepalive = Date.now();
        if (allowKeepalive && (nowKeepalive - Number(lastKeepaliveAt || 0)) >= KEEPALIVE_MIN_GAP_MS) {
          lastKeepaliveAt = nowKeepalive;
        try {
          await p.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true}));
            document.dispatchEvent(new Event('visibilitychange'));
            if (window && document && document.body) {
              const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Control', code: 'ControlLeft' });
              document.body.dispatchEvent(evt);
            }
          });
        } catch {}
        }
      }

      if (limpaHistoricoVelho()) await salvaHistorico();

      await atualizaFila();
      scheduleNextIfIdle();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running || !epochOk()) return;
          const idleModeScroll = getIdleMode(Date.now());
          const allowIdleScroll = (idleModeScroll !== 'deep_idle');
          const shouldScroll = (Array.isArray(fila) && fila.length > 0) || (allowIdleScroll && ((Date.now() - Number(lastScrollToTop || 0)) >= SCROLL_TOP_IDLE_MIN_GAP_MS));
          if (!shouldScroll) return;
          try {
            const ok = await scrollChatsToTop(p, nome);
            if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'OK' : 'FAIL'); }
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
        }, SCROLL_TOP_INTERVAL_MS);
      }
      try {
        const idleModeScrollNow = getIdleMode(Date.now());
        const allowIdleScrollNow = (idleModeScrollNow !== 'deep_idle');
        const shouldScrollNow = (Array.isArray(fila) && fila.length > 0) || (allowIdleScrollNow && ((Date.now() - Number(lastScrollToTop || 0)) >= SCROLL_TOP_IDLE_MIN_GAP_MS));
        if (shouldScrollNow) {
          const scrolled = await scrollChatsToTop(p, nome);
          if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', scrolled ? 'OK' : 'FAIL'); }
          if (scrolled) {
            lastScrollToTop = Date.now();
          }
        }
      } catch {}

      // #region agent log
      let metrics = null;
      try {
        const pm = await p.metrics();
        metrics = {
          jsHeapUsedMB: Number((Number(pm.JSHeapUsedSize || 0) / 1048576).toFixed(2)),
          jsHeapTotalMB: Number((Number(pm.JSHeapTotalSize || 0) / 1048576).toFixed(2)),
          nodes: Number(pm.Nodes || 0),
          documents: Number(pm.Documents || 0),
          layoutCount: Number(pm.LayoutCount || 0),
          taskDuration: Number(pm.TaskDuration || 0)
        };
      } catch {}
      __virtusAgentLog(
        'H10',
        'virtus.js:filaManagerLoop',
        'virtus_page_metrics',
        {
          nome: String(nome || ''),
          filaSize: Array.isArray(fila) ? fila.length : 0,
          chatAtivo: chatAtivo ? String(chatAtivo) : null,
          historicoKeys: Object.keys(historico || {}).length,
          respondedCacheSize: respondedCache.size,
          failCountsSize: failCounts.size,
          metrics
        },
        `virtus.page.metrics.${String(nome || '')}`,
        60000
      );
      // #endregion

      // #region agent log
      // Stage-3 fix candidate: recycle hot Messenger page only when idle.
      try {
        const nowMs = Date.now();
        const heapUsed = Number(metrics && metrics.jsHeapUsedMB || 0);
        const nodesUsed = Number(metrics && metrics.nodes || 0);
        if (lastPageRecycleMeta && String(lastPageRecycleMeta.nome || '') === String(nome || '')) {
          const elapsedMs = nowMs - Number(lastPageRecycleMeta.at || 0);
          if (elapsedMs >= VIRTUS_PAGE_RECYCLE_FOLLOWUP_MS) {
            __virtusAgentLog(
              'H13',
              'virtus.js:filaManagerLoop',
              'virtus_page_recycle_followup_metrics',
              {
                nome: String(nome || ''),
                elapsedMs,
                jsHeapUsedMB: heapUsed,
                nodes: nodesUsed,
                heapBefore: Number(lastPageRecycleMeta.heapBefore || 0),
                nodesBefore: Number(lastPageRecycleMeta.nodesBefore || 0),
                navStatus: lastPageRecycleMeta.navStatus == null ? null : Number(lastPageRecycleMeta.navStatus),
                preUrl: String(lastPageRecycleMeta.preUrl || ''),
                postUrl: String(lastPageRecycleMeta.postUrl || '')
              },
              `virtus.page.recycle.followup.${String(nome || '')}`,
              15000
            );
            lastPageRecycleMeta = null;
          }
        }
        const hostFreeMB = Number((os.freemem() / 1048576).toFixed(0));
        let pressureMode = 'normal';
        let thresholdHeap = VIRTUS_PAGE_HEAP_RECYCLE_MB;
        let thresholdNodes = VIRTUS_PAGE_NODES_RECYCLE;
        let cooldownMs = VIRTUS_PAGE_RECYCLE_COOLDOWN_MS;
        if (hostFreeMB <= VIRTUS_HOST_FREE_CRITICAL_MB) {
          pressureMode = 'critical';
          thresholdHeap = VIRTUS_PAGE_HEAP_RECYCLE_CRITICAL_MB;
          thresholdNodes = VIRTUS_PAGE_NODES_RECYCLE_CRITICAL;
          cooldownMs = VIRTUS_PAGE_RECYCLE_COOLDOWN_CRITICAL_MS;
          respCacheMaxDynamic = Math.min(RESP_CACHE_MAX, VIRTUS_RESP_CACHE_CRITICAL_MAX);
          failCountsMaxDynamic = Math.min(FAIL_COUNTS_MAX, VIRTUS_FAIL_COUNTS_CRITICAL_MAX);
        } else if (hostFreeMB <= VIRTUS_HOST_FREE_LOW_MB) {
          pressureMode = 'low';
          thresholdHeap = VIRTUS_PAGE_HEAP_RECYCLE_LOW_MB;
          thresholdNodes = VIRTUS_PAGE_NODES_RECYCLE_LOW;
          cooldownMs = VIRTUS_PAGE_RECYCLE_COOLDOWN_LOW_MS;
          respCacheMaxDynamic = Math.min(RESP_CACHE_MAX, VIRTUS_RESP_CACHE_LOW_MAX);
          failCountsMaxDynamic = Math.min(FAIL_COUNTS_MAX, VIRTUS_FAIL_COUNTS_LOW_MAX);
        } else {
          respCacheMaxDynamic = RESP_CACHE_MAX;
          failCountsMaxDynamic = FAIL_COUNTS_MAX;
        }
        if (pressureMode !== 'normal') {
          const removedResp = trimMapOldest(respondedCache, respCacheMaxDynamic);
          const removedFail = trimMapOldest(failCounts, failCountsMaxDynamic);
          if (removedResp > 0 || removedFail > 0) {
            __virtusAgentLog(
              'H15',
              'virtus.js:filaManagerLoop',
              'virtus_pressure_trim',
              {
                nome: String(nome || ''),
                hostFreeMB,
                pressureMode,
                removedResponded: removedResp,
                removedFailCounts: removedFail,
                respondedCacheSize: respondedCache.size,
                failCountsSize: failCounts.size,
                respondedCap: respCacheMaxDynamic,
                failCountsCap: failCountsMaxDynamic
              },
              `virtus.pressure.trim.${String(nome || '')}`,
              15000
            );
          }
        }
        if ((nowMs - Number(lastPressureModeLogAt || 0)) >= 60000) {
          lastPressureModeLogAt = nowMs;
          __virtusAgentLog(
            'H14',
            'virtus.js:filaManagerLoop',
            'virtus_recycle_pressure_mode',
            {
              nome: String(nome || ''),
              hostFreeMB,
              pressureMode,
              thresholdHeap,
              thresholdNodes,
              cooldownMs
            },
            `virtus.page.recycle.mode.${String(nome || '')}`,
            60000
          );
        }
        const hasAdaptivePressure = (
          (heapUsed >= thresholdHeap) ||
          (nodesUsed >= thresholdNodes)
        );
        const hasReplyCountTrigger = (VIRTUS_PAGE_RECYCLE_REPLY_COUNT > 0 && repliesSinceRecycle >= VIRTUS_PAGE_RECYCLE_REPLY_COUNT);
        const cooldownOk = (nowMs - Number(lastPageRecycleAt || 0)) >= cooldownMs;
        const idleSafe = !chatAtivo && Array.isArray(fila) && fila.length === 0 && !isVirtusLocked(nome);
        const idleMode = getIdleMode(nowMs);
        const skipByIdlePolicy = (VIRTUS_IDLE_SKIP_RECYCLE_UNTIL_PRESSURE && idleMode === 'deep_idle' && !hasAdaptivePressure);
        if ((hasAdaptivePressure || hasReplyCountTrigger) && cooldownOk) {
          __virtusAgentLog(
            'H11',
            'virtus.js:filaManagerLoop',
            'virtus_page_recycle_candidate',
            {
              nome: String(nome || ''),
              heapUsed,
              nodesUsed,
              hostFreeMB,
              pressureMode,
              thresholdHeap,
              thresholdNodes,
              cooldownMs,
              idleMode,
              hasReplyCountTrigger,
              repliesSinceRecycle,
              recycleReplyCountThreshold: VIRTUS_PAGE_RECYCLE_REPLY_COUNT,
              skipByIdlePolicy,
              idleSafe,
              cooldownOk,
              filaSize: Array.isArray(fila) ? fila.length : 0,
              chatAtivo: chatAtivo ? String(chatAtivo) : null
            },
            `virtus.page.recycle.candidate.${String(nome || '')}`,
            30000
          );
        }
        if (VIRTUS_PAGE_RECYCLE_ENABLED && (hasAdaptivePressure || hasReplyCountTrigger) && cooldownOk && idleSafe && !skipByIdlePolicy) {
          const heavyGuard = canRunHeavyAction(nowMs);
          if (!heavyGuard.ok) {
            __virtusAgentLog(
              'H18',
              'virtus.js:filaManagerLoop',
              'virtus_recycle_skipped_heavy_guard',
              {
                nome: String(nome || ''),
                reason: String(heavyGuard.reason || ''),
                waitMs: Number(heavyGuard.waitMs || 0),
                countInWindow: Number(heavyGuard.count || 0),
                idleMode,
                pressureMode
              },
              `virtus.page.recycle.skip.heavy.${String(nome || '')}`,
              15000
            );
          }
          if (heavyGuard.ok) {
          const globalSlot = tryAcquireGlobalRecycle(nome, nowMs);
          if (!globalSlot.ok) {
            __virtusAgentLog(
              'H17',
              'virtus.js:filaManagerLoop',
              'virtus_page_recycle_skipped_global_guard',
              {
                nome: String(nome || ''),
                reason: String(globalSlot.reason || ''),
                lockedBy: String(globalSlot.owner || ''),
                waitMs: Number(globalSlot.waitMs || 0),
                pressureMode,
                hostFreeMB
              },
              `virtus.page.recycle.skip.global.${String(nome || '')}`,
              15000
            );
          }
          if (globalSlot.ok) {
            markHeavyAction(nowMs);
            const t0 = Date.now();
            try {
            const preUrl = (() => { try { return String(p.url() || ''); } catch { return ''; } })();
            let navTimeoutMs = pressureMode === 'critical' ? 12000 : (pressureMode === 'low' ? 18000 : 30000);
            let navStatus = null;
            let navMethod = 'goto';
            let postUrl = '';
            let swapOldPage = null;
            let swapCandidatePage = null;
            let swapWindowArmed = false;
            const useSwapRecycle = VIRTUS_PAGE_SWAP_RECYCLE_ENABLED === true && pressureMode !== 'critical';
            if (useSwapRecycle) {
              navTimeoutMs = Math.max(8000, Math.min(navTimeoutMs, VIRTUS_PAGE_SWAP_NAV_TIMEOUT_MS));
              try {
                if (browser) {
                  browser._virtusSwapUntil = (browser._virtusSwapUntil && typeof browser._virtusSwapUntil === 'object') ? browser._virtusSwapUntil : {};
                  browser._virtusSwapUntil[nome] = Date.now() + VIRTUS_PAGE_SWAP_WINDOW_MS;
                  swapWindowArmed = true;
                }
              } catch {}
              try {
                swapCandidatePage = await browser.newPage();
                try {
                  const manifest = await manifestStore.read(nome);
                  const coords = utils.getCoords((manifest && manifest.cidade) ? manifest.cidade : '');
                  await patchPage(nome, swapCandidatePage, coords);
                  await ensureMinimizedWindowForPage(swapCandidatePage);
                } catch (swapPatchErr) {
                  logger.warn('virtus swap recycle: falha patch/minimize', { nome }, swapPatchErr);
                }
                swapOldPage = p;
                p = swapCandidatePage;
                page = swapCandidatePage;
                try {
                  const swapRef = swapCandidatePage;
                  swapRef.once && swapRef.once('close', () => { if (page === swapRef) page = null; });
                } catch {}
                navMethod = 'swap_page';
              } catch (swapPrepareErr) {
                try { if (swapCandidatePage && !swapCandidatePage.isClosed?.()) await swapCandidatePage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
                throw new Error(`swap_prepare_failed:${String(swapPrepareErr && swapPrepareErr.message ? swapPrepareErr.message : swapPrepareErr)}`);
              }
            }
            try {
              const browserJs = require('./browser.js');
              let navResp = null;
              if (browserJs && typeof browserJs.ensureMarketplaceMessagesContext === 'function') {
                await browserJs.ensureMarketplaceMessagesContext(p, { timeoutMs: navTimeoutMs, reason: 'virtus_page_recycle' });
                navMethod = 'ensure_marketplace_context';
              } else {
                navResp = await p.goto('https://www.facebook.com/messages', { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
              }
              postUrl = (() => { try { return String(p.url() || ''); } catch { return ''; } })();
              navStatus = navResp && typeof navResp.status === 'function' ? Number(navResp.status()) : null;
            } catch (primaryNavErr) {
              navMethod = 'assign_wait';
              __virtusAgentLog(
                'H16',
                'virtus.js:filaManagerLoop',
                'virtus_page_recycle_fallback_start',
                {
                  nome: String(nome || ''),
                  pressureMode,
                  navTimeoutMs,
                  primaryError: String(primaryNavErr && primaryNavErr.message ? primaryNavErr.message : primaryNavErr)
                },
                `virtus.page.recycle.fallback.start.${String(nome || '')}`,
                15000
              );
              try {
                await p.evaluate(() => { try { location.assign('https://www.facebook.com/messages'); } catch {} });
                const waitBudgetMs = Math.max(6000, Math.floor(navTimeoutMs * 0.8));
                try {
                  await Promise.race([
                    p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitBudgetMs }).catch(() => null),
                    p.waitForFunction(
                      () => {
                        try {
                          const path = location && typeof location.pathname === 'string' ? String(location.pathname || '') : '';
                          return path.includes('/marketplace') || path.includes('/messages');
                        } catch {
                          return false;
                        }
                      },
                      { timeout: waitBudgetMs }
                    ).catch(() => null)
                  ]);
                } catch {}
                let landed = false;
                try {
                  const u = String(p.url() || '');
                  landed = /facebook\.com\/messages|messenger\.com\/marketplace/i.test(u);
                } catch {}
                if (!landed) {
                  try {
                    landed = !!(await p.evaluate(() => {
                      try {
                        const path = location && typeof location.pathname === 'string' ? String(location.pathname || '') : '';
                        return path.includes('/marketplace') || path.includes('/messages');
                      }
                      catch { return false; }
                    }));
                  } catch {}
                }
                if (!landed) throw new Error('fallback_not_landed_marketplace');
                postUrl = (() => { try { return String(p.url() || ''); } catch { return ''; } })();
                __virtusAgentLog(
                  'H16',
                  'virtus.js:filaManagerLoop',
                  'virtus_page_recycle_fallback_done',
                  {
                    nome: String(nome || ''),
                    pressureMode,
                    navTimeoutMs,
                    postUrl
                  },
                  `virtus.page.recycle.fallback.done.${String(nome || '')}`,
                  15000
                );
              } catch (fallbackNavErr) {
                __virtusAgentLog(
                  'H16',
                  'virtus.js:filaManagerLoop',
                  'virtus_page_recycle_fallback_failed',
                  {
                    nome: String(nome || ''),
                    pressureMode,
                    navTimeoutMs,
                    fallbackError: String(fallbackNavErr && fallbackNavErr.message ? fallbackNavErr.message : fallbackNavErr)
                  },
                  `virtus.page.recycle.fallback.fail.${String(nome || '')}`,
                  15000
                );
                throw new Error(`primary_nav=${String(primaryNavErr && primaryNavErr.message ? primaryNavErr.message : primaryNavErr)}; fallback_nav=${String(fallbackNavErr && fallbackNavErr.message ? fallbackNavErr.message : fallbackNavErr)}`);
              }
            }
            lastPageRecycleAt = Date.now();
            repliesSinceRecycle = 0;
            __virtusAgentLog(
              'H11',
              'virtus.js:filaManagerLoop',
              'virtus_page_recycle_done',
              {
                nome: String(nome || ''),
                heapUsedBefore: heapUsed,
                nodesBefore: nodesUsed,
                durationMs: Date.now() - t0
              },
              `virtus.page.recycle.done.${String(nome || '')}`,
              30000
            );
            __virtusAgentLog(
              'H12',
              'virtus.js:filaManagerLoop',
              'virtus_page_recycle_nav_result',
              {
                nome: String(nome || ''),
                preUrl,
                postUrl,
                navStatus,
                navMethod,
                navTimeoutMs,
                durationMs: Date.now() - t0
              },
              `virtus.page.recycle.nav.${String(nome || '')}`,
              30000
            );
            lastPageRecycleMeta = {
              at: Date.now(),
              nome: String(nome || ''),
              heapBefore: heapUsed,
              nodesBefore: nodesUsed,
              navStatus,
              navMethod,
              preUrl,
              postUrl
            };
            try {
              const pm2 = await p.metrics();
              __virtusAgentLog(
                'H11',
                'virtus.js:filaManagerLoop',
                'virtus_page_recycle_post_metrics',
                {
                  nome: String(nome || ''),
                  jsHeapUsedMB: Number((Number(pm2 && pm2.JSHeapUsedSize || 0) / 1048576).toFixed(2)),
                  jsHeapTotalMB: Number((Number(pm2 && pm2.JSHeapTotalSize || 0) / 1048576).toFixed(2)),
                  nodes: Number(pm2 && pm2.Nodes || 0),
                  documents: Number(pm2 && pm2.Documents || 0)
                },
                `virtus.page.recycle.post.${String(nome || '')}`,
                30000
              );
            } catch {}
            if (swapOldPage && swapOldPage !== p) {
              try {
                await swapOldPage.close({ runBeforeUnload: false }).catch(() => {});
              } catch {}
            }
            } catch (recycleErr) {
              let swapRecovered = false;
              if (swapOldPage && page === swapCandidatePage) {
                try {
                  if (!swapOldPage.isClosed?.()) {
                    p = swapOldPage;
                    page = swapOldPage;
                    swapRecovered = true;
                  }
                } catch {}
              }
              if (swapCandidatePage && swapCandidatePage !== swapOldPage) {
                try { if (!swapCandidatePage.isClosed?.()) await swapCandidatePage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
              }
              __virtusAgentLog(
                'H11',
                'virtus.js:filaManagerLoop',
                'virtus_page_recycle_failed',
                {
                  nome: String(nome || ''),
                  heapUsedBefore: heapUsed,
                  nodesBefore: nodesUsed,
                  error: String(recycleErr && recycleErr.message ? recycleErr.message : recycleErr),
                  swapMode: useSwapRecycle ? 'enabled' : 'disabled',
                  swapRecovered
                },
                `virtus.page.recycle.fail.${String(nome || '')}`,
                30000
              );
            } finally {
              if (swapWindowArmed && browser && browser._virtusSwapUntil && browser._virtusSwapUntil[nome]) {
                try { delete browser._virtusSwapUntil[nome]; } catch {}
              }
              releaseGlobalRecycle(nome);
            }
          }
          }
        }
      } catch {}
      // #endregion

      // ========== INÍCIO BLOCO ADICIONADO CONFORME INSTRUÇÃO ==========
      // Checagem de bloqueio temporário Messenger (DOM) — apenas LOG, congelamento é feito pelo nurseTick
      try {
        const det = await p.evaluate(() => {
          const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
          const texts = Array.from(document.querySelectorAll('h1,h2,span,div')).map(el => norm(el.innerText || el.textContent || ''));
          const hasBlocked =
            texts.some(t =>
              t.includes('voce esta bloqueado temporariamente') ||
              t.includes('você está bloqueado temporariamente') ||
              t.includes('youre temporarily blocked') ||
              t.includes('you’re temporarily blocked') ||
              t.includes('temporarily blocked')
            );
          return { blocked: hasBlocked };
        });
        if (det && det.blocked) {
          // Apenas LOG, não congele aqui! O nurseTick irá congelar.
          if (issues) try { await logIssue(nome, 'virtus_blocked', 'Messenger temporariamente bloqueado (Virtus/Marketplace)'); } catch {}
        }
      } catch {}
      // ========== FIM BLOCO ADICIONADO ==========

    } finally {
      filaLoopBusy = false;
    }
  }
  // ==== FIM BLOCO MODIFICADO ====

  async function runner() {
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const manifest = await manifestStore.read(nome);
      manifestFrozenUntil = typeof manifest?.frozenUntil === 'number' ? manifest.frozenUntil : 0;
    } catch {}
    if (manifestFrozenUntil && manifestFrozenUntil > Date.now()) {
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      logger.warn(`[VIRTUS][${nome}] virtus_stop_frozen window — congelado até ${new Date(manifestFrozenUntil).toISOString()}`, { nome });
      return;
    }
    // ========== FIM BLOCO FREEZER INSTRUÇÃO 2 ==========

    await sleep(2000);
    let ready = false;
    while (running && !ready) {
      if (!running || !epochOk()) return;
      try {
        if (!running || !epochOk()) return;
        const p = await ensurePage();
        if (!running || !epochOk()) return;
        if (!p) { await sleep(2500); continue; }
        if (p.url() === 'about:blank' || !/(messenger\.com\/marketplace|facebook\.com\/messages)/i.test(p.url())) {
          try {
            if (!running || !epochOk()) return;
            await p.goto('https://www.facebook.com/messages', { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); continue;
          }
        }
        if (!running || !epochOk()) return;
        const marketReady = await ensureMarketplaceCalmo(p, { timeoutMs: 25000, force: true, reason: 'runner_boot' });
        if (!marketReady) {
          ready = true;
          logger.info('Aba zero da Virtus pronta, mas sem menu Marketplace ainda (aguardando primeiro chat).', { nome });
          continue;
        }
        try {
          const ok = await scrollChatsToTop(p, nome);
          setTimeout(() => {
            if (!running || !epochOk()) return;
            try {
              const b = getBrowserFromPage(p);
              if (b && b._sendLock && b._sendLock.active) return;
            } catch {}
            scrollChatsToTop(p, nome);
          }, 800);
        } catch {}
        ready = true;
        logger.info('Aba zero da Virtus iniciada e garantida: Marketplace pronta.', { nome });
      } catch (err) {
        if (!running) return;
        logger.error('Falha ao garantir aba zero no startup Virtus', { nome }, err);
        await sleep(2500);
      }
    }
    if (!running || !epochOk()) return;
    await initHistoricoSePreciso();
    filaInterval = setInterval(filaManagerLoop, POLL_INTERVAL_MS);
    filaManagerLoop();
  }

  runner();

  return {
    stop: async () => {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'stop' });
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      let pages = [];
      try { pages = await browser.pages(); } catch {}
      if (robeMeta && typeof nome !== "undefined") {
        if (!robeMeta[nome]) robeMeta[nome] = {};
        robeMeta[nome].numPages = pages.length;
      }
      // ========== Limpeza para evitar leaks ==========
      delete virtusDeadLogTimes[nome];
      try { respondedCache.clear(); } catch {}
      try { fila = []; } catch {}
      try { failCounts.clear(); } catch {}
      try { historico = {}; } catch {}
    }
  };
}

module.exports = {
  startVirtus,
  // Exportado para o bootstrap enterprise no worker:
  // - garante sinais reais do Marketplace antes de avançar para checagem Robe.
  garantirMarketplace
};