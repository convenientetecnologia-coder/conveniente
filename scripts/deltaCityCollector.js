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

function createLimitedQueue(maxConcurrent = 1) {
  const limit = Math.max(1, Number(maxConcurrent || 1) || 1);
  const queue = [];
  let inFlight = 0;
  const runNext = () => {
    if (inFlight >= limit) return;
    const next = queue.shift();
    if (!next) return;
    inFlight += 1;
    Promise.resolve()
      .then(() => next.fn())
      .then((out) => next.resolve(out))
      .catch((err) => next.reject(err))
      .finally(() => {
        inFlight = Math.max(0, inFlight - 1);
        runNext();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

function extractMarketplaceItemId(pathname) {
  const m = String(pathname || "").match(/\/marketplace\/item\/([0-9A-Za-z_-]+)/i);
  return m && m[1] ? String(m[1]).trim() : "";
}

function normalizeItemLink(raw) {
  const input = String(raw || "").replace(/&amp;/gi, "&").trim();
  if (!input) return "";
  try {
    const parsed = input.startsWith("http")
      ? new URL(input)
      : input.startsWith("/")
        ? new URL(input, "https://www.facebook.com")
        : null;
    if (!parsed) return "";
    const host = String(parsed.hostname || "").toLowerCase();
    if (host && !host.includes("facebook.com")) return "";
    const itemId = extractMarketplaceItemId(parsed.pathname);
    if (!itemId) return "";
    return `https://www.facebook.com/marketplace/item/${itemId}/`;
  } catch {
    return "";
  }
}

function sanitizeCity(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[:\-]\s*/, "")
    .trim()
    .slice(0, 80);
}

function toTitleCaseCityName(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (["de", "da", "do", "das", "dos", "e"].includes(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(" ")
    .trim();
}

const STATE_NAME_TO_UF = new Map([
  ["acre", "AC"],
  ["alagoas", "AL"],
  ["amapa", "AP"],
  ["amazonas", "AM"],
  ["bahia", "BA"],
  ["ceara", "CE"],
  ["distrito federal", "DF"],
  ["espirito santo", "ES"],
  ["goias", "GO"],
  ["maranhao", "MA"],
  ["mato grosso", "MT"],
  ["mato grosso do sul", "MS"],
  ["minas gerais", "MG"],
  ["para", "PA"],
  ["paraiba", "PB"],
  ["parana", "PR"],
  ["pernambuco", "PE"],
  ["piaui", "PI"],
  ["rio de janeiro", "RJ"],
  ["rio grande do norte", "RN"],
  ["rio grande do sul", "RS"],
  ["rondonia", "RO"],
  ["roraima", "RR"],
  ["santa catarina", "SC"],
  ["sao paulo", "SP"],
  ["sergipe", "SE"],
  ["tocantins", "TO"],
]);
const BR_VALID_UF = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

function normalizeStateKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeCityUfLabel(raw) {
  const s0 = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s0) return "";
  let s = s0
    .replace(/^anunciado\b.*?\bem\s+/i, "")
    .replace(/^listed\b.*?\bin\s+/i, "")
    .replace(/\s*·\s*a localiza[çc][aã]o é aproximada.*$/i, "")
    .replace(/\s*·\s*approximate location.*$/i, "")
    .replace(/\s*-\s*a localiza[çc][aã]o é aproximada.*$/i, "")
    .replace(/\s*-\s*approximate location.*$/i, "")
    .trim();
  if (!s) return "";
  const parts = s.split(/\s*·\s*/).map((p) => String(p || "").trim()).filter(Boolean);
  if (parts.length) s = parts[0];
  if (!s) return "";

  const tryBuild = (cityRaw, ufRaw) => {
    const city = toTitleCaseCityName(String(cityRaw || "").trim());
    const cityKey = String(city || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    const uf = String(ufRaw || "").trim().toUpperCase();
    if (!city || !/^[A-Z]{2}$/.test(uf)) return "";
    if (!BR_VALID_UF.has(uf)) return "";
    if (/\b(anunciado|listed)\b/.test(cityKey)) return "";
    if (/\bha\b.*\bem\b/.test(cityKey)) return "";
    if (/\bago\b.*\bin\b/.test(cityKey)) return "";
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}$/.test(city)) return "";
    return `${city} (${uf})`.slice(0, 80);
  };

  const ufPatterns = [
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*\(\s*([A-Za-z]{2})\s*\)$/,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*,\s*([A-Za-z]{2})$/,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*\/\s*([A-Za-z]{2})$/,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*[-–]\s*([A-Za-z]{2})$/,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s+([A-Za-z]{2})$/,
  ];
  for (const re of ufPatterns) {
    const m = s.match(re);
    if (!m) continue;
    const built = tryBuild(m[1], m[2]);
    if (built) return built;
  }

  const stateNamePatterns = [
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*,\s*([A-Za-zÀ-ÿ'’.\- ]{3,40})$/,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*\/\s*([A-Za-zÀ-ÿ'’.\- ]{3,40})$/,
    /^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,80}?)\s*[-–]\s*([A-Za-zÀ-ÿ'’.\- ]{3,40})$/,
  ];
  for (const re of stateNamePatterns) {
    const m = s.match(re);
    if (!m) continue;
    const stateKey = normalizeStateKey(m[2]);
    const uf = STATE_NAME_TO_UF.get(stateKey);
    if (!uf) continue;
    const built = tryBuild(m[1], uf);
    if (built) return built;
  }

  return "";
}

async function extractCityFromListingPage(page, {
  maxAttempts = 12,
  retryIntervalMs = 250,
  scanLimit = 320,
} = {}) {
  if (!page) return null;
  const attempts = Math.max(1, Math.min(20, Number(maxAttempts || 12) || 12));
  const intervalMs = Math.max(80, Math.min(700, Number(retryIntervalMs || 250) || 250));
  const nodeLimit = Math.max(80, Math.min(500, Number(scanLimit || 320) || 320));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const out = await page.evaluate((maxNodes) => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const bodyText = clean(document.body && document.body.innerText ? document.body.innerText : "");
      const candidates = [];

      const push = (v, source) => {
        const c = clean(v);
        if (!c) return;
        candidates.push({ value: c, source });
      };
      const pushFromNode = (el, sourcePrefix) => {
        if (!el) return;
        push(el.textContent || "", `${sourcePrefix}_text`);
        try { push(el.getAttribute && el.getAttribute("aria-label"), `${sourcePrefix}_aria`); } catch (_) {}
        try { push(el.getAttribute && el.getAttribute("title"), `${sourcePrefix}_title`); } catch (_) {}
        try { push(el.getAttribute && el.getAttribute("data-testid"), `${sourcePrefix}_testid`); } catch (_) {}
      };

      const matchBodyPattern = (regex, source) => {
        const m = bodyText.match(regex);
        if (m && m[1]) push(m[1], source);
      };

      matchBodyPattern(/anunciado em\s*([^\n\r|]+)/i, "body_label_pt");
      matchBodyPattern(/listed in\s*([^\n\r|]+)/i, "body_label_en");
      matchBodyPattern(/localiza[çc][aã]o(?:\s+aproximada)?\s*[:\-]\s*([^\n\r|]+)/i, "body_location_pt");
      matchBodyPattern(/approximate\s+location\s*[:\-]\s*([^\n\r|]+)/i, "body_location_en");

      const semanticNodes = Array.from(document.querySelectorAll(
        'a[href*="/marketplace/item/"], a[href*="/marketplace/"], div[data-testid="marketplace_profile_banner"], span, [aria-label*="localiza"], [aria-label*="location"]'
      )).slice(0, Math.max(1, Number(maxNodes || 320) || 320));
      for (const el of semanticNodes) {
        pushFromNode(el, "semantic_node");
      }

      const approxSpans = Array.from(document.querySelectorAll("span"))
        .map((el) => clean(el.textContent || ""))
        .filter((t) => /localiza[çc][aã]o é aproximada|approximate location/i.test(t));
      for (const value of approxSpans) push(value, "approx_location_badge");

      return candidates;
    }, nodeLimit).catch(() => []);

    const candidates = Array.isArray(out) ? out : [];
    for (const cand of candidates) {
      const v = normalizeCityUfLabel(cand && cand.value);
      if (!v) continue;
      return {
        cidade: v,
        city_source: String((cand && cand.source) || "collector_unknown"),
        attempt,
      };
    }
    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }
  return null;
}

async function dismissLoginOverlay(page) {
  if (!page) return { closed: false, escaped: false };
  let closed = false;
  try {
    closed = await page.evaluate(() => {
      const isVisible = (el) => {
        try {
          if (!el) return false;
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
          const r = el.getBoundingClientRect();
          return !!(r && r.width > 4 && r.height > 4);
        } catch (_) {
          return false;
        }
      };
      const selectors = [
        '[role="dialog"] [aria-label="Fechar"]',
        '[role="dialog"] [aria-label="Close"]',
        '[aria-modal="true"] [aria-label="Fechar"]',
        '[aria-modal="true"] [aria-label="Close"]',
        'div[aria-label="Fechar"][role="button"]',
        'div[aria-label="Close"][role="button"]',
      ];
      const nodes = [];
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) nodes.push(el);
        } catch (_) {}
      }
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        try {
          el.click();
          return true;
        } catch (_) {}
      }
      return false;
    }).catch(() => false);
  } catch (_) {
    closed = false;
  }

  let escaped = false;
  if (!closed) {
    try {
      await page.keyboard.press("Escape");
      escaped = true;
    } catch (_) {}
  }

  if (closed || escaped) {
    await sleep(randomBetween(280, 620));
  }
  return { closed, escaped };
}

async function dismissLoginOverlayPatient(page, { rounds = 3 } = {}) {
  if (!page) return { closed: false, escaped: false, rounds: 0 };
  const maxRounds = Math.max(1, Math.min(5, Number(rounds || 3) || 3));
  let closed = false;
  let escaped = false;
  for (let i = 0; i < maxRounds; i += 1) {
    const out = await dismissLoginOverlay(page);
    if (out && out.closed) closed = true;
    if (out && out.escaped) escaped = true;
    // Apos Esc/X, espera a pagina estabilizar antes da proxima rodada/scrape.
    await sleep(randomBetween(800, 1500));
  }
  return { closed, escaped, rounds: maxRounds };
}

async function waitForListingHints(page, timeoutMs) {
  if (!page) return;
  const timeout = Math.max(400, Number(timeoutMs || 0) || 1500);
  try {
    await page.waitForFunction(() => {
      const body = String((document.body && document.body.innerText) || "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (!body) return false;
      if (body.includes("anunciado em")) return true;
      if (body.includes("listed in")) return true;
      if (body.includes("localização é aproximada")) return true;
      if (body.includes("localizacao e aproximada")) return true;
      if (body.includes("approximate location")) return true;
      return Boolean(
        document.querySelector('a[href*="/marketplace/"][role="link"] span,[aria-label*="localização"],[aria-label*="location"]')
      );
    }, { timeout });
  } catch (_) {}
}

async function createCollectorRuntime() {
  const userDataDir = String(
    process.env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR ||
      path.join(__dirname, "..", "dados", "chrome-session-delta-city-collector")
  ).trim();
  const executablePath =
    process.env.CHROME_PATH ||
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe");

  // Default visivel (headed): facilita diagnostico de scrape de cidade no Marketplace.
  // Para voltar headless: VIRTUS_DELTA_CITY_COLLECTOR_HEADLESS=1
  const headlessEnabled = String(process.env.VIRTUS_DELTA_CITY_COLLECTOR_HEADLESS || "0").trim() === "1";

  let browser = null;
  let page = null;
  const collectorConcurrency = Math.max(
    1,
    Math.min(4, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_MAX_CONCURRENCY || 2) || 2)
  );
  const enqueue = createLimitedQueue(collectorConcurrency);
  const cityCacheByItem = new Map(); // itemId -> { cidade, city_source, at }
  const cityCacheTtlMs = Math.max(
    5 * 60 * 1000,
    Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_CACHE_TTL_MS || (2 * 60 * 60 * 1000)) || (2 * 60 * 60 * 1000)
  );
  const cityCacheMax = Math.max(
    200,
    Math.min(5000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_CACHE_MAX || 1200) || 1200)
  );
  let tabGuardAttached = false;

  const cityCacheGet = (itemId) => {
    const key = String(itemId || "").trim();
    if (!key) return null;
    const rec = cityCacheByItem.get(key);
    if (!rec) return null;
    const ageMs = Date.now() - (Number(rec.at || 0) || 0);
    if (ageMs > cityCacheTtlMs) {
      cityCacheByItem.delete(key);
      return null;
    }
    return rec;
  };
  const cityCacheSet = (itemId, cidade, city_source) => {
    const key = String(itemId || "").trim();
    const city = String(cidade || "").trim();
    if (!key || !city) return;
    cityCacheByItem.set(key, {
      cidade: city,
      city_source: String(city_source || "collector_cache"),
      at: Date.now()
    });
    if (cityCacheByItem.size > cityCacheMax) {
      const entries = [...cityCacheByItem.entries()]
        .sort((a, b) => (Number(a[1] && a[1].at || 0) || 0) - (Number(b[1] && b[1].at || 0) || 0));
      const toDelete = Math.max(1, cityCacheByItem.size - cityCacheMax);
      for (let i = 0; i < toDelete; i += 1) {
        const oldKey = String(entries[i] && entries[i][0] || "").trim();
        if (oldKey) cityCacheByItem.delete(oldKey);
      }
    }
  };

  async function applySessionCookies(pageRef, sessionCookies) {
    try {
      const p = pageRef;
      if (!p || !Array.isArray(sessionCookies) || !sessionCookies.length) return { applied: 0 };
      const safeCookies = sessionCookies
        .filter((ck) => ck && typeof ck === "object")
        .map((ck) => ({
          name: String(ck.name || "").trim(),
          value: String(ck.value || ""),
          domain: String(ck.domain || "").trim() || ".facebook.com",
          path: String(ck.path || "/"),
          expires: Number(ck.expires || 0) || undefined,
          httpOnly: !!ck.httpOnly,
          secure: ck.secure !== false,
          sameSite: (String(ck.sameSite || "").trim() || undefined),
        }))
        .filter((ck) => !!ck.name);
      if (!safeCookies.length) return { applied: 0 };
      await p.setCookie(...safeCookies);
      return { applied: safeCookies.length };
    } catch {
      return { applied: 0 };
    }
  }

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
    session_cookies,
  } = {}) {
    return enqueue(async () => {
      const itemLink = normalizeItemLink(item_link);
      const tk = String(thread_key || "").trim();
      const account = String(account_login || "").trim();
      const itemId = (() => {
        try {
          if (!itemLink) return "";
          const u = new URL(itemLink);
          return extractMarketplaceItemId(u.pathname);
        } catch {
          return "";
        }
      })();
      const maxAttempts = Math.max(1, Number(attempts || 3) || 3);
      const navTimeoutMs = Math.max(8_000, Number(timeoutMs || process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000);

      if (!itemLink) {
        return { ok: false, error: "city_collector_item_link_missing" };
      }
      if (itemId) {
        const cached = cityCacheGet(itemId);
        if (cached && cached.cidade) {
          return {
            ok: true,
            cidade: String(cached.cidade),
            city_source: String(cached.city_source || "collector_cache"),
            cached: true,
          };
        }
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const p = await ensurePage();
          await applySessionCookies(p, session_cookies);
          await p.goto(itemLink, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
          await sleep(randomBetween(500, 1100));
          await dismissLoginOverlayPatient(p, { rounds: 3 });
          await waitForListingHints(p, Math.min(5000, Math.max(2500, Math.floor(navTimeoutMs / 3))));

          let extracted = await extractCityFromListingPage(p, {
            maxAttempts: 12,
            retryIntervalMs: 500,
            scanLimit: 320,
          });
          if (!extracted || !extracted.cidade) {
            // Segunda passada: fecha pop-up de novo, espera hidratar e relê o DOM.
            await dismissLoginOverlayPatient(p, { rounds: 2 });
            await waitForListingHints(p, 3000);
            extracted = await extractCityFromListingPage(p, {
              maxAttempts: 8,
              retryIntervalMs: 400,
              scanLimit: 320,
            });
          }
          if (extracted && extracted.cidade) {
            if (itemId) {
              cityCacheSet(itemId, extracted.cidade, extracted.city_source || "collector_dom");
            }
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
