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
const { patchPage, ensureMinimizedWindowForPage } = require('./browser.js');
const utils = require('./utils.js');
const stepLog = require('./stepLog.js');
const chatLock = require('./chatLock.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');

// Importar o pipeline IA
const { masterExtractAnswer } = require('./inteligenciaArtificial.js');

// Parametrização do ciclo e fila
const AI_COLLECT_WINDOW_MS = parseInt(process.env.VIRTUS_AI_COLLECT_MS || '45000', 10); // 45s
const MIN_SEND_DELAY_MS = parseInt(process.env.MESSENGER_INTERVALO_MIN_MS || '30000', 10); // 30s
const MAX_SEND_DELAY_MS = parseInt(process.env.MESSENGER_INTERVALO_MAX_MS || '90000', 10); // 90s
const AI_NOOP_MS        = parseInt(process.env.VIRTUS_AI_NOOP_MS || '900000', 10); // 15min

const AI_COLLECTORS = new Map();      // chatId -> { timer, startedAt, attemptId }
const AI_NOOP_UNTIL = new Map();      // chatId -> timestamp Ms
const SEND_QUEUE = [];                // [{ chatId, answer, attemptId }]
let SEND_WORKER_ACTIVE = false;

// Locks por perfil de input
const VIRTUS_INPUT_LOCKS = new Map();
function setVirtusInputLock(nome, v){ if (v) VIRTUS_INPUT_LOCKS.set(nome,true); else VIRTUS_INPUT_LOCKS.delete(nome); }
function isVirtusLocked(nome){ return VIRTUS_INPUT_LOCKS.has(nome); }

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
  const POLL_INTERVAL_MS = 30_000; // polling de novos chats
  const MIN_REPLY_DELAY_MS = 60_000;
  const MAX_REPLY_DELAY_MS = 120_000;

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
  let filaChatTimer = null;
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

  async function scrapeChatHistory(p) {
    // Aguarda boot mínimo da thread (não explode)
    try {
      await p.waitForFunction(() =>
        Array.from(document.querySelectorAll('div[dir="auto"]')).some(d => (d.innerText || d.textContent || '').trim().length > 0),
        { timeout: 4000 }
      ).catch(()=>{});
    } catch {}
    try {
      return await p.evaluate(() => {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }catch{return String(s||'').trim();} }
        // Novas bubbles: todas div[dir="auto"] com texto significativo
        const candidates = Array.from(document.querySelectorAll('div[dir="auto"]'))
          .map(el => ({
            text: norm(el.innerText || el.textContent || ''),
            el
          }))
          .filter(x => x.text && x.text.length > 0);
        // Heurística de autor: alinhamento ou ancestrais "Você enviou"
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
        // Filtro spam
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

  function scheduleCollector(chatId) {
    try {
      const now = Date.now();
      if (AI_COLLECTORS.has(chatId)) return;
      if (AI_NOOP_UNTIL.has(chatId) && AI_NOOP_UNTIL.get(chatId) > now) return;
      const attemptId = stepLog.attemptId();
      AI_COLLECTORS.set(chatId, { timer: null, startedAt: now, attemptId });
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'collector_started', chatId, windowMs: AI_COLLECT_WINDOW_MS });
      const t = setTimeout(() => {
        finalizeCollector(chatId).catch(()=>{});
      }, AI_COLLECT_WINDOW_MS);
      const ref = AI_COLLECTORS.get(chatId);
      if (ref) ref.timer = t;
    } catch {}
  }

  async function finalizeCollector(chatId) {
    const ref = AI_COLLECTORS.get(chatId);
    if (!ref) return;
    const attemptId = ref.attemptId || stepLog.attemptId();
    try {
      if (!running || !epochOk()) return;
      const p = await ensurePage();
      if (!p) return;
      // Garante Marketplace logado e contexto visual
      await garantirMarketplace(p);
      const opened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, attemptId, nome });
      if (!opened) {
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: 'open_by_click_failed' });
        AI_NOOP_UNTIL.set(chatId, Date.now() + AI_NOOP_MS);
        return;
      }
      // Ciclo de 3 tentativas de estabilização do DOM
      let historicoMsgs = [];
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
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'collector_done', chatId, msgs: historicoMsgs.length });
      if (!historicoMsgs || historicoMsgs.length === 0) {
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: 'no_messages_after_retries' });
        AI_NOOP_UNTIL.set(chatId, Date.now() + AI_NOOP_MS);
        return;
      }
      const ctx = {};
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_start', chatId });
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
        return;
      }
      if (!llm || !llm.control || llm.control.shouldReply !== true || !llm.answer || !String(llm.answer).trim()) {
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'llm_no_send', chatId, reason: (llm && llm.meta && llm.meta.error) || 'no_answer' });
        AI_NOOP_UNTIL.set(chatId, Date.now() + AI_NOOP_MS);
        return;
      }
      enqueueSend(chatId, llm.answer, attemptId);
    } finally {
      try {
        const r = AI_COLLECTORS.get(chatId);
        if (r && r.timer) clearTimeout(r.timer);
        AI_COLLECTORS.delete(chatId);
      } catch {}
    }
  }

  function enqueueSend(chatId, answer, attemptId) {
    try {
      SEND_QUEUE.push({ chatId, answer, attemptId: attemptId || stepLog.attemptId(), queuedAt: Date.now() });
      stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'queued_send', chatId, answerLen: String(answer||'').length });
      processSendQueue().catch(()=>{});
    } catch {}
  }

  async function processSendQueue() {
    if (SEND_WORKER_ACTIVE) return;
    SEND_WORKER_ACTIVE = true;
    try {
      while (running && epochOk() && SEND_QUEUE.length > 0) {
        const item = SEND_QUEUE.shift();
        const { chatId, answer, attemptId } = item || {};
        if (!chatId || !answer) continue;
        stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_dequeued', chatId });
        let _chatLockAcquired = false;
        let p = null;
        try {
          if (!chatLock.acquire(nome, chatId)) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'chat_lock_busy', chatId });
            if (issues && typeof issues.append === 'function') {
              await issues.append(nome, 'chat_lock_busy', `sendQueue chat=${chatId}`);
            }
            continue;
          }
          _chatLockAcquired = true;
          p = await ensurePage();
          if (!p) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_abort_no_page', chatId });
            continue;
          }
          await garantirMarketplace(p);
          const opened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, attemptId, nome });
          if (!opened) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'composer_missing_send', chatId, reason: 'open_by_click_failed' });
            if (issues && typeof issues.append === 'function') {
              await issues.append(nome, 'virtus_no_composer', `open_by_click_failed chat=${chatId} (sendQueue)`);
            }
            continue;
          }
          await acquireSendGuard(p, chatId);
          const campo = await waitForComposer(p, 10000);
          if (!campo) {
            stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'composer_missing_send', chatId });
            if (issues && typeof issues.append === 'function') {
              await issues.append(nome, 'virtus_no_composer', `composer ausente chat=${chatId} (sendQueue)`);
            }
            continue;
          }
          await sendMessageSafe(p, campo, answer, nome, chatId);
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_ok', chatId });
          const tsNow = agoraEpoch();
          historico[chatId] = tsNow;
          setResponded(chatId, tsNow);
          await salvaHistorico();
          await pendingDel(nome, chatId);
          // cooldown aleatório entre respostas (30–90s)
          const delay = randomBetween(MIN_SEND_DELAY_MS, MAX_SEND_DELAY_MS);
          await sleep(delay);
        } catch (e) {
          stepLog.appendJSONL(nome, 'virtus', { attempt: attemptId, step: 'send_fail', chatId, error: (e && e.message) || String(e) });
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
      SEND_WORKER_ACTIVE = false;
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
    const agora = agoraEpoch();

    chatsNovos.forEach(c => {
      const ts = respondedCache.get(c.id) || Number(historico[c.id] || 0);
      const jaRespondido = ts && (agora - ts) < NO_REPEAT_WINDOW_SEC;
      if (!jaRespondido) {
        scheduleCollector(c.id);
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
    if (!running || !epochOk()) return;
    stepLog.appendJSONL(nome, 'virtus', { step: 'legacy_responderChat_noop', chatId });
    fila = fila.filter(id => id !== chatId);
    chatAtivo = null;
    try { await pendingDel(nome, chatId); } catch {}
    return;
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

        await p.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
        }, anchorSel);

        let attempts = 0;
        let achou = false;
        let urlAtual = '';
        while (attempts < 8) {
          urlAtual = await p.evaluate(() => location.pathname);
          if (urlAtual.includes(`/marketplace/t/${chatId}`)) {
            achou = true;
            break;
          }
          await sleep(250);
          attempts++;
        }
        if (!achou) {
          logger.error(`Não entrou no chat correto após o click simulado. (urlAtual=${urlAtual}, esperado=${chatId})`, { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        // Ativa send-guard imediatamente após confirmar navegação correta
        await acquireSendGuard(p, chatId);

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
          logger.warn('Composer não encontrado. Fallback: click no feed e revalidar.', { nome, chatId });
          try {
            if (!running || !epochOk()) { try { await pendingDel(nome, chatId); } catch {} fila = fila.filter(id => id !== chatId); chatAtivo = null; return; }
            const reopened = await clickChatInFeed(p, chatId, { timeoutMs: 20000, nome });
            if (!reopened) {
              try { await pendingDel(nome, chatId); } catch {}
              fila = fila.filter(id => id !== chatId);
              chatAtivo = null;
              return;
            }
            await sleep(800);
          } catch {}
          if (await isChatBlocked(p)) {
            logger.warn('Chat bloqueado no fallback, marcado respondido', { nome, chatId });
            try { await pendingDel(nome, chatId); } catch {}
            try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado (fallback)`); } catch {}
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
      try { releaseSendGuard(p); } catch {}
      if (_chatLockAcquired) {
        try { chatLock.release(nome, chatId); } catch {}
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'chat_unlock', chatId });
      }
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
      scheduleNextIfIdle();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running || !epochOk()) return;
          try {
            const ok = await scrollChatsToTop(p, nome);
            if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'OK' : 'FAIL'); }
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
          // Reforço após 800ms para garantir Messenger reativo
          setTimeout(() => {
            if (!running || !epochOk()) return;
            try {
              const b = getBrowserFromPage(p);
              if (b && b._sendLock && b._sendLock.active) return;
            } catch {}
            scrollChatsToTop(p, nome);
          }, 800);
        }, 30000);
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
      try {
        for (const [cid, ref] of AI_COLLECTORS.entries()) {
          if (ref && ref.timer) clearTimeout(ref.timer);
        }
        AI_COLLECTORS.clear();
        SEND_QUEUE.splice(0, SEND_QUEUE.length);
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
      try { fila = []; } catch {}
      try { failCounts.clear(); } catch {}
      try { historico = {}; } catch {}
    }
  };
}

module.exports = {
  startVirtus
};