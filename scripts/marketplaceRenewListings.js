'use strict';

/**
 * Motor único: renovar classificados no Marketplace Selling.
 * Usado pelo overlay (manual) e pela renovação pós-publicação do Robe (auto).
 *
 * Selectors por texto/aria-label normalizado — nunca classes efêmeras do Facebook.
 */

const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
const SCROLL_STOP_AGE_DAYS = 46;
const SCROLL_STEP_PX = 380;
const SCROLL_INTERVAL_MS = 900;
const SCROLL_STUCK_TICKS_LIMIT = 180;
const RENEW_SCREEN_WAIT_MS = 180000;
const ACTIONS_MENU_WAIT_MS = 120000;
const SELECT_ALL_WAIT_MS = 120000;
const NAV_TIMEOUT_MS = 120000;
const SETTLE_MS = 8000;
// Após confirmar que saiu da tela Renovar: hold no Selling antes de liberar close.
const POST_RENEW_HOLD_MS_MIN = 25000;
const POST_RENEW_HOLD_MS_MAX = 45000;
// Piso ABSOLUTO após clicar Renovar — nunca declarar "pronto" antes disso (UI pode mentir).
const POST_RENEW_MIN_PROCESS_BASE_MS = 30000;
const POST_RENEW_MIN_PROCESS_PER_ITEM_MS = 120;
const POST_RENEW_MIN_PROCESS_CAP_MS = 4 * 60 * 1000;
// Tela Renovar precisa ficar AUSENTE este tempo seguido (anti flicker / loading).
const POST_RENEW_DISMISS_STABLE_MS = 6000;
// Dialog/tela sumindo em <N após o clique = Cancelar/dismiss suspeito.
const POST_RENEW_TOO_FAST_MS = 8000;
// Teto de espera pela tela sumir (além do piso mínimo).
const POST_RENEW_PROCESS_BASE_MS = 240000;
const POST_RENEW_PROCESS_PER_ITEM_MS = 400;
const POST_RENEW_PROCESS_CAP_MS = 15 * 60 * 1000;
// Grace extra no worker antes do deactivate (renew-then-close) — rede lenta / muitos browsers.
const POST_RENEW_CLOSE_GRACE_MS_MIN = 12000;
const POST_RENEW_CLOSE_GRACE_MS_MAX = 20000;
// Tela Renovar: FB contabiliza devagar — nunca aceitar "ready" antes deste piso.
const RENEW_READY_MIN_ELAPSED_MS = 12000;
// Count+botão enabled precisa ficar estável este tempo (não sobe mais).
const RENEW_READY_STABLE_MS = 6000;
const MANAGE_MODE_WAIT_MS = 180000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function now() {
  return Date.now();
}

function randInt(min, max) {
  const a = Math.min(Number(min) || 0, Number(max) || 0);
  const b = Math.max(Number(min) || 0, Number(max) || 0);
  return a + Math.floor(Math.random() * (b - a + 1));
}

/** Pausa humana aleatória entre ações (anti-atropelo). */
async function humanPause(minMs, maxMs) {
  await sleep(randInt(minMs, maxMs));
}

function postRenewProcessTimeoutMs(expectedCount) {
  const n = Math.max(0, Number(expectedCount || 0) || 0);
  return Math.min(
    POST_RENEW_PROCESS_CAP_MS,
    POST_RENEW_PROCESS_BASE_MS + n * POST_RENEW_PROCESS_PER_ITEM_MS
  );
}

/** Tempo mínimo de parede após o clique — independente da UI. */
function postRenewMinProcessMs(expectedCount) {
  const n = Math.max(0, Number(expectedCount || 0) || 0);
  return Math.min(
    POST_RENEW_MIN_PROCESS_CAP_MS,
    POST_RENEW_MIN_PROCESS_BASE_MS + n * POST_RENEW_MIN_PROCESS_PER_ITEM_MS
  );
}

function normalizeTxt(s) {
  try {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return String(s || '').toLowerCase().trim();
  }
}

async function safeEvaluate(page, fn, ...args) {
  await require('./interactionLease').wait(page);
  try {
    return await page.evaluate(fn, ...args);
  } catch {
    return null;
  }
}

async function setOverlayHint(page, text) {
  if (!page) return;
  try {
    await page.evaluate((t) => {
      try {
        const host = document.getElementById('ct-human-overlay-host');
        const root = host && host.shadowRoot;
        const hint = root && root.getElementById('hint');
        if (hint) hint.textContent = String(t || '');
      } catch {}
    }, String(text || '').slice(0, 240));
  } catch {}
}

async function progress(page, onProgress, stage, message) {
  const msg = String(message || stage || '').slice(0, 240);
  try {
    if (typeof onProgress === 'function') onProgress({ stage: String(stage || ''), message: msg });
  } catch {}
  await setOverlayHint(page, msg);
}

/**
 * Clique por texto / aria-label (NFKD). Preferência: aria-label exact match → texto visível.
 */
async function clickByLabels(page, labels, { timeoutMs = 30000, exactOnly = false, excludeSubstrings = [] } = {}) {
  return require('./interactionReadiness').clickControl(page,labels,{timeoutMs,exact:exactOnly,excludeSubstrings});
}

async function findTextPresent(page, patterns) {
  const wanted = (Array.isArray(patterns) ? patterns : [patterns]).map((x) => normalizeTxt(x)).filter(Boolean);
  return await safeEvaluate(page, (wanted) => {
    const norm = (s) => {
      try {
        return String(s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      } catch {
        return String(s || '').toLowerCase().trim();
      }
    };
    let body = '';
    try {
      body = norm(document.body && (document.body.innerText || document.body.textContent) || '');
    } catch {
      body = '';
    }
    for (const w of wanted) {
      if (w && body.includes(w)) return { ok: true, hit: w };
    }
    return { ok: false };
  }, wanted);
}

async function labelPresent(page, labels, { requireEnabled = false, exactOnly = false } = {}) {
  const wanted = (Array.isArray(labels) ? labels : [labels]).map((x) => normalizeTxt(x)).filter(Boolean);
  if (!wanted.length) return false;
  const hit = await safeEvaluate(
    page,
    ({ wanted, requireEnabled, exactOnly }) => {
      const norm = (s) => {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
        } catch {
          return String(s || '').toLowerCase().trim();
        }
      };
      const matches = (txt) => {
        const n = norm(txt);
        if (!n) return false;
        if (exactOnly) return wanted.some((w) => n === w);
        return wanted.some((w) => n === w || n.includes(w));
      };
      const nodes = document.querySelectorAll(
        '[role="button"],[role="menuitem"],button,a[role="link"],div[role="button"],span[role="button"]'
      );
      for (const el of nodes) {
        if (!el) continue;
        let aria = '';
        let txt = '';
        try { aria = String(el.getAttribute('aria-label') || ''); } catch {}
        try { txt = String(el.innerText || el.textContent || '').slice(0, 200); } catch {}
        if (!matches(aria) && !matches(txt)) continue;
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        if (rect.width < 2 || rect.height < 2 || style.display === 'none' ||
            style.visibility === 'hidden' || Number(style.opacity) === 0 ||
            el.closest('[aria-hidden="true"],[inert]')) continue;

        if (requireEnabled) {
          const disabled =
            el.disabled === true || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
          if (disabled) continue;
        }
        return true;
      }
      return false;
    },
    { wanted, requireEnabled: !!requireEnabled, exactOnly: !!exactOnly }
  );
  return !!hit;
}

async function waitForLabel(page, labels, { timeoutMs = 30000, requireEnabled = false, exactOnly = false, pollMs = 700 } = {}) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    if (await labelPresent(page, labels, { requireEnabled, exactOnly })) return true;
    await sleep(pollMs);
  }
  return false;
}

async function ensureSelling(page, { onProgress } = {}) {
  await progress(page, onProgress, 'goto_selling', 'Abrindo Seus classificados (Selling)...');
  let onSelling = false;
  try {
    onSelling = await page.evaluate(
      () => /marketplace\/(you\/selling|you\/dashboard|profile)/.test(String(location.pathname || ''))
    );
  } catch {
    onSelling = false;
  }
  if (!onSelling) {
    const connectLane = require('./connectLane.js');
    await connectLane.withHeavyNav({ kind: 'renew_selling_goto' }, async () => {
      await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    });
  }
  // Espera readiness real: botão Gerenciar (ou já em manage mode com Selecionar tudo).
  const ready = await waitForLabel(
    page,
    ['Gerenciar classificados', 'Manage listings', 'Manage your listings', 'Selecionar tudo', 'Select all'],
    { timeoutMs: 120000, requireEnabled: false, pollMs: 800 }
  );
  if (!ready) throw Error('renew_selling_not_ready');
  const settled = await require('./interactionReadiness').waitControl(page,['Gerenciar classificados','Manage listings','Manage your listings','Selecionar tudo','Select all'],{timeoutMs:60000});
  if (!settled.ok) throw Error('renew_selling_not_stable');
  return true;
}

async function scrollToAgeThreshold(page, { onProgress, scrollStopAgeDays = SCROLL_STOP_AGE_DAYS, deadlineAt=0, isAborted=null, requireManageMode=false } = {}) {
  const ageDays = Math.max(1, Math.min(120, Math.floor(Number(scrollStopAgeDays) || SCROLL_STOP_AGE_DAYS) || SCROLL_STOP_AGE_DAYS));
  await progress(page, onProgress, 'scroll_down', `Rolando classificados até ${ageDays} dia(s)...`);
  const targetIso = (() => {
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const target = new Date(t0.getTime() - ageDays * 86400000);
    const y = target.getFullYear();
    const m = String(target.getMonth() + 1).padStart(2, '0');
    const d = String(target.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  })();

  let stuckTicks = 0;
  let lastTop = -1;
  for (let tick = 0; tick < SCROLL_STUCK_TICKS_LIMIT + 40; tick++) {
    if((isAborted&&isAborted())||(deadlineAt&&now()>=require('./carrierV2/clock').effective(deadlineAt)))return {ok:false,reason:'scroll_budget_exhausted'};
    if (requireManageMode && !await labelPresent(page, ['Selecionar tudo', 'Select all'], {exactOnly:true})) {
      const restored = await waitForLabel(page, ['Selecionar tudo', 'Select all'], {
        exactOnly:true, timeoutMs:require('./interactionBudget').timeout(page,30000)
      });
      if (!restored) return {ok:false,reason:'renew_manage_mode_lost'};
    }
    const snap = await safeEvaluate(
      page,
      ({ step, targetIso, SCROLL_STOP_AGE_DAYS }) => {
        const norm = (s) => {
          try {
            return String(s || '')
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase();
          } catch {
            return String(s || '').toLowerCase();
          }
        };
        const monthFromToken = (raw) => {
          const t = norm(raw).replace(/\.$/, '');
          const m = {
            janeiro: 1, jan: 1, january: 1,
            fevereiro: 2, fev: 2, february: 2, feb: 2,
            marco: 3, mar: 3, march: 3,
            abril: 4, abr: 4, april: 4, apr: 4,
            maio: 5, may: 5,
            junho: 6, jun: 6, june: 6,
            julho: 7, jul: 7, july: 7,
            agosto: 8, ago: 8, august: 8, aug: 8,
            setembro: 9, set: 9, sept: 9, september: 9,
            outubro: 10, out: 10, october: 10, oct: 10,
            novembro: 11, nov: 11, november: 11,
            dezembro: 12, dez: 12, december: 12, dec: 12
          };
          return Number(m[t] || 0) || 0;
        };
        const toDateSafe = (y, m, d) => {
          const yy = Number(y || 0);
          const mm = Number(m || 0);
          const dd = Number(d || 0);
          if (!yy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
          const dt = new Date(yy, mm - 1, dd);
          if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
          if (dt.getFullYear() !== yy || dt.getMonth() !== mm - 1 || dt.getDate() !== dd) return null;
          return new Date(yy, mm - 1, dd, 0, 0, 0, 0);
        };
        const extractDates = (txt) => {
          const n = norm(txt);
          const out = [];
          const re1 = /(?:anunciado em|listed on|posted on)\s+(\d{1,2})\s+de\s+([a-z\.]+)(?:\s+de\s+(\d{4}))?/g;
          let m;
          while ((m = re1.exec(n))) {
            const d = Number(m[1]);
            const mo = monthFromToken(m[2]);
            const y = m[3] ? Number(m[3]) : new Date().getFullYear();
            const dt = toDateSafe(y, mo, d);
            if (dt) out.push(dt.getTime());
          }
          const re2 = /(?:anunciado em|listed on|posted on)\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;
          while ((m = re2.exec(n))) {
            const d = Number(m[1]);
            const mo = Number(m[2]);
            let y = m[3] ? Number(m[3]) : new Date().getFullYear();
            if (y < 100) y += 2000;
            const dt = toDateSafe(y, mo, d);
            if (dt) out.push(dt.getTime());
          }
          return out;
        };
        const resolveTarget = () => {
          try {
            const primary = [document.scrollingElement, document.documentElement, document.body].find(
              (el) => el && Number(el.scrollHeight || 0) - Number(el.clientHeight || 0) > 20
            );
            if (primary) return primary;
            let best = null;
            let bestDelta = 0;
            const nodes = document.querySelectorAll('main, div, section');
            for (const el of nodes) {
              if (!el || !el.getBoundingClientRect) continue;
              const st = window.getComputedStyle(el);
              const oy = String((st && st.overflowY) || '').toLowerCase();
              if (oy !== 'auto' && oy !== 'scroll') continue;
              const delta = Number(el.scrollHeight || 0) - Number(el.clientHeight || 0);
              if (delta > bestDelta) {
                bestDelta = delta;
                best = el;
              }
            }
            return best || document.scrollingElement || document.documentElement || document.body;
          } catch {
            return document.scrollingElement || document.documentElement || document.body;
          }
        };
        const target = resolveTarget();
        if (!target) return { moved: false, top: 0, ageHit: false };
        const before = Number(target.scrollTop || 0);
        try {
          if (typeof target.scrollBy === 'function') target.scrollBy(0, step);
          else target.scrollTop = before + step;
        } catch {}
        const after = Number(target.scrollTop || 0);
        let oldestTs = null;
        try {
          const nodes = document.querySelectorAll(
            'span, article, [role="article"], div[role="button"], a[role="button"], a[href*="/marketplace"]'
          );
          let sampled = 0;
          for (const el of nodes) {
            if (!el || sampled >= 260) break;
            let txt = '';
            try {
              txt = String(el.innerText || el.textContent || '');
            } catch {}
            if (!txt || txt.length < 12) continue;
            if (!/(anunciado em|listed on|posted on)/i.test(norm(txt))) continue;
            sampled += 1;
            for (const ts of extractDates(txt)) {
              if (oldestTs == null || ts < oldestTs) oldestTs = ts;
            }
          }
        } catch {}
        let ageHit = false;
        if (oldestTs != null && targetIso) {
          const targetDate = new Date(`${targetIso}T00:00:00`);
          if (!Number.isNaN(targetDate.getTime()) && oldestTs <= targetDate.getTime()) ageHit = true;
        }
        const loading=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&!el.closest('[aria-hidden="true"]')});
        return { moved: after !== before, top: after, ageHit, oldestTs, targetIso, loading };
      },
      { step: SCROLL_STEP_PX, targetIso, SCROLL_STOP_AGE_DAYS }
    );

    if(!snap||snap.loading){await sleep(SCROLL_INTERVAL_MS);continue;}
    if (snap && snap.ageHit) {
      await progress(page, onProgress, 'scroll_done', 'Scroll concluído (data alvo alcançada).');
      return { ok: true, reason: 'age_threshold_reached' };
    }
    if (snap && snap.moved) {
      stuckTicks = 0;
      lastTop = Number(snap.top || 0);
    } else {
      stuckTicks += 1;
      if (stuckTicks >= SCROLL_STUCK_TICKS_LIMIT) {
        await progress(page, onProgress, 'scroll_done', 'Scroll parado: fim da lista ou sem rolagem.');
        return { ok: true, reason: 'stuck' };
      }
    }
    if (tick % 8 === 0) {
      await progress(
        page,
        onProgress,
        'scroll_down',
        `Rolando classificados... (tick ${tick}, top ${lastTop})`
      );
    }
    await sleep(SCROLL_INTERVAL_MS);
  }
  return { ok: false, reason: 'listing_scroll_budget_exhausted' };
}

async function scrollToTop(page) {
  const t0 = now();
  while (now() - t0 < 20000) {
    const top = await safeEvaluate(page, () => {
      try {
        window.scrollTo(0, 0);
        const main =
          document.querySelector('[role="main"]') ||
          document.scrollingElement ||
          document.documentElement ||
          document.body;
        if (main && typeof main.scrollTo === 'function') main.scrollTo(0, 0);
        if (main) main.scrollTop = 0;
        const se = document.scrollingElement || document.documentElement;
        return Math.min(
          Number((main && main.scrollTop) || 0),
          Number((se && se.scrollTop) || 0),
          Number(window.scrollY || 0)
        );
      } catch {
        return 0;
      }
    });
    if (Number(top || 0) <= 5) {
      await sleep(800);
      return { ok: true, top: Number(top || 0) };
    }
    await sleep(500);
  }
  await sleep(1000);
  return { ok: true, top: null, reason: 'scroll_top_budget' };
}

/** Aguarda a tela de renovação e o botão final disponível, sem depender de contagem. */
async function waitRenewScreenStable(page, { onProgress, timeoutMs = RENEW_SCREEN_WAIT_MS } = {}) {
  await progress(page, onProgress, 'renew_screen', 'Aguardando botão Renovar...');
  const t0 = now();
  let readySince = null, signature=null;
  let lastSnapshot = null;
  while (now() - t0 < timeoutMs) {
    const snap = await safeEvaluate(page, () => {
      const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
      const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>2&&r.height>2&&s.display!=='none'&&s.visibility!=='hidden'&&!el.closest('[aria-hidden="true"]')};
      const isRenew=text=>/renovar classificados|renew listings|renew your listings/.test(norm(text));
      const root=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')].find(el=>visible(el)&&isRenew(el.innerText))||document.querySelector('[role="main"]')||document.body;
      const text = norm(root && (root.innerText || root.textContent));
      const hasHeader = text.includes('renovar classificados') || text.includes('renew listings') || text.includes('renew your listings');
      let renewBtn = null;
      for (const el of root.querySelectorAll('[role="button"],button')) {
        const aria = norm(el.getAttribute('aria-label'));
        const label = norm(el.innerText || el.textContent);
        if (!['renovar', 'renew'].includes(aria) && !['renovar', 'renew'].includes(label)) continue;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width <= 2 || r.height <= 2 || style.display === 'none' || style.visibility === 'hidden' || el.closest('[aria-hidden="true"]')) continue;
        const enabled = !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getAttribute('tabindex') !== '-1';
        renewBtn = { enabled };
        if (enabled) break;
      }
      const loading=document.readyState==='loading'||!!(root&&[...root.querySelectorAll('[aria-busy="true"],[role="progressbar"],[role="status"]')].some(el=>visible(el)&&(el.getAttribute('aria-busy')==='true'||el.getAttribute('role')==='progressbar'||/carregando|loading/i.test(el.innerText))));
      const signature=text.slice(0,16000);
      return { hasHeader, renewBtn, loading, signature };
    });
    lastSnapshot = snap;
    if (snap && snap.hasHeader && snap.renewBtn && snap.renewBtn.enabled && !snap.loading) {
      if (readySince === null || signature!==snap.signature){readySince=now();signature=snap.signature;}
      if (now() - readySince >= RENEW_READY_STABLE_MS) return { ok: true, reason: 'ready', snapshot: snap };
    } else readySince = null;
    await sleep(1000);
  }
  return { ok: false, reason: 'renew_button_unavailable_timeout', snapshot: lastSnapshot };
}

/**
 * Tela/modal "Renovar classificados" ainda ativa?
 * NÃO usar chrome do Selling (Gerenciar/Selecionar) — eles ficam no DOM ATRÁS do modal.
 */
async function isRenewScreenActive(page) {
  const snap = await safeEvaluate(page, () => {
    const norm = (s) => {
      try {
        return String(s || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim();
      } catch {
        return String(s || '').toLowerCase().trim();
      }
    };
    const markers = (t) => {
      const n = norm(t);
      if (!n) return false;
      return (
        n.includes('renovar classificados') ||
        n.includes('renew listings') ||
        n.includes('renew your listings') ||
        n.includes('serao renovados') ||
        n.includes('will be renewed') ||
        n.includes('classificados serao renovados')
      );
    };
    const roots = Array.from(
      document.querySelectorAll('[role="dialog"],[aria-modal="true"],div[role="alertdialog"]')
    );
    for (const root of roots) {
      if (!root) continue;
      let txt = '';
      try {
        txt = String(root.innerText || root.textContent || '').slice(0, 4000);
      } catch {
        txt = '';
      }
      if (markers(txt)) return { active: true, via: 'dialog_markers' };

      // Rodapé Cancelar + Renovar (mesmo sem header visível / loading).
      let hasCancel = false;
      let hasRenew = false;
      try {
        const nodes = root.querySelectorAll('[role="button"],button');
        for (const el of nodes) {
          if (!el) continue;
          let aria = '';
          let t = '';
          try { aria = norm(el.getAttribute('aria-label') || ''); } catch {}
          try { t = norm(el.innerText || '').slice(0, 40); } catch {}
          if (aria === 'cancelar' || aria === 'cancel' || t === 'cancelar' || t === 'cancel') hasCancel = true;
          if (aria === 'renovar' || aria === 'renew' || t === 'renovar' || t === 'renew') hasRenew = true;
        }
      } catch {}
      if (hasCancel && hasRenew) return { active: true, via: 'dialog_footer_pair' };
    }

    // Full-page renew (sem dialog role claro).
    let body = '';
    try {
      body = String(document.body && (document.body.innerText || document.body.textContent) || '').slice(0, 12000);
    } catch {
      body = '';
    }
    if (markers(body)) {
      // Se o texto existe mas NÃO há dialog, ainda é a tela Renovar (FB full page).
      // Selling puro também pode ter "Renovar" em menus — exige marcador de batch.
      const n = norm(body);
      if (
        n.includes('renovar classificados') ||
        n.includes('renew listings') ||
        n.includes('serao renovados') ||
        n.includes('will be renewed')
      ) {
        return { active: true, via: 'body_markers' };
      }
    }
    return { active: false };
  });
  return !!(snap && snap.active);
}

async function isRenewDialogOpen(page) {
  return await isRenewScreenActive(page);
}

/**
 * Após clicar Renovar: NÃO aceitar "Selling chrome" (fica atrás do modal).
 * Contrato:
 *  1) piso mínimo de parede (minProcessMs) — UI pode fechar cedo; rede ainda processa
 *  2) tela Renovar ausente de forma ESTÁVEL (POST_RENEW_DISMISS_STABLE_MS)
 *  3) só então libera o hold no Selling
 */
async function waitRenewDialogClosed(page, {
  timeoutMs = 240000,
  minProcessMs = POST_RENEW_MIN_PROCESS_BASE_MS,
  onProgress = null,
  isStale = null
} = {}) {
  const t0 = now();
  let lastHintAt = 0;
  let goneSince = 0;
  const minMs = Math.max(POST_RENEW_TOO_FAST_MS, Number(minProcessMs) || POST_RENEW_MIN_PROCESS_BASE_MS);
  const hardCap = Math.max(timeoutMs, minMs + POST_RENEW_DISMISS_STABLE_MS + 5000);

  while (now() - t0 < hardCap) {
    if (typeof isStale === 'function') {
      try {
        if (isStale()) return { ok: false, reason: 'stale' };
      } catch {}
    }

    const elapsed = now() - t0;
    const active = await isRenewScreenActive(page);

    if (active) {
      goneSince = 0;
    } else {
      if (!goneSince) goneSince = now();
      const goneFor = now() - goneSince;
      // Só aceita dismiss depois do piso mínimo E estabilidade sem a tela Renovar.
      if (elapsed >= minMs && goneFor >= POST_RENEW_DISMISS_STABLE_MS) {
        return {
          ok: true,
          via: 'renew_screen_gone_stable',
          elapsedMs: elapsed,
          goneForMs: goneFor,
          minProcessMs: minMs
        };
      }
    }

    if (onProgress && elapsed - lastHintAt >= 4000) {
      lastHintAt = elapsed;
      const remainMin = Math.max(0, minMs - elapsed);
      const msg = active
        ? `Facebook processando renovação... (${Math.round(elapsed / 1000)}s)`
        : remainMin > 0
          ? `Tela saiu — piso mínimo ainda ${Math.ceil(remainMin / 1000)}s (rede)...`
          : `Confirmando saída estável da tela Renovar... (${Math.round((now() - (goneSince || now())) / 1000)}s)`;
      try {
        await progress(page, onProgress, 'click_renew_wait', msg);
      } catch {}
    }
    await sleep(800);
  }
  return { ok: false, reason: 'dialog_close_timeout', elapsedMs: now() - t0 };
}

/**
 * Clique dedicado no botão Renovar REAL do rodapé (nunca Cancelar, nunca ghost).
 * DOM FB: ghost = aria-disabled + aria-hidden + tabindex=-1; real = tabindex=0.
 * Alvo visível, habilitado, estável e alcançável pelo mouse dentro do modal.
 */
async function renewalControlDiagnostic(page) {
  try {
    return await page.evaluate(() => {
      const norm = text => String(text||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
      return [...document.querySelectorAll('[role="button"],button')].filter(el =>
        ['renovar','renew'].includes(norm(el.getAttribute('aria-label')||el.innerText))
      ).slice(0,8).map(el => {
        const r=el.getBoundingClientRect(), style=getComputedStyle(el), hit=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.y+r.height/2)));
        const root=el.closest('[role="dialog"],[aria-modal="true"],[role="main"]');
        return {disabled:el.disabled===true||el.getAttribute('aria-disabled')==='true',hiddenAncestor:!!el.closest('[aria-hidden="true"]'),inert:!!el.closest('[inert]'),busy:!!el.closest('[aria-busy="true"]'),tab:el.getAttribute('tabindex'),display:style.display,visibility:style.visibility,bounds:{x:r.x,y:r.y,w:r.width,h:r.height},insideViewport:r.bottom>0&&r.top<innerHeight,hitOwn:!!hit&&(hit===el||el.contains(hit)),hitTag:hit?.tagName,rootRole:root?.getAttribute('role'),rootLabel:root?.getAttribute('aria-label'),readyState:document.readyState};
      });
    });
  } catch(error) {return {error:String(error.message||error).slice(0,100)};}
}

async function clickRenewConfirmInDialog(page, { beforeClick = null, onClick = null } = {}) {
  await require('./interactionLease').wait(page);
  const controls=require('./interactionReadiness');
  const withinSelector = await page.evaluate(() => {
    const norm = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
    const visible = el => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return r.width > 2 && r.height > 2 && style.display !== 'none' &&
        style.visibility !== 'hidden' && !el.closest('[aria-hidden="true"],[inert]');
    };
    const markers = el => /renovar classificados|renew listings|renew your listings|classificados serao renovados|listings will be renewed/.test(norm(el.getAttribute('aria-label'))+' '+norm(el.innerText));
    const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[role="alertdialog"]')].filter(visible);
    if (dialogs.some(markers)) return '[role="dialog"],[aria-modal="true"],[role="alertdialog"]';
    // A foreign dialog owns the screen until it is dismissed.
    if (dialogs.length) return null;
    const main = [...document.querySelectorAll('[role="main"],main')].find(el => visible(el) && markers(el));
    if (main) return '[role="main"],main';
    if (document.body && markers(document.body)) return 'body';
    return null;
  });
  if (!withinSelector) return {ok:false,reason:'renew_screen_not_ready',diagnostic:await renewalControlDiagnostic(page)};

  const options={exact:true,withinSelector,timeoutMs:60000,equivalentReplacements:true};
  const stable=await controls.waitControl(page,['Renovar','Renew'],options);
  if(!stable.ok)return {ok:false,reason:stable.detail||stable.reason,diagnostic:await renewalControlDiagnostic(page)};
  if(beforeClick)await beforeClick();
  // Revalidate after transport/authentication checks; never reuse old coordinates.
  const rechecked=await controls.waitControl(page,['Renovar','Renew'],options);
  if(!rechecked.ok)return {ok:false,reason:rechecked.detail||rechecked.reason,diagnostic:await renewalControlDiagnostic(page)};
  if(onClick)await onClick();
  const clicked=await controls.clickControl(page,['Renovar','Renew'],options);
  return clicked.ok?{ok:true,via:clicked.via,attempted:true}:{ok:false,reason:clicked.error||clicked.reason,attempted:true};
}

async function clickRenewConfirm(page, { onProgress, onAudit, isStale = null, expectedCount = 0, beforeClick = null, onClick = null, afterConfirm = null } = {}) {
  await progress(page, onProgress, 'click_renew', 'Clicando em Renovar (rodapé real, não Cancelar)...');
  let clicked = false;
  let lastControlReason = null;
  let lastDiagnostic = null;
  const audit = (event, data = {}) => {
    try {
      if (typeof onAudit === 'function') onAudit(event, data);
    } catch {}
  };
  const stale = () => {
    try {
      return typeof isStale === 'function' && !!isStale();
    } catch {
      return false;
    }
  };
  const findDeadline = now() + 180000;
  const tFind0 = now();
  const expectN = Math.max(0, Number(expectedCount || 0) || 0);
  const processTimeoutMs = postRenewProcessTimeoutMs(expectN);
  const minProcessMs = postRenewMinProcessMs(expectN);

  while (now() < findDeadline) {
    if (stale()) {
      audit('renew_confirm_fail', { reason: 'stale', clicked });
      return { ok: false, reason: 'stale', clicked };
    }

    const hit = await clickRenewConfirmInDialog(page, { beforeClick, onClick });
    lastControlReason = hit?.reason || null;
    lastDiagnostic = hit?.diagnostic || null;
    if(lastDiagnostic)audit('renew_control_rejected',{reason:lastControlReason,diagnostic:lastDiagnostic});
    if(hit?.attempted&&hit.ok!==true){audit('renew_confirm_fail',{reason:hit.reason,clicked:true});return {ok:false,reason:hit.reason,clicked:true};}
    if (hit && hit.ok) {
      clicked = true;
      const tClick = now();
      audit('renew_confirm_clicked', {
        via: hit.via || null,
        aria: hit.aria || null,
        txt: hit.txt || null,
        tab: hit.tab || null,
        bottom: hit.bottom != null ? hit.bottom : null,
        right: hit.right != null ? hit.right : null,
        x: hit.x != null ? hit.x : null,
        y: hit.y != null ? hit.y : null,
        candidates: hit.candidates != null ? hit.candidates : null,
        rejectedCancel: hit.rejectedCancel != null ? hit.rejectedCancel : null,
        rejectedGhost: hit.rejectedGhost != null ? hit.rejectedGhost : null,
        expectedCount: expectN,
        processTimeoutMs,
        minProcessMs,
        findMs: tClick - tFind0
      });
      await progress(
        page,
        onProgress,
        'click_renew_wait',
        `Renovar clicado — piso mínimo ${Math.ceil(minProcessMs / 1000)}s + espera a tela sair...`
      );

      const closed = await waitRenewDialogClosed(page, {
        timeoutMs: processTimeoutMs,
        minProcessMs,
        onProgress,
        isStale: stale
      });
      const elapsed = now() - tClick;

      if (closed && closed.reason === 'stale') {
        audit('renew_confirm_fail', { reason: 'stale', clicked: true, elapsedMs: elapsed });
        return { ok: false, reason: 'stale', clicked: true, elapsedMs: elapsed };
      }

      // Fechou a UI rápido demais (antes do piso) = Cancelar/dismiss.
      if (closed && closed.ok && elapsed < POST_RENEW_TOO_FAST_MS && expectN >= 5) {
        audit('renew_confirm_fail', {
          reason: 'dialog_closed_too_fast_suspect_cancel',
          elapsedMs: elapsed,
          expectedCount: expectN,
          via: closed.via || null
        });
        return {
          ok: false,
          reason: 'dialog_closed_too_fast_suspect_cancel',
          clicked: true,
          elapsedMs: elapsed
        };
      }

      if (!(closed && closed.ok)) {
        audit('renew_confirm_fail', {
          reason: 'renew_process_timeout',
          elapsedMs: elapsed,
          expectedCount: expectN,
          processTimeoutMs,
          minProcessMs
        });
        return {
          ok: false,
          reason: 'renew_process_timeout',
          clicked: true,
          elapsedMs: elapsed
        };
      }

      if (stale()) {
        audit('renew_confirm_done', { reason: 'clicked_then_stale', clicked: true, elapsedMs: elapsed });
        return { ok: false, reason: 'stale', clicked: true };
      }

      if (afterConfirm) await afterConfirm();
      // Hold SÓ depois: piso mínimo + tela Renovar sumida estável.
      const holdMs = randInt(POST_RENEW_HOLD_MS_MIN, POST_RENEW_HOLD_MS_MAX);
      await progress(
        page,
        onProgress,
        'click_renew_hold',
        `Selling estável — segurando ${Math.ceil(holdMs / 1000)}s antes de liberar close...`
      );
      await sleep(holdMs);

      audit('renew_confirm_done', {
        reason: 'clicked_and_closed',
        via: closed.via || null,
        clicked: true,
        elapsedMs: now() - tClick,
        processMs: elapsed,
        minProcessMs,
        heldMs: holdMs,
        goneForMs: closed.goneForMs != null ? closed.goneForMs : null
      });
      return { ok: true, reason: 'clicked_and_closed', clicked: true, heldMs: holdMs, processMs: elapsed };
    }

    // Control readiness scrolls only the selected target into view.
    // A rejected confirmation must not scroll the Selling page behind the dialog.
    await humanPause(800, 1400);
  }

  if (clicked) {
    audit('renew_confirm_fail', { reason: 'clicked_loop_end_unexpected', clicked: true });
    return { ok: false, reason: 'clicked_loop_end_unexpected', clicked: true };
  }
  audit('renew_confirm_fail', { reason: 'renew_button_not_found', controlReason:lastControlReason, diagnostic:lastDiagnostic, findMs: now() - tFind0 });
  return { ok: false, reason: 'renew_button_not_found' };
}

async function waitBackToSelling(page, { onProgress, timeoutMs = 90000 } = {}) {
  await progress(page, onProgress, 'back_selling', 'Aguardando retorno ao Selling...');
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    let onSell = false;
    try {
      const url = String(page.url() || '').toLowerCase();
      if (url.includes('/marketplace/you/selling')) onSell = true;
    } catch {}
    if (!onSell) {
      onSell = !!(await safeEvaluate(
        page,
        () => /marketplace\/(you\/selling|you\/dashboard)/.test(String(location.pathname || ''))
      ));
    }
    if (onSell) {
      // Settle real: Gerenciar ou Selecionar tudo visível.
      const settled = await waitForLabel(
        page,
        ['Gerenciar classificados', 'Manage listings', 'Selecionar tudo', 'Select all'],
        { timeoutMs: 15000, requireEnabled: false, pollMs: 700 }
      );
      if (settled) return { ok: true };
      // Já está na URL selling — aceita após pequeno settle.
      await sleep(2500);
      return { ok: true, via: 'url_settle' };
    }
    await sleep(1000);
  }
  try {
    const connectLane = require('./connectLane.js');
    await connectLane.withHeavyNav({ kind: 'renew_back_selling_goto' }, async () => {
      await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    });
    await waitForLabel(
      page,
      ['Gerenciar classificados', 'Manage listings', 'Selecionar tudo', 'Select all'],
      { timeoutMs: 20000, requireEnabled: false, pollMs: 800 }
    );
    return { ok: true, via: 'goto' };
  } catch {
    return { ok: false, reason: 'not_back_selling' };
  }
}

/**
 * @param {object} opts
 * @param {import('puppeteer').Page} opts.page
 * @param {string} [opts.nome]
 * @param {'manual'|'auto'} [opts.mode]
 * @param {(p:{stage:string,message:string})=>void} [opts.onProgress]
 * @param {(evt:object)=>void} [opts.onAudit]
 */
async function runMarketplaceRenewListings({
  page,
  nome = '',
  mode = 'manual',
  onProgress = null,
  onAudit = null,
  deadlineAt = 0,
  isAborted = null,
  scrollStopAgeDays = SCROLL_STOP_AGE_DAYS
} = {}) {
  const audit = (event, data = {}) => {
    try {
      if (typeof onAudit === 'function') onAudit({ event, nome: String(nome || ''), mode, ...data });
    } catch {}
  };
  const aborted = () => {
    try {
      if (typeof isAborted === 'function' && isAborted()) return true;
    } catch {}
    const dl = Number(deadlineAt || 0) || 0;
    return !!(dl > 0 && now() > require('./carrierV2/clock').effective(dl));
  };
  const abortResult = () => {
    audit('renew_listings_fail', { stage: 'abort', reason: 'renew_hard_timeout_or_aborted' });
    return { ok: false, error: 'renew_hard_timeout', renewedCount: 0, reason: 'hard_timeout' };
  };

  if (!page) {
    return { ok: false, error: 'no_page', renewedCount: 0 };
  }
  const isolated = require('./isolatedAccountFlow').context(page, 'renew');
  if(isolated?.deadlineAt)deadlineAt=Math.min(Number(deadlineAt)||Infinity,isolated.deadlineAt);
  if (!isolated) {
    try {
      const isolatedDeadline = Number(deadlineAt) || Date.now() + 35 * 60 * 1000;
      return await require('./isolatedAccountFlow').run({ page, nome, kind: 'renew', deadlineAt: isolatedDeadline },
        isolatedPage => runMarketplaceRenewListings({ page: isolatedPage, nome, mode, onProgress, onAudit, deadlineAt: isolatedDeadline, isAborted, scrollStopAgeDays }));
    } catch (e) { return { ok: false, error: String(e.message || e), renewedCount: 0 }; }
  }

  const startedAt = now();
  const ageDays = Math.max(1, Math.min(120, Math.floor(Number(scrollStopAgeDays) || SCROLL_STOP_AGE_DAYS) || SCROLL_STOP_AGE_DAYS));
  audit('renew_listings_begin', { startedAt, scrollStopAgeDays: ageDays });

  try {
    if (aborted()) return abortResult();
    await ensureSelling(page, { onProgress });
    await require('./accountSecurityGate').assertAllowed(page,nome);
    if (aborted()) return abortResult();

    const alreadyManage = await labelPresent(page, ['Selecionar tudo', 'Select all'], { requireEnabled: false, exactOnly:true });
    if (!alreadyManage) {
      await progress(page, onProgress, 'manage', 'Clicando em Gerenciar classificados...');
      const manage = await clickByLabels(
        page,
        ['Gerenciar classificados', 'Manage listings', 'Manage your listings'],
        { roleHints: ['button'], timeoutMs: 45000, requireEnabled: true, exactOnly:true }
      );
      if (!manage || !manage.ok) {
        audit('renew_listings_fail', { stage: 'manage', reason: 'manage_not_found' });
        return { ok: false, error: 'manage_listings_not_found', renewedCount: 0 };
      }
    } else {
      await progress(page, onProgress, 'manage', 'Já em modo Gerenciar classificados.');
    }
    // Ready real do modo gerenciar (não sleep cego): espera Selecionar tudo.
    await progress(page, onProgress, 'manage_settle', 'Aguardando modo Gerenciar carregar...');
    const manageReady = await waitForLabel(page, ['Selecionar tudo', 'Select all'], {
      timeoutMs: require('./interactionBudget').timeout(page, MANAGE_MODE_WAIT_MS),
      exactOnly:true,
      requireEnabled: false,
      pollMs: 800
    });
    if (!manageReady) {
      audit('renew_listings_fail', {stage:'manage_settle',reason:'renew_manage_mode_unconfirmed'});
      return {ok:false,error:'renew_manage_mode_unconfirmed',renewedCount:0};
    }
    audit('renew_manage_mode_ready');
    if (aborted()) return abortResult();

    const scrolled = await scrollToAgeThreshold(page, { onProgress, scrollStopAgeDays: ageDays, deadlineAt, isAborted, requireManageMode:true });
    if(!scrolled?.ok)return {ok:false,error:scrolled?.reason||'listing_scroll_unconfirmed',renewedCount:0};
    audit('renew_listings_scrolled', { reason: scrolled && scrolled.reason, scrollStopAgeDays: ageDays });
    if (aborted()) return abortResult();

    // Ritmo humano pós-scroll: sobe → seleciona → ações → renovar (sem atropelo).
    await progress(page, onProgress, 'human_pace', 'Pausa humana antes de subir ao topo...');
    await humanPause(2500, 4500);

    await progress(page, onProgress, 'scroll_top', 'Subindo ao topo...');
    await scrollToTop(page);
    await humanPause(1200, 2200);
    await scrollToTop(page);
    await humanPause(2000, 3800);

    await progress(page, onProgress, 'select_all', 'Selecionando tudo...');
    const selectAll = await clickByLabels(page, ['Selecionar tudo', 'Select all'], {
      roleHints: ['button'],
      timeoutMs: SELECT_ALL_WAIT_MS,
      requireEnabled: true
    });
    if (!selectAll || !selectAll.ok) {
      audit('renew_listings_fail', { stage: 'select_all', reason: 'select_all_not_found' });
      return { ok: false, error: 'select_all_not_found', renewedCount: 0 };
    }
    await humanPause(2200, 4000);
    await progress(page,onProgress,'actions_menu','Abrindo Ações e verificando a opção de renovação...');
    const choice=await require('./renewActionsMenu').openAndChoose(page,{timeoutMs:ACTIONS_MENU_WAIT_MS,deadlineAt:deadlineAt?require('./carrierV2/clock').effective(deadlineAt):0,onAudit:audit});
    if(!choice.ok){
      audit('renew_listings_fail',{stage:'actions_menu',reason:choice.error,menu:choice.menu});
      return {ok:false,error:choice.error,renewedCount:0};
    }
    // Espera header da tela Renovar (não só sleep cego).
    await progress(page, onProgress, 'renew_open', 'Aguardando tela Renovar classificados...');
    const renewHeader = await (async () => {
      const tH = now();
      while (now() - tH < 45000) {
        if (aborted()) return false;
        const ok = await findTextPresent(page, [
          'Renovar classificados',
          'Renew listings',
          'Renew your listings',
          'serao renovados',
          'will be renewed'
        ]);
        if (ok && ok.ok) return true;
        await sleep(800);
      }
      return false;
    })();
    if (!renewHeader) await sleep(SETTLE_MS);
    if (aborted()) return abortResult();

    const stable = await waitRenewScreenStable(page, { onProgress, timeoutMs: RENEW_SCREEN_WAIT_MS });
    if (!stable || stable.ok !== true) {
      const error = (stable && stable.reason) || 'renew_screen_unconfirmed';
      audit('renew_listings_fail', { stage: 'renew_screen', reason: error, snapshot: stable && stable.snapshot, diagnostic:await renewalControlDiagnostic(page), durationMs: now() - startedAt });
      return { ok: false, renewedCount: 0, error, reason: error };
    }
    // Botão final disponível: segue sem exigir quantidade.
    // Só generation/stale (controller morto / renew cancelado).
    try {
      if (typeof isAborted === 'function' && isAborted()) return abortResult();
    } catch {}

    // Pausa humana antes do clique final Renovar (rodapé).
    await humanPause(2000, 4000);

    // Fase confirm: achar+clicar Renovar real; espera tela mudar (pode travar muito); hold 15–30s no Selling.
    const clicked = await clickRenewConfirm(page, {
      onProgress,
      onAudit: audit,
      beforeClick: async () => {
        if (!isolated.proxyRequired) return;
        const result = await isolated.rail.armAndProve(page);
        if (!result || !result.ok || !isolated.rail.isProxyArmed) throw new Error('renew_proxy_unavailable');
      },
      onClick: async () => {
        if (isolated.proxyRequired) await isolated.rail.markPublishClick();
      },
      afterConfirm: async () => {
        if (!isolated.proxyRequired) return;
        const transport = await isolated.rail.waitPublishTransport();
        audit('renew_proxy_transport', transport);
        if (!transport.ok) throw new Error('renew_proxy_transport_not_confirmed');
        await isolated.rail.releaseProxy();
      },
      isStale: () => {
        try {
          return typeof isAborted === 'function' && !!isAborted();
        } catch {
          return false;
        }
      }
    });
    if (!clicked || !clicked.ok) {
      if (clicked && (clicked.reason === 'stale' || clicked.reason === 'aborted')) return abortResult();
      audit('renew_listings_fail', {
        stage: 'confirm',
        reason: clicked && clicked.reason,
        elapsedMs: clicked && clicked.elapsedMs != null ? clicked.elapsedMs : null
      });
      return {
        ok: false,
        error: (clicked && clicked.reason) ? String(clicked.reason) : 'renew_confirm_failed',
        renewedCount: 0,
        pendingCount: null
      };
    }
    audit('renew_listings_confirm', {
      reason: clicked && clicked.reason,
      clicked: !!(clicked && clicked.clicked),
      quantityMeasured: false
    });

    // Pós-clique: hold 15–30s já rodou DENTRO de clickRenewConfirm (após tela mudar).
    // Aqui só confirma Selling chrome (best-effort curto).
    await waitBackToSelling(page, { onProgress, timeoutMs: 30000 });
    await progress(page, onProgress, 'done', 'Renovação concluída.');
    audit('renew_listings_ok', {
      renewedCount: null,
      confirmReason: clicked && clicked.reason,
      durationMs: now() - startedAt
    });
    return { ok: true, renewed: true, renewedCount: null, reason: 'renewed' };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    const lease=isolated?.rail?.operationSnapshot?.();
    audit('renew_listings_exception', { error: msg.slice(0, 220), durationMs: now() - startedAt,
      lease:lease?{healthy:lease.healthy,closed:lease.closed,statusError:lease.statusError,statusAgeMs:lease.statusAgeMs,absoluteDeadline:lease.absoluteDeadline}:null });
    return { ok: false, error: msg.slice(0, 220), renewedCount: 0 };
  }
}

module.exports = {
  SELLING_URL,
  SCROLL_STOP_AGE_DAYS,
  runMarketplaceRenewListings,
  ensureSelling,
  scrollToAgeThreshold,
  scrollToTop,
  clickByLabels,
  waitRenewScreenStable
};
