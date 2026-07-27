'use strict';

/**
 * Motor único: renovar classificados no Marketplace Selling.
 * Usado pelo overlay (manual) e pelo modo diário renew_window_close_open (auto).
 *
 * Selectors por texto/aria-label normalizado — nunca classes efêmeras do Facebook.
 */

const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
const SCROLL_STOP_AGE_DAYS = 46;
const SCROLL_STEP_PX = 380;
const SCROLL_INTERVAL_MS = 900;
const SCROLL_STUCK_TICKS_LIMIT = 180;
const RENEW_SCREEN_WAIT_MS = 120000;
const ACTIONS_MENU_WAIT_MS = 120000;
const SELECT_ALL_WAIT_MS = 120000;
const NAV_TIMEOUT_MS = 45000;
const SETTLE_MS = 8000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

function now() {
  return Date.now();
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
async function clickByLabels(page, labels, { roleHints = [], timeoutMs = 30000, requireEnabled = true, exactOnly = false, excludeSubstrings = [] } = {}) {
  const wanted = (Array.isArray(labels) ? labels : [labels])
    .map((x) => normalizeTxt(x))
    .filter(Boolean);
  if (!wanted.length) return { ok: false, reason: 'no_labels' };
  const roles = (Array.isArray(roleHints) ? roleHints : []).map((x) => String(x || '').toLowerCase()).filter(Boolean);
  const excludes = (Array.isArray(excludeSubstrings) ? excludeSubstrings : [])
    .map((x) => normalizeTxt(x))
    .filter(Boolean);
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    const hit = await safeEvaluate(
      page,
      ({ wanted, roles, requireEnabled, exactOnly, excludes }) => {
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
        const isDisabled = (el) => {
          try {
            if (!el) return true;
            if (el.disabled === true) return true;
            const aria = String(el.getAttribute('aria-disabled') || '').toLowerCase();
            if (aria === 'true') return true;
            const cls = String(el.className || '');
            if (/\bdisabled\b/i.test(cls)) return true;
            return false;
          } catch {
            return false;
          }
        };
        const isExcluded = (n) => {
          if (!n) return true;
          for (const ex of excludes) {
            if (ex && n.includes(ex)) return true;
          }
          return false;
        };
        const matches = (txt) => {
          const n = norm(txt);
          if (!n) return false;
          if (isExcluded(n)) return false;
          if (exactOnly) return wanted.some((w) => n === w);
          return wanted.some((w) => n === w || n.includes(w));
        };
        const candidates = [];
        const nodes = document.querySelectorAll(
          '[role="button"],[role="menuitem"],button,a[role="link"],div[role="button"],span[role="button"]'
        );
        for (const el of nodes) {
          if (!el) continue;
          let aria = '';
          let txt = '';
          try {
            aria = String(el.getAttribute('aria-label') || '');
          } catch {}
          try {
            txt = String(el.innerText || el.textContent || '').slice(0, 200);
          } catch {}
          const role = String(el.getAttribute('role') || el.tagName || '').toLowerCase();
          if (roles.length && !roles.some((r) => role.includes(r) || String(el.tagName || '').toLowerCase() === r)) {
            // roleHints são preferência, não hard filter se aria/text bate
          }
          if (!matches(aria) && !matches(txt)) continue;
          if (requireEnabled && isDisabled(el)) continue;
          const nAria = norm(aria);
          const nTxt = norm(txt);
          let score = 1;
          if (wanted.some((w) => nAria === w || nTxt === w)) score = 4;
          else if (matches(aria)) score = 2;
          candidates.push({
            el,
            score,
            aria: aria.slice(0, 80),
            txt: txt.slice(0, 80)
          });
        }
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        if (!best || !best.el) return { ok: false };
        try {
          best.el.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        try {
          best.el.click();
          return { ok: true, via: 'click', aria: best.aria, txt: best.txt };
        } catch {
          try {
            best.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { ok: true, via: 'dispatch', aria: best.aria, txt: best.txt };
          } catch {
            return { ok: false };
          }
        }
      },
      { wanted, roles, requireEnabled: !!requireEnabled, exactOnly: !!exactOnly, excludes }
    );
    if (hit && hit.ok) return hit;
    await sleep(700);
  }
  return { ok: false, reason: 'timeout' };
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
    await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  }
  await sleep(SETTLE_MS);
  return true;
}

async function scrollToAgeThreshold(page, { onProgress } = {}) {
  await progress(page, onProgress, 'scroll_down', 'Rolando classificados até a data alvo...');
  const targetIso = (() => {
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const target = new Date(t0.getTime() - SCROLL_STOP_AGE_DAYS * 86400000);
    const y = target.getFullYear();
    const m = String(target.getMonth() + 1).padStart(2, '0');
    const d = String(target.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  })();

  let stuckTicks = 0;
  let lastTop = -1;
  for (let tick = 0; tick < SCROLL_STUCK_TICKS_LIMIT + 40; tick++) {
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
        return { moved: after !== before, top: after, ageHit, oldestTs, targetIso };
      },
      { step: SCROLL_STEP_PX, targetIso, SCROLL_STOP_AGE_DAYS }
    );

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
  return { ok: true, reason: 'tick_budget' };
}

async function scrollToTop(page) {
  try {
    await page.evaluate(() => {
      try {
        window.scrollTo(0, 0);
        const main =
          document.querySelector('[role="main"]') ||
          document.scrollingElement ||
          document.documentElement;
        if (main && typeof main.scrollTo === 'function') main.scrollTo(0, 0);
        if (main) main.scrollTop = 0;
      } catch {}
    });
  } catch {}
  await sleep(2000);
}

/**
 * Espera a tela "Renovar classificados" estabilizar e extrai contagem.
 * Ignora falso "nenhum" nos primeiros segundos — FB contabiliza até ~120s.
 */
async function waitRenewScreenStable(page, { onProgress, timeoutMs = RENEW_SCREEN_WAIT_MS } = {}) {
  await progress(page, onProgress, 'renew_screen', 'Aguardando Facebook contabilizar renováveis...');
  const t0 = now();
  let lastCount = null;
  let stableHits = 0;
  let sawHeader = false;
  let bestReadyCount = 0;

  while (now() - t0 < timeoutMs) {
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
      let body = '';
      try {
        body = String(document.body && (document.body.innerText || document.body.textContent) || '');
      } catch {
        body = '';
      }
      const n = norm(body);
      const hasHeader =
        n.includes('renovar classificados') ||
        n.includes('renew listings') ||
        n.includes('renew your listings');
      let count = null;
      // "X classificados serão renovados" / "X listings will be renewed"
      const m1 = n.match(/(\d+)\s+classificados?\s+serao\s+renovados/);
      const m2 = n.match(/(\d+)\s+listings?\s+will\s+be\s+renewed/);
      const m3 = n.match(/serao\s+renovados[^\d]*(\d+)/);
      if (m1) count = Number(m1[1]);
      else if (m2) count = Number(m2[1]);
      else if (m3) count = Number(m3[1]);

      const noneEarly =
        /nao ha nenhum classificado|nenhum classificado para renovar|no listings? to renew|nothing to renew/.test(n) &&
        count == null;

      // Botão Renovar habilitado (texto/aria exatamente "renovar"/"renew")
      let renewBtn = null;
      const nodes = document.querySelectorAll('[role="button"],button');
      for (const el of nodes) {
        if (!el) continue;
        let aria = '';
        let txt = '';
        try {
          aria = norm(el.getAttribute('aria-label') || '');
        } catch {}
        try {
          txt = norm(el.innerText || el.textContent || '').slice(0, 40);
        } catch {}
        if (aria !== 'renovar' && txt !== 'renovar' && aria !== 'renew' && txt !== 'renew') continue;
        const disabled =
          el.disabled === true || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        renewBtn = { enabled: !disabled, aria: aria.slice(0, 40), txt: txt.slice(0, 40) };
        if (!disabled) break;
      }
      return { hasHeader, count, noneEarly, renewBtn };
    });

    if (snap && snap.hasHeader) sawHeader = true;

    if (snap && Number.isFinite(snap.count) && snap.count > 0 && snap.renewBtn && snap.renewBtn.enabled) {
      bestReadyCount = Math.max(bestReadyCount, snap.count);
      if (lastCount === snap.count) stableHits += 1;
      else {
        lastCount = snap.count;
        stableHits = 1;
      }
      if (stableHits >= 2) {
        await progress(
          page,
          onProgress,
          'renew_ready',
          `Prontos para renovar: ${snap.count} classificado(s).`
        );
        return { ok: true, count: snap.count, reason: 'ready' };
      }
    } else if (snap && snap.renewBtn && snap.renewBtn.enabled && Number.isFinite(snap.count) && snap.count > 0) {
      lastCount = snap.count;
      bestReadyCount = Math.max(bestReadyCount, snap.count);
    }

    const elapsed = now() - t0;
    if (elapsed >= timeoutMs - 500 && sawHeader && !(snap && snap.count > 0 && snap.renewBtn && snap.renewBtn.enabled)) {
      break;
    }

    if (elapsed % 8000 < 1100) {
      await progress(
        page,
        onProgress,
        'renew_screen',
        `Contabilizando renováveis... (${Math.round(elapsed / 1000)}s)`
      );
    }
    await sleep(1000);
  }

  // Se viu count+botão habilitado mas não estabilizou 2 ticks, ainda assim usa o melhor count.
  if (bestReadyCount > 0) {
    return { ok: true, count: bestReadyCount, reason: 'ready_best_effort' };
  }

  // Timeout: nenhum renovável clicável
  return { ok: true, count: 0, reason: 'none_renewable_timeout' };
}

async function clickRenewConfirm(page, { onProgress } = {}) {
  await progress(page, onProgress, 'click_renew', 'Clicando em Renovar...');
  // Scroll leve até achar o botão — match EXATO "Renovar"/"Renew"
  // (nunca "Renovar no Marketplace" / "Renovar classificados").
  for (let i = 0; i < 25; i++) {
    const hit = await clickByLabels(page, ['Renovar', 'Renew'], {
      roleHints: ['button'],
      timeoutMs: 2500,
      requireEnabled: true,
      exactOnly: true,
      excludeSubstrings: ['marketplace', 'classificado', 'listing', 'listings']
    });
    if (hit && hit.ok) {
      await sleep(SETTLE_MS);
      return { ok: true };
    }
    try {
      await page.evaluate(() => {
        try {
          const el = document.scrollingElement || document.documentElement;
          if (el) el.scrollBy(0, 280);
        } catch {}
      });
    } catch {}
    await sleep(600);
  }
  return { ok: false, reason: 'renew_button_not_found' };
}

async function waitBackToSelling(page, { timeoutMs = 90000 } = {}) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    try {
      const url = String(page.url() || '').toLowerCase();
      if (url.includes('/marketplace/you/selling')) return { ok: true };
    } catch {}
    const onSell = await safeEvaluate(
      page,
      () => /marketplace\/(you\/selling|you\/dashboard)/.test(String(location.pathname || ''))
    );
    if (onSell) return { ok: true };
    await sleep(1000);
  }
  // Best-effort: force goto selling
  try {
    await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await sleep(3000);
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
  onAudit = null
} = {}) {
  const audit = (event, data = {}) => {
    try {
      if (typeof onAudit === 'function') onAudit({ event, nome: String(nome || ''), mode, ...data });
    } catch {}
  };

  if (!page) {
    return { ok: false, error: 'no_page', renewedCount: 0 };
  }

  const startedAt = now();
  audit('renew_listings_begin', { startedAt });

  try {
    await ensureSelling(page, { onProgress });

    await progress(page, onProgress, 'manage', 'Clicando em Gerenciar classificados...');
    const manage = await clickByLabels(
      page,
      ['Gerenciar classificados', 'Manage listings', 'Manage your listings'],
      { roleHints: ['button'], timeoutMs: 45000, requireEnabled: true }
    );
    if (!manage || !manage.ok) {
      audit('renew_listings_fail', { stage: 'manage', reason: 'manage_not_found' });
      return { ok: false, error: 'manage_listings_not_found', renewedCount: 0 };
    }
    await sleep(SETTLE_MS);

    const scrolled = await scrollToAgeThreshold(page, { onProgress });
    audit('renew_listings_scrolled', { reason: scrolled && scrolled.reason });

    await progress(page, onProgress, 'scroll_top', 'Subindo ao topo...');
    await scrollToTop(page);
    await sleep(1500);
    await scrollToTop(page);

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
    // Seleção de muitos anúncios pode demorar — espera Ações ficar habilitado (até 120s).
    await progress(page, onProgress, 'select_wait', 'Aguardando seleção estabilizar...');
    const actionsReady = await (async () => {
      const tWait = now();
      while (now() - tWait < ACTIONS_MENU_WAIT_MS) {
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
          const nodes = document.querySelectorAll('[role="button"],button');
          for (const el of nodes) {
            if (!el) continue;
            let aria = '';
            let txt = '';
            try { aria = norm(el.getAttribute('aria-label') || ''); } catch {}
            try { txt = norm(el.innerText || el.textContent || '').slice(0, 40); } catch {}
            if (aria !== 'acoes' && aria !== 'actions' && txt !== 'acoes' && txt !== 'actions') continue;
            const disabled =
              el.disabled === true || String(el.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
            return { found: true, enabled: !disabled };
          }
          return { found: false, enabled: false };
        });
        if (snap && snap.found && snap.enabled) return true;
        await sleep(1000);
      }
      return false;
    })();
    if (!actionsReady) {
      // Ainda tenta clicar Ações — FB às vezes não marca aria corretamente.
      await sleep(Math.max(SETTLE_MS, 5000));
    }
    await progress(page, onProgress, 'actions', 'Abrindo Ações...');
    const actions = await clickByLabels(page, ['Ações', 'Actions'], {
      roleHints: ['button'],
      timeoutMs: ACTIONS_MENU_WAIT_MS,
      requireEnabled: true
    });
    if (!actions || !actions.ok) {
      audit('renew_listings_fail', { stage: 'actions', reason: 'actions_not_found' });
      return { ok: false, error: 'actions_not_found', renewedCount: 0 };
    }
    await sleep(2000);

    await progress(page, onProgress, 'renew_mp', 'Clicando em Renovar no Marketplace...');
    const renewMp = await clickByLabels(
      page,
      ['Renovar no Marketplace', 'Renew in Marketplace', 'Renew on Marketplace'],
      { roleHints: ['menuitem', 'button'], timeoutMs: ACTIONS_MENU_WAIT_MS, requireEnabled: true }
    );
    if (!renewMp || !renewMp.ok) {
      audit('renew_listings_fail', { stage: 'renew_marketplace', reason: 'menu_item_not_found' });
      return { ok: false, error: 'renew_marketplace_not_found', renewedCount: 0 };
    }
    await sleep(SETTLE_MS);

    const stable = await waitRenewScreenStable(page, { onProgress, timeoutMs: RENEW_SCREEN_WAIT_MS });
    const count = Number(stable && stable.count) || 0;
    if (!(count > 0) || (stable && stable.reason === 'none_renewable_timeout')) {
      audit('renew_listings_none', { reason: stable && stable.reason, durationMs: now() - startedAt });
      await progress(page, onProgress, 'none', 'Nenhum classificado renovável (após espera).');
      // Volta ao selling best-effort
      try {
        await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } catch {}
      return { ok: true, renewedCount: 0, reason: 'none_renewable' };
    }

    const clicked = await clickRenewConfirm(page, { onProgress });
    if (!clicked || !clicked.ok) {
      audit('renew_listings_fail', { stage: 'confirm', reason: clicked && clicked.reason, count });
      return { ok: false, error: 'renew_confirm_failed', renewedCount: 0, pendingCount: count };
    }

    await waitBackToSelling(page, { timeoutMs: 90000 });
    await progress(page, onProgress, 'done', `Renovados: ${count} classificado(s).`);
    audit('renew_listings_ok', { renewedCount: count, durationMs: now() - startedAt });
    return { ok: true, renewedCount: count, reason: 'renewed' };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    audit('renew_listings_exception', { error: msg.slice(0, 220), durationMs: now() - startedAt });
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
