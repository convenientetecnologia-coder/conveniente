"use strict";

/**
 * Contrato preto-no-branco anti about:blank (Robe itens + veículos + worker):
 * - Aba 0 (messages/Virtus) = keepPage — nunca varrer como lixo.
 * - Create nasce about:blank → goto URL real → ao fim close SEM goto(about:blank).
 * - Qualquer about:blank / URL vazia órfã deve morrer (sucesso ou falha do post).
 * - Suppress só durante goto create; não engessa idle.
 */

const provisionAudit = (() => {
  try { return require("./provisionAudit.js"); } catch { return null; }
})();

function isBlankUrl(url) {
  const u = String(url || "").trim();
  return !u || u === "about:blank";
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
    if (browser && browser._suppressBlankKillUntil && nome) {
      delete browser._suppressBlankKillUntil[nome];
    }
  } catch {}
}

function armBlankSuppress(browser, nome, ms = 20_000) {
  try {
    if (!browser || !nome) return;
    const guard = (browser._suppressBlankKillUntil = browser._suppressBlankKillUntil || {});
    guard[nome] = Date.now() + Math.max(1_000, Number(ms) || 20_000);
  } catch {}
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
 * Fecha todas as about:blank / URL vazia, preservando keepPage (Virtus/messages).
 * Nunca toca create/item|vehicle real.
 */
async function sweepAboutBlankPages(browser, { keepPage = null, nome = "" } = {}) {
  if (!browser) return { ok: false, closed: 0 };
  let closed = 0;
  let failed = 0;
  try {
    const pages = await Promise.race([
      browser.pages().catch(() => []),
      new Promise((resolve) => setTimeout(() => resolve([]), 3000))
    ]);
    for (const p of (pages || [])) {
      try {
        if (keepPage && p === keepPage) continue;
        try {
          if (typeof p.isClosed === "function" && p.isClosed()) continue;
        } catch {}
        let u = "";
        try { u = typeof p.url === "function" ? String(p.url() || "") : ""; } catch {}
        if (/facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u)) continue;
        if (!isBlankUrl(u)) continue;
        const r = await safeClosePage(p, { nome, reason: "sweep_about_blank" });
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
            event: "dbg_robe_sweep_about_blank",
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

module.exports = {
  isBlankUrl,
  ensurePageBirth,
  pageAgeMs,
  clearBlankSuppress,
  armBlankSuppress,
  safeClosePage,
  sweepAboutBlankPages
};
