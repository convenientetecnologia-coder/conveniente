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
    const ok = await p.evaluate((id) => {
      try { return (location && typeof location.pathname === 'string') ? location.pathname.includes('/marketplace/t/' + id) : false; }
      catch { return false; }
    }, chatId).catch(() => false);
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
const VIRTUS_RESP_CACHE_LOW_MAX = parseInt(process.env.VIRTUS_RESP_CACHE_LOW_MAX || '3000', 10);
const VIRTUS_RESP_CACHE_CRITICAL_MAX = parseInt(process.env.VIRTUS_RESP_CACHE_CRITICAL_MAX || '1800', 10);
const VIRTUS_FAIL_COUNTS_LOW_MAX = parseInt(process.env.VIRTUS_FAIL_COUNTS_LOW_MAX || '700', 10);
const VIRTUS_FAIL_COUNTS_CRITICAL_MAX = parseInt(process.env.VIRTUS_FAIL_COUNTS_CRITICAL_MAX || '350', 10);
const VIRTUS_TYPE_DELAY_MIN_MS = Math.max(10, parseInt(process.env.VIRTUS_TYPE_DELAY_MIN_MS || '55', 10) || 55);
const VIRTUS_TYPE_DELAY_MAX_MS = Math.max(VIRTUS_TYPE_DELAY_MIN_MS, parseInt(process.env.VIRTUS_TYPE_DELAY_MAX_MS || '120', 10) || 120);
const VIRTUS_ENTER_AFTER_TYPE_MIN_MS = Math.max(80, parseInt(process.env.VIRTUS_ENTER_AFTER_TYPE_MIN_MS || '350', 10) || 350);
const VIRTUS_ENTER_AFTER_TYPE_MAX_MS = Math.max(VIRTUS_ENTER_AFTER_TYPE_MIN_MS, parseInt(process.env.VIRTUS_ENTER_AFTER_TYPE_MAX_MS || '900', 10) || 900);
const VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS = Math.max(120, parseInt(process.env.VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS || '700', 10) || 700);
const VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS = Math.max(VIRTUS_CHAT_OPEN_POST_CLICK_MIN_MS, parseInt(process.env.VIRTUS_CHAT_OPEN_POST_CLICK_MAX_MS || '1400', 10) || 1400);
const VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS = Math.max(120, parseInt(process.env.VIRTUS_CHAT_OPEN_CHECK_INTERVAL_MS || '450', 10) || 450);
const VIRTUS_CHAT_OPEN_PRIMARY_MODE = (String(process.env.VIRTUS_CHAT_OPEN_PRIMARY_MODE || 'mouse').trim().toLowerCase() === 'dom') ? 'dom' : 'mouse';
const __VIRTUS_DEBUG_ENDPOINT = 'http://127.0.0.1:7242/ingest/611be70a-568b-4b8e-87dd-5895ef7bcc36';
const __virtusGlobalRecycle = { owner: '', acquiredAt: 0, lastReleaseAt: 0 };
const __virtusDbgState = { lastByKey: Object.create(null) };
function __virtusAgentLog(hypothesisId, location, message, data, key = '', minIntervalMs = 0) {
  try {
    if (!LEGACY_RUNTIME_DEBUG_ENABLED) return;
    const now = Date.now();
    const k = String(key || `${hypothesisId}:${location}:${message}`);
    const last = Number(__virtusDbgState.lastByKey[k] || 0) || 0;
    if (minIntervalMs > 0 && (now - last) < minIntervalMs) return;
    __virtusDbgState.lastByKey[k] = now;
    // #region agent log
    fetch(__VIRTUS_DEBUG_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: 'stage3-pre-fix',
        hypothesisId,
        location,
        message,
        data: data && typeof data === 'object' ? data : {},
        timestamp: now
      })
    }).catch(() => {});
    try {
      if (provisionAudit && typeof provisionAudit.append === 'function') {
        provisionAudit.append({
          ts: now,
          event: 'dbg_agent_runtime',
          runId: 'stage3-pre-fix',
          hypothesisId: String(hypothesisId || ''),
          location: String(location || ''),
          message: String(message || ''),
          data: data && typeof data === 'object' ? data : {}
        });
      }
    } catch {}
    // #endregion
  } catch {}
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
  if (mH) { if (parseInt(mH[1],10) < 24) return true; }
  return false;
}

// Extratores e coleta
function extraiIdDoHref(href) {
  try {
    const s = String(href || '');
    const pos = s.indexOf('/marketplace/t/');
    if (pos < 0) return null;
    const rest = s.slice(pos + '/marketplace/t/'.length);
    const id = rest.split(/[/?#]/)[0];
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null; }
}

async function coletaChatsMarketplaceTodos(page) {
  try {
    const items = await page.$$eval('a[href^="/marketplace/t/"]', els => {
      function _extraiId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
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
  if (!/messenger.com\/marketplace/i.test(url)) {
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: timeoutMs }); } catch {}
  }
  // Cura fluxos de nonce/continuar
  try {
    const browserJs = require('./browser.js');
    if (browserJs && typeof browserJs.resolveNonceIfPresent === 'function') {
      await browserJs.resolveNonceIfPresent(page).catch(()=>{});
    }
    if (browserJs && typeof browserJs.clickContinuarComo === 'function') {
      await browserJs.clickContinuarComo(page, { timeout: 12000 }).catch(()=>{});
    }
  } catch {}
  // Espera robusta por UI
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
        let firstA = grid.querySelector('a[role="link"], a[href^="/marketplace/t/"]');
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
      await logIssue(nome, 'virtus_send_failed', 'send_confirmation_timeout (no re-enter)');
    }

  } finally {
    setVirtusInputLock(nome, false);
  }
}
// ========== FIM DA FUNÇÃO sendMessageSafe ==========

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

  const HIST_FILE = HIST_JSON_NAME(nome);
  const NO_REPEAT_WINDOW_SEC = 72 * 3600; // 72h de bloqueio hardcoded para blindagem absoluta antiflood
  const POLL_INTERVAL_MS = Math.max(
    45_000,
    Number(process.env.VIRTUS_POLL_INTERVAL_MS || (slowMode ? 90_000 : 60_000)) || (slowMode ? 90_000 : 60_000)
  );
  const MIN_REPLY_DELAY_MS = slowMode ? 80_000 : 60_000;
  const MAX_REPLY_DELAY_MS = slowMode ? 150_000 : 120_000;
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
    // #region agent log
    __virtusAgentLog(
      'H7',
      'virtus.js:carregaHistorico',
      'virtus_history_loaded',
      {
        nome: String(nome || ''),
        historicoKeys: Object.keys(historico || {}).length,
        respondedCacheSize: respondedCache.size,
        noRepeatWindowSec: NO_REPEAT_WINDOW_SEC,
        pollIntervalMs: POLL_INTERVAL_MS
      },
      `virtus.history.loaded.${String(nome || '')}`,
      60000
    );
    // #endregion
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
    // #region agent log
    __virtusAgentLog(
      'H7',
      'virtus.js:limpaHistoricoVelho',
      'virtus_history_prune',
      {
        nome: String(nome || ''),
        removed,
        historicoKeys: Object.keys(historico || {}).length,
        respondedCacheSize: respondedCache.size,
        changed: !!mudanca
      },
      `virtus.history.prune.${String(nome || '')}`,
      60000
    );
    // #endregion
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
      const txts = await p.$$eval('div, span, h1, h2', els =>
        els.slice(0, 200).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean)
      );
      for (const t of txts) {
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
      const p = await ensurePage();
      if (!p) return [];
      try {
        if (!running || !epochOk()) return [];
        await garantirMarketplace(p);
      } catch (err) {
        logger.warn('Não está no Marketplace ou erro ao garantir Marketplace', { nome }, err);
        await sleep(5000);
        return [];
      }
      try {
        await Promise.race([
          p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 4000 }),
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
      log('Histórico existente carregado. Retomando pendentes <24h.');
      return;
    } catch {}

    log('[SNAPSHOT] Primeiro boot sem histórico. Marcando <24h atuais como respondidos.');
    if (!running || !epochOk()) return;
    const p = await ensurePage();
    if (!p) { log('[SNAPSHOT] Falha ao garantir aba zero.'); return; }
    if (!running || !epochOk()) return;
    await garantirMarketplace(p);
    try {
      await Promise.race([
        p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 8000 }),
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
    log(`[SNAPSHOT] Concluído. ${recentes.length} chats <24h marcados como respondidos no primeiro boot.`);
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
        log(`[FILA] Chat ${id} removido da fila (já respondido <24h)`);
        mudancaFila = true;
      }
    });

    if (novosAti > 0) {
      log(`[FILA] Atualizada: ${fila.length} chats pendentes para resposta.`);
      mudancaFila = true;
    }
    // #region agent log
    __virtusAgentLog(
      'H8',
      'virtus.js:atualizaFila',
      'virtus_queue_state',
      {
        nome: String(nome || ''),
        chatsNovosCount: Array.isArray(chatsNovos) ? chatsNovos.length : 0,
        novosAti,
        filaSize: fila.length,
        chatAtivo: chatAtivo ? String(chatAtivo) : null,
        pendingTimers: {
          filaInterval: !!filaInterval,
          filaChatTimer: !!filaChatTimer,
          scrollInterval: !!scrollInterval
        }
      },
      `virtus.queue.state.${String(nome || '')}`,
      45000
    );
    // #endregion
    return mudancaFila;
  }

  function scheduleNextIfIdle() {
    if (!running) return;
    if (chatAtivo) return;
    if (filaChatTimer) return;
    if (!fila.length) return;

    const next = fila[0];
    const delay = randomBetween(MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS);
    log(`[FILA] Atendendo chat ${next} em ${Math.round(delay/1000)}s`);
    filaChatTimer = setTimeout(async () => {
      if (!running || !epochOk()) return;
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'schedule_reply', chatId: next, in: delay });
      filaChatTimer = null;
      await responderChat(next);
      scheduleNextIfIdle();
    }, delay);
  }

  async function responderChat(chatId) {
    const tStartMs = Date.now();
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
        await garantirMarketplace(p);

        const tsPrev = respondedCache.get(chatId) || Number(historico[chatId] || 0);
        if (tsPrev && (agoraEpoch() - tsPrev) < NO_REPEAT_WINDOW_SEC) {
          log(`[GUARD-ID] Já respondido (ID ${chatId}) <24h. Pulando envio.`);
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        let anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
        await scrollChatsToTop(p, nome).catch(()=>{});
        await sleep(300);
        let found = await p.$(anchorSel);

        if (!found) {
          logger.warn(`Âncora do chatId ${chatId} não encontrada. Pulando para próximo chat.`, { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        let achou = false;
        let urlAtual = '';
        const clickOrder = VIRTUS_CHAT_OPEN_PRIMARY_MODE === 'dom' ? ['dom', 'mouse'] : ['mouse', 'dom'];
        for (let clickTry = 0; clickTry < 2 && !achou; clickTry++) {
          try {
            await found.evaluate((el) => {
              try { el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }); } catch {}
            });
          } catch {}

          for (const clickMode of clickOrder) {
            if (achou) break;
            try {
              if (clickMode === 'dom') {
                await found.click({ delay: randomBetween(60, 140) }).catch(()=>{});
              } else {
                const box = await found.boundingBox().catch(() => null);
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
            while (attempts < 6) {
              urlAtual = await p.evaluate(() => location.pathname);
              if (urlAtual.includes(`/marketplace/t/${chatId}`)) {
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
          }

          // Rebusca a âncora antes da próxima tentativa (DOM pode reciclar após render virtualizada).
          if (!achou && clickTry < 1) {
            found = await p.$(anchorSel).catch(() => null);
            if (!found) break;
          }
        }
        if (!achou) {
          logger.error(`Não entrou no chat correto após o click simulado. (urlAtual=${urlAtual}, esperado=${chatId})`, { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        // Ativa send-guard imediatamente após confirmar navegação correta.
        // P1 hardening: use o Browser (não a Page) para evitar leak quando a page fecha/desconecta.
        acquireSendGuardBrowser(browser, chatId);

        if (await isChatBlocked(p)) {
          logger.warn('Chat bloqueado/indisponível, marcado respondido', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          resetFail(chatId);
          return;
        }

        // Checagem de contexto antes de aguardar o composer
        if (!(await assertOnChat(p, chatId, { timeoutMs: 1200 }))) {
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          await logIssue(nome, 'mil_action', `virtus_context_abort: url divergiu antes do envio (chat ${chatId})`);
          return;
        }

        let campo = await waitForComposer(p, 10000);
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
          campo = await waitForComposer(p, 8000);
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
          } else {
            try { await pendingDel(nome, chatId); } catch {}
          }
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
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

        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_prepare', chatId });
        try { await campo.focus(); } catch {}
        const isFocused = await p.evaluate((el)=> document.activeElement===el, campo).catch(()=>false);
        if (!isFocused) { try { await campo.focus(); } catch {} }

        // -------- SUBSTITUIR PELO USO sendMessageSafe --------
        await sendMessageSafe(p, campo, msg, nome, chatId);
        // -----------------------------------------------------
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_ok', chatId });

        log(`Mensagem enviada para chat ${chatId}`);
        // Ledger: remove pending ANTES de gravar responded (commit)
        try { await pendingDel(nome, chatId); } catch {}
        const tsNow = agoraEpoch();
        historico[chatId] = tsNow;
        setResponded(chatId, tsNow);
        await salvaHistorico();

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
        const nowKeepalive = Date.now();
        if ((nowKeepalive - Number(lastKeepaliveAt || 0)) >= KEEPALIVE_MIN_GAP_MS) {
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
          const shouldScroll = (Array.isArray(fila) && fila.length > 0) || ((Date.now() - Number(lastScrollToTop || 0)) >= SCROLL_TOP_IDLE_MIN_GAP_MS);
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
        const shouldScrollNow = (Array.isArray(fila) && fila.length > 0) || ((Date.now() - Number(lastScrollToTop || 0)) >= SCROLL_TOP_IDLE_MIN_GAP_MS);
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
        const cooldownOk = (nowMs - Number(lastPageRecycleAt || 0)) >= cooldownMs;
        const idleSafe = !chatAtivo && Array.isArray(fila) && fila.length === 0 && !isVirtusLocked(nome);
        if (hasAdaptivePressure && cooldownOk) {
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
              idleSafe,
              cooldownOk,
              filaSize: Array.isArray(fila) ? fila.length : 0,
              chatAtivo: chatAtivo ? String(chatAtivo) : null
            },
            `virtus.page.recycle.candidate.${String(nome || '')}`,
            30000
          );
        }
        if (hasAdaptivePressure && cooldownOk && idleSafe) {
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
            const t0 = Date.now();
            try {
            const preUrl = (() => { try { return String(p.url() || ''); } catch { return ''; } })();
            const navTimeoutMs = pressureMode === 'critical' ? 12000 : (pressureMode === 'low' ? 18000 : 30000);
            let navStatus = null;
            let navMethod = 'goto';
            let postUrl = '';
            try {
              const navResp = await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
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
                await p.evaluate(() => {
                  try { location.assign('https://www.messenger.com/marketplace'); } catch {}
                });
                const waitBudgetMs = Math.max(6000, Math.floor(navTimeoutMs * 0.8));
                try {
                  await Promise.race([
                    p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: waitBudgetMs }).catch(() => null),
                    p.waitForFunction(
                      () => {
                        try {
                          return !!(location && typeof location.pathname === 'string' && location.pathname.includes('/marketplace'));
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
                  landed = u.includes('/marketplace');
                } catch {}
                if (!landed) {
                  try {
                    landed = !!(await p.evaluate(() => {
                      try { return !!(location && typeof location.pathname === 'string' && location.pathname.includes('/marketplace')); }
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
            } catch (recycleErr) {
              __virtusAgentLog(
                'H11',
                'virtus.js:filaManagerLoop',
                'virtus_page_recycle_failed',
                {
                  nome: String(nome || ''),
                  heapUsedBefore: heapUsed,
                  nodesBefore: nodesUsed,
                  error: String(recycleErr && recycleErr.message ? recycleErr.message : recycleErr)
                },
                `virtus.page.recycle.fail.${String(nome || '')}`,
                30000
              );
            } finally {
              releaseGlobalRecycle(nome);
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
        if (p.url() === 'about:blank' || !/messenger\.com\/marketplace/i.test(p.url())) {
          try {
            if (!running || !epochOk()) return;
            await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); continue;
          }
        }
        if (!running || !epochOk()) return;
        await garantirMarketplace(p, { timeoutMs: 25000 });
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