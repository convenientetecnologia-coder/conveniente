"use strict";

/**
 * Contrato preto-no-branco anti aba-morta (Robe itens + veículos + worker):
 * - Aba 0 (messages/Virtus) = keepPage — uma só. Nunca 2 abas Virtus.
 * - Create (aba 1) nasce about:blank → goto URL real → ao fim close SEM goto(about:blank).
 * - Lixo = about:blank / URL vazia / chrome-error / Aw Snap / chromewebdata.
 * - Suppress só durante goto create (about:blank); chrome-error nunca é create válido.
 * - Cura in-place se o CDP responde; se pages()/CDP estoura timeout → needReopen.
 * - Restauração de sessão do Chrome NÃO é aba de trabalho: extra Messages/Facebook fecha.
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
      const t = await withTimeout(page.title(), 800, "");
      if (isChromeErrorUiText(t)) return true;
    }
  } catch {}
  try {
    if (typeof page.evaluate === "function") {
      const probe = await withTimeout(
        page.evaluate(() => {
          try {
            if (document.querySelector("#main-frame-error, #main-frame-info, .error-code, #error-code")) {
              return { dom: true, text: "" };
            }
            const title = String((document && document.title) || "");
            const body = String((document && document.body && document.body.innerText) || "");
            return { dom: false, text: (title + "\n" + body).slice(0, 800) };
          } catch {
            return { dom: false, text: "" };
          }
        }),
        800,
        { dom: false, text: "" }
      );
      if (probe && probe.dom === true) return true;
      if (probe && isChromeErrorUiText(probe.text)) return true;
    }
  } catch {}
  return false;
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

/**
 * Contrato: 1 aba Virtus. Create do Robe fica. Blank nascendo no portão fica.
 * Aba morta (chrome-error / ERR_TUNNEL / ERR_BLOCKED) fecha mesmo com Virtus trabalhando.
 * Segunda aba /messages viva fecha. A última aba fica para retry na mesma page.
 */
async function closeRedundantVirtusTabs(browser, { keepPage = null, nome = "", reason = "" } = {}) {
  if (!browser) return { ok: false, closed: 0, error: "no_browser" };
  const listed = await listPagesBounded(browser, 4000);
  if (listed.timedOut) return { ok: false, closed: 0, timedOut: true };
  const pages = listed.pages || [];
  if (pages.length <= 1) return { ok: true, closed: 0, kept: pages.length };

  const gateBusy = Number(browser._convenienteGateInFlight || 0) > 0;
  const states = new Map();
  for (const p of pages) {
    try {
      states.set(p, await classifyPageNavState(p));
    } catch {
      states.set(p, unknownPageNavState(p));
    }
  }
  const virtusLive = pages.filter((p) => {
    const s = states.get(p);
    return !!(s && (s.liveMessages || s.liveWork || s.loginGate));
  });

  const keep = virtusLive.length
    ? pickVirtusKeepPageFromStates(pages, keepPage || virtusLive[0], states)
    : (keepPage && pages.includes(keepPage) ? keepPage : pages[0]);
  let closed = 0;
  const closedUrls = [];
  for (const p of pages) {
    if (!p || p === keep) continue;
    const s = states.get(p) || {};
    const u = s.url || pageUrlOf(p);
    if (isCreateMarketplaceUrl(u)) continue;
    const blinding = !!(p && p._convenienteBlindarPromise);
    if (isBlankUrl(u) && (gateBusy || blinding)) continue;
    if (!virtusLive.length && !(s.deadContent || s.junkUrl)) continue;
    try {
      const r = await safeClosePage(p, { nome, reason: reason || "redundant_virtus_tab" });
      if (r && (r.closed || r.ok)) {
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
        if (Number(browser && browser._convenienteGateInFlight || 0) > 0) continue;
        if (!isJunkUrl(u)) continue;
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

  if (candidate) {
    try {
      if (!nome) throw new Error("cure_goto_no_nome");
      const browserMod = require("./browser.js");
      if (typeof browserMod.blindarPaginaDaConta !== "function") throw new Error("cure_goto_no_gate");
      await browserMod.blindarPaginaDaConta(candidate, nome, { source: "cure_goto_existing" });
      await Promise.race([
        candidate.goto(messagesUrl, { waitUntil: "domcontentloaded", timeout: 25000 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("cure_goto_timeout")), 28000))
      ]);
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
    await Promise.race([
      p.goto(messagesUrl, { waitUntil: "domcontentloaded", timeout: 25000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("cure_newpage_goto_timeout")), 28000))
    ]);
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
  classifyPageNavState,
  pickVirtusKeepPage,
  pickVirtusKeepPageAsync,
  closeRedundantVirtusTabs
};
