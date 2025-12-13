'use strict';

const stepLog = require('./stepLog.js');
const logger = require('./logger.js');
const manifestStore = require('./manifestStore.js');
const browserHelper = require('./browser.js');
const utils = require('./utils.js');
const virtusMessenger = require('./virtusMessenger.js');

const POOLS = new Map();

// HARD DEFAULTS (MILITAR)
const TOTAL_PAGES = parseInt(process.env.VIRTUS_UI_PAGES || '12', 10); // 1 list + 11 IO
const IO_PAGES = Math.max(1, TOTAL_PAGES - 1);

function _id() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function _patchAndGo(perfil, page) {
  try {
    page._virtusKeep = true;
    page._virtusPerfil = perfil;
    page._virtusLockKey = page._virtusLockKey || _id();
    
    const man = await manifestStore.read(perfil).catch(() => null);
    const coords = utils.getCoords((man && man.cidade) || '');
    
    await browserHelper.patchPage(perfil, page, coords).catch(() => {});
    
    await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    
    await virtusMessenger.ensureMarketplace(page, { timeoutMs: 25000 }).catch(() => {});
    
    return true;
  } catch {
    return false;
  }
}

async function warmUp(browser, perfil) {
  if (!browser) return null;
  if (POOLS.has(perfil)) return POOLS.get(perfil);
  
  const pool = {
    perfil,
    browser,
    listPage: null,
    ioPages: [],
    ioFree: [],
    ioBusy: new Set(),
    waiters: []
  };
  
  POOLS.set(perfil, pool);
  
  // suppress about:blank killer during warmup
  try {
    browser._suppressBlankKillUntil = browser._suppressBlankKillUntil || {};
    browser._suppressBlankKillUntil[perfil] = Date.now() + 30000;
  } catch {}
  
  let pages = [];
  try { pages = await browser.pages().catch(() => []); } catch {}
  
  // listPage = pages[0] (mantém previsibilidade com pruners)
  const base = pages[0] || await browser.newPage();
  base._virtusRole = 'list';
  await _patchAndGo(perfil, base);
  pool.listPage = base;
  
  // IO pages
  const creates = [];
  for (let i = 0; i < IO_PAGES; i++) {
    creates.push((async () => {
      const p = await browser.newPage();
      p._virtusRole = 'io';
      await _patchAndGo(perfil, p);
      pool.ioPages.push(p);
      pool.ioFree.push(p);
    })());
  }
  
  await Promise.allSettled(creates);
  
  stepLog.appendJSONL(perfil, 'virtus_pool', {
    step: 'pool_ready',
    totalPages: 1 + pool.ioPages.length,
    ioPages: pool.ioPages.length
  });
  
  logger.info(`[virtusPagePool][${perfil}] pool_ready list=1 io=${pool.ioPages.length}`);
  
  return pool;
}

async function getListPage(browser, perfil) {
  const pool = await warmUp(browser, perfil);
  return pool ? pool.listPage : null;
}

async function acquireIoPage(browser, perfil, { timeoutMs = 15000 } = {}) {
  const pool = await warmUp(browser, perfil);
  if (!pool) return null;
  
  // try fast
  while (pool.ioFree.length) {
    const p = pool.ioFree.shift();
    try {
      if (p && !(p.isClosed && p.isClosed())) {
        pool.ioBusy.add(p);
        return { page: p, release: () => releaseIoPage(perfil, p) };
      }
    } catch {}
  }
  
  // wait
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('io_page_acquire_timeout')), timeoutMs);
    pool.waiters.push({
      resolve: (p) => { clearTimeout(t); resolve({ page: p, release: () => releaseIoPage(perfil, p) }); },
      reject: (e) => { clearTimeout(t); reject(e); }
    });
  }).catch(() => null);
}

function releaseIoPage(perfil, page) {
  const pool = POOLS.get(perfil);
  if (!pool || !page) return;
  
  pool.ioBusy.delete(page);
  
  // handoff to waiter first
  const w = pool.waiters.shift();
  if (w && typeof w.resolve === 'function') {
    pool.ioBusy.add(page);
    return w.resolve(page);
  }
  
  pool.ioFree.push(page);
}

module.exports = { warmUp, getListPage, acquireIoPage };

