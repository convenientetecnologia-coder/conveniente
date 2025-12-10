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
const crypto = require('crypto');
const { patchPage, ensureMinimizedWindowForPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');

// Importar o pipeline IA
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');

// Função para criar digest do histórico (deduplicação de chamadas IA)
function historyDigest(msgs) {
  try {
    const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
    const slim = (Array.isArray(msgs) ? msgs : []).map(m => ({ a: m.autor, t: norm(m.texto) }));
    return crypto.createHash('sha1').update(JSON.stringify(slim)).digest('hex');
  } catch { return null; }
}

// Parametrização do ciclo e fila
const AI_COLLECT_WINDOW_MS = parseInt(process.env.VIRTUS_AI_COLLECT_MS || '45000', 10); // 45s
const MIN_SEND_DELAY_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '30000', 10); // 30s
const MAX_SEND_DELAY_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '90000', 10); // 90s
const AI_NOOP_MS        = parseInt(process.env.VIRTUS_AI_NOOP_MS || '900000', 10); // 15min

const MAX_LOCK_REQUEUE = parseInt(process.env.VIRTUS_MAX_LOCK_REQUEUE || '5', 10);

// Locks por perfil de input
const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

// ==== [PATCH] CRITICAL LOCK (ENVIO/COLETA) + BLOQUEIO DE SCROLL ====
const CRITICAL_CHAINS = new Map(); // nome -> promise chain para serializar coletores/envios

async function acquireCritical(p, nome, owner, chatId) {
  const prev = CRITICAL_CHAINS.get(nome) || Promise.resolve();
  let unlock;
  const next = prev.then(() => new Promise(res => { unlock = res; }));
  CRITICAL_CHAINS.set(nome, next);
  await prev;
  try {
    const b = getBrowserFromPage(p);
    if (b) b._virtusCritical = { active: true, owner: String(owner||'unknown'), chatId: String(chatId||''), since: Date.now() };
  } catch {}
  setVirtusInputLock(nome, true);
  try { stepLog.appendJSONL(nome, 'virtus', { step: 'critical_lock_begin', owner, chatId }); } catch {}
  try { stepLog.appendJSONL(nome, 'virtus', { step: 'scroll_lock_begin', owner, chatId }); } catch {}
  return async function release() {
    try { stepLog.appendJSONL(nome, 'virtus', { step: 'scroll_lock_end', owner, chatId }); } catch {}
    setVirtusInputLock(nome, false);
    try {
      const b = getBrowserFromPage(p);
      if (b && b._virtusCritical && b._virtusCritical.owner === owner && b._virtusCritical.chatId === String(chatId||'')) {
        b._virtusCritical.active = false;
      }
    } catch {}
    try { stepLog.appendJSONL(nome, 'virtus', { step: 'critical_lock_end', owner, chatId }); } catch {}
    try { unlock && unlock(); } catch {}
  };
}

// Helpers globais de send-lock/contexto
function getBrowserFromPage(p) { try { return typeof p.browser === 'function' ? p.browser() : null; } catch { return null; } }
async function acquireSendGuard(p, chatId) { try { const b = getBrowserFromPage(p); if (b) b._sendLock = { active: true, owner: 'virtus', chatId, since: Date.now() }; } catch {} }
function releaseSendGuard(p) { try { const b = getBrowserFromPage(p); if (b && b._sendLock && b._sendLock.owner === 'virtus') b._sendLock.active = false; } catch {} }
async function assertOnChat(p, chatId, { timeoutMs = 0 } = {}) {
  const t0 = Date.now();
  while (true) {
    const ok = await p.evaluate((id) => {
      try { return (location && typeof location.pathname === 'string') ? location.pathname.includes('/marketplace/t/' + id) : false; }
      catch { return false; }
    }, chatId).catch(() => false);
    if (ok) return true;
    if (!timeoutMs || (Date.now() - t0) >= timeoutMs) return false;
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


function agoraEpoch() {
  return Math.floor(Date.now() / 1000);
}

const HIST_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_respondidos.json');

// ======= ADIÇÃO: Pending Ledger Helpers & Heurística =======
const PENDING_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_pending.json');

// ======= ADIÇÃO: Chat State Helpers (persistência de estado por chatid) =======
const CHATS_STATE_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_state.json');

async function readChatState(perfil, chatId) {
  const file = CHATS_STATE_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  return cur[chatId] || null;
}

async function updateChatState(perfil, chatId, updates) {
  const file = CHATS_STATE_JSON_NAME(perfil);
  const cur = await readJson(file, {});
  if (!cur[chatId]) cur[chatId] = {};
  Object.assign(cur[chatId], updates);
  await writeJsonAtomicFsync(file, cur);
}

async function getAllChatStates(perfil) {
  const file = CHATS_STATE_JSON_NAME(perfil);
  return await readJson(file, {});
}

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

function isRecentIncoming(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  if (/\b(agora|now)\b/.test(t)) return true;
  if (/\b\d+\s*(s|seg|secs?|seconds?)\b/.test(t)) return true;
  if (/\b\d+\s*(min|m|mins?|minutes?|minutos?)\b/.test(t)) return true;
  return false;
}

// Parser de idade da mensagem: converte "agora", "5 s", "10 min" em milissegundos
function parseMessageAgeMs(tempoLabel) {
  if (!tempoLabel) return 0;
  const t = String(tempoLabel).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  if (/\b(agora|now)\b/.test(t)) return 0;
  const secMatch = t.match(/\b(\d+)\s*(s|seg|secs?|seconds?)\b/);
  if (secMatch) return parseInt(secMatch[1], 10) * 1000;
  const minMatch = t.match(/\b(\d+)\s*(min|m|mins?|minutes?|minutos?)\b/);
  if (minMatch) return parseInt(minMatch[1], 10) * 60 * 1000;
  const hourMatch = t.match(/\b(\d+)\s*(h|hora|hours?|horas?)\b/);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
  return 0; // desconhecido, assume 0
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
        const rowText = (row && (row.innerText || row.textContent) || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const fromMine = /(voce\s+enviou|você\s+enviou|you\s+sent)/i.test(rowText);
        return { id, tempo, href, fromMine };
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
      // SEM foco durante regiões críticas
      setTimeout(() => { if (grid.scrollTop > 0) grid.scrollTop = 0; }, 250);
      return grid.scrollTop === 0;
    });
    return !!res;
  } catch (err) {
    return false;
  }
}

// ========== FIM DOS GUARDRAILS E FUNÇÕES NOVAS ==========

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
  const okPath = await assertOnChat(p, chatId, { timeoutMs: 8000 });
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
    try { stepLog.appendJSONL(nome, 'virtus', { step: 'composer_guard_begin', chatId }); } catch {}
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

    // Digita uma única vez (sem execCommand/insertText)
    await p.keyboard.type(String(msg || ''), { delay: 0 });

    // Revalidar contexto antes do Enter
    if (!(await assertOnChat(p, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(p, campo);
      await logIssue(nome, 'mil_action', `virtus_context_abort: before_enter (chat ${chatId})`);
      return;
    }

    // Envia (um único Enter)
    await p.keyboard.press('Enter');

    // Aguarda confirmação: bolha "Você enviou" ou composer vazio
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
    try { stepLog.appendJSONL(nome, 'virtus', { step: 'composer_guard_end', chatId }); } catch {}
  }
}
// ========== FIM DA FUNÇÃO sendMessageSafe ==========

async function startVirtus(browser, nome, robeMeta = {}) {
  // Na primeira linha dentro de startVirtus, após argumentos:
  let requiredEpoch = 0;
  if (arguments.length >= 3 && arguments[2] && arguments[2].epoch != null) {
    requiredEpoch = arguments[2].epoch;
  }
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

  const state = {
    aiCollectors: new Map(),
    aiNoopUntil: new Map(),
    sendQueue: [],
    sendWorkerActive: false
  };

  let running = true;
  let page = null;
  let historico = {};

  const HIST_FILE = HIST_JSON_NAME(nome);
  const NO_REPEAT_WINDOW_SEC = 12 * 3600; // 12h de bloqueio
  const POLL_INTERVAL_MS = parseInt(process.env.VIRTUS_POLL_MS || '5000', 10);

  // cache em memória e timers
  const RESP_CACHE_MAX = 5000;
  function setResponded(id, ts) {
    if (!respondedCache.has(id) && respondedCache.size >= RESP_CACHE_MAX) {
      const first = respondedCache.keys().next().value;
      if (first !== undefined) respondedCache.delete(first);
    }
    respondedCache.set(id, ts);
  }
  const respondedCache = new Map();

  // MILITAR: Timers unificados
  let filaInterval = null;
  let scrollInterval = null; // Militar: cleaning interval to prevent interval leak

  let lastScrollToTop = 0;

  // trackers
  let saveChain = Promise.resolve();
  let filaLoopBusy = false;
  let recoverBackoffMs = 0;
  const failCounts = new Map();
  // Limpeza/cap failCounts — nunca deve passar de 1000
  function setFailCount(chatId, n) {
    if (!failCounts.has(chatId) && failCounts.size >= 1000) {
      const first = failCounts.keys().next().value;
      if (first !== undefined) failCounts.delete(first);
    }
    failCounts.set(chatId, n);
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
    Object.keys(historico).forEach(id => {
      const ts = Number(historico[id]) || 0;
      if (!ts || (agora - ts) >= NO_REPEAT_WINDOW_SEC) {
        delete historico[id];
        respondedCache.delete(id);
        mudanca = true;
        log(`Histórico limpo: ${id} removido (>24h)`);
      }
    });
    // Garantir cap adicional do respondedCache
    while (respondedCache.size > RESP_CACHE_MAX) {
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
            await installFeedObserver(newP, nome);
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
        if (page) {
          try { await installFeedObserver(page, nome); } catch {}
        }

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

  // Fast-scrape: tenta coletar mensagens do DOM externo sem abrir o chat
  async function fastScrapeChatHistory(p, chatId) {
    try {
      const lastPreview = await p.evaluate((cid) => {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }catch{return String(s||'').trim();} }
        // Procura o link do chat na lista
        const link = Array.from(document.querySelectorAll('a[href^="/marketplace/t/"]')).find(a => {
          const href = a.getAttribute('href') || a.href || '';
          return href.includes(`/marketplace/t/${cid}`);
        });
        if (!link) return null;
        const row = link.closest('div[role="row"]') || link.parentElement;
        if (!row) return null;
        // Tenta extrair preview da última mensagem do row
        const spans = Array.from(row.querySelectorAll('span'));
        const previews = spans.map(s => norm(s.innerText || s.textContent || '')).filter(t => t.length > 0);
        if (previews.length === 0) return null;
        // Retorna apenas a última mensagem visível como preview
        const last = previews[previews.length - 1];
        if (!last || last.length < 3) return null;
        return last;
      }, chatId);
      // ao final de fastScrapeChatHistory:
      return lastPreview ? [{ autor: 'hint', texto: lastPreview }] : null;
    } catch {
      return null;
    }
  }

  // Proteção anti-duplicata de saudação: verifica se já foi enviada saudação recentemente
  function isGreeting(text) {
    if (!text) return false;
    const t = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
    const greetingPatterns = [
      /^(oi|ol[aá]|olá|hello|hi|hey|bom dia|boa tarde|boa noite|bem vindo|bem-vindo|bemvindo)$/i,
      /^(oi|ol[aá]|olá|hello|hi|hey)\s+/i,
      /^(bom dia|boa tarde|boa noite)\s+/i,
      /^bem\s*vind[oa]s?/i
    ];
    return greetingPatterns.some(p => p.test(t));
  }

  function stripGreeting(text) {
    if (!text) return text;
    let t = String(text).trim();
    const greetingPatterns = [
      /^(oi|ol[aá]|olá|hello|hi|hey|bom dia|boa tarde|boa noite|bem vindo|bem-vindo|bemvindo)[\s,\.!]*/i,
      /^(oi|ol[aá]|olá|hello|hi|hey)[\s,\.!]+\s*/i,
      /^(bom dia|boa tarde|boa noite)[\s,\.!]+\s*/i,
      /^bem\s*vind[oa]s?[\s,\.!]+\s*/i
    ];
    for (const p of greetingPatterns) {
      t = t.replace(p, '').trim();
    }
    return t;
  }

  async function wasGreetingSentRecently(chatId, windowHours = 24) {
    try {
      const ts = respondedCache.get(chatId) || Number(historico[chatId] || 0);
      if (!ts) return false;
      const agora = agoraEpoch();
      const ageHours = (agora - ts) / 3600;
      return ageHours < windowHours;
    } catch {
      return false;
    }
  }

  async function scrapeChatHistory(p) {
    // PATCH: coleta robusta de bolhas somente dentro do grid de mensagens
    try {
      await p.waitForFunction(() =>
        !!document.querySelector('div[aria-label^="Mensagens na conversa"],div[role="grid"][aria-label*="conversa"],div[role="grid"][aria-label*="Mensagens"]'),
        { timeout: 5000 }
      ).catch(()=>{});
    } catch {}
    try {
      const msgs = await p.evaluate(() => {
        const norm = (s) => (s || '')
          .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
          .replace(/\s+/g,' ').trim();

        const isVisible = (el) => {
          try {
            const st = getComputedStyle(el);
            if (!st || st.visibility === 'hidden' || st.display === 'none') return false;
            if (el.offsetParent === null) return false;
            const r = el.getBoundingClientRect();
            return r && r.width > 0 && r.height > 0;
          } catch { return false; }
        };

        // container da conversa (grid)
        const grid =
          document.querySelector('div[aria-label^="Mensagens na conversa"]') ||
          document.querySelector('div[role="grid"][aria-label*="conversa"]') ||
          document.querySelector('div[role="grid"][aria-label*="Mensagens"]');
        if (!grid) return [];

        const rows = Array.from(grid.querySelectorAll('div[role="row"]')).slice(-160);

        // Sistema/ruídos frequentes do Messenger (PT/EN/ES)
        const SYS_RX = new RegExp([
          '^classificar o vendedor$', '^mais opcoes?$', '^mais opções$',
          '^marketplace$', '^r\\$\\s?\\d+', '^visto por\\b', '^(reagir|responder|mais)$',
          '^inserir$', '^mensagem$', '^escrever para\\b', '^aa$', '^gif$', '^escolh(a|e) (um|uma) (emoji|figurinha|gif)$',
          '^clipe de voz$', 'arquivo de ate 25 mb', 'figurinha', 'emoji',
          '^[a-z0-9]{1,2}\\s?h$', // "4 h", "2 h"
          '^(seg|ter|qua|qui|sex|sab|dom),?\\s?\\d{1,2}:\\d{2}$', // datas abreviadas
          '^matheo$', // nomes/labels acima da mensagem
          'carregando\\.\\.\\.'
        ].join('|'), 'i');

        function autorResolve(row) {
          try {
            const txt = norm(row.innerText || row.textContent || '');
            if (/(voce|v[óo]c[eê])\s+enviou|you\s+sent/i.test(txt)) return 'ia';
            const st = getComputedStyle(row);
            if (st && (String(st.justifyContent||'').includes('flex-end') || String(st.textAlign||'') === 'right')) {
              return 'ia';
            }
          } catch {}
          return 'cliente';
        }

        function textsFromRow(row) {
          const nodes = Array.from(row.querySelectorAll('div[dir="auto"]'))
            .filter(isVisible)
            .filter(el => !el.closest('[contenteditable="true"]'))
            .filter(el => !el.closest('[role="button"]'))
            .filter(el => !el.closest('[role="toolbar"]'))
            .filter(el => !el.closest('[aria-label^="Reagir"]'))
            .filter(el => !el.closest('[aria-label^="Responder"]'))
            .filter(el => !el.closest('[aria-label^="Mais"]'));

          const texts = nodes
            .map(el => norm(el.innerText || el.textContent || ''))
            .filter(t => t && t.length >= 2 && !SYS_RX.test(t));
          return texts;
        }

        const out = [];
        for (const row of rows) {
          const autor = autorResolve(row);
          const texts = textsFromRow(row);
          for (const t of texts) {
            out.push({ autor, texto: t });
          }
        }
        return out.slice(-40);
      });
      return Array.isArray(msgs) ? msgs : [];
    } catch {
      return [];
    }
  }

  async function ensureConversationReady(p, chatId, { timeoutMs = 20000 } = {}) {
    try {
      // Cura sessão antes do DOM
      const browserJs = require('./browser.js');
      await browserJs.resolveNonceIfPresent(p).catch(()=>{});
      await browserJs.clickContinuarComo(p, { timeout: 8000 }).catch(()=>{});
    } catch {}
    // Aguarda container de mensagens real da conversa
    const selConversation = [
      'div[aria-label^="Mensagens na conversa"]',
      'div[role="grid"][aria-label*="conversa"]',
      'div[role="grid"][aria-label*="Mensagens"]'
    ];
    for (const sel of selConversation) {
      const h = await p.waitForSelector(sel, { timeout: timeoutMs }).catch(()=>null);
      if (h) return true;
    }
    // Fallback: aguarda função/DOM principal
    return await p.waitForFunction(() => {
      const a = document.querySelector('div[aria-label^="Mensagens na conversa"]');
      const b = document.querySelector('div[role="grid"][aria-label]');
      return !!(a || b);
    }, { timeout: timeoutMs }).then(()=>true).catch(()=>false);
  }

  async function scheduleCollector(chatId, idadeMs = 0) {
    try {
      const now = Date.now();
      // Verifica se chat já está em hold ou na fila de envio
      const st0 = await readChatState(nome, chatId).catch(()=>null);
      if (st0 && (st0.sendQueuedAt && Date.now() < (st0.sendHoldUntil || (st0.sendQueuedAt + MAX_SEND_DELAY_MS + 10000)))) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'enqueue_skip_pending', chatId, reason: 'send_queue_hold' });
        return;
      }
      if (state.sendQueue && state.sendQueue.find(it => it && it.chatId === chatId)) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'enqueue_skip_pending', chatId, reason: 'send_already_queued' });
        return;
      }
      if (state.aiCollectors.has(chatId)) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'enqueue_skip_pending', chatId, reason: 'collector_already_scheduled' });
        return;
      }
      if (state.aiNoopUntil.has(chatId) && state.aiNoopUntil.get(chatId) > now) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'enqueue_skip_pending', chatId, reason: 'noop_window' });
        return;
      }
      // Verifica se já está responded
      const ts = respondedCache.get(chatId) || Number(historico[chatId] || 0);
      const agora = agoraEpoch();
      const jaRespondido = ts && (agora - ts) < NO_REPEAT_WINDOW_SEC;
      if (jaRespondido) {
        stepLog.appendJSONL(nome, 'virtus', { step: 'enqueue_skip_responded_window', chatId, age: agora - ts });
        return;
      }
      // Verifica se já está pending
      try {
        const pend = await pendingList(nome);
        if (pend && pend[chatId]) {
          stepLog.appendJSONL(nome, 'virtus', { step: 'enqueue_skip_pending', chatId, reason: 'already_pending' });
          return;
        }
      } catch {}
      
      // REGRA INVIOLÁVEL: Verifica windowEndsAt antes de agendar collector
      const chatState = await readChatState(nome, chatId);
      if (chatState && chatState.windowEndsAt) {
        const agoraEpochNow = agoraEpoch();
        if (agoraEpochNow < chatState.windowEndsAt) {
          const waitSeconds = chatState.windowEndsAt - agoraEpochNow;
          stepLog.appendJSONL(nome, 'virtus', { 
            step: 'collector_waiting_window', 
            chatId, 
            windowEndsAt: chatState.windowEndsAt, 
            waitSeconds,
            firstSeenAt: chatState.firstSeenAt 
          });
          console.log(`[VIRTUS][${nome}] Aguardando janela ativa de coleta para chatId=${chatId}; abre em ${Math.round(waitSeconds)}s`);
          // Agenda para depois do windowEndsAt
          const delayMs = waitSeconds * 1000;
          const attemptId = stepLog.attemptId();
          state.aiCollectors.set(chatId, { timer: null, startedAt: now, attemptId, idadeMs, delayMs, waitingWindow: true });
          const t = setTimeout(() => {
            const ref = state.aiCollectors.get(chatId);
            const fireTime = Date.now();
            const actualDelay = ref ? (fireTime - ref.startedAt) : delayMs;
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'collector_fire', chatId, actualDelay, expectedDelay: delayMs, reason: 'window_ended' });
            stepLog.appendJSONL(nome,'virtus_sla',{ step:'collector_latency', chatId, delayMs: actualDelay });
            finalizeCollector(chatId).catch(()=>{});
          }, delayMs);
          const ref = state.aiCollectors.get(chatId);
          if (ref) ref.timer = t;
          return;
        }
      }
      
      const attemptId = stepLog.attemptId();
      // Calcula delay baseado na idade real da mensagem
      const delayMs = Math.max(0, AI_COLLECT_WINDOW_MS - idadeMs + jitter);
      state.aiCollectors.set(chatId, { timer: null, startedAt: now, attemptId, idadeMs, delayMs });
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'collector_started', chatId, windowMs: AI_COLLECT_WINDOW_MS, idadeMs, delayMs });
      const t = setTimeout(() => {
        const ref = state.aiCollectors.get(chatId);
        const fireTime = Date.now();
        const actualDelay = ref ? (fireTime - ref.startedAt) : delayMs;
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'collector_fire', chatId, actualDelay, expectedDelay: delayMs });
        stepLog.appendJSONL(nome,'virtus_sla',{ step:'collector_latency', chatId, delayMs: actualDelay });
        finalizeCollector(chatId).catch(()=>{});
      }, delayMs);
      const ref = state.aiCollectors.get(chatId);
      if (ref) ref.timer = t;
    } catch {}
  }

  async function finalizeCollector(chatId) {
    const ref = state.aiCollectors.get(chatId);
    if (!ref) return;
    const lockAcquired = chatLock.acquire(nome, chatId);
    if (!lockAcquired) {
      stepLog.appendJSONL(nome, 'virtus', { step:'collector_skip_lock_busy', chatId });
      state.aiCollectors.delete(chatId);
      return;
    }
    const attemptId = ref.attemptId || stepLog.attemptId();
    try {
      if (!running || !epochOk()) return;
      const p = await ensurePage();
      if (!p) return;
      const releaseCrit = await acquireCritical(p, nome, 'collect', chatId);
      try {
        // Garante Marketplace logado e contexto visual
        await garantirMarketplace(p);
        
        // Fast-scrape apenas para logs/plotagem, NUNCA para decisão
        try {
          const fastScrapePreview = await fastScrapeChatHistory(p, chatId);
          if (fastScrapePreview && Array.isArray(fastScrapePreview) && fastScrapePreview.length > 0) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'fast_scrape_preview', chatId, len: fastScrapePreview.length });
          }
        } catch (e) {
          // Ignora erro de fast-scrape, não afeta decisão
        }
        
        // RIGOR: SEMPRE abre o chat após timer expirar (não usa fast_scrape para decidir)
        const chatState = await readChatState(nome, chatId);
        const timerExpired = chatState && chatState.windowEndsAt ? (agoraEpoch() >= chatState.windowEndsAt) : false;
        const timeSinceFirstSeen = chatState && chatState.firstSeenAt ? (agoraEpoch() - chatState.firstSeenAt) : 0;
        stepLog.appendJSONL(nome, 'virtus', { 
          attempt: attemptId, 
          step: 'chat_window_opened_for_collection', 
          chatId, 
          timerExpired, 
          timeSinceFirstSeen,
          windowEndsAt: chatState?.windowEndsAt 
        });
        console.log(`[VIRTUS][${nome}] Timer expirado: abrindo chat chatId=${chatId} para coleta real...`);
        const opened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, attemptId, nome });
        if (!opened) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: 'open_by_click_failed' });
          console.warn(`[VIRTUS][${nome}] Falha ao abrir chat (clickChatInFeed=false) chatId=${chatId}`);
          state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
          return;
        }
        console.log(`[VIRTUS][${nome}] Chat aberto OK chatId=${chatId}. Coletando histórico...`);
        
        // SEMPRE executa ensureConversationReady e scrapeChatHistory após abrir
        await ensureConversationReady(p, chatId, { timeoutMs: 16000 });
        let historicoMsgs = await scrapeChatHistory(p);
        
        // Se histórico vazio, tenta novamente com ciclo de tentativas
        if (!historicoMsgs || historicoMsgs.length === 0) {
          for (let tryNo = 1; tryNo <= 3; tryNo++) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'conv_wait', chatId, tryNo });
            const ready = await ensureConversationReady(p, chatId, { timeoutMs: 16000 });
            await sleep(300 + (tryNo*150));
            try {
              historicoMsgs = await scrapeChatHistory(p);
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'scrape_result', chatId, tryNo, len: (historicoMsgs||[]).length, sample: (historicoMsgs[0] && historicoMsgs[0].texto) ? String(historicoMsgs[0].texto).slice(0,80) : '' });
            } catch (e) {
              const emsg = (e && e.message) || String(e);
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'scrape_error', chatId, tryNo, error: emsg });
              console.warn(`[VIRTUS][${nome}] [WARN] Erro ao coletar histórico — chatId=${chatId} tryNo=${tryNo} error=${emsg}`);
              if (/detached/i.test(emsg)) {
                const reopened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, attemptId, nome });
                if (!reopened) break;
                continue;
              }
            }
            if (Array.isArray(historicoMsgs) && historicoMsgs.length > 0) break;
            await p.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
            await sleep(500);
          }
        }
        
        // Log de histórico coletado com hashes
        const msgHashes = historicoMsgs ? historicoMsgs.map(m => {
          const txt = String(m.texto || '').slice(0, 50);
          return txt.length > 0 ? txt.replace(/\s+/g, ' ').trim().slice(0, 30) : '';
        }).filter(h => h.length > 0) : [];
        stepLog.appendJSONL(nome, 'virtus', { 
          attempt: attemptId, 
          step: 'chat_history_collected', 
          chatId, 
          len: historicoMsgs?.length || 0, 
          hashes: msgHashes.slice(0, 5) 
        });
        
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'collector_done', chatId, msgs: historicoMsgs.length });
        console.log(`[VIRTUS][${nome}] chat_history_collected chatId=${chatId} len=${historicoMsgs?.length||0}`);
        if (!historicoMsgs || historicoMsgs.length === 0) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: 'no_messages_after_retries' });
          console.warn(`[VIRTUS][${nome}] Coleta vazia após abertura de chat chatId=${chatId}. Marcando NOOP 15min e abortando.`);
          await updateChatState(nome, chatId, { llmInFlightSig: null }).catch(()=>{});
          state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
          return;
        }
        
        // NEW: finalizeCollector — abortar IA sem bolha nova cliente
        const debugMsgs = Array.isArray(historicoMsgs) ? historicoMsgs : [];
        for (let i = Math.max(0, debugMsgs.length - 12); i < debugMsgs.length; i++) {
          const m = debugMsgs[i];
          try {
            require('./stepLog.js').appendJSONL(nome, 'virtus', {
              step: 'dom_bubble_debug',
              chatId,
              idx: i,
              autor: m && m.autor,
              sample: (m && m.texto ? String(m.texto).slice(0, 80) : '')
            });
          } catch {}
        }
        const last = debugMsgs.slice(-1)[0] || null;
        if (!last || last.autor !== 'cliente') {
          require('./stepLog.js').appendJSONL(nome, 'virtus', {
            step: 'llm_skip_no_new_client_bubble',
            chatId,
            len: debugMsgs.length
          });
          // NÃO atualize hash, NÃO enqueueSend, NÃO rode IA, apenas aguarde novo evento.
          state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
          return;
        }
        
        // NEW: historyDigest só após bolha cliente válida
        const histSig = (function(){
          try {
            const slim = (debugMsgs || []).map(m => ({ a: m.autor, t: String(m.texto||'').slice(0,120) }));
            return require('crypto').createHash('sha1').update(JSON.stringify(slim)).digest('hex');
          } catch { return null; }
        })();
        const stPrev = await readChatState(nome, chatId).catch(()=>null);
        if (stPrev && (stPrev.llmInFlightSig === histSig || stPrev.lastHistSig === histSig)) {
          require('./stepLog.js').appendJSONL(nome, 'virtus', { step: 'llm_skip_duplicate_history', chatId });
          await updateChatState(nome, chatId, { llmInFlightSig: null }).catch(()=>{});
          state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
          return;
        }
        await updateChatState(nome, chatId, { llmInFlightSig: histSig }).catch(()=>{});
        
        const ctx = {};
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_start', chatId });
        console.log(`[VIRTUS][${nome}] Enviando histórico para IA chatId=${chatId}...`);
        let llm;
        try {
          llm = await masterExtractAnswer({
            perfil: nome,
            chatId,
            mensagens: historicoMsgs,
            contexto: ctx,
            respond: true
          });
        } catch (e) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_exception', chatId, error: (e && e.message) || String(e) });
          console.error(`[VIRTUS][${nome}] [ERRO] Exceção ao chamar IA — chatId=${chatId} error=${(e && e.message) || String(e)}`);
          await updateChatState(nome, chatId, { llmInFlightSig: null }).catch(()=>{});
          return;
        }
        if (!llm || !llm.control || llm.control.shouldReply !== true || !llm.answer || !String(llm.answer).trim()) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: (llm && llm.meta && llm.meta.error) || 'no_answer' });
          await updateChatState(nome, chatId, { llmInFlightSig: null }).catch(()=>{});
          state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
          return;
        }
        
        // Verifica se WhatsApp foi coletado e atualiza estado
        const extracted = (llm && llm.extraction) || {};
        const whatsapp = extracted.telefone || extracted.whatsapp || null;
        if (whatsapp && /^\d{10,11}$/.test(String(whatsapp).replace(/\D/g, ''))) {
          const now = agoraEpoch();
          const whatsCollectedAt = now;
          const deadline10m = now + 600; // 10 minutos em segundos
          await updateChatState(nome, chatId, {
            whatsCollectedAt,
            deadline10m,
            phase: 'coletando-campos',
            fields: {
              whatsapp: String(whatsapp),
              item: extracted.item || null,
              enderecos: extracted.endereco_saida || extracted.endereco_destino || null,
              cidade: null
            }
          });
          stepLog.appendJSONL(nome, 'virtus', { 
            attempt: attemptId, 
            step: 'whatsapp_detected', 
            chatId, 
            whatsapp, 
            timestamp: whatsCollectedAt,
            deadline10m 
          });
          console.log(`[VIRTUS][${nome}] WhatsApp detectado chatId=${chatId}. Janela de 10 minutos iniciada (deadline=${new Date(deadline10m*1000).toISOString()})`);
        }
        let answerText = String(llm.answer).trim();
        // Proteção anti-duplicata de saudação
        if (isGreeting(answerText)) {
          const wasSent = await wasGreetingSentRecently(chatId, 24);
          if (wasSent) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'greeting_stripped', chatId, reason: 'greeting_sent_recently' });
            // Remove saudação e tenta usar o resto
            answerText = stripGreeting(answerText);
            if (!answerText || answerText.length < 3) {
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: 'only_greeting_after_strip' });
              console.warn(`[VIRTUS][${nome}] [WARN] Resposta ficou vazia após remover saudação — chatId=${chatId} reason=only_greeting_after_strip`);
              await updateChatState(nome, chatId, { llmInFlightSig: null }).catch(()=>{});
              state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
              return;
            }
          }
        }
        // Remove saudação redundante mesmo se não foi enviada recentemente (fail-safe)
        const stripped = stripGreeting(answerText);
        if (stripped !== answerText && stripped.length >= 3) {
          answerText = stripped;
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'greeting_stripped', chatId, reason: 'redundancy_removal' });
        }
        
        // fix: finalizeCollector só enqueueSend se resposta IA não for vazia
        if (!answerText || answerText.trim().length < 2) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: 'empty_after_filters' });
          await updateChatState(nome, chatId, { llmInFlightSig: null }).catch(()=>{});
          state.aiNoopUntil.set(chatId, Date.now() + AI_NOOP_MS);
          return;
        }
        
        console.log(`[VIRTUS][${nome}] Resposta programada para envio chatId=${chatId}: "${String(answerText).slice(0,64)}..."`);
        // RIGOR: enqueueSend só é chamado após collector bem-sucedido (histórico coletado e LLM processado)
        // Patch F - Final message/lock 72h: marcar phase: 'finalizado' quando todos os campos coletados ou deadline 10min atingido
        const extractedFinal = (llm && llm.extraction) || {};
        const hasWhatsappFinal = isValidBRPhoneWithDDD(extractedFinal.telefone);
        const hasItemFinal = !!(extractedFinal.item);
        const hasEnderecoSaidaFinal = !!(extractedFinal.endereco_saida);
        const hasEnderecoDestinoFinal = !!(extractedFinal.endereco_destino);
        const allFieldsCompleteFinal = hasWhatsappFinal && hasItemFinal && hasEnderecoSaidaFinal && hasEnderecoDestinoFinal;
        const chatStateFinal = await readChatState(nome, chatId).catch(()=>null);
        const deadline10mFinal = chatStateFinal && chatStateFinal.deadline10m ? chatStateFinal.deadline10m : null;
        const deadlineReachedFinal = deadline10mFinal && agoraEpoch() >= deadline10mFinal;
        if (allFieldsCompleteFinal || deadlineReachedFinal) {
          const lockedUntil = Date.now() + (72 * 3600 * 1000); // 72h
          await updateChatState(nome, chatId, { phase: 'finalizado', lockedUntil }).catch(()=>{});
          chatLock.acquire(nome, chatId);
          setTimeout(() => {
            try { chatLock.release(nome, chatId); } catch {}
          }, 72 * 3600 * 1000);
        }
        enqueueSend(chatId, answerText, attemptId);
        await updateChatState(nome, chatId, { lastHistSig: histSig, llmInFlightSig: null }).catch(()=>{});
      } finally {
        await releaseCrit();
      }
    } finally {
      try {
        const r = state.aiCollectors.get(chatId);
        if (r && r.timer) clearTimeout(r.timer);
        state.aiCollectors.delete(chatId);
      } catch {}
      try { chatLock.release(nome, chatId); } catch {}
    }
  }

  function enqueueSend(chatId, answer, attemptId) {
    try {
      // RIGOR: Verifica se já existe item na fila para este chatId (evita duplicação)
      if (state.sendQueue.find(it => it && it.chatId === chatId)) {
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_dedup_skip', chatId });
        console.warn(`[VIRTUS][${nome}] [WARN] Envio duplicado ignorado — chatId=${chatId}`);
        return;
      }
      // RIGOR: Esta função só deve ser chamada após collector bem-sucedido (histórico coletado e LLM processado)
      // processSendQueue NÃO pode enviar resposta se chat não foi coletado/handled
      const answerHash = String(answer || '').slice(0, 50).replace(/\s+/g, ' ').trim();
      state.sendQueue.push({ chatId, answer, attemptId: attemptId || stepLog.attemptId(), queuedAt: Date.now(), attempts: 0, answerHash });
      // Dedupe rigoroso por pending/hold imediato
      try { pendingAdd(nome, chatId, attemptId).catch(()=>{}); } catch {}
      try {
        updateChatState(nome, chatId, {
          sendQueuedAt: Date.now(),
          sendHoldUntil: Date.now() + (MAX_SEND_DELAY_MS + 10000)
        }).catch(()=>{});
      } catch {}
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'queued_send', chatId, answerLen: String(answer||'').length });
      processSendQueue().catch(()=>{});
    } catch {}
  }

  async function processSendQueue() {
    if (state.sendWorkerActive) return;
    state.sendWorkerActive = true;
    try {
      if (state.aiCollectors.size > 3 || state.sendQueue.length > 3) {
        if (issues && typeof issues.append === 'function') {
          try { await issues.append('system','queue_overload',`aiCollectors=${state.aiCollectors.size} sendQueue=${state.sendQueue.length}`); } catch {}
        }
      }
      while (running && epochOk() && state.sendQueue.length > 0) {
        const item = state.sendQueue.shift();
        const { chatId, answer, attemptId } = item || {};
        if (!chatId || !answer) continue;
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_dequeued', chatId });
        console.log(`[VIRTUS][${nome}] Enviando resposta ao chatId=${chatId}: "${String(answer).slice(0,64)}..."`);
        let _chatLockAcquired = false;
        let p = null;
        try {
          if (!chatLock.acquire(nome, chatId)) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'chat_lock_busy', chatId });
            console.warn(`[VIRTUS][${nome}] chat_lock_busy chatId=${chatId} — envio postergado.`);
            item.attempts = (item.attempts || 0) + 1;
            if (item.attempts <= MAX_LOCK_REQUEUE) {
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_requeue_lock_busy', chatId, attempts: item.attempts });
              setTimeout(() => { try { state.sendQueue.unshift(item); processSendQueue().catch(()=>{}); } catch {} }, 500 + Math.floor(Math.random()*900));
            } else {
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_drop_lock_busy', chatId, attempts: item.attempts });
              try { await pendingDel(nome, chatId); } catch {}
            }
            continue;
          }
          _chatLockAcquired = true;
          p = await ensurePage();
          if (!p) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_abort_no_page', chatId });
            console.warn(`[VIRTUS][${nome}] [WARN] Página não disponível para envio — chatId=${chatId}`);
            continue;
          }
          const releaseCrit = await acquireCritical(p, nome, 'send', chatId);
          let pendingCreated = false;
          try {
            await garantirMarketplace(p);
            const opened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, attemptId, nome });
            if (!opened) {
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'composer_missing_send', chatId, reason: 'open_by_click_failed' });
              console.warn(`[VIRTUS][${nome}] [WARN] Falha ao abrir chat para envio — chatId=${chatId} reason=open_by_click_failed`);
              if (issues && typeof issues.append === 'function') {
                await issues.append(nome, 'virtus_no_composer', `open_by_click_failed chat=${chatId} (sendQueue)`);
              }
              continue;
            }
            await acquireSendGuard(p, chatId);
            const campo = await waitForComposer(p, 10000);
            if (!campo) {
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'composer_missing_send', chatId });
              console.warn(`[VIRTUS][${nome}] [WARN] Composer ausente — chatId=${chatId}`);
              if (issues && typeof issues.append === 'function') {
                await issues.append(nome, 'virtus_no_composer', `composer ausente chat=${chatId} (sendQueue)`);
              }
              continue;
            }
            
            // REGRA: pendingAdd só DEPOIS de lock/open/composer
            try {
              const answerHash = item.answerHash || String(answer || '').slice(0, 50).replace(/\s+/g, ' ').trim();
              const file = PENDING_JSON_NAME(nome);
              const cur = await readJson(file, {});
              cur[chatId] = { 
                attemptId, 
                startedAt: Date.now(), 
                phase: 'typed',
                attempts: (item.attempts || 0) + 1,
                answerHash
              };
              await writeJsonAtomicFsync(file, cur);
              pendingCreated = true;
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'pending_created', chatId, phase: 'typed' });
            } catch (e) {
              stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'pending_create_failed', chatId, error: (e && e.message) || String(e) });
            }
            
            await sendMessageSafe(p, campo, answer, nome, chatId);
            
            // Verifica ACK positivo antes de marcar responded
            const ackOk = await p.evaluate(() => {
              const norm = s => String(s||'').toLowerCase();
              const nodes = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-25);
              const hasYouSent = nodes.some(el => /you\s+sent|v[ou]c[eê]\s+enviou/.test(norm(el.innerText||el.textContent||'')));
              if (hasYouSent) return true;
              // Verifica se composer está limpo
              const composer = document.querySelector('div[contenteditable="true"][role="textbox"]');
              if (composer && (composer.innerText || composer.textContent || '').trim().length === 0) {
                // Verifica se há nova bubble "me" após o composer
                const bubbles = Array.from(document.querySelectorAll('div[dir="auto"]')).slice(-5);
                const meBubbles = bubbles.filter(b => {
                  const style = window.getComputedStyle(b.closest('div[role="row"]') || b);
                  return style && (style.justifyContent === 'flex-end' || style.textAlign === 'right');
                });
                if (meBubbles.length > 0) return true;
              }
              return false;
            }).catch(() => false);
            
            if (!ackOk) {
              item.attempts = (item.attempts || 0) + 1;
              if (item.attempts <= 3) {
                stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_ack_failed_requeue', chatId, attempts: item.attempts });
                console.warn(`[VIRTUS][${nome}] Falha para confirmar envio (ACK) chatId=${chatId} tentativas=${item.attempts||0}`);
                try { await pendingDel(nome, chatId); } catch {}
                state.sendQueue.push(item); // Requeue
                if (pendingCreated) {
                  pendingCreated = false;
                }
                continue;
              } else {
                stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_ack_failed_max_attempts', chatId, attempts: item.attempts });
                console.warn(`[VIRTUS][${nome}] Falha para confirmar envio (ACK) chatId=${chatId} tentativas=${item.attempts||0}`);
                if (issues && typeof issues.append === 'function') {
                  try { await issues.append(nome, 'virtus_send_no_ack', `chat=${chatId} sem ACK após ${item.attempts} tentativas`); } catch {}
                }
                if (pendingCreated) {
                  try { await pendingDel(nome, chatId); } catch {}
                  pendingCreated = false;
                }
                continue;
              }
            }
            
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_ok', chatId });
            console.log(`[VIRTUS][${nome}] Resposta enviada com sucesso chatId=${chatId}`);
            
            // REGRA: Delay 30-90s ANTES de marcar responded
            const delay = randomBetween(MIN_SEND_DELAY_MS, MAX_SEND_DELAY_MS);
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_delay_before_responded', chatId, delayMs: delay });
            console.log(`[VIRTUS][${nome}] Delay applied before marcar responded chatId=${chatId} delayMs=${delay}`);
            await sleep(delay);
            
            // Verifica deadline10m e fecha pedido se necessário
            const chatState = await readChatState(nome, chatId);
            if (chatState && chatState.whatsCollectedAt && chatState.deadline10m) {
              const agora = agoraEpoch();
              const fields = chatState.fields || {};
              const hasWhatsapp = !!(fields.whatsapp);
              const hasCidade = !!(fields.cidade);
              const hasItem = !!(fields.item);
              
              if (agora >= chatState.deadline10m) {
                // Timeout de 10min: fecha como incompleto
                if (hasWhatsapp && !hasCidade) {
                  await updateChatState(nome, chatId, { phase: 'finalizado', fields: { ...fields, cidade: 'incompleto' } });
                  stepLog.appendJSONL(nome, 'virtus', { 
                    attempt: attemptId, 
                    step: 'pedido_fechado_automatico', 
                    chatId, 
                    causa: 'fechamento automático 10min',
                    whatsapp: hasWhatsapp,
                    cidade: hasCidade,
                    item: hasItem
                  });
                  console.log(`[VIRTUS][${nome}] Fechamento automático após 10min chatId=${chatId} (faltou campos).`);
                }
              } else if (hasWhatsapp && hasCidade && hasItem) {
                // Todos os campos preenchidos antes do deadline
                await updateChatState(nome, chatId, { phase: 'finalizado' });
                stepLog.appendJSONL(nome, 'virtus', { 
                  attempt: attemptId, 
                  step: 'pedido_fechado_completo', 
                  chatId, 
                  causa: 'fechamento completo before deadline',
                  whatsapp: hasWhatsapp,
                  cidade: hasCidade,
                  item: hasItem
                });
                console.log(`[VIRTUS][${nome}] Pedido fechado completo chatId=${chatId} (todos os campos antes do prazo).`);
              }
            }
            
            // REGRA: Marca responded só após ACK e delay
            const tsNow = agoraEpoch();
            historico[chatId] = tsNow;
            setResponded(chatId, tsNow);
            await salvaHistorico();
            if (pendingCreated) {
              try { await pendingDel(nome, chatId); } catch {}
            }
          } finally {
            await releaseCrit();
            if (pendingCreated && !running) {
              try { await pendingDel(nome, chatId); } catch {}
            }
          }
        } catch (e) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_fail', chatId, error: (e && e.message) || String(e) });
          console.error(`[VIRTUS][${nome}] [ERRO] Falha ao enviar mensagem — chatId=${chatId} error=${(e && e.message) || String(e)}`);
          if (issues && typeof issues.append === 'function') {
            try { await issues.append(nome, 'virtus_send_failed', `queue chat=${chatId} ${e && e.message || e}`); } catch {}
          }
        } finally {
          try { releaseSendGuard(p); } catch {}
          if (_chatLockAcquired) {
            try { chatLock.release(nome, chatId); } catch {}
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'chat_unlock', chatId });
          }
        }
      }
    } finally {
      state.sendWorkerActive = false;
    }
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
      const filtrados = todos.filter(c => c.id && isRecentIncoming(c.tempo) && !c.fromMine);
      // Adiciona idadeMs para cada chat
      return filtrados.map(c => ({
        ...c,
        idadeMs: parseMessageAgeMs(c.tempo)
      }));
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
          const opened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, nome });
          if (!opened) {
            await pendingDel(nome, chatId);
            continue;
          }
          const looksSent = await wasRecentlySentByMe(p, 10*60*1000);
          if (looksSent) {
            // considera “committed”
            const tsNow = agoraEpoch();
            historico[chatId] = tsNow;
            setResponded(chatId, tsNow);
            await salvaHistorico();
            await pendingDel(nome, chatId);
          } else {
            // rollback: libera para reenvio
            await pendingDel(nome, chatId);
          }
        } catch { /* segue próximo */ }
      }
    } catch {}
  }

  async function bootstrapHistorico() {
    if (!running || !epochOk()) return;
    try {
      await fs.access(HIST_FILE);
      await carregaHistorico();
      await reconcilePendingsIfAny();
      log('Histórico existente carregado. Retomando pendentes.');
      return;
    } catch {}

    log('[BOOTSTRAP] Primeiro boot sem histórico: SNAPSHOT INSTANTÂNEO (sem varredura/scroll).');
    if (!running || !epochOk()) return;
    const p = await ensurePage();
    if (!p) { log('[BOOTSTRAP] Falha ao garantir aba zero.'); return; }
    if (!running || !epochOk()) return;
    await garantirMarketplace(p);
    try { await scrollChatsToTop(p, nome); } catch {}
    await sleep(350); // Pequeno delay para DOM estabilizar

    // Único passe, snapshot imediato de todos os chats visíveis neste momento!
    const todos = await coletaChatsMarketplaceTodos(p);
    const ids = new Set();
    for (const c of todos) if (c.id) ids.add(c.id);

    const agora = agoraEpoch();
    historico = {};
    for (const id of ids) historico[id] = agora;

    // Sempre grava — mesmo se vazio
    await salvaHistorico();
    await carregaHistorico();
    await reconcilePendingsIfAny();
    log(`[BOOTSTRAP] Snapshot inicial gravado. chats=${ids.size} (arquivo criado mesmo vazio).`);
  }

  // Função auxiliar para evaluateChatsState (similar à worker.js)
  async function evaluateChatsState(p) {
    try {
      const res = await p.evaluate(() => {
        const norm = (s) => (s||'').toLowerCase();
        let grid = Array.from(document.querySelectorAll('div[role="grid"]'))
        .find(g => {
          const al = (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby') || '');
          const t = norm(al);
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
          rows = grid.querySelectorAll('div[role="row"]').length;
          anchors = grid.querySelectorAll('a[href^="/marketplace/t/"]').length;
          skeletons = grid.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
        } else {
          skeletons = document.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
        }
        return { hasGrid: !!grid, rows, anchors, skeletons };
      });
      return res || { hasGrid:false, rows:0, anchors:0, skeletons:0 };
    } catch {
      return { hasGrid:false, rows:0, anchors:0, skeletons:0 };
    }
  }

  async function atualizaFila() {
    let mudancaFila = false;
    const p = await ensurePage();
    let chatsState = null;
    try {
      chatsState = await evaluateChatsState(p);
    } catch {}
    const ts = Date.now();
    const chatsNovos = await coletaChatsMarketplaceRecentes();
    const agora = agoraEpoch();

    // Log mesmo se não houver chats novos
    if (chatsNovos.length === 0) {
      stepLog.appendJSONL(nome, 'virtus', { 
        step: 'poll_zero_new_chats', 
        rows: chatsState?.rows || 0, 
        anchors: chatsState?.anchors || 0, 
        skeletons: chatsState?.skeletons || 0, 
        ts 
      });
      console.log(`[VIRTUS][${nome}] Nenhum chat novo detectado para atendimento.`);
    }

    for (const c of chatsNovos) {
      const ts = respondedCache.get(c.id) || Number(historico[c.id] || 0);
      const jaRespondido = ts && (agora - ts) < NO_REPEAT_WINDOW_SEC;
      
      // Verifica se já está pending ou agendado
      const pend = await pendingList(nome).catch(() => ({}));
      const jaPending = pend && pend[c.id];
      const jaAgendado = state.aiCollectors.has(c.id);
      
      if (!jaRespondido && !jaPending && !jaAgendado) {
        // Chat novo: registra firstSeenAt e windowEndsAt
        const now = Date.now();
        const firstSeenAt = agoraEpoch();
        const windowEndsAt = firstSeenAt + Math.floor(AI_COLLECT_WINDOW_MS / 1000);
        await updateChatState(nome, c.id, {
          firstSeenAt,
          windowEndsAt,
          phase: 'aguardando'
        });
        stepLog.appendJSONL(nome, 'virtus', { 
          step: 'chat_new_detected', 
          chatId: c.id, 
          firstSeenAt, 
          windowEndsAt,
          windowMs: AI_COLLECT_WINDOW_MS 
        });
        console.log(`[VIRTUS][${nome}] Timer 45s iniciado para chatId=${c.id} (firstSeen=${new Date(firstSeenAt*1000).toISOString()})`);
      }
      
      if (!jaRespondido) {
        await scheduleCollector(c.id, c.idadeMs || 0);
      }
    }

    return false;
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

      if (limpaHistoricoVelho()) await salvaHistorico();

      await atualizaFila();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running || !epochOk()) return;
          try {
            const b = getBrowserFromPage(p);
            if (b && ((b._sendLock && b._sendLock.active) || (b._virtusCritical && b._virtusCritical.active))) return;
          } catch {}
          try {
            const ok = await scrollChatsToTop(p, nome);
            if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'OK' : 'FAIL'); }
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
        }, 30000);
        setTimeout(() => {
          if (!running || !epochOk()) return;
          try {
            const b = getBrowserFromPage(p);
            if (b && ((b._sendLock && b._sendLock.active) || (b._virtusCritical && b._virtusCritical.active))) return;
          } catch {}
          scrollChatsToTop(p, nome);
        }, 800);
      }
      try {
        const scrolled = await scrollChatsToTop(p, nome);
        if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', scrolled ? 'OK' : 'FAIL'); }
        if (scrolled) {
          lastScrollToTop = Date.now();
        }
        // Reforço após 800ms para garantir Messenger reativo
        setTimeout(() => {
          if (!running || !epochOk()) return;
          try {
            const b = getBrowserFromPage(p);
            if (b && b._sendLock && b._sendLock.active) return;
          } catch {}
          scrollChatsToTop(p, nome);
        }, 800);
      } catch {}

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
    await bootstrapHistorico();
    filaInterval = setInterval(filaManagerLoop, POLL_INTERVAL_MS);
    filaManagerLoop();
  }

  runner();

  return {
    stop: async () => {
      stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'stop' });
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      try {
        for (const [cid, ref] of state.aiCollectors.entries()) {
          if (ref && ref.timer) clearTimeout(ref.timer);
        }
        state.aiCollectors.clear();
        state.sendQueue.length = 0;
        state.sendWorkerActive = false;
      } catch {}
      let pages = [];
      try { pages = await browser.pages(); } catch {}
      if (robeMeta && typeof nome !== "undefined") {
        if (!robeMeta[nome]) robeMeta[nome] = {};
        robeMeta[nome].numPages = pages.length;
      }
      // ========== Limpeza para evitar leaks ==========
      delete virtusDeadLogTimes[nome];
      try { respondedCache.clear(); } catch {}
      try { failCounts.clear(); } catch {}
      try { historico = {}; } catch {}
    }
  };
}

module.exports = {
  startVirtus
};