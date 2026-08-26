"use strict";

/**
 * Contrato preto-no-branco (Virtus + Robe):
 * - Sem Robe: 1 aba (messages/Virtus). Aba 1+ fecha, qualquer URL, qualquer ERR_*.
 * - Com Robe: aba 0 messages, aba 1 create/item|vehicle. Aba 2+ fecha.
 * - A aba 1 nasce about:blank no portao. Nao fecha blank/blinding enquanto o
 *   gate esta colando (senao o pruner mata o create antes do goto).
 * - Restore de sessao do Chrome nao e aba de trabalho.
 * - Teto por contagem. Nao filtra tipo de erro. pages() timeout cai nos targets CDP.
 */

const provisionAudit = (() => {
  try { return require("./provisionAudit.js"); } catch { return null; }
})();
const facebookNavHosts = require("./facebookNavHosts.js");

function isBlankUrl(url) {
  const u = String(url || "").trim();
  return !u || u === "about:blank";
}

function isDeadTabUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  if (!u) return false;
  if (u.startsWith("chrome-error://")) return true;
  if (u.includes("chromewebdata")) return true;
  if (u.startsWith("chrome://crash")) return true;
  if (u.startsWith("chrome://kill")) return true;
  if (u.startsWith("chrome://hang")) return true;
  if (u.startsWith("chrome://gpucrash")) return true;
  if (u.startsWith("chrome://gpuhang")) return true;
  if (u.startsWith("chrome://inducebrowsercrashforrealz")) return true;
  return false;
}

function isJunkUrl(url) {
  return isBlankUrl(url) || isDeadTabUrl(url);
}

function isCreateMarketplaceUrl(url) {
  return /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(String(url || ""));
}

function isLiveWorkUrl(url) {
  const u = String(url || "");
  if (isJunkUrl(u)) return false;
  const host = facebookNavHosts.hostnameOf(u);
  return facebookNavHosts.isOfficialFacebookNavHost(host) || facebookNavHosts.isOfficialMessengerNavHost(host);
}

function pageUrlOf(page) {
  try {
    return typeof page.url === "function" ? String(page.url() || "") : "";
  } catch {
    return "";
  }
}

function isChromeErrorUiText(s) {
  const t = String(s || "");
  if (!t) return false;
  if (/ERR_(BLOCKED_BY_CLIENT|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_TIMED_OUT|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_REFUSED|EMPTY_RESPONSE|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|SSL_PROTOCOL_ERROR|TIMED_OUT)\b/i.test(t)) {
    return true;
  }
  if (/DNS_PROBE_FINISHED_NO_INTERNET|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i.test(t)) return true;
  if (/n[aã]o [eé] poss[ií]vel acessar esse site/i.test(t)) return true;
  if (/this site can.?t be reached/i.test(t)) return true;
  if (/esta p[aá]gina da web foi bloqueada/i.test(t)) return true;
  if (/checking the proxy address|verifique o endere[cç]o do proxy/i.test(t)) return true;
  return false;
}

function unknownPageNavState(page) {
  const url = pageUrlOf(page);
  const junkUrl = isJunkUrl(url);
  return {
    url,
    junkUrl,
    deadContent: junkUrl,
    liveMessages: false,
    loginGate: false,
    liveWork: false
  };
}

async function pageLooksLikeChromeNetError(page) {
  if (!page) return false;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return false;
  } catch {}
  const u = pageUrlOf(page);
  if (isDeadTabUrl(u)) return true;
  const withTimeout = (p, ms, fallback) => Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms))
  ]);
  try {
    if (typeof page.title === "function") {
      const t = await withTimeout(page.title(), 2200, "");
      if (isChromeErrorUiText(t)) return true;
    }
  } catch {}
  try {
    if (typeof page.evaluate === "function") {
      const probe = await withTimeout(
        page.evaluate(() => {
          try {
            if (document.querySelector("#main-frame-error, #main-frame-info")) {
              return { dom: true, text: "" };
            }
            const title = String((document && document.title) || "");
            const body = String((document && document.body && document.body.innerText) || "");
            return { dom: false, text: (title + "\n" + body).slice(0, 800) };
          } catch {
            return { dom: false, text: "" };
          }
        }),
        2200,
        { dom: false, text: "" }
      );
      if (probe && probe.dom === true) return true;
      if (probe && isChromeErrorUiText(probe.text)) return true;
    }
  } catch {}
  return false;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pageLooksLikeMessengerShell(page) {
  if (!page) return false;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return false;
  } catch {}
  const u = pageUrlOf(page);
  if (!facebookNavHosts.isLiveMessagesUrl(u)) return false;
  try {
    if (await pageLooksLikeChromeNetError(page)) return false;
  } catch {}
  const withTimeout = (p, ms, fallback) => Promise.race([
    Promise.resolve(p).catch(() => fallback),
    new Promise((r) => setTimeout(() => r(fallback), ms))
  ]);
  try {
    const hit = await withTimeout(
      page.evaluate(() => {
        try {
          const tablist = !!document.querySelector('[role="tablist"]');
          const inboxSearch =
            !!document.querySelector('input[aria-label*="Pesquisar no Messenger"]') ||
            !!document.querySelector('input[aria-label*="Search in Messenger"]');
          const threads = document.querySelectorAll('a[href*="/messages/t/"],a[href*="/messages/e2ee/t/"]').length;
          const composer = document.querySelectorAll('div[data-lexical-editor="true"]').length > 0;
          return !!(tablist || inboxSearch || threads > 0 || composer);
        } catch {
          return false;
        }
      }),
      2200,
      false
    );
    return !!hit;
  } catch {
    return false;
  }
}

async function waitForMessengerShellOrGate(page, { timeoutMs = 55000, pollMs = 750 } = {}) {
  const t0 = Date.now();
  const maxMs = Math.max(5000, Number(timeoutMs || 55000) || 55000);
  const step = Math.max(200, Number(pollMs || 750) || 750);
  while ((Date.now() - t0) < maxMs) {
    try {
      if (typeof page.isClosed === "function" && page.isClosed()) {
        return { ok: false, reason: "closed" };
      }
    } catch {}
    let dead = false;
    try { dead = await pageLooksLikeChromeNetError(page); } catch { dead = false; }
    if (dead) return { ok: false, reason: "net_error" };
    const u = pageUrlOf(page);
    if (facebookNavHosts.isFacebookLoginOrGateUrl(u)) {
      return { ok: true, reason: "login_or_gate", url: u.slice(0, 180) };
    }
    try {
      if (await pageLooksLikeMessengerShell(page)) {
        return { ok: true, reason: "messages_ui", url: u.slice(0, 180) };
      }
    } catch {}
    await sleepMs(step);
  }
  return { ok: false, reason: "timeout", url: pageUrlOf(page).slice(0, 180) };
}

/**
 * Fim da rajada CONNECT: tempo fixo + chrome-error + login/gate.
 * Shell Messenger só encerra cedo. Não é requisito.
 */
async function waitForHeavyNavLanding(page, { timeoutMs = 14000, pollMs = 400 } = {}) {
  const t0 = Date.now();
  const maxMs = Math.max(3000, Number(timeoutMs || 14000) || 14000);
  const step = Math.max(200, Number(pollMs || 400) || 400);
  let lastUrl = pageUrlOf(page);
  while ((Date.now() - t0) < maxMs) {
    try {
      if (typeof page.isClosed === "function" && page.isClosed()) {
        return { ok: false, reason: "closed", url: lastUrl.slice(0, 180) };
      }
    } catch {}
    let dead = false;
    try { dead = await pageLooksLikeChromeNetError(page); } catch { dead = false; }
    lastUrl = pageUrlOf(page);
    if (dead) return { ok: false, reason: "net_error", url: lastUrl.slice(0, 180) };
    if (facebookNavHosts.isFacebookLoginOrGateUrl(lastUrl)) {
      return { ok: true, reason: "login_or_gate", url: lastUrl.slice(0, 180) };
    }
    try {
      if (await pageLooksLikeMessengerShell(page)) {
        return { ok: true, reason: "messages_ui", url: lastUrl.slice(0, 180) };
      }
    } catch {}
    await sleepMs(step);
  }
  lastUrl = pageUrlOf(page);
  let deadEnd = false;
  try { deadEnd = await pageLooksLikeChromeNetError(page); } catch { deadEnd = false; }
  if (deadEnd) return { ok: false, reason: "net_error", url: lastUrl.slice(0, 180) };
  return { ok: true, reason: "settle_elapsed", url: lastUrl.slice(0, 180) };
}

async function classifyPageNavState(page) {
  const url = pageUrlOf(page);
  const junkUrl = isJunkUrl(url);
  let deadContent = junkUrl;
  if (!deadContent) {
    try {
      deadContent = await pageLooksLikeChromeNetError(page);
    } catch {
      deadContent = false;
    }
  }
  const liveMessages = !deadContent && facebookNavHosts.isLiveMessagesUrl(url);
  const loginGate = !deadContent && facebookNavHosts.isFacebookLoginOrGateUrl(url);
  const liveWork = !deadContent && isLiveWorkUrl(url) && !isCreateMarketplaceUrl(url);
  return { url, junkUrl, deadContent, liveMessages, loginGate, liveWork };
}

function pickVirtusKeepPageFromStates(pages, preferred, states) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  if (!list.length) return null;
  const st = (p) => (states && states.get(p)) || {};
  const prefOk = !!(preferred && list.includes(preferred));
  const liveMsg = list.filter((p) => st(p).liveMessages);
  if (prefOk && liveMsg.includes(preferred)) return preferred;
  if (liveMsg.length) return liveMsg[0];
  const login = list.filter((p) => st(p).loginGate);
  if (prefOk && login.includes(preferred)) return preferred;
  if (login.length) return login[0];
  const liveWork = list.filter((p) => st(p).liveWork);
  if (prefOk && liveWork.includes(preferred)) return preferred;
  if (liveWork.length) return liveWork[0];
  if (prefOk) return preferred;
  return list[0];
}

async function pickVirtusKeepPageAsync(pages, preferred) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  if (!list.length) return null;
  const states = new Map();
  for (const p of list) {
    try {
      states.set(p, await classifyPageNavState(p));
    } catch {
      states.set(p, unknownPageNavState(p));
    }
  }
  return pickVirtusKeepPageFromStates(list, preferred, states);
}

/** Uma aba Virtus: prefere /messages vivo, depois Facebook/Messenger vivo, depois a preferida. */
function pickVirtusKeepPage(pages, preferred) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  if (!list.length) return null;
  const prefOk = preferred && list.includes(preferred);
  const isMsg = (p) => {
    const u = pageUrlOf(p);
    return !isJunkUrl(u) && facebookNavHosts.isLiveMessagesUrl(u);
  };
  if (prefOk && isMsg(preferred)) return preferred;
  for (const p of list) {
    if (isMsg(p)) return p;
  }
  if (prefOk && isLiveWorkUrl(pageUrlOf(preferred)) && !isCreateMarketplaceUrl(pageUrlOf(preferred))) {
    return preferred;
  }
  for (const p of list) {
    const u = pageUrlOf(p);
    if (isLiveWorkUrl(u) && !isCreateMarketplaceUrl(u)) return p;
  }
  if (prefOk) return preferred;
  return list[0];
}

function listPageTargets(browser) {
  try {
    const targets = (typeof browser.targets === "function" ? browser.targets() : []) || [];
    return targets.filter((t) => {
      try { return t && typeof t.type === "function" && t.type() === "page"; } catch { return false; }
    });
  } catch {
    return [];
  }
}

async function fastClosePage(page) {
  if (!page) return false;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return true;
  } catch {
    return true;
  }
  try {
    await Promise.race([
      page.close({ runBeforeUnload: false }).catch(() => {}),
      new Promise((r) => setTimeout(r, 2000))
    ]);
  } catch {}
  try {
    return typeof page.isClosed === "function" ? !!page.isClosed() : true;
  } catch {
    return true;
  }
}

/**
 * Teto por contagem via CDP targets — não espera browser.pages() nem evaluate de ERR_*.
 * Aba 0 = messages. Aba 1 = create só com Robe. Aba 2+ fecha.
 */
async function closeExtraPageTargets(browser, { nome = "", robeOn = false } = {}) {
  const pageTargets = listPageTargets(browser);
  if (pageTargets.length <= 1) return { closed: 0 };
  const swapping = isVirtusSwapping(browser, nome);
  if (swapping && pageTargets.length <= 2) return { closed: 0 };
  let keepIdx = 0;
  for (let i = 0; i < pageTargets.length; i++) {
    let u = "";
    try { u = typeof pageTargets[i].url === "function" ? String(pageTargets[i].url() || "") : ""; } catch {}
    if (u && !isJunkUrl(u) && facebookNavHosts.isLiveMessagesUrl(u)) {
      keepIdx = i;
      break;
    }
  }
  let closed = 0;
  let createKept = false;
  let swapExtraKept = false;
  let session = null;
  for (let i = pageTargets.length - 1; i >= 0; i--) {
    if (i === keepIdx) continue;
    const t = pageTargets[i];
    let u = "";
    try { u = typeof t.url === "function" ? String(t.url() || "") : ""; } catch {}
    if (robeOn && isCreateMarketplaceUrl(u)) {
      if (!createKept) {
        createKept = true;
        continue;
      }
    }
    if (swapping && !swapExtraKept) {
      swapExtraKept = true;
      continue;
    }
    let page = null;
    try {
      const got = typeof t.page === "function" ? t.page() : null;
      if (got && typeof got.then === "function") {
        page = await Promise.race([
          Promise.resolve(got).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 400))
        ]);
      } else {
        page = got;
      }
    } catch {}
    if (page) {
      const ok = await fastClosePage(page);
      if (ok) closed++;
      continue;
    }
    let tid = "";
    try { tid = String(t._targetId || (t._targetInfo && t._targetInfo.targetId) || ""); } catch { tid = ""; }
    if (!tid) continue;
    try {
      if (!session) {
        session = await Promise.race([
          browser.target().createCDPSession(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("cdp_session_timeout")), 1500))
        ]);
      }
      await Promise.race([
        session.send("Target.closeTarget", { targetId: tid }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("close_target_timeout")), 1500))
      ]);
      closed++;
    } catch {}
  }
  if (closed > 0) {
    try {
      if (provisionAudit && typeof provisionAudit.append === "function") {
        provisionAudit.append({
          ts: Date.now(),
          event: "redundant_virtus_tab_closed",
          nome: String(nome || ""),
          reason: "targets_cap",
          closed
        });
      }
    } catch {}
  }
  return { closed };
}

/**
 * Contrato por contagem, sem filtro de ERR_*:
 * - Sem Robe: 1 aba (Virtus/messages).
 * - Com Robe: aba 0 messages + aba 1 create. Aba 2+ fecha.
 * Extra fecha mesmo no portão / chrome-error / dinossauro / facebook.com/messages morto.
 */
function isVirtusSwapping(browser, nome) {
  try {
    const map = browser && browser._virtusSwapUntil;
    if (!map || typeof map !== "object") return false;
    const now = Date.now();
    if (nome && Number(map[nome] || 0) > now) return true;
    return Object.keys(map).some((k) => Number(map[k] || 0) > now);
  } catch {
    return false;
  }
}

async function closeRedundantVirtusTabs(browser, { keepPage = null, nome = "", reason = "" } = {}) {
  if (!browser) return { ok: false, closed: 0, error: "no_browser" };
  const robeOn = !!(browser && browser._robeActiveFor);
  const listed = await listPagesBounded(browser, 4000);
  if (listed.timedOut) {
    const viaTargets = await closeExtraPageTargets(browser, { nome, robeOn });
    return { ok: true, closed: Number(viaTargets.closed || 0), timedOut: true, via: "targets" };
  }
  const pages = listed.pages || [];
  if (pages.length <= 1) return { ok: true, closed: 0, kept: pages.length };
  const swapping = isVirtusSwapping(browser, nome);
  if (swapping && pages.length <= 2) {
    return { ok: true, closed: 0, kept: pages.length, reason: "virtus_swap" };
  }
  const gateBusy = Number(browser && browser._convenienteGateInFlight || 0) > 0;

  const keep = (keepPage && pages.includes(keepPage))
    ? keepPage
    : (pickVirtusKeepPage(pages, pages[0]) || pages[0]);
  let closed = 0;
  let createKept = null;
  let swapExtraKept = null;
  const closedUrls = [];
  for (const p of pages) {
    if (!p || p === keep) continue;
    if (p && p._convenienteBlindarPromise) continue;
    const u = pageUrlOf(p);
    if (robeOn && gateBusy && isBlankUrl(u) && !isDeadTabUrl(u)) continue;
    if (robeOn && isCreateMarketplaceUrl(u)) {
      if (!createKept) {
        createKept = p;
        continue;
      }
    }
    if (swapping && !swapExtraKept) {
      swapExtraKept = p;
      continue;
    }
    try {
      const ok = await fastClosePage(p);
      if (ok) {
        closed++;
        if (u) closedUrls.push(String(u).slice(0, 180));
      }
    } catch {}
  }

  if (closed > 0) {
    try {
      if (provisionAudit && typeof provisionAudit.append === "function") {
        provisionAudit.append({
          ts: Date.now(),
          event: "redundant_virtus_tab_closed",
          nome: String(nome || ""),
          reason: String(reason || "").slice(0, 80),
          closed,
          closedUrls: closedUrls.slice(0, 6)
        });
      }
    } catch {}
  }
  return { ok: true, closed, keep: !!keep };
}

function isChromeProtocolSickError(msg) {
  const s = String(msg || "");
  return /Network\.enable timed out|Network\.enable|Protocol error \(Runtime|Protocol error \(Network|Page crashed|Runtime\.callFunctionOn timed out|cdp_timeout|pages_timeout|cure_goto_timeout|cure_newpage_timeout|cure_newpage_goto_timeout/i.test(s);
}

function pagesLookAllJunk(pages) {
  if (!Array.isArray(pages) || pages.length < 1) return true;
  for (const p of pages) {
    let u = "";
    try { u = typeof p.url === "function" ? String(p.url() || "") : ""; } catch {}
    if (u && !isJunkUrl(u)) return false;
  }
  return true;
}

function targetIdOf(page) {
  try {
    const t = page && typeof page.target === "function" ? page.target() : null;
    if (t && t._targetId) return String(t._targetId);
  } catch {}
  return null;
}

function ensurePageBirth(browser, page) {
  if (!browser || !page) return 0;
  try {
    browser._pageBirth = browser._pageBirth || {};
    const tid = targetIdOf(page);
    const now = Date.now();
    if (tid) {
      if (!browser._pageBirth[tid]) browser._pageBirth[tid] = now;
      return Number(browser._pageBirth[tid]) || now;
    }
    if (!page.__convenienteBirth) page.__convenienteBirth = now;
    return Number(page.__convenienteBirth) || now;
  } catch {
    return Date.now();
  }
}

function pageAgeMs(browser, page) {
  try {
    const birth = ensurePageBirth(browser, page);
    return Math.max(0, Date.now() - (Number(birth) || Date.now()));
  } catch {
    return 0;
  }
}

function clearBlankSuppress(browser, nome) {
  try {
    if (Number(browser && browser._convenienteGateInFlight || 0) > 0) return;
    if (browser && browser._suppressBlankKillUntil && nome) {
      delete browser._suppressBlankKillUntil[nome];
    }
  } catch {}
}

function armBlankSuppress(browser, nome, ms = 20_000) {
  try {
    if (!browser || !nome) return;
    const until = Date.now() + Math.max(1_000, Number(ms) || 20_000);
    const guard = (browser._suppressBlankKillUntil = browser._suppressBlankKillUntil || {});
    guard[nome] = Math.max(Number(guard[nome] || 0) || 0, until);
  } catch {}
}

async function listPagesBounded(browser, timeoutMs = 4000) {
  if (!browser) return { ok: false, timedOut: true, pages: [] };
  try {
    const pages = await Promise.race([
      browser.pages().catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve("__timeout__"), Math.max(800, Number(timeoutMs) || 4000)))
    ]);
    if (pages === "__timeout__") return { ok: false, timedOut: true, pages: [] };
    return { ok: true, timedOut: false, pages: Array.isArray(pages) ? pages : [] };
  } catch {
    return { ok: false, timedOut: false, pages: [] };
  }
}

async function safeClosePage(page, { nome = "", reason = "" } = {}) {
  if (!page) return { ok: true, closed: true, skipped: true };
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) {
      return { ok: true, closed: true, already: true };
    }
  } catch {}

  // 1) Neutraliza beforeunload SEM navegar para about:blank.
  // about:blank / chrome-error: evaluate no túnel morto só atrasa o close.
  let skipDom = false;
  try { skipDom = isJunkUrl(pageUrlOf(page)); } catch { skipDom = false; }
  if (!skipDom) {
    try {
      await Promise.race([
        page.evaluate(() => {
          try { window.onbeforeunload = null; } catch {}
          try {
            window.addEventListener("beforeunload", (e) => {
              try { e.stopImmediatePropagation(); } catch {}
            }, true);
          } catch {}
        }).catch(() => {}),
        new Promise((r) => setTimeout(r, 800))
      ]);
    } catch {}
  }

  // 2) stopLoading com teto
  try {
    const client = await Promise.race([
      page.target().createCDPSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cdp_timeout")), 1500))
    ]);
    await Promise.race([
      client.send("Page.stopLoading").catch(() => {}),
      new Promise((r) => setTimeout(r, 800))
    ]);
  } catch {}

  // 3) close direto + verificação (CDP pendurado não pode mentir sucesso)
  let closed = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await Promise.race([
        page.close({ runBeforeUnload: false }).catch(() => {}),
        new Promise((r) => setTimeout(r, 2500))
      ]);
    } catch {}
    try {
      if (typeof page.isClosed === "function" && page.isClosed()) {
        closed = true;
        break;
      }
    } catch {
      closed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!closed) {
    try {
      if (provisionAudit && typeof provisionAudit.append === "function") {
        provisionAudit.append({
          ts: Date.now(),
          event: "dbg_robe_safe_close_failed",
          nome: String(nome || ""),
          reason: String(reason || "").slice(0, 80)
        });
      }
    } catch {}
  }
  return { ok: closed, closed, attempts: closed ? undefined : 2 };
}

/**
 * Fecha about:blank / chrome-error / Aw Snap, preservando keepPage (Virtus/messages).
 * Nunca toca create/item|vehicle real.
 */
async function sweepAboutBlankPages(browser, { keepPage = null, nome = "" } = {}) {
  if (!browser) return { ok: false, closed: 0 };
  let closed = 0;
  let failed = 0;
  try {
    const listed = await listPagesBounded(browser, 3000);
    if (listed.timedOut) return { ok: false, closed: 0, failed: 0, timedOut: true };
    const pages = listed.pages || [];
    for (const p of pages) {
      try {
        if (keepPage && p === keepPage) continue;
        try {
          if (typeof p.isClosed === "function" && p.isClosed()) continue;
        } catch {}
        let u = "";
        try { u = typeof p.url === "function" ? String(p.url() || "") : ""; } catch {}
        if (isCreateMarketplaceUrl(u)) continue;
        if (p && p._convenienteBlindarPromise) continue;
        let junk = isJunkUrl(u);
        if (!junk) {
          try { junk = await pageLooksLikeChromeNetError(p); } catch { junk = false; }
        }
        if (!junk) continue;
        const r = await safeClosePage(p, { nome, reason: "sweep_junk_tab" });
        if (r && r.closed) closed++;
        else failed++;
      } catch {
        failed++;
      }
    }
    if (closed > 0 || failed > 0) {
      try {
        if (provisionAudit && typeof provisionAudit.append === "function") {
          provisionAudit.append({
            ts: Date.now(),
            event: "dbg_robe_sweep_junk_tabs",
            nome: String(nome || ""),
            closed: Number(closed || 0),
            failed: Number(failed || 0)
          });
        }
      } catch {}
    }
  } catch {}
  return { ok: true, closed, failed };
}

async function closeJunkCdpTargets(browser, { nome = "", keepTargetId = null } = {}) {
  if (!browser) return { closed: 0, failed: 0 };
  if (Number(browser._convenienteGateInFlight || 0) > 0) return { closed: 0, failed: 0 };
  let closed = 0;
  let failed = 0;
  try {
    const targets = (typeof browser.targets === "function" ? browser.targets() : []) || [];
    const pageTargets = targets.filter((t) => {
      try { return t && typeof t.type === "function" && t.type() === "page"; } catch { return false; }
    });
    let session = null;
    for (const t of pageTargets) {
      let u = "";
      try { u = typeof t.url === "function" ? String(t.url() || "") : ""; } catch {}
      if (!isJunkUrl(u)) continue;
      let tid = "";
      try { tid = String(t._targetId || (t._targetInfo && t._targetInfo.targetId) || ""); } catch { tid = ""; }
      if (keepTargetId && tid && String(keepTargetId) === tid) continue;
      let page = null;
      try {
        page = await Promise.race([
          Promise.resolve().then(() => t.page()).catch(() => null),
          new Promise((r) => setTimeout(() => r(null), 1500))
        ]);
      } catch {}
      if (page) {
        if (page._convenienteBlindarPromise) continue;
        const r = await safeClosePage(page, { nome, reason: "junk_cdp_target_page" });
        if (r && r.closed) { closed++; continue; }
      }
      try {
        if (!tid) { failed++; continue; }
        if (!session) {
          session = await Promise.race([
            browser.target().createCDPSession(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("cdp_session_timeout")), 2000))
          ]);
        }
        await Promise.race([
          session.send("Target.closeTarget", { targetId: tid }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("close_target_timeout")), 2000))
        ]);
        closed++;
      } catch {
        failed++;
      }
    }
    if (closed > 0 || failed > 0) {
      try {
        if (provisionAudit && typeof provisionAudit.append === "function") {
          provisionAudit.append({
            ts: Date.now(),
            event: "dbg_chrome_junk_targets_closed",
            nome: String(nome || ""),
            closed: Number(closed || 0),
            failed: Number(failed || 0)
          });
        }
      } catch {}
    }
  } catch {}
  return { closed, failed };
}

async function probeBrowserHealth(browser, { nome = "", timeoutMs = 4000 } = {}) {
  if (!browser) return { ok: false, reason: "no_browser", needReopen: true, canCure: false, live: 0, junk: 0 };
  try {
    if (typeof browser.isConnected === "function" && !browser.isConnected()) {
      return { ok: false, reason: "disconnected", needReopen: true, canCure: false, live: 0, junk: 0 };
    }
  } catch {
    return { ok: false, reason: "isConnected_throw", needReopen: true, canCure: false, live: 0, junk: 0 };
  }

  const listed = await listPagesBounded(browser, timeoutMs);
  if (listed.timedOut) {
    return { ok: false, reason: "pages_timeout", needReopen: true, canCure: false, live: 0, junk: 0 };
  }
  const pages = listed.pages || [];

  let targetsCount = 0;
  let junkTargets = 0;
  try {
    const targets = (typeof browser.targets === "function" ? browser.targets() : []) || [];
    const pageTargets = targets.filter((t) => {
      try { return t && typeof t.type === "function" && t.type() === "page"; } catch { return false; }
    });
    targetsCount = pageTargets.length;
    for (const t of pageTargets) {
      let u = "";
      try { u = typeof t.url === "function" ? String(t.url() || "") : ""; } catch {}
      if (isJunkUrl(u)) junkTargets++;
    }
  } catch {}

  let live = 0;
  let junk = 0;
  for (const p of pages) {
    let u = "";
    try { u = typeof p.url === "function" ? String(p.url() || "") : ""; } catch {}
    if (isJunkUrl(u)) junk++;
    else if (isLiveWorkUrl(u) || (u && !isJunkUrl(u))) live++;
  }

  const splitBrain = targetsCount > (pages.length + 1);
  const extraJunkTargets = junkTargets > junk;

  if (live >= 1 && junk === 0 && !extraJunkTargets && !splitBrain) {
    return {
      ok: true,
      reason: "healthy",
      needReopen: false,
      canCure: false,
      live,
      junk,
      junkTargets,
      pages: pages.length,
      targets: targetsCount,
      nome: String(nome || "")
    };
  }
  if (live >= 1) {
    return {
      ok: false,
      reason: extraJunkTargets || splitBrain ? "split_brain_junk" : "junk_tabs",
      needReopen: false,
      canCure: true,
      live,
      junk,
      junkTargets,
      pages: pages.length,
      targets: targetsCount
    };
  }
  return {
    ok: false,
    reason: pages.length ? "all_junk" : "no_pages",
    needReopen: false,
    canCure: true,
    live,
    junk,
    junkTargets,
    pages: pages.length,
    targets: targetsCount
  };
}

async function cureBrowserInPlace(browser, { nome = "", keepPage = null } = {}) {
  const health0 = await probeBrowserHealth(browser, { nome });
  if (health0.ok) return { ok: true, action: "already_healthy", health: health0 };
  if (health0.needReopen) return { ok: false, needReopen: true, action: "cdp_dead", health: health0 };

  let tunnelCool = false;
  try {
    const connectLane = require("./connectLane.js");
    tunnelCool = !!(typeof connectLane.isCooling === "function" && connectLane.isCooling());
  } catch {}

  const sweep = await sweepAboutBlankPages(browser, { keepPage, nome });
  if (sweep && sweep.timedOut) {
    return { ok: false, needReopen: true, action: "sweep_pages_timeout", health: health0, sweep };
  }

  let keepTid = null;
  try {
    if (keepPage && typeof keepPage.target === "function") {
      const t = keepPage.target();
      if (t && t._targetId) keepTid = String(t._targetId);
    }
  } catch {}
  const closedTargets = await closeJunkCdpTargets(browser, { nome, keepTargetId: keepTid });

  let after = await probeBrowserHealth(browser, { nome });
  if (after.ok) return { ok: true, action: "swept_junk", health: after, sweep, closedTargets };
  if (after.needReopen) return { ok: false, needReopen: true, action: "cdp_dead_after_sweep", health: after, sweep, closedTargets };

  const listed = await listPagesBounded(browser, 4000);
  if (listed.timedOut) {
    return { ok: false, needReopen: true, action: "pages_timeout_before_goto", health: after, sweep, closedTargets };
  }
  const pages = listed.pages || [];
  const candidate = (keepPage && pages.includes(keepPage) ? keepPage : null) || pages[0] || null;
  const messagesUrl = "https://www.facebook.com/messages";

  if (tunnelCool) {
    try {
      await closeRedundantVirtusTabs(browser, { keepPage: candidate, nome, reason: "cure_tunnel_cool" });
    } catch {}
    after = await probeBrowserHealth(browser, { nome });
    return {
      ok: !!(after && after.ok),
      needReopen: false,
      action: "tunnel_cool_no_nav",
      health: after,
      sweep,
      closedTargets
    };
  }

  if (candidate) {
    try {
      if (!nome) throw new Error("cure_goto_no_nome");
      const browserMod = require("./browser.js");
      if (typeof browserMod.blindarPaginaDaConta !== "function") throw new Error("cure_goto_no_gate");
      await browserMod.blindarPaginaDaConta(candidate, nome, { source: "cure_goto_existing" });
      const connectLane = require("./connectLane.js");
      await connectLane.withHeavyNav({ kind: "cure_goto_messages", nome }, async () => {
        await Promise.race([
          candidate.goto(messagesUrl, { waitUntil: "domcontentloaded", timeout: 25000 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("cure_goto_timeout")), 28000))
        ]);
      });
      after = await probeBrowserHealth(browser, { nome });
      if (after.ok || after.live >= 1) {
        await sweepAboutBlankPages(browser, { keepPage: candidate, nome });
        return { ok: true, action: "goto_messages", health: after, sweep, closedTargets };
      }
    } catch (e) {
      const msg = String((e && e.message) || e || "");
      if (isChromeProtocolSickError(msg) || /cure_goto_timeout/i.test(msg)) {
        return {
          ok: false,
          needReopen: true,
          action: "goto_failed_cdp",
          error: msg.slice(0, 220),
          health: after,
          sweep,
          closedTargets
        };
      }
    }
  }

  try {
    const browserMod = require("./browser.js");
    if (!nome || typeof browserMod.newPageDaConta !== "function") {
      throw new Error("cure_newpage_no_gate");
    }
    const p = await Promise.race([
      browserMod.newPageDaConta(browser, nome, { source: "cure_messages" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cure_newpage_timeout")), 28000))
    ]);
    const connectLane = require("./connectLane.js");
    await connectLane.withHeavyNav({ kind: "cure_newpage_messages", nome }, async () => {
      await Promise.race([
        p.goto(messagesUrl, { waitUntil: "domcontentloaded", timeout: 25000 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("cure_newpage_goto_timeout")), 28000))
      ]);
    });
    await sweepAboutBlankPages(browser, { keepPage: p, nome });
    after = await probeBrowserHealth(browser, { nome });
    if (after.ok || after.live >= 1) {
      return { ok: true, action: "newpage_messages", health: after, sweep, closedTargets };
    }
  } catch (e) {
    return {
      ok: false,
      needReopen: true,
      action: "newpage_failed",
      error: String((e && e.message) || e || "").slice(0, 220),
      health: after,
      sweep,
      closedTargets
    };
  }

  return { ok: false, needReopen: true, action: "still_unhealthy", health: after, sweep, closedTargets };
}

module.exports = {
  isBlankUrl,
  isDeadTabUrl,
  isJunkUrl,
  isCreateMarketplaceUrl,
  isLiveWorkUrl,
  isChromeErrorUiText,
  isChromeProtocolSickError,
  pagesLookAllJunk,
  listPagesBounded,
  ensurePageBirth,
  pageAgeMs,
  clearBlankSuppress,
  armBlankSuppress,
  safeClosePage,
  sweepAboutBlankPages,
  closeJunkCdpTargets,
  probeBrowserHealth,
  cureBrowserInPlace,
  pageLooksLikeChromeNetError,
  pageLooksLikeMessengerShell,
  waitForMessengerShellOrGate,
  waitForHeavyNavLanding,
  classifyPageNavState,
  pickVirtusKeepPage,
  pickVirtusKeepPageAsync,
  closeRedundantVirtusTabs
};
