'use strict';

/**
 * ROBE pós-publicação / overlay humano — verificação de documento Marketplace (id.png).
 *
 * Contrato forense:
 * - Default: ID - nao (ausência de robeIdDocDoneDay ou dia ≠ hoje SP).
 * - Só runRobeAutoId marca robeIdDocDoneDay após wizard ok.
 * - runHumanVerifyId NUNCA marca a flag.
 * - Falha/timeout NUNCA invalida publish_ok (caller engole erros).
 * - Auto: se ID - sim → encerra na hora (sem selling/scan).
 * - Auto: se ID - nao → olha banner no TOPO do selling (sem scroll-hunt);
 *   tem ação → faz wizard; não tem → skip rápido e fecha o fluxo.
 */

const fs = require('fs');
const path = require('path');
const manifestStore = require('./manifestStore.js');
const stepLog = require('./stepLog.js');
const logger = require('./logger.js');
const provisionAudit = require('./provisionAudit.js');

const ID_PNG_PATH = path.join(__dirname, '..', 'dados', 'id.png');
const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';

const BUDGET_TOTAL_MS = 420000;
const BUDGET_SKIP_MS = 25000;
const WAIT_POST_SETTLE_MS = 4000;
const WAIT_STEP_MS = 5000;
const WAIT_FEED_SETTLE_MS = 10000;
const WAIT_AFTER_UPLOAD_MS = 7000;
const POLL_SUCCESS_MS = 180000;
const POLL_AFTER_REFRESH_MS = 60000;
const NAV_TIMEOUT_MS = 60000;
/** Banner “ação necessária” fica no topo — sem caça por scroll. */
const TOP_SCAN_ATTEMPTS_AUTO = 3;
const TOP_SCAN_ATTEMPTS_HUMAN = 4;
const TOP_SCAN_GAP_MS = 3500;

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

function norm(s) {
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

function todaySP(now = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(now));
  } catch {
    const d = new Date(now);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

function isDoneTodayFromDay(doneDay, now = Date.now()) {
  return String(doneDay || '').trim() === todaySP(now);
}

function getIdPngPath() {
  return ID_PNG_PATH;
}

function idPngExists() {
  try {
    return fs.existsSync(ID_PNG_PATH) && fs.statSync(ID_PNG_PATH).isFile();
  } catch {
    return false;
  }
}

function deadlineLeft(deadlineAt) {
  const d = Number(deadlineAt) || 0;
  if (!d) return BUDGET_TOTAL_MS;
  return Math.max(0, d - Date.now());
}

function assertBudget(deadlineAt, where) {
  if (deadlineLeft(deadlineAt) <= 0) {
    const err = new Error(`id_doc_budget_exhausted:${where || 'unknown'}`);
    err.code = 'ID_DOC_BUDGET';
    throw err;
  }
}

function logEvt(nome, source, step, extra) {
  const payload = Object.assign(
    {
      ts: Date.now(),
      source: String(source || ''),
      step: String(step || ''),
      day: todaySP()
    },
    extra || {}
  );
  try {
    stepLog.appendJSONL(nome, 'robe', Object.assign({ event: 'robe_id_doc', attempt: 0 }, payload));
  } catch {}
  try {
    provisionAudit.append(
      Object.assign({ event: `robe_id_doc_${step}`, nome: String(nome || '') }, payload)
    );
  } catch {}
  try {
    logger.info('[ROBE_ID_DOC]', Object.assign({ nome }, payload));
  } catch {}
}

async function readDoneDay(nome) {
  try {
    const man = await manifestStore.read(nome);
    const flags = (man && man.accountFlags) || {};
    return flags.robeIdDocDoneDay ? String(flags.robeIdDocDoneDay) : null;
  } catch {
    return null;
  }
}

async function isDoneToday(nome, now = Date.now()) {
  const day = await readDoneDay(nome);
  return isDoneTodayFromDay(day, now);
}

async function markDoneToday(nome) {
  const day = todaySP();
  await manifestStore.update(nome, (m) => {
    m = m || {};
    m.accountFlags = m.accountFlags || {};
    m.accountFlags.robeIdDocDoneDay = day;
    m.accountFlags.robeIdDocDoneAt = Date.now();
    return m;
  });
  return day;
}

async function pageAlive(page) {
  try {
    if (!page) return false;
    if (typeof page.isClosed === 'function' && page.isClosed()) return false;
    await page.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}

async function clickByText(page, patterns, { withinDialog = false, exact = false } = {}) {
  const pats = (Array.isArray(patterns) ? patterns : [patterns])
    .map((p) => norm(p))
    .filter(Boolean);
  if (!pats.length) return false;
  try {
    return await page.evaluate(
      (patsIn, withinDialogIn, exactIn) => {
        const normLocal = (s) => {
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
        const isDisabled = (el) =>
          el.getAttribute('aria-disabled') === 'true' ||
          el.getAttribute('disabled') != null ||
          String(el.getAttribute('tabindex') || '') === '-1' ||
          (typeof el.closest === 'function' && !!el.closest('[aria-disabled="true"]'));
        const tryClickIn = (root) => {
          const selectors =
            'button,[role="button"],a,[role="link"],[role="radio"],div[tabindex="0"],span[role="button"],[role="option"]';
          const nodes = Array.from(root.querySelectorAll(selectors));
          for (const el of nodes) {
            if (isDisabled(el)) continue;
            const aria = normLocal(el.getAttribute('aria-label') || '');
            const txt = normLocal(el.innerText || el.textContent || '');
            const label = `${aria} ${txt}`.trim();
            if (!label) continue;
            for (const p of patsIn) {
              const hit = exactIn
                ? aria === p || txt === p || label === p
                : aria === p || txt === p || aria.includes(p) || txt.includes(p) || label.includes(p);
              if (!hit) continue;
              try {
                el.click();
                return true;
              } catch {}
            }
          }
          return false;
        };
        // Checkpoint de identidade é página cheia (não dialog). Se withinDialog achar
        // dialogs irrelevantes e falhar, cai no document — sem engessar o fluxo.
        if (withinDialogIn) {
          const dialogs = Array.from(
            document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')
          );
          for (const d of dialogs) {
            if (tryClickIn(d)) return true;
          }
        }
        return tryClickIn(document);
      },
      pats,
      !!withinDialog,
      !!exact
    );
  } catch {
    return false;
  }
}

/** Espera calma até conseguir clicar (páginas de checkpoint são pesadas). */
async function waitClickByText(page, patterns, { maxMs = 90000, deadlineAt, withinDialog = false, exact = false, settleMs = WAIT_STEP_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    const ok = await clickByText(page, patterns, { withinDialog, exact });
    if (ok) {
      await sleep(settleMs);
      return true;
    }
    await sleep(2000);
  }
  return false;
}

async function detectIdWizardScreen(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => {
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
      const body = normLocal(document.body && (document.body.innerText || document.body.textContent) || '');
      const hasAria = (re) =>
        !!Array.from(document.querySelectorAll('[aria-label]')).find((el) =>
          re.test(normLocal(el.getAttribute('aria-label') || ''))
        );
      const hasFile = !!document.querySelector('input[type="file"]');
      if (
        body.includes('suas informacoes foram enviadas') ||
        body.includes('enviadas para verificacao') ||
        body.includes('your information was submitted')
      ) {
        return 'success';
      }
      // Pós-Enviar: “Confirmação de identidade em andamento” + Pronto
      if (
        body.includes('confirmacao de identidade em andamento') ||
        body.includes('normalmente analisamos suas informacoes') ||
        (body.includes('em andamento') && body.includes('48 horas')) ||
        (hasAria(/^pronto$/) && body.includes('em andamento'))
      ) {
        return 'pending_review';
      }
      if (hasFile || body.includes('carregue uma foto do seu documento')) return 'upload_photo';
      // doc_type: exige o título da lista (não basta “carteira…” solto no body)
      if (
        body.includes('escolha um tipo de documento') ||
        (body.includes('carteira de habilitacao') &&
          !!document.querySelector('[role="radio"], [role="listbox"]'))
      ) {
        return 'doc_type';
      }
      if (
        hasAria(/carregar documento de identidade/) ||
        body.includes('carregar seu documento de identidade') ||
        body.includes('carregar documento de identidade')
      ) {
        return 'carregar_doc';
      }
      if (
        body.includes('verificacao de identidade') ||
        body.includes('verificação de identidade') ||
        hasAria(/^continuar$/)
      ) {
        if (!hasAria(/carregar documento/)) return 'continuar';
      }
      if (
        hasAria(/confirme sua identidade/) ||
        body.includes('confirme sua identidade') ||
        body.includes('verifique sua identidade')
      ) {
        return 'confirm';
      }
      return 'unknown';
    });
  } catch {
    return 'unknown';
  }
}

async function waitForWizardScreen(page, wanted, { maxMs = 90000, deadlineAt } = {}) {
  const want = new Set(Array.isArray(wanted) ? wanted : [wanted]);
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    const scr = await detectIdWizardScreen(page);
    if (want.has(scr)) return scr;
    if (scr === 'success' || scr === 'pending_review') return scr;
    await sleep(2000);
  }
  return detectIdWizardScreen(page);
}

/** Probe forense da lista de documentos (radios). */
async function probeDocTypeRadios(page) {
  try {
    return await page.evaluate(() => {
      const normLocal = (s) => {
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
      const radios = Array.from(document.querySelectorAll('[role="radio"]'));
      return {
        radioCount: radios.length,
        items: radios.slice(0, 12).map((el) => {
          const txt = normLocal(el.innerText || el.textContent || '').slice(0, 80);
          return {
            txt,
            checked: el.getAttribute('aria-checked') === 'true',
            selected:
              el.getAttribute('aria-selected') === 'true' ||
              (el.closest('[role="option"]') &&
                el.closest('[role="option"]').getAttribute('aria-selected') === 'true')
          };
        }),
        cnhChecked: radios.some((el) => {
          const t = normLocal(el.innerText || el.textContent || '');
          const isCnh =
            t.includes('carteira de habilitacao') ||
            t.includes('driver license') ||
            t.includes("driver's license");
          if (!isCnh) return false;
          const opt = el.closest('[role="option"]');
          return (
            el.getAttribute('aria-checked') === 'true' ||
            (opt && opt.getAttribute('aria-selected') === 'true')
          );
        }),
        avancarEnabled: (() => {
          const nodes = Array.from(
            document.querySelectorAll('button,[role="button"],a,[role="link"],div[tabindex="0"]')
          );
          for (const el of nodes) {
            const label = normLocal(
              `${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`
            );
            if (!(label === 'avancar' || label.includes('avancar'))) continue;
            const disabled =
              el.getAttribute('aria-disabled') === 'true' ||
              el.getAttribute('disabled') != null ||
              String(el.getAttribute('tabindex') || '') === '-1';
            return !disabled;
          }
          return false;
        })()
      };
    });
  } catch (e) {
    return { radioCount: 0, items: [], cnhChecked: false, avancarEnabled: false, error: String((e && e.message) || e) };
  }
}

/**
 * Seleciona CNH de verdade: só [role=radio], verifica aria-checked.
 * Clique solto em option/div gerava falso positivo (ok=true) com Avançar apagado.
 */
async function selectDocTypeCnh(page) {
  const out = { clicked: false, verified: false, method: null, label: null };
  try {
    const evalClick = await page.evaluate(() => {
      const normLocal = (s) => {
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
      const isCnh = (t) =>
        t.includes('carteira de habilitacao') ||
        t.includes('driver license') ||
        t.includes("driver's license") ||
        t.includes('drivers license');
      const radios = Array.from(document.querySelectorAll('[role="radio"]'));
      for (const el of radios) {
        const label = normLocal(
          `${el.getAttribute('aria-label') || ''} ${el.innerText || ''} ${el.textContent || ''}`
        );
        if (!isCnh(label)) continue;
        try {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        // Sequência de ponteiro — FB lista controlada por React
        try {
          const opts = { bubbles: true, cancelable: true, view: window };
          el.dispatchEvent(new PointerEvent('pointerdown', opts));
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          el.dispatchEvent(new PointerEvent('pointerup', opts));
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
        } catch {
          try {
            el.click();
          } catch {}
        }
        const checked = el.getAttribute('aria-checked') === 'true';
        const opt = el.closest('[role="option"]');
        const selected = opt && opt.getAttribute('aria-selected') === 'true';
        return {
          clicked: true,
          verified: !!(checked || selected),
          label: label.slice(0, 80),
          checked,
          selected: !!selected
        };
      }
      return { clicked: false, verified: false, label: null };
    });
    Object.assign(out, evalClick || {});
    out.method = 'radio_pointer';

    if (out.clicked && !out.verified) {
      // Fallback Puppeteer: click no handle do radio CNH
      const handle = await page.evaluateHandle(() => {
        const normLocal = (s) => {
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
        const isCnh = (t) =>
          t.includes('carteira de habilitacao') ||
          t.includes('driver license') ||
          t.includes("driver's license");
        return (
          Array.from(document.querySelectorAll('[role="radio"]')).find((el) =>
            isCnh(normLocal(`${el.getAttribute('aria-label') || ''} ${el.innerText || ''}`))
          ) || null
        );
      });
      const el = handle && handle.asElement && handle.asElement();
      if (el) {
        try {
          await el.click({ delay: 40 });
          out.method = 'puppeteer_handle_click';
        } catch {}
        try {
          const box = await el.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 30 });
            out.method = 'puppeteer_mouse';
          }
        } catch {}
      }
      try {
        if (handle) await handle.dispose();
      } catch {}
      await sleep(800);
      const probe = await probeDocTypeRadios(page);
      out.verified = !!(probe && probe.cnhChecked);
    }

    if (out.clicked) {
      await sleep(600);
      const probe2 = await probeDocTypeRadios(page);
      out.verified = !!(probe2 && probe2.cnhChecked) || !!out.verified;
      out.avancarEnabled = !!(probe2 && probe2.avancarEnabled);
      out.radioCount = probe2 && probe2.radioCount;
    }
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 160);
  }
  return out;
}

async function waitCnhSelected(page, { maxMs = 90000, deadlineAt } = {}) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    const probe = await probeDocTypeRadios(page);
    last = probe;
    if (probe && probe.radioCount === 0) {
      await clickByText(page, ['ver mais', 'see more'], { withinDialog: false });
      await sleep(2000);
      continue;
    }
    if (probe && probe.cnhChecked && probe.avancarEnabled) {
      return { ok: true, probe };
    }
    const sel = await selectDocTypeCnh(page);
    last = Object.assign({}, probe || {}, sel || {});
    if (sel && sel.verified) {
      // Avançar pode habilitar com atraso curto
      for (let i = 0; i < 8; i++) {
        await sleep(700);
        const p2 = await probeDocTypeRadios(page);
        last = p2;
        if (p2 && p2.cnhChecked && p2.avancarEnabled) return { ok: true, probe: p2, sel };
        if (p2 && p2.cnhChecked) return { ok: true, probe: p2, sel, avancarPending: true };
      }
    }
    await clickByText(page, ['ver mais', 'see more'], { withinDialog: false });
    await sleep(2000);
  }
  return { ok: false, probe: last };
}

async function dismissTurbineUpsell(page, { deadlineAt } = {}) {
  assertBudget(deadlineAt, 'dismiss_start');
  const start = Date.now();
  while (Date.now() - start < 20000 && deadlineLeft(deadlineAt) > 0) {
    let state = null;
    try {
      state = await page.evaluate(() => {
        const normLocal = (s) => {
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
        const dialogs = Array.from(
          document.querySelectorAll('div[role="dialog"], [aria-modal="true"]')
        );
        for (const d of dialogs) {
          const al = normLocal(d.getAttribute('aria-label') || '');
          const txt = normLocal(d.innerText || d.textContent || '').slice(0, 400);
          const isTurbine =
            al.includes('turbine seu classificado') ||
            txt.includes('turbine seu classificado') ||
            txt.includes('promover agora');
          if (!isTurbine) continue;
          const close =
            d.querySelector('[aria-label="Fechar"]') ||
            d.querySelector('[aria-label*="Fechar"]') ||
            d.querySelector('[aria-label*="Close"]') ||
            Array.from(d.querySelectorAll('button,[role="button"]')).find((b) => {
              const t = normLocal(
                `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`
              );
              return (
                t.includes('fechar dialogo para turbinar') ||
                t.includes('fechar dialogo') ||
                t === 'fechar' ||
                t.includes('fechar')
              );
            });
          if (close && typeof close.click === 'function') {
            try {
              close.click();
              return { found: true, closed: true };
            } catch {
              return { found: true, closed: false };
            }
          }
          return { found: true, closed: false };
        }
        return { found: false, closed: false };
      });
    } catch {
      state = null;
    }

    if (!state || !state.found) return { ok: true, dismissed: false };
    if (state.closed) {
      await sleep(1500);
      return { ok: true, dismissed: true };
    }
    try {
      await page.keyboard.press('Escape');
    } catch {}
    await sleep(1200);
  }
  try {
    await page.keyboard.press('Escape');
  } catch {}
  await sleep(800);
  return { ok: true, dismissed: true, via: 'escape_timeout' };
}

async function ensureSellingFeed(page, { deadlineAt } = {}) {
  assertBudget(deadlineAt, 'selling_start');
  let onSelling = false;
  try {
    onSelling = await page.evaluate(
      () => /marketplace\/(you\/selling|you\/dashboard|profile)/.test(location.pathname || '')
    );
  } catch {
    onSelling = false;
  }
  if (!onSelling) {
    await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  }
  // DOM do selling é bem pesado — settle gordo.
  await sleep(Math.max(WAIT_FEED_SETTLE_MS, 14000));
  assertBudget(deadlineAt, 'selling_settle');
  return true;
}

function dateHintsSP(now = Date.now()) {
  const fmt = (ts, opts) => {
    try {
      return new Intl.DateTimeFormat('pt-BR', Object.assign({ timeZone: 'America/Sao_Paulo' }, opts)).format(new Date(ts));
    } catch {
      return '';
    }
  };
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    todayLabel: fmt(now, { day: 'numeric', month: 'long' }),
    todayShort: fmt(now, { day: '2-digit', month: '2-digit' }),
    yesterdayShort: fmt(now - dayMs, { day: '2-digit', month: '2-digit' }),
    todayDayMonth: fmt(now, { day: 'numeric', month: 'numeric' }),
    yesterdayDayMonth: fmt(now - dayMs, { day: 'numeric', month: 'numeric' })
  };
}

/**
 * Abre o classificado com "Uma ação é necessária…".
 * DOM real (selling): NÃO usa <a href="/marketplace/item/…"> no card.
 * Usa role=button aria-label=título + banner de ação; fallback: ⋮ → Ver classificado.
 */
async function openActionNeededListing(page, { mode = 'today', preferTitle = '' } = {}) {
  const prefer = String(preferTitle || '').trim();
  const hints = dateHintsSP();

  try {
    return await page.evaluate(
      (modeIn, preferIn, hintsIn) => {
        const normLocal = (s) => {
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
        const actionRe =
          /uma\s+acao\s+e\s+necessaria(\s+para\s+esse\s+classificado)?|acao\s+necessaria|action\s+required|se\s+requiere\s+una\s+accion/;
        const preferN = normLocal(preferIn).slice(0, 48);
        const dateHints = [
          'hoje',
          'today',
          'hoy',
          normLocal(hintsIn.todayLabel || ''),
          normLocal(hintsIn.todayShort || ''),
          normLocal(hintsIn.yesterdayShort || ''),
          normLocal(hintsIn.todayDayMonth || ''),
          normLocal(hintsIn.yesterdayDayMonth || '')
        ].filter(Boolean);

        const actionNodes = Array.from(
          document.querySelectorAll('div, span, h2, h3, p, a, [role="button"]')
        ).filter((el) => {
          const t = normLocal(el.innerText || el.textContent || '');
          // nó “folha” de ação: texto curto com a frase
          if (!t || t.length > 180) return false;
          return actionRe.test(t);
        });

        const cards = [];
        for (const node of actionNodes) {
          let root = node;
          for (let i = 0; i < 14 && root && root !== document.body; i++) {
            const txt = normLocal(root.innerText || root.textContent || '').slice(0, 1200);
            const hasAction = actionRe.test(txt);
            const hasMore =
              !!root.querySelector('[aria-label*="Mais opções"], [aria-label*="Mais opcoes"], [aria-label*="More options"]') ||
              /marcar como indisponivel|promover agora|anunciado em/.test(txt);
            if (hasAction && hasMore && (root.innerText || '').length < 3500) {
              break;
            }
            root = root.parentElement;
          }
          if (!root || root === document.body) root = node.parentElement || node;

          const txt = normLocal(root.innerText || root.textContent || '').slice(0, 1500);
          const preferHit = preferN
            ? txt.includes(preferN) ||
              Array.from(root.querySelectorAll('[aria-label]')).some((b) =>
                normLocal(b.getAttribute('aria-label') || '').includes(preferN)
              )
            : false;
          const looksToday =
            dateHints.some((h) => h && txt.includes(h)) ||
            /anunciado\s+em\s+\d{1,2}\/\d{1,2}/.test(txt) ||
            /\b(ha|há)\s+[±+]?\s*(uma|1|\d+)\s+(minuto|minutos|hora|horas)\b/.test(txt) ||
            /\bagora\b/.test(txt);

          // mode=today: título do post OU data de hoje/ontem (virada de meia-noite) OU
          // único card com ação (fallback).
          if (modeIn === 'today' && !preferHit && !looksToday) {
            // ainda guarda; filtramos depois se houver preferidos
            cards.push({ root, txt, preferHit, looksToday, weak: true });
          } else {
            cards.push({ root, txt, preferHit, looksToday, weak: false });
          }
        }

        if (!cards.length) return { found: false, reason: 'no_action_banner' };

        // Dedup por root
        const uniq = [];
        const seen = new Set();
        for (const c of cards) {
          if (seen.has(c.root)) continue;
          seen.add(c.root);
          uniq.push(c);
        }

        let pool = uniq.filter((c) => !c.weak);
        if (!pool.length && modeIn === 'firstAny') pool = uniq;
        if (!pool.length && preferN) pool = uniq.filter((c) => c.preferHit);
        // Se só existe 1 card com ação, usar mesmo fraco (pós-publish típico).
        if (!pool.length && uniq.length === 1) pool = uniq;
        if (!pool.length && modeIn === 'today') {
          // aceita cards com "anunciado em" qualquer dia recente se houver preferTitle parcial
          pool = uniq.filter((c) => /anunciado\s+em/.test(c.txt));
        }
        if (!pool.length) return { found: false, reason: 'action_filtered_out', totalBanners: uniq.length };

        pool.sort((a, b) => {
          if (a.preferHit !== b.preferHit) return a.preferHit ? -1 : 1;
          if (a.looksToday !== b.looksToday) return a.looksToday ? -1 : 1;
          return 0;
        });
        const pick = pool[0];
        try {
          pick.root.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}

        // 1) Clique preferencial: botão do título (aria-label), evitando Marcar/Promover/Mais opções.
        const titleBtns = Array.from(pick.root.querySelectorAll('[role="button"][aria-label]'));
        let titleBtn = null;
        for (const b of titleBtns) {
          const al = normLocal(b.getAttribute('aria-label') || '');
          if (!al) continue;
          if (
            al.includes('marcar como') ||
            al.includes('promover') ||
            al.includes('mais opcoes') ||
            al.includes('mais opções') ||
            al.includes('more options') ||
            al.includes('cliques')
          ) {
            continue;
          }
          if (preferN && al.includes(preferN)) {
            titleBtn = b;
            break;
          }
          if (!titleBtn) titleBtn = b;
        }
        if (titleBtn) {
          try {
            titleBtn.click();
            return {
              found: true,
              clicked: true,
              method: 'title_button',
              preferHit: !!pick.preferHit,
              aria: String(titleBtn.getAttribute('aria-label') || '').slice(0, 80)
            };
          } catch {}
        }

        // 2) Fallback seguro: ⋮ Mais opções → Ver classificado
        const more =
          pick.root.querySelector('[aria-label*="Mais opções"], [aria-label*="Mais opcoes"], [aria-label*="More options"]') ||
          Array.from(pick.root.querySelectorAll('[role="button"][aria-label]')).find((b) =>
            /mais opcoes|mais opções|more options/i.test(normLocal(b.getAttribute('aria-label') || ''))
          );
        if (more) {
          try {
            more.click();
            return {
              found: true,
              clicked: true,
              method: 'more_options_opened',
              preferHit: !!pick.preferHit,
              needVerClassificado: true
            };
          } catch {}
        }

        // 3) Último recurso: clicar no próprio banner de ação
        try {
          const banner = Array.from(pick.root.querySelectorAll('div, span')).find((el) =>
            actionRe.test(normLocal(el.innerText || el.textContent || '').slice(0, 120))
          );
          if (banner) {
            banner.click();
            return { found: true, clicked: true, method: 'action_banner', preferHit: !!pick.preferHit };
          }
        } catch {}

        return { found: true, clicked: false, method: 'none', preferHit: !!pick.preferHit };
      },
      mode,
      prefer,
      hints
    );
  } catch (e) {
    return { found: false, error: 'open_evaluate_failed:' + String((e && e.message) || e).slice(0, 120) };
  }
}

async function clickVerClassificadoMenu(page) {
  await sleep(2500);
  try {
    const clicked = await page.evaluate(() => {
      const normLocal = (s) => {
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
      const items = Array.from(document.querySelectorAll('[role="menuitem"], a[role="menuitem"], a'));
      for (const el of items) {
        const t = normLocal(`${el.getAttribute('aria-label') || ''} ${el.innerText || el.textContent || ''}`);
        if (t.includes('ver classificado') || t.includes('view listing') || t.includes('ver anuncio')) {
          try {
            el.click();
            return true;
          } catch {}
        }
        const href = el.getAttribute && el.getAttribute('href');
        if (href && /\/marketplace\/item\//.test(href) && t.includes('ver')) {
          try {
            el.click();
            return true;
          } catch {}
        }
      }
      return false;
    });
    return !!clicked;
  } catch {
    return false;
  }
}

async function waitListingIdentityPrompt(page, { maxMs = 45000, deadlineAt } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    try {
      const st = await page.evaluate(() => {
        const normLocal = (s) => {
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
        const body = normLocal(document.body && (document.body.innerText || '') || '');
        const btn = document.querySelector('[aria-label="Confirme sua identidade"], [aria-label*="Confirme sua identidade"]');
        return {
          hasBtn: !!btn,
          hasText:
            body.includes('confirme sua identidade') ||
            body.includes('verifique sua identidade para publicar') ||
            body.includes('verifique sua identidade'),
          onItem: /\/marketplace\/item\//.test(location.pathname || '')
        };
      });
      if (st && (st.hasBtn || st.hasText)) return st;
    } catch {}
    await sleep(2000);
  }
  return null;
}

/** Compat: scan antigo → agora abre o classificado. */
async function scanActionNeeded(page, opts) {
  return openActionNeededListing(page, opts);
}

async function findFileInputEverywhere(page) {
  const findInFrame = async (frame) => {
    try {
      const handle = await frame.$('input[type="file"]');
      if (handle) return handle;
    } catch {}
    return null;
  };
  let input = await findInFrame(page).catch(() => null);
  if (input) return input;
  for (const fr of page.frames()) {
    if (!fr || fr === page.mainFrame()) continue;
    input = await findInFrame(fr).catch(() => null);
    if (input) return input;
  }
  return null;
}

async function isPendingReviewScreen(page) {
  try {
    return !!(await page.evaluate(() => {
      const normLocal = (s) => {
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
      const hit = (t) =>
        t.includes('confirmacao de identidade em andamento') ||
        t.includes('confirmação de identidade em andamento') ||
        t.includes('identity confirmation in progress') ||
        t.includes('normalmente analisamos suas informacoes') ||
        t.includes('normalmente analisamos suas informações') ||
        (t.includes('em andamento') && t.includes('48 horas'));
      const body = normLocal(document.body && (document.body.innerText || document.body.textContent) || '');
      if (hit(body)) return true;
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
      for (const d of dialogs) {
        const t = normLocal(d.innerText || d.textContent || '');
        if (hit(t)) return true;
      }
      // Botão Pronto no dialog de identidade = variante pós-envio
      const pronto = Array.from(document.querySelectorAll('[aria-label],button,[role="button"]')).some((el) => {
        const al = normLocal(el.getAttribute('aria-label') || '');
        const tx = normLocal(el.innerText || '');
        return al === 'pronto' || tx === 'pronto';
      });
      if (pronto && (body.includes('confirmacao de identidade') || body.includes('em andamento'))) return true;
      return false;
    }));
  } catch {
    return false;
  }
}

async function isClassicSubmittedScreen(page) {
  try {
    return !!(await page.evaluate(() => {
      const normLocal = (s) => {
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
      const hit = (t) =>
        t.includes('suas informacoes foram enviadas') ||
        t.includes('enviadas para verificacao') ||
        t.includes('your information was submitted') ||
        t.includes('your information has been submitted') ||
        t.includes('enviamos suas informacoes') ||
        t.includes('informacoes foram enviadas');
      const body = normLocal(document.body && (document.body.innerText || document.body.textContent) || '');
      if (hit(body)) return true;
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
      for (const d of dialogs) {
        const t = normLocal(d.innerText || d.textContent || '');
        if (hit(t)) return true;
      }
      return false;
    }));
  } catch {
    return false;
  }
}

/** Sucesso pós-envio: tela clássica OU “em andamento” (Pronto). */
async function isSuccessScreen(page) {
  if (await isPendingReviewScreen(page)) return true;
  return isClassicSubmittedScreen(page);
}

async function waitForSuccessScreen(page, { maxMs, deadlineAt }) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    if (await isSuccessScreen(page)) return true;
    await sleep(2000);
  }
  return false;
}

async function clickProntoIfPresent(page, { maxMs = 30000, deadlineAt } = {}) {
  if (!(await isPendingReviewScreen(page))) return false;
  const ok = await waitClickByText(page, ['pronto', 'done'], {
    maxMs,
    deadlineAt,
    withinDialog: true,
    exact: true,
    settleMs: WAIT_STEP_MS
  });
  if (!ok) {
    // Fallback: aria-label exato no dialog
    try {
      const clicked = await page.evaluate(() => {
        const el =
          document.querySelector('[aria-label="Pronto"]') ||
          document.querySelector('[aria-label="Done"]');
        if (el && typeof el.click === 'function') {
          el.click();
          return true;
        }
        return false;
      });
      if (clicked) await sleep(WAIT_STEP_MS);
      return !!clicked;
    } catch {
      return false;
    }
  }
  return true;
}

async function closeSuccessDialog(page, { deadlineAt } = {}) {
  // Variante nova: “em andamento” → Pronto → depois Fechar
  const pronto = await clickProntoIfPresent(page, {
    maxMs: 45000,
    deadlineAt: deadlineAt || Date.now() + 45000
  });
  if (pronto) {
    // Após Pronto, esperar a tela com Fechar (calma — FB pesado)
    const start = Date.now();
    while (Date.now() - start < 60000) {
      const classic = await isClassicSubmittedScreen(page);
      const hasFechar = await clickByText(page, ['fechar', 'close'], { withinDialog: true });
      if (hasFechar) {
        await sleep(1500);
        return true;
      }
      if (classic) break;
      await sleep(2000);
    }
  }

  let clicked = await clickByText(page, ['fechar', 'close', 'concluido', 'ok'], {
    withinDialog: true
  });
  if (!clicked) {
    clicked = await clickByText(page, ['fechar', 'close', 'pronto'], { withinDialog: false, exact: true });
  }
  if (clicked) {
    await sleep(1500);
    return true;
  }
  try {
    await page.keyboard.press('Escape');
  } catch {}
  await sleep(1000);
  return true;
}

/**
 * Pós-Enviar: espera 1–120s+ → (Pronto se “em andamento”) → Fechar.
 */
async function finishAfterEnviar(page, { nome, source, deadlineAt } = {}) {
  let success = await waitForSuccessScreen(page, { maxMs: POLL_SUCCESS_MS, deadlineAt });
  if (!success && deadlineLeft(deadlineAt) > 15000) {
    logEvt(nome, source, 'wizard_refresh_retry', {});
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch {}
    await sleep(WAIT_FEED_SETTLE_MS);
    success = await waitForSuccessScreen(page, { maxMs: POLL_AFTER_REFRESH_MS, deadlineAt });
  }
  if (!success) return { ok: false, error: 'success_screen_timeout' };

  const pending = await isPendingReviewScreen(page);
  logEvt(nome, source, 'wizard_post_enviar_screen', {
    pending,
    classic: await isClassicSubmittedScreen(page)
  });

  if (pending) {
    const pronto = await clickProntoIfPresent(page, { maxMs: 60000, deadlineAt });
    logEvt(nome, source, 'wizard_pronto', { ok: !!pronto });
    if (!pronto) return { ok: false, error: 'pronto_not_clicked' };
    // Após Pronto: tela final com Fechar
    const fecharStart = Date.now();
    let closed = false;
    while (Date.now() - fecharStart < 90000 && deadlineLeft(deadlineAt) > 0) {
      closed = await clickByText(page, ['fechar', 'close'], { withinDialog: true });
      if (!closed) closed = await clickByText(page, ['fechar', 'close'], { withinDialog: false, exact: true });
      if (closed) break;
      // Às vezes ainda “Suas informações…” sem Fechar imediato
      if (await isClassicSubmittedScreen(page)) {
        await sleep(2000);
        continue;
      }
      await sleep(2000);
    }
    logEvt(nome, source, 'wizard_fechar', { ok: !!closed });
    if (closed) await sleep(1500);
    else {
      // Último recurso: Escape não invalida o envio já feito
      try {
        await page.keyboard.press('Escape');
      } catch {}
      await sleep(1000);
    }
  } else {
    await closeSuccessDialog(page, { deadlineAt });
    logEvt(nome, source, 'wizard_fechar', { ok: true, via: 'classic' });
  }

  return { ok: true };
}

async function finishAlreadySubmitted(page, { nome, source, where, deadlineAt } = {}) {
  logEvt(nome, source, 'already_submitted_after_' + String(where || 'step'), { ok: true });
  // Mesmo atalho: pode ser “em andamento” (Pronto) ou clássico (Fechar)
  if (await isPendingReviewScreen(page)) {
    const pronto = await clickProntoIfPresent(page, {
      maxMs: 45000,
      deadlineAt: deadlineAt || Date.now() + 45000
    });
    logEvt(nome, source, 'wizard_pronto', { ok: !!pronto, alreadySubmitted: true });
    await sleep(WAIT_STEP_MS);
  }
  await closeSuccessDialog(page, { deadlineAt: deadlineAt || Date.now() + 60000 });
  return { ok: true, alreadySubmitted: true };
}

async function scrollSellingToTop(page) {
  try {
    await page.evaluate(() => {
      try {
        window.scrollTo(0, 0);
        const main =
          document.querySelector('[role="main"]') ||
          document.scrollingElement ||
          document.documentElement;
        if (main && typeof main.scrollTo === 'function') main.scrollTo(0, 0);
      } catch {}
    });
  } catch {}
}

/**
 * Abre o classificado com “ação necessária” se o banner estiver no topo do selling.
 * Sem scroll-hunt: poucas leituras calmas no topo; se não houver banner, encerra.
 */
async function tryOpenActionNeededAtTop(
  page,
  { nome, source, mode = 'today', preferTitle = '', attempts = TOP_SCAN_ATTEMPTS_AUTO, deadlineAt } = {}
) {
  let scan = { found: false };
  let openedOk = false;

  for (let i = 0; i < attempts && deadlineLeft(deadlineAt) > 0; i++) {
    await scrollSellingToTop(page);
    if (i > 0) await sleep(TOP_SCAN_GAP_MS);

    scan = await openActionNeededListing(page, { mode, preferTitle: preferTitle || '' });
    logEvt(nome, source, 'open_attempt', {
      found: !!(scan && scan.found),
      method: (scan && scan.method) || null,
      reason: (scan && scan.reason) || null,
      preferHit: !!(scan && scan.preferHit),
      attempt: i + 1,
      attempts,
      topOnly: true
    });

    if (!(scan && scan.found)) continue;

    await sleep(4000);
    if (scan.needVerClassificado || scan.method === 'more_options_opened') {
      const ver = await clickVerClassificadoMenu(page);
      logEvt(nome, source, 'ver_classificado', { ok: !!ver });
      await sleep(5000);
    }

    const prompt = await waitListingIdentityPrompt(page, { maxMs: 50000, deadlineAt });
    if (prompt) {
      openedOk = true;
      break;
    }

    // Título pode ter aberto painel sem navegar — plano B: ⋮ → Ver classificado
    if (scan.method === 'title_button') {
      try {
        await page.evaluate(() => {
          const more = document.querySelector(
            '[aria-label*="Mais opções"], [aria-label*="Mais opcoes"], [aria-label*="More options"]'
          );
          if (more) more.click();
        });
      } catch {}
      await sleep(2500);
      await clickVerClassificadoMenu(page);
      await sleep(5000);
      const prompt2 = await waitListingIdentityPrompt(page, { maxMs: 45000, deadlineAt });
      if (prompt2) {
        openedOk = true;
        break;
      }
    }
    // Banner existia mas não abriu o prompt — não fica caçando mais cards abaixo.
    break;
  }

  return { openedOk, scan };
}

async function runIdDocWizard(page, { idPath, deadlineAt, nome, source } = {}) {
  assertBudget(deadlineAt, 'wizard_start');

  await sleep(WAIT_STEP_MS);

  // Já pode estar na tela final (ID feito antes).
  if (await isSuccessScreen(page)) {
    return finishAlreadySubmitted(page, { nome, source, where: 'open', deadlineAt });
  }

  let screen = await detectIdWizardScreen(page);
  logEvt(nome, source, 'wizard_screen', { screen });

  // 1) Confirme sua identidade (página do item / selling)
  if (screen === 'confirm' || screen === 'unknown') {
    let confirmBtn = await waitClickByText(
      page,
      ['confirme sua identidade', 'verifique sua identidade'],
      { maxMs: 60000, deadlineAt, withinDialog: false, settleMs: WAIT_STEP_MS + 2000 }
    );
    if (!confirmBtn) {
      try {
        confirmBtn = await page.evaluate(() => {
          const el =
            document.querySelector('[aria-label="Confirme sua identidade"]') ||
            document.querySelector('[aria-label*="Confirme sua identidade"]');
          if (el && typeof el.click === 'function') {
            el.click();
            return true;
          }
          return false;
        });
        if (confirmBtn) await sleep(WAIT_STEP_MS + 2000);
      } catch {
        confirmBtn = false;
      }
    }
    logEvt(nome, source, 'wizard_confirme_identidade', { ok: !!confirmBtn });
    assertBudget(deadlineAt, 'wizard_after_confirm_btn');
    if (await isSuccessScreen(page)) {
      return finishAlreadySubmitted(page, { nome, source, where: 'confirm_btn', deadlineAt });
    }
    screen = await detectIdWizardScreen(page);
  }

  // 2) Avançar / "A seguir: continue para a verificação…"
  if (screen !== 'continuar' && screen !== 'carregar_doc' && screen !== 'doc_type' && screen !== 'upload_photo' && screen !== 'success') {
    let advanced = await waitClickByText(
      page,
      [
        'a seguir: continue para a verificacao',
        'a seguir: continue para a verificação',
        'continue para a verificacao',
        'continue para a verificação',
        'avancar',
        'avançar'
      ],
      { maxMs: 90000, deadlineAt, withinDialog: false, settleMs: WAIT_STEP_MS + 3000 }
    );
    if (!advanced) {
      try {
        advanced = await page.evaluate(() => {
          const el =
            document.querySelector('[aria-label*="A seguir"]') ||
            document.querySelector(
              '[aria-label*="verificação de identidade"], [aria-label*="verificacao de identidade"]'
            );
          if (el && typeof el.click === 'function') {
            el.click();
            return true;
          }
          return false;
        });
        if (advanced) await sleep(WAIT_STEP_MS + 3000);
      } catch {
        advanced = false;
      }
    }
    logEvt(nome, source, 'wizard_avancar', { ok: !!advanced });
    assertBudget(deadlineAt, 'wizard_after_avancar');

    // Atalho: às vezes Avançar → direto "Suas informações foram enviadas..."
    {
      const earlyScr = await waitForWizardScreen(page, ['success', 'continuar', 'carregar_doc'], {
        maxMs: 45000,
        deadlineAt
      });
      if (earlyScr === 'success' || earlyScr === 'pending_review') {
        return finishAlreadySubmitted(page, { nome, source, where: 'avancar', deadlineAt });
      }
      screen = earlyScr;
    }
  }

  // 3) Continuar (tela "Verificação de identidade")
  if (screen === 'continuar' || screen === 'unknown') {
    const cont = await waitClickByText(page, ['continuar', 'continue'], {
      maxMs: 90000,
      deadlineAt,
      withinDialog: false,
      exact: true,
      settleMs: WAIT_STEP_MS + 3000
    });
    logEvt(nome, source, 'wizard_continuar', { ok: !!cont });
    assertBudget(deadlineAt, 'wizard_after_continuar');
    screen = await waitForWizardScreen(page, ['success', 'carregar_doc', 'doc_type'], {
      maxMs: cont ? 60000 : 20000,
      deadlineAt
    });
    if (screen === 'success' || screen === 'pending_review') {
      return finishAlreadySubmitted(page, { nome, source, where: 'continuar', deadlineAt });
    }
    // Sem avançar de tela: falha explícita (não queimar budget no passo seguinte).
    if (!cont && screen !== 'carregar_doc' && screen !== 'doc_type' && screen !== 'upload_photo') {
      return { ok: false, error: 'continuar_not_clicked' };
    }
  }

  // A partir daqui precisa do documento físico.
  if (!idPath || !fs.existsSync(idPath)) {
    return { ok: false, error: 'id_png_missing' };
  }

  // 4) CRÍTICO (faltava): "Carregar documento de identidade"
  if (screen === 'carregar_doc' || screen === 'unknown' || screen === 'continuar') {
    const loadDoc = await waitClickByText(
      page,
      [
        'carregar documento de identidade',
        'carregar seu documento de identidade',
        'upload identity document',
        'upload your id'
      ],
      { maxMs: 120000, deadlineAt, withinDialog: false, settleMs: WAIT_STEP_MS + 3000 }
    );
    logEvt(nome, source, 'wizard_carregar_documento', { ok: !!loadDoc, screenBefore: screen });
    if (!loadDoc) {
      // Se já estamos em doc_type/upload, ok; senão falha explícita.
      screen = await detectIdWizardScreen(page);
      if (screen !== 'doc_type' && screen !== 'upload_photo') {
        return { ok: false, error: 'carregar_documento_not_clicked' };
      }
    } else {
      screen = await waitForWizardScreen(page, ['doc_type', 'upload_photo'], {
        maxMs: 90000,
        deadlineAt
      });
    }
  }

  // 5) Escolha tipo: Carteira de habilitação (radio) → Avançar fica clicável
  if (screen === 'doc_type' || screen === 'unknown') {
    const before = await probeDocTypeRadios(page);
    logEvt(nome, source, 'wizard_cnh_probe', {
      radioCount: before && before.radioCount,
      cnhChecked: !!(before && before.cnhChecked),
      avancarEnabled: !!(before && before.avancarEnabled),
      items: (before && before.items) || []
    });

    const cnhWait = await waitCnhSelected(page, { maxMs: 120000, deadlineAt });
    const cnhOk = !!(cnhWait && cnhWait.ok);
    logEvt(nome, source, 'wizard_cnh', {
      ok: cnhOk,
      verified: cnhOk,
      cnhChecked: !!(cnhWait && cnhWait.probe && cnhWait.probe.cnhChecked),
      avancarEnabled: !!(cnhWait && cnhWait.probe && cnhWait.probe.avancarEnabled),
      radioCount: cnhWait && cnhWait.probe && cnhWait.probe.radioCount,
      items: (cnhWait && cnhWait.probe && cnhWait.probe.items) || []
    });
    if (!cnhOk) return { ok: false, error: 'cnh_not_selected' };
    await sleep(WAIT_STEP_MS);
    assertBudget(deadlineAt, 'wizard_after_cnh');

    // 6) Avançar pós-CNH — só faz sentido com radio verificado
    const advDoc = await waitClickByText(page, ['avancar', 'avançar', 'next'], {
      maxMs: 90000,
      deadlineAt,
      withinDialog: false,
      settleMs: WAIT_STEP_MS + 3000
    });
    logEvt(nome, source, 'wizard_avancar_pos_cnh', { ok: !!advDoc });
    if (!advDoc) return { ok: false, error: 'avancar_pos_cnh_not_clicked' };
    screen = await waitForWizardScreen(page, ['upload_photo'], { maxMs: 90000, deadlineAt });
  }

  // 7) Upload id.png via input[type=file] (mesmo padrão do ROBE de fotos)
  let input = null;
  const findStart = Date.now();
  while (!input && Date.now() - findStart < 120000 && deadlineLeft(deadlineAt) > 0) {
    input = await findFileInputEverywhere(page);
    if (input) break;
    // UI mostra botão "Carregar" — clicar ajuda a montar o input em alguns builds.
    await clickByText(page, ['carregar', 'upload', 'adicionar arquivo', 'escolher arquivo'], {
      withinDialog: false,
      exact: false
    });
    await sleep(2500);
  }
  if (!input) {
    return { ok: false, error: 'file_input_not_found' };
  }
  try {
    await input.uploadFile(idPath);
  } catch (e) {
    return { ok: false, error: `upload_failed:${(e && e.message) || e}` };
  }
  logEvt(nome, source, 'wizard_upload', { ok: true });
  await sleep(WAIT_AFTER_UPLOAD_MS);
  assertBudget(deadlineAt, 'wizard_after_upload');

  // 8) Enviar (fica azul só depois do arquivo)
  const sent = await waitClickByText(page, ['enviar', 'submit', 'send'], {
    maxMs: 90000,
    deadlineAt,
    withinDialog: false,
    exact: true,
    settleMs: 3000
  });
  logEvt(nome, source, 'wizard_enviar', { ok: !!sent });
  if (!sent) return { ok: false, error: 'enviar_not_clicked' };

  // 9) Pós-Enviar: 1–120s → (em andamento → Pronto) → Fechar
  const finished = await finishAfterEnviar(page, { nome, source, deadlineAt });
  if (!(finished && finished.ok)) {
    return { ok: false, error: (finished && finished.error) || 'post_enviar_failed' };
  }

  logEvt(nome, source, 'wizard_success', { ok: true });
  return { ok: true };
}

async function runRobeAutoId({ page, nome, titulo, deadlineAt } = {}) {
  const startedAt = Date.now();
  const source = 'auto';
  const hardDeadline = Number(deadlineAt) || Date.now() + BUDGET_TOTAL_MS;

  try {
    if (!(await pageAlive(page))) {
      logEvt(nome, source, 'skip_page_gone', {});
      return { ok: true, skipped: true, reason: 'page_gone' };
    }

    // ID - sim: encerra na hora. Sem selling, sem scan, sem scroll.
    const done = await isDoneToday(nome);
    if (done) {
      logEvt(nome, source, 'skip_already_done_today', { durationMs: Date.now() - startedAt });
      return { ok: true, skipped: true, reason: 'already_done_today' };
    }

    await sleep(WAIT_POST_SETTLE_MS);
    try {
      await dismissTurbineUpsell(page, { deadlineAt: Math.min(hardDeadline, Date.now() + 20000) });
    } catch (e) {
      logEvt(nome, source, 'dismiss_err', { error: String((e && e.message) || e).slice(0, 160) });
    }

    // Budget gordo para o restante (só se ID - nao).
    const workDeadline = Math.min(hardDeadline, Date.now() + BUDGET_TOTAL_MS);

    if (!(await pageAlive(page))) {
      logEvt(nome, source, 'skip_page_gone_after_dismiss', {});
      return { ok: true, skipped: true, reason: 'page_gone' };
    }

    await ensureSellingFeed(page, { deadlineAt: workDeadline });
    assertBudget(workDeadline, 'auto_after_selling');

    // ID - nao: banner no topo. Sem scroll-hunt.
    const { openedOk, scan } = await tryOpenActionNeededAtTop(page, {
      nome,
      source,
      mode: 'today',
      preferTitle: titulo || '',
      attempts: TOP_SCAN_ATTEMPTS_AUTO,
      deadlineAt: workDeadline
    });

    if (!openedOk && !(scan && scan.found)) {
      logEvt(nome, source, 'no_action_needed_today', {
        durationMs: Date.now() - startedAt,
        topOnly: true
      });
      return { ok: true, skipped: true, reason: 'no_action_needed_today' };
    }
    if (!openedOk) {
      logEvt(nome, source, 'open_listing_failed', {
        method: (scan && scan.method) || null,
        durationMs: Date.now() - startedAt
      });
      return { ok: false, error: 'open_listing_failed' };
    }

    await sleep(WAIT_STEP_MS);

    const wiz = await runIdDocWizard(page, {
      idPath: ID_PNG_PATH,
      deadlineAt: workDeadline,
      nome,
      source
    });

    if (wiz && wiz.ok) {
      const day = await markDoneToday(nome);
      logEvt(nome, source, 'marked_sim', {
        day,
        alreadySubmitted: !!wiz.alreadySubmitted,
        durationMs: Date.now() - startedAt
      });
      return { ok: true, marked: true, day, alreadySubmitted: !!wiz.alreadySubmitted };
    }

    logEvt(nome, source, 'wizard_failed', {
      error: (wiz && wiz.error) || 'unknown',
      durationMs: Date.now() - startedAt
    });
    return { ok: false, error: (wiz && wiz.error) || 'wizard_failed' };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logEvt(nome, source, 'auto_exception', { error: String(msg).slice(0, 220), durationMs: Date.now() - startedAt });
    return { ok: false, error: msg };
  }
}

async function runHumanVerifyId({ page, nome, deadlineAt } = {}) {
  const startedAt = Date.now();
  const source = 'human';
  const workDeadline = Number(deadlineAt) || Date.now() + BUDGET_TOTAL_MS;

  try {
    if (!(await pageAlive(page))) {
      logEvt(nome, source, 'human_page_gone', {});
      return { ok: false, error: 'page_gone' };
    }

    try {
      await dismissTurbineUpsell(page, { deadlineAt: Math.min(workDeadline, Date.now() + 20000) });
    } catch {}

    await ensureSellingFeed(page, { deadlineAt: workDeadline });

    // Humano força o fluxo, mas banner também fica no topo — sem scroll-hunt.
    const { openedOk, scan } = await tryOpenActionNeededAtTop(page, {
      nome,
      source,
      mode: 'firstAny',
      preferTitle: '',
      attempts: TOP_SCAN_ATTEMPTS_HUMAN,
      deadlineAt: workDeadline
    });

    if (!openedOk) {
      logEvt(nome, source, 'human_no_action', {
        durationMs: Date.now() - startedAt,
        found: !!(scan && scan.found),
        method: (scan && scan.method) || null,
        topOnly: true
      });
      return { ok: false, error: (scan && scan.found) ? 'open_listing_failed' : 'no_action_needed' };
    }

    await sleep(WAIT_STEP_MS);
    const wiz = await runIdDocWizard(page, {
      idPath: ID_PNG_PATH,
      deadlineAt: workDeadline,
      nome,
      source
    });

    // CONTRATO: humano NUNCA marca robeIdDocDoneDay
    logEvt(nome, source, wiz && wiz.ok ? 'human_wizard_ok_no_mark' : 'human_wizard_fail', {
      error: wiz && wiz.error ? wiz.error : null,
      durationMs: Date.now() - startedAt,
      markSim: false
    });
    if (wiz && wiz.ok) return { ok: true, marked: false };
    return { ok: false, error: (wiz && wiz.error) || 'wizard_failed', marked: false };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logEvt(nome, source, 'human_exception', { error: String(msg).slice(0, 220) });
    return { ok: false, error: msg, marked: false };
  }
}

module.exports = {
  BUDGET_TOTAL_MS,
  BUDGET_SKIP_MS,
  ID_PNG_PATH,
  todaySP,
  isDoneTodayFromDay,
  isDoneToday,
  readDoneDay,
  markDoneToday,
  getIdPngPath,
  idPngExists,
  dismissTurbineUpsell,
  ensureSellingFeed,
  scanActionNeeded,
  openActionNeededListing,
  clickVerClassificadoMenu,
  waitListingIdentityPrompt,
  runIdDocWizard,
  runRobeAutoId,
  runHumanVerifyId
};
