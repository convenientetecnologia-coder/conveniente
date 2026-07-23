'use strict';

/**
 * ROBE pós-publicação / overlay humano — verificação de documento Marketplace (id.png).
 *
 * Contrato forense:
 * - Default: ID - nao (ausência de robeIdDocDoneDay ou dia ≠ hoje SP).
 * - Só runRobeAutoId marca robeIdDocDoneDay após wizard ok.
 * - runHumanVerifyId NUNCA marca a flag.
 * - Falha/timeout NUNCA invalida publish_ok (caller engole erros).
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

async function clickByText(page, patterns, { withinDialog = false } = {}) {
  const pats = (Array.isArray(patterns) ? patterns : [patterns])
    .map((p) => norm(p))
    .filter(Boolean);
  if (!pats.length) return false;
  try {
    return await page.evaluate(
      (patsIn, withinDialogIn) => {
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
        const roots = [];
        if (withinDialogIn) {
          document
            .querySelectorAll('div[role="dialog"], [aria-modal="true"]')
            .forEach((d) => roots.push(d));
        }
        if (!roots.length) roots.push(document);
        const selectors = 'button,[role="button"],a,div[tabindex="0"],span[role="button"]';
        for (const root of roots) {
          const nodes = Array.from(root.querySelectorAll(selectors));
          for (const el of nodes) {
            const label = normLocal(
              `${el.getAttribute('aria-label') || ''} ${el.innerText || ''} ${el.textContent || ''}`
            );
            if (!label) continue;
            const disabled =
              el.getAttribute('aria-disabled') === 'true' ||
              el.getAttribute('disabled') != null ||
              String(el.getAttribute('tabindex') || '') === '-1';
            if (disabled) continue;
            for (const p of patsIn) {
              if (label === p || label.includes(p)) {
                try {
                  el.click();
                  return true;
                } catch {}
              }
            }
          }
        }
        return false;
      },
      pats,
      !!withinDialog
    );
  } catch {
    return false;
  }
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
  await sleep(WAIT_FEED_SETTLE_MS);
  assertBudget(deadlineAt, 'selling_settle');
  return true;
}

async function scanActionNeeded(page, { mode = 'today', preferTitle = '' } = {}) {
  const prefer = String(preferTitle || '').trim();
  const todayLabel = (() => {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: 'numeric',
        month: 'long'
      }).format(new Date());
    } catch {
      return '';
    }
  })();
  const todayShort = (() => {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit'
      }).format(new Date());
    } catch {
      return '';
    }
  })();

  try {
    return await page.evaluate(
      (modeIn, preferIn, todayLabelIn, todayShortIn) => {
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
          /uma\s+acao\s+e\s+necessaria|acao\s+necessaria|action\s+required|se\s+requiere\s+una\s+accion/;
        const todayHints = ['hoje', 'today', 'hoy'];
        if (todayLabelIn) todayHints.push(normLocal(todayLabelIn));
        if (todayShortIn) todayHints.push(normLocal(todayShortIn));

        const preferN = normLocal(preferIn).slice(0, 40);
        const candidates = [];

        const anchors = Array.from(document.querySelectorAll('a[href*="/marketplace/item/"], a[href*="marketplace"]'));
        const blocks = anchors.length
          ? anchors
          : Array.from(document.querySelectorAll('div[role="article"], div[role="listitem"], div')).slice(0, 1200);

        for (const el of blocks) {
          const txtRaw = (el.innerText || el.textContent || '').slice(0, 800);
          const txt = normLocal(txtRaw);
          if (!txt || !actionRe.test(txt)) continue;
          const preferHit = preferN ? txt.includes(preferN) : false;
          const looksToday =
            todayHints.some((h) => h && txt.includes(h)) ||
            /\bhoje\b/.test(txt) ||
            /\b(ha|há)\s+\d+\s+(minuto|minutos|hora|horas)\b/.test(txt) ||
            /\b\d+\s+(min|mins|h)\b/.test(txt) ||
            /\bagora\b/.test(txt);
          // mode=today: exige sinal de hoje OU match do título recém-publicado
          if (modeIn === 'today' && !looksToday && !preferHit) continue;
          const href = el.getAttribute && el.getAttribute('href');
          candidates.push({
            el,
            txt,
            href: href || '',
            preferHit
          });
        }

        if (!candidates.length) return { found: false };

        candidates.sort((a, b) => {
          if (a.preferHit !== b.preferHit) return a.preferHit ? -1 : 1;
          return 0;
        });
        const pick = candidates[0];
        try {
          pick.el.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        try {
          pick.el.click();
          return { found: true, clicked: true, preferHit: !!pick.preferHit };
        } catch {
          return { found: true, clicked: false, preferHit: !!pick.preferHit };
        }
      },
      mode,
      prefer,
      todayLabel,
      todayShort
    );
  } catch {
    return { found: false, error: 'scan_evaluate_failed' };
  }
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

async function isSuccessScreen(page) {
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

async function waitForSuccessScreen(page, { maxMs, deadlineAt }) {
  const start = Date.now();
  while (Date.now() - start < maxMs && deadlineLeft(deadlineAt) > 0) {
    if (await isSuccessScreen(page)) return true;
    await sleep(2000);
  }
  return false;
}

async function closeSuccessDialog(page) {
  const clicked = await clickByText(page, ['fechar', 'close', 'concluido', 'ok'], { withinDialog: true });
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

async function finishAlreadySubmitted(page, { nome, source, where } = {}) {
  logEvt(nome, source, 'already_submitted_after_' + String(where || 'step'), { ok: true });
  await closeSuccessDialog(page);
  return { ok: true, alreadySubmitted: true };
}

async function runIdDocWizard(page, { idPath, deadlineAt, nome, source } = {}) {
  assertBudget(deadlineAt, 'wizard_start');

  await sleep(WAIT_STEP_MS);

  // Já pode estar na tela final (ID feito antes).
  if (await isSuccessScreen(page)) {
    return finishAlreadySubmitted(page, { nome, source, where: 'open' });
  }

  // Confirme sua identidade → Avançar
  let advanced = await clickByText(
    page,
    ['avancar', 'avançar', 'continue', 'next'],
    { withinDialog: true }
  );
  if (!advanced) {
    advanced = await clickByText(page, ['avancar', 'avançar', 'continuar', 'continue'], {
      withinDialog: false
    });
  }
  logEvt(nome, source, 'wizard_avancar', { ok: !!advanced });
  await sleep(WAIT_STEP_MS);
  assertBudget(deadlineAt, 'wizard_after_avancar');

  // Atalho crítico: Avançar → direto "Suas informações foram enviadas..."
  // (ID já feito por humano/outro fluxo). Considerar concluído.
  {
    const early = await waitForSuccessScreen(page, {
      maxMs: 20000,
      deadlineAt
    });
    if (early) {
      return finishAlreadySubmitted(page, { nome, source, where: 'avancar' });
    }
  }

  // Continuar
  let cont = await clickByText(page, ['continuar', 'continue', 'avancar', 'avançar'], {
    withinDialog: true
  });
  if (!cont) cont = await clickByText(page, ['continuar', 'continue'], { withinDialog: false });
  logEvt(nome, source, 'wizard_continuar', { ok: !!cont });
  await sleep(WAIT_STEP_MS);
  assertBudget(deadlineAt, 'wizard_after_continuar');

  // Mesmo atalho após Continuar (FB às vezes salta etapas).
  {
    const early2 = await waitForSuccessScreen(page, {
      maxMs: 12000,
      deadlineAt
    });
    if (early2) {
      return finishAlreadySubmitted(page, { nome, source, where: 'continuar' });
    }
  }

  // A partir daqui precisa do documento.
  if (!idPath || !fs.existsSync(idPath)) {
    return { ok: false, error: 'id_png_missing' };
  }

  // Carteira de habilitação
  let cnh = await clickByText(
    page,
    [
      'carteira de habilitacao',
      'carteira de habilitação',
      'driver license',
      "driver's license",
      'drivers license',
      'cnh'
    ],
    { withinDialog: true }
  );
  if (!cnh) {
    cnh = await clickByText(
      page,
      ['carteira de habilitacao', 'carteira de habilitação', 'driver license', 'cnh'],
      { withinDialog: false }
    );
  }
  logEvt(nome, source, 'wizard_cnh', { ok: !!cnh });
  await sleep(WAIT_STEP_MS);
  assertBudget(deadlineAt, 'wizard_after_cnh');

  // File input + upload
  let input = null;
  const findStart = Date.now();
  while (!input && Date.now() - findStart < 30000 && deadlineLeft(deadlineAt) > 0) {
    input = await findFileInputEverywhere(page);
    if (input) break;
    // tenta clicar em área de upload
    await clickByText(
      page,
      ['adicionar arquivo', 'enviar arquivo', 'upload', 'escolher arquivo', 'selecionar arquivo', 'add file'],
      { withinDialog: true }
    );
    await sleep(2000);
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

  // Enviar
  let sent = await clickByText(page, ['enviar', 'submit', 'send'], { withinDialog: true });
  if (!sent) sent = await clickByText(page, ['enviar', 'submit', 'send'], { withinDialog: false });
  logEvt(nome, source, 'wizard_enviar', { ok: !!sent });
  if (!sent) return { ok: false, error: 'enviar_not_clicked' };

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

  await closeSuccessDialog(page);
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

    await sleep(WAIT_POST_SETTLE_MS);
    try {
      await dismissTurbineUpsell(page, { deadlineAt: Math.min(hardDeadline, Date.now() + 20000) });
    } catch (e) {
      logEvt(nome, source, 'dismiss_err', { error: String((e && e.message) || e).slice(0, 160) });
    }

    const done = await isDoneToday(nome);
    if (done) {
      logEvt(nome, source, 'skip_already_done_today', { durationMs: Date.now() - startedAt });
      return { ok: true, skipped: true, reason: 'already_done_today' };
    }

    // Budget gordo para o restante.
    // Nota: id.png só é obrigatório se o FB pedir upload; se Avançar já cair na tela final,
    // marcamos sim mesmo sem arquivo (ID já feito antes).
    const workDeadline = Math.min(hardDeadline, Date.now() + BUDGET_TOTAL_MS);

    if (!(await pageAlive(page))) {
      logEvt(nome, source, 'skip_page_gone_after_dismiss', {});
      return { ok: true, skipped: true, reason: 'page_gone' };
    }

    await ensureSellingFeed(page, { deadlineAt: workDeadline });
    assertBudget(workDeadline, 'auto_after_selling');

    const scanStart = Date.now();
    let scan = { found: false };
    while (Date.now() - scanStart < 45000 && deadlineLeft(workDeadline) > 0) {
      scan = await scanActionNeeded(page, { mode: 'today', preferTitle: titulo || '' });
      if (scan && scan.found) break;
      try {
        await page.evaluate(() => {
          try {
            window.scrollBy(0, 400);
          } catch {}
        });
      } catch {}
      await sleep(2500);
    }

    if (!scan || !scan.found) {
      logEvt(nome, source, 'no_action_needed_today', { durationMs: Date.now() - startedAt });
      return { ok: true, skipped: true, reason: 'no_action_needed_today' };
    }

    if (!scan.clicked) {
      await sleep(2000);
    } else {
      await sleep(WAIT_STEP_MS);
    }

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

    const scanStart = Date.now();
    let scan = { found: false };
    while (Date.now() - scanStart < 45000 && deadlineLeft(workDeadline) > 0) {
      scan = await scanActionNeeded(page, { mode: 'firstAny', preferTitle: '' });
      if (scan && scan.found) break;
      try {
        await page.evaluate(() => {
          try {
            window.scrollBy(0, 400);
          } catch {}
        });
      } catch {}
      await sleep(2500);
    }

    if (!scan || !scan.found) {
      logEvt(nome, source, 'human_no_action', { durationMs: Date.now() - startedAt });
      return { ok: false, error: 'no_action_needed' };
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
  runIdDocWizard,
  runRobeAutoId,
  runHumanVerifyId
};
