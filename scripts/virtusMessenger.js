'use strict';

/**
 * Virtus V2 - Messenger Browser Operations
 * 
 * Extrai TODAS as operações de browser/DOM do Virtus.
 * Este módulo NUNCA deve importar inteligenciaArtificial.js.
 * 
 * Responsabilidades:
 * - Navegação no Messenger/Marketplace
 * - Coleta de chats e histórico
 * - Abertura de chats
 * - Envio de mensagens
 * - Leitura de estado do DOM
 * 
 * Regra absoluta: Sem LLM, sem lógica de negócio, apenas browser/DOM.
 */

const browserHelper = require('./browser.js');

// Selectores do composer (campo de texto)
const COMPOSER_SELECTORS = [
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"][aria-label]',
  'div[contenteditable="true"]',
  'div[role="combobox"][contenteditable="true"]',
  'div[aria-label="Mensagem"]',
  'div[aria-label*="mensagem"]'
];

/**
 * Helper: sleep simples
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Helper: obtém browser de uma page
 */
function getBrowserFromPage(p) {
  try {
    return typeof p.browser === 'function' ? p.browser() : null;
  } catch {
    return null;
  }
}

/**
 * Garante que estamos no Marketplace e a UI está pronta
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {Object} options - Opções
 * @param {number} options.timeoutMs - Timeout em ms (default: 25000)
 * @throws {Error} Se Marketplace não ficar pronto a tempo
 */
async function ensureMarketplace(page, { timeoutMs = 25000 } = {}) {
  if (!page || typeof page.url !== 'function') {
    throw new Error('Page inválida');
  }
  
  let url = '';
  try {
    url = page.url() || '';
  } catch {}
  
  // Navega para Marketplace se necessário
  if (!/messenger.com\/marketplace/i.test(url)) {
    try {
      await page.goto('https://www.messenger.com/marketplace', {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });
    } catch {}
  }
  
  // Cura fluxos de nonce/continuar
  try {
    if (browserHelper && typeof browserHelper.resolveNonceIfPresent === 'function') {
      await browserHelper.resolveNonceIfPresent(page).catch(() => {});
    }
    if (browserHelper && typeof browserHelper.clickContinuarComo === 'function') {
      await browserHelper.clickContinuarComo(page, { timeout: 12000 }).catch(() => {});
    }
  } catch {}
  
  // Espera robusta por UI do Marketplace
  const ok = await Promise.race([
    page.waitForFunction(() => {
      const hasAnchor = !!document.querySelector('a[href^="/marketplace/t/"]');
      const hasGrid = !!document.querySelector('div[role="grid"]') || !!document.querySelector('div[role="rowgroup"]');
      const hasRow = document.querySelectorAll('div[role="row"]').length > 0;
      return hasAnchor || hasGrid || hasRow;
    }, { timeout: timeoutMs }),
    page.waitForSelector('a[href^="/marketplace/t/"]', { timeout: timeoutMs }).catch(() => null)
  ]);
  
  if (!ok) {
    throw new Error('Marketplace UI não ficou pronta a tempo');
  }
}

/**
 * Lista todos os chats recentes e não lidos do Marketplace
 * 
 * @param {Page} page - Página do Puppeteer
 * @returns {Promise<Array>} Array de objetos { id, tempo, href, fromMine, isUnread, recentEnough }
 */
async function listRecentUnreadChats(page) {
  try {
    const items = await page.$$eval('a[href^="/marketplace/t/"]', (els) => {
      function _fnv1aHex(str) {
        let h = 2166136261;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = (h * 16777619) >>> 0;
        }
        return ('00000000' + (h >>> 0).toString(16)).slice(-8);
      }
      
      function _extraiId(href) {
        try {
          const s = String(href || '');
          const pos = s.indexOf('/marketplace/t/');
          if (pos < 0) return null;
          const rest = s.slice(pos + '/marketplace/t/'.length);
          const id = rest.split(/[/?#]/)[0];
          return id && /^\d+$/.test(id) ? id : null;
        } catch {
          return null;
        }
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
            if (/\d+\s*(s|min|m|seg|h|hora|hour|minute|minuto|dia|dias|d|sem|seman|week|w)/i.test(txt)) {
              return txt;
            }
          }
        } catch {}
        return '';
      }
      
      function _parseMessageAgeMs(tempoLabel) {
        if (!tempoLabel) return Number.MAX_SAFE_INTEGER;
        const t = String(tempoLabel).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        if (/\b(agora|now)\b/.test(t)) return 0;
        const secMatch = t.match(/\b(\d+)\s*(s|seg|secs?|seconds?)\b/);
        if (secMatch) return parseInt(secMatch[1], 10) * 1000;
        const minMatch = t.match(/\b(\d+)\s*(min|m|mins?|minutes?|minutos?)\b/);
        if (minMatch) return parseInt(minMatch[1], 10) * 60 * 1000;
        const hourMatch = t.match(/\b(\d+)\s*(h|hora|hours?|horas?)\b/);
        if (hourMatch) {
          const h = parseInt(hourMatch[1], 10);
          if (h > 2) return Number.MAX_SAFE_INTEGER;
          return h * 60 * 60 * 1000;
        }
        return Number.MAX_SAFE_INTEGER;
      }
      
      const arr = els.map((el) => {
        const href = el.getAttribute('href') || el.href || '';
        const id = _extraiId(href);
        const row = el.closest('div[role="row"]') || el.parentElement;
        const tempo = _extraiTempo(row);
        const rowText = (row && (row.innerText || row.textContent) || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        const previewTxt = rowText || '';
        const isMineByPreview = /v[óo]c[eê]\s+enviou|you\s+sent/i.test(previewTxt) || /^thiago\s*:/i.test(previewTxt);
        const isUnreadLabel = /mensagem n[ãa]o lida/i.test(previewTxt);
        const ageMs = _parseMessageAgeMs(tempo);
        const recentEnough = tempo && ageMs !== Number.MAX_SAFE_INTEGER && ageMs <= 5 * 60 * 1000;
        const fromMine = isMineByPreview;

        // previewSig: NÃO inclui tempo (pra não mudar a cada minuto)
        let previewBase = '';
        try {
          const spans = Array.from((row || el).querySelectorAll('span'));
          const texts = spans
            .map(s => (s.innerText || s.textContent || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .filter(t => !/\b(agora|now)\b/i.test(t))
            .filter(t => !/\b\d+\s*(s|min|m|seg|h|hora|hour|minute|minuto|dia|dias|d|sem|seman|week|w)\b/i.test(t))
            .filter(t => !/mensagem n[aã]o lida/i.test(t));
          previewBase = (texts.slice(-3).join(' ') || '').trim();
        } catch {}
        if (!previewBase) {
          // fallback: usa o rowText com regex que remove tempo
          previewBase = previewTxt
            .replace(/\b(agora|now)\b/gi, '')
            .replace(/\b\d+\s*(s|min|m|seg|h|hora|hour|minute|minuto|dia|dias|d|sem|seman|week|w)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        }
        const previewSig = _fnv1aHex(previewBase.toLowerCase());
        
        return { id, tempo, href, fromMine, isUnread: isUnreadLabel, recentEnough, ageMs, previewSig };
      }).filter((o) => o.id);
      
      // Deduplica por ID (mantém primeiro encontrado)
      const map = new Map();
      for (const it of arr) {
        if (!map.has(it.id)) map.set(it.id, it);
      }
      return Array.from(map.values()).map(it => ({
        ...it,
        idadeMs: (typeof it.ageMs === 'number' ? it.ageMs : undefined),
        previewSig: it.previewSig || null
      }));
    });
    
    return items;
  } catch (err) {
    return [];
  }
}

/**
 * Abre um chat no feed (click no anchor e aguarda conversa carregar)
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {string} chatId - ID do chat
 * @param {Object} options - Opções
 * @param {number} options.timeoutMs - Timeout em ms (default: 20000)
 * @returns {Promise<boolean>} true se abriu com sucesso
 */
async function openChat(page, chatId, { timeoutMs = 20000 } = {}) {
  await ensureMarketplace(page, { timeoutMs: 25000 }).catch(() => {});
  
  // Scroll para o topo da lista
  try {
    await page.evaluate(() => {
      let grid = document.querySelector('div[role="grid"]');
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf[data-virtualized="false"]');
      if (!grid) grid = document.querySelector('div[role="rowgroup"]');
      if (!grid) grid = document.querySelector('div.x78zum5.xdt5ytf');
      if (!grid) grid = Array.from(document.querySelectorAll('div')).find((d) => d.scrollHeight > 400 && d.scrollHeight > d.clientHeight + 30);
      if (!grid) grid = document.body;
      if (grid) grid.scrollTop = 0;
    });
  } catch {}
  
  await sleep(200);
  
  // Encontra e clica no anchor do chat
  const sel = `a[href^="/marketplace/t/${chatId}"]`;
  const t0 = Date.now();
  let anchor = null;
  
  // Busca com scroll incremental
  while ((Date.now() - t0) < Math.min(timeoutMs, 16000)) {
    try {
      anchor = await page.$(sel);
      if (anchor) break;
      
      // Scroll incremental
      await page.evaluate(() => {
        const contSel = 'div[role="grid"]';
        const el = document.querySelector(contSel) || document.scrollingElement || document.body;
        if (!el) return;
        const delta = Math.max(400, Math.floor(el.clientHeight * 0.8));
        el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight);
      });
    } catch {}
    await sleep(200);
  }
  
  if (!anchor) {
    return false;
  }
  
  // Clica no anchor
  try {
    await page.evaluate((el) => {
      el.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, anchor);
  } catch {
    try {
      await anchor.click({ delay: 50 });
    } catch {}
  }
  
  // Aguarda estar no chat
  const onChat = await assertOnChat(page, chatId, { timeoutMs: 8000 });
  if (!onChat) {
    const ready = await ensureConversationReady(page, chatId, { timeoutMs: 16000 });
    if (!ready) {
      return false;
    }
  }
  
  return true;
}

/**
 * Verifica se estamos na página do chat correto
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {string} chatId - ID do chat esperado
 * @param {Object} options - Opções
 * @param {number} options.timeoutMs - Timeout em ms (0 = sem timeout)
 * @returns {Promise<boolean>} true se está no chat correto
 */
async function assertOnChat(page, chatId, { timeoutMs = 0 } = {}) {
  const t0 = Date.now();
  while (true) {
    const ok = await page.evaluate((id) => {
      try {
        return location && typeof location.pathname === 'string'
          ? location.pathname.includes('/marketplace/t/' + id)
          : false;
      } catch {
        return false;
      }
    }, chatId).catch(() => false);
    
    if (ok) return true;
    if (!timeoutMs || Date.now() - t0 >= timeoutMs) return false;
    await sleep(120);
  }
}

/**
 * Garante que a conversa está pronta (container de mensagens carregado)
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {string} chatId - ID do chat
 * @param {Object} options - Opções
 * @param {number} options.timeoutMs - Timeout em ms (default: 20000)
 * @returns {Promise<boolean>} true se conversa está pronta
 */
async function ensureConversationReady(page, chatId, { timeoutMs = 20000 } = {}) {
  try {
    // Cura sessão antes do DOM
    if (browserHelper && typeof browserHelper.resolveNonceIfPresent === 'function') {
      await browserHelper.resolveNonceIfPresent(page).catch(() => {});
    }
    if (browserHelper && typeof browserHelper.clickContinuarComo === 'function') {
      await browserHelper.clickContinuarComo(page, { timeout: 8000 }).catch(() => {});
    }
  } catch {}
  
  // Aguarda container de mensagens real da conversa
  const selConversation = [
    'div[aria-label^="Mensagens na conversa"]',
    'div[role="grid"][aria-label*="conversa"]',
    'div[role="grid"][aria-label*="Mensagens"]'
  ];
  
  for (const sel of selConversation) {
    const h = await page.waitForSelector(sel, { timeout: timeoutMs }).catch(() => null);
    if (h) return true;
  }
  
  // Fallback: aguarda função/DOM principal
  return await page
    .waitForFunction(
      () => {
        const a = document.querySelector('div[aria-label^="Mensagens na conversa"]');
        const b = document.querySelector('div[role="grid"][aria-label]');
        return !!(a || b);
      },
      { timeout: timeoutMs }
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * Coleta histórico completo de mensagens do chat aberto
 * 
 * @param {Page} page - Página do Puppeteer
 * @returns {Promise<Array>} Array de objetos { autor: 'cliente'|'ia', texto: string }
 */
async function scrapeHistory(page) {
  try {
    await page
      .waitForFunction(
        () =>
          !!document.querySelector('div[aria-label^="Mensagens na conversa"]') ||
          !!document.querySelector('div[role="grid"][aria-label*="conversa"]') ||
          !!document.querySelector('div[role="grid"][aria-label*="Mensagens"]'),
        { timeout: 5000 }
      )
      .catch(() => {});
  } catch {}
  
  try {
    const msgs = await page.evaluate(() => {
      const norm = (s) =>
        (s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      
      const isVisible = (el) => {
        try {
          const st = getComputedStyle(el);
          if (!st || st.visibility === 'hidden' || st.display === 'none') return false;
          if (el.offsetParent === null) return false;
          const r = el.getBoundingClientRect();
          return r && r.width > 0 && r.height > 0;
        } catch {
          return false;
        }
      };
      
      // Container da conversa (grid)
      const grid =
        document.querySelector('div[aria-label^="Mensagens na conversa"]') ||
        document.querySelector('div[role="grid"][aria-label*="conversa"]') ||
        document.querySelector('div[role="grid"][aria-label*="Mensagens"]');
      
      if (!grid) return [];
      
      const rows = Array.from(grid.querySelectorAll('div[role="row"]')).slice(-160);
      
      // Sistema/ruídos frequentes do Messenger (PT/EN/ES)
      const SYS_RX = new RegExp(
        [
          '^classificar o vendedor$',
          '^mais opcoes?$',
          '^mais opções$',
          '^marketplace$',
          '^r\\$\\s?\\d+',
          '^visto por\\b',
          '^(reagir|responder|mais)$',
          '^inserir$',
          '^mensagem$',
          '^escrever para\\b',
          '^aa$',
          '^gif$',
          '^escolh(a|e) (um|uma) (emoji|figurinha|gif)$',
          '^clipe de voz$',
          'arquivo de ate 25 mb',
          'figurinha',
          'emoji',
          '^[a-z0-9]{1,2}\\s?h$', // "4 h", "2 h"
          '^(seg|ter|qua|qui|sex|sab|dom),?\\s?\\d{1,2}:\\d{2}$', // datas abreviadas
          '^matheo$', // nomes/labels acima da mensagem
          'carregando\\.\\.\\.'
        ].join('|'),
        'i'
      );
      
      function autorResolve(row) {
        try {
          const txt = norm(row.innerText || row.textContent || '');
          if (/(voce|v[óo]c[eê])\\s+enviou|you\\s+sent/i.test(txt)) return 'ia';
          const st = getComputedStyle(row);
          if (st && (String(st.justifyContent || '').includes('flex-end') || String(st.textAlign || '') === 'right')) {
            return 'ia';
          }
        } catch {}
        return 'cliente';
      }
      
      function textsFromRow(row) {
        const nodes = Array.from(row.querySelectorAll('div[dir="auto"]'))
          .filter(isVisible)
          .filter((el) => !el.closest('[contenteditable="true"]'))
          .filter((el) => !el.closest('[role="button"]'))
          .filter((el) => !el.closest('[role="toolbar"]'))
          .filter((el) => !el.closest('[aria-label^="Reagir"]'))
          .filter((el) => !el.closest('[aria-label^="Responder"]'))
          .filter((el) => !el.closest('[aria-label^="Mais"]'));
        
        const texts = nodes
          .map((el) => norm(el.innerText || el.textContent || ''))
          .filter((t) => t && t.length >= 2 && !SYS_RX.test(t));
        
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

/**
 * Encontra o campo de texto (composer) do chat
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {number} timeoutMs - Timeout em ms (default: 10000)
 * @returns {Promise<ElementHandle|null>} Handle do composer ou null
 */
async function findComposer(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of COMPOSER_SELECTORS) {
      try {
        const h = await page.$(sel);
        if (h) {
          const ok = await page.evaluate((el) => {
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

/**
 * Lê o texto da última mensagem enviada por "nós" no chat
 * 
 * @param {Page} page - Página do Puppeteer
 * @returns {Promise<string|null>} Texto da última mensagem enviada ou null
 */
async function readLastOutgoingText(page) {
  try {
    const text = await page.evaluate(() => {
      const norm = (s) => (s || '').toLowerCase();
      const bubbles = Array.from(
        document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')
      ).slice(-50);
      
      // Procura última bolha "nossa" (justifyContent: flex-end ou "você enviou")
      const me = bubbles.reverse().find((b) => {
        const txt = norm(b.innerText || b.textContent || '');
        if (/(você|voce|you)\s*(enviou|sent)/.test(txt)) return true;
        const style = getComputedStyle(b);
        return style && (style.justifyContent === 'flex-end' || style.textAlign === 'right');
      });
      
      if (!me) return null;
      
      // Extrai texto da bolha (sem o "você enviou")
      const txt = (me.innerText || me.textContent || '').trim();
      const cleaned = txt.replace(/^(você|voce|you)\s*(enviou|sent)[\s:]*/i, '').trim();
      return cleaned || null;
    });
    
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Limpa o composer (remove texto existente)
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {ElementHandle} campo - Handle do campo de texto
 */
async function clearComposerIfAny(page, campo) {
  try {
    if (!campo) return;
    const ctrlKey = process.platform === 'darwin' ? 'Meta' : 'Control';
    try {
      await campo.click({ delay: 20 });
    } catch {}
    try {
      await page.keyboard.down(ctrlKey);
      await page.keyboard.press('KeyA');
      await page.keyboard.up(ctrlKey);
    } catch {}
    try {
      await page.keyboard.press('Backspace');
    } catch {}
    try {
      await page.keyboard.press('Delete');
    } catch {}
  } catch {}
}

/**
 * Envia uma mensagem de texto no chat aberto
 * 
 * Processo:
 * 1. Garante que estamos no chat correto
 * 2. Encontra o composer
 * 3. Limpa conteúdo anterior
 * 4. Digita a mensagem
 * 5. Envia (Enter)
 * 6. Aguarda confirmação (ACK)
 * 
 * @param {Page} page - Página do Puppeteer
 * @param {string} chatId - ID do chat
 * @param {string} text - Texto a enviar
 * @returns {Promise<boolean>} true se enviou com sucesso (ACK confirmado)
 */
async function sendText(page, chatId, text) {
  // Verifica contexto antes de começar
  if (!(await assertOnChat(page, chatId, { timeoutMs: 0 }))) {
    return false;
  }
  
  // Encontra composer
  let campo = await findComposer(page, 10000);
  if (!campo) {
    // Tenta reobter se campo ausente ou desconectado
    try {
      if (!campo || (await campo.evaluate((el) => !el.isConnected).catch(() => true))) {
        for (const sel of COMPOSER_SELECTORS) {
          const h = await page.$(sel).catch(() => null);
          if (h) {
            const ok = await h.evaluate((el) => {
              const st = window.getComputedStyle(el);
              return (
                el.isConnected &&
                st &&
                st.visibility !== 'hidden' &&
                st.display !== 'none' &&
                el.offsetParent !== null
              );
            }).catch(() => false);
            if (ok) {
              campo = h;
              break;
            }
          }
        }
      }
    } catch {}
  }
  
  if (!campo) {
    throw new Error('composer_missing');
  }
  
  const ctrlKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  
  try {
    // Foco no composer
    await campo.click({ delay: 20 }).catch(() => {});
    
    // Limpeza: Select All + Backspace/Delete
    try {
      await page.keyboard.down(ctrlKey);
      await page.keyboard.press('KeyA');
      await page.keyboard.up(ctrlKey);
    } catch {}
    try {
      await page.keyboard.press('Backspace');
    } catch {}
    try {
      await page.keyboard.press('Delete');
    } catch {}
    
    // Aguarda composer esvaziar
    await page
      .waitForFunction((el) => ((el.innerText || el.textContent || '').trim().length === 0), { timeout: 1200 }, campo)
      .catch(() => {});
    
    // Digita mensagem
    await page.keyboard.type(String(text || ''), { delay: 0 });
    
    // Revalida contexto antes do Enter
    if (!(await assertOnChat(page, chatId, { timeoutMs: 0 }))) {
      await clearComposerIfAny(page, campo);
      return false;
    }
    
    // Envia (Enter)
    await page.keyboard.press('Enter');
    
    // Aguarda confirmação: bolha "Você enviou" ou composer vazio
    const sent = await Promise.race([
      (async () => {
        try {
          return await page
            .waitForFunction(() => {
              const norm = (s) => String(s || '').toLowerCase();
              const nodes = Array.from(
                document.querySelectorAll('div[role="row"],div[role="article"],div[data-testid]')
              ).slice(-25);
              return nodes.some((el) => /you\s+sent|v[ou]c[eê]\s+enviou/.test(norm(el.innerText || el.textContent || '')));
            }, { timeout: 7000 })
            .then(() => true)
            .catch(() => false);
        } catch {
          return false;
        }
      })(),
      (async () => {
        try {
          return await page
            .waitForFunction(
              (el) => ((el.innerText || el.textContent || '').trim().length === 0),
              { timeout: 7000 },
              campo
            )
            .then(() => true)
            .catch(() => false);
        } catch {
          return false;
        }
      })()
    ]);
    
    return sent;
  } catch (err) {
    await clearComposerIfAny(page, campo);
    throw err;
  }
}

module.exports = {
  ensureMarketplace,
  listRecentUnreadChats,
  openChat,
  ensureConversationReady,
  scrapeHistory,
  findComposer,
  readLastOutgoingText,
  sendText,
  assertOnChat,
  clearComposerIfAny
};

