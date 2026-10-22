"use strict";

const fs = require("fs");
const path = require("path");
const serverConfig = require("./serverConfig");
const { createClient } = require("./anuncioCtClient");
const {
  judgeListing,
  nomeEhNosso,
  pickMoreOptions,
  pickMenuItem,
  pickClassificado,
  pickConcluir,
  listingProbe,
  moreOptionsProbe,
  menuProbe,
  classificadoProbe,
  clickClassificado,
  concluirProbe,
  clickConcluir
} = require("./anuncioSignals");

const BUDGET_TOTAL_MS = 15 * 60 * 1000;
const NAV_TIMEOUT_MS = 60000;
const POLL_GAP_MS = 2000;
const JUDGE_BUDGET_MS = 90000;
const CONTROL_BUDGET_MS = 60000;
const AFTER_CLICK_MS = 8000;
const HOSTID_PATH = path.join(__dirname, "..", "dados", ".telemetry_hostid");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function readContext() {
  const cfg = serverConfig.readServerConfigEffective();
  const country = String(cfg && cfg.country && cfg.country.id || "").trim().toLowerCase();
  let servidor = "";
  try {
    if (fs.existsSync(HOSTID_PATH)) servidor = String(fs.readFileSync(HOSTID_PATH, "utf8") || "").trim();
  } catch {}
  return {
    enabled: !!(cfg && cfg.anuncio && cfg.anuncio.enabled === true),
    country,
    servidor,
    base: createClient().base
  };
}

async function waitPoll(deadlineAt, gapMs, read) {
  while (Date.now() < deadlineAt) {
    const value = await read();
    if (value != null) return value;
    const left = deadlineAt - Date.now();
    if (left <= 0) break;
    await sleep(Math.min(gapMs, left));
  }
  return null;
}

function createPageActions(page) {
  return {
    async open(url, deadlineAt) {
      const timeout = Math.max(1000, Math.min(NAV_TIMEOUT_MS, deadlineAt - Date.now()));
      if (timeout < 5000) return { ok: false };
      await page.goto(String(url), { waitUntil: "domcontentloaded", timeout });
      return { ok: true };
    },
    async judge(deadlineAt) {
      const slice = Math.min(deadlineAt, Date.now() + JUDGE_BUDGET_MS);
      return waitPoll(slice, POLL_GAP_MS, async () => {
        const raw = await page.evaluate(listingProbe);
        const judged = judgeListing(raw || {});
        if (judged.kind === "unavailable" || judged.kind === "seller") return judged;
        return null;
      });
    },
    async denounce(deadlineAt) {
      const buttonDeadline = Math.min(deadlineAt, Date.now() + CONTROL_BUDGET_MS);
      const buttonIndex = await waitPoll(buttonDeadline, POLL_GAP_MS, async () => {
        const buttons = await page.evaluate(moreOptionsProbe);
        return pickMoreOptions(buttons);
      });
      if (buttonIndex == null) return { ok: false, reason: "mais_opcoes_ausente" };
      const clickedButton = await page.evaluate((index) => {
        const buttons = Array.from(document.querySelectorAll('[role="button"][aria-label="Mais opções de item"]'));
        const button = buttons[index];
        if (!button) return false;
        button.click();
        return true;
      }, buttonIndex);
      if (!clickedButton) return { ok: false, reason: "mais_opcoes_ausente" };
      const menuDeadline = Math.min(deadlineAt, Date.now() + CONTROL_BUDGET_MS);
      const menuIndex = await waitPoll(menuDeadline, POLL_GAP_MS, async () => {
        const texts = await page.evaluate(menuProbe);
        return pickMenuItem(texts);
      });
      if (menuIndex == null) return { ok: false, reason: "menu_ausente" };
      const clickedMenu = await page.evaluate((index) => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        const item = items[index];
        if (!item) return false;
        item.click();
        return true;
      }, menuIndex);
      if (!clickedMenu) return { ok: false, reason: "menu_ausente" };
      const rowDeadline = Math.min(deadlineAt, Date.now() + CONTROL_BUDGET_MS);
      const rowPick = await waitPoll(rowDeadline, POLL_GAP_MS, async () => {
        const labels = await page.evaluate(classificadoProbe);
        const picked = pickClassificado(labels);
        if (picked && typeof picked === "object") return picked;
        return picked;
      });
      if (rowPick == null || (rowPick && rowPick.ambiguous)) {
        return { ok: false, reason: "classificado_ausente" };
      }
      const clickedRow = await page.evaluate(clickClassificado);
      if (!clickedRow) return { ok: false, reason: "classificado_ausente" };
      const finishDeadline = Math.min(deadlineAt, Date.now() + CONTROL_BUDGET_MS);
      const finishPick = await waitPoll(finishDeadline, POLL_GAP_MS, async () => {
        const buttons = await page.evaluate(concluirProbe);
        const picked = pickConcluir(buttons);
        if (picked && typeof picked === "object") return picked;
        return picked;
      });
      if (finishPick == null || (finishPick && finishPick.ambiguous)) {
        return { ok: false, reason: "concluir_ausente" };
      }
      const clickedFinish = await page.evaluate(clickConcluir);
      if (!clickedFinish) return { ok: false, reason: "concluir_ausente" };
      return { ok: true };
    }
  };
}

function asLink(data) {
  if (!data || data.ok !== true) return { ok: false, error: (data && data.error) || "ct_falhou" };
  if (data.fim === true) return { ok: true, fim: true, motivo: data.motivo || "sem_link" };
  if (!data.url || !data.itemId) return { ok: false, error: "resposta_sem_link" };
  return {
    ok: true,
    fim: false,
    url: data.url,
    itemId: String(data.itemId),
    nomes: Array.isArray(data.nomes) ? data.nomes : []
  };
}

async function runAnuncio({
  page,
  nome,
  mode = "auto",
  deadlineAt = 0,
  context = null,
  client = null,
  actions = null
} = {}) {
  const ctx = context || readContext();
  const conta = String(nome || "").trim();
  if (!conta) return { ok: true, skipped: true, reason: "conta_ausente" };
  if (mode !== "human" && ctx.enabled !== true) return { ok: true, skipped: true, reason: "disabled" };
  if (!page) return { ok: true, skipped: true, reason: "page_gone" };
  if (ctx.country !== "br" && ctx.country !== "us") return { ok: true, skipped: true, reason: "country" };
  if (!ctx.servidor) return { ok: true, skipped: true, reason: "servidor_ausente" };
  const ct = client || createClient({ base: ctx.base });
  if (!ct || !ct.base) return { ok: true, skipped: true, reason: "ct_indisponivel" };
  const act = actions || createPageActions(page);
  const deadline = Number(deadlineAt) > 0 ? Number(deadlineAt) : (Date.now() + BUDGET_TOTAL_MS);
  const runId = `${conta}:${Date.now()}`;
  const report = (itemId, resultado) => ct.informar({
    servidor: ctx.servidor,
    conta,
    runId,
    itemId,
    resultado
  });
  let current = asLink(await ct.pedir({
    servidor: ctx.servidor,
    conta,
    runId,
    country: ctx.country
  }));
  if (!current.ok) return { ok: true, skipped: true, reason: "ct_falhou" };
  if (current.fim) return { ok: true, skipped: true, reason: current.motivo || "sem_link" };

  while (current && current.url && Date.now() < deadline) {
    if (!Array.isArray(current.nomes) || !current.nomes.length) {
      await report(current.itemId, "erro");
      return { ok: true, skipped: true, reason: "nomes_vazios" };
    }
    let opened = { ok: false };
    try {
      opened = await act.open(current.url, deadline);
    } catch {
      opened = { ok: false };
    }
    if (!opened || opened.ok !== true) {
      await report(current.itemId, "erro");
      return { ok: true, skipped: true, reason: "nav_failed" };
    }
    let judged = null;
    try {
      judged = await act.judge(deadline);
    } catch {
      judged = null;
    }
    if (judged && judged.kind === "unavailable") {
      current = asLink(await report(current.itemId, "indisponivel"));
      if (!current.ok) return { ok: true, skipped: true, reason: "ct_falhou", started: true };
      if (current.fim) return { ok: true, skipped: true, reason: current.motivo || "tentativas" };
      continue;
    }
    if (judged && judged.kind === "seller") {
      if (nomeEhNosso(judged.name, current.nomes)) {
        current = asLink(await report(current.itemId, "nosso"));
        if (!current.ok) return { ok: true, skipped: true, reason: "ct_falhou", started: true };
        if (current.fim) return { ok: true, skipped: true, reason: current.motivo || "tentativas" };
        continue;
      }
      let clicked = { ok: false };
      try {
        clicked = await act.denounce(deadline);
      } catch {
        clicked = { ok: false };
      }
      if (!clicked || clicked.ok !== true) {
        await report(current.itemId, "erro");
        return { ok: true, skipped: true, reason: "click_failed" };
      }
      const done = await report(current.itemId, "concluido");
      if (!done || done.ok !== true) return { ok: true, skipped: true, reason: "ct_falhou", started: true };
      return { ok: true, skipped: false, reason: "concluido" };
    }
    await report(current.itemId, "erro");
    return { ok: true, skipped: true, reason: "pagina_inconclusiva" };
  }
  if (current && current.url && current.itemId) {
    await report(current.itemId, "erro");
    return { ok: true, skipped: true, reason: "erro" };
  }
  return { ok: true, skipped: true, reason: (current && current.motivo) || "sem_link" };
}

function runAuto(opts) {
  return runAnuncio(Object.assign({}, opts, { mode: "auto" }));
}

function runHuman(opts) {
  return runAnuncio(Object.assign({}, opts, { mode: "human" }));
}

module.exports = {
  BUDGET_TOTAL_MS,
  NAV_TIMEOUT_MS,
  POLL_GAP_MS,
  JUDGE_BUDGET_MS,
  CONTROL_BUDGET_MS,
  AFTER_CLICK_MS,
  readContext,
  runAnuncio,
  runAuto,
  runHuman
};
