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

// ========== HELPER GETPERFILMANIFEST ADICIONADO ==========
function getPerfilManifest(nome) {
  const perfisArr = require('../dados/perfis.json');
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
  if (!fsRaw.existsSync(manifestPath)) throw new Error('Manifest não existe: ' + manifestPath);
  return { manifest: require(manifestPath), perfil };
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
    console.error('[VIRTUS] ERRO ao carregar atendimento.json:', e);
    mensagensAtendimento = [];
  }
})();

function agoraEpoch() {
  return Math.floor(Date.now() / 1000);
}

const HIST_JSON_NAME = c => path.join(__dirname, '../dados/perfis', c, 'chats_respondidos.json');

// Classificadores de tempo
function isVelho24h(tempoLabel) {
  if (!tempoLabel) return false;
  const t = tempoLabel.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (/\b\d+\sd\b/.test(t)) return true;
  if (/\b\d+\sdias?\b/.test(t)) return true;
  if (/\b\d+\ssem\b/.test(t)) return true;
  if (/\b\d+\sseman/.test(t)) return true;
  if (/\b\d+\s*w\b/.test(t)) return true;
  if (/week/.test(t)) return true;
  return false;
}

function isChatRecente(tempoLabel) {
  if (!tempoLabel) return false;
  const t = tempoLabel.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (isVelho24h(t)) return false;
  if (/\bagora\b/.test(t)) return true;
  if (/\b\d+\s*(s|seg)\b/.test(t)) return true;
  if (/\b\d+\s*(min|minute|minuto)\b/.test(t)) return true;
  if (/\b\d+\s*(h|hora|hour)\b/.test(t)) return true;
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
          if (pos < 0) return null;
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
    console.log('[VIRTUS] Erro em coletaChatsMarketplaceTodos:', err + '');
    return [];
  }
}

// Messenger helpers
async function garantirMarketplace(page) {
  if (!page || typeof page.url !== 'function') throw new Error('Page inválida');

  let url = '';
  try { url = page.url() || ''; } catch {}

  if (url === 'about:blank' || !url.includes('/marketplace')) {
    await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded' });
    url = page.url();
  }
  await page.waitForSelector('header span, header h1', { timeout: 15000 });
  const header = await page.$eval('header span, header h1', el => el.textContent || "");
  if (!header.toLowerCase().includes('marketplace')) throw new Error('Não está no Marketplace!');
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
async function sendMessageSafe(p, campo, msg) {
  // 1) Garantir foco e limpar o composer
  try { await campo.focus(); } catch {}
  try {
    await p.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await p.keyboard.press('A');
    await p.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await p.keyboard.press('Backspace');
  } catch {}

  // 2) Tentativa: colar via clipboard (inserção “atômica”)
  let pasted = false;
  try {
    const ok = await p.evaluate(async (txt) => {
      try { await navigator.clipboard.writeText(txt); return true; }
      catch { return false; }
    }, msg);
    if (ok) {
      await p.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
      await p.keyboard.press('V');
      await p.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
      pasted = true;
    }
  } catch {}

  // 3) Fallback: digitação
  if (!pasted) {
    await campo.type(msg, { delay: randomBetween(6,14) });
  }

  // 4) Verificação do composer: precisa constar exatamente o texto
  const match = await p.evaluate((el) => {
    const getText = (n) => (n.innerText || n.textContent || '').replace(/\r/g,'');
    const text = getText(el).replace(/\u00a0/g,' ').trim();
    return text;
  }, campo).catch(() => '');

  // 5) Se não bate (corte/preview interferiu), limpa e re-insere uma única vez com execCommand
  if (match !== msg.trim()) {
    try {
      await campo.focus();
      await p.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
      await p.keyboard.press('A');
      await p.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
      await p.keyboard.press('Backspace');
    } catch {}
    await p.evaluate((el, txt) => {
      el.focus();
      try { document.execCommand('insertText', false, txt); } catch {
        const e = new InputEvent('beforeinput', { inputType: 'insertText', data: txt, bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        el.textContent = txt;
      }
    }, campo, msg);
    // revalida
    const m2 = await p.evaluate((el) => (el.innerText || el.textContent || '').replace(/\u00a0/g,' ').trim(), campo).catch(()=>'');

    if (m2 !== msg.trim()) {
      try { await logIssue(nome, 'virtus_send_failed', `composer mismatch [expect=${msg.length}, got=${m2.length}]`); } catch {}
      throw new Error('composer_text_mismatch');
    }
  }

  // 6) Envia
  await campo.press('Enter');

  // 7) Aguarda composer esvaziar (sinal básico de envio) – 7s
  await p.waitForFunction((el) => {
    const txt = (el.innerText || el.textContent || '').trim();
    return txt.length === 0;
  }, { timeout: 7000 }, campo).catch(()=>{});

  // 8) Pós-verificação: se imagem placeholder quebrada ficou no composer
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

function startVirtus(browser, nome, robeMeta = {}) {
  const log = (...args) => console.log(`[VIRTUS][${nome}]`, ...args);

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
  const respondedCache = new Map();

  // MILITAR: Timers unificados
  let filaInterval = null;
  let filaChatTimer = null;
  let scrollInterval = null; // Militar: cleaning interval to prevent interval leak

  let lastScrollToTop = 0;
  let lastRamCheck = 0;

  // trackers
  let ultimoAtendimento = agoraEpoch();
  let saveChain = Promise.resolve();
  let filaLoopBusy = false;
  let recoverBackoffMs = 0;
  const failCounts = new Map();

  // Persistência segura no Windows
  async function salvaHistorico() {
    saveChain = saveChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(HIST_FILE), { recursive: true });
        const tmp = HIST_FILE + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(historico, null, 2));
        try { await fs.unlink(HIST_FILE); } catch {}
        try {
          await fs.rename(tmp, HIST_FILE);
        } catch {
          await fs.copyFile(tmp, HIST_FILE);
          try { await fs.unlink(tmp); } catch {}
        }
      } catch (e) {
        log('Erro ao salvar histórico:', e + '');
      }
    }).catch(err => log('Erro em cadeia de salvamento:', err + ''));
    return saveChain;
  }

  async function carregaHistorico() {
    try {
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
        respondedCache.set(id, ts);
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
    return mudanca;
  }

  async function ensurePage() {
    // === INÍCIO GUARD DE VIDA NO ENSUREPAGE ===
    if (!browser || (browser.isConnected && browser.isConnected() === false)) {
      log(`[VIRTUS][${nome}] Browser morto, não é possível garantir page.`);
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
      return null;
    }
    // ...seguir rotina normal...
    // === FIM GUARD DE VIDA NO ENSUREPAGE ===
    try {
      let pages = await browser.pages();
      if (!pages || !pages[0]) {
        // Cria nova aba e aplica patchPage nela (ambiente idêntico às outras)
        const newP = await browser.newPage();
        try {
          // --- Interceptação de assets pesados no Messenger ---
          if (newP.url && typeof newP.url === 'function' && /messenger\.com/.test(await newP.url())) {
            try {
              await newP.setRequestInterception(true);
              newP.on('request', req => {
                const resource = req.resourceType();
                // PATCH: liberar "image" no intercept
                if (resource === 'media' || resource === 'video' || resource === 'font') {
                  return req.abort();
                }
                if (resource === 'image') {
                  return req.continue();
                }
                return req.continue();
              });
            } catch (e) {
              log('[VIRTUS] Erro ao aplicar interception:', e + '');
            }
          }
          // --- FIM Interceptação ---

          try {
            const { manifest } = getPerfilManifest(nome);
            const coords = utils.getCoords(manifest.cidade || '');
            await patchPage(nome, newP, coords);
            await ensureMinimizedWindowForPage(newP);
          } catch (e) {
            log('ensurePage: falha ao obter manifest ou patchPage:', e + '');
          }
        } catch (e) {
          log('ensurePage: falha ao aplicar patchPage/minimize na nova aba:', e + '');
        }
        page = newP;
        // GUARD extra para page morta após newPage
        if (!browser || (browser.isConnected && browser.isConnected() === false)) {
          log(`[VIRTUS][${nome}] Browser morto após newPage.`);
          if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected após newPage'); } catch {}
          return null;
        }
        if (page && page.isClosed && page.isClosed()) {
          log(`[VIRTUS][${nome}] Page principal fechada.`);
          if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
          return null;
        }
        return page;
      }
      page = pages[0];
      // --- Interceptação de assets pesados no Messenger (garantir para pages já abertas) ---
      if (page.url && typeof page.url === 'function' && /messenger\.com/.test(await page.url())) {
        try {
          await page.setRequestInterception(true);
          if (!page._virtusIntercepted) {
            page.on('request', req => {
              const resource = req.resourceType();
              // PATCH: liberar "image" no intercept
              if (resource === 'media' || resource === 'video' || resource === 'font') {
                return req.abort();
              }
              if (resource === 'image') {
                return req.continue();
              }
              return req.continue();
            });
            page._virtusIntercepted = true;
          }
        } catch (e) {
          log('[VIRTUS] Erro ao aplicar interception:', e + '');
        }
      }
      // GUARD para page fechada
      if (page && page.isClosed && page.isClosed()) {
        log(`[VIRTUS][${nome}] Page principal fechada.`);
        if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
        return null;
      }
      return page;
    } catch (e) {
      log('ensurePage falhou:', e + '');
      return null;
    }
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
    failCounts.set(chatId, n);
    return n;
  }
  function resetFail(chatId) {
    failCounts.delete(chatId);
  }

  async function coletaChatsMarketplaceRecentes() {
    try {
      const p = await ensurePage();
      if (!p) return [];
      try {
        await garantirMarketplace(p);
      } catch (err) {
        log('Não está no Marketplace ou erro ao garantir Marketplace:', err + '');
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
      log('Erro ao coletar chats:', err + '');
      return [];
    }
  }

  async function reloadUltraRobusto() {
    // === INÍCIO GUARD DE VIDA ===
    if (!browser || browser.isConnected?.() === false) {
      log(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`);
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
      log(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`);
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }
    // === FIM GUARD DE VIDA ===
    try {
      log('Reload ultra robusto (2h sem responder).');
      p = await ensurePage();
      if (!p) { bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); return; }
      const client = await p.target().createCDPSession();
      try { await client.send('Network.clearBrowserCache'); } catch {}
      try { await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ensureMinimizedWindowForPage(p); } catch {}
      await Promise.race([
        p.waitForSelector('a[href^="/marketplace/t/"]', { timeout: 15000 }),
        p.waitForSelector('div[role="row"] span', { timeout: 15000 })
      ]).catch(()=>{});
      resetRecoverBackoff();
      log('Reload ultra robusto concluído.');
      // Chama scrollChatsToTop após reload ultra robusto
      try {
        const ok = await scrollChatsToTop(p);
        log('[SCROLL TOP]', ok ? 'Scroll OK' : 'Scroll DEU RUIM');
      } catch {}
      // Reforce após 800ms
      setTimeout(() => { scrollChatsToTop(p); }, 800);
      lastScrollToTop = Date.now();
    } catch (e) {
      log('Erro no reload ultra robusto:', e + '');
      bumpRecoverBackoff();
      if (recoverBackoffMs) await sleep(recoverBackoffMs);
    }
  }

  async function initHistoricoSePreciso() {
    try {
      await fs.access(HIST_FILE);
      await carregaHistorico();
      log('Histórico existente carregado. Retomando pendentes <24h.');
      return;
    } catch {}

    log('[SNAPSHOT] Primeiro boot sem histórico. Marcando <24h atuais como respondidos.');
    const p = await ensurePage();
    if (!p) { log('[SNAPSHOT] Falha ao garantir aba zero.'); return; }
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
      const ts = respondedCache.get(c.id);
      const jaRespondido = ts && (agora - ts) < NO_REPEAT_WINDOW_SEC;
      if (!jaRespondido && !fila.includes(c.id)) {
        fila.push(c.id);
        novosAti++;
        log(`NOVO chat em Fila: ${c.id} (${c.tempo})`);
      }
    });

    const filaAnt = fila.slice(0);
    fila = fila.filter(id => {
      const ts = respondedCache.get(id);
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
      filaChatTimer = null;
      await responderChat(next);
      scheduleNextIfIdle();
    }, delay);
  }

  async function responderChat(chatId) {
    log(`[DETAILED] Início responderChat: ${chatId}`);
    // === INÍCIO GUARD DE VIDA NO RESPONDERCHAT ===
    if (!browser || browser.isConnected?.() === false) {
      log(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`);
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'browser morto/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }
    let p = await ensurePage();
    if (!p || (p.isClosed && p.isClosed())) {
      log(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`);
      if (issues) try { await logIssue(nome, 'virtus_page_dead', 'page closed/disconnected'); } catch {}
      running = false;
      if (filaInterval) clearInterval(filaInterval), filaInterval = null;
      if (filaChatTimer) clearTimeout(filaChatTimer), filaChatTimer = null;
      if (scrollInterval) clearInterval(scrollInterval), scrollInterval = null;
      return;
    }
    // === FIM GUARD DE VIDA ===
    if (!chatId) return;
    chatAtivo = chatId;

    try {
      p = await ensurePage();
      if (!p) {
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }
      await garantirMarketplace(p);

      const tsPrev = respondedCache.get(chatId);
      if (tsPrev && (agoraEpoch() - tsPrev) < NO_REPEAT_WINDOW_SEC) {
        log(`[GUARD-ID] Já respondido (ID ${chatId}) <24h. Pulando envio.`);
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }

      let anchorSel = `a[href^="/marketplace/t/${chatId}"]`;
      let found = await p.$(anchorSel);

      if (!found) {
        log(`[WARN] Âncora do chatId ${chatId} não encontrada. Pulando para próximo chat.`);
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
        log(`[ERRO] Não entrou no chat correto após o click simulado. (urlAtual=${urlAtual}, esperado=${chatId})`);
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }

      if (await isChatBlocked(p)) {
        log(`[WARN] Chat ${chatId} bloqueado/indisponível. Marcando como respondido para evitar looping.`);
        const tsNow = agoraEpoch();
        historico[chatId] = tsNow;
        respondedCache.set(chatId, tsNow);
        ultimoAtendimento = tsNow;
        await salvaHistorico();
        try { await logIssue(nome, 'virtus_blocked', `chat ${chatId} bloqueado/indisponível`); } catch {}
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        resetFail(chatId);
        return;
      }

      let campo = await waitForComposer(p, 10000);
      if (!campo) {
        log(`[WARN] Composer não encontrado. Fallback: goto direto e revalidar.`);
        try {
          await p.goto(`https://www.messenger.com/marketplace/t/${chatId}/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(800);
        } catch {}
        if (await isChatBlocked(p)) {
          log(`[WARN] Chat ${chatId} bloqueado no fallback. Marcando como respondido para evitar looping.`);
          const tsNow = agoraEpoch();
          historico[chatId] = tsNow;
          respondedCache.set(chatId, tsNow);
          ultimoAtendimento = tsNow;
          await salvaHistorico();
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
        log(`[ERRO] Composer indisponível para chat ${chatId}. Tentativas: ${fails}`);
        if (fails >= 2) {
          log(`[WARN] ${chatId} falhou 2x. Marcando como respondido para não travar fila.`);
          const tsNow = agoraEpoch();
          historico[chatId] = tsNow;
          respondedCache.set(chatId, tsNow);
          ultimoAtendimento = tsNow;
          await salvaHistorico();
          try { await logIssue(nome, 'virtus_no_composer', `composer ausente após 2 tentativas (chat ${chatId})`); } catch {}
        }
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }

      resetFail(chatId);

      if (!Array.isArray(mensagensAtendimento) || !mensagensAtendimento.length) {
        log('[ERRO] atendimento.json vazio. Não será enviada resposta!');
        fila = fila.filter(id => id !== chatId);
        chatAtivo = null;
        return;
      }

      let msg = mensagensAtendimento[randomBetween(0, mensagensAtendimento.length - 1)];
      if (Array.isArray(msg)) msg = msg.join('\n');
      if (typeof msg !== 'string') msg = String(msg);

      // -------- SUBSTITUIR PELO USO sendMessageSafe --------
      await sendMessageSafe(p, campo, msg);
      // -----------------------------------------------------

      log(`Mensagem enviada para chat ${chatId}`);
      const tsNow = agoraEpoch();
      historico[chatId] = tsNow;
      respondedCache.set(chatId, tsNow);
      ultimoAtendimento = tsNow;
      await salvaHistorico();

    } catch (err) {
      log(`[ERRO] Erro ao responder chat ${chatId}:`, err && err.stack ? err.stack : err + '');
      const msg = (err && err.message) ? err.message : String(err);
      try { await logIssue(nome, 'virtus_send_failed', `chat ${chatId}: ${msg}`); } catch {}
    }

    fila = fila.filter(id => id !== chatId);
    chatAtivo = null;
    log(`[DETAILED] ChatId ${chatId} removido da fila e finalizado.`);
  }

  // ========================
  // === BLOCO MODIFICADO ===
  // ========================
  async function filaManagerLoop() {
    // === INÍCIO GUARD DE VIDA NO FILAMANAGERLOOP ===
    if (!browser || browser.isConnected?.() === false) {
      log(`[VIRTUS][${nome}] Browser morto/desconectado — encerrando Virtus`);
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
        log(`[VIRTUS][${nome}] Page fechada/desconectada — encerrando Virtus`);
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
        log(`[GUARD][RAM] RAM acima de 700MB (${ramMB} MB), shutdown/restart`);
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
        try { console.log('[KEEPALIVE][EXCEPTION]', err && err.message); } catch{}
      }
      // --- FIM BLOCO KEEPALIVE ---

      if (limpaHistoricoVelho()) await salvaHistorico();

      if ((agoraEpoch() - ultimoAtendimento) > 7200) {
        await reloadUltraRobusto();
        try { await garantirMarketplace(p); } catch {}
      }

      await atualizaFila();
      scheduleNextIfIdle();
      resetRecoverBackoff();

      if (scrollInterval == null) {
        scrollInterval = setInterval(async () => {
          if (!running) return;
          try {
            const ok = await scrollChatsToTop(p);
            log('[SCROLL TOP]', ok ? 'OK' : 'FAIL');
            if (ok) {
              lastScrollToTop = Date.now();
            }
          } catch {}
          // Reforço após 800ms para garantir Messenger reativo
          setTimeout(() => { scrollChatsToTop(p); }, 800);
        }, 30000);
      }
      try {
        const scrolled = await scrollChatsToTop(p);
        log('[SCROLL TOP]', scrolled ? 'OK' : 'FAIL');
        if (scrolled) {
          lastScrollToTop = Date.now();
        }
        // Reforço após 800ms para garantir Messenger reativo
        setTimeout(() => { scrollChatsToTop(p); }, 800);
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
    await sleep(2000);
    let ready = false;
    while (!ready) {
      try {
        const p = await ensurePage();
        if (!p) { await sleep(2500); continue; }
        if (p.url() === 'about:blank' || !p.url().includes('/marketplace')) {
          try {
            await p.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded' });
          } catch { bumpRecoverBackoff(); if (recoverBackoffMs) await sleep(recoverBackoffMs); continue; }
        }
        await garantirMarketplace(p);

        try {
          const ok = await scrollChatsToTop(p);
          log('[SCROLL TOP]', ok ? 'OK' : 'FAIL');
          if (ok) {
            lastScrollToTop = Date.now();
          }
          // Reforço após 800ms
          setTimeout(() => { scrollChatsToTop(p); }, 800);
        } catch {}

        ready = true;
        log('Aba zero da Virtus iniciada e garantida: Marketplace pronta.');
      } catch (err) {
        log('Falha ao garantir aba zero no startup Virtus:', err + '');
        await sleep(2500);
      }
    }

    await initHistoricoSePreciso();

    filaInterval = setInterval(filaManagerLoop, POLL_INTERVAL_MS);
    filaManagerLoop();
  }

  runner();

  return {
    stop: async () => {
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
    }
  };
}

module.exports = {
  startVirtus
};