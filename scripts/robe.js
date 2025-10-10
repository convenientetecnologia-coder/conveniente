// scripts/robe.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { patchPage/*, ensureMinimizedWindowForPage*/ } = require('./browser.js');
const utils = require('./utils.js');
const fotos = require('./fotos.js');       // autoridade central de fotos
const locais = require('./locais.js');     // controlador de rotação de localizações
const manifestStore = require('./manifestStore.js');
const stepLog = require('./stepLog.js');

// Log de issues (robusto; falha silenciosa se não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

// Sentinela para overlays/modais tardios do Facebook (Marketplace Create)
// Injeta MutationObserver e variáveis globais para sinalizar o popup
async function attachLimitOverlaySentinel(page) {
  try {
    await page.exposeFunction('__robeFlagLimitOverlay', (payload) => {
      try {
        window.__ROBE_LIMIT_OVERLAY = Object.assign(window.__ROBE_LIMIT_OVERLAY || {}, payload || {});
      } catch {}
    });
  } catch {}

  await page.evaluateOnNewDocument(() => {
    try {
      window.__ROBE_LIMIT_OVERLAY = { found: false, h2: '', body: '', ts: 0 };
      const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const testTexts = (root) => {
        try {
          const texts = Array.from(root.querySelectorAll('h1,h2,span,div,p'))
            .slice(0, 3000).map(el => norm(el.innerText || el.textContent || '')).filter(Boolean);
          const h2 = texts.find(t =>
            /voce\s+nao\s+pode\s+criar\s+(classificados|anuncios|listagens?|itens?)\s+(no\s+momento|agora)/.test(t) ||
            /you\s+can(?:'|’)?t\s+post\s+right\s+now/.test(t) ||
            /you(?:'|’)?re\s+temporar(?:ily)?\s+blocked\s+from\s+posting/.test(t)
          );
          const bodyHit =
            texts.some(t => /ha\s+um\s+limite\s+temporar/.test(t) && /(vender|marketplace|itens?)/.test(t)) ||
            texts.some(t => /(there('|’)?s|there\s+is)\s+a\s+temporar(?:y)?\s+limit/.test(t));
          const hasDialog = !!document.querySelector('[role="dialog"],[role="alertdialog"],div[aria-modal="true"],div[class*="backdrop"],div[class*="overlay"]');
          if ((h2 || bodyHit) && hasDialog) {
            const h2Text = (() => {
              const el = document.querySelector('h2,h1');
              return el ? (el.innerText || el.textContent || '') : '';
            })();
            const body = texts.slice(0,50).join(' | ').slice(0, 400);
            window.__ROBE_LIMIT_OVERLAY.found = true;
            window.__ROBE_LIMIT_OVERLAY.h2 = h2Text;
            window.__ROBE_LIMIT_OVERLAY.body = body;
            window.__ROBE_LIMIT_OVERLAY.ts = Date.now();
          }
        } catch {}
      };
      document.addEventListener('DOMContentLoaded', () => { try { testTexts(document); } catch {} });
      const mo = new MutationObserver(muts => {
        try { for (const m of muts) for (const n of m.addedNodes || []) if (n && n.nodeType === 1) testTexts(n); } catch {}
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      window.__ROBE_LIMIT_OBS = mo;
    } catch {}
  });
}

async function waitSentinelLimitOverlay(page, timeoutMs = 10000) {
  try {
    const ok = await page.waitForFunction(() => {
      return !!(window.__ROBE_LIMIT_OVERLAY && window.__ROBE_LIMIT_OVERLAY.found === true);
    }, { timeout: timeoutMs });
    if (ok) {
      return await page.evaluate(() => window.__ROBE_LIMIT_OVERLAY || { found:false });
    }
  } catch {}
  return null;
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
  // Snapshot do manifest antes
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
async function findEnabledButton(page, label, timeout = 3000) {
  const start = Date.now();
  const xp = `//span[normalize-space()="${label}"]`;
  while (Date.now() - start < timeout) {
    const spans = await page.$x(xp);
    for (const sp of spans) {
      const btn = await page.evaluateHandle(el => {
        let p = el;
        for (let i = 0; i < 5 && p; i++) {
          if (p.getAttribute && (p.getAttribute('role') === 'button' || p.tagName === 'BUTTON')) return p;
          p = p.parentElement;
        }
        return el;
      }, sp);
      const enabled = await page.evaluate(el => {
        const st = window.getComputedStyle(el);
        const ariaDisabled = el.getAttribute('aria-disabled');
        const tabIndex = el.getAttribute('tabindex');
        const visible = st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
        const disabledAttr = (ariaDisabled === 'true') || (tabIndex === '-1');
        const disabledProp = (el.disabled === true);
        return visible && !disabledAttr && !disabledProp;
      }, btn);
      if (enabled) return btn;
    }
    await sleep(150);
  }
  return null;
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

// SUBSTITUI publicarEFechar5s! NÃO remova publish/verify/etc, só troque a chamada!
async function publishAndWatch(page, titulo, { watchOverlayMs = 12000 } = {}) {
  await attachLimitOverlaySentinel(page); // Arme a sentinela ANTES do clique!
  // Clique, como em publicarEFechar5s, mas NÃO feche/navegue!
  let clicked = false;
  for (let i = 0; i < 12; i++) {
    const btnPub = await findEnabledButton(page, 'Publicar', 600);
    if (btnPub) { try { await btnPub.click({ delay: 60 }); } catch {} clicked = true; break; }
    const btnAv = await findEnabledButton(page, 'Avançar', 600);
    if (btnAv) { try { await btnAv.click({ delay: 60 }); } catch {} await sleep(350); continue; }
    await sleep(220);
  }
  if (!clicked) return { ok: false, reason: 'no_publish_button' };
  // RACE OVERLAY vs PUB
  const overlayP = waitSentinelLimitOverlay(page, watchOverlayMs).then(v => ({ overlay: v })).catch(() => ({ overlay: null }));
  const evidenceP = waitPublishedEvidence(page, titulo, { maxMs: Math.max(8000, Math.floor(watchOverlayMs * 0.8)) }).then(ok => ({ published: !!ok })).catch(() => ({ published: false }));
  const first = await Promise.race([overlayP, evidenceP]);
  if (first.overlay && first.overlay.found) { return { ok: false, reason: 'limit_overlay', overlay: first.overlay }; }
  if (first.published) { return { ok: true, reason: 'published' }; }
  // Late fallback
  const late = await waitSentinelLimitOverlay(page, 2500);
  if (late && late.found) { return { ok: false, reason: 'limit_overlay', overlay: late }; }
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

  console.log(`[ROBE][startRobe] INÍCIO para ${nome}, pauseMS=${robePauseMs}, horário=${new Date().toLocaleString()}`);

  let perfilPath, manifest;

  try {
    // Leitura do manifest via manifestStore (com lock)
    manifest = await manifestStore.read(nome);

    // Limpa pauseReason residual antes do novo ciclo
    try {
      await manifestStore.update(nome, m => {
        m = m || {};
        if (m.robePauseReason) delete m.robePauseReason;
        return m;
      });
    } catch {}

    // NOVO: Não congelar localmente — apenas detectar, logar e retornar para o worker decidir
    if (!manifest) {
      try { await logIssue(nome, 'robe_error', 'manifest ausente; flow deve congelar via worker'); } catch {}
      return { ok: false, error: 'no_manifest' };
    }
    if (!manifest.cookies || !manifest.fp) {
      try { await logIssue(nome, 'robe_error', 'manifest incompleto (cookies/fp); flow deve congelar via worker'); } catch {}
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
        // NÃO criar mensagens para “abortedByCooldown”
        return { ok: false, error: `cooldown_until_${ate}`, log: stepLogArr };
      }
    }

    // Nova aba + patchPage (sem minimizar/off-screen)
    page = await browser.newPage();
    await ensureXPathPolyfill(page);
    const coords = utils.getCoords(manifest.cidade || '');
    // ALTERAÇÃO AQUI: patchPage recebe nome (string), não manifest
    await patchPage(nome, page, coords);
    stepLogArr.push(`[${nome}] Nova aba criada para Robe`);

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

    // Navegação rápida + readiness rápido
    {
      const url = 'https://www.facebook.com/marketplace/create/item';
      let okNav = false, navErr = null;
      for (let i=0;i<2 && !okNav;i++) {
        try {
          stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'goto_create', try: i+1 });
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          // Detecta “Limite atingido” imediatamente após navegar
          if (await detectLimitOverlay(page, { timeoutMs: 15000, intervalMs: 350 })) {
            await applyLimitPostingAndAbort({ page, nome, attId, where: 'goto_create' });
          }
          okNav = true;
        } catch (e) {
          navErr = e && e.message || String(e);
          await sleep(800);
        }
      }
      if (!okNav) {
        stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'goto_create_fail', err: navErr });
        throw new Error('nav_create_timeout');
      }
    }

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

    // FOTO — via fotos.js
    const pick = await fotos.pickPhotoForAccount(nome, workingNames);
    if (!pick.ok) {
      const reason = pick.error || 'no-photo-available';
      throw new Error(`Sem foto disponível para esta conta (${reason}).`);
    }
    fotoPath = pick.absPath;
    fotoNome = pick.file;

    // Upload
    let inputFoto = await page.$('input[type="file"][accept*="image"]');
    if (!inputFoto) inputFoto = await page.$('input[type="file"]');
    if (!inputFoto) throw new Error('Campo para upload de foto não localizado.');
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
      pubRes = await publishAndWatch(page, titulo, { watchOverlayMs: 12000 });
      if (pubRes && pubRes.reason === 'limit_overlay') {
        await applyLimitPostingAndAbort({ page, nome, attId, where: 'publish_race', overlaySnapshot: pubRes.overlay });
      }
      if (pubRes && pubRes.ok && pubRes.reason === 'published') {
        published = true;
        break;
      }
      // Inconclusivo: aborde evidências de publicado, fallback SELLING só depois da janela!
      const ev1 = await waitPublishedEvidence(page, titulo, { maxMs: 8000 });
      if (ev1) { published = true; break; }
      const ev2 = await verifyOnSellerByTitle(page, titulo, { timeout: 15000 });
      if (ev2) { published = true; break; }
      const late2 = await detectLimitOverlay(page, { timeoutMs: 5000, intervalMs: 300 });
      if (late2) {
        await applyLimitPostingAndAbort({ page, nome, attId, where: 'late_fallback' });
      }
      await sleep(1200);
    }
    if (!published) {
      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'publish_fail_final' });
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
      // Descobrir todas as WORKINGNAMES do momento
      const allWorkingProfiles = Array.isArray(workingNames) ? workingNames.slice() : [];
      try {
        await fotos.markPostedAndMaybeDelete(nome, fotoNome, allWorkingProfiles);
      } catch (e) {
        stepLogArr.push(`[${nome}] Falha ao commit foto reservada: ${e && e.message || e}`);
        // Fail-safe: NUNCA tente usar de novo — não faz nada aqui (pois o índice já está locked no próprio fotos.js)
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
      try { await safeClosePage(page); console.log(`[ROBE] ${nome}: aba fechada no finally`); } catch {}
    }

    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'end', success: !!published });
    console.log(`[ROBE][startRobe] FIM: ${published ? 'success' : 'fail'} | logs:`, stepLogArr);
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