'use strict';

const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');
const browserHelper = require('./browser.js');
const utils = require('./utils.js');

const RELOAD_INTERVAL_MS = parseInt(process.env.RELOAD_INTERVAL_MS || '7200000', 10); // 2h
const RELOAD_BATCH_SIZE = parseInt(process.env.RELOAD_BATCH_SIZE || '3', 10);        // 3 por vez
const RELOAD_BATCH_DELAY_MS = parseInt(process.env.RELOAD_BATCH_DELAY_MS || '5000', 10); // 5s entre batches
const RELOAD_TIMEOUT_MS = parseInt(process.env.RELOAD_TIMEOUT_MS || '60000', 10);    // 60s timeout por troca
const RELOAD_PROCESS_INTERVAL_MS = parseInt(process.env.RELOAD_PROCESS_INTERVAL_MS || '30000', 10); // 30s

let reloadQueue = new Set();
let reloadInProgress = new Set();
let lastReloadTimes = new Map();
let reloadInterval = null;
let processInterval = null;
let initialized = false;

function scheduleReload(nome) {
  if (!nome) return;
  if (reloadInProgress.has(nome)) return;
  if (reloadQueue.has(nome)) return;
  reloadQueue.add(nome);
  logger.info('[RELOAD] agendado', { nome });
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForMessengerNavigation(page, nome, timeoutMs = RELOAD_TIMEOUT_MS) {
  const t0 = Date.now();
  while ((Date.now() - t0) < timeoutMs) {
    try {
      const url = (typeof page.url === 'function') ? (page.url() || '') : '';
      if (/^https?:\/\/(www\.)?messenger\.com/i.test(url)) {
        logger.info('[RELOAD] navegação detectada', { nome, url });
        return true;
      }
    } catch {}
    await wait(1000);
  }
  return false;
}

function isBrowserConnected(ctrl) {
  try {
    return !!(ctrl && ctrl.browser && ctrl.browser.isConnected && ctrl.browser.isConnected());
  } catch { return false; }
}

function safeSkipReason(nome, reason) {
  logger.info('[RELOAD] skip - ' + reason, { nome });
}

async function processReload(nome, controllers, robeMeta) {
  if (!controllers || !controllers.get) return;
  if (reloadInProgress.has(nome)) return;
  reloadInProgress.add(nome);
  reloadQueue.delete(nome);
  try {
    const ctrl = controllers.get(nome);
    if (!ctrl) return safeSkipReason(nome, 'controller ausente');
    if (!isBrowserConnected(ctrl)) return safeSkipReason(nome, 'browser desconectado');

    // Segurança obrigatória
    if (ctrl.humanControl === true) return safeSkipReason(nome, 'modo humano');
    if (ctrl.configurando === true) return safeSkipReason(nome, 'configurando');
    if (ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) return safeSkipReason(nome, 'virtus sendLock ativo');
    // PATCH RM-P1: Bloqueia ReloadManager durante UI crítica do Virtus
    if (ctrl && ctrl.browser && ctrl.browser._virtusCritical && ctrl.browser._virtusCritical.active) {
      return safeSkipReason(nome, 'virtus_critical');
    }
    if (robeMeta && robeMeta[nome] && robeMeta[nome].emExecucao === true) {
      return safeSkipReason(nome, 'robe em execução');
    }

    // Evita trocas muito frequentes
    const last = lastReloadTimes.get(nome) || 0;
    const now = Date.now();
    if (now - last < Math.floor(RELOAD_INTERVAL_MS * 0.5)) {
      return safeSkipReason(nome, 'janela de grace não cumprida');
    }

    // Preparação de páginas
    const browser = ctrl.browser;
    let pages = await browser.pages().catch(() => []);
    if (!Array.isArray(pages) || pages.length === 0) return safeSkipReason(nome, 'sem páginas');
    const mainPage = ctrl.mainPage || pages[0];
    if (!mainPage) return safeSkipReason(nome, 'mainPage ausente');

    logger.info('[RELOAD] iniciando troca de aba', { nome });

    // Abre nova aba e faz patch completo
    const man = await manifestStore.read(nome).catch(() => null);
    const coords = utils.getCoords((man && man.cidade) || '');
    const newPage = await browser.newPage();
    try {
      await browserHelper.patchPage(nome, newPage, coords);
    } catch (e) {
      logger.warn('[RELOAD] patchPage falhou (seguindo mesmo assim)', { nome, err: (e && e.message) || String(e) });
    }

    // about:blank (já é blank por padrão; goto opcional)
    try {
      await newPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    } catch {}

    logger.info('[RELOAD] nova aba aberta', { nome });

    // Fecha aba antiga (tolerante a erro)
    try {
      await mainPage.close({ runBeforeUnload: false }).catch(() => {});
      logger.info('[RELOAD] aba antiga fechada', { nome });
    } catch (e) {
      logger.warn('[RELOAD] falha ao fechar aba antiga (seguindo)', { nome, err: (e && e.message) || String(e) });
    }

    // Atualiza referência mainPage (opcional)
    try {
      ctrl.mainPage = newPage;
    } catch {}

    // Aguarda Virtus detectar e navegar ao Messenger
    logger.info('[RELOAD] aguardando navegação do virtus', { nome });
    let ok = await waitForMessengerNavigation(newPage, nome, RELOAD_TIMEOUT_MS);
    if (!ok) {
      logger.warn('[RELOAD] timeout na navegação - tentando manual', { nome });
      try {
        await newPage.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      } catch {}
      ok = await waitForMessengerNavigation(newPage, nome, 20000);
      if (!ok) {
        // erro crítico — fecha o navegador; sistema reabre automaticamente
        logger.error('[RELOAD] erro durante troca de aba — navegador será fechado', { nome });
        try { await browser.close().catch(()=>{}); } catch {}
        return;
      } else {
        logger.info('[RELOAD] navegação manual concluída', { nome });
      }
    }

    lastReloadTimes.set(nome, Date.now());
    logger.info('[RELOAD] troca de aba concluída com sucesso', { nome });

  } catch (e) {
    logger.error('[RELOAD] erro durante troca de aba', { nome, error: (e && e.message) || String(e) }, e);
    try {
      const ctrl = controllers.get(nome);
      if (ctrl && ctrl.browser) {
        logger.warn('[RELOAD] navegador fechado devido a erro', { nome });
        await ctrl.browser.close().catch(()=>{});
      }
    } catch {}
  } finally {
    reloadInProgress.delete(nome);
  }
}

async function processReloadQueue(controllers, robeMeta) {
  if (!controllers) return;
  if (reloadInProgress.size >= RELOAD_BATCH_SIZE) return;
  const capacity = Math.max(0, RELOAD_BATCH_SIZE - reloadInProgress.size);
  if (capacity <= 0) return;
  const batch = Array.from(reloadQueue).slice(0, capacity);
  for (const nome of batch) reloadQueue.delete(nome);
  if (!batch.length) return;
  await Promise.all(batch.map(async (nome) => {
    try { await processReload(nome, controllers, robeMeta); }
    catch (e) { logger.error('[RELOAD] erro no item da fila', { nome, error: (e && e.message) || String(e) }); }
  }));
  await wait(RELOAD_BATCH_DELAY_MS);
}

function schedulePeriodic(controllers) {
  try {
    const now = Date.now();
    for (const [nome, ctrl] of controllers.entries()) {
      // Somente perfis ativos
      if (!ctrl || !isBrowserConnected(ctrl)) continue;
      const last = lastReloadTimes.get(nome) || now; // primeira rodada daqui a 2h
      if (now - last >= RELOAD_INTERVAL_MS) {
        scheduleReload(nome);
        lastReloadTimes.set(nome, now); // evita re-agendar repetidamente até processar
      }
    }
  } catch {}
}

function startReloadManager(controllers, robeMeta) {
  if (initialized) return;
  if (!controllers || typeof controllers.entries !== 'function') {
    logger.warn('[RELOAD] startReloadManager chamado sem controllers válidos');
    return;
  }
  logger.info('[RELOAD] reload manager iniciado');
  // Inicializa relógio de "último reload" para agora (primeiro ciclo ocorrerá após RELOAD_INTERVAL_MS)
  try {
    const now = Date.now();
    for (const [nome] of controllers.entries()) {
      lastReloadTimes.set(nome, now);
    }
  } catch {}
  processInterval = setInterval(() => {
    try { processReloadQueue(controllers, robeMeta).catch(()=>{}); } catch {}
  }, RELOAD_PROCESS_INTERVAL_MS);
  reloadInterval = setInterval(() => {
    try { schedulePeriodic(controllers); } catch {}
  }, Math.max(30000, Math.floor(RELOAD_INTERVAL_MS / 4))); // checagens fracionadas
  initialized = true;
}

module.exports = {
  startReloadManager,
  scheduleReload,
  waitForMessengerNavigation
};

