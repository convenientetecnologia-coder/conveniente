const path = require("path");

let puppeteer = null;
try {
  const pExtra = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
} catch (_) {
  puppeteer = require("puppeteer");
}

const LOG_ENABLED = String(process.env.VIRTUS_DELTA_CITY_COLLECTOR_LOG || "1").trim() === "1";
function log(...args) {
  if (!LOG_ENABLED) return;
  try { console.log("[deltaCityCollector]", ...args); } catch (_) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function createSerialQueue() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(() => fn());
    chain = run.catch(() => {});
    return run;
  };
}

function normalizeItemLink(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return `https://www.facebook.com${s}`;
  return "";
}

function sanitizeCity(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[:\-]\s*/, "")
    .trim()
    .slice(0, 80);
}

async function extractCityFromListingPage(page) {
  if (!page) return null;
  const out = await page.evaluate(() => {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const bodyText = clean(document.body && document.body.innerText ? document.body.innerText : "");
    const candidates = [];

    const push = (v, source) => {
      const c = clean(v);
      if (!c) return;
      candidates.push({ value: c, source });
    };

    const matchBodyPattern = (regex, source) => {
      const m = bodyText.match(regex);
      if (m && m[1]) push(m[1], source);
    };

    matchBodyPattern(/anunciado em\s*([^\n\r|]+)/i, "body_label_pt");
    matchBodyPattern(/listed in\s*([^\n\r|]+)/i, "body_label_en");

    const nodes = Array.from(document.querySelectorAll("span,div,a")).slice(0, 5000);
    for (const el of nodes) {
      const t = clean(el.textContent || "");
      if (!t) continue;
      if (!/anunciado em|listed in/i.test(t)) continue;

      const m = t.match(/anunciado em\s*(.+)$/i) || t.match(/listed in\s*(.+)$/i);
      if (m && m[1]) push(m[1], "dom_inline");

      const nearAnchor =
        (el.querySelector && el.querySelector("a")) ||
        (el.parentElement && el.parentElement.querySelector && el.parentElement.querySelector("a")) ||
        null;
      if (nearAnchor) {
        const v = clean(nearAnchor.textContent || "");
        if (v) push(v, "dom_anchor");
      }
    }

    return candidates;
  }).catch(() => []);

  const candidates = Array.isArray(out) ? out : [];
  for (const cand of candidates) {
    const v = sanitizeCity(cand && cand.value);
    if (!v) continue;
    if (v.length < 2) continue;
    return {
      cidade: v,
      city_source: String((cand && cand.source) || "collector_unknown"),
    };
  }
  return null;
}

async function createCollectorRuntime() {
  const userDataDir = String(
    process.env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR ||
      path.join(__dirname, "..", "dados", "chrome-session-delta-city-collector")
  ).trim();
  const executablePath =
    process.env.CHROME_PATH ||
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe");

  const headlessEnabled = String(process.env.VIRTUS_DELTA_CITY_COLLECTOR_HEADLESS || "1").trim() === "1";

  let browser = null;
  let page = null;
  const enqueue = createSerialQueue();
  let tabGuardAttached = false;

  async function pruneCollectorTabs() {
    try {
      if (!browser || !browser.isConnected || !browser.isConnected()) return;
      const pages = await browser.pages().catch(() => []);
      if (!Array.isArray(pages) || !pages.length) return;
      const primary = page && !page.isClosed() ? page : pages[0];
      page = primary;
      for (const p of pages) {
        if (!p || p === primary) continue;
        try { await p.close({ runBeforeUnload: false }); } catch (_) {}
      }
    } catch (_) {}
  }

  async function ensurePage() {
    try {
      if (browser && browser.isConnected && browser.isConnected() && page && !page.isClosed()) {
        await pruneCollectorTabs();
        return page;
      }
    } catch (_) {}

    try {
      if (browser && browser.isConnected && browser.isConnected()) {
        const pages = await browser.pages().catch(() => []);
        page = pages[0] || (await browser.newPage());
        await pruneCollectorTabs();
        return page;
      }
    } catch (_) {}

    browser = await puppeteer.launch({
      headless: headlessEnabled ? "new" : false,
      executablePath,
      userDataDir,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      defaultViewport: { width: 1366, height: 900 },
    });

    const pages = await browser.pages().catch(() => []);
    page = pages[0] || (await browser.newPage());
    await page.setDefaultTimeout(Math.max(10_000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000));
    if (!tabGuardAttached) {
      tabGuardAttached = true;
      browser.on("targetcreated", async (target) => {
        try {
          if (!target || target.type() !== "page") return;
          const newPage = await target.page().catch(() => null);
          if (!newPage || newPage === page) return;
          await pruneCollectorTabs();
        } catch (_) {}
      });
    }
    await pruneCollectorTabs();
    log(`collector iniciado headless=${headlessEnabled ? "sim" : "nao"} userDataDir=${userDataDir}`);
    return page;
  }

  async function collectCityFromItemLink({
    item_link,
    thread_key,
    account_login,
    timeoutMs,
    attempts,
  } = {}) {
    return enqueue(async () => {
      const itemLink = normalizeItemLink(item_link);
      const tk = String(thread_key || "").trim();
      const account = String(account_login || "").trim();
      const maxAttempts = Math.max(1, Number(attempts || 3) || 3);
      const navTimeoutMs = Math.max(8_000, Number(timeoutMs || process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000);

      if (!itemLink) {
        return { ok: false, error: "city_collector_item_link_missing" };
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const p = await ensurePage();
          await p.goto(itemLink, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
          await sleep(randomBetween(450, 950));

          const extracted = await extractCityFromListingPage(p);
          if (extracted && extracted.cidade) {
            log(`cidade coletada account=${account || "n/a"} thread=${tk || "n/a"} cidade="${extracted.cidade}" attempt=${attempt}`);
            return {
              ok: true,
              cidade: extracted.cidade,
              city_source: extracted.city_source || "collector_dom",
            };
          }
        } catch (e) {
          log(`tentativa falhou account=${account || "n/a"} thread=${tk || "n/a"} attempt=${attempt} error=${e && e.message ? e.message : String(e)}`);
        }
        if (attempt < maxAttempts) {
          await sleep(randomBetween(700, 1500));
        }
      }

      return {
        ok: false,
        error: "city_not_found_in_listing_page",
      };
    });
  }

  return {
    ok: true,
    collectCityFromItemLink,
    shutdown: async () => {
      try {
        if (browser && browser.isConnected && browser.isConnected()) {
          await browser.close();
        }
      } catch (_) {}
      browser = null;
      page = null;
    },
  };
}

async function getDeltaCityCollector() {
  if (!global.__deltaCityCollectorRuntimePromise) {
    global.__deltaCityCollectorRuntimePromise = createCollectorRuntime().catch((err) => {
      global.__deltaCityCollectorRuntimePromise = null;
      throw err;
    });
  }
  return global.__deltaCityCollectorRuntimePromise;
}

module.exports = {
  getDeltaCityCollector,
};
