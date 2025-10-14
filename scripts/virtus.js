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

// ========== HELPER GETPERFILMANIFEST ADICIONADO ==========
function getPerfilManifest(nome) {
  const perfisArr = JSON.parse(fsRaw.readFileSync(path.join(__dirname, '../dados/perfis.json'), 'utf8'));
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
  if (!fsRaw.existsSync(manifestPath)) throw new Error('Manifest não existe: ' + manifestPath);
  return { manifest: JSON.parse(fsRaw.readFileSync(manifestPath, 'utf8')), perfil };
}
// ========== FIM HELPER ==========

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
function isVelho24h(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  if (/\b(ontem|yesterday)\b/.test(t)) return true;
  if (/\b(\d+)\s*(seman|sem|weeks?|w)\b/.test(t)) return true;
  const mDias = t.match(/\b(\d+)\s*(d|dias?)\b/);
  if (mDias) { if (parseInt(mDias[1],10) >= 1) return true; }
  const mH = t.match(/\b(\d+)\s*(h|hora|horas|hours?)\b/);
  if (mH) { if (parseInt(mH[1],10) >= 24) return true; }
  return false;
}
function isChatRecente(tempoLabel) {
  if (!tempoLabel) return false;
  const t = String(tempoLabel)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().trim();
  if (isVelho24h(t)) return false;
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
async function scrollChatsToTop(page) {
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
async function sendMessageSafe(p, campo, msg, nome) {
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

  // Helpers de normalização
  function norm(s) {
    return String(s || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/\u00a0/g,' ')
      .replace(/\r/g,'')
      .replace(/[ \t]+/g,' ')
      .trim();
  }
  const msgNorm = norm(msg);

  // 1) Foco e limpeza dentro do MESMO mundo do elemento
  await campo.focus().catch(()=>{});
  await campo.evaluate(el => {
    try {
      // Select-all seguro no mesmo mundo
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    } catch {}
    el.innerHTML = '';
  }).catch(()=>{});

  // 2) Inserção preferindo keyboard.insertText (mais estável no Messenger)
  let inserted = false;
  try {
    await p.keyboard.insertText(msg);
    inserted = true;
  } catch {}
  if (!inserted) {
    // fallback: digitação "humana"
    try { await campo.type(msg, { delay: randomBetween(6,14) }); inserted = true; } catch {}
  }
  if (!inserted) {
    // última tentativa: execCommand no mesmo mundo
    await campo.evaluate((el, text) => {
      try { el.focus(); document.execCommand('insertText', false, text); }
      catch {
        const e = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        el.textContent = text;
      }
    }, msg);
  }

  // 3) Verificação flexível do composer (no mesmo mundo do elemento)
  const composerText = await campo.evaluate(el => (el.innerText || el.textContent || '')).catch(()=> '');
  const compNorm = norm(composerText);
  if (compNorm !== msgNorm) {
    // Tente mais 1 vez limpar e inserir por execCommand
    await campo.evaluate((el, text) => {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
      } catch {}
      try { document.execCommand('insertText', false, text); }
      catch {
        const e = new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        el.textContent = text;
      }
    }, msg);
  }

  // 4) Envio
  await p.keyboard.press('Enter');
  // Aguarda composer esvaziar OU um bubble novo “You sent/Você enviou” aparecer – o que vier primeiro
  const sent = await Promise.race([
    (async () => {
      try {
        return await p.waitForFunction(() => {
          const norm = s => String(s||'').toLowerCase();
          // Últimas bolhas
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

  // 5) Se evidência de envio não apareceu, reforça Enter uma vez e reavalia
  if (!sent) {
    try { await p.keyboard.press('Enter'); } catch {}
    try {
      const confirmAgain = await p.waitForFunction(() => {
        const norm = s => String(s||'').toLowerCase();
        const nodes = Array.from(document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')).slice(-25);
        return nodes.some(el => /you\s+sent|v[ou]c[eê]\s+enviou/.test(norm(el.innerText||el.textContent||'')));
      }, { timeout: 5000 }).then(()=>true).catch(()=>false);
      if (!confirmAgain) {
        await logIssue(nome, 'virtus_send_failed', 'no_bubble_confirmed_after_enter');
      }
    } catch {}
  }

  // 6) Higiene: se imagens quebradas ficaram no composer
  try {
    const broken = await p.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('div[role="textbox"] img'));
      return imgs.some(img => img.naturalWidth === 0 || img.naturalHeight === 0);
    });
    if (broken) {
      await logIssue(nome, 'virtus_send_failed', 'composer contains broken image placeholder post-send');
    }
  } catch {}
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
    const { manifest } = getPerfilManifest(nome);
    manifestFrozenUntil = typeof manifest.frozenUntil === 'number' ? manifest.frozenUntil : 0;
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
  const NO_REPEAT_WINDOW_SEC = 24 * 3600;
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
  let lastRamCheck = 0;

  // trackers
  const RELOAD_IDLE_SEC = parseInt(process.env.VIRTUS_RELOAD_IDLE_SEC || '7200', 10); // 2 horas
  let lastReloadAt = 0;
  let ultimoAtendimento = agoraEpoch();
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
        if (!page) {
          if (!running || !epochOk()) return null;
          // cria nova aba
          const newP = await browser.newPage();
          try {
            const { manifest } = getPerfilManifest(nome);
            const coords = utils.getCoords(manifest.cidade || '');
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

  async function reloadUltraRobusto() {
    if (!running || !epochOk()) return;
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const { manifest } = getPerfilManifest(nome);
      manifestFrozenUntil = typeof manifest.frozenUntil === 'number' ? manifest.frozenUntil : 0;
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

    // === INÍCIO GUARD DE VIDA ===
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
    try {
      logger.info('Reload ultra robusto (2h sem responder).', { nome });
      p = await ensurePage();
      if (!p) { bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); return; }
      const client = await p.target().createCDPSession();
      try { await client.send('Network.clearBrowserCache'); } catch {}
      if (!running || !epochOk()) return;
      try { await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      if (!running || !epochOk()) return;
      await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ensureMinimizedWindowForPage(p); } catch {}
      await Promise.race([
        p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 15000 }),
        p.waitForSelector('div[role="row"] span', { timeout: 15000 })
      ]).catch(()=>{});
      resetRecoverBackoff();
      logger.info('Reload ultra robusto concluído.', { nome });
      // Chama scrollChatsToTop após reload ultra robusto
      try {
        const ok = await scrollChatsToTop(p);
        if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'Scroll OK' : 'Scroll DEU RUIM'); }
      } catch {}
      // Reforce após 800ms
      setTimeout(() => { if (!running || !epochOk()) return; scrollChatsToTop(p); }, 800);
      lastScrollToTop = Date.now();
    } catch (e) {
      logger.error('Erro no reload ultra robusto', { nome }, e);
      bumpRecoverBackoff();
      if (recoverBackoffMs) await sleep(recoverBackoffMs);
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
          await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil:'domcontentloaded', timeout: 20000 }).catch(()=>{});
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
    try { await scrollListaAte24h(p, { maxMs: 90000, quietLoops: 3 }); } catch {}
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

  async function scrollListaAte24h(page, { maxMs = 90000, quietLoops = 3 } = {}) {
    const t0 = Date.now();
    let semNovos = 0;
    let vistos = new Set();

    while ((Date.now() - t0) < maxMs) {
      const todos = await coletaChatsMarketplaceTodos(page);
      let houveNovo = false, viuAntigo = false;
      for (const c of todos) {
        if (!vistos.has(c.id)) { vistos.add(c.id); houveNovo = true; }
        if (isVelho24h(c.tempo)) viuAntigo = true;
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
    // ========== INÍCIO BLOCO FREEZER INSTRUÇÃO 2 ==========
    let manifestFrozenUntil = 0;
    try {
      const { manifest } = getPerfilManifest(nome);
      manifestFrozenUntil = typeof manifest.frozenUntil === 'number' ? manifest.frozenUntil : 0;
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
        await scrollChatsToTop(p).catch(()=>{});
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

        if (await isChatBlocked(p)) {
          logger.warn('Chat bloqueado/indisponível, marcado respondido', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          resetFail(chatId);
          return;
        }

        let campo = await waitForComposer(p, 10000);
        if (!campo) {
          logger.warn('Composer não encontrado. Fallback: goto direto e revalidar.', { nome, chatId });
          try {
            if (!running || !epochOk()) { try { await pendingDel(nome, chatId); } catch {} fila = fila.filter(id => id !== chatId); chatAtivo = null; return; }
            await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
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

        resetFail(chatId);

        if (!Array.isArray(mensagensAtendimento) || !mensagensAtendimento.length) {
          logger.error('atendimento.json vazio. Não será enviada resposta!', { nome, chatId });
          try { await pendingDel(nome, chatId); } catch {}
          fila = fila.filter(id => id !== chatId);
          chatAtivo = null;
          return;
        }

        let msg = mensagensAtendimento[randomBetween(0, mensagensAtendimento.length - 1)];
        if (Array.isArray(msg)) msg = msg.join('\n');
        if (typeof msg !== 'string') msg = String(msg);

        if (!running) { try { await pendingDel(nome, chatId); } catch {} chatAtivo = null; return; }
        if (!browser || browser.isConnected?.() === false) { try { await pendingDel(nome, chatId); } catch {} chatAtivo = null; return; }
        if (!p || p.isClosed?.()) { try { await pendingDel(nome, chatId); } catch {} chatAtivo = null; return; }

        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_prepare', chatId });
        try { await campo.focus(); } catch {}
        const isFocused = await p.evaluate((el)=> document.activeElement===el, campo).catch(()=>false);
        if (!isFocused) { try { await campo.focus(); } catch {} }

        // -------- SUBSTITUIR PELO USO sendMessageSafe --------
        await sendMessageSafe(p, campo, msg, nome);
        // -----------------------------------------------------
        stepLog.appendJSONL(nome, 'virtus', { attempt: attId, step: 'send_ok', chatId });

        log(`Mensagem enviada para chat ${chatId}`);
        // Ledger: remove pending ANTES de gravar responded (commit)
        try { await pendingDel(nome, chatId); } catch {}
        const tsNow = agoraEpoch();
        historico[chatId] = tsNow;
        setResponded(chatId, tsNow);
        ultimoAtendimento = tsNow;
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
      const { manifest } = getPerfilManifest(nome);
      manifestFrozenUntil = typeof manifest.frozenUntil === 'number' ? manifest.frozenUntil : 0;
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

      // === RAM — monitoramento e shutdown individual por perfil ===
      let ramMB = 0;
      try { ramMB = 0; } catch {}
      lastRamCheck = Date.now();
      if (ramMB > 700) {
        await logIssue(nome, "chrome_memory_spike", `RAM acima de 700MB (${ramMB} MB). shutdown temporário`);
        logger.warn('[GUARD][RAM] RAM acima de 700MB, shutdown/restart', { nome, ramMB });
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

      // --- BLOCO KEEPALIVE: JS para acordar navegador/Messenger (anti-freeze/anti-throttle) ---
      try {
        await p.evaluate(() => {
          window.dispatchEvent(new Event('focus'));
          document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true}));
          document.dispatchEvent(new Event('visibilitychange'));
          if (window && document && document.body) {
            const evt = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Control', code: 'ControlLeft' });
            document.body.dispatchEvent(evt);
          }
          setTimeout(()=>{}, 1);
        });
      } catch (err) {
        if (VIRTUS_DETAILED_DEBUG) { try { logger.debug('[KEEPALIVE][EXCEPTION]', { nome, message: err && err.message }); } catch{} }
      }
      // --- FIM BLOCO KEEPALIVE ---

      if (limpaHistoricoVelho()) await salvaHistorico();

      const nowEpoch = agoraEpoch();
      if ((nowEpoch - ultimoAtendimento) >= RELOAD_IDLE_SEC) {
        if (!running || !epochOk()) return;
        await reloadUltraRobusto();
        lastReloadAt = nowEpoch;
        ultimoAtendimento = agoraEpoch(); // Reinicia a janela de 2h imediatamente após reload!
        if (issues) try {
          await logIssue(nome, 'mil_action', `virtus_reload_idle2h after ${nowEpoch - ultimoAtendimento} sec idle`);
        } catch {}
      }

      await atualizaFila();
      scheduleNextIfIdle();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running || !epochOk()) return;
          try {
            const ok = await scrollChatsToTop(p);
            if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', ok ? 'OK' : 'FAIL'); }
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
          // Reforço após 800ms para garantir Messenger reativo
          setTimeout(() => { if (!running || !epochOk()) return; scrollChatsToTop(p); }, 800);
        }, 30000);
      }
      try {
        const scrolled = await scrollChatsToTop(p);
        if (VIRTUS_SCROLL_DEBUG) { log('[SCROLL TOP]', scrolled ? 'OK' : 'FAIL'); }
        if (scrolled) {
          lastScrollToTop = Date.now();
        }
        // Reforço após 800ms para garantir Messenger reativo
        setTimeout(() => { if (!running || !epochOk()) return; scrollChatsToTop(p); }, 800);
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
      const { manifest } = getPerfilManifest(nome);
      manifestFrozenUntil = typeof manifest.frozenUntil === 'number' ? manifest.frozenUntil : 0;
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
          const ok = await scrollChatsToTop(p);
          setTimeout(() => { if (!running || !epochOk()) return; scrollChatsToTop(p); }, 800);
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
  startVirtus
};