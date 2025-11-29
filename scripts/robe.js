// scripts/robe.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { patchPage/*, ensureMinimizedWindowForPage*/ } = require('./browser.js');
const { detectLimitOverlayDeep, detectLimitOverlayEverywhere } = require('./browser.js');
const utils = require('./utils.js');
const fotos = require('./fotos.js');       // autoridade central de fotos
const locais = require('./locais.js');     // controlador de rotação de localizações
const manifestStore = require('./manifestStore.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');

// Log de issues (robusto; falha silenciosa se não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

// Sentinela para overlays/modais tardios do Facebook (Marketplace Create)
// Injeta MutationObserver e variáveis globais para sinalizar o popup
async function attachLimitOverlaySentinel(page) {
  try {
    await page.exposeFunction('__robeSetLimitOverlay', (payload) => {
      try {
        (window.top || window).___ROBE_LIMIT_OVERLAY__ = Object.assign((window.top || window).___ROBE_LIMIT_OVERLAY__ || {}, payload || {});
      } catch {}
    });
  } catch {}

  await page.evaluateOnNewDocument(() => {
    try {
      const TOP = (window.top || window);
      TOP.___ROBE_LIMIT_OVERLAY__ = { found: false, h2: '', body: '', ts: 0, where: '' };

      function textHitsLimitNormalized(t) {
        try { t = (t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); } catch { t = (t||'').toLowerCase(); }
        if (/voce\s+nao\s+pode\s+(criar|publicar).*(classificados|anuncios|listagens?|itens?).*(no\s+momento|agora)/.test(t)) return true;
        if (/you\s+can(?:'|’)?t\s+(post|create|list).*right\s+now/.test(t)) return true;
        if (/no\s+es\s+posible\s+(crear|publicar).*(anuncios?|art[ií]culos?|listados?|publicaciones?).*(en\s+este\s+momento|ahora)/.test(t)) return true;
        if (/(temporar(?:y|io)|temporariamente|temporalmente)\s+(limit|limite)/.test(t) && /(items?|listings?|classificados|anuncios?)/.test(t)) return true;
        if (/limite\s+atingido/.test(t) || /limit\s+reached/.test(t) || /limite\s+alcanzado/.test(t)) return true;
        if (/(ha|h[áa])\s+um\s+limite\s+tempor/.test(t) && /(itens?|vender|publicar|marketplace)/.test(t)) return true;
        if (/(there('|’)?s|there\s+is)\s+a\s+temporar(?:y)?\s+limit/.test(t) && /(how\s+many\s+items\s+you\s+(can|may)\s+(list|sell)|marketplace)/.test(t)) return true;
        if (/you(?:'|’)?re\s+temporar(?:ily)?\s+(blocked|restricted).*(post|create|list)/.test(t)) return true;
        if (/voce\s+esta\s+bloqueado\s+temporariamente/.test(t)) return true;
        return false;
      }

      function deepScanLimitOverlayInDocument(doc) {
        function norm(s) { try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); } catch { return (s||'').toLowerCase(); } }
        function getAllRoots(d) {
          const roots = [d];
          const walker = d.createTreeWalker(d, NodeFilter.SHOW_ELEMENT);
          let n = walker.currentNode;
          while (n) { if (n.shadowRoot) roots.push(n.shadowRoot); n = walker.nextNode(); }
          return roots;
        }
        function scanRoot(R){
          const heads = Array.from(R.querySelectorAll('h1,h2')).slice(0,50);
          for (const h of heads) {
            const ht = norm(h.innerText || h.textContent || '');
            if (textHitsLimitNormalized(ht)) return { found:true, where:'headline', snippet:(h.innerText||h.textContent||'').slice(0,200) };
          }
          const nodes = Array.from(R.querySelectorAll('h1,h2,div,span,p,section,button,[role="dialog"],[aria-modal="true"]')).slice(0,3000);
          for (const el of nodes) {
            const t = norm(el.innerText || el.textContent || '');
            if (textHitsLimitNormalized(t)) {
              return { found:true, where: (el.getAttribute && (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true')) ? 'dialog_any':'global_any', snippet: (el.innerText || el.textContent || '').slice(0,200) };
            }
          }
          return { found:false };
        }
        const roots = getAllRoots(doc);
        for (const R of roots) {
          const r = scanRoot(R);
          if (r && r.found) {
            TOP.___ROBE_LIMIT_OVERLAY__ = { found:true, where:r.where, h2:r.snippet, body:r.snippet, ts:Date.now() };
            return true;
          }
        }
        return false;
      }

      function scanAndSet() {
        try { if (TOP.___ROBE_LIMIT_OVERLAY__ && TOP.___ROBE_LIMIT_OVERLAY__.found) return; } catch {}
        try {
          deepScanLimitOverlayInDocument(document);
        } catch {}
      }
      scanAndSet();
      try {
        const mo = new MutationObserver(() => scanAndSet());
        mo.observe(document.documentElement, { childList:true, subtree:true, attributes:true, characterData:false });
        TOP.___ROBE_LIMIT_OBS__ = mo;
      } catch {}
    } catch {}
  });
}

async function waitSentinelLimitOverlay(page, timeoutMs = 10000) {
  try {
    const ok = await page.waitForFunction(() => {
      const TOP = (window.top || window);
      return !!(TOP.___ROBE_LIMIT_OVERLAY__ && TOP.___ROBE_LIMIT_OVERLAY__.found === true);
    }, { timeout: timeoutMs, polling: 100 });
    if (ok) {
      return await page.evaluate(() => (window.top||window).___ROBE_LIMIT_OVERLAY__ || { found:false });
    }
  } catch {}
  return null;
}

// FAST-PROBE: detecção ultra-rápida (1.8s) de overlay/limite na página de criação
async function fastDetectPostingLimit(page, { timeoutMs = 1800 } = {}) {
  try {
    const handle = await page.waitForFunction(() => {
      const TOP = (window.top || window);
      if (TOP.___ROBE_LIMIT_OVERLAY__ && TOP.___ROBE_LIMIT_OVERLAY__.found) {
        return TOP.___ROBE_LIMIT_OVERLAY__;
      }
      // deep scan instantâneo como fallback
      function textHitsLimitNormalized(t) {
        try { t = (t||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); } catch { t = (t||'').toLowerCase(); }
        if (/voce\s+nao\s+pode\s+(criar|publicar).*(classificados|anuncios|listagens?|itens?).*(no\s+momento|agora)/.test(t)) return true;
        if (/you\s+can(?:'|’)?t\s+(post|create|list).*right\s+now/.test(t)) return true;
        if (/no\s+es\s+posible\s+(crear|publicar).*(anuncios?|art[ií]culos?|listados?|publicaciones?).*(en\s+este\s+momento|ahora)/.test(t)) return true;
        if (/(temporar(?:y|io)|temporariamente|temporalmente)\s+(limit|limite)/.test(t) && /(items?|listings?|classificados|anuncios?)/.test(t)) return true;
        if (/limite\s+atingido/.test(t) || /limit\s+reached/.test(t) || /limite\s+alcanzado/.test(t)) return true;
        if (/(ha|h[áa])\s+um\s+limite\s+tempor/.test(t) && /(itens?|vender|publicar|marketplace)/.test(t)) return true;
        if (/(there('|’)?s|there\s+is)\s+a\s+temporar(?:y)?\s+limit/.test(t) && /(how\s+many\s+items\s+you\s+(can|may)\s+(list|sell)|marketplace)/.test(t)) return true;
        if (/you(?:'|’)?re\s+temporar(?:ily)?\s+(blocked|restricted).*(post|create|list)/.test(t)) return true;
        if (/voce\s+esta\s+bloqueado\s+temporariamente/.test(t)) return true;
        return false;
      }
      function deepScanLimitOverlayInDocument(doc) {
        const TOP2 = (window.top || window);
        function norm(s) { try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); } catch { return (s||'').toLowerCase(); } }
        function getAllRoots(d) {
          const roots = [d];
          const walker = d.createTreeWalker(d, NodeFilter.SHOW_ELEMENT);
          let n = walker.currentNode;
          while (n) { if (n.shadowRoot) roots.push(n.shadowRoot); n = walker.nextNode(); }
          return roots;
        }
        function scanRoot(R){
          const heads = Array.from(R.querySelectorAll('h1,h2')).slice(0,50);
          for (const h of heads) {
            const ht = norm(h.innerText || h.textContent || '');
            if (textHitsLimitNormalized(ht)) return { found:true, where:'headline', snippet:(h.innerText||h.textContent||'').slice(0,200) };
          }
          const nodes = Array.from(R.querySelectorAll('h1,h2,div,span,p,section,button,[role="dialog"],[aria-modal="true"]')).slice(0,3000);
          for (const el of nodes) {
            const t = norm(el.innerText || el.textContent || '');
            if (textHitsLimitNormalized(t)) {
              return { found:true, where: (el.getAttribute && (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true')) ? 'dialog_any':'global_any', snippet: (el.innerText || el.textContent || '').slice(0,200) };
            }
          }
          return { found:false };
        }
        const roots = getAllRoots(doc);
        for (const R of roots) {
          const r = scanRoot(R);
          if (r && r.found) {
            TOP2.___ROBE_LIMIT_OVERLAY__ = { found:true, where:r.where, h2:r.snippet, body:r.snippet, ts:Date.now() };
            return true;
          }
        }
        return false;
      }
      const hit = deepScanLimitOverlayInDocument(document);
      return hit ? (window.top||window).___ROBE_LIMIT_OVERLAY__ : false;
    }, { timeout: timeoutMs, polling: 100 });
    if (!handle) return null;
    const v = await handle.jsonValue().catch(() => null);
    return v && v.found ? v : null;
  } catch { return null; }
}

// Helpers básicos
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// PATCH MILITAR — Constantes de limit_posting
const LIMIT_POSTING_REASON = 'limit_posting';
const LIMIT_POSTING_MS = 24 * 60 * 60 * 1000;

// Guards ABSOLUTOS para abortar fluxo pós-limit
const ABORT_LIMIT_POSTING = 'LIMIT_POSTING_ABORT';

function throwAbortLimitPosting() {
  const e = new Error(ABORT_LIMIT_POSTING);
  e.LIMIT_POSTING = true;
  throw e;
}

async function applyLimitPostingAndAbort({ page, nome, attId, where, overlaySnapshot }) {
  logger.warn('[ROBE] Limit posting detectado - aplicando pausa 24h', { nome, attId, where, overlay: overlaySnapshot || null });
  // Snapshot do manifest antes
  // Logging stack trace no evento critical (limit_posting)
  const stack = (new Error('limit_posting')).stack;
  try { if (issues && typeof issues.append === 'function') { await issues.append(nome, 'mil_action', 'limit_posting_apply ' + (stack||'')); } } catch {}

  const manBefore = await manifestStore.read(nome).catch(()=>null);

  stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'limit_overlay_detected', where });

  // Log detalhado do overlay (h2/body/ts)
  try {
    if (overlaySnapshot && (overlaySnapshot.h2 || overlaySnapshot.body)) {
      stepLog.appendJSONL(nome, 'robe', {
        attempt: attId,
        step: 'limit_overlay_snapshot',
        h2: String(overlaySnapshot.h2 || '').slice(0, 200),
        body: String(overlaySnapshot.body || '').slice(0, 400),
        ts: overlaySnapshot.ts || Date.now()
      });
      if (issues && typeof issues.append === 'function') {
        await issues.append(nome, 'mil_action',
          `limit_post_overlay where=${where} h2="${String(overlaySnapshot.h2||'').slice(0,120)}" body="${String(overlaySnapshot.body||'').slice(0,180)}"`);
      }
    }
  } catch {}

  // Pause hard 24h
  await manifestStore.update(nome, m => {
    m = m || {};
    m.robeCooldownUntil = Date.now() + LIMIT_POSTING_MS;
    m.robeCooldownRemainingMs = 0;
    m.robePauseReason = LIMIT_POSTING_REASON;
    return m;
  });

  // Log old/new mudanças no manifest
  try {
    const manAfter = await manifestStore.read(nome).catch(()=>null);
    const oldUntil = (manBefore && manBefore.robeCooldownUntil) || 0;
    const oldReason = (manBefore && manBefore.robePauseReason) || '';
    const newUntil = (manAfter && manAfter.robeCooldownUntil) || 0;
    const newReason = (manAfter && manAfter.robePauseReason) || '';
    stepLog.appendJSONL(nome, 'robe', {
      attempt: attId,
      step: 'pause_24h_applied',
      oldUntil, newUntil, oldReason, newReason
    });
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, 'mil_action',
        `limit_posting_manifest_update old_until=${oldUntil} new_until=${newUntil} old_reason=${oldReason} new_reason=${newReason}`);
    }
  } catch {}

  // Logs e fechamento
  stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'abort_flow', reason: LIMIT_POSTING_REASON, pageClosed: true });
  try { await issues.append(nome, 'robe_error', 'limit_posting_detected: pausa 24h aplicada'); } catch {}
  try { await safeClosePage(page); } catch {}

  throwAbortLimitPosting();
}

// Adicionar helper local para logar issues (assíncrono e silencioso)
async function logIssue(nome, type, message) {
  try {
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome, type, message);
    }
  } catch {
    // silencioso
  }
}

// Polyfill de XPath para garantir compatibilidade total
async function ensureXPathPolyfill(page) {
  if (typeof page.$x === 'function') return;
  page.$x = async function(xpath) {
    const arrHandle = await page.evaluateHandle((xp) => {
      const res = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < res.snapshotLength; i++) {
        out.push(res.snapshotItem(i));
      }
      return out;
    }, xpath);
    const props = await arrHandle.getProperties();
    const result = [];
    for (const handle of props.values()) {
      const el = handle.asElement ? handle.asElement() : null;
      if (el) result.push(el);
      else { try { handle.dispose && handle.dispose(); } catch {} }
    }
    try { arrHandle.dispose && arrHandle.dispose(); } catch {}
    return result;
  };
}

// IO seguro
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, dataObj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dataObj, null, 2));
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch { return false; }
}

// Busca robusta por input com rótulo visível
async function findInputByLabel(page, labelText, timeout = 8000) {
  const xpaths = [
    `//label[.//span[normalize-space()="${labelText}"]]//input`,
    `//span[normalize-space()="${labelText}"]/ancestor::*[self::label or self::div][1]//input`,
    `//label[.="${labelText}"]//input`,
    `//input[@aria-label="${labelText}"]`,
    `//input[@placeholder="${labelText}"]`
  ];
  const started = Date.now();
  while (Date.now() - started < timeout) {
    for (const xp of xpaths) {
      const handles = await page.$x(xp);
      if (handles && handles[0]) return handles[0];
    }
    await sleep(180);
  }
  return null;
}

// Busca robusta por combobox (role=combobox) a partir do rótulo
async function findComboboxByLabel(page, labelText, timeout = 8000) {
  const xp = `//label[@role="combobox" and .//span[normalize-space()="${labelText}"]]`;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const handles = await page.$x(xp);
    if (handles && handles[0]) return handles[0];
    await sleep(180);
  }
  return null;
}

// Clicar em um item por texto (fallback)
async function clickItemByText(page, text, timeout = 5000) {
  const xp = `//*[normalize-space()="${text}"]`;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const els = await page.$x(xp);
    if (els && els[0]) {
      await els[0].click();
      return true;
    }
    await sleep(120);
  }
  0
  return false;
}

// Função robusta para detectar overlay "Limite atingido" e o novo bloqueio "você não pode criar classificados no momento" (multilíngue, headline/corpo autonome)
async function detectLimitOverlay(page, { timeoutMs = 15000, intervalMs = 350, debug = (process.env.LIMIT_DEBUG==='1') } = {}) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const start = Date.now();
  let rounds = 0;

  async function checkOnce() {
    try {
      const v = await page.evaluate(() => {
        const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const nodes = Array.from(document.querySelectorAll('h1,h2,span,div,p,section')).slice(0, 3000);
        const texts = nodes.map(el => norm(el.innerText || el.textContent || '')).filter(Boolean);
        const joined = texts.join(' ');

        // Headline/H2 novo: "você não pode criar ... no momento/agora"
        const h2Exact = texts.some(t =>
          /voce\s+nao\s+pode\s+criar\s+(classificados|anuncios|listagens?|itens?)\s+(no\s+momento|agora)/.test(t)
        );

        // Corpo PT: limites temporários para venda/classificados
        const ptTempLimit = (
          /ha\s+um\s+limite\s+temporar/.test(joined) &&
          (/itens?\s+voce\s+pode\s+vender/.test(joined) || /no\s+marketplace/.test(joined))
        );
        // Corpo EN: temporarily limit how many items you can post/sell
        const enTempLimit = (
          /(there('|’)?s|there\s+is)\s+a\s+temporar(?:y)?\s+limit/.test(joined) &&
          /(how\s+many\s+items\s+you\s+(can|may)\s+(list|sell)|marketplace)/.test(joined)
        );
        // Corpo ES: hay un limite temporal ...
        const esTempLimit = (
          /(hay|existe)\s+un\s+limite\s+tempor/.test(joined) &&
          /(cuantos\s+articulos\s+puedes\s+(publicar|vender)|marketplace)/.test(joined)
        );

        // Corpo PT: "você não pode criar ..."
        const ptCantCreate = /voce\s+nao\s+pode\s+criar\s+(classificados|anuncios|listagens?|itens?)\s+(no\s+momento|agora)/.test(joined);

        const strong = h2Exact || ptCantCreate || ptTempLimit || enTempLimit || esTempLimit;

        return { strong, h2Exact, ptCantCreate, ptTempLimit, enTempLimit, esTempLimit };
      });
      return v || { strong:false };
    } catch {
      return { strong:false };
    }
  }
  while ((Date.now() - start) < timeoutMs) {
    rounds++;
    const res = await checkOnce();
    if (debug) {
      try { require('./issues.js').append && require('./issues.js').append('system', 'mil_action', `limit_poll round=${rounds} res=${JSON.stringify(res)}`); } catch {}
    }
    if (res.strong) return true;
    await sleep(intervalMs);
  }
  return false;
}

// Detectar “Limite atingido” ao criar/publicar
async function detectLimitReached(page) {
  try {
    const v = await page.evaluate(() => {
      const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const arr = Array.from(document.querySelectorAll('h1,h2,span,div')).slice(0,2000)
        .map(el => norm(el.innerText||el.textContent||''));
      const h2Limit = arr.some(t => /limite atingido/.test(t));
      const msg = arr.some(t => t.includes('voce nao pode mais criar novos classificados') && t.includes('limite') && t.includes('frequencia'));
      return h2Limit && msg;
    });
    return !!v;
  } catch { return false; }
}

// Botão habilitado por texto
async function findEnabledButton(page, label, timeout = 700) {
  const start = Date.now();
  const xp = `//span[normalize-space()="${label}"]`;
  while (Date.now() - start < timeout) {
    const spans = await page.$x(xp);
    for (const sp of spans) {
      let btn = sp;
      // Sobe até host BUTTON ou role=button em no máximo 5 níveis
      for (let up = 0; up < 5 && btn; up++) {
        // Testa host BUTTON
        const tagOk = await btn.evaluate(el => el.tagName.toUpperCase() === 'BUTTON');
        const roleOk = await btn.evaluate(el => el.getAttribute && el.getAttribute('role') === 'button');
        if (tagOk || roleOk) {
          // Verifica disponível/habilitado
          const enabled = await btn.evaluate(el => {
            const st = window.getComputedStyle(el);
            if (!st) return false;
            if (st.display === 'none' || st.visibility === 'hidden' || !el.offsetParent) return false;
            if (el.getAttribute('aria-disabled') === 'true') return false;
            if (el.disabled === true) return false;
            if (el.getAttribute('tabindex') === '-1') return false;
            return true;
          });
          if (enabled) return btn;
        }
        btn = await btn.evaluateHandle(el => el.parentElement);
        btn = btn.asElement();
      }
    }
    await sleep(120);
  }
  return null;
}

async function forensicScreenshot(page, nome, label) {
  try {
    const dir = require('path').join(__dirname, '..', 'dados', 'perfis', String(nome||'system'));
    require('fs').mkdirSync(dir, { recursive: true });
    const file = require('path').join(dir, `${label}_${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false }).catch(()=>{});
    return file;
  } catch { return null; }
}

// Helpers de clique exato e fluxo de botão (Avançar/Publicar)
async function clickExactCenter(page, handle) {
  try { await handle.focus?.(); } catch {}
  const box = await handle.boundingBox().catch(()=>null);
  if (box && box.width > 0 && box.height > 0) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await sleep(20);
    await page.mouse.up();
  } else {
    await handle.click({ delay: 60 }).catch(()=>{});
  }
}

async function clickFlowExactRetry(page, nome, { maxSteps = 24, publishMaxRetries = 3, waitAfterAdvanceMs = 400 } = {}) {
  const sequence = [];
  let publishClicked = false;
  let publishTries = 0;
  for (let step = 1; step <= maxSteps; step++) {
    // PUBLICAR — tenta até publishMaxRetries
    const btnPub = await findEnabledButton(page, 'Publicar', 700);
    if (btnPub) {
      publishTries++;
      await clickExactCenter(page, btnPub);
      sequence.push('publicar');
      const stateChange = await page.waitForFunction((label) => {
        const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button,div[role="button"],a[role="button"]'));
        for (const el of buttons) {
          const t = (el.innerText || el.textContent || '').trim();
          if (norm(t) === norm(label)) {
            const disabled = el.getAttribute('aria-disabled')==='true' || el.disabled || el.getAttribute('tabindex')==='-1';
            const spinner = !!el.querySelector('svg[role="progressbar"], [role="progressbar"], [aria-busy="true"], svg[aria-label*="carregando"]');
            if (disabled || spinner) return true;
          }
        }
        const exists = buttons.some(el => norm((el.innerText||el.textContent||'').trim()) === norm(label));
        return !exists;
      }, { timeout: 12000 }, 'Publicar').catch(()=>false);

      if (stateChange) { publishClicked = true; break; }
      if (publishTries >= publishMaxRetries) break;
      await sleep(320);
      continue;
    }
    // AVANÇAR
    const btnAv = await findEnabledButton(page, 'Avançar', 700);
    if (btnAv) {
      await clickExactCenter(page, btnAv);
      sequence.push('avancar');
      await sleep(waitAfterAdvanceMs);
      continue;
    }
    await sleep(150);
  }
  return { sequence, publishClicked };
}

// --- O PATCH PRINCIPAL: clique só uma vez, espera o botão PUBLICAR ficar cinza/desabilitado/spinner ---
async function clickPublishAndWaitState(page, nome, {
  maxTries = 3,
  publishLabel = 'Publicar',
  waitSpinnerTimeoutMs = 12000
} = {}) {
  const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  let tries = 0, clicked = false;
  for (; ++tries <= maxTries;) {
    // 1. Localiza o botão habilitado, azul, texto exato!
    const btn = await robustFindEnabledButton(page, [publishLabel], 2000);
    if (!btn) {
      await forensicScreenshot(page, nome, `no_publish_btn_${tries}`);
      return { clicked: false, confirmed: false, reason: 'no_btn' };
    }
    // Estado _antes_
    const btnTxt = (await page.evaluate(el => el.innerText || el.textContent || '', btn)).trim();
    const disabled = await page.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('tabindex') === '-1', btn);

    if (norm(btnTxt) !== norm(publishLabel) || disabled) {
      await forensicScreenshot(page, nome, `publish_btn_not_ready_${tries}`);
      return { clicked: false, confirmed: false, reason: 'not_ready' };
    }
    await forensicScreenshot(page, nome, `before_click_publish_${tries}`);

    // 2. Clique!
    let clickOk = false;
    try { await btn.focus(); await btn.click({delay: 70}); clickOk = true; } catch {}
    clicked = true;
    await forensicScreenshot(page, nome, `after_click_publish_${tries}`);

    // 3. Espera: botão PUBLICAR muda para cinza/desabilitado/spinner?
    try {
      const stateChange = await page.waitForFunction((_label) => {
        const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
        const btns = Array.from(document.querySelectorAll('button,div[role="button"],a[role="button"]'));
        for (const el of btns) {
          const t = (el.innerText || el.textContent || '').trim();
          if (norm(t) === norm(_label)) {
            const disabled = el.getAttribute('aria-disabled')==='true' || el.disabled || el.getAttribute('tabindex')==='-1';
            // botão virou cinza/desabilitado: AGUARDE, NÃO RECLIQUE
            if (disabled) return true;
            // spinner? (verifica o loading… icone/svg dentro do botão)
            const hasSpinner = !!el.querySelector('svg[aria-label*="carregando"], svg, div[aria-label*="carregando"]');
            if (hasSpinner) return true;
          }
        }
        // botão sumiu? página mudou
        const hasBtn = btns.some(el => norm(el.innerText || el.textContent || '') === norm(_label));
        if (!hasBtn) return true;
        // Página já foi para painel seller?
        if (/marketplace\/(you\/selling|profile|you\/dashboard)/.test(location.pathname)) return true;
        // Rota changed (step audience?) ok também
        if (/[?&]step=/.test(location.search)) return true;
        return false;
      }, {timeout: waitSpinnerTimeoutMs}, publishLabel);
      if (stateChange) return { clicked: true, confirmed: true };
    } catch {}
    // Se não virou cinza, tenta de novo até maxTries
  }
  return { clicked, confirmed: false, reason: 'never_disabled' };
}
// ===================== FIM PATCH MILITAR ======================

// NOVOS HELPERS (PATCH DINÂMICO AVANÇAR/PUBLICAR)
function normLabel(s) {
  try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); }
  catch { return String(s||'').trim().toLowerCase(); }
}
function canonicalLabel(tNorm) {
  if (tNorm === 'avançar' || tNorm === 'avancar') return 'avancar';
  if (tNorm === 'publicar') return 'publicar';
  return tNorm;
}

// NOVOS HELPERS ATUALIZADOS: meta e resolução robusta de botões
function __robeComputeButtonMeta(el, wantedCanon) {
  function N(s){ try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); } catch { return String(s||'').trim().toLowerCase(); } }
  function BTN_labelCanonFromText(txt) {
    const t = N(txt);
    if (!t) return null;
    // publicar em pt/en e variantes
    if (
      t === "publicar" ||
      t.startsWith("publicar") ||
      t.includes("postar") ||
      t === "post" ||
      t.startsWith("post ") ||
      t.includes("publish")
    ) return "publicar";
    // avancar, continuar, próximo em pt/en
    if (
      t === "avancar" ||
      t === "avançar" ||
      t.startsWith("avancar") ||
      t.startsWith("avançar") ||
      t.includes("próximo") ||
      t.includes("proximo") ||
      t.includes("continuar") ||
      t.includes("continue") ||
      t === "next"
    ) return "avancar";
    return null;
  }
  function BTN_isTargetLabel(txt, wantedCanon) {
    const canon = BTN_labelCanonFromText(txt);
    if (!wantedCanon) return canon === "publicar" || canon === "avancar";
    return canon === wantedCanon;
  }
  function findWizardRoot(){
    const mains = Array.from(document.querySelectorAll('[role="main"]'));
    const hasCreateSignals = (el) => {
      const txt = (el.innerText||'').toLowerCase();
      if (/(prévia|previa|detalhes|para vender|anunciar em mais locais|os itens do marketplace são públicos)/i.test(txt)) return true;
      if (el.querySelector('input[aria-label="Título"],input[aria-label="Localização"],label[role="combobox"] span')) return true;
      return false;
    };
    for (const m of mains) if (hasCreateSignals(m)) return m;
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]'))
      .find(d => /marketplace|criar|anunciar/i.test((d.getAttribute('aria-label')||d.innerText||'').toLowerCase()));
    return dlg || document.body;
  }
  const root = findWizardRoot();
  const st = window.getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const text = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
  const t = N(text);
  const visible = !!(st && st.visibility!=='hidden' && st.display!=='none' && r && r.width>=20 && r.height>=16);
  const ariaDisabled = el.getAttribute('aria-disabled')==='true';
  const tabIndex = el.getAttribute('tabindex') || '';
  const disabledProp = el.disabled===true;
  const hasSpinner = !!el.querySelector('svg[role="progressbar"], div[role="progressbar"], [aria-busy="true"], svg[aria-label*="carregando"]');
  const inDialog = !!el.closest('[role="dialog"]');
  const inNav = !!el.closest('[role="navigation"],[role="banner"],header');
  const inRoot = !!(root && root.contains(el));
  const fixed = st.position==='fixed';
  const sticky = st.position==='sticky';
  const peNone = st.pointerEvents==='none';
  const inViewport = r && r.width>0 && r.height>0 && (r.bottom>0) && (r.right>0) && (r.top<window.innerHeight) && (r.left<window.innerWidth);
  let occluded = true;
  if (inViewport) {
    const cx = Math.min(window.innerWidth-1, Math.max(1, Math.floor(r.left + r.width/2)));
    const cy = Math.min(window.innerHeight-1, Math.max(1, Math.floor(r.top + r.height/2)));
    const top = document.elementFromPoint(cx, cy);
    occluded = !!(top && top!==el && !el.contains(top));
  }
  const rootIsDialog = !!(root && root.getAttribute && root.getAttribute('role') === 'dialog');
  const inWizardDialog = inDialog && rootIsDialog && root && root.contains(el);
  const allowedDialogGate = (!inDialog) || inWizardDialog;
  const allowedFixedGate = (st.position !== 'fixed') || inWizardDialog || inRoot;
  const enabled =
    BTN_isTargetLabel(text, wantedCanon) &&
    visible &&
    !ariaDisabled && !disabledProp && tabIndex !== '-1' &&
    !hasSpinner && !peNone &&
    allowedDialogGate &&
    !inNav &&
    inRoot &&
    allowedFixedGate &&
    inViewport &&
    !occluded;
  const z = parseInt(st.zIndex||'0',10)||0;
  return {
    t, labelCanon: BTN_labelCanonFromText(text),
    visible, ariaDisabled, tabIndex, disabledProp, hasSpinner,
    inDialog, inNav, inRoot, position: st.position, pointerEvents: st.pointerEvents,
    inViewport, occluded, z,
    rect: { x: r?.x||0, y: r?.y||0, w: r?.width||0, h: r?.height||0 },
    enabled,
    outerHTML: (el.outerHTML||'').slice(0,700)
  };
}

async function waitButtonEffect(page, clickedLabelCanon, { timeoutMs = 8000, hrefBefore = null } = {}) {
  const href0 = hrefBefore || await page.evaluate(() => location.href).catch(()=>null);
  try {
    const ok = await page.waitForFunction((lab, href0) => {
      function N(s){ try { return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase(); } catch { return String(s||'').trim().toLowerCase(); } }
      const matches = (txt) => {
        const t = (txt||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
        if (lab==='publicar') return t.includes('publicar')||t.includes('postar')||t.includes('publish');
        if (lab==='avancar') return t.includes('avancar')||t.includes('avançar')||t.includes('próximo')||t.includes('continuar')||t.includes('next')||t.includes('continue')||t.includes('proximo');
        return false;
      };
      const btns = Array.from(document.querySelectorAll('button,div[role="button"],a[role="button"]'));
      let exists = false, disabled=false, spinner=false;
      for (const el of btns) {
        const t = N(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
        if (!matches(t)) continue;
        exists = true;
        const ariaDisabled = el.getAttribute('aria-disabled')==='true';
        const tabIndex = el.getAttribute('tabindex') || '';
        const disProp = el.disabled===true;
        const sp = !!el.querySelector('svg[role="progressbar"], [role="progressbar"], [aria-busy="true"], svg[aria-label*="carregando"]');
        if (ariaDisabled || disProp || tabIndex==='-1') disabled = true;
        if (sp) spinner = true;
      }
      const hrefChanged = (href0 && href0 !== location.href);
      const routeSelling = /marketplace\/(you\/selling|profile|you\/dashboard)/.test(location.pathname);
      return (!exists) || disabled || spinner || hrefChanged || routeSelling;
    }, { timeout: timeoutMs }, clickedLabelCanon, href0);
    return { ok: !!ok };
  } catch {
    return { ok:false, timeout:true };
  }
}

// Fonte de localizações (JSON)
function listLocalizacoesPorCidade(cidade) {
  try {
    const localPath = path.join(__dirname, '..', 'dados', 'localizacoes.json');
    const raw = readJsonSafe(localPath, null);
    if (!raw) return [];
    const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();

    if (Array.isArray(raw)) {
      const hit = raw.find(ent =>
        norm(ent?.cidade) === norm(cidade) ||
        norm(ent?.nome) === norm(cidade) ||
        norm(ent?.id) === norm(cidade)
      );
      if (hit && Array.isArray(hit.localizacoes)) return hit.localizacoes.slice(0);
      return [];
    }

    const key = Object.keys(raw).find(k => norm(k) === norm(cidade));
    if (key && Array.isArray(raw[key])) return raw[key].slice(0);
    return Array.isArray(raw['default']) ? raw['default'].slice(0) : [];
  } catch {
    return [];
  }
}

// Fallback aleatório
function pickLocalizacaoAleatoria(cidade) {
  const lista = listLocalizacoesPorCidade(cidade);
  if (!lista.length) return 'São Paulo';
  return lista[Math.floor(Math.random() * lista.length)];
}

// Preenche Título e confere (timings otimizados)
async function preencherTitulo(page, titulo) {
  const inp = await findInputByLabel(page, 'Título', 7000);
  if (!inp) throw new Error('Campo Título não localizado.');
  await inp.click({ clickCount: 3 });
  await sleep(jitter(120, 220));
  await inp.type(titulo, { delay: jitter(12, 20) });
  await sleep(jitter(120, 200));
  const val = await page.evaluate(el => el.value, inp);
  if (!val || !String(val).trim()) throw new Error('Falha ao preencher Título (value vazio).');
}

// Preenche Preço 0, Enter e confere (timings otimizados)
async function preencherPreco(page) {
  const inp = await findInputByLabel(page, 'Preço', 7000);
  if (!inp) throw new Error('Campo Preço não localizado.');
  await inp.click({ clickCount: 3 });
  await sleep(jitter(120, 220));
  await inp.type('0', { delay: jitter(8, 15) });
  await sleep(jitter(100, 180));
  await inp.press('Enter');
  await sleep(jitter(200, 320));
  const val = await page.evaluate(el => el.value, inp);
  const ok = val && (val.trim() === '0' || /(^R\$?\s*0(,00)?$)/.test(val.trim()));
  if (!ok) throw new Error(`Preço não ficou "0" (value="${val}").`);
}

// Categoria: Móveis (multi-modelo: novo input/search com fallback legacy)
async function selecionarCategoriaMoveis(page) {
  // Novo DOM: input/combobox de busca
  const input = await page.$('input[aria-label="Categoria"][role="combobox"][type="search"]');
  if (input) {
    await input.click({ delay: 40 }).catch(()=>{});
    await sleep(120);
    // No NOVO DOM: deve ser "Diversos"
    const alvo = 'Diversos';
    await input.type(alvo, { delay: 22 }).catch(()=>{});
    await sleep(700);
    await page.keyboard.press('Enter');
    await sleep(350);
    // Validação assertiva do NOVO DOM (aceitou "Diversos"?)
    const ok = await page.evaluate((alvoNorm) => {
      const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const inp = document.querySelector('input[aria-label="Categoria"]');
      if (inp && norm(inp.value).includes(alvoNorm)) return true;
      // fallback: às vezes a seleção aparece em label/summary ao lado
      const lab = Array.from(document.querySelectorAll('label')).find(l=> (l.textContent||'').includes('Categoria'));
      const txt = lab ? (lab.innerText||lab.textContent||'') : '';
      return norm(txt).includes(alvoNorm);
    }, 'diversos');
    if (!ok) throw new Error('Falha ao selecionar a categoria "Diversos" no novo DOM.');
    return;
  }

  // Legacy DOM (combobox/tab-enter): “Móveis”
  const combo = await findComboboxByLabel(page, 'Categoria', 7000);
  if (!combo) throw new Error('Combobox "Categoria" não localizado.');
  await combo.click();
  await sleep(jitter(220, 380));
  try {
    await page.keyboard.press('Tab');
    await sleep(jitter(120, 200));
    await page.keyboard.press('Enter');
    await sleep(jitter(220, 360));
  } catch {}

  const ok1 = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Categoria'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return /Móveis/.test(box.innerText || '');
  });
  if (ok1) return;

  await combo.click();
  await sleep(jitter(180, 300));
  const clicked = await clickItemByText(page, 'Móveis', 2500);
  if (!clicked) {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('ArrowDown');
      await sleep(60);
      const focusedIsMoveis = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active) return false;
        const t = (active.innerText || active.textContent || '').trim();
        return t === 'Móveis';
      });
      if (focusedIsMoveis) {
        await page.keyboard.press('Enter');
        break;
      }
    }
  }
  await sleep(jitter(250, 380));
  const ok2 = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Categoria'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return /Móveis/.test(box.innerText || '');
  });
  if (!ok2) throw new Error('Falha ao selecionar a categoria "Móveis".');
}

// Condição: Novo (timings otimizados)
async function selecionarCondicaoNovo(page) {
  const combo = await findComboboxByLabel(page, 'Condição', 7000);
  if (!combo) throw new Error('Combobox "Condição" não localizado.');
  await combo.click();
  await sleep(jitter(200, 320));
  await page.keyboard.press('Enter');
  await sleep(jitter(180, 260));
  await page.keyboard.press('ArrowDown');
  await sleep(60);
  await page.keyboard.press('Enter');
  await sleep(jitter(220, 360));
  const ok = await page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Condição'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return /Novo/.test(box.innerText || '');
  });
  if (!ok) throw new Error('Falha ao selecionar a condição "Novo".');
}

// Garantir “Mais detalhes” aberto
async function ensureMaisDetalhesAberto(page, timeout = 8000) {
  const start = Date.now();
  while ((Date.now() - start) < timeout) {
    const expanded = await page.evaluate(() => {
      const span = Array.from(document.querySelectorAll('div[role="button"] span'))
        .find(s => (s.textContent || '').trim() === 'Mais detalhes');
      if (!span) return 'notfound';
      const host = span.closest('div[role="button"]');
      if (!host) return 'notfound';
      return host.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed';
    });

    if (expanded === 'open') return true;

    if (expanded === 'notfound') {
      await page.evaluate(() => window.scrollBy(0, Math.max(250, window.innerHeight * 0.4)));
      await sleep(150);
    }

    if (expanded === 'closed') {
      await page.evaluate(() => {
        const span = Array.from(document.querySelectorAll('div[role="button"] span'))
          .find(s => (s.textContent || '').trim() === 'Mais detalhes');
        if (!span) return;
        const host = span.closest('div[role="button"]');
        if (!host) return;
        host.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      });
      await sleep(250);
    }
  }
  return false;
}

// Validação de localização
async function isLocalizacaoValida(page) {
  return await page.evaluate(() => {
    const inp = document.querySelector('input[aria-label="Localização"]');
    if (!inp) return false;
    const val = (inp.value || '').trim();
    const invalid = inp.getAttribute('aria-invalid') === 'true';
    let ok = !!val && !invalid;
    try {
      const label = inp.closest('label');
      const siblingWrap = label ? label.nextElementSibling : null;
      const okIcon = siblingWrap && siblingWrap.querySelector('i[aria-label*="válida"]');
      if (okIcon) ok = true;
    } catch {}
    return ok;
  });
}

// ————————— FAST-LANE: readiness da página “Criar item” —————————
// Timeout reduzido a 3500ms e fallback curto.
async function waitForCreateItemReady(page, { timeout = 3500 } = {}) {
  const start = Date.now();
  async function check() {
    // Presença (não exige “visível”), pois janela minimizada pode alterar métricas de visibilidade
    return await page.evaluate(() => {
      const file = document.querySelector('input[type="file"][accept*="image"], input[type="file"]');
      const titulo = Array.from(document.querySelectorAll('input')).find(i => i.getAttribute('aria-label') === 'Título' || i.getAttribute('placeholder') === 'Título');
      const catLbl = Array.from(document.querySelectorAll('label[role="combobox"] span')).find(s => (s.textContent || '').includes('Categoria'));
      return !!file && (!!titulo || !!catLbl);
    });
  }
  while ((Date.now() - start) < timeout) {
    try { if (await check()) return true; } catch {}
    await sleep(100);
  }
  return false;
}

// Preenche Localização via ciclo global (locais.js) e retorna a localização usada
async function preencherLocalizacao(page, cidade) {
  const okMaisDetalhes = await ensureMaisDetalhesAberto(page, 8000);
  if (!okMaisDetalhes) throw new Error('Não foi possível expandir “Mais detalhes”.');

  let inp = await findInputByLabel(page, 'Localização', 6000);
  if (!inp) inp = await page.$('input[aria-label="Localização"]');
  if (!inp) {
    await page.evaluate(() => window.scrollBy(0, Math.max(300, window.innerHeight * 0.5)));
    await sleep(300);
    inp = await findInputByLabel(page, 'Localização', 3500) || await page.$('input[aria-label="Localização"]');
  }
  if (!inp) throw new Error('Campo Localização não localizado.');

  // Anti-loop: controle de sessões
  const visited = new Set();
  const allLocs = listLocalizacoesPorCidade(cidade); // lista bruta para medir ciclo

  // Tenta até 20 candidatos do ciclo
  for (let tent = 0; tent < 20; tent++) {
    const sug = await locais.nextLocationForCity(cidade);
    if (!sug.ok) throw new Error('Sem localizações disponíveis para esta cidade.');
    const cand = sug.location;

    if (visited.has(cand)) {
      try { await locais.reportInvalid(cidade, cand, 'repeat_in_session'); } catch {}
      continue;
    }
    visited.add(cand);

    try { await inp.click({ clickCount: 3 }); } catch {}
    await sleep(jitter(100, 180));
    try { await page.keyboard.press('Backspace'); } catch {}
    await sleep(jitter(100, 160));
    await inp.type(cand, { delay: jitter(10, 18) });
    await sleep(jitter(600, 900));

    for (let idx = 0; idx < 2; idx++) {
      try { await inp.focus(); } catch {}
      await sleep(80);
      try { await page.keyboard.press('ArrowDown'); } catch {}
      await sleep(jitter(80, 140));
      try { await page.keyboard.press('Enter'); } catch {}
      await sleep(jitter(350, 550));

      if (await isLocalizacaoValida(page)) {
        // sucesso! consome localização e retorna
        try { await locais.confirmUsed(cidade, cand); } catch {}
        return cand;
      }
    }

    // NÃO validou; consome localização, marca como inválida e passa:
    try { await locais.confirmUsed(cidade, cand); } catch {}
    try { await locais.reportInvalid(cidade, cand, 'not_valid_on_fb'); } catch {}
    await sleep(120);

    // Anti-loop: se tentamos todas localizações do ciclo, aborta!
    if (visited.size >= allLocs.length) {
      throw new Error('Sem localizações válidas para essa cidade!');
    }
  }

  throw new Error('Localização não ficou válida após múltiplas tentativas.');
}

// Fechamento seguro da aba (anti-trava)
async function safeClosePage(page) {
  if (!page) return;
  try {
    await page.evaluate(() => {
      try { window.onbeforeunload = null; } catch {}
      try {
        window.addEventListener('beforeunload', (e) => {
          e.stopImmediatePropagation();
        }, true);
      } catch {}
    }).catch(()=>{});
  } catch {}
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.stopLoading').catch(()=>{});
  } catch {}
  try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 1200 }).catch(()=>{}); } catch {}
  try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
}

// —————— NOVA FUNÇÃO: Abertura robusta da página de criação com retries ——————
async function openCreateItemPageRobust(browser, nome, coords, baseAttId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let p = null;
    try {
      p = await browser.newPage();
      // SUPRESSOR para o killer de about:blank durante patchPage+goto (20s de guarda)
      const guard = (browser._suppressBlankKillUntil = browser._suppressBlankKillUntil || {});
      guard[nome] = Date.now() + 20000;

      await ensureXPathPolyfill(p);
      await patchPage(nome, p, coords);
      stepLog.appendJSONL(nome, 'robe', { attempt: baseAttId, step: 'goto_create', try: attempt });
      await p.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 });
      return p; // sucesso
    } catch (e) {
      lastError = e;
      const msg = (e && e.message) ? e.message : String(e);
      try { await safeClosePage(p); } catch {}
      if (/detached|Target closed|Execution context was destroyed|Protocol error.*Target closed/i.test(msg)) {
        await new Promise(r => setTimeout(r, 300));
        continue; // retry
      }
      throw e;
    }
  }
  stepLog.appendJSONL(nome, 'robe', { attempt: baseAttId, step: 'goto_create_fail', err: (lastError && lastError.message) || String(lastError) });
  throw new Error('nav_create_timeout');
}

// —————— NOVO: Rotina publicação e fechamento 5s como solicitado ——————
// *** SUBSTITUÍDA PELO NOVO FLUXO ABAIXO ***

// ——— NOVO: Pós-publicação ultra-rápido com detecção de “painel/listagem” ———
async function isSellerListOrDashboard(page) {
  try {
    const url = page.url() || '';
    if (/\/marketplace\/you\b|\/marketplace\/\?ref=marketplace_page_selling_chip/.test(url)) return true;
    const hit = await page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return (el && (el.innerText || el.textContent || '') || '').trim().toLowerCase();
      };
      const h1 = txt('h1');
      const h2 = txt('h2');
      const nav = document.querySelector('a[href*="/marketplace/you/selling/"], a[href*="/marketplace/you/dashboard/"]');
      const seller = /venda|seus classificados|painel do vendedor|seller|dashboard/i;
      return seller.test(h1) || seller.test(h2) || !!nav;
    });
    return !!hit;
  } catch { return false; }
}

// Espera curta pós-publicação com heurística “painel/listagem” + popup
async function waitAndCloseAfterPublishSmart(page, { hardMaxMs = 3000, popupExtraMs = 2500, sawPopupRef = { value: false } } = {}) {
  const start = Date.now();
  while ((Date.now() - start) < hardMaxMs) {
    if (sawPopupRef.value) {
      await sleep(popupExtraMs);
      break;
    }
    if (await isSellerListOrDashboard(page)) break;
    await sleep(100);
  }
  await safeClosePage(page);
}

// --------- SUBSTITUÍDA PELO NOVO FLUXO SINGLE SUBMIT BOOT MILITAR ---------
async function publicarEFechar5s(page) {
  let submitted = false;
  let steps = 0;

  // 1) Avança etapas até aparecer “Publicar”
  for (let i = 0; i < 12; i++) {
    steps++;
    const btnPub = await findEnabledButton(page, 'Publicar', 500);
    if (btnPub) {
      try {
        await btnPub.click();
        submitted = true;
      } catch {}
      break; // NUNCA clica "Publicar" mais de uma vez
    }
    const btnAv = await findEnabledButton(page, 'Avançar', 500);
    if (btnAv) {
      try { await btnAv.click(); } catch {}
      await sleep(400);
      continue;
    }
    // Nem Avançar nem Publicar => pequena espera e revalida mais uma vez
    await sleep(250);
  }

  if (!submitted) return false;

  // 2) Espera o “sumiço”/desabilitação de "Publicar" (até 15s)
  const hidden = await page.waitForFunction(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const btnSpan = spans.find(s => (s.innerText || '').trim() === 'Publicar');
    if (!btnSpan) return true;
    const host = btnSpan.closest('div[role="button"],button');
    if (!host) return true;
    const disabled = host.getAttribute('aria-disabled') === 'true' || host.getAttribute('tabindex') === '-1';
    const style = window.getComputedStyle(host);
    const visible = style && style.visibility !== 'hidden' && style.display !== 'none';
    return (!visible) || disabled;
  }, { timeout: 15000 }).catch(() => false);

  // 3) Não fechar a página aqui; confirmação será feita por heurísticas externas
  return true;
}

// --------------------------------------------------
// GUARD: Armezenamento RAM/Status/Antiflood Backoff/FROZEN/Logging guard rails
// (Removido: robeMeta e população a partir do manifest; controle de estado local não é mais utilizado)

// --------------------------------------------------

async function waitPublishedEvidence(page, titulo, {maxMs=15000}={}) {
  const t0 = Date.now();
  while (Date.now()-t0 < maxMs) {
    try {
      const ok = await page.evaluate((t) => {
        const norm = s => (s||'').toLowerCase();
        const txts = Array.from(document.querySelectorAll('div, span, h1, h2')).slice(0, 400).map(el => norm(el.innerText || el.textContent || ''));
        if (txts.some(s => s.includes('sua publicação') && s.includes('foi concluída'))) return true;
        if (txts.some(s => s.includes('anúncio') && s.includes('publicado'))) return true;
        return false;
      }, titulo);
      if (ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

async function verifyOnSellerByTitle(page, titulo, {timeout=20000}={}) {
  try {
    await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(800);
    // Busca pelo título
    const found = await page.evaluate((t) => {
      const norm = s => (s||'').toLowerCase();
      const want = norm(t).slice(0, 30);
      const cards = Array.from(document.querySelectorAll('a, div')).slice(0, 800);
      return cards.some(el => norm(el.innerText || el.textContent || '').includes(want));
    }, titulo);
    return !!found;
  } catch { return false; }
}

// Constantes de thresholds para publicação (PUBLISH_*)
// Ajustáveis via .env
const PUBLISH_OVERLAY_WATCH_MS   = parseInt(process.env.PUBLISH_OVERLAY_WATCH_MS   || '20000', 10); // 20s
const PUBLISH_SUCCESS_ROUTE_MS   = parseInt(process.env.PUBLISH_SUCCESS_ROUTE_MS   || '15000', 10); // 15s
const PUBLISH_TOTAL_TIMEOUT_MS   = parseInt(process.env.PUBLISH_TOTAL_TIMEOUT_MS   || '25000', 10); // 25s
const PUBLISH_DWELL_MS = 8000; // 8 segundos inegociáveis para quarentena anti-falso-positivo

// Helpers novos para rota estável e watcher GraphQL
async function waitForSellerRouteStable(page, { timeoutMs = PUBLISH_SUCCESS_ROUTE_MS, stableMs = 600 } = {}) {
  const start = Date.now();
  let firstTrue = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await page.evaluate(() =>
        /marketplace\/(you\/selling|profile|you\/dashboard)/.test(location.pathname)
      );
      if (ok) {
        if (!firstTrue) firstTrue = Date.now();
        if (Date.now() - firstTrue >= stableMs) return true;
      } else {
        firstTrue = 0;
      }
    } catch {}
    await sleep(150);
  }
  return false;
}

function setupGraphqlPublishWatcher(page) {
  let resolve, settled = false;
  const promise = new Promise(r => resolve = r);
  const onResp = async (res) => {
    try {
      const url = res.url();
      if (!/(api\/graphql|ajax\/bulk)/i.test(url)) return;
      let txt = '';
      try { txt = await res.text(); } catch {}
      if (/create.*marketplace.*listing/i.test(txt) || /commerce.*listing.*create/i.test(txt)) {
        if (!settled) {
          settled = true;
          try { page.off('response', onResp); } catch {}
          resolve(true);
        }
      }
    } catch {}
  };
  page.on('response', onResp);
  return {
    promise,
    cleanup: () => { try { page.off('response', onResp); } catch {} }
  };
}

// SUBSTITUI publicarEFechar5s! NÃO remova publish/verify/etc, só troque a chamada!
async function publishAndWatch(page, titulo, nome, { watchOverlayMs = PUBLISH_OVERLAY_WATCH_MS } = {}) {
  if (typeof page.isClosed === 'function' && page.isClosed()) {
    return { ok: false, reason: 'page_closed_early' };
  }
  // 1) Arme sentinela de overlay ANTES de clicar em Publicar
  try {
    if (!page.isClosed || !page.isClosed()) {
      await attachLimitOverlaySentinel(page);
    } else {
      return { ok: false, reason: 'page_closed_early' };
    }
  } catch (e) {
    return { ok: false, reason: 'page_session_closed' };
  }

  // 2) Watcher de GraphQL só como sinal — nunca valida sucesso antes do dwell
  const gql = setupGraphqlPublishWatcher(page);

  // 2. TROQUE O BLOCO CRÍTICO DE publishAndWatch PARA USO DO LAÇO EXATO:
  stepLog.appendJSONL(nome, 'robe', { step: 'exact_btn_flow_start' });
  const flowRes = await clickFlowExactRetry(page, nome, { maxSteps: 24, publishMaxRetries: 3 });
  stepLog.appendJSONL(nome, 'robe', { step: 'exact_btn_flow_end', sequence: flowRes.sequence, publishClicked: flowRes.publishClicked });

  if (!flowRes.sequence.length) {
    await forensicScreenshot(page, nome, 'btn_flow_no_sequence');
    stepLog.appendJSONL(nome, 'robe', { step: 'publish_click_failed', reason: 'no_buttons_clicked' });
    gql.cleanup && gql.cleanup();
    return { ok: false, reason: 'publish_click_failed' };
  }

  // Logging array para rounds de dwell (forense)
  const dwellDebugRounds = [];

  const dwellMs = PUBLISH_DWELL_MS;
  const t0 = Date.now();
  stepLog.appendJSONL('system', 'robe', { step: 'publish_click', at: t0 });

  // 4) Watcher de overlay dentro da dwell window (sentinela + deep + frames)
  const dwellEndsAt = Date.now() + dwellMs;
  let overlayHit = null;
  let roundNum = 0;

  while (Date.now() < dwellEndsAt && !overlayHit) {
    roundNum++;
    try {
      // Deep overlay scan — logs internos do browser.js pegam path/attrs/etc.
      overlayHit = await detectLimitOverlayEverywhere(page, 0);

      // Em cada ciclo, cole snapshot forense do DOM / dialogs / attrs
      const domSnapshot = await page.evaluate(() => {
        try {
          // Array of dialogs/roots in dom
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).map(el => ({
            id: el.id || null,
            class: el.className || null,
            ariaLabel: el.getAttribute('aria-label') || null,
            innerText: el.innerText ? el.innerText.slice(0,300) : null,
            outerHTML: el.outerHTML ? el.outerHTML.slice(0,300) : null,
          }));
          // Partial body snippet
          const bodyTxt = document.body && document.body.innerText ? document.body.innerText.slice(0,300) : '';
          // Also h2/h1
          const heads = Array.from(document.querySelectorAll('h1,h2')).map(h => (h.innerText || '').slice(0,100));
          return {dialogs, bodyTxt, heads};
        } catch (e) { return {dialogs:[], bodyTxt:'', heads:[]}; }
      }).catch(()=>({dialogs:[], bodyTxt:'', heads:[]}));

      // Log forense da rodada — chama só stepLog (não issues!)
      stepLog.appendJSONL(nome, 'robe', {
        step: 'dwell_debug_cycle',
        dwellRound: roundNum,
        overlayFound: overlayHit && overlayHit.blocked,
        overlayWhere: overlayHit && overlayHit.where,
        overlayTexts: overlayHit && overlayHit.joinedTexts,
        domSnapshot
      });

      if (overlayHit && overlayHit.blocked) break;
    } catch (e) {
      stepLog.appendJSONL(nome, 'robe', {step:'dwell_debug_exception', dwellRound: roundNum, err: e && e.message || e});
    }
    // Aguarda próximo ciclo (150ms)
    await sleep(150);
  }

  // Se overlay foi detectado em QUALQUER ponto da dwell, aborta instantaneamente
  if (overlayHit && overlayHit.blocked) {
    stepLog.appendJSONL('system', 'robe', { step: 'publish_fail_overlay_during_dwell', overlayWhere: overlayHit.where || '', ms: (Date.now() - t0) });
    gql.cleanup();
    return { ok: false, reason: 'limit_overlay', overlay: { found: true, where: overlayHit.where || 'everywhere', h2: overlayHit.joinedTexts || '' } };
  }

  // 3. Aguarde até acabar o dwell (se overlay não encontrado)
  if (!overlayHit || !overlayHit.blocked) {
    await sleep(Math.max(0, dwellEndsAt - Date.now()));
  }

  // 5) Paralelamente, observe rota (sinal de “rumo ao painel”), mas sem aceitar sucesso ainda
  const routeHintP = waitForSellerRouteStable(page, { timeoutMs: PUBLISH_SUCCESS_ROUTE_MS })
    .then(ok => !!ok)
    .catch(() => false);

  // 7) Dwell de 8s concluído sem overlay — SÓ AGORA valide sucesso:
  // 7.1) DOM final/rota estável ou seller dashboard visível?
  let routeOk = false;
  try {
    routeOk = (await routeHintP) || (await isSellerListOrDashboard(page));
  } catch { routeOk = false; }

  // 7.2) Caso a rota/DOM não estejam estáveis, valide por evidência textual pós-dwell
  let evidenceOk = false;
  if (!routeOk) {
    evidenceOk = await waitPublishedEvidence(page, titulo, { maxMs: 2500 }).catch(() => false);
  }

  if (routeOk || evidenceOk) {
    stepLog.appendJSONL('system', 'robe', {
      step: 'publish_success_after_dwell',
      trigger: routeOk ? 'route' : 'evidence_post_dwell',
      ms: (Date.now() - t0)
    });
    gql.cleanup();
    return { ok: true, reason: routeOk ? 'published_route' : 'published_evidence_after_dwell' };
  }

  // 8) Nem rota, nem evidência pós-dwell — último check de overlay (curto) e falha/indefinido
  const lateOverlay = await detectLimitOverlayEverywhere(page, 1800);
  if (lateOverlay && lateOverlay.blocked) {
    stepLog.appendJSONL('system', 'robe', { step: 'publish_fail_late_overlay_after_dwell', overlayWhere: lateOverlay.where || '' });
    gql.cleanup();
    return { ok: false, reason: 'limit_overlay', overlay: { found: true, where: lateOverlay.where || 'late', h2: lateOverlay.joinedTexts || '' } };
  }

  // Logging forense em “indeterminate”
  try {
    const snapshot = await page.evaluate(() => (window.top || window).___ROBE_LIMIT_OVERLAY__ || null).catch(()=>null);
    stepLog.appendJSONL(nome || 'system', 'robe', {
      step: 'publish_indeterminate_forensic',
      url: (page.url && page.url()) || '',
      sentinel: snapshot || null,
      ts: Date.now()
    });
    if (issues && typeof issues.append === 'function') {
      await issues.append(nome || 'system', 'mil_action', 'publish_indeterminate');
    }
  } catch {}

  // Adicione logging forense caso publish fique indeterminate (DOM dump + screenshot)
  try {
    const html = await page.content().catch(()=> '');
    stepLog.appendJSONL(nome || 'system', 'robe', {
      step: 'publish_indeterminate_dom_dump',
      url: (page.url && page.url()) || '',
      htmlSnippet: (html || '').slice(0, 50000)
    });
    try { await page.screenshot({ path: path.join(__dirname, '..', 'dados', 'perfis', nome, `publish_indeterminate_${Date.now()}.png`) }).catch(()=>{}); } catch {}
  } catch {}

  gql.cleanup();
  return { ok: false, reason: 'indeterminate' };
}

/**
 * Start Robe — rápido e robusto:
 * - Fast-lane readiness (3.5s) + fallback curto.
 * - Espera curta se restar <5s de cooldown; aborta sem mexer no cooldown se faltar mais.
 * - Cooldown padrão 15–30min após sucesso ou erro; nada no abort por cooldown. NUNCA penalidade/backoff especial.
 * - Pós-publicação: se detectar “painel/listagem” fecha imediatamente; senão fecha em até 3s (sem popup).
 *   Se houver popup, aceita e espera ~2.5s, depois fecha.
 * - Minimização suave apenas desta aba (após anti-detect).
 */
async function startRobe(browser, nome, robePauseMs = 0, workingNames = []) {
  let limitPostingHit = false;
  let page = null;
  let published = false;
  let sawBeforeUnloadDialog = false;
  let abortedByCooldown = false;
  let cooldownApplied = false; // controla se o cooldown já foi aplicado no catch
  let fotoNome = null;
  let fotoPath = null;
  let cidadePerfil = null; // ADEQUAÇÃO: tornar visível no catch
  let localUsada = null;   // ADEQUAÇÃO: tornar visível no catch

  // Cooldown padrão: Sempre após post (sucesso ou erro), aplica 15–30min. NUNCA penalidade/backoff especial.
  const stepLogArr = [];

  const attId = stepLog.attemptId();
  stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'start', robePauseMs });

  logger.info(`[ROBE][startRobe] INÍCIO`, { nome, robePauseMs, horario: new Date().toLocaleString() });

  let perfilPath, manifest;

  try {
    // Leitura do manifest via manifestStore (com retry e tolerância)
    manifest = await manifestStore.read(nome);

    // Limpa pauseReason residual antes do novo ciclo (SÓ se cooldown zerou e NÃO for 'limit_posting')
    try {
      await manifestStore.update(nome, m => {
        m = m || {};
        const now = Date.now();
        const left = Math.max(0, (m.robeCooldownUntil||0) - now);
        if (left <= 0 && m.robePauseReason && m.robePauseReason !== 'limit_posting') {
          delete m.robePauseReason;
        }
        return m;
      });
    } catch {}

    // ATENÇÃO: Não congele o perfil por “manifesto ausente” transitório.
    if (!manifest) {
      try { await logIssue(nome, 'robe_error', 'manifest ausente; retorno ao worker (sem freeze local)'); } catch {}
      return { ok: false, error: 'no_manifest' };
    }
    if (!manifest.cookies || !manifest.fp) {
      try { await logIssue(nome, 'robe_error', 'manifest incompleto (cookies/fp); retorno ao worker (sem freeze local)'); } catch {}
      return { ok: false, error: 'incomplete_manifest' };
    }

    // Cooldown: espera curto se faltar pouco; aborta sem mexer no cooldown se faltar muito
    const now = Date.now();
    const leftMs = (manifest.robeCooldownUntil || 0) - now;
    if (leftMs > 0) {
      if (leftMs <= 5000) {
        await sleep(leftMs + 300);
      } else {
        const ate = new Date(manifest.robeCooldownUntil).toLocaleString();
        stepLogArr.push(`[${nome}] Cooldown ainda ativo por ${Math.ceil(leftMs/1000)}s (até ${ate}). Abortando sem atualizar pause.`);
        abortedByCooldown = true;
        logger.warn(`[ROBE] Cooldown ativo; abortando`, { nome, leftMs, until: ate });
        // NÃO criar mensagens para “abortedByCooldown”
        return { ok: false, error: `cooldown_until_${ate}`, log: stepLogArr };
      }
    }

    // Nova aba + patchPage (sem minimizar/off-screen)
    const coords = utils.getCoords(manifest.cidade || '');
    page = await openCreateItemPageRobust(browser, nome, coords, attId);
    stepLogArr.push(`[${nome}] Nova aba criada para Robe`);

    // PASSO 1 — Detector ultra-específico antes de qualquer attach/fastDetect/overlay:
    // GUARDA ULTRA-RÁPIDO: Detecta <span>Limite atingido</span> e ABORTA na hora
    // Aguarda DOM básico sem fragilidade, com fallback
    const waitBody = async () => {
      const ok = await page.waitForFunction(() => !!(document && document.body), { timeout: 15000 }).catch(()=>false);
      if (ok) return true;
      // Se a página fechou, classifique explicitamente
      if (typeof page.isClosed === 'function' && page.isClosed()) {
        throw new Error('page_closed_before_body');
      }
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 }); } catch {}
      return await page.waitForFunction(() => !!(document && document.body), { timeout: 5000 }).catch(()=>false) || false;
    };
    const hasBody = await waitBody();
    if (!hasBody) throw new Error('create_body_not_available');

    const bloqueioLimite = await page.evaluate(() => {
      function normalize(str) {
        return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
      }
      return Array.from(document.querySelectorAll('span')).some(span =>
        normalize(span.innerText || span.textContent) === 'limite atingido' &&
        window.getComputedStyle(span).visibility !== 'hidden' &&
        window.getComputedStyle(span).display !== 'none'
      );
    });
    if (bloqueioLimite) {
      logger.warn('[ROBE] Limite atingido detectado — pausando 24h', { nome, attId });
      await applyLimitPostingAndAbort({ page, nome, attId, where: 'span_limite_atingido' });
      return;
    }

    await attachLimitOverlaySentinel(page).catch(() => {}); // Sentinela leve armada

    /* --- PATCH INICIO (DESATIVADO PELO NOVO DETECTOR ULTRA-ESPECÍFICO) ---
    // Checagem precoce de bloqueio de limite de postagem (fast-probe leve; sem penalizar hot path)
    const earlyPreNavProbe = await fastDetectPostingLimit(page, { timeoutMs: 40 });
    if (earlyPreNavProbe && earlyPreNavProbe.found) {
      logger.warn('[ROBE] Limite de postagem DETECTADO (pre-nav) — abortando Robe e aplicando pausa 24h', { nome, attId });
      await applyLimitPostingAndAbort({ page, nome, attId, where: 'early_detect_pre_nav_fast_probe', overlaySnapshot: earlyPreNavProbe });
      return; // Saída antecipada, não tenta publicar nem executar etapas seguintes!
    }
    --- PATCH FIM --- */

    // Captura possíveis diálogos
    page.on('dialog', async dlg => {
      try {
        const t = dlg.type && dlg.type();
        const m = (dlg.message && dlg.message()) || '';
        if (t === 'beforeunload' || /sair|deixar|leave this page|continuar/i.test(m)) {
          sawBeforeUnloadDialog = true;
          await dlg.accept().catch(()=>{});
        } else {
          await dlg.dismiss().catch(()=>{});
        }
      } catch {}
    });

    // Interceptação de recursos — NUNCA bloquear assets nem usar setRequestInterception
    // Marketplace create/posting: NÃO bloquear NENHUM asset. Mantém patchPage limpo.

    // Fast-lane readiness (3.5s). Se não ficar pronto, fallback com seletor (8s).
    const readyFast = await waitForCreateItemReady(page, { timeout: 3500 });
    if (!readyFast) {
      await page.waitForSelector('input[type="file"][accept*="image"], input[type="file"]', {
        timeout: 8000
      }).catch(() => {});
    }
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'create_ready_fastlane', ok: readyFast });

    // Micro settle (2 frames + 100–220 ms); substituído por sleep apenas (alteração)
    await sleep(jitter(100, 220));
    stepLogArr.push(`[${nome}] Tela de criar item pronta (fast-lane)`);

    // PASSO 2 — Segunda checagem (racing severo) logo após readiness:
    const bloqueioLimite2 = await page.evaluate(() => {
      function normalize(str) {
        return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
      }
      return Array.from(document.querySelectorAll('span')).some(span =>
        normalize(span.innerText || span.textContent) === 'limite atingido' &&
        window.getComputedStyle(span).visibility !== 'hidden' &&
        window.getComputedStyle(span).display !== 'none'
      );
    });
    if (bloqueioLimite2) {
      logger.warn('[ROBE] Limite atingido detectado (ready) — pausando 24h', { nome, attId });
      await applyLimitPostingAndAbort({ page, nome, attId, where: 'span_limite_atingido_ready' });
      return;
    }

    /* FAST-PROBE após readiness (DESATIVADO PELO NOVO DETECTOR)
    const readyProbe = await fastDetectPostingLimit(page, { timeoutMs: 1000 });
    if (readyProbe && readyProbe.found) {
      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'limit_detect_fast_ready', where: 'after_ready', h2: String(readyProbe.h2||'').slice(0,200) });
      await applyLimitPostingAndAbort({ page, nome, attId, where: 'after_ready_fast_probe', overlaySnapshot: readyProbe });
      return;
    }
    */

    // Watcher background (opcional) — sem await — protege contra overlays AJAX/racing durante o preenchimento
    (async () => {
      const late = await waitSentinelLimitOverlay(page, 45000);
      if (late && late.found) {
        try {
          await applyLimitPostingAndAbort({ page, nome, attId, where: 'background_watch', overlaySnapshot: late });
        } catch {}
      }
    })().catch(()=>{});

    // FOTO — via fotos.js
    const pick = await fotos.pickPhotoForAccount(nome, workingNames);
    if (!pick.ok) {
      const reason = pick.error || 'no-photo-available';
      throw new Error(`Sem foto disponível para esta conta (${reason}).`);
    }
    fotoPath = pick.absPath;
    fotoNome = pick.file;

    // Upload - procurar no documento e em frames
    let inputFoto = await page.$('input[type="file"][accept*="image"], input[type="file"]');
    if (!inputFoto) {
      for (const fr of page.frames()) {
        try {
          inputFoto = await fr.$('input[type="file"][accept*="image"], input[type="file"]');
          if (inputFoto) break;
        } catch {}
      }
    }
    if (!inputFoto) {
      // Antes de falhar, última checagem de bloqueio
      const late = await detectLimitOverlayEverywhere(page, 1500).catch(()=>null);
      if (late && late.blocked) {
        await applyLimitPostingAndAbort({ page, nome, attId, where: 'no_file_input_overlay', overlaySnapshot: late });
        return; // aborta por limit_posting como deve
      }
      throw new Error('Campo para upload de foto não localizado (frames varridos).');
    }
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'upload_start', file: fotoNome });
    await inputFoto.uploadFile(fotoPath);
    await sleep(jitter(250, 450));

    // TÍTULO
    const titulos = readJsonSafe(path.join(__dirname, '..', 'dados', 'titulos.json'), []);
    const titulo = titulos.length ? titulos[Math.floor(Math.random()*titulos.length)] : 'Título padrão';
    await preencherTitulo(page, titulo);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'title_ok', value: titulo });
    await sleep(jitter(120, 220));

    // PREÇO
    await preencherPreco(page);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'price_ok', value: '0' });

    // CATEGORIA
    await selecionarCategoriaMoveis(page);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'category_ok', value: 'Móveis' });

    // CONDIÇÃO
    await selecionarCondicaoNovo(page);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'condition_ok', value: 'Novo' });

    // LOCALIZAÇÃO
    cidadePerfil = manifest.cidade || manifest.localizacao || manifest['localização'] || 'São Paulo';
    localUsada = await preencherLocalizacao(page, cidadePerfil);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'location_ok', value: localUsada });

    // —————— ALTERAÇÃO APLICADA: Rotina publicarEFechar5s no lugar do pós-publicação anterior ——————

    // SUBSTITUIÇÃO MILITAR: PUBLICAÇÃO × OVERLAY-BLOCK (RACE)
    published = false; let pubRes;
    for (let i = 0; i < 2 && !published; i++) {
      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'publish_try_race', try: i+1 });
      pubRes = await publishAndWatch(page, titulo, nome, { watchOverlayMs: 12000 });
      if (pubRes && pubRes.reason === 'limit_overlay') {
        await applyLimitPostingAndAbort({ page, nome, attId, where: 'publish_race', overlaySnapshot: pubRes.overlay });
      }

      // Reforço: se a razão foi apenas textual, confirme na listagem
      if (pubRes && pubRes.ok && pubRes.reason === 'published_evidence') {
        try {
          const confirm = await verifyOnSellerByTitle(page, titulo, { timeout: 8000 });
          if (!confirm) throw new Error('post_evidence_confirm_failed');
        } catch {
          throw new Error('publish_not_confirmed_after_evidence');
        }
      }

      // ENCERRAMENTO IMEDIATO: se ok (published OU seller dashboard), feche a aba e siga sem sleeps
      if (pubRes && pubRes.ok) {
        published = true;
        try { await safeClosePage(page); } catch {}
        page = null;
        break;
      }
      // Inconclusivo: aborde evidências de publicado, fallback SELLING só depois da janela!
      const ev1 = await waitPublishedEvidence(page, titulo, { maxMs: 8000 });
      if (ev1) { published = true; break; }
      const ev2 = await verifyOnSellerByTitle(page, titulo, { timeout: 15000 });
      if (ev2) { published = true; break; }
      const late2Probe = await fastDetectPostingLimit(page, { timeoutMs: 1200 });
      if (late2Probe && late2Probe.found) {
        await applyLimitPostingAndAbort({ page, nome, attId, where: 'late_fallback_fast_probe', overlaySnapshot: late2Probe });
      }
      await sleep(1200);
    }
    if (!published) {
      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'publish_fail_final' });
      logger.warn('[ROBE] Publicação não confirmada', { nome, titulo });
      throw new Error('publish_not_confirmed');
    }

    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'publish_ok' });

    // Confirmar localização usada (após publicar — mantém)
    try { await locais.confirmUsed(cidadePerfil, localUsada); } catch {}

    // Aba já foi fechada pela publicarEFechar5s; solta a referência
    try { await safeClosePage(page); } catch {}
    page = null;

    // COMMIT no índice de fotos — somente após confirmação de publicação
    if (published) {
      try {
        if (fotoNome) {
          const allWorkingProfiles = Array.isArray(workingNames) ? workingNames.slice() : [];
          await fotos.markPostedAndMaybeDelete(nome, fotoNome, allWorkingProfiles);
        }
      } catch (e) {
        stepLogArr.push(`[${nome}] markPostedAndMaybeDelete no catch/erro: ${e && e.message || e}`);
      }
    }

    // IMPORTANTE: Grava ultimaPostagemRobe via manifestStore
    await manifestStore.update(nome, m => {
      m.ultimaPostagemRobe = Date.now();
      return m;
    });

    // LOG: evento de sucesso (uma mensagem por account/turno já é suficiente)
    try { await logIssue(nome, 'robe_success', 'Publicação concluída com sucesso.'); } catch {}

  // ATENÇÃO: MARCAR FOTO COMO USADA (SEM REUSAR JAMAIS NA MESMA CONTA), MESMO SE ERRO/TIMEOUT/BUG.
  // GARANTE FAIL-CLOSED: NUNCA DUPLICA PARA A MESMA CONTA!
  } catch (e) {
    logger.error('Erro em fluxo Robe', { nome }, e);
    if (e && e.LIMIT_POSTING === true) {
      limitPostingHit = true;
      // Nada mais além de já ter pausado/logado/fechado
      return { ok: false, error: LIMIT_POSTING_REASON, limitPosting: true };
    }

    const errMsg = (e && e.message) ? e.message : String(e);
    stepLogArr.push(`[${nome}] ERRO: ${errMsg}`);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'error', err: (e && e.message) || String(e) });

    // Tipo de issue (no-photo vs erro geral)
    const isNoPhoto = /sem foto dispon[ií]vel/i.test(errMsg);
    const issueType = isNoPhoto ? 'robe_no_photo' : 'robe_error';

    // Registra issue (silencioso)
    try { await logIssue(nome, issueType, errMsg); } catch {}

    // PATCH MILITAR — Se houve limit_posting neste ciclo, retorna imediatamente sem aplicar cooldown curto.
    if (limitPostingHit) return { ok:false, error:LIMIT_POSTING_REASON, limitPosting:true };

    // Cooldown padrão: Sempre após post (sucesso ou erro), aplica 15–30min. NUNCA penalidade/backoff especial.
    try {
      const pause = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;
      await manifestStore.update(nome, m => {
        m.robeCooldownUntil = Date.now() + pause;
        return m;
      });
      cooldownApplied = true;
      try { await logIssue(nome, 'robe_error', `Erro técnico; cooldown padrão ${Math.ceil(pause/60000)}min: ${errMsg}`); } catch {}
    } catch {}

    // P2 ULTRA ROBUSTO: MARCAR COMO USADA MESMO EM FALHA!!!
    try {
      if (fotoNome) {
        const allWorkingProfiles = Array.isArray(workingNames) ? workingNames.slice() : [];
        await fotos.markPostedAndMaybeDelete(nome, fotoNome, allWorkingProfiles);
      }
    } catch (e) {
      stepLogArr.push(`[${nome}] markPostedAndMaybeDelete no catch/erro: ${e && e.message || e}`);
    }

    // ADEQUAÇÃO: "tentou ⇒ consumiu" para localização mesmo em erro
    try {
      if (localUsada) {
        await locais.confirmUsed(cidadePerfil, localUsada);
      }
    } catch {}

    return { ok: false, error: errMsg, log: stepLogArr };

  } finally {
    // ABORTO ABSOLUTO: Não executa nada pós-fluxo ao detectar limit_posting
    if (limitPostingHit) {
      try { if (page) await safeClosePage(page); } catch {}
      return { ok: false, error: LIMIT_POSTING_REASON, limitPosting: true };
    }

    // Cooldown padrão: Sempre após post (sucesso ou erro), aplica 15–30min. NUNCA penalidade/backoff especial.
    // Exceção: abortedByCooldown => não alterar (cooldown já estava ativo).
    try {
      if (!abortedByCooldown && !cooldownApplied && !limitPostingHit) {
        const pause = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;
        await manifestStore.update(nome, m => {
          m.robeCooldownUntil = Date.now() + pause;
          return m;
        });
      }
    } catch (err) {
      stepLogArr.push(`[${nome}] ERRO ao atualizar cooldown: ${err && err.message || err}`);
    }

    // OPCIONAL RECOMENDADO: logging do beforeunload dialog
    try { 
      if (sawBeforeUnloadDialog) 
        await logIssue(nome, 'robe_error', 'beforeunload dialog detectado; fechamento forçado'); 
    } catch {}

    if (page) {
      try { await safeClosePage(page); logger.info(`[ROBE] Aba fechada no finalmente`, { nome }); } catch {}
    }

    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'end', success: !!published });
    logger.info(`[ROBE][startRobe] FIM: ${published ? 'success' : 'fail'}`, { nome, published, logs: stepLogArr });
  }

  return { ok: published, log: stepLogArr };
}

// --------------------------------------------------
// Filtragem de fila/fila global militar
function robeQueueFilter(nome) {
  // Sem estado local; worker decide sobre frozen/controle de fila
  return true;
}

// --------------------------------------------------

module.exports = {
  startRobe,
  robeQueueFilter
};