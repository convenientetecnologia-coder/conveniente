// scripts/robe.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { newPageDaConta, resolvePatchCoordsForProfile/*, ensureMinimizedWindowForPage*/ } = require('./browser.js');
const { detectLimitOverlayDeep, detectLimitOverlayEverywhere, detectLoginRequired, detectMarketplaceDisabled } = require('./browser.js');
const fotos = require('./fotos.js');       // autoridade central de fotos
const locais = require('./locais.js');     // controlador de rotação de localizações
const manifestStore = require('./manifestStore.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');
const provisionAudit = require('./provisionAudit.js');
const gatewayProxy = require('./gatewayProxy.js');
const connectLane = require('./connectLane.js');
const serverConfig = require('./serverConfig.js');
const { readCtConfig, normalizeCtBaseUrl } = require('./ctConfig.js');
const robePostPublishId = require('./robePostPublishId.js');
const robePostPublishRenew = require('./robePostPublishRenew.js');
const {
  safeClosePage,
  sweepAboutBlankPages,
  clearBlankSuppress,
  armBlankSuppress,
  isChromeProtocolSickError
} = require('./robeTabHygiene.js');

// Log de issues (robusto; falha silenciosa se não existir)
let issues = null;
try { issues = require('./issues.js'); } catch { issues = null; }

const DADOS_DIR = path.join(__dirname, '..', 'dados');
const PERFIS_JSON_PATH = path.join(DADOS_DIR, 'perfis.json');
const HOSTID_PATH = path.join(DADOS_DIR, 'hostid');
const ROBE_V2_QUEUE_PATH = path.join(DADOS_DIR, 'robe_v2_queue.json');
const ROBE_V2_QUEUE_LOCK_PATH = ROBE_V2_QUEUE_PATH + '.lock';
const ROBE_V2_REGEN_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let robeV2RegenPromise = null;

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

function makeRobeLoginRequiredError(det = {}) {
  const reason = String((det && det.reason) || 'login_required');
  const source = String((det && det.domain) || 'facebook');
  const e = new Error(`ROBE_LOGIN_REQUIRED:${reason}`);
  e.ROBE_LOGIN_REQUIRED = true;
  e.loginReason = reason;
  e.loginSource = source;
  return e;
}

function makeRobeMarketplaceDisabledError(det = {}) {
  const reason = String((det && det.reason) || 'cannot_buy_or_sell');
  const snippet = String((det && det.snippet) || '');
  const e = new Error(`ROBE_MARKETPLACE_DISABLED:${reason}`);
  e.ROBE_MARKETPLACE_DISABLED = true;
  e.marketplaceDisabledReason = reason;
  e.marketplaceDisabledSnippet = snippet;
  e.marketplaceDisabledSource = 'robe_create_item';
  return e;
}

function makeRobeProbeFailedError(where = 'robe_action') {
  const e = new Error(`ROBE_PROBE_FAILED:${where}`);
  e.ROBE_PROBE_FAILED = true;
  return e;
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
const ROBE_HUMAN_PAUSE_MIN_MS = Math.max(120, parseInt(process.env.ROBE_HUMAN_PAUSE_MIN_MS || '220', 10) || 220);
const ROBE_HUMAN_PAUSE_JITTER_MS = Math.max(0, parseInt(process.env.ROBE_HUMAN_PAUSE_JITTER_MS || '180', 10) || 180);
const ROBE_CLICK_DELAY_MIN_MS = Math.max(60, parseInt(process.env.ROBE_CLICK_DELAY_MIN_MS || '110', 10) || 110);
const ROBE_CLICK_DELAY_MAX_MS = Math.max(ROBE_CLICK_DELAY_MIN_MS, parseInt(process.env.ROBE_CLICK_DELAY_MAX_MS || '220', 10) || 220);
const ROBE_TYPE_DELAY_MIN_MS = Math.max(35, parseInt(process.env.ROBE_TYPE_DELAY_MIN_MS || '45', 10) || 45);
const ROBE_TYPE_DELAY_MAX_MS = Math.max(ROBE_TYPE_DELAY_MIN_MS, parseInt(process.env.ROBE_TYPE_DELAY_MAX_MS || '95', 10) || 95);
function toHumanPauseMs(ms) {
  const raw = Math.max(0, Number(ms) || 0);
  if (raw === 0) return 0;
  if (raw >= ROBE_HUMAN_PAUSE_MIN_MS) return raw;
  return ROBE_HUMAN_PAUSE_MIN_MS + Math.floor(Math.random() * (ROBE_HUMAN_PAUSE_JITTER_MS + 1));
}
const sleep = (ms) => new Promise(r => setTimeout(r, toHumanPauseMs(ms)));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Humanização da criação do classificado:
// distribui budget (30..90s por padrão) em 8 timers ANTES das ações do formulário.
const ROBE_POST_HUMANIZE_ENABLED = String(process.env.ROBE_POST_HUMANIZE_ENABLED || '1').trim() !== '0';
const ROBE_POST_COMPOSE_MIN_MS = Math.max(8_000, parseInt(process.env.ROBE_POST_COMPOSE_MIN_MS || '30000', 10) || 30000);
const ROBE_POST_COMPOSE_MAX_MS = Math.max(ROBE_POST_COMPOSE_MIN_MS, parseInt(process.env.ROBE_POST_COMPOSE_MAX_MS || '90000', 10) || 90000);
const ROBE_POST_PHASE_MIN_MS = Math.max(0, parseInt(process.env.ROBE_POST_PHASE_MIN_MS || '500', 10) || 500);
const ROBE_TITLE_TYPE_DELAY_MIN_MS = Math.max(20, parseInt(process.env.ROBE_TITLE_TYPE_DELAY_MIN_MS || '45', 10) || 45);
const ROBE_TITLE_TYPE_DELAY_MAX_MS = Math.max(ROBE_TITLE_TYPE_DELAY_MIN_MS, parseInt(process.env.ROBE_TITLE_TYPE_DELAY_MAX_MS || '125', 10) || 125);
const ROBE_PRICE_TYPE_DELAY_MIN_MS = Math.max(12, parseInt(process.env.ROBE_PRICE_TYPE_DELAY_MIN_MS || '35', 10) || 35);
const ROBE_PRICE_TYPE_DELAY_MAX_MS = Math.max(ROBE_PRICE_TYPE_DELAY_MIN_MS, parseInt(process.env.ROBE_PRICE_TYPE_DELAY_MAX_MS || '90', 10) || 90);
const ROBE_DESC_TYPE_DELAY_MIN_MS = Math.max(8, parseInt(process.env.ROBE_DESC_TYPE_DELAY_MIN_MS || '24', 10) || 24);
const ROBE_DESC_TYPE_DELAY_MAX_MS = Math.max(ROBE_DESC_TYPE_DELAY_MIN_MS, parseInt(process.env.ROBE_DESC_TYPE_DELAY_MAX_MS || '70', 10) || 70);
const ROBE_LOCATION_TYPE_DELAY_MIN_MS = Math.max(8, parseInt(process.env.ROBE_LOCATION_TYPE_DELAY_MIN_MS || '26', 10) || 26);
const ROBE_LOCATION_TYPE_DELAY_MAX_MS = Math.max(ROBE_LOCATION_TYPE_DELAY_MIN_MS, parseInt(process.env.ROBE_LOCATION_TYPE_DELAY_MAX_MS || '72', 10) || 72);

const ROBE_COMPOSE_PHASES = [
  'before_upload',
  'before_title',
  'before_price',
  'before_category',
  'before_condition',
  'before_description',
  'before_location',
  'before_publish'
];

function createComposeTimingPlan() {
  if (!ROBE_POST_HUMANIZE_ENABLED) return null;
  const phaseCount = ROBE_COMPOSE_PHASES.length;
  const targetMs = jitter(ROBE_POST_COMPOSE_MIN_MS, ROBE_POST_COMPOSE_MAX_MS);
  const minPerPhase = Math.max(0, ROBE_POST_PHASE_MIN_MS);
  const base = minPerPhase * phaseCount;
  const total = Math.max(targetMs, base);
  const remaining = Math.max(0, total - base);
  const weights = ROBE_COMPOSE_PHASES.map(() => Math.max(0.0001, Math.random()));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const slots = {};
  let assigned = 0;

  for (let i = 0; i < ROBE_COMPOSE_PHASES.length; i++) {
    const phase = ROBE_COMPOSE_PHASES[i];
    const fraction = weights[i] / weightSum;
    const extra = Math.floor(remaining * fraction);
    const ms = minPerPhase + extra;
    slots[phase] = ms;
    assigned += ms;
  }

  // Ajuste final para bater total exatamente (distribui sobras de 1ms).
  let leftover = total - assigned;
  let idx = 0;
  while (leftover > 0) {
    const phase = ROBE_COMPOSE_PHASES[idx % ROBE_COMPOSE_PHASES.length];
    slots[phase] += 1;
    leftover -= 1;
    idx += 1;
  }

  return {
    enabled: true,
    totalTargetMs: total,
    slots,
    startedAt: 0
  };
}

function markComposeStart(plan) {
  if (!plan || !plan.enabled) return;
  plan.startedAt = Date.now();
}

async function waitBeforeComposeAction(plan, phase, { nome = '', attId = '' } = {}) {
  if (!plan || !plan.enabled) return;
  const waitMs = Math.max(0, Number((plan.slots && plan.slots[phase]) || 0));
  if (waitMs <= 0) return;
  const elapsedBeforeMs = plan.startedAt ? Math.max(0, Date.now() - plan.startedAt) : null;
  try {
    stepLog.appendJSONL(nome || 'system', 'robe', {
      attempt: attId || undefined,
      step: 'humanize_compose_pre_action_wait',
      phase: String(phase || 'unknown'),
      waitMs,
      elapsedBeforeMs,
      totalTargetMs: Number(plan.totalTargetMs || 0)
    });
  } catch {}
  await sleep(waitMs);
}

// PATCH MILITAR — Constantes de limit_posting
const LIMIT_POSTING_REASON = 'limit_posting';
const LIMIT_POSTING_MS = 24 * 60 * 60 * 1000;
const MARKETPLACE_RATE_LIMIT_ERR = 'marketplace_rate_limit_1675004';

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
    m.robeLimitPostingLastAt = Date.now();
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

function pickRandomItemTitulo() {
  let pack = 'titulos';
  try {
    const cfg = serverConfig.readServerConfigEffective();
    pack = String((cfg && cfg.robe && cfg.robe.itemTitlesPack) || 'titulos');
  } catch {}
  const fallbackPath = path.join(__dirname, '..', 'dados', 'titulos.json');
  let primary = fallbackPath;
  try {
    if (typeof serverConfig.resolveItemTitlesPath === 'function') {
      primary = serverConfig.resolveItemTitlesPath(pack);
    }
  } catch {}
  let titulos = readJsonSafe(primary, []);
  if (!Array.isArray(titulos) || titulos.length === 0) {
    if (primary !== fallbackPath) titulos = readJsonSafe(fallbackPath, []);
  }
  const list = Array.isArray(titulos)
    ? titulos.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  return list.length ? list[Math.floor(Math.random() * list.length)] : 'Título padrão';
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

function cityNormKey(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function readHostIdSafe() {
  try {
    if (!fs.existsSync(HOSTID_PATH)) return '';
    return String(fs.readFileSync(HOSTID_PATH, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function loadTotalProfilesCount() {
  try {
    const arr = readJsonSafe(PERFIS_JSON_PATH, []);
    if (!Array.isArray(arr)) return 0;
    return arr.filter((p) => p && String(p.nome || '').trim()).length;
  } catch {
    return 0;
  }
}

function resolveCtSecretConfig() {
  const cfg = readCtConfig();
  let base = normalizeCtBaseUrl((cfg && cfg.ctBaseUrl) || process.env.CT_BASE_URL || process.env.CT_URL || '');
  // Mesmo fallback do worker: se ctBaseUrl foi limpo (ex.: ngrok bloqueado),
  // ainda resolve a base canônica via notifierEndpoints.
  if (!base) {
    try {
      const { notifierBaseFromEndpoints } = require('./notifierEndpoints');
      base = normalizeCtBaseUrl(String(notifierBaseFromEndpoints() || ''));
    } catch {}
  }
  let secret = String((cfg && cfg.logIngestSecret) || process.env.LOG_INGEST_SECRET || '').trim();
  if (!base) return { ok: false, error: 'ct_config_missing' };
  base = base.replace(/\/+$/, '');
  return { ok: true, base, secret };
}

function defaultRobeV2QueueState() {
  return {
    version: 1,
    updatedAt: 0,
    planGeneratedAt: 0,
    planValidUntil: 0,
    planTargetN: 0,
    queue: [],
    consumedTotal: 0,
    lastBlock: null,
    lastBlockStartAtConsumedTotal: 0,
    lastBlockQueueLen: 0,
    prefetchThreshold: 20,
    regenPending: false,
    regenInFlightId: null,
    lastRegenAt: 0,
    failures: { count: 0, lastAt: 0, backoffUntil: 0 },
    meta: null
  };
}

function normalizeRobeQueueRawItem(x) {
  if (typeof x === 'string') {
    const city = String(x || '').trim();
    return city || null;
  }
  if (x && typeof x === 'object') {
    const city = String(x.city || x.cidade || '').trim();
    if (!city) return null;
    const sizeRaw = String(x.size || x.tamanho || '').trim().toUpperCase();
    const size = (sizeRaw === 'P' || sizeRaw === 'M' || sizeRaw === 'G') ? sizeRaw : null;
    return { city, size };
  }
  return null;
}

function robeQueueItemToSlot(item) {
  const n = normalizeRobeQueueRawItem(item);
  if (!n) return { city: '', size: null };
  if (typeof n === 'string') return { city: n, size: null };
  return { city: String(n.city || '').trim(), size: n.size || null };
}

function formatRobeQueueItemLabel(item) {
  const slot = robeQueueItemToSlot(item);
  if (!slot.city) return '';
  return slot.size ? `${slot.city} [${slot.size}]` : slot.city;
}

function readRobeV2QueueState() {
  const d = defaultRobeV2QueueState();
  const raw = readJsonSafe(ROBE_V2_QUEUE_PATH, d);
  if (!raw || typeof raw !== 'object') return d;
  const q = Array.isArray(raw.queue)
    ? raw.queue.map(normalizeRobeQueueRawItem).filter(Boolean)
    : [];
  const f = (raw.failures && typeof raw.failures === 'object') ? raw.failures : {};
  return {
    ...d,
    ...raw,
    queue: q,
    consumedTotal: Math.max(0, Number(raw.consumedTotal || 0) || 0),
    lastBlock: (raw.lastBlock && typeof raw.lastBlock === 'object') ? raw.lastBlock : null,
    lastBlockStartAtConsumedTotal: Math.max(0, Number(raw.lastBlockStartAtConsumedTotal || 0) || 0),
    lastBlockQueueLen: Math.max(0, Number(raw.lastBlockQueueLen || 0) || 0),
    failures: {
      count: Math.max(0, Number(f.count || 0) || 0),
      lastAt: Math.max(0, Number(f.lastAt || 0) || 0),
      backoffUntil: Math.max(0, Number(f.backoffUntil || 0) || 0)
    }
  };
}

async function acquireRobeV2FileLock({ retries = 140, delayMs = 35, staleMs = 2 * 60 * 1000 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const fd = fs.openSync(ROBE_V2_QUEUE_LOCK_PATH, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8'); } catch {}
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(ROBE_V2_QUEUE_LOCK_PATH); } catch {}
      };
    } catch (e) {
      const code = String(e && e.code || '');
      if (code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(ROBE_V2_QUEUE_LOCK_PATH);
        if ((Date.now() - Number(st.mtimeMs || 0)) > staleMs) {
          try { fs.unlinkSync(ROBE_V2_QUEUE_LOCK_PATH); } catch {}
        }
      } catch {}
      await sleep(delayMs + Math.floor(Math.random() * 20));
    }
  }
  throw new Error('robe_v2_lock_timeout');
}

async function withRobeV2QueueLock(mutator) {
  const release = await acquireRobeV2FileLock();
  try {
    const current = readRobeV2QueueState();
    const next = await mutator(current);
    const finalState = next && typeof next === 'object' ? next : current;
    finalState.updatedAt = Date.now();
    if (!writeJsonAtomic(ROBE_V2_QUEUE_PATH, finalState)) throw new Error('robe_v2_state_persist_failed');
    return finalState;
  } finally {
    try { release(); } catch {}
  }
}

function calcRobeV2PlanTargetN(cfg) {
  const robeCfg = (cfg && cfg.robe) ? cfg.robe : {};
  const cMin = Math.max(1, Number(robeCfg.cooldownMinMinutes || 25) || 25);
  const cMax = Math.max(cMin, Number(robeCfg.cooldownMaxMinutes || 50) || 50);
  const avgCooldownMin = Math.max(1, (cMin + cMax) / 2);
  const totalProfiles = Math.max(0, loadTotalProfilesCount());
  const perAccount = 1440 / avgCooldownMin;
  const targetN = Math.max(1, Math.ceil(perAccount * totalProfiles));
  return { targetN, totalProfiles, avgCooldownMin };
}

function computeRobeV2Counts({ cities, statsByCity, targetN, tuning } = {}) {
  const cityList = Array.isArray(cities) ? cities.map((c) => String(c || '').trim()).filter(Boolean) : [];
  const n = Math.max(1, Number(targetN || 0) || 1);
  if (!cityList.length) return { ok: false, error: 'no_cities' };
  const t = (tuning && typeof tuning === 'object') ? tuning : {};
  const refs = [];
  const pops = [];
  const rows = cityList.map((city) => {
    const rec = statsByCity && statsByCity[city] ? statsByCity[city] : {};
    const pop = Number(rec && rec.habitantes);
    const ins = Number(rec && rec.insightPercent);
    if (Number.isFinite(pop) && pop > 0) pops.push(pop);
    if (Number.isFinite(ins) && ins > 0) refs.push(ins);
    return {
      city,
      habitantes: Number.isFinite(pop) && pop > 0 ? pop : null,
      insightPercent: Number.isFinite(ins) && ins > 0 ? ins : null,
      motoristas: Number(rec && rec.motoristas || 0) || 0,
      chamados3d: Number(rec && rec.chamados3d || 0) || 0
    };
  });
  const sortedRefs = refs.slice(0).sort((a, b) => a - b);
  const sortedPops = pops.slice(0).sort((a, b) => a - b);
  const refInsight = sortedRefs.length ? sortedRefs[Math.floor(sortedRefs.length / 2)] : 1;
  const popFallback = sortedPops.length ? sortedPops[Math.floor(sortedPops.length / 2)] : 1;
  // Ajuste de justiça (enterprise):
  // - insight é mais importante;
  // - habitantes conta, mas com força reduzida (alpha pequeno);
  // - casos de insight nulo/zero NÃO podem premiar cidade sem motoristas.
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const alpha = Number.isFinite(Number(t.alpha)) ? clamp(Number(t.alpha), 0, 0.6) : 0.10;
  const beta = Number.isFinite(Number(t.beta)) ? clamp(Number(t.beta), 0.05, 6.0) : 1.0;
  const minBoost = Number.isFinite(Number(t.minBoost)) ? clamp(Number(t.minBoost), 0.01, 2.0) : 0.35;
  const maxBoost = Number.isFinite(Number(t.maxBoost)) ? clamp(Number(t.maxBoost), 1.0, 20.0) : 3.0;
  const noDriversFactor = Number.isFinite(Number(t.noDriversFactor)) ? clamp(Number(t.noDriversFactor), 0, 1) : 0.06;          // penalidade forte: sem motoristas => quase não recebe slots
  const lowDriversMinFactor = Number.isFinite(Number(t.lowDriversMinFactor)) ? clamp(Number(t.lowDriversMinFactor), 0, 1) : 0.22; // piso para "tem motoristas, mas poucos" (penaliza sem zerar)
  const lowDriversGamma = Number.isFinite(Number(t.lowDriversGamma)) ? clamp(Number(t.lowDriversGamma), 0.05, 6.0) : 0.70;       // quão rápido penaliza cidades com poucos motoristas
  const driverBonusGamma = Number.isFinite(Number(t.driverBonusGamma)) ? clamp(Number(t.driverBonusGamma), 0, 2.0) : 0.25;
  const driverBonusCap = Number.isFinite(Number(t.driverBonusCap)) ? clamp(Number(t.driverBonusCap), 1.0, 3.0) : 1.25;
  const minBoostNorm = Math.min(minBoost, maxBoost);
  const maxBoostNorm = Math.max(minBoost, maxBoost);
  const antiStreakPenalty = Number.isFinite(Number(t.antiStreakPenalty)) ? clamp(Number(t.antiStreakPenalty), 0.01, 1) : 0.35;

  // Referência de motoristas: mediana das cidades com motoristas > 0 (robusto a outliers).
  const driversRef = (() => {
    const arr = rows
      .map(r => Number(r && r.motoristas || 0) || 0)
      .filter(x => Number.isFinite(x) && x > 0)
      .sort((a, b) => a - b);
    if (!arr.length) return 1;
    return Math.max(1, arr[Math.floor(arr.length / 2)] || 1);
  })();
  for (const r of rows) {
    const pop = Number.isFinite(r.habitantes) && r.habitantes > 0 ? r.habitantes : popFallback;
    const insVal = Number(r.insightPercent);
    const hasInsight = Number.isFinite(insVal);
    const motoristas = Number(r.motoristas || 0) || 0;
    const hasDrivers = motoristas > 0;

    const capBoostByDrivers = hasDrivers
      ? Math.min(maxBoostNorm, 1 + Math.log1p(motoristas)) // motoristas baixos não podem "bater o teto 3x" com tanta facilidade
      : 1;

    // Boost por insight:
    // - insight > 0 => inverso normal com clamp
    // - insight == 0 => trata como "muito baixo" (boost=maxBoost) sem dividir por zero
    // - insight nulo => neutro (boost=1) para não "inventar" boost por falta de dado
    let boost = 1;
    if (hasInsight && insVal > 0) {
      const raw = Math.pow(refInsight / insVal, beta);
      boost = Math.max(minBoostNorm, Math.min(capBoostByDrivers, raw));
    } else if (hasInsight && insVal <= 0 && hasDrivers) {
      // Guardrail: insight=0 com 1 único motorista tende a "explodir" alocação (fica boost alto demais).
      // Nesses casos, trate como neutro (boost=1) e deixe habitantes+supply resolverem.
      boost = (motoristas <= 1) ? 1 : capBoostByDrivers;
    }

    // Penalidade por baixo supply (enterprise):
    // - sem motoristas => penalidade forte
    // - com motoristas => só penaliza quando está abaixo do "normal" (driversRef); nunca dá bônus > 1 (evita dobrar o efeito do insight).
    let supplyFactor = 1;
    if (!hasDrivers) {
      supplyFactor = noDriversFactor;
    } else {
      const ratio = motoristas / Math.max(1, driversRef);
      const raw = Math.pow(Math.max(0.0001, ratio), lowDriversGamma);
      supplyFactor = Math.max(lowDriversMinFactor, Math.min(1, raw));
    }

    // Bônus por motoristas (opcional):
    // - só dá bônus quando está acima do "normal" (driversRef)
    // - cap para não esmagar insight/habitantes
    let driverBonus = 1;
    if (hasDrivers && driverBonusGamma > 0 && driverBonusCap > 1) {
      const ratio = motoristas / Math.max(1, driversRef);
      if (ratio > 1) {
        driverBonus = Math.min(driverBonusCap, Math.max(1, Math.pow(ratio, driverBonusGamma)));
      }
    }

    r._weight = Math.max(0.0001, Math.pow(Math.max(1, pop), alpha) * boost * supplyFactor * driverBonus);
  }
  const weightSum = rows.reduce((acc, r) => acc + r._weight, 0);
  if (!(weightSum > 0)) return { ok: false, error: 'weights_invalid' };
  let assigned = 0;
  for (const r of rows) {
    const raw = n * (r._weight / weightSum);
    r._raw = raw;
    r._count = Math.floor(raw);
    r._rest = raw - r._count;
    assigned += r._count;
  }
  let missing = n - assigned;
  rows.sort((a, b) => b._rest - a._rest);
  for (let i = 0; i < rows.length && missing > 0; i++, missing--) rows[i]._count += 1;
  rows.sort((a, b) => String(a.city).localeCompare(String(b.city), 'pt-BR'));
  const countsByCity = {};
  for (const r of rows) countsByCity[r.city] = Math.max(0, Number(r._count || 0) || 0);
  return {
    ok: true,
    countsByCity,
    rows: rows.map((r) => ({
      city: r.city,
      habitantes: r.habitantes,
      insightPercent: r.insightPercent,
      motoristas: r.motoristas,
      chamados3d: r.chamados3d,
      weight: Number(r._weight.toFixed(6)),
      count: r._count
    })),
    params: { alpha, beta, minBoost: minBoostNorm, maxBoost: maxBoostNorm, driverBonusGamma, driverBonusCap, antiStreakPenalty, refInsight, popFallback, noDriversFactor, lowDriversMinFactor, lowDriversGamma, driversRef }
  };
}

function buildRobeV2ShuffledQueue(countsByCity, { antiStreakPenalty = 0.35 } = {}) {
  const rem = {};
  const queue = [];
  let total = 0;
  for (const [city, cnt] of Object.entries(countsByCity || {})) {
    const c = Math.max(0, Number(cnt || 0) || 0);
    if (!c) continue;
    rem[city] = c;
    total += c;
  }
  let prev = '';
  while (total > 0) {
    const candidates = Object.keys(rem).filter((c) => rem[c] > 0);
    if (!candidates.length) break;
    let sum = 0;
    const weighted = candidates.map((city) => {
      const base = rem[city];
      const penalty = (city === prev && candidates.length > 1) ? Math.max(0.01, Math.min(1, Number(antiStreakPenalty) || 0.35)) : 1;
      const w = Math.max(0.0001, base * penalty);
      sum += w;
      return { city, w };
    });
    let pick = Math.random() * sum;
    let chosen = weighted[weighted.length - 1].city;
    for (const row of weighted) {
      pick -= row.w;
      if (pick <= 0) {
        chosen = row.city;
        break;
      }
    }
    queue.push(chosen);
    rem[chosen] -= 1;
    total -= 1;
    prev = chosen;
  }
  return queue;
}

/**
 * Aloca L postagens em P/M/G com pesos efetivos (fixo 40/30/30).
 * Largest remainder; desempate P > M > G.
 * Gabarito: cenários A–G do plano Robe V3 PMG.
 */
function allocatePmgSlots(L, pmg) {
  const target = Math.max(0, Math.floor(Number(L || 0) || 0));
  const p = Math.max(0, Number(pmg && pmg.p || 0) || 0);
  const m = Math.max(0, Number(pmg && pmg.m || 0) || 0);
  const g = Math.max(0, Number(pmg && pmg.g || 0) || 0);
  const fixo = Math.max(0, Number(pmg && pmg.fixo || 0) || 0);
  let wP = p + (fixo * 0.40);
  let wM = m + (fixo * 0.30);
  let wG = g + (fixo * 0.30);
  let W = wP + wM + wG;
  if (!(W > 0)) {
    wP = 0.40;
    wM = 0.30;
    wG = 0.30;
    W = 1;
  }
  if (target <= 0) {
    return {
      ok: true,
      nP: 0, nM: 0, nG: 0,
      weights: { wP, wM, wG, W },
      pmg: { p, m, g, fixo }
    };
  }
  const rawP = target * wP / W;
  const rawM = target * wM / W;
  const rawG = target * wG / W;
  let nP = Math.floor(rawP);
  let nM = Math.floor(rawM);
  let nG = Math.floor(rawG);
  let resto = target - (nP + nM + nG);
  const fracs = [
    { size: 'P', frac: rawP - nP },
    { size: 'M', frac: rawM - nM },
    { size: 'G', frac: rawG - nG }
  ].sort((a, b) => {
    if (b.frac !== a.frac) return b.frac - a.frac;
    const ord = { P: 0, M: 1, G: 2 };
    return ord[a.size] - ord[b.size];
  });
  for (let i = 0; i < resto; i++) {
    const s = fracs[i % fracs.length].size;
    if (s === 'P') nP += 1;
    else if (s === 'M') nM += 1;
    else nG += 1;
  }
  return {
    ok: true,
    nP, nM, nG,
    weights: { wP, wM, wG, W },
    pmg: { p, m, g, fixo }
  };
}

function buildRobeV3ShuffledQueue(slotsByCity, { antiStreakPenalty = 0.35 } = {}) {
  // slotsByCity: { city: { P:n, M:n, G:n } }
  const rem = {};
  let total = 0;
  for (const [city, sizes] of Object.entries(slotsByCity || {})) {
    const p = Math.max(0, Number(sizes && sizes.P || 0) || 0);
    const m = Math.max(0, Number(sizes && sizes.M || 0) || 0);
    const g = Math.max(0, Number(sizes && sizes.G || 0) || 0);
    const cityTotal = p + m + g;
    if (!cityTotal) continue;
    rem[city] = { P: p, M: m, G: g, total: cityTotal };
    total += cityTotal;
  }
  const queue = [];
  let prevCity = '';
  let prevSize = '';
  while (total > 0) {
    const cities = Object.keys(rem).filter((c) => rem[c].total > 0);
    if (!cities.length) break;
    let sumCity = 0;
    const weightedCities = cities.map((city) => {
      const base = rem[city].total;
      const penalty = (city === prevCity && cities.length > 1)
        ? Math.max(0.01, Math.min(1, Number(antiStreakPenalty) || 0.35))
        : 1;
      const w = Math.max(0.0001, base * penalty);
      sumCity += w;
      return { city, w };
    });
    let pickC = Math.random() * sumCity;
    let chosenCity = weightedCities[weightedCities.length - 1].city;
    for (const row of weightedCities) {
      pickC -= row.w;
      if (pickC <= 0) {
        chosenCity = row.city;
        break;
      }
    }
    const bucket = rem[chosenCity];
    const sizeCandidates = ['P', 'M', 'G'].filter((s) => bucket[s] > 0);
    let sumSize = 0;
    const weightedSizes = sizeCandidates.map((size) => {
      const base = bucket[size];
      const penalty = (chosenCity === prevCity && size === prevSize && sizeCandidates.length > 1) ? 0.55 : 1;
      const w = Math.max(0.0001, base * penalty);
      sumSize += w;
      return { size, w };
    });
    let pickS = Math.random() * sumSize;
    let chosenSize = weightedSizes[weightedSizes.length - 1].size;
    for (const row of weightedSizes) {
      pickS -= row.w;
      if (pickS <= 0) {
        chosenSize = row.size;
        break;
      }
    }
    queue.push({ city: chosenCity, size: chosenSize });
    bucket[chosenSize] -= 1;
    bucket.total -= 1;
    total -= 1;
    prevCity = chosenCity;
    prevSize = chosenSize;
  }
  return queue;
}

async function fetchRobeV2CityStatsFromCT(cities, { windowDays = 3 } = {}) {
  const ct = resolveCtSecretConfig();
  if (!ct.ok) return { ok: false, error: ct.error || 'ct_config_missing' };
  const hostId = readHostIdSafe();
  const canonicalBase = 'https://api.convenientetecnologia.com';
  const postStats = async (base) => {
    const Aborter = global.AbortController || require('node-abort-controller');
    const ac = new Aborter();
    const timeout = setTimeout(() => { try { ac.abort(); } catch {} }, 10000);
    try {
      const resp = await fetch(`${base}/api/robe/v2/city_stats_secret`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ct.secret ? { 'X-Log-Secret': ct.secret } : {})
        },
        body: JSON.stringify({ hostId, windowDays: Math.max(1, Math.min(10, Math.floor(Number(windowDays || 3) || 3))), cities }),
        signal: ac.signal
      });
      const j = await resp.json().catch(() => null);
      if (!j || j.ok !== true) {
        return { ok: false, error: (j && j.error) ? String(j.error) : `http_${resp.status}` };
      }
      return { ok: true, statsByCity: j.statsByCity || {}, requestId: j.requestId || null, missingCities: Array.isArray(j.missingCities) ? j.missingCities : [] };
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    const primary = await postStats(ct.base);
    if (primary.ok) return primary;
    // Auto-repair operacional: hosts com ctBaseUrl legado podem cair em 404.
    // Faz retry único no domínio canônico sem depender de ação manual.
    if (/^http_404$/i.test(String(primary.error || '')) && String(ct.base).toLowerCase() !== canonicalBase) {
      const fallback = await postStats(canonicalBase);
      if (fallback.ok) return fallback;
      return { ok: false, error: `primary_${primary.error};fallback_${fallback.error}` };
    }
    return primary;
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function generateRobeV2QueueBlock({ reason = 'scheduled' } = {}) {
  const cfg = serverConfig.readServerConfigEffective();
  const robeCfg = (cfg && cfg.robe) ? cfg.robe : {};
  const workMode = String(robeCfg.workMode || 'v1').trim().toLowerCase();
  const isV3 = workMode === 'v3_pmg';
  if (isV3) {
    try {
      if (fotos && typeof fotos.ensurePmgDirs === 'function') fotos.ensurePmgDirs();
    } catch {}
  }
  const tuning = (robeCfg && robeCfg.v2Tuning && typeof robeCfg.v2Tuning === 'object') ? robeCfg.v2Tuning : {};
  const cities = normalizeCityList(cfg && cfg.robe && cfg.robe.cidadesExtrasGlobais);
  if (!cities.length) return { ok: false, error: 'robe_v2_no_global_cities' };
  const plan = calcRobeV2PlanTargetN(cfg);
  const stats = await fetchRobeV2CityStatsFromCT(cities, { windowDays: tuning.statsWindowDays || 3 });
  if (!stats.ok) return { ok: false, error: `stats_fetch_failed:${stats.error}` };
  // IMPORTANTE: missingCities no CT significa "sem grupo/motoristas", não "cidade inválida".
  // Fail-closed apenas quando NÃO há sinal nenhum para nenhuma cidade (evita fallback igualitário burro).
  const statsByCity = (stats && stats.statsByCity && typeof stats.statsByCity === 'object') ? stats.statsByCity : {};
  let keyed = 0;
  let signal = 0;
  for (const city of cities) {
    const rec = statsByCity && statsByCity[city] ? statsByCity[city] : null;
    if (rec) keyed += 1;
    const hab = rec ? Number(rec.habitantes) : NaN;
    const mot = rec ? Number(rec.motoristas) : NaN;
    const ins = rec ? ((rec.insightPercent == null) ? null : Number(rec.insightPercent)) : null;
    const hasPop = Number.isFinite(hab) && hab > 0;
    const hasDrivers = Number.isFinite(mot) && mot > 0;
    const hasInsight = (ins != null) && Number.isFinite(ins) && ins > 0;
    if (hasPop || hasDrivers || hasInsight) signal += 1;
  }
  if (keyed === 0) return { ok: false, error: 'stats_missing_keys_all' };
  if (signal === 0) return { ok: false, error: 'stats_no_signal_all' };
  const calc = computeRobeV2Counts({ cities, statsByCity: statsByCity, targetN: plan.targetN, tuning });
  if (!calc.ok) return { ok: false, error: calc.error || 'counts_calc_failed' };

  let queue = [];
  let rowsOut = Array.isArray(calc.rows) ? calc.rows.slice() : [];
  if (isV3) {
    const slotsByCity = {};
    rowsOut = rowsOut.map((r) => {
      const city = String(r.city || '').trim();
      const L = Math.max(0, Number(r.count || 0) || 0);
      const st = (statsByCity && statsByCity[city]) ? statsByCity[city] : null;
      const pmgRaw = (st && st.pmg && typeof st.pmg === 'object') ? st.pmg : null;
      const motoristas = st ? (Number(st.motoristas || 0) || 0) : (Number(r.motoristas || 0) || 0);
      const pmg = pmgRaw || { p: 0, m: 0, g: 0, fixo: motoristas };
      const alloc = allocatePmgSlots(L, pmg);
      if (city && L > 0) {
        slotsByCity[city] = { P: alloc.nP, M: alloc.nM, G: alloc.nG };
      }
      return {
        ...r,
        motoristas,
        pmg: {
          p: alloc.pmg.p,
          m: alloc.pmg.m,
          g: alloc.pmg.g,
          fixo: alloc.pmg.fixo
        },
        slots: { P: alloc.nP, M: alloc.nM, G: alloc.nG },
        weights: alloc.weights
      };
    });
    queue = buildRobeV3ShuffledQueue(slotsByCity, { antiStreakPenalty: tuning.antiStreakPenalty });
  } else {
    queue = buildRobeV2ShuffledQueue(calc.countsByCity, { antiStreakPenalty: tuning.antiStreakPenalty });
  }
  if (!queue.length) return { ok: false, error: 'empty_queue_generated' };
  const now = Date.now();
  const pr = Number(tuning.prefetchRatio);
  const prefetchRatio = Number.isFinite(pr) ? Math.max(0.01, Math.min(0.8, pr)) : 0.10;
  const prefetchMin = Math.max(1, Math.min(200, Math.floor(Number(tuning.prefetchMin || 5) || 5)));
  const prefetchMax = Math.max(prefetchMin, Math.min(500, Math.floor(Number(tuning.prefetchMax || 20) || 20)));
  return {
    ok: true,
    queue,
    prefetchThreshold: Math.max(prefetchMin, Math.min(prefetchMax, Math.floor(Math.max(1, queue.length) * prefetchRatio) || prefetchMax)),
    meta: {
      reason,
      requestId: stats.requestId || null,
      generatedAt: now,
      citiesCount: cities.length,
      queueMode: isV3 ? 'v3_pmg' : 'v2_auto',
      configSig: JSON.stringify({
        workMode: String(robeCfg.workMode || 'v1'),
        cooldownMinMinutes: Number(robeCfg.cooldownMinMinutes || 0) || 0,
        cooldownMaxMinutes: Number(robeCfg.cooldownMaxMinutes || 0) || 0,
        cities: cities.map((c) => cityNormKey(c)),
        v2Tuning: tuning || null
      }),
      totalProfiles: plan.totalProfiles,
      avgCooldownMin: Number(plan.avgCooldownMin.toFixed(3)),
      targetN: plan.targetN,
      missingCities: stats.missingCities || [],
      params: calc.params || null,
      rows: rowsOut
    },
    planGeneratedAt: now,
    planValidUntil: now + ROBE_V2_REGEN_COOLDOWN_MS,
    planTargetN: plan.targetN
  };
}

async function scheduleRobeV2Regeneration({ reason = 'low_queue', wait = false } = {}) {
  if (!robeV2RegenPromise) {
    robeV2RegenPromise = (async () => {
      let generationId = null;
      try {
        await withRobeV2QueueLock((state) => {
          const now = Date.now();
          const backoffUntil = Number(state.failures && state.failures.backoffUntil || 0) || 0;
          if (backoffUntil > now) return state;
          if (state.regenPending === true) return state;
          generationId = `${process.pid}:${now}:${Math.random().toString(16).slice(2, 8)}`;
          state.regenPending = true;
          state.regenInFlightId = generationId;
          return state;
        });
        if (!generationId) return { ok: true, skipped: true, reason: 'regen_already_pending_or_backoff' };
        const block = await generateRobeV2QueueBlock({ reason });
        await withRobeV2QueueLock((state) => {
          const same = String(state.regenInFlightId || '') === String(generationId || '');
          state.regenPending = false;
          state.regenInFlightId = null;
          if (!same) return state;
          if (!block.ok) {
            const failCount = Math.max(1, Number(state.failures && state.failures.count || 0) + 1);
            const backoff = Math.min(30 * 60 * 1000, Math.max(30 * 1000, (2 ** Math.min(8, failCount)) * 1000));
            state.failures = { count: failCount, lastAt: Date.now(), backoffUntil: Date.now() + backoff };
            state.meta = {
              ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
              lastError: String(block.error || 'regen_failed'),
              lastErrorAt: Date.now()
            };
            return state;
          }
          const oldLen = Array.isArray(state.queue) ? state.queue.length : 0;
          const consumedTotal = Math.max(0, Number(state.consumedTotal || 0) || 0);
          state.queue = (Array.isArray(state.queue) ? state.queue : []).concat(block.queue);
          state.prefetchThreshold = Number(block.prefetchThreshold || state.prefetchThreshold || 20) || 20;
          state.planGeneratedAt = Number(block.planGeneratedAt || Date.now()) || Date.now();
          state.planValidUntil = Number(block.planValidUntil || (Date.now() + ROBE_V2_REGEN_COOLDOWN_MS)) || (Date.now() + ROBE_V2_REGEN_COOLDOWN_MS);
          state.planTargetN = Number(block.planTargetN || 0) || 0;
          state.lastRegenAt = Date.now();
          state.failures = { count: 0, lastAt: 0, backoffUntil: 0 };
          state.meta = block.meta || null;

          // Observabilidade: "último bloco" (mesmo se foi prefetch com itens antigos ainda na frente).
          state.lastBlock = {
            generatedAt: Number(block.meta && block.meta.generatedAt || state.planGeneratedAt || Date.now()) || Date.now(),
            targetN: Number(block.meta && block.meta.targetN || state.planTargetN || 0) || 0,
            citiesCount: Number(block.meta && block.meta.citiesCount || 0) || null,
            reason: String(block.meta && block.meta.reason || reason || '').slice(0, 120) || null,
            requestId: (block.meta && block.meta.requestId) ? String(block.meta.requestId) : null,
            queueMode: (block.meta && block.meta.queueMode) ? String(block.meta.queueMode) : null,
            params: (block.meta && block.meta.params) ? block.meta.params : null,
            rows: Array.isArray(block.meta && block.meta.rows) ? block.meta.rows : null
          };
          state.lastBlockQueueLen = Array.isArray(block.queue) ? block.queue.length : 0;
          state.lastBlockStartAtConsumedTotal = consumedTotal + oldLen; // quando o primeiro item do novo bloco será consumido
          return state;
        });
        return { ok: true };
      } catch (e) {
        try {
          await withRobeV2QueueLock((state) => {
            state.regenPending = false;
            state.regenInFlightId = null;
            const failCount = Math.max(1, Number(state.failures && state.failures.count || 0) + 1);
            const backoff = Math.min(30 * 60 * 1000, Math.max(30 * 1000, (2 ** Math.min(8, failCount)) * 1000));
            state.failures = { count: failCount, lastAt: Date.now(), backoffUntil: Date.now() + backoff };
            state.meta = {
              ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
              lastError: String((e && e.message) || e || 'regen_exception'),
              lastErrorAt: Date.now()
            };
            return state;
          });
        } catch {}
        return { ok: false, error: (e && e.message) || String(e) };
      } finally {
        robeV2RegenPromise = null;
      }
    })();
  }
  if (wait) return robeV2RegenPromise;
  robeV2RegenPromise.catch(() => {});
  return { ok: true, queued: true };
}

async function pickPostingSlotForRunV2() {
  const cfg = serverConfig.readServerConfigEffective();
  const robeCfg = (cfg && cfg.robe) ? cfg.robe : {};
  const cfgCities = normalizeCityList(robeCfg.cidadesExtrasGlobais);
  const expectedSig = JSON.stringify({
    workMode: String(robeCfg.workMode || 'v1'),
    cooldownMinMinutes: Number(robeCfg.cooldownMinMinutes || 0) || 0,
    cooldownMaxMinutes: Number(robeCfg.cooldownMaxMinutes || 0) || 0,
    cities: cfgCities.map((c) => cityNormKey(c)),
    // IMPORTANTÍSSIMO: precisa espelhar exatamente o que foi salvo em meta.configSig,
    // senão cada consumo detecta "configMismatch", zera a fila e força regeneração.
    v2Tuning: (robeCfg && robeCfg.v2Tuning && typeof robeCfg.v2Tuning === 'object') ? robeCfg.v2Tuning : null
  });
  let chosen = { city: '', size: null };
  let queueAfter = 0;
  let threshold = 20;
  let expiredPlan = false;
  const takeOne = (state) => {
    const q = Array.isArray(state.queue) ? state.queue : [];
    if (q.length > 0) {
      const raw = q.shift();
      const slot = robeQueueItemToSlot(raw);
      if (slot.city) {
        chosen = slot;
        state.consumedTotal = Math.max(0, Number(state.consumedTotal || 0) || 0) + 1;
      }
    }
    state.queue = q;
    queueAfter = q.length;
    threshold = Math.max(1, Number(state.prefetchThreshold || 20) || 20);
    expiredPlan = Number(state.planValidUntil || 0) > 0 && Number(state.planValidUntil || 0) <= Date.now();
    return state;
  };
  await withRobeV2QueueLock((state) => {
    const stateSig = String(state && state.meta && state.meta.configSig || '');
    if (stateSig && stateSig !== expectedSig) {
      state.queue = [];
      state.planValidUntil = 0;
      state.planGeneratedAt = 0;
      state.meta = {
        ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
        configMismatchDetectedAt: Date.now(),
        configMismatch: true
      };
    }
    return takeOne(state);
  });
  if (!chosen.city) {
    await scheduleRobeV2Regeneration({ reason: 'empty_queue_blocking', wait: true });
    await withRobeV2QueueLock((state) => takeOne(state));
  }
  if (!chosen.city) {
    const st = readRobeV2QueueState();
    const failCount = Math.max(0, Number(st && st.failures && st.failures.count || 0) || 0);
    const backoffUntil = Math.max(0, Number(st && st.failures && st.failures.backoffUntil || 0) || 0);
    const lastError = (st && st.meta && st.meta.lastError) ? String(st.meta.lastError) : 'none';
    throw new Error(`robe_v2_queue_empty:lastError=${lastError}:failures=${failCount}:backoffUntil=${backoffUntil}`);
  }
  if (queueAfter <= threshold || expiredPlan) {
    scheduleRobeV2Regeneration({ reason: queueAfter <= threshold ? 'prefetch_low_queue' : 'plan_expired', wait: false }).catch(() => {});
  }
  return chosen;
}

async function pickPostingCityForRunV2() {
  const slot = await pickPostingSlotForRunV2();
  return slot && slot.city ? String(slot.city) : '';
}

async function robeV2WarmupNow({ reason = 'manual', force = false } = {}) {
  try {
    // V3: garante pastas Desktop/fotos/{p,m,g} antes de gerar a fila.
    try {
      const cfg = serverConfig.readServerConfigEffective();
      const wm = String(cfg && cfg.robe && cfg.robe.workMode || '').trim().toLowerCase();
      if (wm === 'v3_pmg' && fotos && typeof fotos.ensurePmgDirs === 'function') {
        const ensured = fotos.ensurePmgDirs();
        try {
          logger.info('[ROBE][v3] ensurePmgDirs no warmup', {
            reason: String(reason || '').slice(0, 80),
            created: (ensured && ensured.created) || [],
            ok: !!(ensured && ensured.ok)
          });
        } catch {}
      }
    } catch {}
    if (force) {
      await withRobeV2QueueLock((state) => {
        state.queue = [];
        state.planValidUntil = 0;
        state.planGeneratedAt = 0;
        state.regenPending = false;
        state.regenInFlightId = null;
        state.failures = { count: 0, lastAt: 0, backoffUntil: 0 };
        state.meta = {
          ...(state.meta && typeof state.meta === 'object' ? state.meta : {}),
          forcedResetAt: Date.now(),
          forcedResetReason: String(reason || 'manual').slice(0, 120)
        };
        return state;
      });
    }
    const r = await scheduleRobeV2Regeneration({ reason: String(reason || 'manual'), wait: true });
    const st = readRobeV2QueueState();
    return {
      ok: true,
      regenResult: r || null,
      state: {
        queueTotal: Array.isArray(st.queue) ? st.queue.length : 0,
        consumedTotal: Math.max(0, Number(st.consumedTotal || 0) || 0),
        regenPending: !!st.regenPending,
        lastRegenAt: Number(st.lastRegenAt || 0) || 0,
        failures: st.failures || null,
        lastBlock: st.lastBlock || null
      }
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
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

// Helper: localizar textarea por label (ex.: "Descrição")
async function findTextareaByLabel(page, labelText, timeout = 8000) {
  const started = Date.now();
  const xpaths = [
    `//div[.//span[normalize-space()="${labelText}"]]//textarea`,
    `//label[.//span[normalize-space()="${labelText}"]]//textarea`,
    `//span[normalize-space()="${labelText}"]/ancestor::*[self::div or self::label][1]//textarea`,
    `//textarea[@aria-label="${labelText}"]`,
    `//textarea[contains(@aria-label,"${labelText}")]`
  ];
  while (Date.now() - started < timeout) {
    for (const xp of xpaths) {
      try {
        const els = await page.$x(xp);
        if (els && els[0]) return els[0];
      } catch {}
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
    await handle.click({ delay: jitter(ROBE_CLICK_DELAY_MIN_MS, ROBE_CLICK_DELAY_MAX_MS) }).catch(()=>{});
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
    try { await btn.focus(); await btn.click({ delay: jitter(ROBE_CLICK_DELAY_MIN_MS, ROBE_CLICK_DELAY_MAX_MS) }); clickOk = true; } catch {}
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

function normalizeCityList(input) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(input) ? input : [])) {
    const v = String(raw || '').trim();
    if (!v) continue;
    const k = v.toLocaleLowerCase('pt-BR');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function shuffleCityOrder(list) {
  const arr = Array.isArray(list) ? list.slice(0) : [];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function buildPostingCityPool(manifest) {
  const principal = String(
    (manifest && (manifest.cidade || manifest.localizacao || manifest['localização'])) || ''
  ).trim();
  const extras = normalizeCityList(manifest && manifest.cidadesExtras);
  const globalExtras = (() => {
    try {
      const cfg = serverConfig.readServerConfigEffective();
      return normalizeCityList(cfg && cfg.robe && cfg.robe.cidadesExtrasGlobais);
    } catch {
      return [];
    }
  })();
  const pool = normalizeCityList([principal, ...extras.filter(c => c !== principal), ...globalExtras]);
  return pool.length ? pool : ['São Paulo'];
}

function isCycleCompatible(cycle, pool) {
  if (!cycle || typeof cycle !== 'object') return false;
  const order = normalizeCityList(cycle.order);
  const want = normalizeCityList(pool);
  if (!order.length || order.length !== want.length) return false;
  const ordSet = new Set(order.map(v => v.toLocaleLowerCase('pt-BR')));
  const wantSet = new Set(want.map(v => v.toLocaleLowerCase('pt-BR')));
  if (ordSet.size !== wantSet.size) return false;
  for (const k of wantSet) if (!ordSet.has(k)) return false;
  const idx = Number(cycle.idx || 0);
  if (!Number.isFinite(idx) || idx < 0 || idx > order.length) return false;
  return true;
}

async function pickPostingCityForRun(nome) {
  let workMode = 'v1';
  try {
    const cfg = serverConfig.readServerConfigEffective();
    workMode = String(cfg && cfg.robe && cfg.robe.workMode || 'v1').trim().toLowerCase();
  } catch {}
  if (workMode === 'v2_auto' || workMode === 'v3_pmg') {
    const city = await pickPostingCityForRunV2();
    if (!city) throw new Error(workMode === 'v3_pmg' ? 'robe_v3_city_unavailable' : 'robe_v2_city_unavailable');
    return city;
  }
  let chosen = 'São Paulo';
  await manifestStore.update(nome, (m) => {
    m = m || {};
    const pool = buildPostingCityPool(m);
    let cycle = isCycleCompatible(m.postCityCycle, pool)
      ? { ...m.postCityCycle, order: normalizeCityList(m.postCityCycle.order) }
      : { order: shuffleCityOrder(pool), idx: 0, updatedAt: Date.now() };
    if (!Array.isArray(cycle.order) || !cycle.order.length) {
      cycle.order = shuffleCityOrder(pool);
      cycle.idx = 0;
    }
    let idx = Number(cycle.idx || 0);
    if (!Number.isFinite(idx) || idx < 0 || idx >= cycle.order.length) idx = 0;
    chosen = String(cycle.order[idx] || pool[0] || 'São Paulo').trim() || 'São Paulo';
    idx += 1;
    if (idx >= cycle.order.length) {
      cycle.order = shuffleCityOrder(pool);
      idx = 0;
    }
    cycle.idx = idx;
    cycle.updatedAt = Date.now();
    m.postCityCycle = cycle;
    return m;
  });
  return chosen;
}

async function humanTypeText(page, inputHandle, text, {
  minDelayMs,
  maxDelayMs,
  allowTypo = false,
  typoChance = 0.2
} = {}) {
  const payload = String(text || '');
  if (!payload) return;
  const min = Math.max(1, Number(minDelayMs) || 1);
  const max = Math.max(min, Number(maxDelayMs) || min);
  const shouldTypo = !!allowTypo && payload.length >= 6 && Math.random() < typoChance;
  if (!shouldTypo) {
    await inputHandle.type(payload, { delay: jitter(min, max) });
    return;
  }

  const typoChars = 'aeioubcdfghjklmnpqrstvwxyz';
  const typoIndex = Math.max(1, Math.min(payload.length - 1, jitter(2, Math.min(10, payload.length - 1))));
  const prefix = payload.slice(0, typoIndex);
  const suffix = payload.slice(typoIndex);
  const typoChar = typoChars[Math.floor(Math.random() * typoChars.length)];

  await inputHandle.type(prefix, { delay: jitter(min, max) });
  await inputHandle.type(typoChar, { delay: jitter(min, max) });
  await sleep(jitter(120, 380));
  try {
    await inputHandle.press('Backspace');
  } catch {
    try { await page.keyboard.press('Backspace'); } catch {}
  }
  await sleep(jitter(90, 260));
  await inputHandle.type(suffix, { delay: jitter(min, max) });
}

// Preenche Título e confere (timings otimizados)
async function preencherTitulo(page, titulo) {
  const inp = await findInputByLabel(page, 'Título', 7000);
  if (!inp) throw new Error('Campo Título não localizado.');
  await inp.click({ clickCount: 3 });
  await sleep(jitter(120, 220));
  await humanTypeText(page, inp, titulo, {
    minDelayMs: ROBE_TITLE_TYPE_DELAY_MIN_MS,
    maxDelayMs: ROBE_TITLE_TYPE_DELAY_MAX_MS,
    allowTypo: true,
    typoChance: 0.2
  });
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
  await inp.type('0', { delay: jitter(ROBE_PRICE_TYPE_DELAY_MIN_MS, ROBE_PRICE_TYPE_DELAY_MAX_MS) });
  await sleep(jitter(100, 180));
  await inp.press('Enter');
  await sleep(jitter(200, 320));
  const val = await page.evaluate(el => el.value, inp);
  const txt = String(val || '').trim();
  const onlyDigits = txt.replace(/\D/g, '');
  const ok = !!txt && !!onlyDigits && !/[1-9]/.test(onlyDigits);
  if (!ok) throw new Error(`Preço não ficou "0" (value="${val}").`);
}

async function preencherDescricaoItem(page) {
  const arquivo = path.join(__dirname, '..', 'dados', 'descricaoItens.json');
  const arr = readJsonSafe(arquivo, []);
  let descricao = '';
  if (Array.isArray(arr) && arr.length) {
    descricao = String(arr[Math.floor(Math.random() * arr.length)] || '').trim();
  }
  if (!descricao) return { ok: false, reason: 'no_descriptions' };

  const tx = await findTextareaByLabel(page, 'Descrição', 7000);
  let el = tx;
  if (!el) {
    // fallback robusto: textarea visível, priorizando seção próxima do texto "Descrição"
    const h = await page.evaluateHandle((labelText) => {
      const norm = s => String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'')
        .trim()
        .toLowerCase();
      const isVisible = node => {
        if (!node) return false;
        const st = window.getComputedStyle(node);
        if (!st) return false;
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const r = node.getBoundingClientRect();
        return !!(r && r.width > 8 && r.height > 8);
      };
      const wanted = norm(labelText);
      const spans = Array.from(document.querySelectorAll('span,div,label'))
        .filter(n => norm(n.textContent || '') === wanted);
      for (const s of spans) {
        const box = s.closest('div,section,fieldset,form,label') || s.parentElement;
        if (!box) continue;
        const txs = Array.from(box.querySelectorAll('textarea')).filter(isVisible);
        if (txs[0]) return txs[0];
      }
      const allVisible = Array.from(document.querySelectorAll('textarea')).filter(isVisible);
      return allVisible[0] || null;
    }, 'Descrição').catch(() => null);
    el = h && h.asElement ? h.asElement() : null;
  }
  if (!el) return { ok: false, reason: 'no_textarea' };

  try { await el.click({ clickCount: 1 }); } catch {}
  await sleep(jitter(100, 180));
  // limpar
  try { await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); } catch {}
  try { await page.keyboard.press('Backspace'); } catch {}
  await sleep(50);
  try {
    await humanTypeText(page, el, descricao, {
      minDelayMs: ROBE_DESC_TYPE_DELAY_MIN_MS,
      maxDelayMs: ROBE_DESC_TYPE_DELAY_MAX_MS,
      allowTypo: true,
      typoChance: 0.2
    });
  } catch {}
  await sleep(jitter(120, 220));

  // validação simples: tem algum texto
  const got = await page.evaluate(e => (e.value || '').trim(), el).catch(()=> '');
  if (!got) return { ok: false, reason: 'desc_empty_after_type' };
  return { ok: true, len: got.length };
}

function _normCategory(s) {
  // Normalização robusta para comparar texto do DOM:
  // - remove acentos
  // - unifica hífen/minus e travessões (–/—) para "-"
  // - remove pontuação/duplicidade de espaços
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[\u2013\u2014]/g, '-') // – —
    .replace(/[“”"']/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _shuffleCopy(arr) {
  const a = Array.isArray(arr) ? arr.slice() : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function _assertCategoriaApplied(page, alvo) {
  const alvoNorm = _normCategory(alvo);
  return await page.evaluate((alvoNormInner) => {
    const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
    const inp = document.querySelector('input[aria-label="Categoria"]');
    if (inp && norm(inp.value).includes(alvoNormInner)) return true;
    const lab = Array.from(document.querySelectorAll('label')).find(l=> (l.textContent||'').includes('Categoria'));
    const txt = lab ? (lab.innerText||lab.textContent||'') : '';
    if (norm(txt).includes(alvoNormInner)) return true;
    const lab2 = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Categoria'));
    if (!lab2) return false;
    const box = lab2.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return norm(box.innerText || '').includes(alvoNormInner);
  }, alvoNorm);
}

async function _clickCategoriaSuggestionByText(page, alvo) {
  const targetNorm = _normCategory(alvo);
  if (!targetNorm) return false;
  return await page.evaluate((targetNormInner) => {
    const norm = s => String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[“”"']/g, '')
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = el => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st) return false;
      if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
      const r = el.getBoundingClientRect();
      return !!(r && r.width > 4 && r.height > 4);
    };
    const clickNode = node => {
      if (!node) return false;
      const host = node.closest('[role="option"], [role="radio"], [role="button"], li, div') || node;
      if (!isVisible(host)) return false;
      host.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    };

    // Prioridade 1: opções de listas abertas
    const nodes = Array.from(document.querySelectorAll('[role="option"], [role="radio"], [role="button"], li, span, div'));
    const hit = nodes.find(el => {
      if (!isVisible(el)) return false;
      const txt = norm(el.innerText || el.textContent || '');
      return !!txt && (txt === targetNormInner || txt.includes(targetNormInner));
    });
    if (hit && clickNode(hit)) return true;

    // Prioridade 2: spans com texto exato
    const sp = Array.from(document.querySelectorAll('span'))
      .find(s => norm(s.textContent || '') === targetNormInner);
    if (sp && clickNode(sp)) return true;
    return false;
  }, targetNorm).catch(() => false);
}

async function _selectCategoriaByTypingNewDom(page, alvo) {
  const input = await page.$('input[aria-label="Categoria"][role="combobox"][type="search"]');
  if (!input) return { ok: false, reason: 'no_new_dom_input' };
  await input.click({ delay: jitter(ROBE_CLICK_DELAY_MIN_MS, ROBE_CLICK_DELAY_MAX_MS) }).catch(()=>{});
  await sleep(120);
  // limpa o campo
  try { await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); } catch {}
  try { await page.keyboard.press('Backspace'); } catch {}
  await sleep(40);
  await input.type(String(alvo || ''), { delay: jitter(ROBE_TYPE_DELAY_MIN_MS, ROBE_TYPE_DELAY_MAX_MS) }).catch(()=>{});
  await sleep(260);
  // Estratégia principal validada em produção: com única sugestão visível, ArrowDown + Enter seleciona corretamente.
  try { await page.keyboard.press('ArrowDown'); } catch {}
  await sleep(90);
  try { await page.keyboard.press('Enter'); } catch {}
  await sleep(260);

  let ok = await _assertCategoriaApplied(page, alvo).catch(() => false);
  if (ok) return { ok: true, method: 'type_new_dom_arrow_enter' };

  // Fallback 1: repetir ArrowDown+Enter caso a lista tenha aberto com atraso.
  await sleep(220);
  try { await page.keyboard.press('ArrowDown'); } catch {}
  await sleep(90);
  try { await page.keyboard.press('Enter'); } catch {}
  await sleep(240);
  ok = await _assertCategoriaApplied(page, alvo).catch(() => false);
  if (ok) return { ok: true, method: 'type_new_dom_arrow_enter_retry' };

  // Fallback 2: clique textual na opção.
  const clicked = await _clickCategoriaSuggestionByText(page, alvo).catch(() => false);
  await sleep(240);
  ok = await _assertCategoriaApplied(page, alvo).catch(() => false);
  return ok ? { ok: true, method: clicked ? 'type_new_dom_click_fallback' : 'type_new_dom_fallback_unknown' } : { ok: false, reason: 'new_dom_not_applied' };
}

async function _selectCategoriaByTabsLegacyDom(page, alvo, tabsCount) {
  const combo = await findComboboxByLabel(page, 'Categoria', 7000);
  if (!combo) return { ok: false, reason: 'no_legacy_combo' };
  await combo.click();
  await sleep(jitter(160, 240));

  // Regra do Cassio (legacy): Tab N vezes + Enter
  // Timing controlado: manter rápido sem "insanidade" (alvo ~700ms total até Enter).
  const perTabDelayBase = Math.max(20, parseInt(process.env.ROBE_CAT_TAB_DELAY_MS || '30', 10) || 30);
  const n = Math.max(1, Math.min(24, parseInt(String(tabsCount || 1), 10) || 1));
  for (let attempt = 0; attempt < 3; attempt++) {
    const perTabDelay = perTabDelayBase + (attempt * 20);
    try {
      if (attempt > 0) {
        try { await page.keyboard.press('Escape'); } catch {}
        await sleep(80);
        try { await combo.click(); } catch {}
        await sleep(jitter(120, 220));
      }

      for (let i = 0; i < n; i++) {
        await page.keyboard.press('Tab');
        await sleep(perTabDelay);
      }

      const focusCheck = await page.evaluate(() => {
        const txt = v => String(v || '').trim();
        const el = document.activeElement;
        if (!el) return { safe: false, risk: false, reason: 'no_active_element' };
        const tag = txt(el.tagName).toLowerCase();
        const type = txt(el.getAttribute && el.getAttribute('type')).toLowerCase();
        const role = txt(el.getAttribute && el.getAttribute('role')).toLowerCase();
        const aria = txt(el.getAttribute && el.getAttribute('aria-label')).toLowerCase();
        const text = txt(el.textContent).toLowerCase();
        const fileRisk = (tag === 'input' && type === 'file') || /arquivo|anexo|upload|foto|video/.test(`${aria} ${text}`);
        if (fileRisk) return { safe: false, risk: true, reason: 'file_focus_risk' };
        const inCategoriaContext =
          aria.includes('categoria') ||
          role === 'option' ||
          role === 'radio' ||
          role === 'menuitemradio' ||
          role === 'listbox' ||
          !!el.closest('[role="listbox"], [role="menu"], [role="combobox"], [aria-label*="Categoria"], [aria-label*="categoria"]');
        return { safe: !!inCategoriaContext, risk: false, reason: inCategoriaContext ? 'ok' : 'focus_outside_categoria' };
      }).catch(() => ({ safe: false, risk: false, reason: 'focus_eval_failed' }));

      if (!focusCheck.safe) {
        if (focusCheck.risk) {
          try { await page.keyboard.press('Escape'); } catch {}
          await sleep(120);
        }
        continue;
      }

      await page.keyboard.press('Enter');
      await sleep(jitter(220, 340));
      const ok = await _assertCategoriaApplied(page, alvo).catch(() => false);
      if (ok) return { ok: true, method: `tab_legacy_${n}_attempt_${attempt + 1}` };
    } catch {}
  }

  return { ok: false, reason: 'legacy_tab_not_applied_safe_retries' };
}

async function _selectCategoriaByClickLegacyDom(page, alvo) {
  const combo = await findComboboxByLabel(page, 'Categoria', 7000);
  if (!combo) return { ok: false, reason: 'no_legacy_combo' };
  await combo.click();
  await sleep(jitter(160, 240));
  const clicked = await clickItemByText(page, String(alvo || ''), 1800);
  await sleep(jitter(220, 320));
  const ok = clicked ? await _assertCategoriaApplied(page, alvo).catch(() => false) : false;
  return ok ? { ok: true, method: 'click_legacy' } : { ok: false, reason: 'legacy_click_not_applied' };
}

async function _selectCategoriaRadioModelRandom(page, opcoes) {
  // Modelo alternativo observado: lista de categorias em cards (role="button"/"radio"),
  // sem input search visível no estado inicial. Nesse modelo, usar categorias random (não fixar Diversos).
  const candidatos = _shuffleCopy(Array.isArray(opcoes) ? opcoes.slice() : []);
  if (!candidatos.length) return { ok: false, reason: 'no_radio_candidates' };

  async function ensureCategoriaOpened() {
    try {
      const combo = await findComboboxByLabel(page, 'Categoria', 1200).catch(() => null);
      if (combo) {
        try { await combo.click(); } catch {}
      } else {
        await page.evaluate(() => {
          const span = Array.from(document.querySelectorAll('span')).find(s => (s.textContent || '').trim() === 'Categoria');
          if (!span) return;
          const host = span.closest('[role="button"], [role="combobox"], label, div');
          if (!host) return;
          host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
          host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          host.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        });
      }
      await sleep(jitter(220, 340));
    } catch {}
  }

  await ensureCategoriaOpened();

  async function clickOptionByNorm(alvo) {
    const alvoNorm = _normCategory(alvo);
    return await page.evaluate((targetNorm) => {
      const norm = s => String(s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'')
        .replace(/[\u2013\u2014]/g,'-')
        .replace(/[“”"']/g, '')
        .replace(/[^\w\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const nodes = Array.from(document.querySelectorAll('[role="radio"], [role="button"]'));
      const hit = nodes.find(el => norm(el.innerText || el.textContent || '').includes(targetNorm));
      if (!hit) return false;
      hit.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }, alvoNorm).catch(() => false);
  }

  for (const alvo of candidatos) {
    const clicked = await clickOptionByNorm(alvo);
    if (!clicked) continue;
    await sleep(jitter(220, 340));
    const ok = await _assertCategoriaApplied(page, alvo).catch(() => false);
    if (ok) return { ok: true, value: alvo, method: 'radio_model_random' };
  }

  return { ok: false, reason: 'radio_click_not_applied' };
}

// Categoria (multi-modelo):
// - Input search (type=search): fixar somente "Diversos"
// - Modelo em lista/radio (sem input): random entre 5 categorias
// - Legacy TAB: random entre 4 categorias (compatibilidade antiga)
async function selecionarCategoriaMoveis(page) {
  const opcoes = [
    'Móveis',
    'Ferramentas',
    'Diversos',
    'Utilidades domésticas',
    'Venda de garagem'
  ];

  // Modelo com input de busca: fixar somente "Diversos"
  const input = await page.$('input[aria-label="Categoria"][role="combobox"][type="search"]');
  if (input) {
    const r = await _selectCategoriaByTypingNewDom(page, 'Diversos');
    if (r && r.ok) return { ok: true, value: 'Diversos', method: r.method };
    throw new Error('Falha ao selecionar categoria "Diversos" no modelo com input search.');
  }

  // Modelo alternativo (lista/radio): random entre categorias
  const radio = await _selectCategoriaRadioModelRandom(page, opcoes).catch(() => ({ ok: false }));
  if (radio && radio.ok) return { ok: true, value: radio.value, method: radio.method };

  // Legacy DOM (TAB)
  const legacyMap = [
    { value: 'Móveis', tabs: 1 },
    { value: 'Utilidades domésticas', tabs: 2 },
    { value: 'Venda de garagem', tabs: 23 },
    { value: 'Diversos', tabs: 24 }
  ];
  const legacyCandidates = _shuffleCopy(legacyMap);
  for (const it of legacyCandidates) {
    // Primeiro tenta click por texto (se funcionar, é mais seguro do que 23/24 TABs)
    const c = await _selectCategoriaByClickLegacyDom(page, it.value);
    if (c && c.ok) return { ok: true, value: it.value, method: c.method };

    const r = await _selectCategoriaByTabsLegacyDom(page, it.value, it.tabs);
    if (r && r.ok) return { ok: true, value: it.value, method: r.method };
  }

  throw new Error(`Falha ao selecionar categoria no legacy DOM (TAB/click). tried=${JSON.stringify(legacyCandidates.map(x=>x.value))}`);
}

async function _assertCondicaoApplied(page, alvo) {
  const alvoNorm = _normCategory(alvo);
  // 1) Preferir ler do próprio combobox (mais confiável que procurar classes internas voláteis)
  try {
    const combo = await findComboboxByLabel(page, 'Condição', 2500).catch(() => null);
    if (combo) {
      const txt = await page.evaluate(el => (el.innerText || el.textContent || ''), combo).catch(() => '');
      if (_normCategory(txt).includes(alvoNorm)) return true;
    }
  } catch {}

  // 2) Fallback: heurística antiga (caso o combobox esteja fora da viewport / handle falhe)
  return await page.evaluate((alvoNormInner) => {
    const norm = s => (s||'')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g,'')
      .replace(/[\u2013\u2014]/g,'-')
      .trim()
      .toLowerCase();
    const lab = Array.from(document.querySelectorAll('label[role="combobox"]'))
      .find(l => l.textContent && l.textContent.includes('Condição'));
    if (!lab) return false;
    const box = lab.querySelector('.xjyslct, [class*="xjyslct"]');
    if (!box) return false;
    return norm(box.innerText || '').includes(alvoNormInner);
  }, alvoNorm);
}

const ROBE_CONDICOES = [
  'Novo',
  'Usado - estado de novo',
  'Usado - em boas condições',
  'Usado - em condições razoáveis'
];

async function _readCondicaoFromCombo(page) {
  const combo = await findComboboxByLabel(page, 'Condição', 2500).catch(() => null);
  if (!combo) return null;
  const txt = await page.evaluate(el => (el.innerText || el.textContent || ''), combo).catch(() => '');
  const norm = _normCategory(txt);
  if (!norm) return null;
  for (const opt of ROBE_CONDICOES) {
    if (norm.includes(_normCategory(opt))) return opt;
  }
  return String(txt || '').trim() || null;
}

// Condição (random): setas pra baixo conforme mapeamento do Cássio.
// 1 seta  = Novo
// 2 setas = Usado - estado de novo
// 3 setas = Usado - em boas condições
// 4 setas = Usado - em condições razoáveis
async function selecionarCondicaoNovo(page) {
  const combo = await findComboboxByLabel(page, 'Condição', 7000);
  if (!combo) throw new Error('Combobox "Condição" não localizado.');
  await combo.click();
  await sleep(jitter(200, 320));
  await page.keyboard.press('Enter');
  await sleep(jitter(180, 260));

  const opcoes = _shuffleCopy([
    { value: ROBE_CONDICOES[0], arrows: 1 },
    { value: ROBE_CONDICOES[1], arrows: 2 },
    { value: ROBE_CONDICOES[2], arrows: 3 },
    { value: ROBE_CONDICOES[3], arrows: 4 }
  ]);

  const perArrowDelay = Math.max(20, parseInt(process.env.ROBE_COND_ARROW_DELAY_MS || '45', 10) || 45);
  const tried = [];
  for (const it of opcoes) {
    tried.push(it.value);
    try {
      for (let i = 0; i < it.arrows; i++) {
        await page.keyboard.press('ArrowDown');
        await sleep(perArrowDelay);
      }
      await page.keyboard.press('Enter');
    } catch {}
    await sleep(jitter(220, 360));
    const ok = await _assertCondicaoApplied(page, it.value).catch(() => false);
    if (ok) return { ok: true, value: it.value, method: `arrowdown_${it.arrows}`, tried };

    // Se o assert falhar por DOM/label, mas o combobox já mostra uma das condições esperadas, aceite e siga.
    const seen = await _readCondicaoFromCombo(page).catch(() => null);
    if (seen && ROBE_CONDICOES.map(_normCategory).includes(_normCategory(seen))) {
      return { ok: true, value: seen, method: 'combo_readback', tried };
    }

    // reset: reabre o combo para tentar outra opção (evita "somar setas" em sequência)
    try {
      await combo.click();
      await sleep(jitter(160, 240));
      await page.keyboard.press('Enter');
      await sleep(jitter(120, 200));
    } catch {}
  }

  throw new Error(`Falha ao selecionar condição (random). tried=${JSON.stringify(tried)}`);
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
  // Alguns fluxos movem Localização para a próxima etapa; tenta "Avançar" e revalida.
  if (!inp) {
    for (let step = 0; step < 2 && !inp; step++) {
      const btnAv = await findEnabledButton(page, 'Avançar', 1400).catch(() => null);
      if (!btnAv) break;
      await clickExactCenter(page, btnAv).catch(() => {});
      await sleep(jitter(420, 620));
      await ensureMaisDetalhesAberto(page, 2500).catch(() => false);
      inp = await findInputByLabel(page, 'Localização', 2500) || await page.$('input[aria-label="Localização"]');
    }
  }
  if (!inp) throw new Error('Campo Localização não localizado (nem após avançar etapa).');

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
    await inp.type(cand, { delay: jitter(ROBE_LOCATION_TYPE_DELAY_MIN_MS, ROBE_LOCATION_TYPE_DELAY_MAX_MS) });
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

async function findFileInputInFrame(frame) {
  if (!frame) return null;
  let handle = null;
  try {
    handle = await frame.evaluateHandle(() => {
      const pick = (root) => {
        if (!root) return null;
        const direct = root.querySelector && root.querySelector('input[type="file"][accept*="image"], input[type="file"]');
        if (direct) return direct;
        const queue = [];
        if (root.children && root.children.length) {
          for (const el of root.children) queue.push(el);
        } else if (root.documentElement) {
          queue.push(root.documentElement);
        }
        while (queue.length) {
          const el = queue.shift();
          if (!el) continue;
          if (el.tagName === 'INPUT') {
            const t = String(el.type || '').toLowerCase();
            if (t === 'file') return el;
          }
          if (el.shadowRoot) {
            const inside = pick(el.shadowRoot);
            if (inside) return inside;
          }
          if (el.children && el.children.length) {
            for (const c of el.children) queue.push(c);
          }
        }
        return null;
      };
      return pick(document);
    });
    const el = handle && typeof handle.asElement === 'function' ? handle.asElement() : null;
    if (el) return el;
  } catch {}
  try { if (handle && typeof handle.dispose === 'function') await handle.dispose(); } catch {}
  return null;
}

async function findFileInputEverywhere(page) {
  if (!page) return null;
  let input = await findFileInputInFrame(page).catch(()=>null);
  if (input) return input;
  for (const fr of page.frames()) {
    if (!fr || fr === page.mainFrame()) continue;
    input = await findFileInputInFrame(fr).catch(()=>null);
    if (input) return input;
  }
  return null;
}

async function triggerPhotoPickerEverywhere(page) {
  if (!page) return;
  const clickInFrame = async (frame) => {
    try {
      await frame.evaluate(() => {
        const hasPhotoWord = (s) => /(foto|fotos|imagem|imagens|photo|photos|image|images|upload|adicionar fotos|add photos)/i.test(String(s || ''));
        const candidates = Array.from(document.querySelectorAll('label,[role="button"],button,div,span,a'));
        for (const el of candidates) {
          const txt = `${el.innerText || ''} ${el.textContent || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''}`.trim();
          if (!hasPhotoWord(txt)) continue;
          const st = window.getComputedStyle(el);
          if (!st || st.display === 'none' || st.visibility === 'hidden') continue;
          try { el.click(); return; } catch {}
        }
      });
    } catch {}
  };
  await clickInFrame(page).catch(()=>{});
  for (const fr of page.frames()) {
    if (!fr || fr === page.mainFrame()) continue;
    await clickInFrame(fr).catch(()=>{});
  }
}

async function captureCreatePageVitals(page, nome, attId, stage) {
  if (!page) return;
  let snap = null;
  try {
    snap = await page.evaluate(() => {
      const d = document;
      const b = d && d.body;
      const h = d && d.documentElement;
      const bodyStyle = b ? window.getComputedStyle(b) : null;
      const htmlStyle = h ? window.getComputedStyle(h) : null;
      const txt = b ? String((b.innerText || '').trim()) : '';
      return {
        href: String(location.href || ''),
        readyState: String(d && d.readyState || ''),
        visibilityState: String(d && d.visibilityState || ''),
        hidden: !!(d && d.hidden),
        bodyExists: !!b,
        bodyChildCount: b && b.children ? Number(b.children.length || 0) : 0,
        textLen: txt.length,
        textHead: txt.slice(0, 140),
        htmlBg: htmlStyle ? String(htmlStyle.backgroundColor || '') : '',
        bodyBg: bodyStyle ? String(bodyStyle.backgroundColor || '') : '',
        htmlDisplay: htmlStyle ? String(htmlStyle.display || '') : '',
        bodyDisplay: bodyStyle ? String(bodyStyle.display || '') : '',
        htmlVisibility: htmlStyle ? String(htmlStyle.visibility || '') : '',
        bodyVisibility: bodyStyle ? String(bodyStyle.visibility || '') : '',
        viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
        fileInputs: d ? d.querySelectorAll('input[type="file"]').length : 0,
        notificationType: typeof Notification,
        hasNotificationInWindow: ('Notification' in window),
        hasPermissionsApi: !!(navigator && navigator.permissions && typeof navigator.permissions.query === 'function'),
        serviceWorkerControlled: !!(navigator && navigator.serviceWorker && navigator.serviceWorker.controller)
      };
    });
  } catch (e) {
    snap = { evalError: String((e && e.message) || e || '') };
  }
  // #region agent log
  try { provisionAudit.append({ ts: Date.now(), event: 'dbg_create_page_vitals', nome: String(nome || ''), attId: String(attId || ''), stage: String(stage || ''), snap }); } catch {}
  // #endregion
}

async function readCreatePageVitals(page) {
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      const d = document;
      const b = d && d.body;
      const txt = b ? String((b.innerText || '').trim()) : '';
      return {
        href: String(location.href || ''),
        readyState: String(d && d.readyState || ''),
        textLen: txt.length,
        fileInputs: d ? d.querySelectorAll('input[type="file"]').length : 0
      };
    });
  } catch {
    return null;
  }
}

function isCreateFormDegraded(v) {
  if (!v) return true;
  const textLen = Number(v.textLen || 0);
  const fileInputs = Number(v.fileInputs || 0);
  return fileInputs <= 0 || textLen < 120;
}

function isMarketplaceComposerRateLimitMessage(msg) {
  const s = String(msg || '');
  if (!s) return false;
  return /1675004/.test(s) && /useMarketplaceComposerMedianPackageDetailQuery/i.test(s);
}

function installCreatePageForensics(page, nome, attId) {
  if (!page || page.__ctCreateForensicsInstalled) return;
  page.__ctCreateForensicsInstalled = true;
  const state = { console: 0, pageerror: 0, requestfailed: 0, nav: 0, response: 0, runtime: 0, graphql: 0, graphqlReq: 0 };
  const maxEach = 14;
  const can = (k) => {
    state[k] = Number(state[k] || 0) + 1;
    return state[k] <= maxEach;
  };
  const logEvt = (event, data) => {
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event, nome: String(nome || ''), attId: String(attId || ''), data: data || null }); } catch {}
    // #endregion
  };
  try {
    page.on('pageerror', (err) => {
      if (!can('pageerror')) return;
      const msg = String((err && err.message) || err || '');
      const stack = String((err && err.stack) || '').slice(0, 500);
      const name = String((err && err.name) || '');
      logEvt('dbg_create_page_pageerror', { message: msg.slice(0, 300), name: name.slice(0, 80), stack });
    });
  } catch {}
  try {
    page.on('console', (m) => {
      if (!can('console')) return;
      const type = String((m && m.type && m.type()) || '');
      const text = String((m && m.text && m.text()) || '');
      if (!/error|warning|assert/i.test(type) && !/chunk|react|marketplace|exception|error/i.test(text)) return;
      logEvt('dbg_create_page_console', { type, text: text.slice(0, 340) });
    });
  } catch {}
  try {
    page.on('requestfailed', (req) => {
      if (!can('requestfailed')) return;
      const url = String((req && req.url && req.url()) || '');
      const type = String((req && req.resourceType && req.resourceType()) || '');
      const err = req && req.failure ? req.failure() : null;
      const em = err && err.errorText ? String(err.errorText) : '';
      if (!/script|xhr|fetch|document/i.test(type)) return;
      logEvt('dbg_create_page_requestfailed', { type, url: url.slice(0, 300), errorText: em.slice(0, 120) });
    });
  } catch {}
  try {
    page.on('framenavigated', (frame) => {
      if (!frame || frame !== page.mainFrame() || !can('nav')) return;
      const url = String((frame && frame.url && frame.url()) || '');
      logEvt('dbg_create_page_mainframe_nav', { url: url.slice(0, 300) });
    });
  } catch {}
  try {
    page.on('response', (resp) => {
      if (!can('response')) return;
      const status = Number((resp && resp.status && resp.status()) || 0);
      if (!status || status < 400) return;
      const req = resp && resp.request ? resp.request() : null;
      const type = String((req && req.resourceType && req.resourceType()) || '');
      if (!/script|xhr|fetch|document/i.test(type)) return;
      const url = String((resp && resp.url && resp.url()) || '');
      logEvt('dbg_create_page_response_error', { status, type, url: url.slice(0, 300) });
    });
  } catch {}
  try {
    page.on('response', async (resp) => {
      if (!can('graphql')) return;
      const req = resp && resp.request ? resp.request() : null;
      const type = String((req && req.resourceType && req.resourceType()) || '');
      if (!/xhr|fetch/i.test(type)) return;
      const url = String((resp && resp.url && resp.url()) || '');
      if (!/\/api\/graphql\//i.test(url)) return;
      const status = Number((resp && resp.status && resp.status()) || 0);
      let raw = '';
      try { raw = String(await resp.text()); } catch {}
      if (!raw || !/1675004|useMarketplaceComposerMedianPackageDetailQuery/i.test(raw)) return;
      let code = null;
      let message = '';
      let operation = '';
      try {
        const parsed = JSON.parse(raw);
        const getFirstErr = (obj) => {
          if (!obj) return null;
          if (Array.isArray(obj)) {
            for (const it of obj) {
              const hit = getFirstErr(it);
              if (hit) return hit;
            }
            return null;
          }
          if (obj && Array.isArray(obj.errors) && obj.errors.length) return obj.errors[0];
          if (obj && obj.error) return obj.error;
          return null;
        };
        const err = getFirstErr(parsed);
        if (err && typeof err === 'object') {
          code = (err.code != null) ? String(err.code) : (err.error_code != null ? String(err.error_code) : null);
          message = String(err.message || err.summary || '').slice(0, 260);
          operation = String(err.error_user_title || err.error_user_msg || '').slice(0, 160);
        }
      } catch {}
      logEvt('dbg_create_page_graphql_rate_payload', {
        status,
        type,
        url: url.slice(0, 300),
        code: code || null,
        message: message || null,
        operation: operation || null,
        bodyReadable: !!raw,
        bodyLen: Number((raw && raw.length) || 0),
        matched1675004: /1675004/.test(raw),
        matchedComposerOp: /useMarketplaceComposerMedianPackageDetailQuery/i.test(raw)
      });
    });
  } catch {}
  try {
    page.on('request', (req) => {
      if (!can('graphqlReq')) return;
      const url = String((req && req.url && req.url()) || '');
      if (!/\/api\/graphql\//i.test(url)) return;
      const type = String((req && req.resourceType && req.resourceType()) || '');
      if (!/xhr|fetch/i.test(type)) return;
      const method = String((req && req.method && req.method()) || '');
      let postData = '';
      try { postData = String((req && req.postData && req.postData()) || ''); } catch {}
      if (!/MarketplaceComposer|useMarketplaceComposerMedianPackageDetailQuery|doc_id|fb_api_req_friendly_name/i.test(postData)) return;
      const opMatch = postData.match(/(?:fb_api_req_friendly_name|operationName)=([^&]+)/i);
      const docMatch = postData.match(/doc_id=([0-9]+)/i);
      const varsMatch = postData.match(/variables=([^&]+)/i);
      let op = '';
      let varsHead = '';
      try { op = opMatch ? decodeURIComponent(String(opMatch[1] || '')) : ''; } catch {}
      try { varsHead = varsMatch ? decodeURIComponent(String(varsMatch[1] || '')).slice(0, 200) : ''; } catch {}
      logEvt('dbg_create_page_graphql_request', {
        method,
        type,
        url: url.slice(0, 300),
        operation: op.slice(0, 140) || null,
        docId: docMatch ? String(docMatch[1] || '') : null,
        hasComposerMarker: /useMarketplaceComposerMedianPackageDetailQuery/i.test(postData),
        postDataLen: postData.length,
        varsHead
      });
    });
  } catch {}
  try {
    const fnName = `__ctCreateForensicsEmit_${String(attId || 'na').replace(/[^a-zA-Z0-9_]/g, '_')}`;
    if (!page[fnName]) {
      page[fnName] = true;
      page.exposeFunction(fnName, (payload) => {
        if (!can('runtime')) return;
        const data = (payload && typeof payload === 'object') ? payload : null;
        logEvt('dbg_create_page_runtime_error', data);
        const msg = String((data && data.message) || '');
        if (isMarketplaceComposerRateLimitMessage(msg)) {
          page.__ctMarketplaceComposerRateLimited = {
            ts: Date.now(),
            code: '1675004',
            message: msg.slice(0, 280)
          };
          logEvt('dbg_create_page_rate_limit_detected', {
            code: '1675004',
            op: 'useMarketplaceComposerMedianPackageDetailQuery',
            message: msg.slice(0, 280)
          });
        }
      }).catch(() => {});
      page.evaluateOnNewDocument((name) => {
        try {
          const emit = (kind, payload) => {
            try {
              const fn = window[name];
              if (typeof fn === 'function') fn({ kind, ...(payload || {}) });
            } catch {}
          };
          window.addEventListener('error', (e) => {
            const message = String((e && e.message) || '');
            const filename = String((e && e.filename) || '');
            const lineno = Number((e && e.lineno) || 0);
            const colno = Number((e && e.colno) || 0);
            const stack = String((e && e.error && e.error.stack) || '').slice(0, 500);
            emit('window_error', { message: message.slice(0, 300), filename: filename.slice(0, 260), lineno, colno, stack });
          }, true);
          window.addEventListener('unhandledrejection', (e) => {
            const reason = (e && e.reason);
            const msg = typeof reason === 'string'
              ? reason
              : String((reason && reason.message) || reason || '');
            const stack = String((reason && reason.stack) || '').slice(0, 500);
            emit('unhandledrejection', { message: msg.slice(0, 300), stack });
          }, true);
        } catch {}
      }, fnName).catch(() => {});
    }
  } catch {}
}

async function installCreatePageGraphqlRateGuard(page, nome, attId) {
  if (!page || page.__ctGraphqlRateGuardInstalled) return;
  page.__ctGraphqlRateGuardInstalled = true;
  try {
    if (!page._ctRateGuardInterceptionEnabled) {
      await page.setRequestInterception(true);
      page._ctRateGuardInterceptionEnabled = true;
    }
  } catch {}
  const safeContinue = (req) => {
    try { req.continue(); } catch {}
  };
  try {
    page.on('request', (req) => {
      try {
        const url = String((req && req.url && req.url()) || '');
        const method = String((req && req.method && req.method()) || '');
        if (!/\/api\/graphql\//i.test(url) || method !== 'POST') return safeContinue(req);
        const postData = String((req && req.postData && req.postData()) || '');
        const isComposerMedianQuery =
          /useMarketplaceComposerMedianPackageDetailQuery/i.test(postData) ||
          /doc_id=9336866166424067/i.test(postData);
        if (!isComposerMedianQuery) return safeContinue(req);
        // #region agent log
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'dbg_create_page_graphql_rate_guard_stubbed',
            nome: String(nome || ''),
            attId: String(attId || ''),
            data: { url: url.slice(0, 260), method: String(method || ''), postDataLen: Number(postData.length || 0) }
          });
        } catch {}
        // #endregion
        try {
          req.respond({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ data: {} })
          });
          return;
        } catch {}
        return safeContinue(req);
      } catch {
        return safeContinue(req);
      }
    });
  } catch {}
}

// —————— NOVA FUNÇÃO: Abertura robusta da página de criação com retries ——————
async function openCreateItemPageRobust(browser, nome, coords, baseAttId) {
  return await connectLane.withHeavyNav({ kind: 'robe_create', nome }, async () => {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let p = null;
    let gatewayResolved = null;
    try {
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_robe_open_create_attempt', nome: String(nome || ''), attempt: Number(attempt || 0), baseAttId: String(baseAttId || '') }); } catch {}
      // #endregion
      // SUPRESSOR para o killer de about:blank durante patch+goto (20s de guarda)
      armBlankSuppress(browser, nome, 20_000);

      p = await newPageDaConta(browser, nome, { source: 'robe_create' });
      await ensureXPathPolyfill(p);
      try {
        const manifest = await manifestStore.read(nome);
        gatewayResolved = gatewayProxy.resolveProxyForProfile({ profileName: nome, manifest });
        if (gatewayProxy.isStrictProxyRequired() && (!gatewayResolved || gatewayResolved.enabled !== true)) {
          const reason = String(gatewayResolved && gatewayResolved.reason || "proxy_unresolved").trim() || "proxy_unresolved";
          throw new Error(`gateway_proxy_required:${reason}`);
        }
        try {
          const slot = gatewayResolved && gatewayResolved.slot ? gatewayResolved.slot : null;
          provisionAudit.append({
            ts: Date.now(),
            event: 'dbg_robe_open_create_proxy_resolved',
            nome: String(nome || ''),
            attempt: Number(attempt || 0),
            slotId: slot ? String(slot.slotId || '') : null,
            zone: slot ? String(slot.zone || '') : null,
            ipCurrent: slot ? String(slot.ipCurrent || '') : null
          });
        } catch {}
      } catch (e) {
        const em = String((e && e.message) || e || '');
        if (/gateway_proxy_required:/i.test(em)) throw e;
      }
      stepLog.appendJSONL(nome, 'robe', { attempt: baseAttId, step: 'goto_create', try: attempt });
      await p.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await captureCreatePageVitals(p, nome, baseAttId, `open_create_attempt_${attempt}_after_goto`);
      // MKT Desativado (URL-gated create) — antes de LR/compose
      // Contrato: fecha aba create (economia) → throw → worker marca pill + humano na aba 0.
      try {
        const md = await detectMarketplaceDisabled(p).catch(() => ({ disabled: false }));
        if (md && md.disabled === true) {
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'dbg_robe_open_create_marketplace_disabled',
              nome: String(nome || ''),
              attempt: Number(attempt || 0),
              reason: String(md.reason || ''),
              url: (typeof p.url === 'function') ? String(p.url() || '') : '',
              closeCreateTab: true
            });
          } catch {}
          try { await safeClosePage(p); } catch {}
          throw makeRobeMarketplaceDisabledError(md);
        }
      } catch (e) {
        if (e && e.ROBE_MARKETPLACE_DISABLED === true) throw e;
      }
      // Guardrail: se create/item redirecionar para fluxo de login, sinalizar erro semântico de Robe.
      try {
        const lrNow = await detectLoginRequired(p).catch(() => ({ loginRequired: false }));
        if (lrNow && lrNow.loginRequired === true) {
          const rr = String((lrNow && lrNow.reason) || '').toLowerCase();
          if (rr === 'probe_failed' || rr.startsWith('probe_failed')) {
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'dbg_robe_open_create_probe_failed_retry',
                nome: String(nome || ''),
                attempt: Number(attempt || 0),
                reason: String(lrNow.reason || ''),
                source: String(lrNow.domain || ''),
                url: (typeof p.url === 'function') ? String(p.url() || '') : ''
              });
            } catch {}
            if (attempt < 3) throw makeRobeProbeFailedError('open_create_retry');
            throw makeRobeProbeFailedError('open_create_abort');
          }
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'dbg_robe_open_create_login_required',
              nome: String(nome || ''),
              attempt: Number(attempt || 0),
              reason: String(lrNow.reason || ''),
              source: String(lrNow.domain || ''),
              url: (typeof p.url === 'function') ? String(p.url() || '') : ''
            });
          } catch {}
          throw makeRobeLoginRequiredError(lrNow);
        }
      } catch (e) {
        if (e && (e.ROBE_LOGIN_REQUIRED === true || e.ROBE_PROBE_FAILED === true)) throw e;
      }
      // Create já em URL real: libera suppress para o killer limpar órfãs sem esperar fim do Robe.
      clearBlankSuppress(browser, nome);
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_robe_open_create_success', nome: String(nome || ''), attempt: Number(attempt || 0), url: (typeof p.url === 'function') ? String(p.url() || '') : '' }); } catch {}
      // #endregion
      return p; // sucesso
    } catch (e) {
      // MKT: aba create já fechada acima (ou fecha aqui se sobrou). Login: mantém aba p/ remediação.
      if (e && e.ROBE_MARKETPLACE_DISABLED === true) {
        try { await safeClosePage(p, { nome, reason: 'open_create_mkt_disabled' }); } catch {}
        clearBlankSuppress(browser, nome);
        try { await sweepAboutBlankPages(browser, { nome }); } catch {}
        throw e;
      }
      if (e && e.ROBE_LOGIN_REQUIRED === true) {
        throw e;
      }
      lastError = e;
      const msg = (e && e.message) ? e.message : String(e);
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_robe_open_create_error', nome: String(nome || ''), attempt: Number(attempt || 0), error: String(msg || '') }); } catch {}
      // #endregion
      try { await safeClosePage(p, { nome, reason: 'open_create_retry_close' }); } catch {}
      // Em falha desta tentativa, libera suppress cedo para o killer poder limpar residual.
      clearBlankSuppress(browser, nome);
      try { await sweepAboutBlankPages(browser, { nome }); } catch {}
      if (isChromeProtocolSickError(msg)) {
        try { e.CHROME_SICK = true; } catch {}
        lastError = e;
        break;
      }
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|Navigation timeout|timed out|Network\.enable|Protocol error/i.test(msg)) {
        try {
          const sid = String(gatewayResolved && gatewayResolved.slot && gatewayResolved.slot.slotId || '').trim();
          if (gatewayResolved && gatewayResolved.enabled === true) {
            await gatewayProxy.reportProxyIssue({
              resolved: gatewayResolved,
              reason: 'robe_open_create_tunnel_failed',
              context: {
                stage: 'open_create',
                attempt: Number(attempt || 0),
                slotId: sid || null,
                error: String(msg || '').slice(0, 220)
              }
            });
          }
        } catch {}
        if (attempt < 3) {
          // Reativa suppress só para a próxima tentativa (goto create)
          armBlankSuppress(browser, nome, 20_000);
          await new Promise(r => setTimeout(r, 600 * attempt));
          continue;
        }
      }
      if (e && e.ROBE_PROBE_FAILED === true) {
        armBlankSuppress(browser, nome, 20_000);
        await new Promise(r => setTimeout(r, 350));
        continue; // retry da ação sem classificar como login_required
      }
      if (/detached|Target closed|Execution context was destroyed|Protocol error.*Target closed/i.test(msg)) {
        armBlankSuppress(browser, nome, 20_000);
        await new Promise(r => setTimeout(r, 300));
        continue; // retry
      }
      throw e;
    }
  }
  clearBlankSuppress(browser, nome);
  try { await sweepAboutBlankPages(browser, { nome }); } catch {}
  stepLog.appendJSONL(nome, 'robe', { attempt: baseAttId, step: 'goto_create_fail', err: (lastError && lastError.message) || String(lastError) });
  if (lastError && lastError.CHROME_SICK === true) throw lastError;
  throw new Error('nav_create_timeout');
  });
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
    await connectLane.withHeavyNav({ kind: 'robe_verify_selling_goto' }, async () => {
      await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 45000 });
    });
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
 * - Cooldown padrão 25–50min após sucesso ou erro; nada no abort por cooldown. NUNCA penalidade/backoff especial.
 * - Pós-publicação: se detectar “painel/listagem” fecha imediatamente; senão fecha em até 3s (sem popup).
 *   Se houver popup, aceita e espera ~2.5s, depois fecha.
 * - Minimização suave apenas desta aba (após anti-detect).
 */
async function startRobe(browser, nome, robePauseMs = 0, workingNames = [], photoDeletePolicy = 'after_all_working_posted') {
  let limitPostingHit = false;
  let page = null;
  let published = false;
  let sawBeforeUnloadDialog = false;
  let abortedByCooldown = false;
  let cooldownApplied = false; // controla se o cooldown já foi aplicado no catch
  // login_required: preserva aba create p/ remediação.
  // MKT Desativado: FECHA aba create (economia) e sobe throw → humano na aba 0.
  let preserveCreatePageForHuman = false;
  let marketplaceDisabledAbort = false;
  let fotoNome = null;
  let fotoPath = null;
  let fotoUploaded = false;
  let cidadePerfil = null; // ADEQUAÇÃO: tornar visível no catch
  let localUsada = null;   // ADEQUAÇÃO: tornar visível no catch

  // V2: cooldown preferencial vem do worker (sessão/lote) em robePauseMs.
  // Fallback legado permanece para segurança em caso de ausência do plano.
  const robePauseMsSafe = (() => {
    const n = Number(robePauseMs || 0);
    if (!Number.isFinite(n)) return 0;
    if (n < 15_000) return 0;
    if (n > (6 * 60 * 60 * 1000)) return 0;
    return Math.floor(n);
  })();

  // Cooldown padrão: após post/sessão, usa robePauseMsSafe; fallback 25–50min.
  const stepLogArr = [];

  const attId = stepLog.attemptId();
  stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'start', robePauseMs });
  // #region agent log
  try { provisionAudit.append({ ts: Date.now(), event: 'dbg_robe_start_entry', nome: String(nome || ''), attId: String(attId || ''), robePauseMs: Number(robePauseMs || 0) }); } catch {}
  // #endregion

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
    const coords = resolvePatchCoordsForProfile(nome, manifest || {});
    // Pré-seleciona foto antes de abrir/create para reduzir janela de degradação entre recovery e upload.
    // V3 PMG: consome slot {city,size} ANTES da foto (pasta Desktop/fotos/{p,m,g}).
    let robeWorkModeEarly = 'v1';
    try {
      const cfgEarly = serverConfig.readServerConfigEffective();
      robeWorkModeEarly = String(cfgEarly && cfgEarly.robe && cfgEarly.robe.workMode || 'v1').trim().toLowerCase();
    } catch {}
    let postingSize = null;
    if (robeWorkModeEarly === 'v3_pmg') {
      try {
        const slot = await pickPostingSlotForRunV2();
        cidadePerfil = slot && slot.city ? String(slot.city) : null;
        postingSize = slot && slot.size ? String(slot.size).toUpperCase() : null;
        if (!cidadePerfil || !postingSize) throw new Error('robe_v3_slot_unavailable');
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'posting_slot_selected_v3',
          city: cidadePerfil,
          size: postingSize
        });
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : String(e);
        stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'posting_slot_pick_failed', error: msg });
        throw new Error(`robe_v3_city_unavailable:${msg}`);
      }
    }
    const photoPickStartedAt = Date.now();
    let pick = await fotos.pickPhotoForAccount(nome, workingNames, postingSize ? { size: postingSize } : undefined);
    // Auto-heal: se a conta entrou em "sem foto" apesar do pool existir, limpar histórico dela no índice e tentar 1x.
    // Isso evita travar operação por inconsistência do registry (ex.: consumo indevido por falhas antigas).
    if (!pick.ok && pick.error === 'no-photo-available') {
      try {
        const heal = await fotos.clearAccountHistory(nome).catch(() => null);
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'dbg_robe_no_photo_auto_heal',
            nome: String(nome || ''),
            attId: String(attId || ''),
            heal
          });
        } catch {}
      } catch {}
      pick = await fotos.pickPhotoForAccount(nome, workingNames, postingSize ? { size: postingSize } : undefined);
    }
    if (!pick.ok) {
      const reason = pick.error || 'no-photo-available';
      throw new Error(`Sem foto disponível para esta conta (${reason}).`);
    }
    fotoPath = pick.absPath;
    fotoNome = pick.file;
    // #region agent log
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'dbg_robe_photo_prepicked',
        nome: String(nome || ''),
        attId: String(attId || ''),
        file: String(fotoNome || ''),
        requestedSize: postingSize || null,
        usedScope: pick.usedScope || null,
        fallback: !!pick.fallback,
        durMs: Number(Date.now() - photoPickStartedAt)
      });
    } catch {}
    // #endregion
    if (postingSize && pick.fallback) {
      try {
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'photo_fallback_used',
          requestedSize: postingSize,
          usedScope: pick.usedScope || null,
          file: fotoNome
        });
      } catch {}
    }

    page = await openCreateItemPageRobust(browser, nome, coords, attId);
    await installCreatePageGraphqlRateGuard(page, nome, attId);
    installCreatePageForensics(page, nome, attId);
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
      try {
        await connectLane.withHeavyNav({ kind: 'robe_create_body_reload', nome }, async () => {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
        });
      } catch {}
      return await page.waitForFunction(() => !!(document && document.body), { timeout: 5000 }).catch(()=>false) || false;
    };
    const hasBody = await waitBody();
    if (!hasBody) throw new Error('create_body_not_available');

    // MKT Desativado (após body) — permanente, não confundir com "Limite atingido"
    // Fecha aba 1 create → throw → worker invoca humano na aba 0.
    try {
      const md = await detectMarketplaceDisabled(page).catch(() => ({ disabled: false }));
      if (md && md.disabled === true) {
        logger.warn('[ROBE] Marketplace desativado detectado — fecha create + humano aba0', { nome, attId });
        try { await safeClosePage(page); } catch {}
        page = null;
        throw makeRobeMarketplaceDisabledError(md);
      }
    } catch (e) {
      if (e && e.ROBE_MARKETPLACE_DISABLED === true) throw e;
    }

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
    await captureCreatePageVitals(page, nome, attId, `after_ready_fastlane_${readyFast ? 'ok' : 'fallback'}`);
    let vitals = await readCreatePageVitals(page);
    if (isCreateFormDegraded(vitals)) {
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_create_page_degraded_detected', nome: String(nome || ''), attId: String(attId || ''), vitals }); } catch {}
      // #endregion
      for (let recoverAttempt = 1; recoverAttempt <= 2; recoverAttempt++) {
        const rl = page && page.__ctMarketplaceComposerRateLimited ? page.__ctMarketplaceComposerRateLimited : null;
        if (rl && Number(rl.ts || 0) > 0) {
          // #region agent log
          try { provisionAudit.append({ ts: Date.now(), event: 'dbg_create_page_recover_skipped_rate_limit', nome: String(nome || ''), attId: String(attId || ''), recoverAttempt: Number(recoverAttempt || 0), rateLimit: rl }); } catch {}
          // #endregion
          break;
        }
        try {
          await connectLane.withHeavyNav({ kind: 'robe_recover_create_goto', nome }, async () => {
            await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 });
          });
        } catch {}
        await waitForCreateItemReady(page, { timeout: 5000 }).catch(()=>false);
        await page.waitForSelector('input[type="file"][accept*="image"], input[type="file"]', { timeout: 5000 }).catch(()=>{});
        await captureCreatePageVitals(page, nome, attId, `recover_create_form_attempt_${recoverAttempt}`);
        vitals = await readCreatePageVitals(page);
        if (!isCreateFormDegraded(vitals)) break;
      }
      const rlAfter = page && page.__ctMarketplaceComposerRateLimited ? page.__ctMarketplaceComposerRateLimited : null;
      if (isCreateFormDegraded(vitals) && rlAfter && Number(rlAfter.ts || 0) > 0) {
        throw new Error(`${MARKETPLACE_RATE_LIMIT_ERR}: ${String((rlAfter && rlAfter.message) || '').slice(0, 200)}`);
      }
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

    const composePlan = createComposeTimingPlan();
    if (composePlan && composePlan.enabled) {
      try {
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'humanize_compose_plan',
          totalTargetMs: composePlan.totalTargetMs,
          phaseSlotsMs: composePlan.slots
        });
      } catch {}
      markComposeStart(composePlan);
    }

    // Upload - procurar no documento, shadow DOM e frames; se necessário, acionar seletor de fotos.
    // Se a tela degradar nesse ponto (após fastlane), recarrega create/item 1x para retentativa real.
    let inputFoto = null;
    for (let uploadAttempt = 1; uploadAttempt <= 3 && !inputFoto; uploadAttempt++) {
      inputFoto = await findFileInputEverywhere(page);
      if (inputFoto) break;
      await captureCreatePageVitals(page, nome, attId, 'before_trigger_photo_picker');
      await triggerPhotoPickerEverywhere(page);
      await page.waitForFunction(() => {
        const pick = (root) => {
          if (!root) return false;
          const direct = root.querySelector && root.querySelector('input[type="file"][accept*="image"], input[type="file"]');
          if (direct) return true;
          const queue = [];
          if (root.children && root.children.length) {
            for (const el of root.children) queue.push(el);
          } else if (root.documentElement) {
            queue.push(root.documentElement);
          }
          while (queue.length) {
            const el = queue.shift();
            if (!el) continue;
            if (el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file') return true;
            if (el.shadowRoot && pick(el.shadowRoot)) return true;
            if (el.children && el.children.length) {
              for (const c of el.children) queue.push(c);
            }
          }
          return false;
        };
        return pick(document);
      }, { timeout: 8000 }).catch(()=>{});
      inputFoto = await findFileInputEverywhere(page);
      if (inputFoto) break;

      await captureCreatePageVitals(page, nome, attId, `upload_input_not_found_attempt_${uploadAttempt}`);
      const uploadVitals = await readCreatePageVitals(page);
      const degradedAtUpload = isCreateFormDegraded(uploadVitals);
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_robe_upload_recover_probe', nome: String(nome || ''), attId: String(attId || ''), uploadAttempt: Number(uploadAttempt || 0), degradedAtUpload: !!degradedAtUpload, textLen: Number((uploadVitals && uploadVitals.textLen) || 0), fileInputs: Number((uploadVitals && uploadVitals.fileInputs) || 0) }); } catch {}
      // #endregion

      const rl = page && page.__ctMarketplaceComposerRateLimited ? page.__ctMarketplaceComposerRateLimited : null;
      if (!degradedAtUpload || uploadAttempt >= 3 || (rl && Number(rl.ts || 0) > 0)) break;

      try {
        await connectLane.withHeavyNav({ kind: 'robe_upload_recover_create_goto', nome }, async () => {
          await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 });
        });
      } catch {}
      await waitForCreateItemReady(page, { timeout: 7000 }).catch(()=>false);
      await page.waitForSelector('input[type="file"][accept*="image"], input[type="file"]', { timeout: 6000 }).catch(()=>{});
      await captureCreatePageVitals(page, nome, attId, `upload_recover_create_attempt_${uploadAttempt}`);
    }
    if (!inputFoto) {
      await captureCreatePageVitals(page, nome, attId, 'upload_input_not_found_final');
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_robe_upload_input_not_found_after_trigger', nome: String(nome || ''), attId: String(attId || ''), url: (typeof page.url === 'function') ? String(page.url() || '') : '' }); } catch {}
      // #endregion
      // Antes de falhar, última checagem de bloqueio
      const late = await detectLimitOverlayEverywhere(page, 1500).catch(()=>null);
      if (late && late.blocked) {
        await applyLimitPostingAndAbort({ page, nome, attId, where: 'no_file_input_overlay', overlaySnapshot: late });
        return; // aborta por limit_posting como deve
      }
      // Última checagem semântica: ausência de input também pode ser "login_required" no fluxo do Robe.
      try {
        const lrNow = await detectLoginRequired(page).catch(() => ({ loginRequired: false }));
        if (lrNow && lrNow.loginRequired === true) {
          const rr = String((lrNow && lrNow.reason) || '').toLowerCase();
          if (rr === 'probe_failed' || rr.startsWith('probe_failed')) {
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'dbg_robe_upload_probe_failed_retry',
                nome: String(nome || ''),
                attId: String(attId || ''),
                reason: String(lrNow.reason || ''),
                source: String(lrNow.domain || ''),
                url: (typeof page.url === 'function') ? String(page.url() || '') : ''
              });
            } catch {}
            throw makeRobeProbeFailedError('upload_input_probe_failed');
          }
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'dbg_robe_upload_login_required_detected',
              nome: String(nome || ''),
              attId: String(attId || ''),
              reason: String(lrNow.reason || ''),
              source: String(lrNow.domain || ''),
              url: (typeof page.url === 'function') ? String(page.url() || '') : ''
            });
          } catch {}
          throw makeRobeLoginRequiredError(lrNow);
        }
      } catch (e) {
        if (e && (e.ROBE_LOGIN_REQUIRED === true || e.ROBE_PROBE_FAILED === true)) throw e;
      }
      throw new Error('Campo para upload de foto não localizado (frames varridos).');
    }
    await waitBeforeComposeAction(composePlan, 'before_upload', { nome, attId });
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'upload_start', file: fotoNome });
    await inputFoto.uploadFile(fotoPath);
    fotoUploaded = true;
    await sleep(jitter(250, 450));

    // TÍTULO
    const titulo = pickRandomItemTitulo();
    await waitBeforeComposeAction(composePlan, 'before_title', { nome, attId });
    await preencherTitulo(page, titulo);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'title_ok', value: titulo });
    await sleep(jitter(120, 220));

    // PREÇO
    await waitBeforeComposeAction(composePlan, 'before_price', { nome, attId });
    await preencherPreco(page);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'price_ok', value: '0' });

    // CATEGORIA
    await waitBeforeComposeAction(composePlan, 'before_category', { nome, attId });
    const cat = await selecionarCategoriaMoveis(page);
    stepLog.appendJSONL(nome, 'robe', {
      attempt: attId,
      step: 'category_ok',
      value: (cat && cat.value) ? cat.value : 'unknown',
      method: (cat && cat.method) ? cat.method : 'unknown'
    });

    // CONDIÇÃO
    await waitBeforeComposeAction(composePlan, 'before_condition', { nome, attId });
    const cond = await selecionarCondicaoNovo(page);
    stepLog.appendJSONL(nome, 'robe', {
      attempt: attId,
      step: 'condition_ok',
      value: (cond && cond.value) ? cond.value : 'unknown',
      method: (cond && cond.method) ? cond.method : 'unknown'
    });

    // DESCRIÇÃO removida por regra operacional: publicar item sem descrição.
    stepLog.appendJSONL(nome, 'robe', {
      attempt: attId,
      step: 'description_skipped',
      reason: 'disabled_by_runtime_rule'
    });

    // LOCALIZAÇÃO
    let robeWorkMode = 'v1';
    try {
      const cfgNow = serverConfig.readServerConfigEffective();
      robeWorkMode = String(cfgNow && cfgNow.robe && cfgNow.robe.workMode || 'v1').trim().toLowerCase();
    } catch {}
    let cityPickErr = null;
    // V3 já consumiu o slot no início (antes da foto) — não puxar de novo da fila.
    if (robeWorkMode !== 'v3_pmg' || !cidadePerfil) {
      try {
        cidadePerfil = await pickPostingCityForRun(nome);
      } catch (e) {
        cityPickErr = (e && e.message) ? String(e.message) : String(e);
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'posting_city_pick_failed',
          error: cityPickErr
        });
      }
    }
    if (!cidadePerfil && (robeWorkMode === 'v2_auto' || robeWorkMode === 'v3_pmg')) {
      throw new Error(
        `${robeWorkMode === 'v3_pmg' ? 'robe_v3_city_unavailable' : 'robe_v2_city_unavailable'}${cityPickErr ? `:${cityPickErr}` : ''}`
      );
    }
    if (!cidadePerfil) cidadePerfil = manifest.cidade || manifest.localizacao || manifest['localização'] || 'São Paulo';
    stepLog.appendJSONL(nome, 'robe', {
      attempt: attId,
      step: 'posting_city_selected',
      value: cidadePerfil,
      size: postingSize || null
    });
    await waitBeforeComposeAction(composePlan, 'before_location', { nome, attId });
    localUsada = await preencherLocalizacao(page, cidadePerfil);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'location_ok', value: localUsada });
    await waitBeforeComposeAction(composePlan, 'before_publish', { nome, attId });

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

      // Publicado: mantém a aba aberta para pós-publish (upsell + ID doc 1x/dia).
      if (pubRes && pubRes.ok) {
        published = true;
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

    // Pós-publish: dismiss upsell + verificação ID documento (1x/dia). Nunca invalida publish_ok.
    if (page) {
      try {
        const idRes = await robePostPublishId.runRobeAutoId({
          page,
          nome,
          titulo,
          deadlineAt: Date.now() + (robePostPublishId.BUDGET_TOTAL_MS || 420000)
        });
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'post_publish_id',
          ok: !!(idRes && idRes.ok),
          skipped: !!(idRes && idRes.skipped),
          marked: !!(idRes && idRes.marked),
          reason: (idRes && (idRes.reason || idRes.error)) || null
        });
      } catch (eId) {
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'post_publish_id_err',
          err: String((eId && eId.message) || eId).slice(0, 220)
        });
      }
      // Pós-ID: renovação desacoplada (se due e ainda não renovou hoje). Nunca invalida publish_ok.
      try {
        await robePostPublishRenew.runRobeAutoRenewSafe({
          page,
          nome,
          attId,
          deadlineAt: Date.now() + (robePostPublishRenew.BUDGET_TOTAL_MS || (35 * 60 * 1000))
        });
      } catch {}
    } else {
      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'post_publish_id', skipped: true, reason: 'page_gone' });
      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'post_publish_renew', skipped: true, reason: 'page_gone' });
    }

    try { await safeClosePage(page); } catch {}
    page = null;

    // COMMIT no índice de fotos — somente após confirmação de publicação
    if (published) {
      try {
        if (fotoNome) {
          const allWorkingProfiles = Array.isArray(workingNames) ? workingNames.slice() : [];
          await fotos.markPostedAndMaybeDelete(nome, fotoNome, allWorkingProfiles, photoDeletePolicy);
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

  // Contrato atual (enterprise):
  // - "postedBy" só é commitado quando há publicação confirmada (published=true).
  // - em falha/abort sem publicação, apenas liberamos a reserva para não travar o pool.
  // Isso evita "esgotar" fotos por retentativas/erros técnicos.
  } catch (e) {
    logger.error('Erro em fluxo Robe', { nome }, e);
    if (e && e.LIMIT_POSTING === true) {
      limitPostingHit = true;
      // Nada mais além de já ter pausado/logado/fechado
      return { ok: false, error: LIMIT_POSTING_REASON, limitPosting: true };
    }
    // Contrato ops: MKT / login_required sobem pro worker. NÃO engolir como robe_error.
    if (e && e.ROBE_MARKETPLACE_DISABLED === true) {
      marketplaceDisabledAbort = true;
      try { if (page) await safeClosePage(page); } catch {}
      page = null;
      try {
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'marketplace_disabled_close_create',
          reason: String((e && e.message) || '').slice(0, 220)
        });
      } catch {}
      throw e;
    }
    if (e && e.ROBE_LOGIN_REQUIRED === true) {
      preserveCreatePageForHuman = true;
      try {
        stepLog.appendJSONL(nome, 'robe', {
          attempt: attId,
          step: 'login_required',
          reason: String((e && e.message) || '').slice(0, 220)
        });
      } catch {}
      throw e;
    }

    const errMsg = (e && e.message) ? e.message : String(e);
    stepLogArr.push(`[${nome}] ERRO: ${errMsg}`);
    stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'error', err: (e && e.message) || String(e) });

    // Tipo de issue (no-photo vs erro geral)
    const isNoPhoto = /sem foto dispon[ií]vel/i.test(errMsg);
    const isMarketplaceRateLimit = errMsg.includes(MARKETPLACE_RATE_LIMIT_ERR) || /1675004/.test(errMsg);
    const issueType = isNoPhoto ? 'robe_no_photo' : 'robe_error';

    // Registra issue (silencioso)
    try { await logIssue(nome, issueType, errMsg); } catch {}

    // PATCH MILITAR — Se houve limit_posting neste ciclo, retorna imediatamente sem aplicar cooldown curto.
    if (limitPostingHit) return { ok:false, error:LIMIT_POSTING_REASON, limitPosting:true };

    // Cooldown: sucesso usa robePauseMs (90–150 do servidor). Rate-limit curto. Chrome doente: settle curto + flag para curar/reabrir. Outro erro técnico: mesmo relógio do servidor.
    try {
      if (isMarketplaceRateLimit) {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          if (m.robePauseReason === LIMIT_POSTING_REASON) delete m.robePauseReason;
          return m;
        });
      }
      const isChromeSick = (e && e.CHROME_SICK === true) || isChromeProtocolSickError(errMsg);
      const pause = isMarketplaceRateLimit
        ? (2 + Math.floor(Math.random() * 4)) * 60 * 1000
        : isChromeSick
          ? (2 + Math.floor(Math.random() * 3)) * 60 * 1000
          : (robePauseMsSafe > 0 ? robePauseMsSafe : ((25 + Math.floor(Math.random() * 26)) * 60 * 1000));
      await manifestStore.update(nome, m => {
        m.robeCooldownUntil = Date.now() + pause;
        return m;
      });
      cooldownApplied = true;
      try {
        const reason = isMarketplaceRateLimit
          ? 'rate_limit_curto_retry'
          : (isChromeSick ? 'chrome_sick_settle' : 'erro_tecnico_config');
        await logIssue(nome, 'robe_error', `Erro técnico (${reason}); cooldown ${Math.ceil(pause/60000)}min: ${errMsg}`);
      } catch {}
    } catch {}

    // Em falha: NÃO consumir foto como "postada". Apenas libera a reserva para evitar lock/stuck.
    // Se a foto foi realmente publicada, o commit ocorre no caminho de sucesso (published=true).
    // Se falhou após upload (fotoUploaded=true), permitir reuso é preferível a "esgotar" foto por conta por falhas técnicas.
    try {
      if (fotoNome) await fotos.releaseReservation(nome, fotoNome);
    } catch {}

    // ADEQUAÇÃO: "tentou ⇒ consumiu" para localização mesmo em erro
    try {
      if (localUsada) {
        await locais.confirmUsed(cidadePerfil, localUsada);
      }
    } catch {}

    return { ok: false, error: errMsg, retryable: isMarketplaceRateLimit, errorCode: isMarketplaceRateLimit ? MARKETPLACE_RATE_LIMIT_ERR : null, chromeSick: (e && e.CHROME_SICK === true) || isChromeProtocolSickError(errMsg), log: stepLogArr };

  } finally {
    // Sempre liberar a reserva quando não houve publicação confirmada.
    // (Isso evita que uma foto fique reservada indefinidamente para uma conta e bloqueie o pool para outras.)
    try {
      if (fotoNome && !published) await fotos.releaseReservation(nome, fotoNome);
    } catch {}

    // ABORTO ABSOLUTO: Não executa nada pós-fluxo ao detectar limit_posting
    if (limitPostingHit) {
      try { if (page) await safeClosePage(page, { nome, reason: 'limit_posting' }); } catch {}
      try { await sweepAboutBlankPages(browser, { nome }); } catch {}
      return { ok: false, error: LIMIT_POSTING_REASON, limitPosting: true };
    }

    // login_required: preserva aba create. MKT: create já fechada; sem cooldown técnico.
    if (preserveCreatePageForHuman) {
      try {
        stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'end_preserve_create_page', success: false });
      } catch {}
      // Preserva create, mas limpa about:blank extras.
      try { await sweepAboutBlankPages(browser, { keepPage: page, nome }); } catch {}
      logger.info(`[ROBE][startRobe] FIM: preserve_create_page (remediação)`, { nome });
    } else if (marketplaceDisabledAbort) {
      try { if (page) await safeClosePage(page, { nome, reason: 'marketplace_disabled' }); } catch {}
      page = null;
      try { await sweepAboutBlankPages(browser, { keepPage: null, nome }); } catch {}
      try {
        stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'end_marketplace_disabled', success: false });
      } catch {}
      logger.info(`[ROBE][startRobe] FIM: marketplace_disabled (create fechada → humano aba0)`, { nome });
    } else {
      // Cooldown padrão: Sempre após post (sucesso ou erro), aplica 25–50min. NUNCA penalidade/backoff especial.
      // Exceção: abortedByCooldown => não alterar (cooldown já estava ativo).
      try {
        if (!abortedByCooldown && !cooldownApplied && !limitPostingHit) {
          const pause = robePauseMsSafe > 0 ? robePauseMsSafe : ((25 + Math.floor(Math.random() * 26)) * 60 * 1000);
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
        try {
          await safeClosePage(page, { nome, reason: 'robe_end' });
          logger.info(`[ROBE] Aba fechada no finalmente`, { nome });
        } catch {}
      }
      // Varredura final anti-fantasma (retries de create que sobraram)
      try { await sweepAboutBlankPages(browser, { keepPage: null, nome }); } catch {}

      stepLog.appendJSONL(nome, 'robe', { attempt: attId, step: 'end', success: !!published });
      logger.info(`[ROBE][startRobe] FIM: ${published ? 'success' : 'fail'}`, { nome, published, logs: stepLogArr });
    }
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
  robeQueueFilter,
  robeV2WarmupNow,
  // Exportado para permitir que Robe de veículos consuma a fila V2/V3 também.
  pickPostingCityForRunV2,
  pickPostingSlotForRunV2,
  allocatePmgSlots,
  formatRobeQueueItemLabel
};
