// scripts/browser.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const utils = require('./utils.js');
const logger = require('./logger.js');
const gptFallback = require('./gptFallback.js');
const { readGroqConfig } = require('./groqConfig.js');
const provisionAudit = require('./provisionAudit.js');
const gatewayProxy = require('./gatewayProxy');
const fileStore = require('./fileStore.js');
const glassViewer = require('./glassViewer.js');

// Stealth permanece LIGADO (webdriver, plugins, permissions, codecs, chrome.*).
// user-agent-override continua off (a UA da conta é o patchPage).
// languages / hardwareConcurrency / webgl.vendor saem do default do plugin
// (en-US, 4 núcleos, Iris OpenGL) e entram como instâncias configuráveis
// para cantar a mesma voz do patchPage por conta.
const stealthLanguages = require('puppeteer-extra-plugin-stealth/evasions/navigator.languages')({
  languages: ['pt-BR', 'pt']
});
const stealthHwc = require('puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency')({
  hardwareConcurrency: 8
});
const stealthWebgl = require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor')({
  vendor: 'Intel Inc.',
  renderer: 'Intel(R) UHD Graphics 620'
});
const stealthPlugin = StealthPlugin();
try { stealthPlugin.enabledEvasions.delete('user-agent-override'); } catch {}
try { stealthPlugin.enabledEvasions.delete('navigator.languages'); } catch {}
try { stealthPlugin.enabledEvasions.delete('navigator.hardwareConcurrency'); } catch {}
try { stealthPlugin.enabledEvasions.delete('webgl.vendor'); } catch {}
puppeteer.use(stealthLanguages);
puppeteer.use(stealthHwc);
puppeteer.use(stealthWebgl);
puppeteer.use(stealthPlugin);

function syncStealthVoiceForAccount({ languages, hardwareConcurrency, webglVendor, webglRenderer } = {}) {
  try {
    const langs = Array.isArray(languages) && languages.length
      ? languages.map((x) => String(x || '')).filter(Boolean)
      : ['pt-BR', 'pt'];
    if (langs.length) stealthLanguages.opts.languages = langs;
  } catch {}
  try {
    const hwc = Number(hardwareConcurrency);
    stealthHwc.opts.hardwareConcurrency = (Number.isFinite(hwc) && hwc >= 2 && hwc <= 32) ? Math.floor(hwc) : 8;
  } catch {}
  try {
    if (webglVendor) stealthWebgl.opts.vendor = String(webglVendor);
    if (webglRenderer) stealthWebgl.opts.renderer = String(webglRenderer);
  } catch {}
}

async function syncStealthFromManifest(nome, manifest) {
  const who = String(nome || '').trim();
  const man = (manifest && typeof manifest === 'object') ? manifest : {};
  const proxyResolved = gatewayProxy.resolveProxyForProfile({ profileName: who, manifest: man });
  const proxyCountry = String(proxyResolved && proxyResolved.slot && proxyResolved.slot.country || '').trim().toLowerCase() || 'br';
  const antiState = await ensureFingerprintProfileState({ nome: who, manifest: man, proxyCountry });
  syncStealthVoiceForAccount({
    languages: antiState.navigatorLanguages,
    hardwareConcurrency: (man.fp && man.fp.hardwareConcurrency) || 8,
    webglVendor: antiState.webglVendor,
    webglRenderer: antiState.webglRenderer
  });
  return antiState;
}

const DESIRED_ENGINE_PATH = path.join(__dirname, '..', 'dados', 'desired.json');
let __desiredEngineCache = { at: 0, engine: 'delta' };
function readDesiredVirtusEngineRuntimeBestEffort() {
  try {
    const now = Date.now();
    if (__desiredEngineCache && __desiredEngineCache.at && (now - __desiredEngineCache.at) < 2000) {
      return __desiredEngineCache.engine || 'delta';
    }
    const raw = fs.readFileSync(DESIRED_ENGINE_PATH, 'utf8');
    const desired = raw ? JSON.parse(raw) : null;
    const eng =
      (desired && desired._autoMode && desired._autoMode.engine) ||
      (desired && desired.autoMode && desired.autoMode.engine) ||
      (desired && desired.engine) ||
      '';
    const normalized = String(eng || '').trim().toLowerCase();
    const out = (normalized === 'legacy') ? 'legacy' : 'delta';
    __desiredEngineCache = { at: now, engine: out };
    return out;
  } catch {
    return 'delta';
  }
}
function isDeltaMotorEnabledRuntime() {
  return readDesiredVirtusEngineRuntimeBestEffort() === 'delta';
}

/**
 * Traz a janela do navegador para frente e maximiza.
 * Use SOMENTE ao injetar cookies ou invocar humano.
 */
async function bringWindowToFront(page) {
  try {
    await page.bringToFront();
    if (page.isClosed && typeof page.isClosed === 'function' && page.isClosed()) return;
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/Target closed|Network\.enable|Protocol error/i.test(msg)) logger.warn('[bringWindowToFront] CDP falhou (target/timeout) — skip maximizar', { err: msg.slice(0, 80) });
    try { await page.bringToFront(); } catch {}
  }
  try { await glassViewer.applyGlassViewer(page, { source: 'bringWindowToFront' }); } catch {}
}

/**
 * Injeta cookies normalizados numa page/context (campo seguro)
 */
async function injectCookies(page, cookies) {
  try {
    if (!Array.isArray(cookies) || !cookies.length) return;
    const allowed = ['name','value','domain','path','expires','httpOnly','secure','sameSite'];
    const fixDomain = (d) => {
      let dd = String(d || '.facebook.com').replace(/\s/g, '').toLowerCase();
      if (!dd.startsWith('.')) dd = '.' + dd;
      if (!dd.includes('.facebook.com')) dd = '.facebook.com';
      return dd;
    };
    const fixPath = (p) => (typeof p === 'string' ? p.trim() : '/');
    const ascii = (s) => String(s || '').normalize('NFD').replace(/[^\w\-]/g, '');
    const filtered = cookies.map(c => {
      const obj = {};
      for (const k of allowed) {
        if (c[k] !== undefined) {
          if (k === 'httpOnly' || k === 'secure') {
            obj[k] = Boolean(c[k] === true || c[k] === 'true' || c[k] === 1 || c[k] === '1');
          } else if (k === 'domain') {
            obj[k] = fixDomain(c[k]);
          } else if (k === 'path') {
            obj[k] = fixPath(c[k]);
          } else if (k === 'name') {
            obj[k] = ascii(c[k]);
          } else if (k === 'expires') {
            let v = Number(c[k]);
            if (Number.isNaN(v) && c.expirationDate) v = Number(c.expirationDate);
            if (Number.isNaN(v) && c.datadeexpiraao) v = Number(c.datadeexpiraao) / 1000;
            if (Number.isFinite(v) && v > 1000000000) obj[k] = Math.floor(v); // segundos
          } else {
            obj[k] = String(c[k]);
          }
        }
      }
      obj.name = ascii(obj.name || '');
      obj.value = String(obj.value || '');
      obj.domain = fixDomain(obj.domain);
      obj.path = fixPath(obj.path);
      return obj;
    }).filter(c => c.name && c.value && c.domain && c.path);
    if (process.env.BROWSER_DEBUG === '1') {
      logger.debug('[COOKIES] PARA INJETAR FINAL:', { cookies: filtered });
    }
    await page.setCookie(...filtered);
    if (process.env.BROWSER_DEBUG === '1') {
      logger.debug('[COOKIES] setCookie OK');
    }
  } catch (e) {
    if (process.env.BROWSER_DEBUG === '1') {
      logger.warn('[browser.js] Erro ao injetar cookies: ' + (e && e.message));
    }
  }
}

// ===============================
// patchPage agora usa leitura correta do manifest
// ===============================
const manifestStore = require('./manifestStore.js');
const cohortLedgerPath = path.join(__dirname, '..', 'dados', 'cohort_ledger.json');

const COUNTRY_LOCALE_PROFILES = {
  br: {
    timezones: ['America/Sao_Paulo', 'America/Fortaleza', 'America/Manaus', 'America/Belem'],
    languages: [
      { navigatorLanguage: 'pt-BR', navigatorLanguages: ['pt-BR', 'pt', 'en-US', 'en'], acceptLanguage: 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' },
      { navigatorLanguage: 'pt-BR', navigatorLanguages: ['pt-BR', 'pt', 'en'], acceptLanguage: 'pt-BR,pt;q=0.9,en;q=0.7' }
    ]
  },
  us: {
    timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles'],
    languages: [
      { navigatorLanguage: 'en-US', navigatorLanguages: ['en-US', 'en'], acceptLanguage: 'en-US,en;q=0.9' }
    ]
  }
};

const FINGERPRINT_COHORTS = [
  {
    id: 'intel_hd_520',
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel(R) HD Graphics 520',
    deviceMemory: 4,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Verdana']
  },
  {
    id: 'intel_uhd_620',
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel(R) UHD Graphics 620',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Times New Roman', 'Verdana']
  },
  {
    id: 'intel_uhd_630',
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel(R) UHD Graphics 630',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Times New Roman', 'Trebuchet MS']
  },
  {
    id: 'intel_iris_xe',
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel(R) Iris(R) Xe Graphics',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Roboto', 'Verdana']
  },
  {
    id: 'amd_vega_8',
    webglVendor: 'ATI Technologies Inc.',
    webglRenderer: 'AMD Radeon(TM) Vega 8 Graphics',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Trebuchet MS']
  },
  {
    id: 'amd_rx_560',
    webglVendor: 'ATI Technologies Inc.',
    webglRenderer: 'AMD Radeon RX 560 Series',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Verdana']
  },
  {
    id: 'nvidia_gtx_1060',
    webglVendor: 'NVIDIA Corporation',
    webglRenderer: 'NVIDIA GeForce GTX 1060 6GB/PCIe/SSE2',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Verdana']
  },
  {
    id: 'nvidia_gtx_1650',
    webglVendor: 'NVIDIA Corporation',
    webglRenderer: 'NVIDIA GeForce GTX 1650/PCIe/SSE2',
    deviceMemory: 8,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Verdana']
  },
  {
    id: 'nvidia_rtx_2060',
    webglVendor: 'NVIDIA Corporation',
    webglRenderer: 'NVIDIA GeForce RTX 2060/PCIe/SSE2',
    deviceMemory: 16,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Verdana']
  },
  {
    id: 'amd_rx_580',
    webglVendor: 'ATI Technologies Inc.',
    webglRenderer: 'AMD Radeon RX 580 Series',
    deviceMemory: 16,
    maxTouchPoints: 0,
    plugins: ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
    fonts: ['Arial', 'Calibri', 'Segoe UI', 'Tahoma', 'Trebuchet MS']
  }
];

function readCohortLedgerSafe() {
  try {
    const raw = fs.readFileSync(cohortLedgerPath, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.profiles && typeof j.profiles === 'object') return j;
  } catch {}
  return { version: 1, updatedAt: 0, profiles: {} };
}

function writeCohortLedgerSafe(ledger) {
  try {
    const dir = path.dirname(cohortLedgerPath);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = `${cohortLedgerPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8');
    fs.renameSync(tmp, cohortLedgerPath);
    return true;
  } catch {
    return false;
  }
}

function buildCohortCounts(ledger) {
  const counts = {};
  const profiles = (ledger && ledger.profiles && typeof ledger.profiles === 'object') ? ledger.profiles : {};
  for (const row of Object.values(profiles)) {
    const id = String(row && row.cohortId || '').trim();
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

function hashToUInt32(input) {
  const h = crypto.createHash('sha256').update(String(input || ''), 'utf8').digest();
  return h.readUInt32BE(0) >>> 0;
}

function pickBySeed(arr, seed) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const idx = Math.abs(Number(seed || 0)) % arr.length;
  return arr[idx];
}

function resolveLocaleByCountry({ country, seed }) {
  const cc = String(country || 'br').trim().toLowerCase();
  const profile = COUNTRY_LOCALE_PROFILES[cc] || COUNTRY_LOCALE_PROFILES.br;
  const tz = pickBySeed(profile.timezones, seed) || 'America/Sao_Paulo';
  const langPack = pickBySeed(profile.languages, seed >> 1) || profile.languages[0];
  return {
    country: cc,
    timezone: String(tz || 'America/Sao_Paulo'),
    navigatorLanguage: String(langPack.navigatorLanguage || 'pt-BR'),
    navigatorLanguages: Array.isArray(langPack.navigatorLanguages) ? langPack.navigatorLanguages.slice() : ['pt-BR', 'pt', 'en-US', 'en'],
    acceptLanguage: String(langPack.acceptLanguage || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7')
  };
}

function resolveCohortByProfile({ manifest, seed, forcedCohortId = '' }) {
  const m = (manifest && typeof manifest === 'object') ? manifest : {};
  const profileName = String(m.nome || '').trim();
  const vp = (m.fp && m.fp.viewport && typeof m.fp.viewport === 'object') ? m.fp.viewport : {};
  const hc = Number(m.fp && m.fp.hardwareConcurrency || 8) || 8;
  const width = Number(vp.width || 1366) || 1366;
  const uaMajor = Number((String(m.uaString || '').match(/Chrome\/(\d+)\./) || [])[1] || 0) || 0;
  // Coorte técnica plausível: hardware + viewport direcionam GPU provável.
  const bucket = (() => {
    if (hc <= 4 || width <= 1366) return ['intel_hd_520', 'intel_uhd_620'];
    if (hc <= 8 && width <= 1600) return ['intel_uhd_620', 'intel_uhd_630', 'amd_vega_8'];
    if (hc <= 12 && width <= 1920) return ['intel_iris_xe', 'nvidia_gtx_1060', 'nvidia_gtx_1650', 'amd_rx_560'];
    if (hc <= 16) return ['nvidia_gtx_1650', 'nvidia_rtx_2060', 'amd_rx_560', 'amd_rx_580'];
    return ['nvidia_rtx_2060', 'amd_rx_580'];
  })();
  let pool = FINGERPRINT_COHORTS.filter((c) => bucket.includes(c.id));
  // Leve amarra com geração do navegador: majors mais novos tendem a hardware mais novo.
  if (uaMajor >= 136) {
    const newer = pool.filter((c) => ['intel_iris_xe', 'nvidia_gtx_1650', 'nvidia_rtx_2060', 'amd_rx_560', 'amd_rx_580'].includes(c.id));
    if (newer.length) pool = newer;
  }
  const candidates = pool.length ? pool : FINGERPRINT_COHORTS;
  const forced = String(forcedCohortId || '').trim();
  if (forced) {
    const forcedHit = FINGERPRINT_COHORTS.find((c) => c.id === forced);
    if (forcedHit) {
      if (profileName) {
        const ledger = readCohortLedgerSafe();
        const profiles = (ledger.profiles && typeof ledger.profiles === 'object') ? ledger.profiles : {};
        profiles[profileName] = { cohortId: forcedHit.id, updatedAt: Date.now() };
        writeCohortLedgerSafe({ version: 1, updatedAt: Date.now(), profiles });
      }
      return forcedHit;
    }
  }
  if (!profileName) return pickBySeed(candidates, seed) || FINGERPRINT_COHORTS[0];

  // Sticky + diversidade global: usa ledger persistente de coortes por perfil.
  // Regra: reutiliza coorte já atribuída; se novo perfil, escolhe a menos usada.
  const ledger = readCohortLedgerSafe();
  const profiles = (ledger.profiles && typeof ledger.profiles === 'object') ? ledger.profiles : {};
  const existing = profiles[profileName] && String(profiles[profileName].cohortId || '').trim();
  if (existing) {
    const keep = candidates.find((c) => c.id === existing);
    if (keep) return keep;
  }

  const counts = buildCohortCounts(ledger);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let min = Number.POSITIVE_INFINITY;
  let bestIds = [];
  for (const c of candidates) {
    const n = Number(counts[c.id] || 0) || 0;
    if (n < min) {
      min = n;
      bestIds = [c.id];
    } else if (n === min) {
      bestIds.push(c.id);
    }
  }
  const chosenId = pickBySeed(bestIds, seed) || bestIds[0] || candidates[0].id;
  const chosen = byId.get(chosenId) || candidates[0];
  profiles[profileName] = { cohortId: chosen.id, updatedAt: Date.now() };
  const nextLedger = { version: 1, updatedAt: Date.now(), profiles };
  writeCohortLedgerSafe(nextLedger);
  return chosen;
}

async function ensureFingerprintProfileState({ nome, manifest, proxyCountry }) {
  const m0 = (manifest && typeof manifest === 'object') ? manifest : {};
  const anti = (m0.antiDetect && typeof m0.antiDetect === 'object') ? { ...m0.antiDetect } : {};
  let seed = Number(anti.seed || 0) || 0;
  if (!seed) {
    const cUser = (() => {
      try {
        const cookies = Array.isArray(m0.cookies) ? m0.cookies : [];
        const row = cookies.find((c) => c && c.name === 'c_user');
        return String((row && row.value) || '');
      } catch { return ''; }
    })();
    seed = hashToUInt32(`${nome}|${m0.uaPresetId || ''}|${cUser || ''}|${m0.createdAt || ''}`);
  }
  if (!seed) seed = hashToUInt32(nome || 'profile');
  const locale = resolveLocaleByCountry({ country: proxyCountry || anti.country || 'br', seed });
  let forcedCohortId = '';
  try {
    const byCt = gatewayProxy.resolveCohortForProfile({ profileName: nome, manifest: m0 });
    if (byCt && byCt.enabled === true) forcedCohortId = String(byCt.cohortId || '').trim();
  } catch {}
  const cohort = resolveCohortByProfile({ manifest: m0, seed, forcedCohortId });
  const canvasNoise = Number((seed % 9) + 1);
  const audioNoise = Number((seed % 13) + 1) / 100000;
  const state = {
    seed,
    country: locale.country,
    timezone: locale.timezone,
    navigatorLanguage: locale.navigatorLanguage,
    navigatorLanguages: locale.navigatorLanguages,
    acceptLanguage: locale.acceptLanguage,
    cohortId: cohort.id,
    webglVendor: cohort.webglVendor,
    webglRenderer: cohort.webglRenderer,
    plugins: cohort.plugins,
    fonts: cohort.fonts,
    deviceMemory: Number(cohort.deviceMemory || 8) || 8,
    maxTouchPoints: Number(cohort.maxTouchPoints || 0) || 0,
    canvasNoise,
    audioNoise,
    updatedAt: Date.now()
  };
  try {
    await manifestStore.update(nome, (cur) => {
      const next = Object.assign({}, cur || {});
      next.antiDetect = Object.assign({}, next.antiDetect || {}, state);
      return next;
    });
  } catch {}
  return state;
}

function resolveAccountWindowBounds(manifest) {
  const vp = (manifest && manifest.fp && manifest.fp.viewport && typeof manifest.fp.viewport === 'object')
    ? manifest.fp.viewport
    : {};
  let width = Math.floor(Number(vp.width) || 0);
  let height = Math.floor(Number(vp.height) || 0);
  if (width < 800 || height < 600) {
    width = 1366;
    height = 768;
  }
  if (width > 3840) width = 3840;
  if (height > 2160) height = 2160;
  const left = Math.floor(Math.random() * 600);
  const top = Math.floor(Math.random() * 400);
  return { width, height, left, top };
}

function installAccountFingerprintHooks(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  try {
    if (window.__convenienteFpHooks === true) return;
    window.__convenienteFpHooks = true;
  } catch {}

  const safeDefine = (obj, key, getter) => {
    try {
      Object.defineProperty(obj, key, { get: getter, configurable: true });
    } catch {}
  };

  const canvasNoise = Number(cfg.canvasNoise || 1) || 1;
  const audioNoise = Number(cfg.audioNoise || 0.00001) || 0.00001;

  const applyCanvasNoise = (data) => {
    try {
      if (!data || data.length < 4) return;
      const n = ((canvasNoise % 9) + 1) | 0;
      const pixels = (data.length / 4) | 0;
      if (pixels < 1) return;
      const marks = [
        0,
        4 * ((n * 13) % pixels),
        4 * ((n * 29) % pixels),
        4 * ((n * 47) % pixels)
      ];
      for (let k = 0; k < marks.length; k++) {
        const i = marks[k];
        if (i >= 0 && i < data.length) data[i] = (data[i] + n) % 256;
      }
    } catch {}
  };

  const applyAudioNoise = (data) => {
    try {
      if (!data || data.length < 8) return;
      const lim = Math.min(data.length, 32);
      for (let i = 0; i < lim; i++) {
        data[i] = data[i] + (audioNoise * ((i % 5) + 1));
      }
    } catch {}
  };

  const applyPixelBufferNoise = (pixels) => {
    try {
      if (!pixels || pixels.length < 4) return;
      const n = ((canvasNoise % 9) + 1) | 0;
      const i = (n * 7) % pixels.length;
      pixels[i] = (Number(pixels[i]) + n) % 256;
    } catch {}
  };

  safeDefine(navigator, 'language', () => cfg.navigatorLanguage);
  safeDefine(navigator, 'languages', () => (cfg.navigatorLanguages || []).slice());
  safeDefine(navigator, 'platform', () => 'Win32');
  safeDefine(navigator, 'webdriver', () => undefined);
  safeDefine(navigator, 'deviceMemory', () => cfg.deviceMemory);
  safeDefine(navigator, 'maxTouchPoints', () => cfg.maxTouchPoints);
  if (cfg.hardwareConcurrency) {
    safeDefine(navigator, 'hardwareConcurrency', () => cfg.hardwareConcurrency);
  }

  const ro = Intl.DateTimeFormat.prototype.resolvedOptions;
  if (typeof ro === 'function') {
    Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      const out = ro.apply(this, arguments);
      return Object.assign({}, out, { timeZone: cfg.timezone, locale: cfg.navigatorLanguage });
    };
  }

  const fakePlugins = (cfg.plugins || []).map((name, idx) => ({
    name,
    filename: `internal-${idx}.dll`,
    description: name
  }));
  const pluginArray = Object.assign(fakePlugins.slice(), {
    item: (i) => fakePlugins[i] || null,
    namedItem: (n) => fakePlugins.find((p) => p && p.name === n) || null,
    refresh: () => {}
  });
  safeDefine(navigator, 'plugins', () => pluginArray);
  safeDefine(navigator, 'mimeTypes', () => ({ length: 0, item: () => null, namedItem: () => null }));

  const patchWebGl = (Proto) => {
    if (!Proto || !Proto.prototype || !Proto.prototype.getParameter) return;
    const originalGetParameter = Proto.prototype.getParameter;
    const originalGetExtension = Proto.prototype.getExtension;
    const originalReadPixels = Proto.prototype.readPixels;
    const wrappedGetParameter = function (param) {
      if (param === 37445) return cfg.webglVendor;
      if (param === 37446) return cfg.webglRenderer;
      return originalGetParameter.apply(this, arguments);
    };
    const wrappedGetExtension = function (name) {
      const n = String(name || '').toUpperCase();
      if (n === 'WEBGL_DEBUG_RENDERER_INFO') {
        return {
          UNMASKED_VENDOR_WEBGL: 37445,
          UNMASKED_RENDERER_WEBGL: 37446
        };
      }
      return originalGetExtension ? originalGetExtension.apply(this, arguments) : null;
    };
    const wrappedReadPixels = function () {
      const out = originalReadPixels ? originalReadPixels.apply(this, arguments) : undefined;
      try {
        const pixels = arguments.length ? arguments[arguments.length - 1] : null;
        applyPixelBufferNoise(pixels);
      } catch {}
      return out;
    };
    try {
      Object.defineProperty(Proto.prototype, 'getParameter', { value: wrappedGetParameter, configurable: true });
    } catch {
      try { Proto.prototype.getParameter = wrappedGetParameter; } catch {}
    }
    try {
      Object.defineProperty(Proto.prototype, 'getExtension', { value: wrappedGetExtension, configurable: true });
    } catch {
      try { Proto.prototype.getExtension = wrappedGetExtension; } catch {}
    }
    if (originalReadPixels) {
      try {
        Object.defineProperty(Proto.prototype, 'readPixels', { value: wrappedReadPixels, configurable: true });
      } catch {
        try { Proto.prototype.readPixels = wrappedReadPixels; } catch {}
      }
    }
  };

  const installWebglContextWrapper = () => {
    try {
      const proto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
      if (!proto || proto.__adWebglCtxWrapped) return;
      const originalGetContext = proto.getContext;
      proto.getContext = function (type) {
        const ctx = originalGetContext.apply(this, arguments);
        const t = String(type || '').toLowerCase();
        if (ctx && (t === 'webgl' || t === 'experimental-webgl' || t === 'webgl2')) {
          try {
            const gp = ctx.getParameter && ctx.getParameter.bind(ctx);
            const ge = ctx.getExtension && ctx.getExtension.bind(ctx);
            const rp = ctx.readPixels && ctx.readPixels.bind(ctx);
            if (gp) {
              ctx.getParameter = function (param) {
                if (param === 37445) return cfg.webglVendor;
                if (param === 37446) return cfg.webglRenderer;
                return gp(param);
              };
            }
            if (ge) {
              ctx.getExtension = function (name) {
                const n = String(name || '').toUpperCase();
                if (n === 'WEBGL_DEBUG_RENDERER_INFO') {
                  return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
                }
                return ge(name);
              };
            }
            if (rp) {
              ctx.readPixels = function () {
                const out = rp.apply(this, arguments);
                try {
                  const pixels = arguments.length ? arguments[arguments.length - 1] : null;
                  applyPixelBufferNoise(pixels);
                } catch {}
                return out;
              };
            }
          } catch {}
        }
        return ctx;
      };
      proto.__adWebglCtxWrapped = true;
    } catch {}
  };
  patchWebGl(window.WebGLRenderingContext);
  patchWebGl(window.WebGL2RenderingContext);
  installWebglContextWrapper();

  if (window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype && window.CanvasRenderingContext2D.prototype.getImageData) {
    const originalGetImageData = window.CanvasRenderingContext2D.prototype.getImageData;
    window.CanvasRenderingContext2D.prototype.getImageData = function () {
      const imageData = originalGetImageData.apply(this, arguments);
      try {
        if (imageData && imageData.data) applyCanvasNoise(imageData.data);
      } catch {}
      return imageData;
    };
  }

  const noiseCloneAndCall = (canvasEl, origMethod, args) => {
    const c = document.createElement('canvas');
    c.width = canvasEl.width;
    c.height = canvasEl.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(canvasEl, 0, 0);
    try {
      const img = ctx.getImageData(0, 0, c.width, c.height);
      ctx.putImageData(img, 0, 0);
    } catch {}
    return origMethod.apply(c, args);
  };

  if (window.HTMLCanvasElement && window.HTMLCanvasElement.prototype) {
    const origToDataURL = window.HTMLCanvasElement.prototype.toDataURL;
    window.HTMLCanvasElement.prototype.toDataURL = function () {
      try {
        return noiseCloneAndCall(this, origToDataURL, arguments);
      } catch {
        return origToDataURL.apply(this, arguments);
      }
    };
    if (typeof window.HTMLCanvasElement.prototype.toBlob === 'function') {
      const origToBlob = window.HTMLCanvasElement.prototype.toBlob;
      window.HTMLCanvasElement.prototype.toBlob = function () {
        try {
          return noiseCloneAndCall(this, origToBlob, arguments);
        } catch {
          return origToBlob.apply(this, arguments);
        }
      };
    }
  }

  try {
    if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype && OffscreenCanvas.prototype.convertToBlob) {
      const origConvert = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function () {
        try {
          const c = new OffscreenCanvas(this.width, this.height);
          const ctx = c.getContext('2d');
          ctx.drawImage(this, 0, 0);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          ctx.putImageData(img, 0, 0);
          return origConvert.apply(c, arguments);
        } catch {
          return origConvert.apply(this, arguments);
        }
      };
    }
  } catch {}

  if (window.AudioBuffer && window.AudioBuffer.prototype && window.AudioBuffer.prototype.getChannelData) {
    const originalGetChannelData = window.AudioBuffer.prototype.getChannelData;
    window.AudioBuffer.prototype.getChannelData = function () {
      const data = originalGetChannelData.apply(this, arguments);
      applyAudioNoise(data);
      return data;
    };
  }
  if (window.AudioBuffer && window.AudioBuffer.prototype && window.AudioBuffer.prototype.copyFromChannel) {
    const originalCopyFromChannel = window.AudioBuffer.prototype.copyFromChannel;
    window.AudioBuffer.prototype.copyFromChannel = function (destination) {
      const out = originalCopyFromChannel.apply(this, arguments);
      applyAudioNoise(destination);
      return out;
    };
  }

  try {
    const fonts = Array.isArray(cfg.fonts) ? cfg.fonts.map((x) => String(x || '').toLowerCase()) : [];
    if (document.fonts && typeof document.fonts.check === 'function') {
      const originalCheck = document.fonts.check.bind(document.fonts);
      document.fonts.check = function (font) {
        try {
          const family = String(font || '').toLowerCase();
          if (fonts.some((f) => family.includes(f))) return true;
        } catch {}
        return originalCheck.apply(this, arguments);
      };
    }
  } catch {}

  window.chrome = window.chrome || { runtime: {} };
  if (typeof window.Notification === 'undefined') {
    try {
      const NotificationShim = function Notification() {
        throw new TypeError('Illegal constructor');
      };
      NotificationShim.permission = 'denied';
      NotificationShim.requestPermission = () => Promise.resolve('denied');
      Object.defineProperty(window, 'Notification', {
        value: NotificationShim,
        configurable: true,
        writable: true
      });
    } catch {}
  }
}

async function persistAlignedUa(nome, aligned) {
  if (!nome || !aligned || !aligned.changed) return;
  try {
    await manifestStore.update(nome, (cur) => {
      const next = Object.assign({}, cur || {});
      next.uaString = aligned.uaString;
      next.uaCh = aligned.uaCh;
      return next;
    });
  } catch {}
  try {
    fileStore.withPerfisFileLockUpdate((arr) => {
      return (Array.isArray(arr) ? arr : []).map((p) => {
        if (!p || p.nome !== nome) return p;
        return Object.assign({}, p, { uaString: aligned.uaString, uaCh: aligned.uaCh });
      });
    }, { caller: 'ua_align_binary', nome });
  } catch {}
  try {
    const recPath = path.join(__dirname, '..', 'dados', 'perfis', String(nome), 'perfil.json');
    const existing = fileStore.readJsonSafe(recPath, null) || {};
    fileStore.writePerfilRecord(Object.assign({}, existing, {
      nome,
      uaString: aligned.uaString,
      uaCh: aligned.uaCh,
      userDataDir: existing.userDataDir || null
    }), { caller: 'ua_align_binary' });
  } catch {}
}

async function patchPage(nome, page, coords) {
  // BLINDAGEM: nome obrigatório
  if (!nome) throw new Error('manifest_incomplete: nome ausente (perfil corrompido)');

  let manifest = null;
  try {
    // Tente ler do manifestStore
    manifest = await manifestStore.read(nome);

    // FALLBACK: Se não tem userDataDir, tenta perfis.json
    if (!manifest || !manifest.userDataDir) {
      const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
      const perfil = perfisArr.find(p => p && p.nome === nome);
      if (perfil && perfil.userDataDir) {
        manifest = Object.assign({}, perfil, manifest || {});
        await manifestStore.write(nome, manifest);
      }
    }
  } catch (e) {}

  // Hard-check — se manifest ou nome ou userDataDir estão inválidos, throw explicativo
  if (!manifest || !manifest.nome || !manifest.userDataDir) {
    // Opcional: log no disco ou em issues.json — aqui preferimos fail fast/clear
    throw new Error('manifest_incomplete: Falta nome/userDataDir para ' + (nome || 'undefined') + '. Corrija manifest/perfis.json para autocura.');
  }

  // --- RESTANTE INALTERADO (só troquei para usar manifest lido acima) ---
  const viewport = manifest.fp?.viewport || { width: 1366, height: 768 };
  const dpr = manifest.fp?.dpr || 1;
  const hardwareConcurrency = manifest.fp?.hardwareConcurrency || 8;
  const proxyResolved = gatewayProxy.resolveProxyForProfile({ profileName: nome, manifest });
  const proxyCountry = String(proxyResolved && proxyResolved.slot && proxyResolved.slot.country || '').trim().toLowerCase() || 'br';
  const antiState = await ensureFingerprintProfileState({ nome, manifest, proxyCountry });
  syncStealthVoiceForAccount({
    languages: antiState.navigatorLanguages,
    hardwareConcurrency,
    webglVendor: antiState.webglVendor,
    webglRenderer: antiState.webglRenderer
  });
  const alignedUa = fileStore.alignUaToInstalledChrome(manifest.uaString, manifest.uaCh);
  const ua = alignedUa.uaString;
  const uaCh = alignedUa.uaCh || {};
  try { if (alignedUa.changed) await persistAlignedUa(nome, alignedUa); } catch {}

  // --- PATCH FULL UA/UA-CH ---
  // Identidade: falhou = throw (o portão retenta 3x). Não segue pelado / Frankenstein.
  if (!ua) throw new Error('patchPage_ua_missing');
  if (page.isClosed && typeof page.isClosed === 'function' && page.isClosed()) {
    throw new Error('patchPage_closed_before_ua');
  }
  await page.setUserAgent(ua);
  if (uaCh && uaCh.brands) {
    const client = await page.target().createCDPSession();
    await client.send('Network.setUserAgentOverride', {
      userAgent: ua,
      userAgentMetadata: uaCh,
    });
  }

  // Viewport/DPR do preset (antes era lido e descartado — tela virava a da MAE).
  const vw = Number(viewport && viewport.width) || 0;
  const vh = Number(viewport && viewport.height) || 0;
  const scaleRaw = Number(dpr);
  const scale = (Number.isFinite(scaleRaw) && scaleRaw >= 1 && scaleRaw <= 3) ? scaleRaw : 1;
  if (vw >= 800 && vh >= 600) {
    await page.setViewport({
      width: Math.floor(vw),
      height: Math.floor(vh),
      deviceScaleFactor: scale
    });
  }

  // --- IDIOMA E REGION ---
  // ATENÇÃO: idioma/timezone agora podem ser configurados via env BROWSER_LANG e BROWSER_TZ
  const patchLang = process.env.BROWSER_LANG || antiState.acceptLanguage || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';
  const patchTz = process.env.BROWSER_TZ || antiState.timezone || 'America/Sao_Paulo';
  await page.setExtraHTTPHeaders({ 'accept-language': patchLang });
  await page.emulateTimezone(patchTz);

  const fingerprintCfg = {
    navigatorLanguage: antiState.navigatorLanguage,
    navigatorLanguages: antiState.navigatorLanguages,
    timezone: patchTz,
    webglVendor: antiState.webglVendor,
    webglRenderer: antiState.webglRenderer,
    canvasNoise: antiState.canvasNoise,
    audioNoise: antiState.audioNoise,
    plugins: antiState.plugins,
    fonts: antiState.fonts,
    deviceMemory: antiState.deviceMemory,
    maxTouchPoints: antiState.maxTouchPoints,
    hardwareConcurrency
  };

  await page.evaluateOnNewDocument(installAccountFingerprintHooks, fingerprintCfg);
  try {
    await page.evaluate(installAccountFingerprintHooks, fingerprintCfg);
  } catch (e) {
    throw e;
  }

  // --- GEOLOCALIZAÇÃO ---
  if (coords && coords.latitude) {
    await page.setGeolocation(coords);
  }

  // --- OCULTAR BANNER AUTOMATION ---
  await page.evaluateOnNewDocument(() => {
    const style = document.createElement('style');
    style.innerHTML = `
      body > div[role="alert"], .automation-message {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
    `;
    document.addEventListener('DOMContentLoaded', () => {
      document.head.appendChild(style);
    });
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
    } catch {}
  });

  // --- INJEÇÃO DO DISMISS AUTOMÁTICO DO OVERLAY "SUSPEITAMOS..." ---
  try {
    // Exponha como function para page
    await page.exposeFunction('__dismissAutomationSuspect', () =>
      dismissAutomationSuspect(page, nome).catch(()=>false)
    );
    // Injeta um scanner após DOMContentLoaded: tenta algumas vezes nas primeiras rodadas
    await page.evaluateOnNewDocument(() => {
      let rodadas = 0;
      function tryDismiss(){
        if (++rodadas > 8) return;
        if (window.__dismissAutomationSuspect) {
          window.__dismissAutomationSuspect().catch(()=>{});
        }
        setTimeout(tryDismiss, 900 + Math.floor(Math.random()*400));
      }
      window.addEventListener('DOMContentLoaded', tryDismiss);
    });
  } catch {} // nunca deixa travar

  // GUARDA: Virtus Messenger asset interception (apenas Messenger, nunca Marketplace Create)
  const url = typeof page.url === "function" ? page.url() : "";
  let interceptionConfigured = false;
  const enableVirtusMessengerBlock =
    (
      typeof url === "string"
      && /^https?:\/\/(www\.)?messenger\.com\/?/.test(url)
    ) || (
      page.target && typeof page.target === 'function' &&
      (
        (page.target()._targetInfo && /messenger\.com/.test(page.target()._targetInfo.url || ""))
        || (typeof page.target().url === 'function' && /messenger\.com/.test(page.target().url() || ""))
      )
    );

  // #region agent log
  try {
    const targetUrlForDebug = (() => {
      try {
        if (page && page.target && typeof page.target === 'function') {
          if (typeof page.target().url === 'function') return String(page.target().url() || '');
          if (page.target()._targetInfo && page.target()._targetInfo.url) return String(page.target()._targetInfo.url || '');
        }
      } catch {}
      return '';
    })();
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_patchpage_interception_decision', nome: String(nome || ''), pageUrl: String(url || ''), targetUrl: String(targetUrlForDebug || ''), enableVirtusMessengerBlock: !!enableVirtusMessengerBlock }); } catch {}
  } catch {}
  // #endregion

  // ==== PATCH APLICADO CONFORME INSTRUÇÃO (PATCH MILITAR) ====
  if (enableVirtusMessengerBlock) {
    try {
      // EVITAR MÚLTIPLOS setRequestInterception/listeners:
      if (!page._virtusIntercepted) {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const u = req.url();
          const type = req.resourceType();
          const allowLoginFlow = (url) => /(?:messenger|facebook)\.com\/(?:(?:login|checkpoint|device|oauth|connect|security)[/?]|.*nonce)/i.test(url);
          const isLoggedArea = () => {
            try { return /messenger\.com\/(?:marketplace|t\/|inbox|compose)/i.test(page.url() || ''); }
            catch { return false; }
          };

          if (allowLoginFlow(u)) return req.continue();
          if (!isLoggedArea()) {
            if (type === 'image' && /facebook\.com/i.test(u)) return req.continue();
            if (/favicon\.ico$/i.test(u) && type === 'image') return req.continue();
            return req.continue();
          }
          if (type === 'media' || type === 'font') {
            // #region agent log
            try {
              page._dbgAbortCount = Number(page._dbgAbortCount || 0);
              if (page._dbgAbortCount < 8) {
                page._dbgAbortCount++;
                try { provisionAudit.append({ ts: Date.now(), event: 'dbg_patchpage_request_abort', nome: String(nome || ''), type: String(type || ''), url: String(u || '').slice(0, 280) }); } catch {}
              }
            } catch {}
            // #endregion
            return req.abort();
          }
          if (type === 'image') {
            if (process.env.VIRTUS_BLOCK_IMAGES === '1') {
              if (/favicon\.ico$/i.test(u)) return req.continue();
              // #region agent log
              try {
                page._dbgAbortCount = Number(page._dbgAbortCount || 0);
                if (page._dbgAbortCount < 8) {
                  page._dbgAbortCount++;
                  try { provisionAudit.append({ ts: Date.now(), event: 'dbg_patchpage_image_abort', nome: String(nome || ''), type: String(type || ''), url: String(u || '').slice(0, 280) }); } catch {}
                }
              } catch {}
              // #endregion
              return req.abort();
            }
            return req.continue();
          }
          return req.continue();
        });
        page._virtusIntercepted = true;
        interceptionConfigured = true;
      }
    } catch (err) {
      // log silencioso
    }
  }
  // ==== FIM DO PATCH ====

  // PATCH: Hook redundante de beforeunload para toda nova page
  try {
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('beforeunload', (e) => { try { e.stopImmediatePropagation(); } catch {} }, true);
    });
  } catch (e) {
    // Hook de beforeunload não é identidade. Não aborta o patch e não devolve objeto de probe.
    try {
      logger.warn('[patchPage] beforeunload hook falhou (seguindo)', {
        nome: String(nome || '').slice(0, 40),
        err: String((e && e.message) || e || '').slice(0, 160)
      });
    } catch {}
  }
}

function resolvePatchCoordsForProfile(profileName, manifest) {
  const nome = String(profileName || '').trim();
  const strictGateway = gatewayProxy.isStrictProxyRequired();
  const geoProxy = gatewayProxy.resolveGeoForProfile({ profileName: nome, manifest });
  if (strictGateway) {
    if (!geoProxy || geoProxy.enabled !== true || !geoProxy.coords) {
      const reason = String(geoProxy && geoProxy.reason || 'geo_proxy_unresolved').trim() || 'geo_proxy_unresolved';
      throw new Error(`gateway_geo_required:${reason}`);
    }
    try {
      logger.info('[GEO_PROXY][strict]', {
        nome,
        slotId: String(geoProxy.slotId || ''),
        source: String(geoProxy.source || 'slot_geo'),
        ipCurrent: String(geoProxy.ipCurrent || '')
      });
    } catch {}
    return geoProxy.coords;
  }
  if (geoProxy && geoProxy.enabled === true && geoProxy.coords) {
    return geoProxy.coords;
  }
  return utils.getCoords((manifest && manifest.cidade) ? manifest.cidade : '');
}

const BLINDAR_TRIES = 3;
const BLINDAR_RETRY_MS = 450;
const NEWPAGE_CONTA_TRIES = 3;

function _isAccountPageClosed(page) {
  try {
    if (!page) return true;
    if (typeof page.isClosed === 'function' && page.isClosed()) return true;
    return false;
  } catch {
    return true;
  }
}

function _browserGateBusy(browser) {
  return Number(browser && browser._convenienteGateInFlight || 0) > 0;
}

function _pageIsBlinding(page) {
  return !!(page && page._convenienteBlinding === true);
}

async function _safeCloseAccountPage(page) {
  try {
    if (!_isAccountPageClosed(page) && typeof page.close === 'function') {
      await page.close({ runBeforeUnload: false }).catch(() => {});
    }
  } catch {}
}

function _auditBlindar(event, extra) {
  try {
    provisionAudit.append(Object.assign({ ts: Date.now(), event: String(event || '') }, extra || {}));
  } catch {}
}

async function applyProxyAuthIfEnabled(page, nome) {
  const manifest = await manifestStore.read(nome).catch(() => null);
  const resolved = gatewayProxy.resolveProxyForProfile({ profileName: nome, manifest: manifest || {} });
  if (gatewayProxy.isStrictProxyRequired() && (!resolved || resolved.enabled !== true)) {
    const reason = String((resolved && resolved.reason) || 'proxy_unresolved').trim() || 'proxy_unresolved';
    throw new Error(`gateway_proxy_required:${reason}`);
  }
  if (!(resolved && resolved.enabled === true && resolved.auth && typeof page.authenticate === 'function')) {
    return { enabled: false };
  }
  await page.authenticate({
    username: String(resolved.auth.username || ''),
    password: String(resolved.auth.password || '')
  });
  return { enabled: true };
}

async function _blindarOnce(page, nome) {
  if (_isAccountPageClosed(page)) throw new Error('blindar_page_closed');
  const manifest = await manifestStore.read(nome).catch(() => null);
  const coords = resolvePatchCoordsForProfile(nome, manifest || {});
  await patchPage(nome, page, coords);
  await applyProxyAuthIfEnabled(page, nome);
  page._convenientePatched = true;
  page._convenientePatchedNome = String(nome);
  page._convenientePatchedAt = Date.now();
  try { await glassViewer.applyGlassViewer(page, { source: 'blindar' }); } catch {}
}

async function blindarPaginaDaConta(page, nome, opts = {}) {
  const who = String(nome || '').trim();
  if (!who) throw new Error('blindar_nome_ausente');
  if (_isAccountPageClosed(page)) throw new Error('blindar_page_closed');

  if (page._convenientePatched === true && page._convenientePatchedNome === who) {
    return page;
  }

  if (page._convenienteBlindarPromise) {
    await page._convenienteBlindarPromise;
    if (page._convenientePatched === true && page._convenientePatchedNome === who) return page;
    if (_isAccountPageClosed(page)) throw new Error('blindar_page_closed');
  }

  const source = String((opts && opts.source) || 'blindar').slice(0, 80);
  const tries = Math.max(1, Math.min(5, Number((opts && opts.tries) || BLINDAR_TRIES) || BLINDAR_TRIES));

  const inflight = (async () => {
    const errors = [];
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (_isAccountPageClosed(page)) throw new Error('blindar_page_closed');
      try {
        await _blindarOnce(page, who);
        if (attempt > 1) {
          try { logger.info('[BLINDAR] ok apos retry', { nome: who, attempt, source }); } catch {}
        }
        _auditBlindar('account_page_blinded', { nome: who, attempt, source });
        return page;
      } catch (e) {
        const msg = String((e && e.message) || e || '').slice(0, 220);
        errors.push(`t${attempt}:${msg}`);
        try { logger.warn('[BLINDAR] falhou, retenta', { nome: who, attempt, tries, source, err: msg }); } catch {}
        _auditBlindar('account_page_blind_retry', { nome: who, attempt, tries, source, error: msg });
        if (attempt < tries) await new Promise((r) => setTimeout(r, BLINDAR_RETRY_MS * attempt));
      }
    }
    const joined = errors.join(' | ');
    _auditBlindar('account_page_blind_failed', { nome: who, tries, source, error: joined.slice(0, 400) });
    throw new Error(`blindar_failed:${who}:${joined}`.slice(0, 500));
  })();

  page._convenienteBlinding = true;
  page._convenienteBlindarPromise = inflight;
  try {
    return await inflight;
  } catch (e) {
    throw e;
  } finally {
    page._convenienteBlinding = false;
    try {
      if (page._convenienteBlindarPromise === inflight) page._convenienteBlindarPromise = null;
    } catch {}
  }
}

async function newPageDaConta(browser, nome, opts = {}) {
  const who = String(nome || '').trim();
  if (!browser) throw new Error('newPageDaConta_no_browser');
  if (!who) throw new Error('newPageDaConta_nome_ausente');
  const source = String((opts && opts.source) || 'newPageDaConta').slice(0, 80);
  const tries = Math.max(1, Math.min(5, Number((opts && opts.tries) || NEWPAGE_CONTA_TRIES) || NEWPAGE_CONTA_TRIES));
  const errors = [];

  try { browser._convenienteNome = who; } catch {}
  try {
    const man = await manifestStore.read(who).catch(() => null);
    if (man) await syncStealthFromManifest(who, man);
  } catch {}
  // A aba nasce about:blank. O killer (7s) mata blank se não houver suppress.
  // Cola+UA-CH pode passar de 7s; sem isto o killer fecha a aba no meio do portão.
  try {
    const until = Date.now() + 25000;
    browser._suppressBlankKillUntil = browser._suppressBlankKillUntil || {};
    browser._suppressBlankKillUntil[who] = Math.max(Number(browser._suppressBlankKillUntil[who] || 0) || 0, until);
  } catch {}
  browser._convenienteGateInFlight = (Number(browser._convenienteGateInFlight || 0) || 0) + 1;
  try {
    for (let attempt = 1; attempt <= tries; attempt++) {
      let page = null;
      try {
        page = await browser.newPage();
        await blindarPaginaDaConta(page, who, { source: `${source}:a${attempt}`, tries: 1 });
        return page;
      } catch (e) {
        const msg = String((e && e.message) || e || '').slice(0, 220);
        errors.push(`t${attempt}:${msg}`);
        try { logger.warn('[NEWPAGE_CONTA] falhou, fecha aba e retenta', { nome: who, attempt, tries, source, err: msg }); } catch {}
        _auditBlindar('account_newpage_retry', { nome: who, attempt, tries, source, error: msg });
        await _safeCloseAccountPage(page);
        if (attempt < tries) await new Promise((r) => setTimeout(r, BLINDAR_RETRY_MS * attempt));
      }
    }
    const joined = errors.join(' | ');
    _auditBlindar('account_newpage_failed', { nome: who, tries, source, error: joined.slice(0, 400) });
    throw new Error(`newPageDaConta_failed:${who}:${joined}`.slice(0, 500));
  } finally {
    browser._convenienteGateInFlight = Math.max(0, (Number(browser._convenienteGateInFlight || 1) || 1) - 1);
  }
}

function _installForceCloseExtras(browser) {
  browser.forceCloseExtras = async () => {
    try {
      const hygiene = require('./robeTabHygiene.js');
      if (hygiene && typeof hygiene.closeRedundantVirtusTabs === 'function') {
        await hygiene.closeRedundantVirtusTabs(browser, { reason: 'force_close_extras' });
        return;
      }
    } catch {}
    try {
      const pages = await browser.pages();
      if (pages && pages.length > 1) {
        const robeOn = !!(browser && browser._robeActiveFor);
        for (const p of pages.slice(1)) {
          if (_pageIsBlinding(p)) continue;
          let u = '';
          try { u = await p.url(); } catch {}
          if (robeOn && /facebook.com\/marketplace\/create\/(item|vehicle)/i.test(u)) continue;
          if (typeof p.close === 'function') await p.close({ runBeforeUnload: false }).catch(()=>{});
        }
      }
    } catch {}
  };
  browser.forceCloseExtrasHard = async () => {
    try {
      const pages = await browser.pages();
      if (pages && pages.length > 1) {
        for (const p of pages.slice(1)) {
          if (_pageIsBlinding(p)) continue;
          if (typeof p.close === 'function') await p.close({ runBeforeUnload: false }).catch(()=>{});
        }
      }
    } catch {}
  };
}

/**
 * Cola identidade + portão neste objeto Browser (launch OU reconnect CDP).
 * Sem isto, puppeteer.connect nasce sem targetcreated/UA-CH/timezone.
 */
async function bindAccountIdentity(browser, nome, opts = {}) {
  const who = String(nome || '').trim();
  if (!browser) throw new Error('bindAccountIdentity_no_browser');
  if (!who) throw new Error('bindAccountIdentity_nome_ausente');
  const source = String((opts && opts.source) || 'bind').slice(0, 80);

  try { browser._convenienteNome = who; } catch {}
  try {
    const until = Date.now() + 25000;
    browser._suppressBlankKillUntil = browser._suppressBlankKillUntil || {};
    browser._suppressBlankKillUntil[who] = Math.max(Number(browser._suppressBlankKillUntil[who] || 0) || 0, until);
  } catch {}

  try {
    const conn = browser && browser._connection;
    if (conn && typeof conn.setProtocolTimeout === 'function') {
      conn.setProtocolTimeout(60000);
    }
  } catch {}

  const manifest = await manifestStore.read(who).catch(() => null);
  try { await syncStealthFromManifest(who, manifest || {}); } catch {}
  const gatewayResolved = gatewayProxy.resolveProxyForProfile({
    profileName: who,
    manifest: manifest || {}
  });

  const setDefaults = async (p) => {
    try {
      if (gatewayResolved && gatewayResolved.enabled && gatewayResolved.auth) {
        try {
          await p.authenticate({
            username: String(gatewayResolved.auth.username || ''),
            password: String(gatewayResolved.auth.password || '')
          });
        } catch (e) {
          try {
            await gatewayProxy.reportProxyIssue({
              resolved: gatewayResolved,
              reason: 'page_auth_proxy_failed',
              context: { stage: 'authenticate', error: String((e && e.message) || e || '').slice(0, 220) }
            });
          } catch {}
        }
      }
      p.setDefaultTimeout(30000);
      p.setDefaultNavigationTimeout(45000);
      p.on('dialog', async (dlg) => {
        try {
          const t = dlg.type && dlg.type();
          const m = (dlg.message && dlg.message()) || '';
          if (t === 'beforeunload' || /sair|deixar|leave this page|continuar|recarregar|atualizar/i.test(m)) {
            await dlg.accept().catch(()=>{});
          } else {
            await dlg.dismiss().catch(()=>{});
          }
        } catch {}
      });
    } catch {}
  };

  const already = !!browser._convenienteIdentityBound;
  if (!already) {
    browser._convenienteIdentityBound = true;
    const pagesNow = await browser.pages().catch(() => []);
    for (const p of (pagesNow || [])) await setDefaults(p);
    browser.on('targetcreated', async (t) => {
      try {
        let isPage = true;
        try { if (t && t.type && t.type() !== 'page') isPage = false; } catch {}
        const p = await t.page().catch(()=>null);
        if (p) await setDefaults(p);
        if (!isPage || !p) return;
        const accountNome = String(browser._convenienteNome || who).trim();
        if (!accountNome) return;
        const gateBusy = _browserGateBusy(browser);
        try {
          await blindarPaginaDaConta(p, accountNome, {
            source: gateBusy ? 'targetcreated_gate' : 'targetcreated_popup',
            tries: gateBusy ? 1 : BLINDAR_TRIES
          });
        } catch (e) {
          if (!gateBusy && !_isAccountPageClosed(p)) {
            let opener = null;
            try { opener = await p.opener(); } catch {}
            let u = '';
            try { u = String((typeof p.url === 'function' && p.url()) || ''); } catch {}
            const junk = !u || u === 'about:blank' || /chrome-error:|chromewebdata|chrome:\/\/crash/i.test(u);
            const isPopup = !!opener;
            if (isPopup || junk) {
              try {
                logger.warn('[BLINDAR] popup/lixo sem cara, fechando', {
                  nome: accountNome,
                  junk: !!junk,
                  popup: !!isPopup,
                  url: u.slice(0, 160),
                  err: String((e && e.message) || e || '').slice(0, 180)
                });
              } catch {}
              await _safeCloseAccountPage(p);
            } else {
              try {
                logger.warn('[BLINDAR] type=page sem cara, nao fecho (pode ser iframe da Meta)', {
                  nome: accountNome,
                  url: u.slice(0, 160),
                  err: String((e && e.message) || e || '').slice(0, 180)
                });
              } catch {}
            }
          }
        }
        try {
          if (typeof browser._convenienteEnforceHardCap === 'function') {
            await browser._convenienteEnforceHardCap();
          }
        } catch {}
      } catch {}
    });
    _installForceCloseExtras(browser);
  }

  try {
    const context = browser.defaultBrowserContext();
    const MEDIA_ORIGINS = [
      'https://facebook.com',
      'https://www.facebook.com',
      'https://m.facebook.com',
      'https://web.facebook.com',
      'https://mbasic.facebook.com',
      'https://business.facebook.com',
      'https://messenger.com',
      'https://www.messenger.com',
      'https://lookaside.facebook.com',
      'https://staticxx.facebook.com'
    ];
    for (const o of MEDIA_ORIGINS) {
      await context.overridePermissions(o, ['geolocation', 'camera', 'microphone']);
    }
    function originOf(u) {
      try {
        const url = new URL(u);
        return `${url.protocol}//${url.host}`;
      } catch { return null; }
    }
    function isFbHost(host) {
      return !!host && (
        host.endsWith('.facebook.com') || host === 'facebook.com' ||
        host.endsWith('.messenger.com') || host === 'messenger.com'
      );
    }
    async function grantForUrl(u) {
      const ori = originOf(u);
      if (!ori) return;
      try {
        const h = (new URL(u)).host;
        if (isFbHost(h)) {
          await context.overridePermissions(ori, ['geolocation', 'camera', 'microphone']);
        }
      } catch {}
    }
    if (!browser._mediaPermListenerInstalled) {
      browser._mediaPermListenerInstalled = true;
      browser.on('targetcreated', async t => { try { await grantForUrl(t.url && t.url()); } catch {} });
      browser.on('targetchanged', async t => { try { await grantForUrl(t.url && t.url()); } catch {} });
    }
    if (process.env.BROWSER_DEBUG === '1') {
      logger.debug('>> [BROWSER][STEP] Permissões de mídia concedidas para Facebook/Messenger.');
    }
  } catch (e) {
    logger.warn('[BROWSER][Permissões mídia] Falha ao conceder mídia: ' + ((e && e.message) || e));
  }

  const all = await browser.pages().catch(() => []);
  const page0 = all && all[0];
  if (!page0) throw new Error('bindAccountIdentity_no_page0');

  const hygiene = (() => { try { return require('./robeTabHygiene.js'); } catch { return null; } })();
  let keep = page0;
  try {
    if (hygiene && typeof hygiene.pickVirtusKeepPageAsync === 'function') {
      keep = (await hygiene.pickVirtusKeepPageAsync(all, page0)) || page0;
    } else if (hygiene && typeof hygiene.pickVirtusKeepPage === 'function') {
      keep = hygiene.pickVirtusKeepPage(all, page0) || page0;
    }
  } catch {
    keep = page0;
  }

  browser._convenienteGateInFlight = (Number(browser._convenienteGateInFlight || 0) || 0) + 1;
  try {
    await blindarPaginaDaConta(keep, who, { source: `${source}_virtus` });
    // Portão aqui é cola da aba Virtus, não create do Robe. Extra restaurada/blank fecha agora.
    const nowPages = await browser.pages().catch(() => []);
    for (const extra of (nowPages || [])) {
      if (!extra || extra === keep) continue;
      let u = '';
      try { u = (typeof extra.url === 'function') ? String(extra.url() || '') : ''; } catch {}
      if (hygiene && typeof hygiene.isCreateMarketplaceUrl === 'function' && hygiene.isCreateMarketplaceUrl(u)) continue;
      await _safeCloseAccountPage(extra);
    }
  } finally {
    browser._convenienteGateInFlight = Math.max(0, (Number(browser._convenienteGateInFlight || 1) || 1) - 1);
  }
  return browser;
}

// Minimização suave
async function ensureMinimizedWindowForPage(page) {
  // GUARDA: A função minimize é inerte para steady-state (só uso manual/debug)
  return;
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function hasFocus(page) {
  try {
    return await page.evaluate(() => {
      try { return !!(document && document.hasFocus && document.hasFocus()); }
      catch { return false; }
    });
  } catch { return false; }
}

/**
 * Limpa locks/arquivos residuais de perfil que impedem o launch em Windows.
 */
function cleanupUserDataLocks(userDataDir) {
  try {
    if (!userDataDir || !fs.existsSync(userDataDir)) return;
    const candidates = [
      'SingletonLock',
      'SingletonCookie',
      'SingletonSocket',
      'SingletonSharedMemory',
      'Lock',
      'LOCK',
      'lockfile'
    ];
    for (const name of candidates) {
      const p = path.join(userDataDir, name);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
    try {
      const entries = fs.readdirSync(userDataDir);
      for (const ent of entries) {
        if (/^Singleton/i.test(ent)) {
          const p2 = path.join(userDataDir, ent);
          try { fs.unlinkSync(p2); } catch {}
        }
      }
    } catch {}
  } catch {}
}

function normalizePathForCompare(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function extractUserDataDirFromCmd(cmd) {
  try {
    const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(String(cmd || ''));
    return m ? (m[1] || m[2] || m[3] || null) : null;
  } catch {
    return null;
  }
}

function listChromeProcessesWin() {
  try {
    // Nota: usar -Filter (WMI-side) é MUITO mais rápido/estável que pipe+Where em hosts carregados.
    // Também adiciona timeout para não travar o worker em cenário de WMI lento.
    const ps = `
      $names = @('chrome.exe','chromium.exe');
      $all = @();
      foreach ($n in $names) {
        try {
          $all += (Get-CimInstance Win32_Process -Filter ("Name='" + $n + "'") | Select-Object ProcessId, Name, CommandLine);
        } catch {}
      }
      $all | ConvertTo-Json -Compress
    `;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 8000 }
    ).trim();
    if (!out) return [];
    const json = JSON.parse(out);
    const arr = Array.isArray(json) ? json : (json ? [json] : []);
    return arr.map(p => ({
      pid: Number(p.ProcessId),
      name: String(p.Name || ''),
      cmd: String(p.CommandLine || '')
    })).filter(p => Number.isFinite(p.pid) && p.pid > 0);
  } catch {
    return [];
  }
}

function taskkillTreeWin(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function taskkillTreeWinGraceful(pid) {
  // Sem /F: tenta fechar "normalmente" (WM_CLOSE). Pode falhar silenciosamente — caller decide se forçará.
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function _listProfilePidsWinOrThrow(userDataDir) {
  const expected = String(userDataDir || '').trim();
  if (!expected) return [];
  // Retorna só PIDs (compacto) para evitar JSON gigantes e reduzir chance de falha.
  const ps = `
    $expected = $args[0];
    if (-not $expected) { "[]" ; exit 0 }
    $esc = [Regex]::Escape($expected);
    $names = @('chrome.exe','chromium.exe');
    $pids = @();
    foreach ($n in $names) {
      try {
        $procs = Get-CimInstance Win32_Process -Filter ("Name='" + $n + "'") |
          Where-Object { $_.CommandLine -and ($_.CommandLine -match $esc) } |
          Select-Object -ExpandProperty ProcessId;
        if ($procs) { $pids += $procs; }
      } catch {}
    }
    ($pids | Sort-Object -Unique) | ConvertTo-Json -Compress
  `;
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps, expected],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024, timeout: 8000 }
  ).trim();
  if (!out) return [];
  const json = JSON.parse(out);
  const arr = Array.isArray(json) ? json : (json ? [json] : []);
  return arr.map(x => Number(x)).filter(n => Number.isFinite(n) && n > 0);
}

function listProfilePidsWin(userDataDir) {
  // Mantém API legada (nunca lança): em falha retorna [].
  try {
    return _listProfilePidsWinOrThrow(userDataDir);
  } catch {
    return [];
  }
}

function listProfilePidsWinMeta(userDataDir) {
  // Enterprise: preservar sinal de falha real.
  // Bug antigo: listProfilePidsWin engolia exceções e retornava [], mascarando WMI/Powershell quebrado,
  // o que podia levar a delete de userDataDir com Chrome ainda vivo ("janela quebrada").
  try {
    const pids = _listProfilePidsWinOrThrow(userDataDir);
    return { ok: true, pids: Array.isArray(pids) ? pids : [] };
  } catch (e) {
    return { ok: false, pids: [], error: (e && e.message) ? String(e.message).slice(0, 180) : 'wmi_failed' };
  }
}

/**
 * Mata processos do Chrome usando ESTE userDataDir (Windows).
 * Implementação real usando PowerShell + taskkill.
 */
function killChromeProfileProcesses(userDataDir, openingMap) {
  if (process.platform !== 'win32') return;
  try {
    const expectedRaw = String(userDataDir || '').trim();
    const expected = normalizePathForCompare(expectedRaw).replace(/\/+$/g, '');
    if (!expected) return;
    const toKill = new Set();

    // PASSO A: tentativa rápida (lista cmdline completa)
    try {
      const procs = listChromeProcessesWin();
      for (const pr of procs) {
        const ud = extractUserDataDirFromCmd(pr.cmd);
        if (ud) {
          if (normalizePathForCompare(ud).replace(/\/+$/g, '') === expected) {
            toKill.add(pr.pid);
          }
        } else {
          // fallback: se não achou o param, mas cmd contém o path inteiro
          if (pr.cmd && normalizePathForCompare(pr.cmd).includes(expected)) {
            toKill.add(pr.pid);
          }
        }
      }
    } catch {}

    // PASSO B: fallback robusto (WMI filtra por substring e retorna só PIDs)
    if (!toKill.size) {
      try {
        const pids = listProfilePidsWin(expectedRaw);
        for (const pid of pids) toKill.add(pid);
      } catch {}
    }

    // PASSO B2 (ultra enterprise): fallback curto por slug
    // Motivo: em alguns hosts, o CommandLine pode ser truncado/instável; a substring "\\Conveniente\\<slug>"
    // é curta e costuma sobreviver. Isso evita falso-negativo que leva a "janela quebrada" após delete.
    if (!toKill.size) {
      try {
        const slug = (() => {
          try {
            const s = String(expectedRaw || '').trim().replace(/[\\\/]+$/g, '');
            return s ? path.basename(s) : '';
          } catch { return ''; }
        })();
        if (slug) {
          const hint = `\\Conveniente\\${slug}`;
          const pids2 = listProfilePidsWin(hint);
          for (const pid of pids2) toKill.add(pid);
        }
      } catch {}
    }

    if (!toKill.size) return;

    let killed = 0;
    for (const pid of toKill) {
      if (taskkillTreeWin(pid)) killed++;
    }

    // PASSO C: validação + retry (caso ainda exista processo vivo com o userDataDir)
    try {
      const still = listProfilePidsWin(expectedRaw);
      if (still && still.length) {
        for (const pid of still) {
          if (taskkillTreeWin(pid)) killed++;
        }
      }
    } catch {}

    try {
      if (killed > 0) {
        logger.warn('[BROWSER][KILL][userDataDir] Chrome órfão removido', { userDataDir, killed });
      }
    } catch {}
  } catch {}
}

function closeChromeProfileProcessesGraceful(userDataDir) {
  // Fecha (sem /F) processos do Chrome ligados ao userDataDir; não garante fechamento.
  if (process.platform !== 'win32') return { ok: false, skipped: 'non_win32' };
  try {
    const expectedRaw = String(userDataDir || '').trim();
    if (!expectedRaw) return { ok: false, skipped: 'no_userDataDir' };
    const pids = listProfilePidsWin(expectedRaw);
    if (!pids || !pids.length) return { ok: true, closed: 0, pids: [] };
    let closed = 0;
    for (const pid of pids) {
      if (taskkillTreeWinGraceful(pid)) closed++;
    }
    try { if (closed > 0) logger.warn('[BROWSER][CLOSE][userDataDir] tentativa de fechar Chrome (sem /F)', { userDataDir: expectedRaw, closed, pids: pids.slice(0, 12) }); } catch {}
    return { ok: true, closed, pids };
  } catch {
    return { ok: false, error: 'close_failed' };
  }
}

function getChromeProfilePids(userDataDir) {
  // Retorna lista de PIDs do Chrome/Chromium cujo CommandLine contém o userDataDir.
  // Uso: validação "antes de deletar" (anti-janela zumbi).
  if (process.platform !== 'win32') return [];
  try {
    const raw = String(userDataDir || '').trim();
    const p0 = listProfilePidsWin(raw);
    if (p0 && p0.length) return p0;
    // Fallback curto por slug (mesma lógica do kill): \\Conveniente\\<slug>
    try {
      const s = raw.replace(/[\\\/]+$/g, '');
      const slug = s ? path.basename(s) : '';
      if (slug) return listProfilePidsWin(`\\Conveniente\\${slug}`) || [];
    } catch {}
    return [];
  } catch {
    return [];
  }
}

function getChromeProfilePidsMeta(userDataDir) {
  // Versão enterprise: não perde sinal de falha (ok=false).
  if (process.platform !== 'win32') return { ok: true, pids: [] };
  try {
    const raw = String(userDataDir || '').trim();
    const r0 = listProfilePidsWinMeta(raw);
    if (r0 && r0.ok && r0.pids && r0.pids.length) return { ok: true, pids: r0.pids };
    // fallback curto por slug (\\Conveniente\\<slug>)
    try {
      const s = raw.replace(/[\\\/]+$/g, '');
      const slug = s ? path.basename(s) : '';
      if (slug) {
        const r1 = listProfilePidsWinMeta(`\\Conveniente\\${slug}`);
        if (r1 && r1.ok) return { ok: true, pids: r1.pids || [] };
        return { ok: false, pids: [], error: (r1 && r1.error) ? r1.error : 'wmi_failed' };
      }
    } catch {}
    // Se não temos slug e a primeira tentativa falhou, isso é "unknown" => ok=false
    if (r0 && r0.ok === false) return { ok: false, pids: [], error: r0.error || 'wmi_failed' };
    return { ok: true, pids: [] };
  } catch (e) {
    return { ok: false, pids: [], error: (e && e.message) ? String(e.message).slice(0, 180) : 'wmi_failed' };
  }
}

/**
 * Imprime as primeiras linhas do log do Chrome (se existir).
 */
function printChromeLog(chromeLogFile, label = 'CHROME LOG') {
  try {
    if (!chromeLogFile || !fs.existsSync(chromeLogFile)) return;
    const txt = fs.readFileSync(chromeLogFile, 'utf8');
    const lines = txt.split(/\r?\n/).filter(Boolean).slice(0, 80).join('\n');
    logger.info(`[BROWSER][${label}] (primeiras linhas) >>>\n${lines}\n<<< [fim do log]`);
  } catch {}
}

/**
 * Enforce: garantir que userDataDir esteja em "User Data\Conveniente\NOME".
 */
function ensureUserDataDirUnderChrome(manifest) {
  try {
    const chromeRoot = (process.platform === 'win32')
      ? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'))
      : path.join(os.homedir(), '.config', 'google-chrome');
    const desiredDir = path.join(chromeRoot, 'Conveniente', manifest.nome);
    if (!manifest.userDataDir || !String(manifest.userDataDir).startsWith(chromeRoot)) {
      manifest.userDataDir = desiredDir;
      try { fs.mkdirSync(desiredDir, { recursive: true }); } catch {}
      // persistir manifest somente no userDataDir
      try {
        const mpath = path.join(desiredDir, 'manifest.json');
        const tmp = mpath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
        try { fs.unlinkSync(mpath); } catch {}
        try { fs.renameSync(tmp, mpath); }
        catch { fs.copyFileSync(tmp, mpath); try { fs.unlinkSync(tmp); } catch {} }
      } catch {}
    } else {
      try { fs.mkdirSync(manifest.userDataDir, { recursive: true }); } catch {}
    }
  } catch {}
}

/* ===== Helpers novos: IO, preferências e janela única ===== */

async function safeCloseBrowser(browser) {
  try {
    if (browser && typeof browser.close === 'function') {
      await browser.close().catch(()=>{});
    }
  } catch {}
}

function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch { return false; }
}

/**
 * Normaliza preferências do perfil para evitar restauração/segunda janela.
 * - Força: profile.exit_type="Normal", profile.exited_cleanly=true
 * - Força: session.restore_on_startup=0 (Nova guia), startup_urls=[]
 * - Em "Local State": exited_cleanly=true
 */
function ensureChromeProfilePreferences(userDataDir, windowBounds) {
  try {
    if (!userDataDir) return;

    // Default/Preferences
    const defaultDir = path.join(userDataDir, 'Default');
    try { fs.mkdirSync(defaultDir, { recursive: true }); } catch {}
    const prefsPath = path.join(defaultDir, 'Preferences');
    const prefs = readJsonSafe(prefsPath, {}) || {};
    prefs.profile = prefs.profile || {};
    prefs.profile.exit_type = 'Normal';
    prefs.profile.exited_cleanly = true;
    prefs.session = prefs.session || {};
    prefs.session.restore_on_startup = 0; // 0: Nova guia
    prefs.session.startup_urls = [];
    if (windowBounds && Number(windowBounds.width) >= 800 && Number(windowBounds.height) >= 600) {
      const left = Math.floor(Number(windowBounds.left) || 0);
      const top = Math.floor(Number(windowBounds.top) || 0);
      const width = Math.floor(Number(windowBounds.width));
      const height = Math.floor(Number(windowBounds.height));
      prefs.browser = prefs.browser || {};
      prefs.browser.window_placement = {
        left,
        top,
        right: left + width,
        bottom: top + height,
        maximized: false
      };
    }
    writeJsonAtomic(prefsPath, prefs);

    // Local State
    const localStatePath = path.join(userDataDir, 'Local State');
    const ls = readJsonSafe(localStatePath, {}) || {};
    ls.exited_cleanly = true;
    writeJsonAtomic(localStatePath, ls);
  } catch (e) {
    try { if (process.env.BROWSER_DEBUG === '1') { logger.warn('[BROWSER][prefs] falha ao normalizar preferências: ' + ((e && e.message) || e)); } } catch {}
  }
}

/**
 * Prefs sozinhas não impedem o Chrome de devolver Last Session (2 abas Messages).
 * Apaga só arquivos de sessão/abas. Cookies, History, Preferences ficam.
 */
function clearChromeSessionRestore(userDataDir) {
  try {
    if (!userDataDir) return;
    const defaultDir = path.join(userDataDir, 'Default');
    const files = ['Current Session', 'Last Session', 'Current Tabs', 'Last Tabs'];
    for (const name of files) {
      try {
        const p = path.join(defaultDir, name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
    const sessionsDir = path.join(defaultDir, 'Sessions');
    try {
      if (!fs.existsSync(sessionsDir)) return;
      const ents = fs.readdirSync(sessionsDir);
      for (const ent of ents) {
        if (/^(Tabs_|Session_)/i.test(String(ent || ''))) {
          try { fs.unlinkSync(path.join(sessionsDir, ent)); } catch {}
        }
      }
    } catch {}
  } catch {}
}

// BEGIN -- PRUNING PATCH: ULTRA CONSCIENTE

/**
 * Garante que apenas UMA janela permaneça aberta.
 * Mantém a mainPage; fecha quaisquer outras pages "page".
 * 
 * Ultra Consciente: NÃO fecha se robeMeta[nome]?.emExecucao ou ctrl?.skipPruneUntil > Date.now()!
 * 
 * Após prune, robeMeta[nome].numPages atualizado, para uso no painel/status.json.
 */
async function pruneExtraWindows(browser, mainPage, { timeoutMs = 5000, intervalMs = 250, robeMeta, nome, ctrl } = {}) {
  try {
    const hygiene = require('./robeTabHygiene.js');
    if (hygiene && typeof hygiene.closeRedundantVirtusTabs === 'function') {
      await hygiene.closeRedundantVirtusTabs(browser, {
        keepPage: mainPage || null,
        nome,
        reason: 'prune_extra_windows'
      });
      return;
    }
  } catch {}
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = Date.now();
  while ((Date.now() - t0) < timeoutMs) {
    try {
      const pages = await browser.pages();
      if (!pages || pages.length <= 1) break;
      const robeOn = !!(browser && browser._robeActiveFor);
      for (const p of pages.slice(1)) {
        let u = ''; try { u = p.url(); } catch {}
        if (robeOn && /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u)) continue;
        await p.close({ runBeforeUnload: false }).catch(()=>{});
      }
      await sleep(intervalMs);
    } catch { break; }
  }
}

/**
 * Militar: em modo humano, manter APENAS 1 aba.
 * Não depende do pruneExtraWindows (que evita mexer em humano por segurança).
 *
 * - Escolhe uma aba para manter (prioridade: facebook.com, depois messenger.com, depois pages[0])
 * - Fecha todas as outras (inclui about:blank)
 * - Atualiza robeMeta[nome].numPages quando possível
 */
async function pruneHumanToOneTab(browser, { nome = '', ctrl = null, robeMeta = null } = {}) {
  if (!browser) return { ok: false, error: 'no_browser' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const pages = await browser.pages().catch(()=>[]);
    if (!Array.isArray(pages) || pages.length <= 1) {
      try {
        if (robeMeta && nome) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].numPages = Array.isArray(pages) ? pages.length : 0;
        }
      } catch {}
      return { ok: true, kept: 1, closed: 0, reason: 'already_one' };
    }
    const safeUrl = (p) => { try { return (p && typeof p.url === 'function') ? String(p.url() || '') : ''; } catch { return ''; } };

    let keep = null;
    for (const p of pages) {
      const u = safeUrl(p);
      if (!u || u === 'about:blank') continue;
      if (/facebook\.com/i.test(u)) { keep = p; break; }
    }
    if (!keep) {
      for (const p of pages) {
        const u = safeUrl(p);
        if (!u || u === 'about:blank') continue;
        if (/messenger\.com/i.test(u)) { keep = p; break; }
      }
    }
    if (!keep) keep = pages[0];

    let closed = 0;
    for (const p of pages) {
      if (p === keep) continue;
      if (_pageIsBlinding(p)) continue;
      try { await p.close({ runBeforeUnload: false }).catch(()=>{}); closed++; } catch {}
      await sleep(60);
    }
    try {
      const pages2 = await browser.pages().catch(()=>[]);
      if (robeMeta && nome) {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = Array.isArray(pages2) ? pages2.length : 0;
      }
    } catch {}
    return { ok: true, kept: 1, closed };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// END -- PRUNING PATCH

// ===== Hard One-Tab Guard (evento alvo criado/destruído) =====
/**
 * Teto do guard. Contrato: Virtus=1. Robe=2 (messages + create).
 * A aba create nasce about:blank; capar em 1 so porque ainda nao tem
 * /marketplace/create fecha a aba 1 no targetcreated (log MAE1 2026-08-26:
 * reason=robe lim=1 + Target.attachToTarget).
 */
function resolveOneTabHardCap({ allow, limOpt, robeOn, hasCreate, gateBusy } = {}) {
  const opt = Number(limOpt);
  const allowed = Math.max(1, Number.isFinite(opt) && opt >= 1 ? opt : 2);
  let lim = allow ? allowed : 1;
  if (robeOn && (hasCreate === true || gateBusy === true)) {
    lim = Math.max(lim, 2);
  } else if (robeOn && hasCreate !== true && gateBusy !== true) {
    lim = 1;
  }
  return Math.max(1, lim);
}

function installOneTabGuard(browser, nome, {
  allow = () => false,              // função externa que diz se “mais de 1 aba” é permitido
  maxPagesWhenAllow = 2,            // máximo permitido quando allow() é true (Robe/config)
  onNumPages = null,                // callback para atualizar robeMeta[nome].numPages
  onPrune = null,                   // callback quando o guard fechou abas (telemetria/auditoria)
  getReason = null,                 // string|fn para explicar por que allow/limOpt foram escolhidos
  log = (m,ctx)=>{ try{require('./logger.js').info(m,ctx);}catch{} }
} = {}) {
  try {
    if (!browser || browser._oneTabGuardInstalled) return;
    browser._oneTabGuardInstalled = true;

    async function reportNum() {
      try {
        const pages = await browser.pages();
        if (onNumPages) onNumPages(Array.isArray(pages) ? pages.length : 0);
      } catch {}
    }
    async function enforceHardCap() {
      try {
        const hygiene = (() => { try { return require('./robeTabHygiene.js'); } catch { return null; } })();
        const pagesWait = await Promise.race([
          browser.pages().catch(() => []),
          new Promise((r) => setTimeout(() => r(null), 4000))
        ]);
        if (!pagesWait) {
          if (hygiene && typeof hygiene.closeRedundantVirtusTabs === 'function') {
            await hygiene.closeRedundantVirtusTabs(browser, { nome, reason: 'one_tab_guard_pages_timeout' });
          }
          return;
        }
        const pages = pagesWait;
        const beforeCount = Array.isArray(pages) ? pages.length : 0;
        let limOpt = (typeof maxPagesWhenAllow === 'function') ? Number(maxPagesWhenAllow()) : Number(maxPagesWhenAllow);
        if (!Number.isFinite(limOpt) || limOpt < 1) limOpt = 1;
        if (!Array.isArray(pages) || pages.length <= 1) return;

        const robeOn = !!(browser && browser._robeActiveFor);
        const gateBusy = _browserGateBusy(browser);
        let hasCreate = false;
        try {
          hasCreate = pages.some((pg) => {
            let u = '';
            try { u = typeof pg.url === 'function' ? String(pg.url() || '') : ''; } catch {}
            return /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u);
          });
        } catch {}
        const lim = resolveOneTabHardCap({
          allow: !!(allow && allow()),
          limOpt,
          robeOn,
          hasCreate,
          gateBusy
        });
        if (pages.length <= lim) return;

        let keepIdx = 0;
        try {
          if (hygiene && typeof hygiene.pickVirtusKeepPage === 'function') {
            const keepPage = hygiene.pickVirtusKeepPage(pages, pages[0]);
            const idx = pages.indexOf(keepPage);
            if (idx >= 0) keepIdx = idx;
          }
        } catch {}

        const closedUrls = [];
        let remaining = pages.length;
        let createKept = false;
        for (let i = pages.length - 1; i >= 0; i--) {
          if (remaining <= lim) break;
          if (i === keepIdx) continue;
          const p = pages[i];
          if (_pageIsBlinding(p)) continue;
          let u = '';
          try { u = typeof p.url === 'function' ? String(p.url() || '') : ''; } catch {}
          if (robeOn && /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u)) {
            if (!createKept) {
              createKept = true;
              continue;
            }
          }
          try { closedUrls.push(String(u || '').slice(0, 180)); } catch {}
          try { await p.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
          remaining--;
        }

        if (closedUrls.length > 0) {
          let reason = '';
          try {
            reason = (typeof getReason === 'function') ? String(getReason() || '') : String(getReason || '');
          } catch { reason = ''; }
          const cur = await browser.pages().catch(() => []);
          const afterCount = (cur && cur.length) || 0;
          log('[PRUNER][HARD] Guard fechou abas extras', { nome, final: afterCount, lim, reason });
          try {
            if (onPrune) {
              Promise.resolve(onPrune({
                nome,
                lim,
                beforeCount,
                afterCount,
                reason: reason || 'tab_cap',
                closedUrls: closedUrls.slice(0, 8)
              })).catch(()=>{});
            }
          } catch {}
        }
      } catch (e) {
        if (process.env.PRUNE_DEBUG === '1') {
          log('[PRUNER][HARD] erro enforce', { nome, error: (e && e.message) || String(e) });
        }
      } finally {
        await reportNum();
      }
    }

    browser._convenienteEnforceHardCap = enforceHardCap;

    browser.on('targetcreated', async (t) => {
      try {
        if (t && t.type && t.type() !== 'page') return;
      } catch {}
      await enforceHardCap();
    });

    browser.on('targetdestroyed', async (t) => {
      try {
        if (t && t.type && t.type() !== 'page') return;
      } catch {}
      await reportNum();
    });

    // Varredura inicial + atraso: restore de sessão cola 3-4 abas no portão.
    setTimeout(enforceHardCap, 400);
    setTimeout(enforceHardCap, 2500);
    setTimeout(enforceHardCap, 8000);

  } catch {}
}

// ====== FIND CHROME STABLE ======
// Tenta Chrome Stable por CHROME_PATH/CHROMIUM_PATH variáveis de ambiente, depois paths padrão de OS.
function findChromeStable() {
  const found = fileStore.findChromeStablePath();
  if (found) return found;
  throw new Error('Chrome/Chromium não encontrado. Instale o Chrome Stable ou defina CHROME_PATH/CHROMIUM_PATH.');
}

//
// For PRUNER attach
//

/**
 * Ativar perfil: abre browser dedicado.
 */
async function openBrowser(manifest, { robeMeta=undefined, nome=manifest.nome, ctrl=undefined, openingMap=undefined } = {}) {
  let browser = null;
  let pruneTimer = null;
  try {
    const coords = resolvePatchCoordsForProfile(manifest && manifest.nome ? manifest.nome : nome, manifest);
    const gatewayResolved = gatewayProxy.resolveProxyForProfile({
      profileName: manifest && manifest.nome ? manifest.nome : nome,
      manifest
    });
    const strictGateway = gatewayProxy.isStrictProxyRequired();
    if (strictGateway && (!gatewayResolved || gatewayResolved.enabled !== true)) {
      const reason = String(gatewayResolved && gatewayResolved.reason || "proxy_unresolved").trim() || "proxy_unresolved";
      throw new Error(`gateway_proxy_required:${reason}`);
    }
    try {
      if (gatewayResolved && gatewayResolved.enabled) {
        await gatewayProxy.persistManifestAssignment(manifest && manifest.nome ? manifest.nome : nome, gatewayResolved);
      }
    } catch {}

    // GUARDA: RAM, userDataDir correto
    ensureUserDataDirUnderChrome(manifest);
    const userDataDir = manifest.userDataDir;
    const accountNome = String((manifest && manifest.nome) || nome || '').trim();
    let launchAntiState = null;
    try { launchAntiState = await syncStealthFromManifest(accountNome, manifest); } catch {}
    const windowBounds = resolveAccountWindowBounds(manifest);

    try { fs.accessSync(userDataDir, fs.constants.W_OK); } catch (e) {
      logger.error('[BROWSER][DEBUG] ERRO NO userDataDir:', { userDataDir }, e);
      throw new Error('UserDataDir sem permissão de escrita: ' + userDataDir);
    }

    // RAM: Encerra processos do perfil e limpa locks ANTES das prefs/sessão
    // (Chrome morrendo depois das prefs reescrevia Last Session com 2 abas).
    try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
    try { cleanupUserDataLocks(userDataDir); } catch {}
    try { clearChromeSessionRestore(userDataDir); } catch {}
    ensureChromeProfilePreferences(userDataDir, windowBounds);

    if (process.env.BROWSER_DEBUG === '1') {
      logger.debug('[BROWSER][DEBUG] userDataDir: ' + userDataDir);
    }

    const chromeLogFile = path.join(userDataDir, 'chrome_launch.log');
    try { if (fs.existsSync(chromeLogFile)) fs.unlinkSync(chromeLogFile); } catch {}

    // FLAGS “OURO” ONLY!
    const launchLang = String((launchAntiState && launchAntiState.navigatorLanguage) || 'pt-BR');
    const launchArgs = [
      '--no-first-run', // Não exibe onboarding
      '--no-default-browser-check', // Não pergunta padrão
      '--password-store=basic', // Evita prompts/chaves desktop
      '--disable-extensions', // Zero extensão custom
      `--lang=${launchLang}`,
      '--disable-background-timer-throttling', // Não pausa timers de fundo
      '--disable-backgrounding-occluded-windows', // Prev. throttling CPU tabs background
      '--disable-renderer-backgrounding', // Garantir render foreground
      '--process-per-site', // Cada site processo
      '--disable-features=TranslateUI,ProfilePicker,OptimizationHints,HardwareMediaKeyHandling,MediaRouter,AutomationControlled,CalculateNativeWinOcclusion', // DEFS: disable detection, hints, popups, media router, win occlusion
      '--disk-cache-size=104857600', // 100MB de cap em disco
      '--media-cache-size=0', // Zero cache de mídia
      `--window-size=${windowBounds.width},${windowBounds.height}`,
      `--window-position=${windowBounds.left},${windowBounds.top}`
      // Sem --start-maximized: a janela física tem que ser o preset, não o monitor da MAE.
    ];

    // Permite ativar auto-aceite da permissão de camera/mic real por flag do Chrome, via env
    if (process.env.MEDIA_AUTO_UI === '1') {
      launchArgs.push('--use-fake-ui-for-media-stream');
    }

    if (gatewayResolved && gatewayResolved.enabled && gatewayResolved.proxyServer) {
      launchArgs.push(`--proxy-server=${gatewayResolved.proxyServer}`);
      // Só com proxy: sem túnel, HTTP e WebRTC já saem no mesmo IP do modem.
      launchArgs.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
      try { require('./connectLane.js').markArmed(true, 'proxy_launch'); } catch {}
    }

    // ENV para adicionar argumentos de debug
    const extraArgsEnv = (process.env.CHROME_EXTRA_ARGS || '').trim();
    if (extraArgsEnv) {
      const tokens = extraArgsEnv.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const cleaned = tokens.map(t => t.replace(/^"(.*)"$/, '$1')).filter(Boolean);
      if (cleaned.length) {
        if (process.env.BROWSER_DEBUG === '1') {
          logger.debug('[BROWSER][DEBUG] CHROME_EXTRA_ARGS: ' + JSON.stringify(cleaned));
        }
        launchArgs.push(...cleaned);
      }
    }

    // HEADFUL por política operacional canônica.
    // Headless só pode ser habilitado em exceção explícita.
    const headlessRequested = process.env.OVERRIDE_HEADLESS === '1' || process.env.HEADLESS === '1';
    const headlessAllowed = String(process.env.CONVENIENTE_ALLOW_HEADLESS || '').trim() === '1';
    if (headlessRequested && !headlessAllowed) {
      try {
        logger.warn('[BROWSER][POLICY] HEADLESS solicitado, mas bloqueado por política operacional (defina CONVENIENTE_ALLOW_HEADLESS=1 para exceção).');
      } catch {}
    }
    const isHeadless = headlessRequested && headlessAllowed;

    // DEFAULT VIEWPORT: null SEMPRE
    const defaultViewport = null;

    // GUARDA: Chrome Stable only
    const executablePath = findChromeStable();

    async function tryLaunch(args, tag) {
      try {
        if (process.env.BROWSER_DEBUG === '1') {
          logger.debug(`>> [BROWSER][STEP] Puppeteer about to launch (${tag}).`);
        }
        const b = await puppeteer.launch({
          headless: isHeadless ? true : false,
          executablePath,
          userDataDir,
          args: launchArgs,
          defaultViewport,
          dumpio: !!process.env.BROWSER_DEBUG,
          protocolTimeout: 120000 // 120 segundos garante o Stealth/plugin
        });
        if (process.env.BROWSER_DEBUG === '1') {
          const spawnargs = b.process && b.process ? b.process().spawnargs : null;
          logger.debug('[BROWSER][DEBUG] spawnargs: ' + JSON.stringify(spawnargs));
        }
        return b;
      } catch (e) {
        try {
          const em = String((e && e.message) || e || '').toLowerCase();
          const proxyRelated =
            em.includes('proxy') ||
            em.includes('tunnel') ||
            em.includes('407') ||
            em.includes('403') ||
            em.includes('net::err') ||
            em.includes('timed out');
          if (proxyRelated && gatewayResolved && gatewayResolved.enabled) {
            await gatewayProxy.reportProxyIssue({
              resolved: gatewayResolved,
              reason: 'launch_failed_proxy',
              context: { stage: 'launch', error: String((e && e.message) || e || '').slice(0, 220), tag: String(tag || '').slice(0, 60) }
            });
          }
        } catch {}
        if (process.env.BROWSER_DEBUG === '1') {
          logger.error(`[BROWSER][CRASH][${tag}]`, {}, e);
          printChromeLog(chromeLogFile, tag);
        } else {
          logger.error(`[BROWSER][CRASH][${tag}]`, {}, e);
        }
        return null;
      }
    }

    let browserTry = await tryLaunch(launchArgs, 'LAUNCH 1');

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      try { clearChromeSessionRestore(userDataDir); } catch {}
      browserTry = await tryLaunch(launchArgs, 'LAUNCH 2');
    }

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      try { clearChromeSessionRestore(userDataDir); } catch {}
      browserTry = await tryLaunch(launchArgs, 'LAUNCH 3');
    }

    if (!browserTry) {
      throw new Error('Browser não iniciou após 3 tentativas. Veja logs acima e o arquivo chrome_launch.log do perfil.');
    }
    browser = browserTry;
    try { browser._convenienteNome = String((manifest && manifest.nome) || nome || '').trim(); } catch {}

    // 1. PATCH: Set protocol timeout GLOBAL para 60s
    try {
      const conn = browser && browser._connection;
      if (conn && typeof conn.setProtocolTimeout === 'function') {
        conn.setProtocolTimeout(60000); // 60s para operações CDP
      }
    } catch {}

    // 1) Garantir pages()
    let pages;
    try {
      if (process.env.BROWSER_DEBUG === '1') logger.debug('>> [BROWSER][STEP] browser.pages() about to call');
      pages = await browser.pages();
      if (process.env.BROWSER_DEBUG === '1') logger.debug('>> [BROWSER][STEP] browser.pages() returned: ' + (pages && pages.length));
    } catch (e) {
      await safeCloseBrowser(browser);
      throw e;
    }

    // 1.1) Inicialmente NÃO execute prune nem arme timer de prune durante abertura/configuração.
    // Só rode pruning/timer após entrar realmente em modo de produção (Virtus ON/start_work).
    // Permaneça inativo aqui.

    // 2) Janela = preset (não maximizar no monitor da MAE)
    try {
      const first = (await browser.pages())[0];
      const client = await first.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          windowState: 'normal',
          left: windowBounds.left,
          top: windowBounds.top,
          width: windowBounds.width,
          height: windowBounds.height
        }
      });
      if (process.env.BROWSER_DEBUG === '1') logger.debug('>> [BROWSER][STEP] Janela no preset [OK]');
    } catch (e) {
      logger.warn('[BROWSER] Falha ao aplicar window bounds do preset (seguindo): ' + ((e && e.message) || e));
    }

    // 2–5) Portão único: defaults, popup, permissões, cola aba 0/extras, forceClose.
    const LAUNCH_MAX_WAIT = 7000;
    const LAUNCH_POLL = 200;
    let ready = false;
    let start = Date.now();
    while (!ready && (Date.now() - start) < LAUNCH_MAX_WAIT) {
      try {
        const ps = await browser.pages();
        if (ps && ps.length >= 1) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, LAUNCH_POLL));
    }
    if (!ready) {
      await safeCloseBrowser(browser);
      throw new Error('Browser não inicializou/target não disponível em tempo aceitável!');
    }

    try {
      await bindAccountIdentity(browser, String((manifest && manifest.nome) || nome || '').trim(), {
        source: 'openBrowser'
      });
    } catch (e) {
      await safeCloseBrowser(browser);
      throw e;
    }

    // Operador: vidro maximizado. Identidade da página continua o setViewport do preset (já colado no portão).
    // Visor: 1:1 se o preset cabe; encaixa se nao cabe. Nao altera innerWidth.
    try {
      const pagesNow = await browser.pages();
      const firstMax = pagesNow && pagesNow[0];
      if (firstMax) {
        const clientMax = await firstMax.target().createCDPSession();
        const { windowId } = await clientMax.send('Browser.getWindowForTarget');
        await clientMax.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        try { await glassViewer.applyGlassViewer(firstMax, { source: 'openBrowser' }); } catch {}
      }
    } catch (e) {
      logger.warn('[BROWSER] Falha ao maximizar janela do operador (seguindo): ' + ((e && e.message) || e));
    }

    browser.getPageCount = async () => (await browser.pages()).length;

    // Após toda a abertura e logo antes de return:
    if (browser && typeof browser.process === "function") {
      browser._rootPid = null;
      try {
        const proc = browser.process();
        if (proc && proc.pid) {
          browser._rootPid = proc.pid;
        }
      } catch {}
    }
    return browser;
  } catch (err) {
    try { await safeCloseBrowser(browser); } catch {}
    logger.error('[BROWSER][ERRO FATAL ao abrir Puppeteer/browser]', {}, err);
    throw err;
  }
}

// ===============
//
// ==========|||||| HELPERS ROBUSTOS MESSENGER LOGIN ||||||==========

async function waitAny(page, selectors, { timeout = 15000, visible = true } = {}) {
  const start = Date.now();
  while ((Date.now() - start) < timeout) {
    for (const sel of selectors) {
      try {
        const h = await page.$(sel);
        if (h) {
          if (!visible) return h;
          const ok = await page.evaluate(el => {
            const st = window.getComputedStyle(el);
            return st && st.visibility !== 'hidden' && st.display !== 'none' && el.offsetParent !== null;
          }, h).catch(()=>false);
          if (ok) return h;
        }
      } catch {}
    }
    await sleep(200);
  }
  try {
    if (process.env.BROWSER_DEBUG === '1') {
      logger.warn('[BROWSER][waitAny] timeout', {
        timeoutMs: timeout,
        selectors: Array.isArray(selectors) ? selectors.slice(0, 8) : []
      });
    }
  } catch {}
  return null;
}

async function clickByXPath(page, xps, { waitNav = true, timeoutNav = 15000, logPrefix = '[messenger]' } = {}) {
  for (const xp of xps) {
    try {
      const els = await page.$x(xp);
      if (els && els[0]) {
        await page.evaluate(el => {
          el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        }, els[0]);
        if (waitNav) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutNav }).catch(()=>{}),
            els[0].click({ delay: 80 })
          ]);
        } else {
          await els[0].click({ delay: 80 });
        }
        return true;
      }
    } catch (e) {
      try { if (process.env.BROWSER_DEBUG === '1') { logger.debug(`${logPrefix} clickByXPath err: ` + ((e && e.message) || e)); } } catch {}
    }
  }
  return false;
}

async function resolveNonceIfPresent(page, { logPrefix='[messenger][nonce]', maxCycles = 3 } = {}) {
  for (let i = 0; i < maxCycles; i++) {
    const url = page.url() || '';
    if (!/messenger.com\/login\/nonce/i.test(url)) return true;

    try { if (process.env.BROWSER_DEBUG === '1') { logger.debug(`${logPrefix} detectado em ${url}`); } } catch {}

    // Botão “Recarregar página”
    const recarregar = await waitAny(page, [
      'button[type="submit"]',
      'button[aria-label*="Recarregar"]'
    ], { timeout: 3000, visible: true });
    if (recarregar) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}),
          recarregar.click({ delay: 60 })
        ]);
        await sleep(800);
        continue;
      } catch {}
    }

    // Tenta “Return to messenger”
    const ok = await clickByXPath(page, [
      '//a[contains(.,"Return to messenger")]',
      '//a[contains(.,"Return") and contains(.,"messenger")]',
      '//a[contains(.,"Voltar") and contains(.,"Messenger")]'
    ], { waitNav: true, timeoutNav: 15000, logPrefix });

    if (ok) {
      await sleep(800);
      continue;
    }

    // Sem botão na UI: recarrega e volta manualmente para a home do messenger
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
    await sleep(800);
    try { await page.goto('https://www.messenger.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
    await sleep(800);
  }
  return !/messenger.com\/login\/nonce/i.test(page.url() || '');
}

async function clickContinuarComo(page, { logPrefix='[messenger][continuar]', timeout = 15000 } = {}) {
  // Enterprise: NÃO clicar "qualquer submit" aqui.
  // No Messenger, pode existir um <form id="login_form"> oculto com botão "Continuar".
  // Aqui só podemos clicar explicitamente "Continuar como <Nome>" (ou "Continue as <Name>").
  const t0 = Date.now();
  const maxMs = Math.max(1000, Number(timeout || 0) || 0);
  while ((Date.now() - t0) < maxMs) {
    const clicked = await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const isVisible = (el) => {
        try {
          const r = el.getBoundingClientRect();
          if (!r || r.width < 2 || r.height < 2) return false;
          const st = window.getComputedStyle(el);
          if (!st || st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity || '1') < 0.05) return false;
      return true;
        } catch { return false; }
      };
      const cands = Array.from(document.querySelectorAll('button,[role="button"]')).slice(0, 240);
      for (const el of cands) {
        if (!el) continue;
        const disabled = (el.getAttribute('aria-disabled') === 'true') || (el.getAttribute('disabled') != null) || (String(el.getAttribute('tabindex')||'') === '-1');
        if (disabled) continue;
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.textContent || '');
        const al = norm(el.getAttribute('aria-label') || '');
        if (t.includes('continuar como') || al.includes('continuar como') || t.includes('continue as') || al.includes('continue as')) {
          try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch {}
          el.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); } catch {}
      return true;
    }
    await sleep(250);
  }
  try { if (process.env.BROWSER_DEBUG === '1') { logger.debug(`${logPrefix} nenhum 'Continuar como' detectado`); } } catch {}
  return false;
}

// Facebook checkpoint helpers
async function clickVoltarParaFacebook(page, { logPrefix='[fb][voltar]', timeout = 15000 } = {}) {
  try {
    if (!page) return false;
    const ok = await clickByXPath(page, [
      '//a[contains(.,"Voltar para o Facebook")]',
      '//div[@role="button"][contains(.,"Voltar para o Facebook")]',
      '//button[contains(.,"Voltar para o Facebook")]',
      '//a[contains(.,"Back to Facebook")]',
      '//div[@role="button"][contains(.,"Back to Facebook")]',
      '//button[contains(.,"Back to Facebook")]'
    ], { waitNav: true, timeoutNav: Math.max(5000, Number(timeout||0)||0), logPrefix });
    return !!ok;
  } catch {
    return false;
  }
}

async function detectMessengerPinModal(page) {
  try {
    // Contrato DOM real (forense MAE1/MAE2 2026-08-04):
    // 1) Âncora = input oficial #mw-numeric-code-input-prevent-composer-focus-steal (aria-label=PIN, maxlength=6).
    //    Os "-" visuais são spans aria-hidden — NÃO são inputs.
    // 2) pin_input = "Insira seu PIN para restaurar..." + input oficial (NÃO exige role=dialog —
    //    scans MAE1/MAE2 mostravam p:false com modal visível quando exigíamos dialog).
    // 3) create_pin = frase de CRIAR + input oficial (anti-FP: feed CTA sozinho sem input = false).
    // 4) continue_without_restore = dialog "Continuar sem restaurar?" + botão habilitado.
    return await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const isVisible = (el) => {
        try {
          if (!el || typeof el.getBoundingClientRect !== 'function') return false;
          const r = el.getBoundingClientRect();
          const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
          if (!r || r.width < 2 || r.height < 2) return false;
          if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
          return true;
        } catch {
          return false;
        }
      };
      const isEnabledBtn = (el) => {
        if (!el) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.getAttribute('disabled') != null) return false;
        if (String(el.getAttribute('tabindex') || '') === '-1') return false;
        return isVisible(el);
      };
      const hasCreatePinPhrase = (t) =>
        t.includes('crie um pin') ||
        t.includes('criar pin') ||
        t.includes('create a pin') ||
        t.includes('create pin') ||
        t.includes('seu pin restaura') ||
        t.includes('sem um pin') ||
        t.includes('evitar a perda') ||
        t.includes('historico de conversas') ||
        t.includes('perda do seu historico');
      const hasConfirmPinPhrase = (t) =>
        t.includes('confirme o pin') ||
        t.includes('confirme seu pin') ||
        t.includes('confirmar o pin') ||
        t.includes('confirm your pin') ||
        t.includes('reinsira seu pin') ||
        t.includes('digite novamente') ||
        t.includes('digite de novo');
      const hasEnterPinPhrase = (t) =>
        t.includes('insira seu pin') ||
        t.includes('inserir seu pin') ||
        t.includes('enter your pin') ||
        (t.includes('insira') && t.includes('pin') && t.includes('restaurar'));
      const hasRestoreSyncNoticePhrase = (t) =>
        (
          t.includes('apos restaurar o historico de conversas') &&
          t.includes('sincronizacao automatica das mensagens continuara')
        ) ||
        (
          t.includes('after restoring your chat history') &&
          t.includes('automatic message syncing')
        );
      const textNear = (el) => {
        let n = el;
        for (let i = 0; i < 12 && n; i++) {
          const t = norm(n.innerText || n.textContent || '');
          if (t && t.length >= 24) return t;
          n = n.parentElement;
        }
        return norm(document.body ? (document.body.innerText || '') : '');
      };

      const bodyTxt = norm(document.body ? (document.body.innerText || '') : '');
      const hasLocalPinContext = (el) => {
        let n = el;
        const boundary = el && el.closest
          ? el.closest('div[role="dialog"], [aria-modal="true"]')
          : null;
        for (let i = 0; i < 14 && n && n !== document.body && n !== document.documentElement; i++) {
          const t = norm(n.innerText || n.textContent || '');
          if (hasCreatePinPhrase(t) || hasConfirmPinPhrase(t) || hasEnterPinPhrase(t)) return true;
          if (boundary && n === boundary) break;
          n = n.parentElement;
        }
        return false;
      };
      const hasLocalConfirmContext = (el) => {
        let n = el;
        const boundary = el && el.closest
          ? el.closest('div[role="dialog"], [aria-modal="true"]')
          : null;
        for (let i = 0; i < 14 && n && n !== document.body && n !== document.documentElement; i++) {
          const t = norm(n.innerText || n.textContent || '');
          if (hasConfirmPinPhrase(t)) return true;
          if (boundary && n === boundary) break;
          n = n.parentElement;
        }
        return false;
      };
      // Âncora 1: input oficial em qualquer lugar visível (modal restaurar/criar).
      const officialCandidates = Array.from(document.querySelectorAll(
        'input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label="PIN"][maxlength="6"][autocomplete="one-time-code"], input[aria-label="PIN"][maxlength="6"], input[aria-label="Confirme seu PIN"][maxlength="6"], input[aria-label="Confirm your PIN"][maxlength="6"], input[maxlength="6"][autocomplete="one-time-code"], input[maxlength="6"][inputmode="numeric"]'
      ));
      // FB PIN oficial costuma ter opacity:0 / box 0x0 — isVisible falha e o sistema nunca digita
      // (forense MAE1 joinville-1786214565664: CTA click ok, hasOfficial=false com input no DOM).
      const isOfficialPinUsable = (el) => {
        try {
          if (!el || !el.isConnected) return false;
          const id = String(el.id || '');
          const al = norm(el.getAttribute('aria-label') || '');
          const maxLen = Number(el.getAttribute('maxlength') || 0) || 0;
          const ac = norm(el.getAttribute('autocomplete') || '');
          const mode = norm(el.getAttribute('inputmode') || '');
          const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
          if (st && st.display === 'none') return false;
          if (st && st.visibility === 'hidden') return false;
          if (el.getAttribute('aria-hidden') === 'true') return false;
          if (el.getAttribute('disabled') != null) return false;
          if (id === 'mw-numeric-code-input-prevent-composer-focus-steal') return true;
          if (maxLen === 6 && al.includes('pin')) return true;
          if (
            maxLen === 6 &&
            hasLocalPinContext(el) &&
            (ac.includes('one-time-code') || mode.includes('numeric'))
          ) return true;
          return false;
        } catch { return false; }
      };
      const activeEl = document.activeElement;
      const activeOfficial = officialCandidates.find((el) => el === activeEl && isOfficialPinUsable(el)) || null;
      const confirmOfficial = officialCandidates.find((el) => {
        if (!isOfficialPinUsable(el)) return false;
        const al = norm(el.getAttribute('aria-label') || '');
        return (
          (al.includes('pin') && (al.includes('confirme') || al.includes('confirm'))) ||
          hasLocalConfirmContext(el)
        );
      }) || null;
      // O React mantém o input da etapa 1 no DOM e monta outro com o MESMO id
      // na confirmação. Priorizar o ativo; depois, o aria de confirmação.
      const officialPinEl =
        activeOfficial ||
        confirmOfficial ||
        officialCandidates.find(isOfficialPinUsable) ||
        null;
      const hasOfficialPinInput = !!officialPinEl;
      const surfaceTxt = officialPinEl ? textNear(officialPinEl) : '';
      const pinIncorrect =
        surfaceTxt.includes('pin incorreto') ||
        surfaceTxt.includes('incorrect pin') ||
        (surfaceTxt.includes('tente novamente') && surfaceTxt.includes('pin'));

      // Dialogs (pode haver mais de um; preferir o que contém o input / continue).
      const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
      const dlgWithPin = officialPinEl
        ? (officialPinEl.closest('div[role="dialog"], [aria-modal="true"]') || null)
        : null;
      const dlgContinue = dialogs.find((d) => {
        const t = norm(d.innerText || d.textContent || '');
        const al = norm(d.getAttribute('aria-label') || '');
        return t.includes('continuar sem restaurar') || al.includes('continuar sem restaurar');
      }) || null;
      const dlgEl = dlgWithPin || dlgContinue || dialogs[0] || null;
      const dlgTxt = dlgEl ? norm(dlgEl.innerText || dlgEl.textContent || '') : '';
      const scope = dlgWithPin || (officialPinEl ? officialPinEl.parentElement : null);

      const splitPinInputs = scope ? Array.from(scope.querySelectorAll('input:not([aria-hidden="true"])')).filter(el => {
        if (!isVisible(el)) return false;
        if (el === officialPinEl) return false;
        if (String(el.id || '') === 'mw-numeric-code-input-prevent-composer-focus-steal') return false;
        const type = norm(el.getAttribute('type') || '');
        const mode = norm(el.getAttribute('inputmode') || '');
        const al = norm(el.getAttribute('aria-label') || '');
        const ac = norm(el.getAttribute('autocomplete') || '');
        const maxLen = Number(el.getAttribute('maxlength') || 0) || 0;
        const isTextLike = !type || type === 'text' || type === 'tel' || type === 'number' || type === 'password';
        if (!isTextLike) return false;
        if (maxLen === 1) return true;
        if (mode.includes('numeric') && maxLen > 0 && maxLen <= 2) return true;
        if (ac.includes('one-time-code') && maxLen > 0 && maxLen <= 2) return true;
        if (al.includes('pin') && maxLen > 0 && maxLen <= 2) return true;
        return false;
      }) : [];
      const hasSplitPinInputs = splitPinInputs.length >= 4;
      const hasPinInput = hasOfficialPinInput;
      const hasCreateTypingSurface = hasSplitPinInputs || hasPinInput;

      const contScope = dlgContinue || dlgEl;
      const contTxt = contScope ? norm(contScope.innerText || contScope.textContent || '') : '';
      const contAria = contScope ? norm(contScope.getAttribute('aria-label') || '') : '';
      const contText =
        contTxt.includes('continuar sem restaurar') ||
        contAria.includes('continuar sem restaurar') ||
        (contTxt.includes('nao restaurar') && contTxt.includes('mensagens'));
      const hasNaoRestaurarBtn =
        !!(contScope && Array.from(contScope.querySelectorAll('button,[role="button"]'))
          .some(el => {
            if (!isEnabledBtn(el)) return false;
            const t = norm(el.innerText || el.textContent || '');
            const al = norm(el.getAttribute('aria-label') || '');
            return t.includes('nao restaurar mensagens') || al.includes('nao restaurar mensagens');
          }));
      // Pós-PIN de restauração: aviso de sincronização com botão OK. O Facebook
      // pode manter o input anterior no DOM; por isso o aviso exato tem prioridade.
      const restoreSyncOkBtn =
        Array.from(document.querySelectorAll('button,[role="button"]')).find((el) => {
          if (!isEnabledBtn(el)) return false;
          const t = norm(el.innerText || el.textContent || '').trim();
          const al = norm(el.getAttribute('aria-label') || '').trim();
          if (t !== 'ok' && al !== 'ok') return false;
          let n = el;
          for (let i = 0; i < 18 && n && n !== document.body && n !== document.documentElement; i++) {
            const localText = norm(n.innerText || n.textContent || '');
            if (hasRestoreSyncNoticePhrase(localText)) return true;
            n = n.parentElement;
          }
          return false;
        }) || null;
      const isRestoreSyncNotice = !!restoreSyncOkBtn;

      // Frases: preferir texto perto do input oficial (não body inteiro do feed).
      const phraseTxt = surfaceTxt || dlgTxt || bodyTxt;
      const officialPinAria = officialPinEl ? norm(officialPinEl.getAttribute('aria-label') || '') : '';
      const isPinConfirmation = !!(
        hasOfficialPinInput &&
        (
          hasConfirmPinPhrase(phraseTxt) ||
          (officialPinAria.includes('pin') && (officialPinAria.includes('confirme') || officialPinAria.includes('confirm')))
        )
      );
      const createText = !!(
        hasOfficialPinInput &&
        (hasCreatePinPhrase(phraseTxt) || isPinConfirmation) &&
        !hasEnterPinPhrase(phraseTxt)
      );
      const pinText = !!(hasOfficialPinInput && hasEnterPinPhrase(phraseTxt));
      const hasCreateBtn =
        Array.from(document.querySelectorAll('button,div[role="button"]')).some(el => {
          if (!isVisible(el)) return false;
          const t = norm(el.innerText || el.textContent || '');
          const al = norm(el.getAttribute('aria-label') || '');
          return t.includes('criar pin') || al.includes('criar pin') || al === 'criar pin' ||
            t.includes('create pin') || al.includes('create pin') || al === 'create pin';
        });
      // Intro modal real (forense MAE1 sorocaba-1786213049929):
      // "Crie um PIN para acessar suas conversas..." + botão Criar PIN, SEM input ainda.
      // Antes: p:false sempre (exigia input) → nurse/configure nunca clicava.
      const introCreatePhrase =
        bodyTxt.includes('crie um pin para acessar suas conversas') ||
        bodyTxt.includes('create a pin to access your conversations') ||
        (dlgTxt.includes('crie um pin') && (dlgTxt.includes('qualquer dispositivo') || dlgTxt.includes('criptografia'))) ||
        (hasCreatePinPhrase(dlgTxt) && dlgTxt.includes('qualquer dispositivo'));
      const isCreatePinCta = !!(!hasOfficialPinInput && !hasSplitPinInputs && hasCreateBtn && introCreatePhrase);
      const feedCreateCtaOnly = !!(!hasOfficialPinInput && hasCreateBtn && hasCreatePinPhrase(bodyTxt) && !introCreatePhrase);

      const isCreatePin = !!(createText && hasCreateTypingSurface);
      const isPinInput = !!(pinText && hasPinInput && !isCreatePin);
      const isContinue = !!(contText && hasNaoRestaurarBtn);
      const present = isRestoreSyncNotice || isCreatePinCta || isCreatePin || isPinInput || isContinue;

      return {
        present: !!present,
        kind: isRestoreSyncNotice ? 'restore_sync_notice'
          : isCreatePinCta ? 'create_pin_cta'
          : isCreatePin ? 'create_pin'
          : isPinInput ? 'pin_input'
          : isContinue ? 'continue_without_restore'
          : null,
        hasPinInput,
        hasOfficialPinInput,
        hasSplitPinInputs,
        hasCreateTypingSurface,
        hasNaoRestaurarBtn,
        hasCreateBtn,
        createText: !!createText,
        pinText: !!pinText,
        pinIncorrect: !!pinIncorrect,
        isPinConfirmation: !!isPinConfirmation,
        officialPinAria,
        feedCreateCtaOnly: !!feedCreateCtaOnly,
        isCreatePinCta: !!isCreatePinCta,
        hasRestoreSyncOkBtn: !!restoreSyncOkBtn,
        hasDialog: !!dlgEl
      };
    });
  } catch {
    return { present: false };
  }
}

async function tryDismissMessengerPinModal(page, { logPrefix='[PIN]', maxTries = 2 } = {}) {
  const fs = require('fs');
  const path = require('path');
  const MSGPIN_LOG = path.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
  const pinLog = (obj) => { try { fs.appendFileSync(MSGPIN_LOG, JSON.stringify({ ts: Date.now(), src: 'browser.js', ...obj }) + '\n'); } catch {} };

  // PIN padrão do sistema (enterprise): configurável via env.
  // Default: 882584 (padrão operacional)
  const DEFAULT_PIN = String(process.env.MESSENGER_PIN || '882584').trim() || '882584';

  async function clickCloseTrusted() {
    try {
      const h =
        (await page.$('div[role="dialog"] [aria-label="Fechar"], div[role="dialog"] [aria-label*="Fechar"], div[role="dialog"] [aria-label*="Close"]')) ||
        (await page.$('[aria-label="Fechar"], [aria-label*="Fechar"], [aria-label*="Close"]'));
      if (!h) return false;
      await h.click({ delay: 60 }).catch(()=>{});
      return true;
    } catch { return false; }
  }

  async function clickNaoRestaurarTrusted() {
    try {
      // DOM real: há botão decoy aria-disabled/aria-hidden + botão real tabindex=0.
      // Só clicar no habilitado.
      const clicked = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const roots = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
        const scopes = roots.length ? roots : [document];
        for (const scope of scopes) {
          const btns = Array.from(scope.querySelectorAll('button,[role="button"]'));
          for (const b of btns) {
            const disabled =
              b.getAttribute('aria-disabled') === 'true' ||
              b.getAttribute('aria-hidden') === 'true' ||
              b.getAttribute('disabled') != null ||
              String(b.getAttribute('tabindex') || '') === '-1';
            if (disabled) continue;
            const t = norm(b.innerText || b.textContent || '');
            const al = norm(b.getAttribute('aria-label') || '');
            if (t.includes('nao restaurar mensagens') || al.includes('nao restaurar mensagens')) {
              try { b.click(); return true; } catch {}
            }
          }
        }
        return false;
      }).catch(() => false);
      return !!clicked;
    } catch { return false; }
  }

  async function clickRestoreSyncOkTrusted() {
    const marker = 'data-conveniente-restore-sync-ok';
    try {
      const marked = await page.evaluate((markerAttr) => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const hasNoticePhrase = (t) =>
          (
            t.includes('apos restaurar o historico de conversas') &&
            t.includes('sincronizacao automatica das mensagens continuara')
          ) ||
          (
            t.includes('after restoring your chat history') &&
            t.includes('automatic message syncing')
          );
        const isEnabledVisible = (el) => {
          try {
            if (!el || !el.isConnected) return false;
            if (el.getAttribute('aria-disabled') === 'true') return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.getAttribute('disabled') != null) return false;
            if (String(el.getAttribute('tabindex') || '') === '-1') return false;
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!r || r.width < 2 || r.height < 2) return false;
            if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
            return true;
          } catch { return false; }
        };
        try {
          document.querySelectorAll(`[${markerAttr}]`).forEach(el => el.removeAttribute(markerAttr));
        } catch {}
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        for (const el of buttons) {
          if (!isEnabledVisible(el)) continue;
          const text = norm(el.innerText || el.textContent || '').trim();
          const aria = norm(el.getAttribute('aria-label') || '').trim();
          if (text !== 'ok' && aria !== 'ok') continue;
          let n = el;
          let anchored = false;
          for (let i = 0; i < 18 && n && n !== document.body && n !== document.documentElement; i++) {
            const localText = norm(n.innerText || n.textContent || '');
            if (hasNoticePhrase(localText)) {
              anchored = true;
              break;
            }
            n = n.parentElement;
          }
          if (!anchored) continue;
          el.setAttribute(markerAttr, '1');
          return true;
        }
        return false;
      }, marker).catch(() => false);
      if (!marked) return false;
      const handle = await page.$(`[${marker}="1"]`);
      if (!handle) return false;
      await handle.click({ delay: 70 });
      await page.evaluate((markerAttr) => {
        try {
          document.querySelectorAll(`[${markerAttr}]`).forEach(el => el.removeAttribute(markerAttr));
        } catch {}
      }, marker).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async function dismissRestoreSyncNotice() {
    for (let clickAttempt = 1; clickAttempt <= 2; clickAttempt++) {
      const before = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      if (!before || before.kind !== 'restore_sync_notice') {
        return { ok: true, dismissed: true, clicked: clickAttempt > 1 };
      }
      const clicked = await clickRestoreSyncOkTrusted().catch(() => false);
      pinLog({ event: 'restore_sync_notice_ok_click', clickAttempt, clicked: !!clicked });
      await sleep(clicked ? 900 : 450);
      const after = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      if (!after || after.kind !== 'restore_sync_notice') {
        return { ok: true, dismissed: true, clicked: !!clicked };
      }
    }
    return { ok: false, dismissed: false, error: 'restore_sync_notice_ok_still_present' };
  }

  async function clickCreatePinButton() {
    try {
      const clicked = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const isVisible = (el) => {
          try {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!r || r.width < 2 || r.height < 2) return false;
            if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
            return true;
          } catch { return false; }
        };
        const isEnabled = (el) => {
          if (!el || !isVisible(el)) return false;
          if (el.getAttribute('aria-disabled') === 'true') return false;
          if (el.getAttribute('aria-hidden') === 'true') return false;
          if (el.getAttribute('disabled') != null) return false;
          if (String(el.getAttribute('tabindex') || '') === '-1') return false;
          return true;
        };
        const matchCreate = (el) => {
          const t = norm(el.innerText || el.textContent || '');
          const al = norm(el.getAttribute('aria-label') || '');
          return al === 'criar pin' || t === 'criar pin' || t.includes('criar pin') || al.includes('criar pin') ||
            al === 'create pin' || t === 'create pin' || t.includes('create pin') || al.includes('create pin');
        };
        // 1) dialog/aria-modal (preferido)
        const roots = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
        // 2) fallback: superfície do intro (título "Crie um PIN para acessar...") — sem role=dialog em alguns builds
        if (!roots.length) {
          const hs = Array.from(document.querySelectorAll('h2,span')).filter((el) => {
            const t = norm(el.innerText || el.textContent || '');
            return t.includes('crie um pin para acessar') || t.includes('create a pin to access');
          });
          for (const h of hs.slice(0, 6)) {
            let n = h;
            for (let i = 0; i < 10 && n; i++) {
              if (n.querySelector && n.querySelector('[aria-label="Criar PIN"], [aria-label="Create PIN"], [role="button"]')) {
                roots.push(n);
                break;
              }
              n = n.parentElement;
            }
          }
        }
        const scopes = roots.length ? roots : [document];
        for (const scope of scopes) {
          const buttons = Array.from(scope.querySelectorAll('button,[role="button"],div[aria-label]')).slice(0, 260);
          // Preferir aria-label exato "Criar PIN"
          for (const b of buttons) {
            if (!isEnabled(b)) continue;
            const al = norm(b.getAttribute('aria-label') || '');
            if (al === 'criar pin') { try { b.click(); return { ok: true, via: 'aria_label' }; } catch {} }
          }
          for (const b of buttons) {
            if (!isEnabled(b)) continue;
            if (matchCreate(b)) { try { b.click(); return { ok: true, via: 'text' }; } catch {} }
          }
        }
        return { ok: false };
      });
      if (clicked && clicked.ok) return true;
      // Clique real Puppeteer (evaluate click às vezes não avança o React do FB).
      try {
        const h =
          (await page.$('[aria-label="Criar PIN"][role="button"]')) ||
          (await page.$('[aria-label="Criar PIN"]')) ||
          (await page.$('div[role="button"][aria-label="Criar PIN"]')) ||
          (await page.$('[aria-label="Create PIN"][role="button"]')) ||
          (await page.$('[aria-label="Create PIN"]'));
        if (h) {
          await h.click({ delay: 70 }).catch(() => {});
          return true;
        }
      } catch {}
      return false;
    } catch { return false; }
  }

  async function waitForOfficialPinInput({ timeoutMs = 10_000, preferConfirmation = false } = {}) {
    const t0 = Date.now();
    while ((Date.now() - t0) < timeoutMs) {
      const det = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      if (
        det &&
        det.hasOfficialPinInput &&
        (!preferConfirmation || det.isPinConfirmation === true)
      ) {
        return { ok: true, det };
      }
      try {
        const h = await page.$('input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label="PIN"][maxlength="6"], input[aria-label="Confirme seu PIN"][maxlength="6"], input[aria-label="Confirm your PIN"][maxlength="6"], input[maxlength="6"][autocomplete="one-time-code"], input[maxlength="6"][inputmode="numeric"]');
        if (h && !preferConfirmation) {
          return {
            ok: true,
            det: det || { present: true, hasOfficialPinInput: true, kind: 'create_pin' }
          };
        }
      } catch {}
      if (
        !preferConfirmation &&
        det &&
        (det.hasOfficialPinInput || det.hasSplitPinInputs || det.kind === 'create_pin' || det.kind === 'pin_input')
      ) {
        return { ok: true, det };
      }
      await sleep(350);
    }
    return { ok: false, det: await detectMessengerPinModal(page).catch(() => ({ present: false })) };
  }

  async function clickMoreOptionsThenSkip() {
    // Alguns modais de “Crie um PIN…” não mostram “Criar PIN” e sim “Mais opções”.
    // Estratégia: clicar "Mais opções" e depois "Agora não"/"Pular"/"No momento não".
    try {
      const didMore = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const scope = document.querySelector('div[role="dialog"]');
        if (!scope) return false;
        const btns = Array.from(scope.querySelectorAll('button,[role="button"]')).slice(0, 120);
        for (const b of btns) {
          const disabled = (b.getAttribute('aria-disabled') === 'true') || (b.getAttribute('disabled') != null) || (String(b.getAttribute('tabindex')||'') === '-1');
          if (disabled) continue;
          const t = norm(b.innerText || b.textContent || '');
          const al = norm(b.getAttribute('aria-label') || '');
          if (t.includes('mais opcoes') || t.includes('mais opções') || al.includes('mais opcoes') || al.includes('mais opções')) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (!didMore) return { ok: false, error: 'more_options_not_found' };
      await sleep(900);
      const didSkip = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const dlg = document.querySelector('div[role="dialog"]');
        if (!dlg) return false;
        const btns = Array.from(dlg.querySelectorAll('button,[role="button"],a[role="button"],input[type="submit"]')).slice(0, 160);
        const words = ['agora nao', 'agora não', 'pular', 'no momento nao', 'no momento não', 'mais tarde', 'continuar sem'];
        for (const b of btns) {
          const disabled = (b.getAttribute('aria-disabled') === 'true') || (b.getAttribute('disabled') != null) || (String(b.getAttribute('tabindex')||'') === '-1');
          if (disabled) continue;
          const t = norm(b.innerText || b.value || b.textContent || '');
          const al = norm(b.getAttribute('aria-label') || '');
          if (words.some(w => t.includes(w) || al.includes(w))) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (!didSkip) return { ok: false, error: 'skip_button_not_found' };
      await sleep(1200);
      return { ok: true, skipped: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'more_options_exception' };
    }
  }

  async function readCreatePinState() {
    try {
      return await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const isVisible = (el) => {
          try {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!r || r.width < 2 || r.height < 2) return false;
            if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
            return true;
          } catch {
            return false;
          }
        };
        const officialSelector =
          'input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label="PIN"][maxlength="6"][autocomplete="one-time-code"], input[aria-label="PIN"][maxlength="6"], input[aria-label="Confirme seu PIN"][maxlength="6"], input[aria-label="Confirm your PIN"][maxlength="6"], input[maxlength="6"][autocomplete="one-time-code"], input[maxlength="6"][inputmode="numeric"]';
        const officialCandidates = Array.from(document.querySelectorAll(officialSelector));
        const isUsableOfficial = (el) => {
          try {
            if (!el || !el.isConnected) return false;
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.getAttribute('disabled') != null) return false;
            return true; // opacity/box 0 é normal no input oficial do FB
          } catch { return false; }
        };
        const hasPinSurface = (el) => {
          let n = el;
          const boundary = el && el.closest
            ? el.closest('div[role="dialog"], [aria-modal="true"]')
            : null;
          for (let i = 0; i < 14 && n && n !== document.body && n !== document.documentElement; i++) {
            const t = norm(n.innerText || n.textContent || '');
            if (
              t.includes('crie um pin') ||
              t.includes('criar pin') ||
              t.includes('create a pin') ||
              t.includes('create pin') ||
              t.includes('confirme o pin') ||
              t.includes('confirme seu pin') ||
              t.includes('confirm your pin') ||
              (t.includes('pin') && (
                t.includes('historico') ||
                t.includes('restaur') ||
                t.includes('repita') ||
                t.includes('novamente') ||
                t.includes('reinsira')
              ))
            ) return true;
            if (boundary && n === boundary) break;
            n = n.parentElement;
          }
          return false;
        };
        const hasConfirmSurface = (el) => {
          let n = el;
          const boundary = el && el.closest
            ? el.closest('div[role="dialog"], [aria-modal="true"]')
            : null;
          for (let i = 0; i < 14 && n && n !== document.body && n !== document.documentElement; i++) {
            const t = norm(n.innerText || n.textContent || '');
            if (
              t.includes('confirme o pin') ||
              t.includes('confirme seu pin') ||
              t.includes('confirm your pin') ||
              (t.includes('pin') && (
                t.includes('repita') ||
                t.includes('novamente') ||
                t.includes('reinsira') ||
                t.includes('digite de novo')
              ))
            ) return true;
            if (boundary && n === boundary) break;
            n = n.parentElement;
          }
          return false;
        };
        const isTrustedOfficial = (el) => {
          if (!isUsableOfficial(el)) return false;
          const id = String(el.id || '');
          const al = norm(el.getAttribute('aria-label') || '');
          const maxLen = Number(el.getAttribute('maxlength') || 0) || 0;
          const ac = norm(el.getAttribute('autocomplete') || '');
          const mode = norm(el.getAttribute('inputmode') || '');
          if (id === 'mw-numeric-code-input-prevent-composer-focus-steal') return true;
          if (maxLen === 6 && al.includes('pin')) return true;
          return !!(
            maxLen === 6 &&
            hasPinSurface(el) &&
            (ac.includes('one-time-code') || mode.includes('numeric'))
          );
        };
        const active = document.activeElement;
        const activeOfficial = officialCandidates.find((el) => el === active && isTrustedOfficial(el)) || null;
        const confirmOfficial = officialCandidates.find((el) => {
          if (!isTrustedOfficial(el)) return false;
          const al = norm(el.getAttribute('aria-label') || '');
          return (
            (al.includes('pin') && (al.includes('confirme') || al.includes('confirm'))) ||
            hasConfirmSurface(el)
          );
        }) || null;
        // Há dois nós com o mesmo id durante a transição. Nunca escolher o
        // input antigo apenas porque ele aparece primeiro no DOM.
        const officialPin =
          activeOfficial ||
          confirmOfficial ||
          officialCandidates.find(isTrustedOfficial) ||
          null;
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [aria-modal="true"]'));
        const dlgEl =
          (officialPin && officialPin.closest('div[role="dialog"], [aria-modal="true"]')) ||
          dialogs.find((d) => {
            const t = norm(d.innerText || d.textContent || '');
            return t.includes('pin') && (
              t.includes('confirme') ||
              t.includes('crie') ||
              t.includes('criar') ||
              t.includes('historico')
            );
          }) ||
          dialogs[0] ||
          null;
        const dlg = dlgEl;
        // O modal real de confirmação pode vir SEM role=dialog. O div mais próximo
        // contém só o input; subir a árvore até encontrar o título/descrição.
        const textNear = (el) => {
          let n = el;
          for (let i = 0; i < 14 && n; i++) {
            const t = norm(n.innerText || n.textContent || '');
            if (
              t.includes('confirme o pin') ||
              t.includes('confirme seu pin') ||
              t.includes('confirm your pin') ||
              t.includes('crie um pin') ||
              t.includes('criar pin') ||
              t.includes('evitar a perda') ||
              (t.includes('historico') && t.includes('pin'))
            ) return t;
            n = n.parentElement;
          }
          return norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
        };
        const txt = dlg
          ? norm(dlg.innerText || dlg.textContent || '')
          : (officialPin ? textNear(officialPin) : norm(document.body ? (document.body.innerText || '') : ''));
        const hasOfficialPinInput = !!officialPin;
        const officialPinValueLen = officialPin ? String(officialPin.value || '').trim().length : 0;
        const officialPinAria = officialPin ? norm(officialPin.getAttribute('aria-label') || '') : '';
        const splitInputs = dlg ? Array.from(dlg.querySelectorAll('input:not([aria-hidden="true"])')).filter(el => {
          if (!isVisible(el)) return false;
          if (el === officialPin) return false;
          if (String(el.id || '') === 'mw-numeric-code-input-prevent-composer-focus-steal') return false;
          const type = norm(el.getAttribute('type') || '');
          const mode = norm(el.getAttribute('inputmode') || '');
          const al = norm(el.getAttribute('aria-label') || '');
          const ac = norm(el.getAttribute('autocomplete') || '');
          const maxLen = Number(el.getAttribute('maxlength') || 0) || 0;
          const isTextLike = !type || type === 'text' || type === 'tel' || type === 'number' || type === 'password';
          if (!isTextLike) return false;
          if (maxLen === 1) return true;
          if (mode.includes('numeric') && maxLen > 0 && maxLen <= 2) return true;
          if (ac.includes('one-time-code') && maxLen > 0 && maxLen <= 2) return true;
          if (al.includes('pin') && maxLen > 0 && maxLen <= 2) return true;
          return false;
        }) : [];
        const filledCount = splitInputs.filter(el => String(el.value || '').trim().length > 0).length;
        const activeAria = active && active.getAttribute ? norm(active.getAttribute('aria-label') || '') : '';
        const activeRole = active && active.getAttribute ? norm(active.getAttribute('role') || '') : '';
        const activeId = active && active.id ? String(active.id) : '';
        const focusInsideDialog = !!(dlgEl && active && typeof dlgEl.contains === 'function' && dlgEl.contains(active));
        const focusOnOfficialPin = !!(officialPin && active === officialPin);
        const dangerousFocus =
          activeAria.includes('seu perfil') ||
          activeAria.includes('your profile') ||
          activeAria.includes('mensagem') ||
          activeAria.includes('message') ||
          activeAria.includes('escreva') ||
          activeAria.includes('composer') ||
          activeAria.includes('digite uma mensagem') ||
          (activeRole === 'textbox' && !activeAria.includes('pin') && activeId !== 'mw-numeric-code-input-prevent-composer-focus-steal' && !focusInsideDialog);
        // Só texto do dialog — feed/body sozinho nunca autoriza.
        const asksRepeat = !!(
          txt.includes('confirme o pin') ||
          txt.includes('confirme seu pin') ||
          txt.includes('confirm your pin') ||
          txt.includes('repita') ||
          txt.includes('repet') ||
          txt.includes('digite de novo') ||
          txt.includes('digite novamente') ||
          (officialPinAria.includes('pin') && (officialPinAria.includes('confirme') || officialPinAria.includes('confirm')))
        );
        const hasCreateText = !!(
          txt.includes('crie um pin') ||
          txt.includes('criar pin') ||
          txt.includes('seu pin restaura') ||
          txt.includes('sem um pin') ||
          txt.includes('evitar a perda') ||
          (txt.includes('historico') && txt.includes('pin')) ||
          asksRepeat
        );
        return {
          hasCreateText,
          asksRepeat,
          phase: asksRepeat ? 'confirm' : (hasCreateText ? 'create' : 'unknown'),
          splitInputsCount: splitInputs.length,
          filledCount,
          hasOfficialPinInput,
          officialPinValueLen,
          officialPinAria,
          focusOnOfficialPin,
          focusInsideDialog,
          dangerousFocus,
          hasDialog: !!dlgEl,
          activeTag: String(active && active.tagName || '').toLowerCase(),
          activeType: active && active.getAttribute ? norm(active.getAttribute('type') || '') : '',
          activeAria,
          activeRole,
          activeId
        };
      });
    } catch {
      return null;
    }
  }

  // Digitar create_pin só com input oficial no dialog OU slots 1-char no dialog.
  // Feed com CTA "Criar PIN" sem input = recusa.
  function canTypeCreatePinKeyboard(state, det) {
    if (!state || typeof state !== 'object') return false;
    if (state.dangerousFocus === true) return false;
    const hasOfficial =
      (det && det.hasOfficialPinInput === true) ||
      state.hasOfficialPinInput === true;
    const hasSplit =
      Number(state.splitInputsCount || 0) >= 4 ||
      (det && det.hasSplitPinInputs === true);
    // Dialog opcional: FB renderiza modal PIN sem role=dialog em alguns builds.
    const createOk =
      state.hasCreateText === true ||
      (det && det.createText === true) ||
      (det && (det.kind === 'create_pin' || det.kind === 'create_pin_cta'));
    if (!createOk) return false;
    return !!(hasOfficial || hasSplit);
  }

  // Sem clique: foca o input oficial. Na confirmação, o Facebook mantém o
  // input antigo no DOM (às vezes com o mesmo id), então aria/active mandam.
  async function focusOfficialCreatePinInput({ preferConfirmation = false } = {}) {
    try {
      const focused = await page.evaluate((preferConfirm) => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const selector =
          'input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label="PIN"][maxlength="6"][autocomplete="one-time-code"], input[aria-label="PIN"][maxlength="6"], input[aria-label="Confirme seu PIN"][maxlength="6"], input[aria-label="Confirm your PIN"][maxlength="6"], input[maxlength="6"][autocomplete="one-time-code"], input[maxlength="6"][inputmode="numeric"]';
        const candidates = Array.from(document.querySelectorAll(selector));
        const usable = (el) => {
          try {
            if (!el || !el.isConnected) return false;
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.getAttribute('disabled') != null) return false;
            return true;
          } catch { return false; }
        };
        const hasPinSurface = (el) => {
          let n = el;
          const boundary = el && el.closest
            ? el.closest('div[role="dialog"], [aria-modal="true"]')
            : null;
          for (let i = 0; i < 14 && n && n !== document.body && n !== document.documentElement; i++) {
            const t = norm(n.innerText || n.textContent || '');
            if (
              t.includes('crie um pin') ||
              t.includes('criar pin') ||
              t.includes('create a pin') ||
              t.includes('create pin') ||
              t.includes('confirme o pin') ||
              t.includes('confirme seu pin') ||
              t.includes('confirm your pin') ||
              (t.includes('pin') && (
                t.includes('historico') ||
                t.includes('restaur') ||
                t.includes('repita') ||
                t.includes('novamente') ||
                t.includes('reinsira')
              ))
            ) return true;
            if (boundary && n === boundary) break;
            n = n.parentElement;
          }
          return false;
        };
        const trusted = (el) => {
          if (!usable(el)) return false;
          const id = String(el.id || '');
          const al = norm(el.getAttribute('aria-label') || '');
          const maxLen = Number(el.getAttribute('maxlength') || 0) || 0;
          const ac = norm(el.getAttribute('autocomplete') || '');
          const mode = norm(el.getAttribute('inputmode') || '');
          if (id === 'mw-numeric-code-input-prevent-composer-focus-steal') return true;
          if (maxLen === 6 && al.includes('pin')) return true;
          return !!(
            maxLen === 6 &&
            hasPinSurface(el) &&
            (ac.includes('one-time-code') || mode.includes('numeric'))
          );
        };
        const isConfirm = (el) => {
          const al = norm(el && el.getAttribute ? el.getAttribute('aria-label') || '' : '');
          return al.includes('pin') && (al.includes('confirme') || al.includes('confirm'));
        };
        const isConfirmSurface = (el) => {
          let n = el;
          const boundary = el && el.closest
            ? el.closest('div[role="dialog"], [aria-modal="true"]')
            : null;
          for (let i = 0; i < 12 && n; i++) {
            const t = norm(n.innerText || n.textContent || '');
            if (
              t.includes('confirme o pin') ||
              t.includes('confirme seu pin') ||
              t.includes('confirm your pin') ||
              (t.includes('pin') && (
                t.includes('digite novamente') ||
                t.includes('digite de novo') ||
                t.includes('repita') ||
                t.includes('reinsira')
              ))
            ) return true;
            if (boundary && n === boundary) break;
            n = n.parentElement;
          }
          return false;
        };
        const active = document.activeElement;
        const activeCandidate = candidates.find((el) => el === active && trusted(el)) || null;
        let el = null;
        if (preferConfirm) {
          el =
            (activeCandidate && (isConfirm(activeCandidate) || isConfirmSurface(activeCandidate)) ? activeCandidate : null) ||
            candidates.find((candidate) => trusted(candidate) && (isConfirm(candidate) || isConfirmSurface(candidate))) ||
            activeCandidate ||
            [...candidates].reverse().find(trusted) ||
            null;
        } else {
          el = activeCandidate || candidates.find(trusted) || null;
        }
        if (!el) {
          return {
            ok: false,
            error: preferConfirm ? 'confirmation_pin_input_missing' : 'official_pin_input_missing',
            candidates: candidates.length
          };
        }
        const dlg = el.closest('div[role="dialog"], [aria-modal="true"]');
        try {
          const proto = el.constructor ? el.constructor.prototype : null;
          const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
          if (desc && typeof desc.set === 'function') desc.set.call(el, '');
          else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch {}
        try { el.focus(); } catch {}
        try { el.click(); } catch {}
        const activeAfter = document.activeElement;
        return {
          ok: !!(activeAfter && activeAfter === el),
          id: String(el.id || ''),
          aria: String(el.getAttribute('aria-label') || ''),
          valueLen: String(el.value || '').trim().length,
          hasDialog: !!dlg,
          confirmationSurface: !!isConfirmSurface(el),
          preferConfirmation: !!preferConfirm,
          candidates: candidates.length
        };
      }, !!preferConfirmation).catch(() => ({ ok: false, error: 'focus_eval_failed' }));
      pinLog({ event: 'create_pin_official_focus', result: focused });
      return focused;
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'focus_exception' };
    }
  }

  async function fillSplitPinInputsWithoutClicks(pinValue = DEFAULT_PIN, { round = 1 } = {}) {
    try {
      const digits = String(pinValue || '').trim();
      if (!/^\d{6}$/.test(digits)) return { ok: false, error: 'pin_value_invalid' };
      const result = await page.evaluate((value) => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const isVisible = (el) => {
          try {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!r || r.width < 2 || r.height < 2) return false;
            if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
            return true;
          } catch {
            return false;
          }
        };
        const dlg = document.querySelector('div[role="dialog"]');
        if (!dlg) return { ok: false, error: 'dialog_missing', count: 0 };
        const splitInputs = Array.from(dlg.querySelectorAll('input:not([aria-hidden="true"])')).filter(el => {
          if (!isVisible(el)) return false;
          const id = String(el.id || '');
          if (id === 'mw-numeric-code-input-prevent-composer-focus-steal') return false;
          const type = norm(el.getAttribute('type') || '');
          const mode = norm(el.getAttribute('inputmode') || '');
          const al = norm(el.getAttribute('aria-label') || '');
          const ac = norm(el.getAttribute('autocomplete') || '');
          const maxLen = Number(el.getAttribute('maxlength') || 0) || 0;
          const isTextLike = !type || type === 'text' || type === 'tel' || type === 'number' || type === 'password';
          if (!isTextLike) return false;
          if (maxLen === 1) return true;
          if (mode.includes('numeric') && maxLen > 0 && maxLen <= 2) return true;
          if (ac.includes('one-time-code') && maxLen > 0 && maxLen <= 2) return true;
          if (al.includes('pin') && maxLen > 0 && maxLen <= 2) return true;
          return false;
        }).slice(0, 6);
        if (splitInputs.length < 4) return { ok: false, error: 'split_inputs_not_found', count: splitInputs.length };
        const digits = String(value || '').split('');
        for (let i = 0; i < Math.min(splitInputs.length, digits.length); i++) {
          const el = splitInputs[i];
          const ch = String(digits[i] || '');
          try { if (typeof el.focus === 'function') el.focus(); } catch {}
          try {
            const proto = el && el.constructor ? el.constructor.prototype : null;
            const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
            if (desc && typeof desc.set === 'function') desc.set.call(el, ch);
            else el.value = ch;
          } catch {
            try { el.value = ch; } catch {}
          }
          try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
          try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
          try { el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true })); } catch {}
        }
        const filledCount = splitInputs.filter(el => String(el.value || '').trim().length > 0).length;
        return { ok: true, count: splitInputs.length, filledCount };
      }, digits).catch(()=>({ ok:false, error:'split_fill_eval_failed' }));
      pinLog({ event: 'create_pin_split_fill_result', round, result });
      return result;
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'split_fill_exception' };
    }
  }

  async function typePinWithKeyboardOnly(pinValue = DEFAULT_PIN, { round = 1, perDigitDelayMs = 320, betweenDigitPauseMs = 140, settleMs = 900, detHint = null } = {}) {
    try {
      const digits = String(pinValue || '').trim();
      if (!/^\d{6}$/.test(digits)) return { ok: false, error: 'pin_value_invalid' };
      try { await page.bringToFront().catch(()=>{}); } catch {}
      const before = await readCreatePinState().catch(()=>null);
      pinLog({ event: 'create_pin_round_begin', round, state: before });
      if (!canTypeCreatePinKeyboard(before, detHint)) {
        pinLog({
          event: 'create_pin_refused_unsafe_target',
          round,
          state: before,
          hasCreateTypingSurface: !!(detHint && detHint.hasCreateTypingSurface),
          hasOfficialPinInput: !!(detHint && detHint.hasOfficialPinInput),
          hasPinInput: !!(detHint && detHint.hasPinInput),
          feedCreateCtaOnly: !!(detHint && detHint.feedCreateCtaOnly)
        });
        return { ok: false, error: 'create_pin_unsafe_target', before, refused: true };
      }
      const hasOfficial =
        !!(before && before.hasOfficialPinInput === true) ||
        !!(detHint && detHint.hasOfficialPinInput === true);
      const hasSplit = Number((before && before.splitInputsCount) || 0) >= 4;
      let focusRes = null;
      if (hasOfficial) {
        // Garante foco no input oficial (sem clique). Evita digitar no composer/chat.
        const explicitConfirm = !!(
          round >= 2 &&
          (
            (before && String(before.officialPinAria || '').includes('confirm')) ||
            (detHint && detHint.isPinConfirmation === true)
          )
        );
        focusRes = await focusOfficialCreatePinInput({ preferConfirmation: explicitConfirm });
        if (!(focusRes && focusRes.ok)) {
          pinLog({ event: 'create_pin_refused_no_official_focus', round, focusRes, state: before });
          return { ok: false, error: 'create_pin_unsafe_target', before, refused: true, focusRes };
        }
        const focusedAria = String(focusRes.aria || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        if (
          explicitConfirm &&
          !(focusedAria.includes('pin') && focusedAria.includes('confirm')) &&
          focusRes.confirmationSurface !== true
        ) {
          pinLog({ event: 'create_pin_refused_stale_round1_input', round, focusRes, state: before });
          return { ok: false, error: 'create_pin_confirmation_focus_mismatch', before, refused: true, focusRes };
        }
      } else if (!hasSplit) {
        pinLog({ event: 'create_pin_refused_no_surface', round, state: before });
        return { ok: false, error: 'create_pin_unsafe_target', before, refused: true };
      }
      await sleep(250);
      if (hasOfficial || !hasSplit) {
        for (const ch of digits) {
          try { await page.keyboard.type(String(ch), { delay: perDigitDelayMs }).catch(()=>{}); } catch {}
          await sleep(betweenDigitPauseMs);
        }
      }
      await sleep(settleMs);
      let after = await readCreatePinState().catch(()=>null);
      // Fallback só para layout de 6 slots; o modal atual usa 1 input oficial maxlength=6.
      if (after && after.splitInputsCount >= 4 && after.filledCount === 0 && !after.hasOfficialPinInput) {
        const splitFill = await fillSplitPinInputsWithoutClicks(digits, { round });
        if (splitFill && splitFill.ok) {
          await sleep(700);
          after = await readCreatePinState().catch(()=>after);
        }
      }
      pinLog({ event: 'create_pin_round_done', round, state: after, focusRes });
      return { ok: true, before, after };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'create_pin_keyboard_type_exception' };
    }
  }

  async function waitForCreatePinAdvance({
    timeoutMs = 14_000,
    stableGoneMs = 4_500,
    previousState = null
  } = {}) {
    const t0 = Date.now();
    let absentSince = 0;
    let sawFilled = Number(previousState && previousState.filledCount || 0) >= 4;
    let sawOfficialFilled = Number(previousState && previousState.officialPinValueLen || 0) >= 6;
    let lastDet = null;
    let lastState = previousState || null;

    while ((Date.now() - t0) < timeoutMs) {
      const det = await detectMessengerPinModal(page).catch(()=>({ present:false }));
      const state = await readCreatePinState().catch(()=>null);
      lastDet = det || lastDet;
      lastState = state || lastState;

      // Contrato DOM confirmado: tela 2 usa título "Confirme o PIN..." e
      // aria-label="Confirme seu PIN", inclusive sem role=dialog.
      if (
        (state && state.asksRepeat === true) ||
        (det && det.isPinConfirmation === true)
      ) {
        return {
          ok: true,
          dismissed: false,
          reason: 'confirmation_screen_ready',
          state,
          det
        };
      }

      if (state) {
        // Builds sem texto/aria explícito: após a primeira entrada, o mesmo
        // input (ou os slots) zera para receber a confirmação.
        if (state.hasOfficialPinInput) {
          const n = Number(state.officialPinValueLen || 0) || 0;
          if (n >= 6) sawOfficialFilled = true;
          if (sawOfficialFilled && n === 0) {
            return {
              ok: true,
              dismissed: false,
              reason: 'official_pin_reset_for_repeat',
              state,
              det
            };
          }
        }
        if (state.splitInputsCount >= 4) {
          if (state.filledCount >= 4) sawFilled = true;
          if (sawFilled && state.filledCount === 0) {
            return {
              ok: true,
              dismissed: false,
              reason: 'slots_reset_for_repeat',
              state,
              det
            };
          }
        }
      }

      if (!det || !det.present) {
        if (!absentSince) absentSince = Date.now();
        // Nunca concluir sucesso no primeiro frame sem modal: entre as telas
        // 1 e 2 o React desmonta/remonta o componente por alguns instantes.
        if ((Date.now() - absentSince) >= stableGoneMs) {
          return {
            ok: true,
            dismissed: true,
            reason: 'modal_absent_stable_after_round1',
            state,
            det
          };
        }
      } else {
        absentSince = 0;
      }
      await sleep(300);
    }
    return {
      ok: false,
      dismissed: false,
      reason: 'confirmation_screen_timeout',
      state: lastState,
      det: lastDet
    };
  }

  async function waitForPinModalGone({ timeoutMs = 15_000, stableGoneMs = 1_800 } = {}) {
    const t0 = Date.now();
    let absentSince = 0;
    let lastState = null;
    while ((Date.now() - t0) < timeoutMs) {
      const det = await detectMessengerPinModal(page).catch(()=>({ present:false }));
      lastState = await readCreatePinState().catch(()=>lastState);
      if (det && det.kind === 'restore_sync_notice') {
        const notice = await dismissRestoreSyncNotice();
        pinLog({
          event: 'create_pin_restore_sync_notice_result',
          ok: !!notice.ok,
          dismissed: !!notice.dismissed,
          error: notice.error || null
        });
        if (!notice.ok) {
          return {
            ok: false,
            dismissed: false,
            reason: notice.error || 'restore_sync_notice_ok_failed',
            state: lastState
          };
        }
        absentSince = 0;
        await sleep(250);
        continue;
      }
      if (!det || !det.present) {
        if (!absentSince) absentSince = Date.now();
        if ((Date.now() - absentSince) >= stableGoneMs) {
          return { ok: true, dismissed: true, reason: 'modal_absent_stable' };
        }
      } else {
        absentSince = 0;
      }
      await sleep(350);
    }
    return { ok: false, dismissed: false, reason: 'modal_still_present', state: lastState };
  }

  async function tryCreatePinTwiceNoClicks(pinValue = DEFAULT_PIN, detHint = null) {
    const first = await typePinWithKeyboardOnly(pinValue, { round: 1, detHint });
    if (!first.ok) {
      return {
        ok: false,
        error: first.error || 'create_pin_round1_failed',
        rounds: 0,
        refused: !!first.refused
      };
    }

    const afterFirst = await waitForCreatePinAdvance({
      timeoutMs: 14_000,
      stableGoneMs: 4_500,
      previousState: first.after || null
    });
    pinLog({
      event: 'create_pin_round_transition',
      round: 1,
      ok: !!afterFirst.ok,
      dismissed: !!afterFirst.dismissed,
      reason: afterFirst.reason || null,
      state: afterFirst.state || null,
      isPinConfirmation: !!(afterFirst.det && afterFirst.det.isPinConfirmation)
    });
    if (afterFirst.dismissed) {
      // Regra conservadora: criar PIN só é sucesso após DUAS entradas.
      // Se a confirmação não apareceu, não inventar sucesso de uma etapa.
      return {
        ok: false,
        error: 'create_pin_confirmation_missing_after_round1',
        dismissed: true,
        rounds: 1,
        transitionReason: afterFirst.reason || 'modal_absent_stable_after_round1'
      };
    }
    if (!afterFirst.ok) {
      return {
        ok: false,
        error: 'create_pin_confirmation_not_reached',
        rounds: 1,
        transitionReason: afterFirst.reason || null,
        finalState: afterFirst.state || null
      };
    }

    // 2ª rodada obrigatória no fluxo de duas etapas. Reaquisição explícita:
    // o input da tela 1 foi desmontado e a tela 2 possui outro nó React.
    await sleep(350);
    const afterFirstAria = String(
      (afterFirst.state && afterFirst.state.officialPinAria) ||
      (afterFirst.det && afterFirst.det.officialPinAria) ||
      ''
    ).toLowerCase();
    const explicitConfirmationUi = !!(
      (afterFirst.det && afterFirst.det.isPinConfirmation === true) ||
      (afterFirstAria.includes('pin') && afterFirstAria.includes('confirm'))
    );
    const confirmInput = await waitForOfficialPinInput({
      timeoutMs: 8_000,
      preferConfirmation: explicitConfirmationUi
    });
    const confirmDet =
      (confirmInput && confirmInput.det) ||
      afterFirst.det ||
      await detectMessengerPinModal(page).catch(() => detHint);
    const confirmState = await readCreatePinState().catch(() => afterFirst.state || null);
    const confirmationReady = !!(
      (confirmInput && confirmInput.ok) &&
      (
        (confirmState && confirmState.asksRepeat === true) ||
        (confirmDet && confirmDet.isPinConfirmation === true) ||
        afterFirst.reason === 'official_pin_reset_for_repeat' ||
        afterFirst.reason === 'slots_reset_for_repeat'
      )
    );
    pinLog({
      event: 'create_pin_confirmation_ready',
      ready: confirmationReady,
      transitionReason: afterFirst.reason || null,
      state: confirmState || null,
      detKind: (confirmDet && confirmDet.kind) || null,
      isPinConfirmation: !!(confirmDet && confirmDet.isPinConfirmation)
    });
    if (!confirmationReady) {
      return {
        ok: false,
        error: 'create_pin_confirmation_input_not_ready',
        rounds: 1,
        transitionReason: afterFirst.reason || null,
        finalState: confirmState || null
      };
    }

    const second = await typePinWithKeyboardOnly(pinValue, {
      round: 2,
      detHint: confirmDet || detHint
    });
    if (!second.ok) {
      return {
        ok: false,
        error: second.error || 'create_pin_round2_failed',
        rounds: 1,
        transitionReason: afterFirst.reason || null,
        refused: !!second.refused
      };
    }

    const final = await waitForPinModalGone({ timeoutMs: 15_000, stableGoneMs: 1_800 });
    pinLog({
      event: 'create_pin_final_wait',
      ok: !!final.ok,
      dismissed: !!final.dismissed,
      reason: final.reason || null,
      state: final.state || null
    });
    if (final.ok && final.dismissed) {
      return {
        ok: true,
        dismissed: true,
        rounds: 2,
        transitionReason: afterFirst.reason || final.reason || null
      };
    }
    return {
      ok: false,
      error: 'create_pin_still_present_after_confirmation',
      rounds: 2,
      transitionReason: afterFirst.reason || null,
      finalState: final.state || null
    };
  }

  async function tryConfirmExistingCreatePin(pinValue = DEFAULT_PIN, detHint = null) {
    const state = await readCreatePinState().catch(() => null);
    const isConfirmation = !!(
      (detHint && detHint.isPinConfirmation === true) ||
      (state && state.asksRepeat === true)
    );
    if (!isConfirmation) {
      return {
        ok: false,
        error: 'create_pin_confirmation_not_proven',
        rounds: 1,
        finalState: state || null
      };
    }
    pinLog({
      event: 'create_pin_existing_confirmation_begin',
      state: state || null,
      detKind: (detHint && detHint.kind) || null,
      officialPinAria: (detHint && detHint.officialPinAria) || null
    });
    const second = await typePinWithKeyboardOnly(pinValue, {
      round: 2,
      detHint
    });
    if (!second.ok) {
      return {
        ok: false,
        error: second.error || 'create_pin_existing_confirmation_type_failed',
        rounds: 1,
        refused: !!second.refused,
        finalState: second.after || second.before || state || null
      };
    }
    const final = await waitForPinModalGone({
      timeoutMs: 15_000,
      stableGoneMs: 1_800
    });
    pinLog({
      event: 'create_pin_existing_confirmation_final',
      ok: !!final.ok,
      dismissed: !!final.dismissed,
      reason: final.reason || null,
      state: final.state || null
    });
    if (final.ok && final.dismissed) {
      return {
        ok: true,
        dismissed: true,
        pinEntered: true,
        confirmed: true,
        rounds: 2,
        resumedAtConfirmation: true
      };
    }
    return {
      ok: false,
      error: 'create_pin_still_present_after_existing_confirmation',
      rounds: 2,
      finalState: final.state || null
    };
  }

  async function focusOfficialPinInputAnywhere() {
    try {
      return await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const isVisible = (el) => {
          try {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            const r = el.getBoundingClientRect();
            const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!r || r.width < 2 || r.height < 2) return false;
            if (st && (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')) return false;
            return true;
          } catch { return false; }
        };
        const hasPinSurface = (el) => {
          let n = el;
          const boundary = el && el.closest
            ? el.closest('div[role="dialog"], [aria-modal="true"]')
            : null;
          for (let i = 0; i < 14 && n && n !== document.body && n !== document.documentElement; i++) {
            const t = norm(n.innerText || n.textContent || '');
            if (
              t.includes('insira seu pin') ||
              t.includes('inserir seu pin') ||
              t.includes('enter your pin') ||
              (t.includes('pin') && (t.includes('restaur') || t.includes('conversas')))
            ) return true;
            if (boundary && n === boundary) break;
            n = n.parentElement;
          }
          return false;
        };
        const candidates = Array.from(document.querySelectorAll(
          'input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label="PIN"][maxlength="6"][autocomplete="one-time-code"], input[aria-label="PIN"][maxlength="6"], input[aria-label="Confirme seu PIN"][maxlength="6"], input[aria-label="Confirm your PIN"][maxlength="6"], input[maxlength="6"][autocomplete="one-time-code"], input[maxlength="6"][inputmode="numeric"]'
        ));
        const trusted = (candidate) => {
          if (!candidate || !candidate.isConnected) return false;
          const id = String(candidate.id || '');
          const aria = norm(candidate.getAttribute('aria-label') || '');
          const maxLen = Number(candidate.getAttribute('maxlength') || 0) || 0;
          const ac = norm(candidate.getAttribute('autocomplete') || '');
          const mode = norm(candidate.getAttribute('inputmode') || '');
          if (id === 'mw-numeric-code-input-prevent-composer-focus-steal') return true;
          if (maxLen === 6 && aria.includes('pin')) return true;
          return !!(
            isVisible(candidate) &&
            maxLen === 6 &&
            hasPinSurface(candidate) &&
            (ac.includes('one-time-code') || mode.includes('numeric'))
          );
        };
        const active = document.activeElement;
        const el =
          candidates.find((candidate) => candidate === active && trusted(candidate)) ||
          candidates.find(trusted) ||
          null;
        if (!el) return { ok: false, error: 'official_pin_input_missing' };
        try {
          const proto = el.constructor ? el.constructor.prototype : null;
          const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
          if (desc && typeof desc.set === 'function') desc.set.call(el, '');
          else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch {}
        try { el.focus(); } catch {}
        return {
          ok: !!(document.activeElement && document.activeElement === el),
          id: String(el.id || ''),
          valueLen: String(el.value || '').length
        };
      }).catch(() => ({ ok: false, error: 'focus_eval_failed' }));
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'focus_exception' };
    }
  }

  async function tryEnterPin(pinValue = DEFAULT_PIN, round = 1) {
    // pin_input (restaurar): digitar UMA vez, com calma, só no input oficial.
    // Modal não tem botão Confirmar — completa ao chegar em 6 dígitos.
    try {
      const digits = String(pinValue || '').trim();
      if (!/^\d{6}$/.test(digits)) return { ok: false, error: 'pin_value_invalid' };

      const focusRes = await focusOfficialPinInputAnywhere();
      if (!(focusRes && focusRes.ok)) {
        return { ok: false, error: 'pin_input_not_found', focusRes };
      }
      await sleep(350);

      // Cadência humana: 8 _ 8 _ 2 _ 5 _ 8 _ 4
      for (const ch of digits) {
        try { await page.keyboard.type(String(ch), { delay: 420 }).catch(()=>{}); } catch {}
        await sleep(220);
      }
      await sleep(1400);

      const after = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      const incorrect = !!(after && after.pinIncorrect === true);
      const cleared = !(after && after.present && after.kind === 'pin_input');
      pinLog({
        event: 'pin_enter_round_done',
        round,
        cleared,
        incorrect,
        kindAfter: (after && after.kind) || null,
        focusRes
      });
      return {
        ok: true,
        entered: true,
        cleared,
        incorrect,
        kindAfter: (after && after.kind) || null,
        confirmed: cleared && !incorrect
      };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'pin_enter_exception' };
    }
  }

  async function waitForRestorePinOutcome({
    timeoutMs = 8_000,
    stableGoneMs = 3_500
  } = {}) {
    const t0 = Date.now();
    let absentSince = 0;
    let pinStillSince = 0;
    let lastDet = { present: false };
    while ((Date.now() - t0) < timeoutMs) {
      const det = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      lastDet = det || lastDet;
      if (det && det.present) {
        absentSince = 0;
        // Durante a validação o campo pode continuar montado por alguns
        // segundos sem erro. Não redigitar o PIN enquanto o FB processa.
        if (det.kind === 'pin_input' && det.pinIncorrect !== true) {
          if (!pinStillSince) pinStillSince = Date.now();
          if ((Date.now() - pinStillSince) < 4_500) {
            await sleep(250);
            continue;
          }
        }
        return { det, absentStable: false };
      }
      pinStillSince = 0;
      if (!absentSince) absentSince = Date.now();
      if ((Date.now() - absentSince) >= stableGoneMs) {
        return { det: det || { present: false }, absentStable: true };
      }
      await sleep(250);
    }
    return { det: lastDet, absentStable: !(lastDet && lastDet.present), timedOut: true };
  }

  async function dismissPinInputAfterFailures() {
    // Contrato: Esc e/ou X → "Continuar sem restaurar?" → "Não restaurar mensagens" (habilitado).
    pinLog({ event: 'pin_restore_fallback_begin' });
    try { await page.keyboard.press('Escape').catch(()=>{}); } catch {}
    await sleep(900);
    let det = await detectMessengerPinModal(page).catch(() => ({ present: false }));
    if (det && det.kind === 'pin_input') {
      const closed = await clickCloseTrusted().catch(() => false);
      pinLog({ event: 'pin_restore_fallback_close_x', closed: !!closed });
      await sleep(900);
      det = await detectMessengerPinModal(page).catch(() => ({ present: false }));
    }
    if (det && det.kind === 'continue_without_restore') {
      const clicked = await clickNaoRestaurarTrusted().catch(() => false);
      pinLog({ event: 'pin_restore_fallback_nao_restaurar', clicked: !!clicked });
      await sleep(1200);
      const after = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      if (!after || !after.present) {
        return { ok: true, dismissed: true, via: 'nao_restaurar_mensagens' };
      }
      return { ok: false, dismissed: false, error: 'continue_still_present', via: 'nao_restaurar_mensagens' };
    }
    if (!det || !det.present) {
      return { ok: true, dismissed: true, via: 'esc_or_close' };
    }
    // Última tentativa: se já estamos no continue, clicar de novo; senão Esc + não restaurar.
    try { await page.keyboard.press('Escape').catch(()=>{}); } catch {}
    await sleep(700);
    det = await detectMessengerPinModal(page).catch(() => ({ present: false }));
    if (det && det.kind === 'continue_without_restore') {
      const clicked = await clickNaoRestaurarTrusted().catch(() => false);
      await sleep(1000);
      const after = await detectMessengerPinModal(page).catch(() => ({ present: false }));
      return {
        ok: !!(after && !after.present),
        dismissed: !!(after && !after.present),
        via: 'esc_then_nao_restaurar',
        clicked: !!clicked
      };
    }
    return { ok: false, dismissed: false, error: 'pin_fallback_failed', kind: (det && det.kind) || null };
  }

  let createPinFlowArmed = false;
  for (let attempt = 1; attempt <= Math.max(1, maxTries); attempt++) {
    const det = await detectMessengerPinModal(page);
    if (!det.present) {
      if (createPinFlowArmed) {
        pinLog({ event: 'create_pin_flow_lost', attempt, error: 'pin_surface_missing_after_create_click' });
        return {
          ok: false,
          error: 'create_pin_flow_lost_before_double_confirmation',
          dismissed: false,
          confirmed: false
        };
      }
      return { ok: true, dismissed: false };
    }

    // snapshot mínimo sempre que detecta (ajuda a comparar DOM real vs esperado)
    try {
      pinLog({
        event: 'pin_present',
        attempt,
        kind: det.kind || null,
        hasPinInput: !!det.hasPinInput,
        hasOfficialPinInput: !!det.hasOfficialPinInput,
        hasSplitPinInputs: !!det.hasSplitPinInputs,
        hasCreateTypingSurface: !!det.hasCreateTypingSurface,
        hasNaoRestaurarBtn: !!det.hasNaoRestaurarBtn,
        hasCreateBtn: !!det.hasCreateBtn,
        isPinConfirmation: !!det.isPinConfirmation,
        officialPinAria: det.officialPinAria || null,
        feedCreateCtaOnly: !!det.feedCreateCtaOnly,
        isCreatePinCta: !!det.isCreatePinCta,
        hasRestoreSyncOkBtn: !!det.hasRestoreSyncOkBtn
      });
    } catch {}

    if (det.kind === 'restore_sync_notice') {
      const notice = await dismissRestoreSyncNotice();
      pinLog({
        event: 'restore_sync_notice_result',
        attempt,
        ok: !!notice.ok,
        dismissed: !!notice.dismissed,
        error: notice.error || null
      });
      if (notice.ok) {
        return { ok: true, dismissed: true, via: 'restore_sync_ok' };
      }
      return {
        ok: false,
        error: notice.error || 'restore_sync_notice_ok_failed',
        dismissed: false
      };
    }

    // CREATE_PIN_CTA (intro): clicar "Criar PIN" → espera input → digita 882584×2.
    // Evidência MAE1: modal visível com p:false porque detector exigia input.
    if (det.kind === 'create_pin_cta' || (det.isCreatePinCta === true && !det.hasOfficialPinInput)) {
      try {
        pinLog({ event: 'create_pin_cta_click_begin', attempt });
        const clicked = await clickCreatePinButton().catch(() => false);
        pinLog({ event: 'create_pin_cta_click_result', attempt, clicked: !!clicked });
        if (!clicked) {
          // retry curto com sleep (DOM pode animar)
          await sleep(900);
          const clicked2 = await clickCreatePinButton().catch(() => false);
          pinLog({ event: 'create_pin_cta_click_retry', attempt, clicked: !!clicked2 });
          if (!clicked2) {
            return { ok: false, error: 'create_pin_cta_click_failed', dismissed: false };
          }
        }
        createPinFlowArmed = true;
        await sleep(1100);
        const waited = await waitForOfficialPinInput({ timeoutMs: 12_000 });
        pinLog({
          event: 'create_pin_cta_wait_input',
          attempt,
          ok: !!(waited && waited.ok),
          kindAfter: waited && waited.det ? (waited.det.kind || null) : null,
          hasOfficial: !!(waited && waited.det && waited.det.hasOfficialPinInput)
        });
        if (!(waited && waited.ok)) {
          // Fallback duro: input oficial no DOM mesmo se detect ainda achar CTA.
          let hardInput = null;
          try {
            hardInput = await page.$('input#mw-numeric-code-input-prevent-composer-focus-steal, input[aria-label="PIN"][maxlength="6"], input[aria-label="Confirme seu PIN"][maxlength="6"], input[aria-label="Confirm your PIN"][maxlength="6"], input[maxlength="6"][autocomplete="one-time-code"], input[maxlength="6"][inputmode="numeric"]');
          } catch {}
          if (!hardInput) {
            return { ok: false, error: 'create_pin_cta_no_input_after_click', dismissed: false };
          }
          pinLog({ event: 'create_pin_cta_hard_input_type', attempt });
          const detForce = {
            present: true,
            kind: 'create_pin',
            hasOfficialPinInput: true,
            hasCreateTypingSurface: true,
            createText: true,
            hasCreateBtn: false
          };
          const createRes = await tryCreatePinTwiceNoClicks(DEFAULT_PIN, detForce);
          if (createRes && createRes.ok && Number(createRes.rounds || 0) === 2) {
            pinLog({ event: 'create_pin_cta_hard_type_success', attempt, rounds: createRes.rounds || 0 });
            return { ok: true, dismissed: true, pinEntered: true, confirmed: true, rounds: createRes.rounds || 2, via: 'cta_hard_input' };
          }
          pinLog({ event: 'create_pin_cta_hard_type_failed', attempt, error: (createRes && createRes.error) || null });
          return { ok: false, error: (createRes && createRes.error) || 'create_pin_cta_hard_type_failed', dismissed: false };
        }
        // Continua o loop: agora deve ser create_pin / pin_input com superfície digitável.
        continue;
      } catch (e) {
        pinLog({ event: 'create_pin_cta_exception', attempt, error: (e && e.message) || String(e) });
        return { ok: false, error: 'create_pin_cta_exception', dismissed: false };
      }
    }

    // CREATE_PIN: digitar se a superfície/foco do PIN estiver seguro
    // (campo especial já vem selecionado — 882584, depois de novo 882584).
    if (det.kind === 'create_pin') {
      createPinFlowArmed = true;
      try {
        const preState = await readCreatePinState().catch(() => null);
        // Conta já parada na tela 2 (inclusive após restart/deploy): não
        // reiniciar a criação; apenas concluir a segunda entrada.
        if (det.isPinConfirmation === true || (preState && preState.asksRepeat === true)) {
          const existingConfirmation = await tryConfirmExistingCreatePin(DEFAULT_PIN, det);
          pinLog({
            event: existingConfirmation.ok
              ? 'create_pin_existing_confirmation_success'
              : 'create_pin_existing_confirmation_failed',
            attempt,
            ok: !!existingConfirmation.ok,
            error: existingConfirmation.error || null,
            rounds: existingConfirmation.rounds || 1,
            finalState: existingConfirmation.finalState || null
          });
          if (existingConfirmation.ok) return existingConfirmation;
          return {
            ...existingConfirmation,
            dismissed: false,
            pinEntered: false,
            confirmed: false
          };
        }
        pinLog({
          event: 'create_pin_keyboard_only_begin',
          attempt,
          hasPinInput: !!det.hasPinInput,
          hasSplitPinInputs: !!det.hasSplitPinInputs,
          hasCreateTypingSurface: !!det.hasCreateTypingSurface,
          hasCreateBtn: !!det.hasCreateBtn,
          createText: !!det.createText,
          state: preState
        });
        if (!canTypeCreatePinKeyboard(preState, det)) {
          pinLog({
            event: 'create_pin_refused_unsafe_target',
            attempt,
            state: preState,
            hasCreateTypingSurface: !!det.hasCreateTypingSurface,
            hasCreateBtn: !!det.hasCreateBtn
          });
          return { ok: false, error: 'create_pin_unsafe_target', dismissed: false, pinEntered: false };
        }
        const createRes = await tryCreatePinTwiceNoClicks(DEFAULT_PIN, det);
        if (createRes.ok && Number(createRes.rounds || 0) === 2) {
          pinLog({
            event: 'create_pin_keyboard_only_success',
            attempt,
            rounds: createRes.rounds || 2,
            transitionReason: createRes.transitionReason || null
          });
          return { ok: true, dismissed: true, pinEntered: true, confirmed: true, rounds: createRes.rounds || 2 };
        }
        pinLog({
          event: 'create_pin_keyboard_only_failed',
          attempt,
          error: createRes.error || 'create_pin_still_present',
          rounds: createRes.rounds || 0,
          transitionReason: createRes.transitionReason || null,
          finalState: createRes.finalState || null,
          refused: !!createRes.refused
        });
        if (createRes.refused || createRes.error === 'create_pin_unsafe_target') {
          return { ok: false, error: 'create_pin_unsafe_target', dismissed: false, pinEntered: false };
        }
        return {
          ...createRes,
          ok: false,
          dismissed: false,
          pinEntered: Number(createRes.rounds || 0) > 0,
          confirmed: false
        };
      } catch (e) {
        pinLog({ event: 'create_pin_keyboard_only_exception', attempt, error: (e && e.message) || String(e) });
        return {
          ok: false,
          error: (e && e.message) || 'create_pin_keyboard_only_exception',
          dismissed: false,
          pinEntered: false,
          confirmed: false
        };
      }
    }

    // PIN INPUT (restaurar conversas): digitar UMA vez com calma; até 3 tentativas;
    // se "PIN incorreto" persistir → Esc/X → Não restaurar mensagens.
    if (det.kind === 'pin_input' && det.hasPinInput) {
      const maxPinRounds = 3;
      try {
        for (let round = 1; round <= maxPinRounds; round++) {
          pinLog({
            event: 'pin_enter_attempt',
            attempt,
            round,
            pin: DEFAULT_PIN,
            pinIncorrectBefore: !!det.pinIncorrect,
            hasOfficialPinInput: !!det.hasOfficialPinInput
          });
          const enterResult = await tryEnterPin(DEFAULT_PIN, round);
          if (!enterResult.ok) {
            pinLog({ event: 'pin_enter_failed', attempt, round, error: enterResult.error || null });
            continue;
          }
          pinLog({
            event: 'pin_entered',
            attempt,
            round,
            cleared: !!enterResult.cleared,
            incorrect: !!enterResult.incorrect,
            kindAfter: enterResult.kindAfter || null
          });

          // O PIN some antes de o aviso pós-restauração montar em alguns builds.
          // Só aceitar ausência após uma janela estável para não deixar o OK cobrindo a tela.
          const restoreOutcome = await waitForRestorePinOutcome();
          const detAfter = (restoreOutcome && restoreOutcome.det) || { present: false };
          if (detAfter.kind === 'restore_sync_notice') {
            const notice = await dismissRestoreSyncNotice();
            pinLog({
              event: 'pin_restore_sync_notice_result',
              attempt,
              round,
              ok: !!notice.ok,
              dismissed: !!notice.dismissed,
              error: notice.error || null
            });
            if (notice.ok) {
              return {
                ok: true,
                dismissed: true,
                pinEntered: true,
                via: 'restore_sync_ok',
                rounds: round
              };
            }
            return {
              ok: false,
              error: notice.error || 'restore_sync_notice_ok_failed',
              dismissed: false,
              pinEntered: true,
              rounds: round
            };
          }
          if (!detAfter || !detAfter.present) {
            pinLog({ event: 'pin_success_modal_dismissed', attempt, round });
            return { ok: true, dismissed: true, pinEntered: true, rounds: round };
          }
          if (detAfter.kind === 'continue_without_restore') {
            const clicked = await clickNaoRestaurarTrusted().catch(() => false);
            await sleep(1000);
            const gone = await detectMessengerPinModal(page).catch(() => ({ present: false }));
            pinLog({ event: 'pin_continue_after_enter', attempt, round, clicked: !!clicked, gone: !(gone && gone.present) });
            if (!gone || !gone.present) {
              return { ok: true, dismissed: true, pinEntered: true, via: 'continue_without_restore', rounds: round };
            }
          }
          if (detAfter.kind === 'pin_input') {
            pinLog({
              event: 'pin_still_after_enter',
              attempt,
              round,
              incorrect: !!detAfter.pinIncorrect
            });
            // Próxima tentativa (limpa no focus). Se última, cai no fallback.
            if (round < maxPinRounds) {
              await sleep(700);
              continue;
            }
          }
        }
      } catch (e) {
        pinLog({ event: 'pin_enter_exception', attempt, error: (e && e.message) || String(e) });
      }

      const fallback = await dismissPinInputAfterFailures().catch((e) => ({
        ok: false,
        error: (e && e.message) || 'fallback_exception'
      }));
      pinLog({ event: 'pin_restore_fallback_result', attempt, fallback });
      if (fallback && fallback.ok) {
        return { ok: true, dismissed: true, pinEntered: true, via: fallback.via || 'fallback' };
      }
      return {
        ok: false,
        error: (fallback && fallback.error) || 'pin_still_present',
        dismissed: false,
        pinEntered: true
      };
    }

    let clickedTrusted = false;
    try {
      if (det.kind === 'continue_without_restore') {
        clickedTrusted = await clickNaoRestaurarTrusted();
      } else {
        clickedTrusted = await clickCloseTrusted();
      }
    } catch {}

    let clicked = false;
    try {
      clicked = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        // 1) Se aparecer o diálogo "Continuar sem restaurar?", clique "Não restaurar mensagens"
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        for (const d of dialogs) {
          const dt = norm(d.innerText || d.textContent || '');
          if (dt.includes('continuar sem restaurar') || (dt.includes('nao restaurar') && dt.includes('mensagens'))) {
            const btns = Array.from(d.querySelectorAll('button,[role="button"]'));
            // preferir o botão clicável (tabindex=0, não aria-disabled)
            for (const b of btns) {
              const disabled = (b.getAttribute('aria-disabled') === 'true') || (b.getAttribute('disabled') != null) || (String(b.getAttribute('tabindex')||'') === '-1');
              if (disabled) continue;
              const t = norm(b.innerText || b.textContent || '');
              const al = norm(b.getAttribute('aria-label') || '');
              if (t.includes('nao restaurar mensagens') || al.includes('nao restaurar mensagens')) {
                b.click();
                return true;
              }
            }
            // Se não achou, tenta fechar o dialog
            const close = d.querySelector('[aria-label="Fechar"],[aria-label*="Fechar"],[aria-label*="Close"]');
            if (close && typeof close.click === 'function') { close.click(); return true; }
          }
        }

        // 2) Caso do PIN (input 6 dígitos): tente clicar em "Fechar" (X) no topo (não necessariamente dentro de dialog)
        const pinInput =
          document.querySelector('input[aria-label="PIN"][maxlength="6"]') ||
          document.querySelector('input[aria-label="Confirme seu PIN"][maxlength="6"]') ||
          document.querySelector('input[aria-label="Confirm your PIN"][maxlength="6"]') ||
          document.querySelector('input#mw-numeric-code-input-prevent-composer-focus-steal') ||
          null;
        if (pinInput) {
          const closeAny = document.querySelector('[aria-label="Fechar"],[aria-label*="Fechar"],button[aria-label*="Fechar"],div[role="button"][aria-label*="Fechar"],[aria-label*="Close"]');
          if (closeAny && typeof closeAny.click === 'function') { closeAny.click(); return true; }
        }

        // 3) Fallback genérico: procurar botões "Fechar/X"
        const root = document;

        const candidates = [
          '[aria-label="Fechar"]',
          '[aria-label*="Fechar"]',
          '[aria-label*="Close"]',
          'button[aria-label*="Fechar"]',
          'div[role="button"][aria-label*="Fechar"]',
        ];
        for (const sel of candidates) {
          const el = root.querySelector(sel);
          if (el && typeof el.click === 'function') { el.click(); return true; }
        }

        // fallback: ícone X dentro de um botão (caso Messenger esconda aria-label)
        const buttons = Array.from(root.querySelectorAll('button,[role="button"]'));
        for (const b of buttons) {
          const label = norm(b.getAttribute('aria-label') || '');
          const t = norm(b.innerText || b.textContent || '');
          if (label.includes('fechar') || t === 'x') { b.click(); return true; }
          const i = b.querySelector('i');
          if (i) {
            const st = (i.getAttribute('style') || '').toLowerCase();
            if (st.includes('background-image') && st.includes('.png') && (st.includes('width: 20px') || st.includes('width:20px'))) {
              b.click(); return true;
            }
          }
        }
        return false;
      });
    } catch {}

    // fallback "fora do DOM": ESC geralmente fecha o PIN e abre o confirm "Não restaurar"
    if (!clicked) {
      try { await page.keyboard.press('Escape').catch(()=>{}); } catch {}
      await sleep(250);
    }

    try {
      pinLog({ event:'pin_modal_dismiss_attempt', attempt, kind: det.kind || null, url: (()=>{try{return page.url();}catch{return ''}})(), clickedTrusted: !!clickedTrusted, clickedEval: !!clicked });
      logger.info(`${logPrefix} pin_modal dismiss attempt=${attempt} kind=${det.kind||''} clickedTrusted=${!!clickedTrusted} clickedEval=${!!clicked}`);
    } catch {}
    await sleep(700);

    const det2 = await detectMessengerPinModal(page);
    if (!det2.present) return { ok: true, dismissed: true };
  }
  return { ok: false, error: 'pin_modal_still_present' };
}

function _fbUiHistoryKey(nome, reason) { return `${String(nome||'').trim()}::${String(reason||'').trim()}`; }
const _fbUiHistory = new Map(); // key -> [{...}]
function _histGet(nome, reason) { return _fbUiHistory.get(_fbUiHistoryKey(nome, reason)) || []; }
function _histPush(nome, reason, item) {
  const key = _fbUiHistoryKey(nome, reason);
  const arr = _fbUiHistory.get(key) || [];
  arr.push(item);
  _fbUiHistory.set(key, arr.slice(-12));
}

async function tryApplySelectorHints(page, selectorHints, opts = {}) {
  const hints = Array.isArray(selectorHints) ? selectorHints : [];
  const requireDialog = (opts && typeof opts.requireDialog === 'boolean') ? opts.requireDialog : true;
  for (const selRaw of hints) {
    const sel = String(selRaw || '').trim();
    if (!sel) continue;
    // guardrails básicos (evita seletor “perigoso”)
    if (sel.length > 220) continue;
    if (/script|iframe|object|embed/i.test(sel)) continue;
    try {
      const clicked = await page.evaluate((selector, requireDlg) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        // por padrão, exige dialog/modal para evitar cliques destrutivos fora
        const inDialog = !!(el.closest && el.closest('div[role="dialog"]'));
        if (!inDialog && requireDlg === true) return false;
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || r.width < 2 || r.height < 2) return false;
        // se não for dialog, só aceita clique em elementos "seguros" (consent/continuar/aceitar)
        if (!inDialog) {
          const norm = (s) => {
            try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
            catch { return String(s||'').toLowerCase(); }
          };
          const t = norm(el.innerText || el.value || el.textContent || '');
          const al = norm(el.getAttribute ? (el.getAttribute('aria-label') || '') : '');
          const safeWords = ['continuar','aceitar','concordo','permitir','entendi','ok','confirmar','comecar','começar','iniciar','prosseguir','avancar','avançar','fechar','close'];
          const okTxt = safeWords.some(w => t.includes(w) || al.includes(w));
          const tag = String(el.tagName || '').toLowerCase();
          const role = String(el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
          const isButtonLike = tag === 'button' || tag === 'a' || tag === 'input' || role === 'button';
          if (!isButtonLike || !okTxt) return false;
        }
        if (typeof el.click === 'function') { el.click(); return true; }
        return false;
      }, sel, requireDialog);
      if (clicked) return { ok: true, clickedSelector: sel };
    } catch {}
  }
  return { ok: false, error: 'no_selector_clicked' };
}

async function gptRemediateFbUi(page, nome, { reason, stage } = {}) {
  const url = (() => { try { return page.url(); } catch { return ''; } })();
  const title = await page.title().catch(()=> '');
  const html = await page.content().catch(()=> '');
  const screenshotBase64 = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false, encoding: 'base64' }).catch(()=> '');

  const history = _histGet(nome, reason);
  _histPush(nome, reason, { ts: Date.now(), stage: String(stage||''), url, title, note: 'snapshot' });

  const out = await gptFallback.resolveFbGpt({
    perfil: nome,
    url,
    title,
    html,
    screenshotBase64,
    reason: String(reason || ''),
    source: 'browser.js',
    history
  }).catch(e => ({ ok: false, error: (e && e.message) || String(e) }));

  _histPush(nome, reason, { ts: Date.now(), stage: String(stage||''), gptOk: !!out.ok, fromCache: !!out.fromCache, diagId: out.diagId || null, kind: out?.result?.problemKind || null });

  if (!out || out.ok !== true) return { ok: false, error: out && out.error || 'gpt_failed' };
  const result = out.result || null;
  if (!result) return { ok: false, error: 'gpt_missing_result' };

  // Para consent (full-page), permitimos hints fora de dialog, mas com guardrails (texto/aria + button-like).
  const allowNonDialog = String(reason || '').toLowerCase().includes('consent');
  const applied = await tryApplySelectorHints(page, result.selectorHints, { requireDialog: !allowNonDialog });
  _histPush(nome, reason, { ts: Date.now(), stage: String(stage||''), appliedOk: !!applied.ok, clickedSelector: applied.clickedSelector || null });
  await sleep(800);
  return { ok: true, result, applied };
}

function _normUiText(s) {
  try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
  catch { return String(s || '').toLowerCase(); }
}

async function _detectFbConsentOrBlockingPage(page) {
  try {
    const url = (() => { try { return page.url(); } catch { return ''; } })();
    const title = await page.title().catch(()=> '');
    const u = String(url || '');
    const t = _normUiText(title);
    const isFb = /facebook\.com/i.test(u);
    if (!isFb) return { present: false };
    // LGPD/Consent flow (ex.: /privacy/consent/lgpd_migrated/)
    if (/\/privacy\/consent\//i.test(u) || /lgpd_migrated/i.test(u) || t.includes('consent') || t.includes('privacidade')) {
      return { present: true, kind: 'consent', url: u, title };
    }
    return { present: false };
  } catch {}
  return { present: false };
}

async function _tryDismissFbConsent(page) {
  // Somente ações “não destrutivas” (aceitar/continuar) e sem depender de seletor frágil.
  try {
    const did = await page.evaluate(() => {
      const norm = (s) => {
        try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
        catch { return String(s||'').toLowerCase(); }
      };
      // LGPD/consent costuma ser multi-step: “Começar” -> “Confirmar” -> ...
      const okWords = ['comecar','começar','iniciar','continuar','prosseguir','avancar','avançar','concordo','aceitar','permitir','entendi','ok','confirmar','fechar','close'];
      // 0) Se existir botão/ícone de fechar (X) com aria-label, tente primeiro.
      const closeBtn =
        document.querySelector('[aria-label="Fechar"][role="button"]') ||
        document.querySelector('[aria-label="Fechar"]') ||
        document.querySelector('[aria-label="Close"][role="button"]') ||
        document.querySelector('[aria-label="Close"]');
      if (closeBtn) {
        const r = closeBtn.getBoundingClientRect ? closeBtn.getBoundingClientRect() : null;
        if (r && r.width >= 2 && r.height >= 2) { try { closeBtn.click(); return true; } catch {} }
      }
      const candidates = Array.from(document.querySelectorAll('button, div[role="button"], input[type="submit"], a[role="button"]'))
        .filter(el => {
          const txt = norm(el.innerText || el.value || el.textContent || '');
          if (!txt) return false;
          return okWords.some(w => txt.includes(w));
        })
        .slice(0, 30);
      for (const el of candidates) {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || r.width < 2 || r.height < 2) continue;
        try { el.click(); return true; } catch {}
      }
      return false;
    });
    if (did) {
      await sleep(1200);
      return { ok: true, clicked: true };
    }
  } catch {}
  return { ok: false, error: 'no_consent_button_clicked' };
}

async function _detectGenericBlockingDialog(page) {
  try {
    const v = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return { present: false };
      const txt = (dlg.innerText || dlg.textContent || '').slice(0, 1800);
      const aria = (dlg.getAttribute && (dlg.getAttribute('aria-label') || '')) || '';
      return { present: true, dialogText: txt, ariaLabel: aria };
    });
    if (!v || !v.present) return { present: false };
    return { present: true, kind: 'dialog', dialogText: v.dialogText || '', ariaLabel: v.ariaLabel || '' };
  } catch {}
  return { present: false };
}

async function _tryDismissGenericDialogDeterministic(page) {
  // Fecha/OK/Continuar dentro de dialog (seguro).
  try {
    const did = await page.evaluate(() => {
      const dlg = document.querySelector('div[role="dialog"]');
      if (!dlg) return false;
      const norm = (s) => {
        try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
        catch { return String(s||'').toLowerCase(); }
      };
      const btns = Array.from(dlg.querySelectorAll('button, div[role="button"], a[role="button"], input[type="submit"]')).slice(0, 80);
      const close = btns.find(el => {
        const al = norm(el.getAttribute ? (el.getAttribute('aria-label') || '') : '');
        const t = norm(el.innerText || el.value || el.textContent || '');
        return al.includes('fechar') || al.includes('close') || t === 'x';
      });
      if (close) { try { close.click(); return true; } catch {} }
      const okWords = [
        'continuar','aceitar','ok','entendi','confirmar',
        'comecar','começar','iniciar','prosseguir','avancar','avançar',
        // onboarding/notificações
        'marcar como lido','mark as read',
        'ver tudo','see all',
        'fechar','close'
      ];
      const okBtn = btns.find(el => okWords.some(w => norm(el.innerText || el.value || el.textContent || '').includes(w)));
      if (okBtn) { try { okBtn.click(); return true; } catch {} }
      return false;
    });
    if (did) {
      await sleep(900);
      return { ok: true, dismissed: true };
    }
  } catch {}
  return { ok: false, error: 'no_dialog_button_clicked' };
}

/**
 * “Olhos enterprise”: garante que a página não está presa em consent/popup/novidades.
 * - Determinístico primeiro.
 * - Se não resolver e allowGpt=true, chama GPT (selectorHints) para fechar modal.
 */
async function ensureFbUiUnblocked(page, nome, { reasonBase = 'fb_ui_unblock', allowGpt = true, maxRounds = 3 } = {}) {
  const rounds = Math.max(1, Math.min(5, Number(maxRounds) || 3));
  for (let i = 1; i <= rounds; i++) {
    // 0) Caso especial: Messenger PIN modal (não é “popup genérico” — a solução é determinística)
    try {
      const pin = await detectMessengerPinModal(page).catch(()=>({ present:false }));
      if (pin && pin.present) {
        const r = await tryDismissMessengerPinModal(page, { logPrefix: `[UNBLOCK][PIN]`, maxTries: 2 }).catch(()=>null);
        // após tentar, re-rodar loop (ou sair se já desbloqueou)
        const pin2 = await detectMessengerPinModal(page).catch(()=>({ present:false }));
        if (!pin2 || !pin2.present) return { ok: true, blocked: false, round: i, pinDismissed: true, pinResult: r || null };
        // se ainda está presente, deixa cair para GPT/flow genérico como fallback
      }
    } catch {}

    const consent = await _detectFbConsentOrBlockingPage(page);
    if (consent && consent.present && consent.kind === 'consent') {
      const det = await _tryDismissFbConsent(page);
      if (det && det.ok) continue;
      // Consent às vezes é “full page” sem dialog; se falhar, chama GPT para diagnóstico/evidência.
      if (allowGpt && nome) {
        await gptRemediateFbUi(page, nome, { reason: `${reasonBase}_consent`, stage: `round_${i}` }).catch(()=>null);
        await sleep(900);
        // Se o GPT clicou e saiu do consent (ex.: foi para checkpoint/captcha), NÃO marque como blocked: reavalia.
        const consentAfter = await _detectFbConsentOrBlockingPage(page).catch(()=>({ present:false }));
        if (!consentAfter || !consentAfter.present) continue;
        const det2 = await _tryDismissFbConsent(page);
        if (det2 && det2.ok) continue;
      }
      return { ok: false, blocked: true, kind: 'consent', round: i };
    }

    const dlg = await _detectGenericBlockingDialog(page);
    if (dlg && dlg.present) {
      const det = await _tryDismissGenericDialogDeterministic(page);
      if (det && det.ok) continue;
      if (allowGpt && nome) {
        await gptRemediateFbUi(page, nome, { reason: `${reasonBase}_dialog`, stage: `round_${i}` }).catch(()=>null);
        await sleep(900);
        const det2 = await _tryDismissGenericDialogDeterministic(page);
        if (det2 && det2.ok) continue;
      }
      return { ok: false, blocked: true, kind: 'dialog', round: i, dialogPreview: String(dlg.dialogText || '').slice(0, 220) };
    }

    // Sem sinal de bloqueio.
    return { ok: true, blocked: false, round: i };
  }
  return { ok: false, blocked: true, kind: 'unknown', round: rounds };
}

// ===============
// configureProfile USA A LEITURA correta do manifest
// ===============
async function configureProfile(browser, nome, cookiesOverride = null) {
  const dbg = process.env.CONFIGURE_DEBUG === '1';
  if (dbg) logger.debug('[CONFIG] configureProfile (2-tabs) begin', { nome });

  // Cadastro (contrato 2026-08-08): SOMENTE 2 abas — sem redundância messages×2.
  // 0) facebook.com/messages (Virtus) — cookies + PIN + validação
  // 1) marketplace/create/(item|vehicle) (Robe) — validação; depois worker fecha e deixa só aba 0
  let pages = [];
  try { pages = await browser.pages().catch(()=>[]); } catch { pages = []; }
  if (!pages || !pages.length) {
    pages = [await newPageDaConta(browser, nome, { source: 'configure_missing_p0' })];
  }
  if (!pages || !pages[0]) throw new Error('configureProfile_no_page0');

  const p0 = pages[0];
  await bringWindowToFront(p0);

  // Fechar extras pré-existentes (para não herdar lixo de tentativas anteriores)
  try {
    for (const pg of (pages || []).slice(1)) {
      try { await pg.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
    }
  } catch {}

    // Ler manifest (fonte de verdade) + definição de coords por política do gateway.
  let manifest = null;
  let coords = null;
  let robeMode = 'itens';
  try {
    manifest = await manifestStore.read(nome).catch(()=>null);
    if (manifest && manifest.robeMode) robeMode = String(manifest.robeMode);
  } catch {}
  try {
    // Sem fallback para cidade da conta quando gateway estrito está ON.
    coords = resolvePatchCoordsForProfile(nome, manifest || {});
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e || '');
    if (/gateway_geo_required:/i.test(msg)) throw e;
    // Fora do modo estrito, mantém robustez sem travar o fluxo.
    try {
      const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
      const perfil = perfisArr.find(p => p && p.nome === nome);
      const city = (manifest && manifest.cidade) ? String(manifest.cidade) : String((perfil && perfil.cidade) || '');
      coords = utils.getCoords(city || '');
    } catch {}
  }

  const cookies = Array.isArray(cookiesOverride) && cookiesOverride.length
    ? cookiesOverride
    : (manifest && Array.isArray(manifest.cookies) ? manifest.cookies : []);
  if (!Array.isArray(cookies) || !cookies.length) {
    if (dbg) logger.debug('[CONFIG] missing cookies', { nome });
    return; // caller (worker) vai detectar missing_cookies e tratar
  }

  const createUrl = (String(robeMode || '').toLowerCase() === 'veiculos')
    ? 'https://www.facebook.com/marketplace/create/vehicle'
    : 'https://www.facebook.com/marketplace/create/item';
  // Cadastro: aba 0 sempre messages (Virtus). Delta/legado: mesma URL canônica.
  const fb0Url = 'https://www.facebook.com/messages';

  // Aba 0 — Messages (Virtus)
  try {
    await blindarPaginaDaConta(p0, nome, { source: 'configure_p0' });
  } catch (e) {
    if (dbg) logger.debug('[CONFIG] blindar p0 fail', { nome, error: (e && e.message) || String(e) });
    throw e;
  }
  await injectCookies(p0, cookies);
  try { await p0.goto(fb0Url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
  try { await sleep(900); } catch {}
  // Fail-fast ANTES do GPT unblock: se já é captcha/checkpoint/login, não gasta rounds.
  try {
    const lr0 = await detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
    const url0 = (p0 && typeof p0.url === 'function') ? String(p0.url() || '') : '';
    const rr0 = String((lr0 && lr0.reason) || '').toLowerCase();
    if (dbg) logger.debug('[CONFIG] fb0 lr', { nome, lr: lr0 || null, url: url0 });
    const hardBlock =
      (lr0 && lr0.loginRequired === true) ||
      /\/checkpoint\//i.test(url0) ||
      /captcha/i.test(url0);
    if (hardBlock) {
      if (dbg) logger.debug('[CONFIG] fb0 hard_block early_return', { nome, reason: rr0 || 'url_checkpoint', url: url0.slice(0, 220) });
      return;
    }
  } catch {}
  try {
    const ui0 = await ensureFbUiUnblocked(p0, nome, { reasonBase: 'configure_fb0', allowGpt: true, maxRounds: 2 }).catch(()=>null);
    if (dbg) logger.debug('[CONFIG] fb0 ui', { nome, ui: ui0 || null });
  } catch {}
  // Re-checa após UI unblock (consent/cookie banner pode ter mascarado).
  try {
    const lr0b = await detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
    const url0b = (p0 && typeof p0.url === 'function') ? String(p0.url() || '') : '';
    if ((lr0b && lr0b.loginRequired === true) || /\/checkpoint\//i.test(url0b) || /captcha/i.test(url0b)) {
      if (dbg) logger.debug('[CONFIG] fb0 hard_block after_ui', { nome, reason: String((lr0b && lr0b.reason) || 'url_checkpoint'), url: url0b.slice(0, 220) });
      return;
    }
  } catch {}

  // PIN na aba 0 (messages) — clicar Criar PIN se CTA intro + digitar 882584x2.
  // Contrato: PIN NUNCA aborta cadastro nem invoca humano. Nurse retenta se sobrar.
  try {
    await resolveNonceIfPresent(p0, { logPrefix: '[CONFIG][Messages][nonce]' });
    await clickContinuarComo(p0, { logPrefix: '[CONFIG][Messages][continuar]' }).catch(() => false);
    const pin1 = await tryDismissMessengerPinModal(p0, { logPrefix: '[CONFIG][Messages][pin]', maxTries: 6 });
    if (!(pin1 && pin1.ok)) {
      await sleep(1200);
      await tryDismissMessengerPinModal(p0, { logPrefix: '[CONFIG][Messages][pin-retry]', maxTries: 4 }).catch(() => null);
    }
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    if (dbg) logger.debug('[CONFIG] pin path soft-fail', { nome, error: msg });
  }

  // Aba 1 — Create (Robe) — só se aba 0 passou login/captcha/PIN
  let p1 = null;
  try {
    p1 = await newPageDaConta(browser, nome, { source: 'configure_p1' });
    await injectCookies(p1, cookies);
    await p1.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await sleep(1200);
    const ui1 = await ensureFbUiUnblocked(p1, nome, { reasonBase: 'configure_create', allowGpt: true, maxRounds: 2 }).catch(()=>null);
    if (dbg) logger.debug('[CONFIG] create ui', { nome, createUrl, ui: ui1 || null });
    // Marketplace desativado no create → sinaliza worker (fecha aba 1 + humano).
    const mkt = await detectMarketplaceDisabled(p1).catch(() => ({ disabled: false }));
    if (mkt && mkt.disabled === true) {
      const sn = String(mkt.snippet || '').slice(0, 180);
      throw new Error(`marketplace_disabled:${String(mkt.reason || 'cannot_buy_or_sell')}:${sn}`);
    }
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    if (/marketplace_disabled/i.test(msg)) throw e;
    if (dbg) logger.debug('[CONFIG] create tab fail', { nome, error: msg });
  }

  if (dbg) {
    try {
      const ps = await browser.pages().catch(()=>[]);
      const urls = [];
      for (const pg of (ps || []).slice(0, 5)) { try { urls.push(String(pg.url() || '')); } catch { urls.push(''); } }
      logger.debug('[CONFIG] configureProfile (2-tabs) end', { nome, tabs: (ps || []).length, urls, robeMode, createUrl });
    } catch {}
  }
}

// ===============
// invocarHumano USA A LEITURA correta do manifest se precisar
// Desabilitado por padrão: abrir interface/painel automático só pode via opt-in, frontend ou chamada manual/intencional.
async function invocarHumano(browser, nome, opts = {}) {
  const withTimeout = (p, ms) => {
    let t;
    const to = new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('invocarHumano_timeout')), Math.max(500, Number(ms) || 5000));
    });
    return Promise.race([Promise.resolve(p).finally(() => clearTimeout(t)), to]);
  };
  try {
    const pages = await withTimeout(browser.pages(), 8000).catch(() => []);
    const page = pages && pages[0];
    if (!page) return { ok: false, skippedNav: true, reason: 'no_page' };
    // CDP/bringToFront pode pendurar em página cativa — nunca bloquear invoke eterno.
    try { await withTimeout(bringWindowToFront(page), 5000); } catch {}
    // Enterprise: login/checkpoint/appeal/recover/captcha → NÃO navegar (humano vê a tela atual).
    let u0 = '';
    try { u0 = (typeof page.url === 'function') ? (page.url() || '') : ''; } catch {}
    const u = String(u0 || '').toLowerCase();
    let title = '';
    try {
      title = String(await withTimeout(page.title(), 3000).catch(() => '') || '').toLowerCase();
    } catch {}
    const skipNav = opts && opts.skipNavigation === true;
    const isProblemUrl =
      skipNav ||
      u.includes('/login') ||
      u.includes('/checkpoint') ||
      u.includes('/recover') ||
      u.includes('/help/contact') ||
      u.includes('/appeal') ||
      u.includes('captcha') ||
      /persona|checkpoint|security.?check|confirm.?identity/i.test(title);

    if (!isProblemUrl) {
      const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
      try {
        await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        try { await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
      }
      try { await withTimeout(bringWindowToFront(page), 5000); } catch {}
      return { ok: true, skippedNav: false };
    }
    return { ok: true, skippedNav: true, reason: skipNav ? 'flag_skip' : 'problem_url' };
  } catch (e) {
    try { if (process.env.BROWSER_DEBUG === '1') { logger.warn('[BROWSER][invocarHumano] erro: ' + ((e && e.message) || e)); } } catch {}
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) };
  }
}

/**
 * Observadores de página para sinais de vida (health monitor).
 * Para ser chamado no worker, via wirePageObservers!
 * (Só inclui; worker faz uso.)
 */
async function attachHealthProbes(page, nome, onPing) {
  try {
    await page.exposeFunction('__healthReport', (payload) => {
      try { onPing && onPing({ nome, ts: Date.now(), ...payload }); } catch {}
    });
  } catch {}
  try {
    await page.evaluateOnNewDocument(() => {
      (function(){
        const safeCall = (ev) => { try { window.__healthReport && window.__healthReport(ev); } catch {} };
        // Timer
        setInterval(() => safeCall({ type:'timer', href: location.href, vis: document.visibilityState }), 10000);
        // DOM observer
        try {
          const obs = new MutationObserver(() => { safeCall({ type:'dom', href: location.href }); });
          obs.observe(document.documentElement, { childList:true, subtree:true, attributes:false });
        } catch {}
        // Input/visibilidade
        ['visibilitychange','focus','blur','mousemove','keydown','wheel','touchstart'].forEach(evt => {
          window.addEventListener(evt, () => safeCall({ type: 'evt:'+evt }), { passive:true, capture:false });
        });
        // Erros JS
        window.addEventListener('error', (e) => safeCall({ type:'js_error', msg: (e && e.message) || '' }));
        window.addEventListener('unhandledrejection', (e) => safeCall({ type:'js_unhandledrejection', msg: (e) && ((e.reason && e.reason.message) || e.reason) || '' }));
      })();
    });
  } catch {}
}

/**
 * Limpeza HARD de caches e magreza de perfil preservando cookies/login.
 * - Localiza userDataDir a partir do perfis.json/manifest do perfil.
 * - Encerra quaisquer processos do Chrome que estejam usando esse userDataDir.
 * - Remove diretórios pesados (Cache/Code Cache/GPUCache/Service Worker caches/Shader/Dawn/Media).
 * - NÃO remove Cookies/Local Storage nem o próprio userDataDir.
 * - Retorna { ok: true, removed: N }.
 */
async function hardCleanProfileOnDisk(nome, opts = { keepCookies: true }) {
  try {
    // 1) Resolver userDataDir via perfis.json
    let userDataDir = null;
    try {
      const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
      const perfil = Array.isArray(perfisArr) ? perfisArr.find(p => p && p.nome === nome) : null;
      if (perfil && perfil.userDataDir) userDataDir = String(perfil.userDataDir);
    } catch {}

    // Fallback: usar caminho padrão sob Chrome/User Data/Conveniente/NOME (mesma lógica do ensureUserDataDirUnderChrome)
    if (!userDataDir) {
      try {
        const chromeRoot = (process.platform === 'win32')
          ? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'))
          : path.join(os.homedir(), '.config', 'google-chrome');
        const guess = path.join(chromeRoot, 'Conveniente', String(nome));
        if (fs.existsSync(guess)) userDataDir = guess;
      } catch {}
    }

    if (!userDataDir || !fs.existsSync(userDataDir)) {
      // Nada a fazer
      return { ok: true, removed: 0 };
    }

    // 2) Encerrar processos do Chrome que usem esse userDataDir
    try { killChromeProfileProcesses(userDataDir); } catch {}
    if (process.platform !== 'win32') {
      try {
        const { execSync } = require('child_process');
        // Tenta pkill por path
        try { execSync(`pkill -f "${userDataDir.replace(/"/g, '\\"')}"`, { stdio: 'ignore' }); } catch {}
        // Fallback parse de ps
        try {
          let out = '';
          try { out = execSync('ps -axo pid=,command=', { encoding: 'utf8' }); } catch {}
          if (!out) { try { out = execSync('ps -eo pid=,args=', { encoding: 'utf8' }); } catch {} }
          const lines = (out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          const ud1 = path.normalize(userDataDir).replace(/\\/g, '/');
          const ud2 = path.normalize(userDataDir);
          for (const line of lines) {
            const m = line.match(/^(\d+)\s+(.*)$/);
            if (!m) continue;
            const pid = parseInt(m[1], 10);
            const cmd = m[2] || '';
            if (!/chrome|Chromium|Google Chrome/i.test(cmd)) continue;
            if (cmd.includes(userDataDir) || cmd.includes(ud1) || cmd.includes(ud2)) {
              try { process.kill(pid, 'SIGKILL'); } catch {}
            }
          }
        } catch {}
      } catch {}
    }
    try { await new Promise(r => setTimeout(r, 350)); } catch {}

    // Remove locks residuais
    try { cleanupUserDataLocks(userDataDir); } catch {}

    // 3) Remover diretórios pesados
    const targets = [
      path.join(userDataDir, 'Default', 'Cache'),
      path.join(userDataDir, 'Default', 'Code Cache'),
      path.join(userDataDir, 'Default', 'GPUCache'),
      path.join(userDataDir, 'Default', 'Service Worker', 'CacheStorage'),
      path.join(userDataDir, 'Default', 'Service Worker', 'ScriptCache'),
      path.join(userDataDir, 'Default', 'GrShaderCache'),
      path.join(userDataDir, 'Default', 'ShaderCache'),
      path.join(userDataDir, 'Default', 'DawnCache'),
      path.join(userDataDir, 'Default', 'Media Cache'),
      path.join(userDataDir, 'ShaderCache'),
    ];

    const protectedPaths = [
      path.join(userDataDir, 'Default', 'Cookies'),
      path.join(userDataDir, 'Default', 'Local Storage'),
    ];

    let removed = 0;
    for (const p of targets) {
      try {
        if (!fs.existsExists) {} // placeholder
      } catch {}
    }

    // Ajuste: checagem correta de existência e remoção
    removed = 0;
    for (const p of targets) {
      try {
        if (!fs.existsSync(p)) continue;
        // Proteção adicional contra alvos críticos
        const pNorm = path.normalize(p);
        let isProtected = false;
        for (const prot of protectedPaths) {
          const protNorm = path.normalize(prot);
          if (pNorm === protNorm) { isProtected = true; break; }
        }
        if (isProtected) continue;

        // rm -rf
        try {
          if (fs.rmSync) fs.rmSync(p, { recursive: true, force: true });
          else fs.rmdirSync(p, { recursive: true }); // fallback
          removed++;
        } catch (e) {
          logger.warn('[BROWSER][hardClean] falha ao remover ' + p + ' ' + ((e && e.message) ? e.message : e));
        }
      } catch (e) {
        logger.warn('[BROWSER][hardClean] erro ao acessar ' + p + ' ' + ((e && e.message) ? e.message : e));
      }
    }

    return { ok: true, removed };
  } catch (e) {
    try { logger.warn('[BROWSER][hardClean] erro inesperado: ' + ((e && e.message) ? e.message : e)); } catch {}
    return { ok: true, removed: 0 };
  }
}

// PATCH DETECÇÃO DE BLOQUEIO TEMPORÁRIO — ROBUSTA, TODOS OS GÊNEROS/IDIOMAS/VARIAÇÕES
async function detectMessengerTempBlock(page) {
  try {
    const v = await page.evaluate(() => {
      try {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const href = String((window && window.location && window.location.href) || '');

        const isMessengerCtx = /(^https?:\/\/)?(www\.)?messenger\.com/i.test(href);
        const isFacebookCtx  = /(^https?:\/\/)?(www\.)?facebook\.com/i.test(href);
        const isCreateOrSellerRoute = /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(href);

        const isVisible = (el) => {
          try {
            const st = window.getComputedStyle(el);
            if (!st) return false;
            if (st.visibility === 'hidden' || st.display === 'none') return false;
            if (el.offsetParent === null) return false;
            const r = el.getBoundingClientRect();
            return r && r.width > 0 && r.height > 0;
          } catch { return false; }
        };

        const nodes = Array.from(document.querySelectorAll('h1,h2,span,div,section,p,button,a')).filter(isVisible).slice(0, 1200);
        const texts = nodes.map(el => norm(el.innerText || el.textContent || '')).filter(Boolean);
        const headlines = Array.from(document.querySelectorAll('h1,h2')).map(el => norm(el.innerText || el.textContent || ''));

        function textHitsLimit(t) {
          if (!t) return false;
          if (/limite\s+atingido/.test(t) || /limit\s+reached/.test(t) || /limite\s+alcanzado/.test(t)) return true;
          if (/you\s+can(?:'|’)?t\s+(post|create|list).*right\s+now/.test(t)) return true;
          if (/you(?:'|’)?re\s+temporar(?:ily)?\s+(blocked|restricted).*(post|create|list)/.test(t)) return true;
          if (/voce\s+n(?:a|ã)o\s+pode.*(publicar|criar).*(classificados|an[úu]ncios|listagens?|itens?)/.test(t)) return true;
          if (/no\s+puedes\s+(publicar|crear).*(anuncios?|articulos?|publicaciones?)/.test(t)) return true;
          if (/(temporar(?:y|io)|temporariamente|temporalmente)\s+(limit|limite)/.test(t) &&
              /(items?|listings?|classificados|anuncios?)/.test(t)) return true;
          // [PATCH-GPT5] variantes adicionais (PT/ES) — “não é possível / no es posible ... no momento/agora”
          if (/nao\s+e\s+possivel\s+(criar|publicar).*(classificados|an[úu]ncios|listagens?|itens?)/.test(t)) return true;
          if (/no\s+es\s+posible\s+(crear|publicar).*(anuncios?|art[ií]culos?|listados?|publicaciones?).*(en\s+este\s+momento|ahora)/.test(t)) return true;
          return false;
        }

        const headerHit = headlines.some(textHitsLimit);
        const bodyHit = texts.some(textHitsLimit);

        let hasReloadBtn = !!document.querySelector(
          '[aria-label*="recarregar"],[aria-label*="reload"],[aria-label*="recargar"],[aria-label*="atualizar"],[aria-label*="actualizar"],[aria-label*="tentar novamente"],[aria-label*="try again"]'
        );

        const blockedMessenger = isMessengerCtx && (headerHit || bodyHit);
        const blockedFacebookCreate = isFacebookCtx && isCreateOrSellerRoute && (headerHit || bodyHit);

        return {
          blockedMessenger,
          blockedFacebookCreate,
          isMessengerCtx, isFacebookCtx, isCreateOrSellerRoute,
          hasReloadBtn,
          strongEvidenceCount: (headerHit ? 1 : 0) + (bodyHit ? 1 : 0)
        };
      } catch (e) {
        return {
          blockedMessenger: false,
          blockedFacebookCreate: false,
          isMessengerCtx: false, isFacebookCtx: false, isCreateOrSellerRoute: false,
          hasReloadBtn: false,
          strongEvidenceCount: 0
        };
      }
    });

    let blocked = false;
    let domain = null;
    if (v.blockedMessenger) { blocked = true; domain = 'messenger'; }
    else if (v.blockedFacebookCreate) { blocked = true; domain = 'facebook'; }

    // Se não bloqueou e é FB/Messenger, tenta fallback deep
    if (!blocked && (v.isFacebookCtx || v.isMessengerCtx)) {
      try {
        const deep = await detectLimitOverlayDeep(page, { alsoCheckFrames: true });
        if (deep && deep.blocked) {
          blocked = true;
          domain = v.isMessengerCtx ? 'messenger' : 'facebook';
        }
      } catch {}
    }

    return {
      blocked,
      domain,
      hasReloadBtn: v.hasReloadBtn,
      strongEvidenceCount: v.strongEvidenceCount,
      joinedTexts: '' // opcional
    };
  } catch {
    return {
      blocked: false,
      domain: null,
      hasReloadBtn: false,
      strongEvidenceCount: 0,
      joinedTexts: ''
    };
  }
}

/**
 * Dismiss automático do overlay "Suspeitamos que o comportamento da sua conta seja automatizado"
 * Tenta encontrar o overlay e clicar no botão "Ignorar" (PT/EN, normalizado, aria-label ou innerText).
 * Debounce por perfil/controlado externamente.
 */
async function dismissAutomationSuspect(page, nome) {
  try {
    // Evita erro em ausência de page/context
    if (!page) return false;

    const found = await page.evaluate(() => {
      function norm(s) {
        try {
          return (s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g,'')
            .toLowerCase();
        } catch { return (s || '').toLowerCase(); }
      }
      // 1. Localiza textos desejados
      const allTexts = Array.from(document.querySelectorAll('h1,h2,span,div'))
        .slice(0, 2000)
        .map(el => norm(el.innerText || el.textContent || ''));
      const hasSuspect = allTexts.some(t =>
        t.includes('suspeitamos que o comportamento da sua conta seja automatizado') ||
        t.includes('suspeitamos que o comportamento da sua conta seja automatizado') ||
        t.includes('we suspect') && t.includes('automated') ||
        t.includes('suspeitamos do seu comportamento') ||
        t.includes('comportamento automatizado')
      );
      if (!hasSuspect) return false;

      // 2. Procura botão "Ignorar"
      let btn = Array.from(document.querySelectorAll('[role="button"]'))
        .find(el =>
          norm(el.getAttribute('aria-label')||'').includes('gnorar') ||
          norm(el.innerText||el.textContent||'').includes('gnorar') ||
          norm(el.innerText||el.textContent||'').includes('ignore')
        );
      if (!btn) return false;
      try { btn.scrollIntoView({behavior:'instant',block:'center'}); } catch{}
      try { btn.dispatchEvent(new MouseEvent('mousemove',{bubbles:true})); } catch{}
      try { btn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); } catch{}
      try { btn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); } catch{}
      try { btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); } catch{}
      return true;
    });
    if (found) {
      try { require('./issues.js').append && require('./issues.js').append(nome,'mil_action','dismiss_automation_suspect_clicked'); } catch{}
      return true;
    }
  } catch(e) {
    // Logging, mas silencioso por padrão
    try { require('./issues.js').append && require('./issues.js').append(nome,'mil_action','dismiss_automation_suspect_ERROR '+(e&&e.message)); } catch{}
  }
  return false;
}

// [ADD/UPDATE] Deep pattern — multilíngue (PT/EN/ES) para bloqueio/limite de criação/posta/lista
function textHitsLimitNormalized(t) {
  if (!t) return false;
  t = String(t).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

  if (/voce\s+nao\s+pode\s+(criar|publicar).*(classificados|anuncios|listagens?|itens?).*(no\s+momento|agora)/.test(t)) return true;
  if (/(ha|h[áa])\s+um\s+limite\s+tempor/.test(t) && /(itens?|vender|publicar|marketplace)/.test(t)) return true;
  if (/limite\s+atingido/.test(t)) return true;
  if (/voce\s+esta\s+bloqueado\s+temporariamente/.test(t)) return true;

  if (/you\s+can(?:'|’)?t\s+(post|create|list).*right\s+now/.test(t)) return true;
  if (/(there(?:'|’)?s|there\s+is)\s+a\s+temporar(?:y)?\s+limit/.test(t) && /(how\s+many\s+items\s+you\s+(can|may)\s+(list|sell)|marketplace)/.test(t)) return true;
  if (/you(?:'|’)?re\s+temporar(?:ily)?\s+(blocked|restricted).*(post|create|list)/.test(t)) return true;

  if (/no\s+es\s+posible\s+(crear|publicar).*(anuncios?|art[ií]culos?|listados?|publicaciones?).*(en\s+este\s+momento|ahora)/.test(t)) return true;
  if (/limite\s+alcanzado/.test(t)) return true;
  if (/(hay|existe)\s+un\s+limite\s+tempor/.test(t) && /(art[ií]culos?|publicar|vender|marketplace)/.test(t)) return true;

  return false;
}

function deepScanLimitOverlayInDocument() {
  function norm(s) { try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); } catch { return (s||'').toLowerCase(); } }
  function getAllRoots(doc) {
    const roots = [doc];
    try {
      const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.currentNode; n; n = walker.nextNode()) {
        if (n.shadowRoot) roots.push(n.shadowRoot);
      }
    } catch {}
    try {
      const extras = doc.querySelectorAll('#facebook, #mount_0_0, [id^="mount_"], [id^="portal"], [role="dialog"]');
      extras.forEach(el => { if (el && el.shadowRoot) roots.push(el.shadowRoot); });
    } catch {}
    return roots;
  }
  function textsOf(el, doc) {
    const out = [];
    try { out.push(el.innerText || ''); } catch {}
    try { out.push(el.textContent || ''); } catch {}
    try { out.push(el.getAttribute && el.getAttribute('aria-label') || ''); } catch {}
    try {
      const lb = el.getAttribute && el.getAttribute('aria-labelledby');
      if (lb && doc) {
        const ids = lb.split(/\s+/).filter(Boolean);
        ids.forEach(id => {
          const lab = doc.getElementById(id);
          if (lab) out.push(lab.innerText || lab.textContent || '');
        });
      }
    } catch {}
    try { out.push(el.getAttribute && el.getAttribute('title') || ''); } catch {}
    return out.filter(Boolean);
  }
  function scanRoot(R) {
    const doc = R.ownerDocument || (R.defaultView && R.defaultView.document) || document;

    const dialogs = Array.from((R.querySelectorAll ? R.querySelectorAll('[role="dialog"],[aria-modal="true"]') : []));
    for (const d of dialogs) {
      const tt = textsOf(d, doc);
      if (tt.some(txt => textHitsLimitNormalized(norm(txt)))) {
        const snippet = (tt.find(txt => textHitsLimitNormalized(norm(txt))) || '').slice(0,200);
        // LOGS DEBUG FORTE — após encontrar dialog
        if (typeof window !== "undefined") {
          try {
            const hits = 2;
            const where = 'dialog';
            const el = d;
            const debugPayload = {
              step: 'deepScan_limit_overlay_debug',
              found: hits > 0,
              where: where,
              snippet,
              tags: el ? (
                {
                  id: el.id || '',
                  class: el.className || '',
                  ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : '',
                  ariaLabelled: el.getAttribute ? el.getAttribute('aria-labelledby') : '',
                  title: el.getAttribute ? el.getAttribute('title') : '',
                }
              ) : {},
              strongEvidenceCount: hits,
            };
            if (window.__robeSetLimitOverlay) {
              window.__robeSetLimitOverlay(debugPayload);
            }
            if (typeof console !== "undefined") {
              console.log('DEBUG_robo_deepScanLimitOverlayInDocument', debugPayload);
            }
          } catch {}
        }
        return { found:true, where:'dialog', snippet, strongEvidenceCount: 2 };
      }
    }

    const heads = Array.from((R.querySelectorAll ? R.querySelectorAll('h1,h2') : []));
    for (const h of heads) {
      const ht = norm(h.innerText || h.textContent || '');
      if (textHitsLimitNormalized(ht)) {
        const snippet = (h.innerText||h.textContent||'').slice(0,200);
        // LOGS DEBUG FORTE — após encontrar headline
        if (typeof window !== "undefined") {
          try {
            const hits = 1;
            const where = 'headline';
            const el = h;
            const debugPayload = {
              step: 'deepScan_limit_overlay_debug',
              found: hits > 0,
              where: where,
              snippet,
              tags: el ? (
                {
                  id: el.id || '',
                  class: el.className || '',
                  ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : '',
                  ariaLabelled: el.getAttribute ? el.getAttribute('aria-labelledby') : '',
                  title: el.getAttribute ? el.getAttribute('title') : '',
                }
              ) : {},
              strongEvidenceCount: hits,
            };
            if (window.__robeSetLimitOverlay) {
              window.__robeSetLimitOverlay(debugPayload);
            }
            if (typeof console !== "undefined") {
              console.log('DEBUG_robo_deepScanLimitOverlayInDocument', debugPayload);
            }
          } catch {}
        }
        return { found:true, where:'headline', snippet: snippet, strongEvidenceCount: 1 };
      }
    }

    const nodes = Array.from((R.querySelectorAll ? R.querySelectorAll('h1,h2,h3,section,div,span,p,button,a,[role="dialog"],[aria-modal="true"]') : []));
    for (const el of nodes) {
      const tt = textsOf(el, doc);
      if (tt.some(txt => textHitsLimitNormalized(norm(txt)))) {
        const snippet = (tt.find(txt => textHitsLimitNormalized(norm(txt))) || '').slice(0,200);
        // LOGS DEBUG FORTE — após encontrar qualquer candidato
        if (typeof window !== "undefined") {
          try {
            const hits = 1;
            const where = 'global_any';
            const debugPayload = {
              step: 'deepScan_limit_overlay_debug',
              found: hits > 0,
              where: where,
              snippet,
              tags: el ? (
                {
                  id: el.id || '',
                  class: el.className || '',
                  ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : '',
                  ariaLabelled: el.getAttribute ? el.getAttribute('aria-labelledby') : '',
                  title: el.getAttribute ? el.getAttribute('title') : '',
                }
              ) : {},
              strongEvidenceCount: hits,
            };
            if (window.__robeSetLimitOverlay) {
              window.__robeSetLimitOverlay(debugPayload);
            }
            if (typeof console !== "undefined") {
              console.log('DEBUG_robo_deepScanLimitOverlayInDocument', debugPayload);
            }
          } catch {}
        }
        return { found:true, where:'global_any', snippet, strongEvidenceCount: 1 };
      }
    }
    return { found:false, where:'', snippet:'', strongEvidenceCount: 0 };
  }

  const doc = document;
  const roots = getAllRoots(doc);
  for (const R of roots) {
    const r = scanRoot(R);
    if (r && r.found) return r;
  }
  try {
    const bodyTxt = (doc.body && (doc.body.innerText || doc.body.textContent)) || '';
    if (textHitsLimitNormalized(norm(bodyTxt))) {
      return { found:true, where:'body_fallback', snippet: bodyTxt.slice(0,200), strongEvidenceCount: 1 };
    }
  } catch {}

  return { found:false, where:'', snippet:'', strongEvidenceCount: 0 };
}

async function detectLimitOverlayDeep(page, { alsoCheckFrames = true } = {}) {
  try {
    const main = await page.evaluate(() => deepScanLimitOverlayInDocument()).catch(()=>({found:false}));
    if (main && main.found) return { blocked: true, domain: 'facebook', hasReloadBtn: false, strongEvidenceCount: main.strongEvidenceCount, joinedTexts: main.snippet, where: main.where };

    if (alsoCheckFrames && page.mainFrame && page.mainFrame().childFrames) {
      const frames = page.mainFrame().childFrames();
      for (const fr of frames) {
        try {
          const res = await fr.evaluate(() => deepScanLimitOverlayInDocument());
          if (res && res.found) {
            return { blocked: true, domain: 'facebook', hasReloadBtn: false, strongEvidenceCount: res.strongEvidenceCount, joinedTexts: res.snippet, where: res.where };
          }
        } catch {}
      }
    }
  } catch {}
  return { blocked: false, domain: null, hasReloadBtn: false, strongEvidenceCount: 0, joinedTexts: '', where: '' };
}

async function detectLimitOverlayEverywhere(page, msWindow = 0) {
  const until = Date.now() + (msWindow || 0);
  do {
    try {
      const s = await page.evaluate(() => {
        const a = (window && window._ROBE_LIMIT_OVERLAY) || null;
        const b = (window.top && window.top._ROBE_LIMIT_OVERLAY) || null;
        const pick = (a && a.found) ? a : (b && b.found ? b : null);
        return pick ? { found:true, where: pick.where || '', snippet: (pick.h2||pick.body||''), ts: pick.ts||Date.now() } : null;
      }).catch(()=>null);
      if (s && s.found) {
        return { blocked:true, where: s.where||'sentinel', joinedTexts: s.snippet||'', strongEvidenceCount: 2 };
      }
    } catch {}
    const deep = await detectLimitOverlayDeep(page, { alsoCheckFrames:true });
    if (deep && deep.blocked) return deep;
    if (!msWindow) break;

    // LOG/PRINT em cada ciclo do loop — DEBUG DOM forense
    try {
      const debugDom = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]')).map(el => ({
          id: el.id || null,
          class: el.className || null,
          ariaLabel: el.getAttribute('aria-label') || null,
          ariaLabelled: el.getAttribute('aria-labelledby') || null,
          innerText: el.innerText ? el.innerText.slice(0,200) : null,
          outerHTML: el.outerHTML ? el.outerHTML.slice(0,200) : null,
        }));
        const allH2 = Array.from(document.querySelectorAll('h2')).map(h2 => h2.innerText || h2.textContent || '');
        if (typeof console !== 'undefined') {
          console.log('DEBUG_robo_dialogs: ', dialogs, allH2);
        }
        return {dialogs, allH2};
      }).catch(()=>({dialogs:[], allH2:[]}));
      
      try {
        require('./stepLog.js').appendJSONL && require('./stepLog.js').appendJSONL('system', 'debug_browser_deep_scan', debugDom);
      } catch {}
    } catch {}

    await new Promise(r=>setTimeout(r, 150));
  } while (Date.now() < until);

  return { blocked:false };
}

// ==== Patch Killer de about:blank ====
// Fecha qualquer aba "about:blank" que não navegue para uma URL real em até graceMs.
// Ativo em qualquer contexto (human, robe, config, virtus).
function installAboutBlankKiller(browser, nome, { graceMs = 7000 } = {}) {
  if (!browser || browser._aboutBlankKillerInstalled) return;
  browser._aboutBlankKillerInstalled = true;
  const issues = require('./issues.js');
  const timers = new Map();
  const ABOUTBLANK_MAX_AGE_MS = parseInt(process.env.ABOUTBLANK_MAX_AGE_MS || '45000', 10);
  const ABOUTBLANK_RETRY_MS = parseInt(process.env.ABOUTBLANK_RETRY_MS || '2500', 10);
  browser._pageBirth = browser._pageBirth || {};

  async function pageFromTarget(t) {
    try { return await t.page(); } catch { return null; }
  }
  function keyFor(target) {
    // Blindado: só aceita _targetId. Sem aleatório.
    try { if (target && target._targetId) return String(target._targetId); } catch {}
    return null;
  }
  function clearTimer(key) {
    const t = timers.get(key);
    if (t) clearTimeout(t);
    timers.delete(key);
  }

  async function armKiller(target) {
    try {
      if (!target || (typeof target.type === 'function' && target.type() !== 'page')) return;
      const page = await pageFromTarget(target);
      if (!page) return;
      // Sem _targetId: ainda rastreia (antes return null engessava blank órfã).
      const key = keyFor(target) || `page:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
      try {
        browser._pageBirth[key] = browser._pageBirth[key] || Date.now();
        if (!page.__convenienteBirth) page.__convenienteBirth = browser._pageBirth[key];
      } catch {}

      // CANCELADORES - NÃO BUSQUE page.url()
      try {
        page.once('close', () => clearTimer(key));
      } catch {}

      async function check() {
        let rearmed = false;
        try {
          if (page.isClosed && page.isClosed()) return;
          if (_browserGateBusy(browser) || _pageIsBlinding(page)) {
            rearmed = true;
            const t2 = setTimeout(() => { check().catch(()=>{}); }, ABOUTBLANK_RETRY_MS);
            timers.set(key, t2);
            return;
          }
          const u = page.url ? page.url() : '';
          let dead = false;
          try {
            const hy = require('./robeTabHygiene.js');
            dead = !!(hy && typeof hy.isDeadTabUrl === 'function' && hy.isDeadTabUrl(u));
          } catch {}
          if (dead) {
            try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
            try { await issues.append(nome, 'mil_action', 'dead_tab_killed'); } catch {}
            return;
          }
          if (u && u !== 'about:blank') return;

          const now = Date.now();
          const birth =
            (browser && browser._pageBirth && browser._pageBirth[key]) ||
            Number(page.__convenienteBirth || 0) ||
            0;
          const age = birth ? (now - birth) : 0;
          // Override por perfil (ex.: bootstrap precisa de mais tempo para navegar)
          let maxAge = ABOUTBLANK_MAX_AGE_MS;
          try {
            const ov = (browser && browser._aboutBlankMaxAgeMs && browser._aboutBlankMaxAgeMs[nome]) || 0;
            if (ov && Number.isFinite(Number(ov)) && Number(ov) > 0) maxAge = Number(ov);
          } catch {}
          const sup = (browser && browser._suppressBlankKillUntil && browser._suppressBlankKillUntil[nome]) || 0;
          const suppressed = (browser && browser._robeActiveFor === nome) || (sup > now);

          if (suppressed) {
            if (age >= maxAge) {
              try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
              try { await issues.append(nome, 'mil_action', 'about_blank_killed_max_age'); } catch {}
              return;
            }
            rearmed = true;
            const t2 = setTimeout(() => { check().catch(()=>{}); }, ABOUTBLANK_RETRY_MS);
            timers.set(key, t2);
            return;
          }

          // Fora de Robe e sem suppress => mata imediatamente
          try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
          try { await issues.append(nome, 'mil_action', 'about_blank_killed'); } catch {}
        } finally {
          if (!rearmed) clearTimer(key);
        }
      }

      const timer = setTimeout(() => { check().catch(()=>{}); }, graceMs);
      timers.set(key, timer);
    } catch {}
  }

  browser.on('targetcreated', armKiller);
  browser.on('targetchanged', async (t) => {
    try {
      const key = keyFor(t);
      // Use t.url() apenas (ThreadSafe), não page.url()
      const u = (t && typeof t.url === 'function') ? t.url() : '';
      let dead = false;
      try {
        const hy = require('./robeTabHygiene.js');
        dead = !!(hy && typeof hy.isDeadTabUrl === 'function' && hy.isDeadTabUrl(u));
      } catch {}
      if (u && u !== 'about:blank' && !dead) clearTimer(key);
    } catch {}
  });
  browser.on('targetdestroyed', async (t) => {
    try {
      const key = keyFor(t);
      clearTimer(key);
    } catch {}
  });

  try {
    browser.once && browser.once('disconnected', () => {
      try { timers.forEach(t => clearTimeout(t)); } catch {}
      timers.clear();
      // Limpeza defensiva dos listeners
      try { 
        browser.removeAllListeners && browser.removeAllListeners('targetcreated');
        browser.removeAllListeners && browser.removeAllListeners('targetchanged');
        browser.removeAllListeners && browser.removeAllListeners('targetdestroyed');
      } catch {}
    });
  } catch {}
}

// ==== NOVOS DETECTORES LOGIN E SUSPENSÃO ====

/**
 * Detecta se a página está exigindo login (form Facebook/Messenger clássico, checkpoint, captcha).
 * Retorna { loginRequired: true/false, reason: string, domain: string }
 */
async function detectLoginRequired(page) {
  try {
    const href = (page && typeof page.url === 'function') ? (page.url() || '') : '';
    const isFbOrMsg = /(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(href);
    if (!isFbOrMsg) return { loginRequired: false };

    const v = await page.evaluate(() => {
      function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
      // 1) Formulários de login canônicos
      const hasRoyal = !!document.querySelector('form[data-testid="royal_login_form"], form#login_form');
      const hasEmailInput = !!document.querySelector('input[name="email"], input#email, input[type="email"]');
      const hasPassInput = !!document.querySelector('input[name="pass"], input#pass, input[type="password"]');
      const hasInputs = hasEmailInput && hasPassInput;
      const href0 = String(location && location.href ? location.href : '');
      const path0 = String(location && location.pathname ? location.pathname : '');
      const title0 = String(document && document.title ? document.title : '');
      // 2) Checkpoint/captcha
      const h1 = Array.from(document.querySelectorAll('h1,h2,span,div')).slice(0,2000).map(el => norm(el.innerText||el.textContent||''));
      // HARDEN: também usa body.innerText, porque às vezes o texto está fora do recorte inicial
      const bodyTxt = norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
      // Fallback robusto: alguns layouts não expõem royal_login_form, mas exibem claramente a superfície de login.
      const hasLoginUiHints =
        bodyTxt.includes('esqueceu a senha') ||
        bodyTxt.includes('forgot password') ||
        bodyTxt.includes('criar nova conta') ||
        bodyTxt.includes('create new account') ||
        bodyTxt.includes('entrar no facebook') ||
        bodyTxt.includes('log into facebook') ||
        bodyTxt.includes('e-mail ou telefone') ||
        bodyTxt.includes('email or phone');
      const hasCaptchaPromptText =
        bodyTxt.includes('digite o texto da imagem') ||
        bodyTxt.includes('type the text from the image') ||
        bodyTxt.includes('enter the text from the image');
      const hasCaptchaImg = !!document.querySelector('img[src*="/captcha/tfbimage/"]');
      const hasCaptchaInput = !!document.querySelector('input[type="text"]');
      const hasContinueBtn = (() => {
        try {
          const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1200);
          for (const el of candidates) {
            const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
            const txt = norm(el.innerText || el.textContent || '');
            if (aria === 'continuar' || txt === 'continuar') return true;
          }
        } catch {}
        return false;
      })();
      // AYMH / seletor de perfil salvo (gate de login REAL):
      // Contrato leve: Continuar + "Usar outro perfil" — SEM comparar nome do botão com nome do card/pill
      // (nome na UI ≠ nome do perfil no CT → match de nome = falso positivo).
      // NÃO confundir com "Continuar como <Nome>" (sessão já autenticada).
      const hasUsarOutroPerfil =
        bodyTxt.includes('usar outro perfil') ||
        bodyTxt.includes('use another profile');
      const hasCriarNovaConta =
        bodyTxt.includes('criar nova conta') ||
        bodyTxt.includes('create new account');
      const hasAymhEntryPoint =
        !!document.querySelector('a[href*="entry_point=aymh"], a[href*="entry_point%3Daymh"]') ||
        /entry_point=aymh/i.test(href0);
      // Botão Continuar do chooser (rótulo livre) — só presença do CTA, zero match de identidade.
      const hasContinuarChooserBtn = (() => {
        try {
          const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1200);
          for (const el of candidates) {
            const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
            const txt = norm(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^continuar\s+como\b/.test(aria) || /^continue\s+as\b/.test(aria)) continue;
            if (/^continuar\s+como\b/.test(txt) || /^continue\s+as\b/.test(txt)) continue;
            if (aria === 'continuar' || txt === 'continuar' || aria === 'continue' || txt === 'continue') return true;
            // "Continuar …" / "Continue …" no aria (sem validar o texto após Continuar)
            if (/^continuar(\s|$)/.test(aria) || /^continue(\s|$)/.test(aria)) return true;
            if (/^continuar(\s|$)/.test(txt) || /^continue(\s|$)/.test(txt)) return true;
          }
        } catch {}
        return false;
      })();
      // Sinal seguro e mínimo: chooser AYMH = Usar outro perfil + Continuar, ainda sem inputs de login.
      // Criar nova conta / entry_point=aymh reforçam, mas NÃO são obrigatórios (nem match de nome).
      const isAymhContinue =
        !hasEmailInput &&
        !hasPassInput &&
        hasUsarOutroPerfil &&
        hasContinuarChooserBtn;
      const hasHumanConfirmText =
        bodyTxt.includes('confirme que voce e humano para usar sua conta') ||
        bodyTxt.includes('confirme que voce e humano') && bodyTxt.includes('para usar sua conta') ||
        bodyTxt.includes('confirm that you are human') ||
        bodyTxt.includes('confirm you are human');
      // Pre-screen: "confirme que você é humano para usar sua conta" + botão Continuar,
      // mas ainda NÃO é o captcha (sem imagem/input/prompt).
      const hasHumanConfirmPreScreen =
        hasHumanConfirmText &&
        hasContinueBtn &&
        !hasCaptchaPromptText &&
        !hasCaptchaImg &&
        !hasCaptchaInput;
      const hasPersonaTextRaw =
        h1.some(t => t.includes('confirme que voce e uma pessoa') || t.includes('confirm that you are a person')) ||
        bodyTxt.includes('confirme que voce e uma pessoa') ||
        bodyTxt.includes('confirm that you are a person');
      const hasCheckpointText =
        h1.some(t => t.includes('checkpoint') || t.includes('verificacao') || t.includes('verificacao de seguranca') || t.includes('security check')) ||
        bodyTxt.includes('checkpoint') ||
        bodyTxt.includes('verificacao de seguranca') ||
        bodyTxt.includes('security check');
      // 3) Confirmação de identidade (ex.: selfie/vídeo) — NÃO é resolvível automaticamente, mas precisa ser “visto”.
      const hasIdentityText = h1.some(t =>
        t.includes('confirme sua identidade') ||
        t.includes('confirm your identity') ||
        t.includes('gravar uma selfie de video') ||
        t.includes('grave uma selfie de video') ||
        t.includes('video selfie') ||
        (t.includes('selfie') && t.includes('video'))
      );

      // 4) 2FA / autenticação de dois fatores (NÃO automatizável)
      const hasTwoFactorText =
        h1.some(t =>
          t.includes('autenticacao de dois fatores') ||
          t.includes('dois fatores') ||
          t.includes('two-factor') ||
          t.includes('two factor') ||
          t.includes('authentication code') ||
          t.includes('codigo de autenticacao') ||
          t.includes('codigo de login') ||
          t.includes('gerador de codigo') ||
          t.includes('approvals needed') ||
          t.includes('aprovacoes de login')
        ) ||
        bodyTxt.includes('autenticacao de dois fatores') ||
        bodyTxt.includes('dois fatores') ||
        bodyTxt.includes('two-factor') ||
        bodyTxt.includes('approvals needed') ||
        bodyTxt.includes('codigo de autenticacao') ||
        bodyTxt.includes('codigo de login');

      // 5) Recurso/Apelação submetida (“você apresentou um recurso…”)
      // Estado: conta não utilizável, mas não é “login_form” — precisa de monitoramento.
      const hasAppealSubmitted =
        h1.some(t => t.includes('voce apresentou um recurso')) ||
        bodyTxt.includes('voce apresentou um recurso') ||
        bodyTxt.includes('sua conta nao esta visivel no facebook') ||
        bodyTxt.includes('voce nao pode usa-la') ||
        bodyTxt.includes('confira aqui novamente para ver o resultado');

      // 5b) Fluxo "Conta restringida / pode ter sido invadida" (hacked cleanup)
      // Exemplos reais:
      // - "analise seus dados de login para desbloquear sua conta"
      // - "proteja seus detalhes de login"
      // - "agora crie uma nova senha"
      // - "voce desbloqueou a sua conta" / "voce esta de volta ao facebook"
      const hasHackedReview =
        bodyTxt.includes('analise seus dados de login') ||
        bodyTxt.includes('analisar seus dados de login') ||
        bodyTxt.includes('proteja seus detalhes de login') ||
        bodyTxt.includes('conta pode ter sido invadida') ||
        bodyTxt.includes('pode ter sido invadida') ||
        bodyTxt.includes('etapas para voltar ao facebook') ||
        bodyTxt.includes('voltar ao facebook') && bodyTxt.includes('etapas') ||
        bodyTxt.includes('desbloquear sua conta');
      const hasPasswordResetRequired =
        bodyTxt.includes('agora crie uma nova senha') ||
        bodyTxt.includes('inserir nova senha') ||
        bodyTxt.includes('salvar alteracoes') && bodyTxt.includes('nova senha');
      const hasBackToFacebookUnlocked =
        bodyTxt.includes('voce desbloqueou a sua conta') ||
        bodyTxt.includes('voce esta de volta ao facebook') ||
        bodyTxt.includes('voltar para o facebook') && bodyTxt.includes('voce');

      // 5c) Bug do Facebook: "Este conteúdo não está disponível no momento"
      // Isso NÃO é um bloqueio real da conta; basta navegar para home/marketplace depois.
      const hasContentNotAvailable =
        bodyTxt.includes('este conteudo nao esta disponivel no momento') ||
        bodyTxt.includes('este conteúdo não está disponível no momento') ||
        bodyTxt.includes("this content isn't available") ||
        bodyTxt.includes('this content is not available');

      // 5d) Bug/erro do Messenger: "Esta página não está disponível"
      // Caso real: Messenger mostra tela de erro e o worker precisa checar FB /marketplace/create para inferir SMS cliff.
      const hasPageNotAvailable =
        bodyTxt.includes('esta pagina nao esta disponivel') ||
        bodyTxt.includes('esta página não está disponível') ||
        bodyTxt.includes("this page isn't available") ||
        bodyTxt.includes('this page is not available') ||
        bodyTxt.includes('o link que voce acessou pode estar corrompido') ||
        bodyTxt.includes('o link que você acessou pode estar corrompido');

      // 6) Confirmação de identidade em andamento (pós upload / aguardando análise)
      // IMPORTANT (ultra enterprise):
      // - NÃO confundir "Recurso em análise" (appeal_submitted) com "Identidade em análise".
      // - A frase "normalmente, levamos cerca de uma hora para analisar" aparece em ambos os contextos,
      //   então ela NÃO pode ser sinal suficiente sozinha.
      // Critério: exigir sinais fortes e específicos de identidade/selfie/vídeo.
      const identityStrongHints =
        bodyTxt.includes('selfie de video') ||
        bodyTxt.includes('video selfie') ||
        bodyTxt.includes('selfie') && bodyTxt.includes('video') ||
        (bodyTxt.includes('carregamento desse video') && bodyTxt.includes('confirmar sua identidade')) ||
        (bodyTxt.includes('grave') && bodyTxt.includes('selfie') && bodyTxt.includes('video')) ||
        (bodyTxt.includes('gravar') && bodyTxt.includes('selfie') && bodyTxt.includes('video'));

      // Anti-falso-positivo crítico:
      // Em telas de identidade o FB usa texto "pessoa real" (parece captcha), mas é IDENTIDADE (selfie/vídeo).
      // Se há sinais fortes de identidade, NÃO classificar como captcha_persona.
      const hasPersonaText = hasPersonaTextRaw && !identityStrongHints;

      const hasIdentitySubmitted =
        // textos explícitos de identidade "em andamento"
        (identityStrongHints && (
          bodyTxt.includes('confirmacao de identidade em andamento') ||
          (bodyTxt.includes('confirmacao de identidade') && bodyTxt.includes('em andamento')) ||
          bodyTxt.includes('selfie de video finalizada') ||
          bodyTxt.includes('analisaremos suas informacoes') ||
          bodyTxt.includes('analisamos suas informacoes em ate')
        ));

      // 7) Sinais de identidade no body (fallback quando o recorte de h1 não contém)
      const bodyHasIdentityHints =
        bodyTxt.includes('confirme sua identidade') ||
        bodyTxt.includes('confirm your identity') ||
        bodyTxt.includes('selfie') ||
        bodyTxt.includes('identidade') ||
        bodyTxt.includes('video selfie');

      return {
        hasRoyal, hasInputs, hasEmailInput, hasPassInput, hasLoginUiHints, hasPersonaText, hasCheckpointText,
        hasIdentityText, hasTwoFactorText, hasAppealSubmitted, hasIdentitySubmitted, identityStrongHints,
        bodyHasIdentityHints, hasHackedReview, hasPasswordResetRequired, hasBackToFacebookUnlocked,
        hasContentNotAvailable, hasPageNotAvailable, hasHumanConfirmPreScreen, hasCaptchaPromptText,
        hasCaptchaImg, hasCaptchaInput, hasContinueBtn, isAymhContinue, hasUsarOutroPerfil,
        hasCriarNovaConta, hasContinuarChooserBtn, hasAymhEntryPoint, href0, path0, title0
      };
    });

    const domain = (/messenger\.com/i.test(href) ? 'messenger' : 'facebook');
    const path = (v && v.path0) ? String(v.path0) : '';
    const strongLoginPath = /\/(login|checkpoint|recover|two_step_verification|security)/i.test(path);
    const hasRoyal = !!(v && v.hasRoyal);
    const hasInputs = !!(v && v.hasInputs);
    const hasEmailInput = !!(v && v.hasEmailInput);
    const hasPassInput = !!(v && v.hasPassInput);
    const hasPersonaText = !!(v && v.hasPersonaText);
    const hasLoginUiHints = !!(v && v.hasLoginUiHints);
    const hasCheckpointText = !!(v && v.hasCheckpointText);
    const hasIdentityText = !!(v && v.hasIdentityText);
    const hasIdentitySubmitted = !!(v && v.hasIdentitySubmitted);
    const identityStrongHints = !!(v && v.identityStrongHints);
    const bodyHasIdentityHints = !!(v && v.bodyHasIdentityHints);
    const hasTwoFactorText = !!(v && v.hasTwoFactorText);
    const hasAppealSubmitted = !!(v && v.hasAppealSubmitted);
    const hasHackedReview = !!(v && v.hasHackedReview);
    const hasPasswordResetRequired = !!(v && v.hasPasswordResetRequired);
    const hasBackToFacebookUnlocked = !!(v && v.hasBackToFacebookUnlocked);
    const hasContentNotAvailable = !!(v && v.hasContentNotAvailable);
    const hasPageNotAvailable = !!(v && v.hasPageNotAvailable);
    const hasHumanConfirmPreScreen = !!(v && v.hasHumanConfirmPreScreen);
    const hasCaptchaPromptText = !!(v && v.hasCaptchaPromptText);
    const hasCaptchaImg = !!(v && v.hasCaptchaImg);
    const hasCaptchaInput = !!(v && v.hasCaptchaInput);
    const hasContinueBtn = !!(v && v.hasContinueBtn);
    const hasUsarOutroPerfil = !!(v && v.hasUsarOutroPerfil);
    const hasContinuarChooserBtn = !!(v && v.hasContinuarChooserBtn);
    // Chooser AYMH vence login_form mesmo com input de senha já pintado no DOM
    // (race / residual pós-render). Contrato: Usar outro perfil + Continuar = humano only.
    const isAymhContinue =
      !!(v && v.isAymhContinue) ||
      (hasUsarOutroPerfil && hasContinuarChooserBtn);
    const title = (v && v.title0) ? String(v.title0) : '';
    const titleNorm = (() => {
      try {
        return (title || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      } catch { return String(title || '').toLowerCase(); }
    })();
    const hrefNorm = (() => { try { return String((v && v.href0) ? v.href0 : href); } catch { return String(href||''); } })();
    const looksLikeLoggedOutTitle =
      titleNorm.includes('entre ou cadastre') ||
      titleNorm.includes('entre ou cadastrar') ||
      titleNorm.includes('entre no facebook') ||
      titleNorm.includes('facebook – entre') ||
      titleNorm.includes('facebook - entre') ||
      titleNorm.includes('log in') ||
      titleNorm.includes('sign up');
    const looksLikeLoginUrl =
      /\/login\.php/i.test(hrefNorm) ||
      /\/login\//i.test(hrefNorm) ||
      /\/checkpoint\//i.test(hrefNorm) ||
      /\/recover\//i.test(hrefNorm);

    // Bug conhecido do Facebook: não deve travar automação.
    if (hasContentNotAvailable) {
      return {
        loginRequired: false,
        reason: 'content_not_available',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasContentNotAvailable, path }
      };
    }

    // Pré-captcha: "Confirme que você é humano" (antes do captcha).
    // Regra enterprise: tratar como loginRequired e encaminhar para fluxo de clique "Continuar".
    if (hasHumanConfirmPreScreen) {
      // #region agent log (debug)
      // #endregion
      return {
        loginRequired: true,
        reason: 'captcha_persona_pre_screen',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasHumanConfirmPreScreen, hasContinueBtn, hasCaptchaPromptText, hasCaptchaImg, hasCaptchaInput, path }
      };
    }

    // Captcha clássico (imagem+texto). Não é automatizável por padrão (o placeholder OCR fica no worker).
    // Mantemos motivo "captcha_persona" quando o texto "pessoa" existe; mas se o captcha estiver explícito,
    // também deixamos evidência forte para reduzir falso positivo.
    if (hasCaptchaPromptText && hasCaptchaImg && hasCaptchaInput) {
      // #region agent log (debug)
      // #endregion
      return {
        loginRequired: true,
        reason: 'captcha_persona',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasCaptchaPromptText, hasCaptchaImg, hasCaptchaInput, hasContinueBtn, path }
      };
    }

    // Bug/erro do Messenger: "Esta página não está disponível".
    // Blindagem anti-FP (forense MAE1 31/07): feed/Marketplace pode conter a frase no body
    // sem ser tela de erro → NÃO marcar LR em superfície saudável de Marketplace/Messages.
    if (hasPageNotAvailable) {
      const pathNorm = String(path || '').toLowerCase();
      const urlLooksMarketplace = /\/marketplace\b/i.test(hrefNorm) || /\/marketplace\b/i.test(pathNorm);
      const urlLooksMessagesThread =
        /\/messages\/t\//i.test(hrefNorm) ||
        /\/messages\/t\//i.test(pathNorm) ||
        (/messenger\.com\/t\//i.test(hrefNorm));
      const titleLooksError =
        titleNorm.includes('nao esta disponivel') ||
        titleNorm.includes("isn't available") ||
        titleNorm.includes('is not available') ||
        titleNorm.includes('page not available');
      const isMessengerDomain = domain === 'messenger' || /messenger\.com/i.test(hrefNorm);
      // Marketplace app_tab / feed saudável: ignora body-match (FP comprovado).
      const suppressFpOnHealthySurface =
        (urlLooksMarketplace || urlLooksMessagesThread) &&
        !titleLooksError &&
        !isAymhContinue &&
        !hasInputs &&
        !hasRoyal;
      if (!suppressFpOnHealthySurface && (isMessengerDomain || titleLooksError || (!urlLooksMarketplace && !urlLooksMessagesThread))) {
        return {
          loginRequired: true,
          reason: 'messenger_page_not_available',
          domain,
          url: (v && v.href0) ? String(v.href0) : href,
          title,
          evidence: {
            hasPageNotAvailable,
            path,
            suppressFpOnHealthySurface: false,
            urlLooksMarketplace,
            urlLooksMessagesThread,
            titleLooksError
          }
        };
      }
    }

    // AYMH / seletor de perfil: Continuar + Usar outro perfil (sem match de nome).
    // Contrato: só marcar LR + humano. NÃO clicar Continuar / NÃO cookies / NÃO auto-login.
    if (isAymhContinue) {
      return {
        loginRequired: true,
        reason: 'aymh_continue',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: {
          isAymhContinue: true,
          hasUsarOutroPerfil: !!(v && v.hasUsarOutroPerfil),
          hasCriarNovaConta: !!(v && v.hasCriarNovaConta),
          hasContinuarChooserBtn: !!(v && v.hasContinuarChooserBtn),
          hasAymhEntryPoint: !!(v && v.hasAymhEntryPoint),
          path
        }
      };
    }

    // 2FA sempre vence (não dá para “contornar” em outra aba)
    if (hasTwoFactorText) {
      return {
        loginRequired: true,
        reason: 'two_factor',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, hasHackedReview, hasPasswordResetRequired, hasBackToFacebookUnlocked, path }
      };
    }

    // Checkpoint "Voltar para o Facebook" (desbloqueado / de volta):
    // exige apenas clicar em "Voltar para o Facebook" e seguir, não é login_form.
    if (hasBackToFacebookUnlocked && !hasPasswordResetRequired && !hasHackedReview) {
      return {
        loginRequired: true,
        reason: 'checkpoint_back_to_facebook',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasBackToFacebookUnlocked, path }
      };
    }

    // Fluxo hacked/password reset: tratar como estado próprio (auto-remediável).
    if (hasPasswordResetRequired) {
      return {
        loginRequired: true,
        reason: 'password_reset_required',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasPasswordResetRequired, hasHackedReview, hasBackToFacebookUnlocked, path }
      };
    }
    if (hasHackedReview || hasBackToFacebookUnlocked) {
      return {
        loginRequired: true,
        reason: 'hacked_review',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasHackedReview, hasBackToFacebookUnlocked, path }
      };
    }

    // Recurso submetido: não é “login_form”, mas bloqueia conta (precisa monitorar).
    if (hasAppealSubmitted) {
      // Importante (anti-falso-positivo):
      // após concluir identidade, a página pode conter palavras genéricas como "identidade" no texto,
      // então NÃO use "bodyHasIdentityHints" aqui. Só trate como identity_submitted se houver sinais fortes.
      if (hasIdentitySubmitted || hasIdentityText) {
        return {
          loginRequired: true,
          reason: 'identity_submitted',
          domain,
          url: (v && v.href0) ? String(v.href0) : href,
          title,
          evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasIdentitySubmitted, bodyHasIdentityHints, hasTwoFactorText, hasAppealSubmitted, path }
        };
      }
      return {
        loginRequired: true,
        reason: 'appeal_submitted',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasIdentitySubmitted, bodyHasIdentityHints, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }

    // Blindagem por URL/path (sem depender de texto):
    // - FB 2FA costuma cair em /two_step_verification/two_factor/ (flow=two_factor_login)
    // - Messenger pode cair em /login/checkpoint_interstitial/ quando a conta exige checkpoint/2FA
    if (/\/two_step_verification\/two_factor\//i.test(path) || /flow=two_factor/i.test(hrefNorm)) {
      return {
        loginRequired: true,
        reason: 'two_factor',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }
    if (/checkpoint_interstitial/i.test(path) || /checkpoint_interstitial/i.test(hrefNorm)) {
      return {
        loginRequired: true,
        reason: 'checkpoint_interstitial',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }

    // Messenger é especial:
    // muitas vezes a tela de login (form#login_form) aparece na rota "/" (marketing page),
    // então não dá para exigir strongLoginPath/title como no Facebook.
    // Aceita também superfície só-senha (pós Continuar AYMH).
    if (domain === 'messenger' && (hasInputs || (hasPassInput && (hasRoyal || hasLoginUiHints))) && (hasRoyal || hasLoginUiHints || looksLikeLoggedOutTitle || looksLikeLoginUrl)) {
      return {
        loginRequired: true,
        reason: 'login_form',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasEmailInput, hasPassInput, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }

    // Detecção mais conservadora para evitar falso positivo:
    // - login_form só é válido se a rota for claramente de login/checkpoint
    // - checkpoint/captcha também exige rota/sinais de checkpoint
    // IMPORTANT: em algumas telas, o form aparece em rotas como /marketplace ou /index.php (logged-out),
    // então não podemos depender apenas do path.
    // Password-only (hasPassInput sem email) conta quando há royal/hints/URL de login — típico pós Continuar AYMH.
    if ((hasInputs || (hasPassInput && (hasRoyal || hasLoginUiHints || looksLikeLoginUrl || strongLoginPath))) && (hasRoyal || hasLoginUiHints) && (strongLoginPath || looksLikeLoginUrl || looksLikeLoggedOutTitle || hasLoginUiHints)) {
      return {
        loginRequired: true,
        reason: 'login_form',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasEmailInput, hasPassInput, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }
    // Identidade (selfie/vídeo) deve ser reconhecida mesmo fora de /checkpoint.
    // Motivo: em alguns fluxos o FB renderiza a etapa dentro de / (home) com modal/SPA.
    // Blindagem anti-falso-positivo: exigir hints fortes (selfie+vídeo) para considerar.
    if (hasIdentitySubmitted || (identityStrongHints && bodyHasIdentityHints) || (hasIdentityText && (strongLoginPath || /checkpoint/i.test(title)))) {
      return {
        loginRequired: true,
        reason: hasIdentitySubmitted ? 'identity_submitted' : 'identity_confirm_selfie',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }
    // Captcha/persona e checkpoint podem aparecer fora de /checkpoint (ex.: /index.php, m.facebook.com/error, etc).
    // Se há texto explícito de "confirme que você é uma pessoa", trate como NÃO automatizável sempre.
    if (hasPersonaText) {
      return {
        loginRequired: true,
        reason: 'captcha_persona',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }
    if (hasCheckpointText && (strongLoginPath || /checkpoint/i.test(title))) {
      return {
        loginRequired: true,
        // Se a tela é explicitamente “Confirme que você é uma pessoa”, separa para diagnóstico humano
        reason: 'checkpoint_captcha',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }

    return {
      loginRequired: false,
      reason: '',
      domain,
      url: (v && v.href0) ? String(v.href0) : href,
      title,
      evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
    };
  } catch {}
  // Fail-safe enterprise: se o probe falhar (contexto destruído/aba fechando),
  // não podemos concluir "liberado". Mantemos como loginRequired=true para evitar ações erradas.
  return { loginRequired: true, reason: 'probe_failed' };
}

/**
 * ID Virtus — bloqueio Messenger de envio (NÃO é identity selfie/vídeo).
 * Âncora forte: "Confirme sua identidade para enviar mensagens" (+ reforço).
 * Zero FP vs selfie, captcha persona, login/2FA.
 */
async function detectVirtusIdentityBlock(page) {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return { blocked: false, reason: 'page_closed' };
    }
    const v = await page.evaluate(() => {
      function norm(s) {
        try {
          return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        } catch {
          return String(s || '').toLowerCase();
        }
      }
      const href = String(location.href || '');
      const host = String(location.hostname || '').toLowerCase();
      const path = String(location.pathname || '');
      const isMessenger =
        host.includes('messenger.com') ||
        /facebook\.com$/i.test(host) && (/\/messages\b/i.test(path) || /\/marketplace\/t\//i.test(path));
      if (!isMessenger) return { blocked: false, reason: 'not_messenger' };

      const bodyTxt = norm(document.body ? (document.body.innerText || '') : '');
      const hasSendIdentityPt = bodyTxt.includes('confirme sua identidade para enviar mensagens');
      const hasSendIdentityEn = bodyTxt.includes('confirm your identity to send messages');
      if (!hasSendIdentityPt && !hasSendIdentityEn) {
        return { blocked: false, reason: 'no_send_identity_anchor' };
      }

      // Negativo: fluxo selfie/vídeo (identityRequired do Robe/FB)
      const selfieHints =
        (bodyTxt.includes('selfie') && bodyTxt.includes('video')) ||
        bodyTxt.includes('selfie de video') ||
        bodyTxt.includes('video selfie') ||
        bodyTxt.includes('gravar uma selfie') ||
        bodyTxt.includes('grave uma selfie');
      if (selfieHints) return { blocked: false, reason: 'selfie_identity_not_id_virtus' };

      // Negativo: captcha persona
      if (
        bodyTxt.includes('confirme que voce e uma pessoa') ||
        bodyTxt.includes('confirm that you are a person')
      ) {
        return { blocked: false, reason: 'captcha_persona_not_id_virtus' };
      }

      const hasUnusual =
        bodyTxt.includes('atividade incomum') ||
        bodyTxt.includes('unusual activity') ||
        bodyTxt.includes('acoes foram restringidas') ||
        bodyTxt.includes('actions have been restricted');

      let hasComoConfirmar = false;
      try {
        const els = Array.from(
          document.querySelectorAll('[role="button"],button,a,[aria-label]')
        ).slice(0, 800);
        for (const el of els) {
          const aria = norm((el.getAttribute && el.getAttribute('aria-label')) || '');
          const txt = norm(el.innerText || el.textContent || '');
          if (
            aria.includes('como confirmar') ||
            txt.includes('como confirmar') ||
            aria.includes('how to confirm') ||
            txt.includes('how to confirm')
          ) {
            hasComoConfirmar = true;
            break;
          }
        }
      } catch {}

      if (!hasUnusual && !hasComoConfirmar) {
        return { blocked: false, reason: 'missing_reinforcement' };
      }

      let alertHit = false;
      try {
        const alerts = Array.from(document.querySelectorAll('[role="alert"]')).slice(0, 40);
        for (const a of alerts) {
          const t = norm(a.innerText || a.textContent || '');
          if (
            t.includes('confirme sua identidade para enviar mensagens') ||
            t.includes('confirm your identity to send messages')
          ) {
            alertHit = true;
            break;
          }
        }
      } catch {}

      let composerCount = 0;
      try {
        composerCount = Array.from(
          document.querySelectorAll(
            'div[data-lexical-editor="true"][contenteditable="true"]'
          )
        ).filter((el) => {
          try {
            const st = window.getComputedStyle(el);
            return st && st.display !== 'none' && st.visibility !== 'hidden';
          } catch {
            return true;
          }
        }).length;
      } catch {}

      return {
        blocked: true,
        reason: 'id_virtus_send_identity',
        hasUnusual,
        hasComoConfirmar,
        alertHit,
        composerCount,
        href: href.slice(0, 300),
        title: String(document.title || '').slice(0, 200)
      };
    }).catch(() => null);

    if (!v || v.blocked !== true) {
      return { blocked: false, reason: (v && v.reason) || 'not_blocked' };
    }
    return {
      blocked: true,
      reason: String(v.reason || 'id_virtus_send_identity'),
      url: v.href || null,
      title: v.title || null,
      evidence: {
        hasUnusual: !!v.hasUnusual,
        hasComoConfirmar: !!v.hasComoConfirmar,
        alertHit: !!v.alertHit,
        composerCount: Number(v.composerCount || 0) || 0
      }
    };
  } catch (e) {
    return {
      blocked: false,
      reason: 'probe_failed',
      error: String((e && e.message) || e).slice(0, 120)
    };
  }
}

// ==== CAPTCHA/CONFIRME-HUMANO HELPERS (SEM OCR IMPLEMENTADO) ====

async function clickContinueByLabel(page, { maxWaitMs = 10_000 } = {}) {
  try {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1500, Number(maxWaitMs || 0) || 0);
    while (Date.now() < deadline) {
      const r = await page.evaluate(() => {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
        const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1600);
        // AYMH: wrapper role=button tabindex=-1 envolve o Continuar real (tabindex=0).
        // NÃO abortar no wrapper — pular e seguir buscando o CTA clicável.
        let sawDisabledReal = null;
        for (const el of candidates) {
          const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
          const txt = norm(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          const isContinuarExact = (aria === 'continuar' || txt === 'continuar' || aria === 'continue' || txt === 'continue');
          if (!isContinuarExact) continue;
          const ariaDisabled = (el.getAttribute && el.getAttribute('aria-disabled')) ? String(el.getAttribute('aria-disabled')) : '';
          const tabIndex = (el.getAttribute && el.getAttribute('tabindex')) ? String(el.getAttribute('tabindex')) : '';
          if (tabIndex === '-1') continue; // wrapper/decoy
          if (ariaDisabled === 'true') {
            sawDisabledReal = { ariaDisabled, tabIndex };
            continue;
          }
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          try { el.click(); } catch {}
          return { ok: true };
        }
        if (sawDisabledReal) {
          return { ok: false, error: 'continue_disabled', ariaDisabled: sawDisabledReal.ariaDisabled, tabIndex: sawDisabledReal.tabIndex };
        }
        return { ok: false, error: 'continue_not_found' };
      }).catch(()=>null);
      if (r && r.ok) {
        // #region agent log (debug)
        // #endregion
        return { ok: true };
      }
      // Se está disabled, não adianta martelar; deixa caller decidir (ex.: captcha precisa texto).
      if (r && String(r.error||'').includes('disabled')) {
        // #region agent log (debug)
        // #endregion
        return { ok: false, error: String(r.error), details: r };
      }
      await new Promise(r => setTimeout(r, 450));
    }
    // #region agent log (debug)
    // #endregion
    return { ok: false, error: 'timeout' };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function waitForContinueEnabled(page, { timeoutMs = 20_000 } = {}) {
  const budget = Math.max(1500, Number(timeoutMs || 0) || 0);
  try {
    const ok = await page.waitForFunction(() => {
      try {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
        const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1600);
        for (const el of candidates) {
          const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
          const txt = norm(el.innerText || el.textContent || '');
          if (aria === 'continuar' || txt === 'continuar') {
            const ariaDisabled = (el.getAttribute && el.getAttribute('aria-disabled')) ? String(el.getAttribute('aria-disabled')) : '';
            const tabIndex = (el.getAttribute && el.getAttribute('tabindex')) ? String(el.getAttribute('tabindex')) : '';
            const disabled = (ariaDisabled === 'true') || (tabIndex === '-1');
            return !disabled;
          }
        }
        return false;
      } catch { return false; }
    }, { timeout: budget }).then(()=>true).catch(()=>false);
    return { ok: !!ok };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function detectCaptchaChallenge(page) {
  try {
    const v = await page.evaluate(() => {
      function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
      const bodyTxt = norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
      const hasPrompt = bodyTxt.includes('digite o texto da imagem') || bodyTxt.includes('type the text from the image');
      const img = document.querySelector('img[src*="/captcha/tfbimage/"]');
      const imgSrc = img && img.getAttribute ? String(img.getAttribute('src') || '') : '';
      const input = document.querySelector('input[type="text"]');
      const hasInput = !!input;
      const btns = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1600);
      let continueDisabled = null;
      for (const el of btns) {
        const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
        const txt = norm(el.innerText || el.textContent || '');
        if (aria === 'continuar' || txt === 'continuar') {
          const ariaDisabled = (el.getAttribute && el.getAttribute('aria-disabled')) ? String(el.getAttribute('aria-disabled')) : '';
          const tabIndex = (el.getAttribute && el.getAttribute('tabindex')) ? String(el.getAttribute('tabindex')) : '';
          continueDisabled = (ariaDisabled === 'true') || (tabIndex === '-1');
          break;
        }
      }
      return { hasPrompt, imgSrc, hasInput, continueDisabled };
    });
    return { ok: true, present: !!(v && v.hasPrompt && v.imgSrc && v.hasInput), ...(v || {}) };
  } catch (e) {
    return { ok: false, present: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function focusCaptchaInput(page) {
  try {
    const r = await page.evaluate(() => {
      const input = document.querySelector('input[type="text"]');
      if (!input) return { ok: false, error: 'input_not_found' };
      try { input.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      try { input.focus(); } catch {}
      try { input.click(); } catch {}
      return { ok: true };
    });
    return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) ? String(r.error) : 'unknown' };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function fillCaptchaAndContinue(page, { text, maxWaitMs = 12_000 } = {}) {
  // Captcha: digitar somente caracteres úteis (sem espaços).
  // Regra de robustez: aceitar alfanumérico (A-Z/0-9). Se o captcha mudar (letras+numeros),
  // o sistema continua pronto.
  const t = String(text || '').replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').trim();
  if (!t) return { ok: false, error: 'empty_text' };
  try {
    // Foco garantido
    await focusCaptchaInput(page).catch(()=>null);
    // IMPORTANT (ultra enterprise):
    // Em retries, o Facebook pode manter o texto anterior no input.
    // Se não limpar, o próximo OCR "concatena" e garante erro.
    await page.evaluate(() => {
      try {
        const input = document.querySelector('input[type="text"]');
        if (!input) return;
        // Select-all + clear (compatível com React-controlled inputs)
        try { input.focus(); } catch {}
        try { input.value = ''; } catch {}
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
        try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
      } catch {}
    }).catch(()=>null);
    // Digitar com delay leve (um char por vez) para reduzir flake e permitir React atualizar estado do botão.
    await page.type('input[type="text"]', t, { delay: 60 }).catch(()=>null);

    // Espera condição REAL: botão "Continuar" habilitar (sem sleeps artificiais).
    const budget = Math.max(1200, Number(maxWaitMs||0)||0);
    const enabled = await page.waitForFunction(() => {
      try {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
        const candidates = Array.from(document.querySelectorAll('[role=\"button\"],button,a')).slice(0, 1600);
        for (const el of candidates) {
          const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
          const txt = norm(el.innerText || el.textContent || '');
          if (aria === 'continuar' || txt === 'continuar') {
            const ariaDisabled = (el.getAttribute && el.getAttribute('aria-disabled')) ? String(el.getAttribute('aria-disabled')) : '';
            const tabIndex = (el.getAttribute && el.getAttribute('tabindex')) ? String(el.getAttribute('tabindex')) : '';
            const disabled = (ariaDisabled === 'true') || (tabIndex === '-1');
            return !disabled;
          }
        }
        return false;
      } catch { return false; }
    }, { timeout: budget }).then(()=>true).catch(()=>false);

    if (!enabled) return { ok: false, error: 'continue_still_disabled_after_type' };

    const r = await clickContinueByLabel(page, { maxWaitMs: Math.min(2500, budget) }).catch(()=>null);
    if (r && r.ok) return { ok: true };
    return { ok: false, error: r && r.error ? String(r.error) : 'continue_click_failed' };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function waitForCaptchaTurnover(page, { previousImgSrc = '', timeoutMs = 15_000, minStableMs = 700 } = {}) {
  const prev = String(previousImgSrc || '').trim();
  const budget = Math.max(1500, Number(timeoutMs||0)||0);
  const stable = Math.max(0, Number(minStableMs||0)||0);
  try {
    const ok = await page.waitForFunction((p, stableMs) => {
      try {
        // Mantém um mini-estado em window para detectar "estabilizou" (sem depender de sleeps externos)
        const now = Date.now();
        const img = document.querySelector('img[src*=\"/captcha/tfbimage/\"]');
        if (!img) return true; // saiu do captcha
        const src = String(img.getAttribute('src') || img.src || '');
        const loaded = !!(img.complete && (img.naturalWidth || 0) > 0);
        // Se temos um previousImgSrc, não aceitamos enquanto for a mesma imagem.
        if (p && src && src === p) return false;
        if (!loaded) return false;
        const st = window.__ctCaptchaStable = window.__ctCaptchaStable || { lastSrc: '', lastChangeAt: 0 };
        if (st.lastSrc !== src) {
          st.lastSrc = src;
          st.lastChangeAt = now;
          return false;
        }
        // Só libera quando o src ficou estável por stableMs (reduz "atropelo" entre tentativas)
        if (stableMs > 0) {
          return (now - Number(st.lastChangeAt || 0)) >= stableMs;
        }
        return true;
      } catch { return false; }
    }, { timeout: budget }, prev, stable).then(()=>true).catch(()=>false);

    let finalSrc = '';
    let present = false;
    try {
      const v = await page.evaluate(() => {
        const img = document.querySelector('img[src*=\"/captcha/tfbimage/\"]');
        const src = img ? String(img.getAttribute('src') || img.src || '') : '';
        return { present: !!img, src };
      }).catch(()=>({ present:false, src:'' }));
      present = !!(v && v.present);
      finalSrc = v && v.src ? String(v.src) : '';
    } catch {}

    return { ok: !!ok, present, previousImgSrc: prev, finalImgSrc: finalSrc, minStableMs: stable };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

/**
 * Resolve captcha usando Groq OCR (ultra enterprise melhor do mundo).
 * Extrai a imagem do captcha, envia para Groq API, processa resposta e retorna texto limpo.
 */
async function solveCaptchaWithGroq(page, { nome = '', operator = '', attempt = 1, previousImgSrc = '' } = {}) {
  try {
    // 1. Detectar captcha e extrair URL da imagem
    const cap = await detectCaptchaChallenge(page).catch(()=>({ ok: false, present: false }));
    if (!cap || !cap.ok || !cap.present || !cap.imgSrc) {
      return { ok: false, error: 'captcha_not_detected', details: cap };
    }

    const imgSrc = String(cap.imgSrc || '').trim();
    if (!imgSrc || !imgSrc.includes('/captcha/tfbimage/')) {
      return { ok: false, error: 'invalid_img_src', imgSrc };
    }

    // Esperar imagem REAL estar carregada (evita OCR em imagem “meio atualizando”).
    // Se previousImgSrc foi informado, esperar virar para uma imagem diferente.
    const prev = String(previousImgSrc || '').trim();
    const imgReady = await page.waitForFunction((p) => {
      try {
        const img = document.querySelector('img[src*=\"/captcha/tfbimage/\"]');
        if (!img) return false;
        const src = String(img.getAttribute('src') || img.src || '');
        const loaded = !!(img.complete && (img.naturalWidth || 0) > 0);
        if (!loaded) return false;
        if (p && src && src === p) return false;
        return true;
      } catch { return false; }
    }, { timeout: 12_000 }, prev).then(()=>true).catch(()=>false);
    if (!imgReady) return { ok: false, error: 'captcha_image_not_ready', imgSrc, hasPrev: !!prev };

    // 2. Ler configuração Groq
    const groqCfg = readGroqConfig();
    if (!groqCfg || !groqCfg.groqApiKey || !groqCfg.groqModel) {
      return { ok: false, error: 'groq_config_missing', hasKey: !!groqCfg?.groqApiKey, hasModel: !!groqCfg?.groqModel };
    }

    // 3. Baixar imagem usando puppeteer (mais confiável que fetch para imagens do Facebook)
    let imageBase64 = null;
    try {
      // Usa evaluate para baixar a imagem via canvas (evita CORS)
      // Busca a imagem pelo src completo ou parcial
      imageBase64 = await page.evaluate(async (src) => {
        try {
          // Tenta encontrar a imagem pelo src completo primeiro
          let img = document.querySelector(`img[src="${src}"]`);
          // Se não encontrar, tenta pelo src parcial
          if (!img) {
            const srcParts = src.split('/captcha/tfbimage/');
            if (srcParts.length > 1) {
              const partial = srcParts[1].split('?')[0];
              img = document.querySelector(`img[src*="${partial}"]`);
            }
          }
          // Última tentativa: qualquer img com /captcha/tfbimage/
          if (!img) {
            img = document.querySelector('img[src*="/captcha/tfbimage/"]');
          }
          if (!img) return null;
          
          // Cria canvas para converter imagem em base64
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = img.naturalWidth || img.width || 300;
          canvas.height = img.naturalHeight || img.height || 100;
          
          // Aguarda imagem carregar
          await new Promise((resolve, reject) => {
            if (img.complete) {
              resolve();
            } else {
              img.onload = resolve;
              img.onerror = reject;
              setTimeout(reject, 5000);
            }
          });
          
          ctx.drawImage(img, 0, 0);
          return canvas.toDataURL('image/png').split(',')[1]; // Remove data:image/png;base64,
        } catch (e) {
          return null;
        }
      }, imgSrc).catch(()=>null);

      // Fallback: se canvas falhar, tenta baixar via fetch (com cookies da página)
      if (!imageBase64) {
        const response = await page.evaluate(async (src) => {
          try {
            const res = await fetch(src, { credentials: 'include' });
            if (!res.ok) return null;
            const blob = await res.blob();
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
              };
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            });
          } catch (e) {
            return null;
          }
        }, imgSrc).catch(()=>null);
        imageBase64 = response;
      }
    } catch (e) {
      return { ok: false, error: 'image_download_failed', details: (e && e.message) ? String(e.message) : String(e) };
    }

    if (!imageBase64) {
      return { ok: false, error: 'image_base64_failed' };
    }

    // 4. Chamar Groq API
    try {
      const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqCfg.groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: groqCfg.groqModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  // Regra enterprise: retornar somente os caracteres do captcha (sem espaços).
                  // Se não conseguir ler com 110% certeza, retornar vazio.
                  text: 'Read this captcha and return ONLY the captcha characters (letters and/or digits). Output ONLY the characters, no spaces, no punctuation, no quotes, no extra text. If unsure, return empty.'
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${imageBase64}`
                  }
                }
              ]
            }
          ],
          max_tokens: 50,
          temperature: 0
        })
      });

      if (!groqResponse.ok) {
        const errorText = await groqResponse.text().catch(()=>'');
        return { ok: false, error: 'groq_api_error', status: groqResponse.status, details: errorText.slice(0, 200) };
      }

      const groqData = await groqResponse.json().catch(()=>null);
      if (!groqData || !groqData.choices || !Array.isArray(groqData.choices) || !groqData.choices[0]) {
        return { ok: false, error: 'groq_invalid_response', data: groqData };
      }

      const rawText = String(groqData.choices[0].message?.content || '');
      if (!rawText) {
        return { ok: false, error: 'groq_empty_response' };
      }

      // 5. Processar resposta: extrair apenas o texto (remove comentários, explicações, etc.)
      // Groq pode retornar coisas como "The text is: ABC123" ou "ABC123" ou "Text: ABC123"
      // Precisamos extrair apenas os caracteres do captcha
      const rawTrim = String(rawText || '').trim();
      const rawHadWhitespace = /\s/.test(rawTrim);
      let cleanText = rawTrim
        .replace(/^(text|the text|text is|text:|the text is:|answer|answer is|answer:)\s*/i, '')
        .replace(/\s*(text|the text|text is|text:|the text is:|answer|answer is|answer:)\s*$/i, '')
        .replace(/^["']|["']$/g, '')
        .trim();

      // Mantém apenas alfanumérico e remove espaços.
      const used = String(cleanText || '').replace(/\s+/g, '').replace(/[^a-zA-Z0-9]/g, '').trim();

      // Guardrail: captcha típico é curto; rejeita strings longas/lixo.
      if (!used || used.length < 4 || used.length > 8) {
        return { ok: false, error: 'groq_text_bad_length', meta: { rawLength: rawTrim.length, rawHadWhitespace, cleanedLength: used.length } };
      }

      return { ok: true, text: used, meta: { rawLength: rawTrim.length, rawHadWhitespace, cleanedLength: used.length, imgSrc: imgSrc.slice(0, 120) } };
    } catch (e) {
      return { ok: false, error: 'groq_request_exception', details: (e && e.message) ? String(e.message) : String(e) };
    }
  } catch (e) {
    return { ok: false, error: 'solve_captcha_exception', details: (e && e.message) ? String(e.message) : String(e) };
  }
}


/**
 * Assistente safe para fluxo de identidade (selfie/vídeo).
 * Clica apenas quando um botão "aparece" e está habilitado, sem depender de classes:
 * prioridade: Concluir > Carregar > Avançar > Continuar.
 *
 * IMPORTANT:
 * - Não grava vídeo nem interage com câmera.
 * - Só atua quando o texto do body indica claramente o fluxo de identidade.
 */
async function identityAssistStep(page, { maxWaitMs = 60_000, tries = 2 } = {}) {
  const start = Date.now();
  const budget = Math.max(2_000, Number(maxWaitMs || 0) || 0);
  // IMPORTANT:
  // No fluxo real, o botão "Carregar" pode demorar 20–120s para habilitar.
  // Portanto, "tries" não pode limitar a espera; ele é apenas um mínimo de tentativas.
  const minTries = Math.max(1, Number(tries || 0) || 0);
  try {
    const href = (page && typeof page.url === 'function') ? (page.url() || '') : '';
    const isFbOrMsg = /(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(href);
    if (!isFbOrMsg) return { ok: false, error: 'not_fb_or_msg' };
  } catch {}

  const pickAndClick = async () => {
    try {
      return await page.evaluate(() => {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
        const href = norm(String(location && location.href ? location.href : ''));
        // Captcha/persona (aerr=1621002) é um fluxo humano; não deve receber cliques de "identidade".
        if (href.includes('aerr=1621002')) return { ok: false, error: 'captcha_persona_context' };
        const bodyTxt = norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
        // Só considerar "fluxo de identidade" quando houver sinais claros do fluxo de selfie/vídeo
        // (evita clicar em telas de checkpoint/captcha que também falam "pessoa real").
        const hasSelfieFlowSignal =
          bodyTxt.includes('iniciar selfie') ||
          bodyTxt.includes('selfie de video') ||
          bodyTxt.includes('selfie de vídeo') ||
          bodyTxt.includes('carregamento desse video') ||
          bodyTxt.includes('carregar') ||
          bodyTxt.includes('upload') ||
          bodyTxt.includes('selfie de video finalizada') ||
          bodyTxt.includes('selfie de vídeo finalizada');
        const looksIdentity =
          hasSelfieFlowSignal &&
          (bodyTxt.includes('confirme sua identidade') ||
          bodyTxt.includes('confirm your identity') ||
          bodyTxt.includes('identidade') ||
            bodyTxt.includes('confirmacao de identidade') ||
            bodyTxt.includes('confirmacao') ||
            bodyTxt.includes('confirm'));
        if (!looksIdentity) return { ok: false, error: 'not_identity_context' };

        const scope = document.querySelector('div[role="dialog"]') || document;
        // FB às vezes usa "role=none" para botões estilizados; então buscamos por texto também.
        const all = Array.from(scope.querySelectorAll('*')).slice(0, 1600);

        // Detecção de estágio (evita clicar "Confirmar" quando o primeiro passo ainda é "Continuar/Iniciar").
        const hasUploadStage =
          bodyTxt.includes('carregar') ||
          bodyTxt.includes('upload') ||
          bodyTxt.includes('carregamento desse video') ||
          bodyTxt.includes('selfie de video finalizada') ||
          bodyTxt.includes('selfie de vídeo finalizada');

        const priority = hasUploadStage
          ? [
          { key: 'carregar', words: ['carregar', 'upload'] },
              { key: 'enviar', words: ['enviar', 'submit'] },
              { key: 'confirmar', words: ['confirmar', 'confirm'] },
              { key: 'concluir', words: ['concluir', 'finalizar', 'finish', 'done'] },
          { key: 'avancar', words: ['avancar', 'avançar', 'next'] },
              { key: 'continuar', words: ['continuar', 'continue'] },
            ]
          : [
              // Estágio inicial: normalmente é Continuar/Avançar -> Iniciar selfie -> (só então) Carregar -> Confirmar/Concluir
              { key: 'continuar', words: ['continuar', 'continue'] },
              { key: 'avancar', words: ['avancar', 'avançar', 'next'] },
              { key: 'iniciar_selfie', words: ['iniciar selfie de video', 'iniciar selfie de vídeo', 'iniciar selfie', 'começar', 'comecar', 'start'] },
              { key: 'carregar', words: ['carregar', 'upload'] },
              { key: 'confirmar', words: ['confirmar', 'confirm'] },
              { key: 'concluir', words: ['concluir', 'finalizar', 'finish', 'done'] },
              { key: 'enviar', words: ['enviar', 'submit'] },
        ];
        const isDisabled = (el) => {
          try {
            return (el.getAttribute('aria-disabled') === 'true') || (el.getAttribute('disabled') != null) || (String(el.getAttribute('tabindex')||'') === '-1');
          } catch { return true; }
        };
        const isVisiblyClickable = (el) => {
          try {
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || r.width < 6 || r.height < 6) return false;
            const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!cs) return false;
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (cs.pointerEvents === 'none') return false;
            // Para div/span, exigir um indicativo de "click" para evitar falso positivo em containers.
            const tag = String(el.tagName || '').toLowerCase();
            if ((tag === 'div' || tag === 'span') && String(cs.cursor || '') !== 'pointer') return false;
            return true;
          } catch { return false; }
        };
        const textOf = (el) => norm(el.innerText || el.value || el.textContent || '');
        const aria = (el) => norm(el.getAttribute('aria-label') || '');
        const pickClickableContainer = (el) => {
          try {
            if (!el) return null;
            // Sobe para containers que geralmente recebem o click (sem depender de classes do FB).
            return (
              el.closest('button,[role="button"],a,input[type="submit"],[tabindex]') ||
              el
            );
          } catch { return el; }
        };
        const hitTestCenter = (el) => {
          try {
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || r.width < 6 || r.height < 6) return { ok: false, reason: 'no_rect' };
            const x = Math.floor(r.left + Math.min(r.width - 1, Math.max(2, r.width / 2)));
            const y = Math.floor(r.top + Math.min(r.height - 1, Math.max(2, r.height / 2)));
            const topEl = document.elementFromPoint(x, y);
            if (!topEl) return { ok: false, reason: 'no_element_from_point', x, y };
            const hit = (el === topEl) || el.contains(topEl) || topEl.contains(el);
            if (!hit) return { ok: false, reason: 'overlay_hit', x, y, topTag: String(topEl.tagName||'').toLowerCase() };
            return { ok: true, x, y };
          } catch { return { ok: false, reason: 'hit_test_failed' }; }
        };
        const isOffscreen = (el) => {
          try {
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r) return true;
            const vh = Math.max(0, window.innerHeight || 0);
            const vw = Math.max(0, window.innerWidth || 0);
            if (!vh || !vw) return true;
            // margem pequena: botão no rodapé pode ficar "quase visível" mas ainda fora.
            const margin = 16;
            const top = r.top, left = r.left, bottom = r.bottom, right = r.right;
            return (bottom < margin) || (top > (vh - margin)) || (right < margin) || (left > (vw - margin));
          } catch { return true; }
        };
        const scrollToMakeClickable = (el) => {
          let scrolled = false;
          let scrollReason = '';
          try {
            if (!el) return { scrolled: false, scrollReason: '' };
            if (isOffscreen(el)) {
              // Padrão do repo: behavior 'instant' (determinístico).
              try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); scrolled = true; scrollReason = 'offscreen_scrollIntoView'; } catch {}
            }
          } catch {}
          return { scrolled, scrollReason };
        };
        const scrollNudgeDown = () => {
          try {
            // micro-ajuste (uma rolada pequena) — útil quando o FB prende o botão no rodapé do conteúdo.
            window.scrollBy(0, Math.max(220, (window.innerHeight || 800) * 0.25));
            return true;
          } catch { return false; }
        };

        let bestDisabled = null;
        for (const p of priority) {
          for (const el of all) {
            if (!el) continue;
            const t = textOf(el);
            const al = aria(el);
            if (!p.words.some(w => t.includes(w) || al.includes(w))) continue;
            const b = pickClickableContainer(el);
            if (!b) continue;
            // Não gerar falso positivo: só clicar se estiver habilitado E realmente clicável.
            if (isDisabled(b) || !isVisiblyClickable(b)) {
              const cand = {
                ok: false,
                found: p.key,
                disabled: true,
                why: isDisabled(b) ? 'disabled_attr' : 'not_visible',
                ariaDisabled: b.getAttribute('aria-disabled'),
                tabindex: b.getAttribute('tabindex')
              };
              if (!bestDisabled) bestDisabled = cand;
              continue;
            }
            // 1) Auto-scroll mínimo antes do hit-test (resolve o caso do botão no rodapé).
            const s1 = scrollToMakeClickable(b);
            let ht = hitTestCenter(b);
            // 2) Se ainda falhar, faz um "nudge" curto e tenta mais uma vez (no máximo 1x).
            let nudge = false;
            if (!ht || !ht.ok) {
              const why0 = ht && ht.reason ? String(ht.reason) : '';
              if (why0 === 'no_element_from_point' || why0 === 'overlay_hit') {
                nudge = scrollNudgeDown();
                ht = hitTestCenter(b);
              }
            }
            if (!ht || !ht.ok) {
              const cand = {
                ok: false,
                found: p.key,
                disabled: true,
                why: ht && ht.reason ? ht.reason : 'hit_test',
                ariaDisabled: b.getAttribute('aria-disabled'),
                tabindex: b.getAttribute('tabindex'),
                scrolled: !!(s1 && s1.scrolled),
                scrollReason: (s1 && s1.scrollReason) ? String(s1.scrollReason) : '',
                nudged: !!nudge
              };
              if (!bestDisabled) bestDisabled = cand;
              continue;
            }
            return {
              ok: true,
              clicked: p.key,
              x: ht.x,
              y: ht.y,
              label: (b.getAttribute('aria-label') || '').slice(0, 80),
              text: (b.innerText || b.textContent || '').slice(0, 80),
              scrolled: !!(s1 && s1.scrolled),
              scrollReason: (s1 && s1.scrollReason) ? String(s1.scrollReason) : '',
              nudged: !!nudge
            };
          }
        }
        if (bestDisabled) return bestDisabled;
        return { ok: false, error: 'no_clickable_button' };
      });
    } catch (e) {
      return { ok: false, error: (e && e.message) ? String(e.message) : 'evaluate_failed' };
    }
  };

  let attempt = 0;
  let lastErr = '';
  let firstSeenAt = 0;
  let lastSeen = null;
  // Loop bounded por budget/minTries (P1: sem espera infinita)
  while (((Date.now() - start) < budget) || (attempt < minTries)) {
    attempt += 1;
    const r = await pickAndClick();
    if (r && r.ok && typeof r.x === 'number' && typeof r.y === 'number') {
      // Clique real (mouse) para evitar falso "click()" sem efeito.
      try { await page.mouse.click(r.x, r.y, { delay: 28 }).catch(()=>{}); } catch {}
      await sleep(650);
      return {
        ok: true,
        attempt,
        clicked: r.clicked,
        meta: {
          text: r.text || '',
          label: r.label || '',
          scrolled: !!r.scrolled,
          scrollReason: r.scrollReason || '',
          nudged: !!r.nudged
        }
      };
    }
    lastErr = (r && r.error) ? String(r.error) : 'no_click';
    if (r && r.found) {
      if (!firstSeenAt) firstSeenAt = Date.now();
      lastSeen = r;
    }
    const elapsed = Date.now() - start;
    if (elapsed >= budget && attempt >= minTries) break;
    // Polling curto: clica assim que habilitar (sem esperar "burro")
    await sleep(250);
    // Se nem apareceu botão alvo por alguns segundos, não fica preso numa página errada.
    if (!firstSeenAt && elapsed > 8_000 && attempt >= minTries) break;
  }
  return { ok: false, error: `no_step_clicked:${lastErr}`.slice(0, 120), waitedMs: Date.now() - start, attempts: attempt, lastSeen };
}

/**
 * Assistente safe para fluxo "conta restringida / pode ter sido invadida" (hacked cleanup + reset de senha).
 * Objetivo: clicar CTAs (Começar/Avançar/Continuar/Voltar) e, quando aparecer, preencher "nova senha" e clicar "Salvar alterações".
 */
async function hackedAssistStep(page, { newPassword = '', maxWaitMs = 45_000, tries = 2 } = {}) {
  const start = Date.now();
  const budget = Math.max(2_000, Number(maxWaitMs || 0) || 0);
  const minTries = Math.max(1, Number(tries || 0) || 0);
  const pass = String(newPassword || '').trim();
  try {
    const href = (page && typeof page.url === 'function') ? (page.url() || '') : '';
    const isFbOrMsg = /(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(href);
    if (!isFbOrMsg) return { ok: false, error: 'not_fb_or_msg' };
  } catch {}

  const attemptOnce = async () => {
    try {
      return await page.evaluate((pass) => {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
        const bodyTxt = norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
        const looksHacked =
          bodyTxt.includes('analise seus dados de login') ||
          bodyTxt.includes('analisar seus dados de login') ||
          bodyTxt.includes('proteja seus detalhes de login') ||
          bodyTxt.includes('pode ter sido invadida') ||
          bodyTxt.includes('conta pode ter sido invadida') ||
          bodyTxt.includes('agora crie uma nova senha') ||
          bodyTxt.includes('inserir nova senha') ||
          bodyTxt.includes('voce desbloqueou a sua conta') ||
          bodyTxt.includes('voce esta de volta ao facebook') ||
          bodyTxt.includes('voltar para o facebook');
        if (!looksHacked) return { ok: false, error: 'not_hacked_context' };

        // 1) Se houver inputs de senha, preencher primeiro (sem clicar em outros elementos).
        let filled = 0;
        try {
          const inputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(el => {
            try {
              const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              if (!r || r.width < 8 || r.height < 8) return false;
              const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
              if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
              return true;
            } catch { return false; }
          });
          if (pass && inputs.length) {
            for (const el of inputs.slice(0, 2)) {
              try {
                el.focus();
                el.value = '';
                el.value = pass;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                // Alguns fluxos (FB) só habilitam o CTA no blur (equivalente a TAB).
                try { el.dispatchEvent(new Event('blur', { bubbles: true })); } catch {}
                try { el.blur && el.blur(); } catch {}
                try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab', code: 'Tab' })); } catch {}
                filled++;
              } catch {}
            }
          }
        } catch {}

        const scope = document.querySelector('div[role="dialog"]') || document;
        const all = Array.from(scope.querySelectorAll('button,div[role="button"],a[role="button"],a')).slice(0, 900);
        const isDisabled = (el) => {
          try {
            return (el.getAttribute('aria-disabled') === 'true') || (el.getAttribute('disabled') != null) || (String(el.getAttribute('tabindex')||'') === '-1');
          } catch { return true; }
        };
        const isVis = (el) => {
          try {
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || r.width < 8 || r.height < 8) return false;
            const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
            if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
            if (cs.pointerEvents === 'none') return false;
            return true;
          } catch { return false; }
        };
        const txt = (el) => norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');

        // Prioridade militar: salvar senha > voltar > avançar/continuar
        const priority = [
          { key: 'salvar_alteracoes', words: ['salvar alteracoes', 'save changes', 'salvar'] },
          { key: 'voltar_para_fb', words: ['voltar para o facebook', 'back to facebook'] },
          { key: 'comecar', words: ['comecar', 'começar', 'start'] },
          { key: 'avancar', words: ['avancar', 'avançar', 'next'] },
          { key: 'continuar', words: ['continuar', 'continue'] },
        ];

        for (const p of priority) {
          for (const el of all) {
            if (!el) continue;
            const t = txt(el);
            if (!t) continue;
            if (!p.words.some(w => t.includes(w))) continue;
            if (isDisabled(el) || !isVis(el)) continue;
            try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch {}
            try { el.click(); } catch { continue; }
            return { ok: true, filled, clicked: p.key, text: t.slice(0, 60) };
          }
        }
        // Se não clicou nada, mas preencheu senha, consideramos progresso (sem reload).
        if (filled > 0) return { ok: true, filled, clicked: 'filled_password_only' };

        // Scroll nudge (virtualização: "Começar" pode não estar no DOM até rolar).
        try {
          const y0 = window.scrollY || 0;
          window.scrollBy(0, Math.max(220, Math.floor((window.innerHeight || 800) * 0.85)));
          const y1 = window.scrollY || 0;
          if (y1 !== y0) return { ok: true, filled, clicked: 'scroll_nudge' };
        } catch {}
        return { ok: false, error: 'no_hacked_step_clicked' };
      }, pass);
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  };

  let attempt = 0;
  let lastErr = 'none';
  while ((Date.now() - start) < budget) {
    attempt++;
    const r = await attemptOnce();
    if (r && r.ok) return { ok: true, ...r, waitedMs: Date.now() - start, attempts: attempt };
    lastErr = r && r.error ? String(r.error) : 'error';
    if (attempt >= minTries) {
      // Se não clicou nada em alguns segundos, não martela.
      if ((Date.now() - start) > 8_000) break;
    }
    await sleep(650);
  }
  return { ok: false, error: `no_hacked_step_clicked:${lastErr}`.slice(0, 120), waitedMs: Date.now() - start, attempts: attempt };
}

// ========= LOGIN (email/senha) =========
async function _maybeClickKeepConnected(page) {
  try {
    await page.evaluate(() => {
      const cb =
        document.querySelector('input[name="persistent"][type="checkbox"]') ||
        document.querySelector('input#default_persistent') ||
        document.querySelector('input[type="checkbox"][name="persistent"]');
      if (!cb) return false;
      if (cb.checked) return true;
      cb.click();
      return true;
    });
  } catch {}
}

async function _maybeClickUseAnotherProfile(page) {
  try {
    const did = await page.evaluate(() => {
      const norm = (s) => (s || '').toLowerCase();
      const a = Array.from(document.querySelectorAll('a,div[role="button"],span[role="button"]')).find(el => {
        const t = norm(el.innerText || el.textContent || '');
        return t.includes('usar outro perfil') || t.includes('use another profile');
      });
      if (!a) return false;
      if (typeof a.click === 'function') { a.click(); return true; }
      return false;
    });
    if (did) await sleep(800);
    return !!did;
  } catch {}
  return false;
}

/**
 * AYMH chooser: clica UMA vez em Continuar (sem match de nome / sem "Continuar como").
 * Objetivo: avançar para a próxima página (muitas vezes email/senha clássico).
 * Não clica "Usar outro perfil" — isso muda de conta; Continuar segue o perfil salvo.
 */
async function tryClickAymhContinuar(page) {
  try {
    if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
      return { ok: false, error: 'page_closed' };
    }
    const r = await page.evaluate(() => {
      function norm(s) {
        try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
        catch { return String(s || '').toLowerCase(); }
      }
      const bodyTxt = norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
      const hasUsarOutroPerfil =
        bodyTxt.includes('usar outro perfil') || bodyTxt.includes('use another profile');
      const hasEmail = !!document.querySelector('input[name="email"], input#email, input[type="email"]');
      const hasPass = !!document.querySelector('input[name="pass"], input#pass, input[type="password"]');
      if (!hasUsarOutroPerfil) return { ok: false, error: 'not_aymh_chooser' };
      if (hasEmail || hasPass) return { ok: false, error: 'already_has_login_inputs' };

      const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1600);
      let best = null;
      for (const el of candidates) {
        const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
        const txt = norm(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (/^continuar\s+como\b/.test(aria) || /^continue\s+as\b/.test(aria)) continue;
        if (/^continuar\s+como\b/.test(txt) || /^continue\s+as\b/.test(txt)) continue;
        const isContinuar =
          aria === 'continuar' || txt === 'continuar' || aria === 'continue' || txt === 'continue' ||
          /^continuar(\s|$)/.test(aria) || /^continue(\s|$)/.test(aria) ||
          /^continuar(\s|$)/.test(txt) || /^continue(\s|$)/.test(txt);
        if (!isContinuar) continue;
        const ariaDisabled = el.getAttribute && el.getAttribute('aria-disabled') === 'true';
        const tabIndex = el.getAttribute && el.getAttribute('tabindex') === '-1';
        if (ariaDisabled || tabIndex) continue;
        const r0 = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r0 || r0.width < 2 || r0.height < 2) continue;
        best = el;
        // Preferência: aria "Continuar …" (botão principal do card) sobre txt genérico
        if (aria && /^continuar(\s|$)/.test(aria)) break;
      }
      if (!best) return { ok: false, error: 'continuar_not_found' };
      try { best.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const rect = best.getBoundingClientRect ? best.getBoundingClientRect() : null;
      return {
        ok: true,
        x: rect ? (rect.left + rect.width / 2) : null,
        y: rect ? (rect.top + rect.height / 2) : null,
        label: (best.getAttribute && best.getAttribute('aria-label')) || ''
      };
    }).catch((e) => ({ ok: false, error: (e && e.message) || 'evaluate_failed' }));

    if (!(r && r.ok)) {
      return { ok: false, error: (r && r.error) ? String(r.error) : 'click_failed' };
    }
    // Um clique só: mouse real quando há coords; senão fallback DOM click.
    if (typeof r.x === 'number' && typeof r.y === 'number') {
      try { await page.mouse.click(r.x, r.y, { delay: 28 }).catch(() => {}); } catch {}
    } else {
      try {
        await page.evaluate(() => {
          function norm(s) {
            try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
            catch { return String(s || '').toLowerCase(); }
          }
          const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1600);
          for (const el of candidates) {
            const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
            const txt = norm(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^continuar\s+como\b/.test(aria) || /^continue\s+as\b/.test(aria)) continue;
            if (aria === 'continuar' || txt === 'continuar' || /^continuar(\s|$)/.test(aria) || /^continuar(\s|$)/.test(txt)) {
              try { el.click(); } catch {}
              return true;
            }
          }
          return false;
        });
      } catch {}
    }
    await sleep(1200);
    return { ok: true, label: r.label || '' };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : 'tryClickAymhContinuar_failed' };
  }
}

async function _maybeClickCloseX(page) {
  try {
    const did = await page.evaluate(() => {
      const btn = document.querySelector('[aria-label="Fechar"][role="button"], [aria-label="Close"][role="button"]');
      if (!btn) return false;
      const r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
      if (!r || r.width < 2 || r.height < 2) return false;
      btn.click();
      return true;
    });
    if (did) await sleep(800);
    return !!did;
  } catch {}
  return false;
}

async function tryLoginEmailPass(page, { login, password, nome, allowGpt = true, allowAymhContinue = false } = {}) {
  const email = String(login || '').trim();
  const pass = String(password || '').trim();
  if (!email || !pass) return { ok: false, error: 'missing_credentials' };

  // 1) destravar telas comuns:
  //    - RUNTIME: AYMH (Continuar + Usar outro perfil) = humano-only (NÃO clicar Continuar)
  //    - CADASTRO (allowAymhContinue): clica Continuar e segue pra senha / email+senha
  //    - se já tem form → NÃO clica "Usar outro perfil"
  //    - senão, "Usar outro perfil" só para cair no form em branco clássico
  await _maybeClickCloseX(page);
  try {
    const aymh = await detectLoginRequired(page).catch(() => null);
    const aymhReason = String((aymh && aymh.reason) || '').toLowerCase();
    if (aymh && aymh.loginRequired && (aymhReason.includes('aymh_continue') || aymhReason === 'aymh')) {
      if (!allowAymhContinue) {
        return { ok: false, error: 'aymh_continue_human_only' };
      }
      const clk = await tryClickAymhContinuar(page).catch(() => ({ ok: false }));
      if (!(clk && clk.ok)) {
        return { ok: false, error: 'aymh_continue_click_failed' };
      }
      await sleep(1200);
    }
  } catch {}
  try {
    const surface = await page.evaluate(() => {
      const hasEmail = !!document.querySelector('input[name="email"], input#email, input[type="email"]');
      const hasPass = !!document.querySelector('input[name="pass"], input#pass, input[type="password"]');
      return { hasEmail, hasPass };
    }).catch(() => ({ hasEmail: false, hasPass: false }));
    if (!(surface && (surface.hasEmail || surface.hasPass))) {
      // Em cadastro com AYMH, NÃO clicar "Usar outro perfil" — Continuar já foi o caminho.
      if (!allowAymhContinue) {
        await _maybeClickUseAnotherProfile(page);
        await sleep(700);
      }
    }
  } catch {}

  // 2) preencher formulário (FB / Messenger) — email opcional se a página só pedir senha
  try {
    await page.waitForTimeout(600);
  } catch {}

  try {
    // aguarda inputs aparecerem (evita “atropelo” de render)
    await page.waitForSelector('input[name="pass"], input#pass, input[type="password"]', { timeout: 12000 }).catch(()=>{});
    await page.waitForSelector('input[name="email"], input#email', { timeout: 2500 }).catch(()=>{});

    // limpa e digita com pequeno delay humano
    await page.evaluate(() => {
      const e = document.querySelector('input[name="email"], input#email');
      const p = document.querySelector('input[name="pass"], input#pass, input[type="password"]');
      if (e) e.value = '';
      if (p) p.value = '';
    }).catch(()=>{});
    const hasEmailSel = await page.$('input[name="email"], input#email').catch(() => null);
    if (hasEmailSel) {
      await page.type('input[name="email"], input#email', email, { delay: 28 }).catch(()=>{});
    }
    await page.type('input[name="pass"], input#pass, input[type="password"]', pass, { delay: 28 }).catch(()=>{});
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'type_failed' };
  }

  // 3) marcar "manter-me conectado" se existir
  await _maybeClickKeepConnected(page);

  // 4) submit (enterprise): click -> Enter -> form.submit -> GPT -> click (2a)
  try {
    // dá um respiro pra UI renderizar botões/handlers após preencher inputs
    await sleep(600);
    const clickLoginCta = () => page.evaluate(() => {
      function norm(s) {
        try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
        catch { return String(s || '').toLowerCase(); }
      }
      const classic =
        document.querySelector('button#loginbutton, button[name="login"], button[type="submit"], [data-testid="royal-login-button"]') ||
        document.querySelector('form#login_form button[type="submit"]') ||
        document.querySelector('form[data-testid="royal_login_form"] button[type="submit"]') ||
        document.querySelector('form#aymh_password_entry_view input[type="submit"]');
      if (classic) {
        try { classic.click(); return true; } catch { return false; }
      }
      // AYMH pós-Continuar: CTA "Entrar" é div[role=button], não <button type=submit>
      const candidates = Array.from(document.querySelectorAll('button,div[role="button"],a[role="button"]')).slice(0, 1600);
      for (const el of candidates) {
        const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
        const txt = norm(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        const tabIndex = el.getAttribute && el.getAttribute('tabindex') === '-1';
        const ariaDisabled = el.getAttribute && el.getAttribute('aria-disabled') === 'true';
        if (tabIndex || ariaDisabled) continue;
        const isEntrar =
          aria === 'entrar' || txt === 'entrar' ||
          aria === 'log in' || txt === 'log in' ||
          aria === 'sign in' || txt === 'sign in' ||
          /^entrar(\s|$)/.test(aria) || /^entrar(\s|$)/.test(txt);
        if (!isEntrar) continue;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        try { el.click(); return true; } catch {}
      }
      return false;
    }).catch(() => false);

    const clicked = await clickLoginCta();

    if (!clicked) {
      // fallback 1: Enter no campo senha
      try {
        await page.focus('input[name="pass"], input#pass, input[type="password"]').catch(()=>{});
        await page.keyboard.press('Enter').catch(()=>{});
        await sleep(450);
      } catch {}

      // fallback 2: form.submit() (inclui AYMH password entry)
      try {
        const submitted = await page.evaluate(() => {
          const form =
            document.querySelector('form#login_form') ||
            document.querySelector('form[data-testid="royal_login_form"]') ||
            document.querySelector('form#aymh_password_entry_view') ||
            document.querySelector('form[action*="/login/password/"]') ||
            document.querySelector('form[action*="/login/"]');
          if (!form) return false;
          try { form.submit(); return true; } catch { return false; }
        });
        if (submitted) await sleep(450);
      } catch {}

      // fallback 3: GPT (opcional) e tenta clique novamente 1x
      if (allowGpt && nome) {
        try { await gptRemediateFbUi(page, nome, { reason: 'login_submit_fallback', stage: 'login_submit' }); } catch {}
        await sleep(900);
        const clicked2 = await clickLoginCta();
        if (!clicked2) return { ok: false, error: 'login_submit_failed' };
      } else {
        // Sem GPT: ainda tenta CTA Entrar uma 2ª vez (AYMH password-only)
        const clicked2 = await clickLoginCta();
        if (!clicked2) return { ok: false, error: 'login_submit_failed' };
      }
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'click_failed' };
  }

  // 5) aguardar navegação estabilizar
  try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
  // “anti-atropelo”: alguns popups/redirects vêm 1-3s depois
  try { await sleep(2600); } catch {}
  // Validação “com olhos” (sem falso positivo): se ainda estiver em login_form, falha
  try {
    const lr = await detectLoginRequired(page).catch(()=>({ loginRequired:false }));
    if (lr && lr.loginRequired) return { ok: false, error: `still_login_required:${lr.reason||'login'}` };
  } catch {}
  return { ok: true };
}

async function collectFreshCookies(browser) {
  try {
    const pages = await browser.pages();
    const p0 = pages && pages[0];
    if (!p0) return { ok: false, error: 'no_pages' };
    // garantir que os domínios relevantes foram tocados (para preencher jar)
    await p0.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await sleep(1200);
    const cookiesMsg = await p0.cookies('https://www.messenger.com').catch(()=>[]);
    const cookiesFb = await p0.cookies('https://www.facebook.com').catch(()=>[]);
    const all = utils.normalizeCookies([...(cookiesMsg||[]), ...(cookiesFb||[])]);
    return { ok: true, cookies: all };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Detecta se a conta foi bloqueada de modo permanente/banida/suspensa.
 * Retorna { banned: true/false, reason, snippet }
 */
/**
 * Marketplace desativado: create/item|vehicle OU parede /marketplace/ineligible
 * (o FB redireciona o create para ineligible). NÃO rodar em Virtus/messages.
 * Textos: "Você não pode comprar ou vender..." e "O Marketplace não está disponível para você".
 */
async function detectMarketplaceDisabled(page) {
  async function readDisabledSignals() {
    return await page.evaluate(() => {
      function norm(s) {
        try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
        catch { return String(s || '').toLowerCase(); }
      }
      const nodes = Array.from(document.querySelectorAll('span,div,h1,h2')).slice(0, 2500);
      const texts = nodes.map((el) => (el.innerText || el.textContent || '')).filter(Boolean);
      const tnorm = texts.map(norm);
      const ineligible =
        tnorm.some((t) => t.includes('o marketplace nao esta disponivel para voce')) ||
        tnorm.some((t) => t.includes('marketplace is not available to you') || t.includes('marketplace isnt available to you')) ||
        tnorm.some((t) => t.includes('marketplace no esta disponible para ti') || t.includes('marketplace no esta disponible para usted'));
      const buySell =
        tnorm.some((t) => t.includes('voce nao pode comprar ou vender itens')) ||
        tnorm.some((t) => t.includes('voce nao pode comprar ou vender')) ||
        tnorm.some((t) => t.includes('you can\'t buy or sell items') || t.includes('you cannot buy or sell items')) ||
        tnorm.some((t) => t.includes('no puedes comprar ni vender articulos') || t.includes('no puedes comprar o vender'));
      const community =
        tnorm.some((t) => t.includes('padroes da comunidade') || t.includes('community standards') || t.includes('estandares de la comunidad'));
      let snippet = '';
      if (ineligible) {
        snippet =
          texts.find((s) => /marketplace nao esta disponivel|marketplace n[aã]o est[aá] dispon[ií]vel|marketplace isn'?t available|marketplace is not available|marketplace no esta disponible/i.test(norm(s))) ||
          texts.find((s) => /nao esta disponivel para voce|not available to you|no esta disponible para ti/i.test(norm(s))) ||
          '';
      } else if (buySell) {
        snippet =
          texts.find((s) => /comprar ou vender|buy or sell|comprar ni vender|comprar o vender/i.test(String(s || ''))) ||
          '';
      }
      if (!snippet) snippet = texts.slice(0, 20).join(' | ').slice(0, 420);
      return {
        ineligible: !!ineligible,
        buySell: !!buySell,
        community: !!community,
        snippet: String(snippet || '').slice(0, 420)
      };
    });
  }

  async function probeOnce() {
    try {
      const href = (page && typeof page.url === 'function') ? String(page.url() || '') : '';
      const isCreate = /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(href);
      const isIneligibleUrl = /facebook\.com\/marketplace\/ineligible/i.test(href);
      // Create (item/vehicle) ou a parede /ineligible (o FB redireciona o create para cá).
      if (!isCreate && !isIneligibleUrl) {
        return { disabled: false };
      }

      let signals = { ineligible: false, buySell: false, community: false, snippet: '' };
      try { signals = (await readDisabledSignals()) || signals; } catch {}

      if (isIneligibleUrl || signals.ineligible) {
        return {
          disabled: true,
          reason: 'ineligible',
          snippet: String(signals.snippet || 'marketplace/ineligible').slice(0, 420),
          communityStandards: false
        };
      }
      if (signals.buySell) {
        return {
          disabled: true,
          reason: 'cannot_buy_or_sell',
          snippet: String(signals.snippet || '').slice(0, 420),
          communityStandards: !!signals.community
        };
      }
    } catch {}
    return { disabled: false };
  }
  // 1ª leitura + 1 retry curto (redirect create → ineligible / DOM atrasado).
  let out = await probeOnce();
  if (out && out.disabled === true) return out;
  try { await new Promise((r) => setTimeout(r, 900)); } catch {}
  out = await probeOnce();
  return out || { disabled: false };
}

async function detectAccountSuspended(page) {
  try {
    const href = (page && typeof page.url === 'function') ? (page.url() || '') : '';
    const isFbOrMsg = /(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(href);
    if (!isFbOrMsg) return { banned: false };

    const v = await page.evaluate(() => {
      function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
      const href = String(location && location.href || '');
      const path = String(location && location.pathname || '');
      const nodes = Array.from(document.querySelectorAll('h1,h2,span,div')).slice(0,2500);
      const texts = nodes.map(el => (el.innerText || el.textContent || '')).filter(Boolean);
      const tnorm = texts.map(norm);

      // Multilíngue PT/EN/ES variantes para “suspensa/suspendida/suspended”
      const hit = tnorm.some(t =>
        t.includes('sua conta foi suspensa') ||
        t.includes('sua conta esta suspensa') ||
        t.includes('desabilitamos sua conta') ||
        t.includes('desativamos sua conta') ||
        t.includes('conta desabilitada') ||
        t.includes('conta desativada') ||
        t.includes('your account was suspended') ||
        t.includes('your account is suspended') ||
        t.includes('we disabled your account') ||
        t.includes('your account has been disabled') ||
        t.includes('tu cuenta ha sido suspendida') ||
        t.includes('tu cuenta esta suspendida')
      );

      // Evidência adicional contendo prazo/efeito (opcional e robusta)
      const more = tnorm.some(t =>
        t.includes('nao esta visivel no facebook') ||
        t.includes('you cannot use it right now') ||
        t.includes('no puedes usarla ahora') ||
        t.includes('sera desabilitada permanentemente') ||
        t.includes('will be permanently disabled') ||
        t.includes('voce nao pode solicitar outra analise') ||
        t.includes('you cannot request another review') ||
        t.includes('analisamos sua conta e constatamos') ||
        t.includes('we reviewed your account')
      );

      let snippet = '';
      // Alguns bans vêm como "disabled checkpoint" sem conter "suspensa" no texto (ex.: "Desabilitamos sua conta")
      const disabledCheckpoint =
        href.includes('disabled_checkpoint') ||
        path.includes('/checkpoint/dyi') ||
        path.includes('/checkpoint/disabled') ||
        path.includes('/checkpoint') && tnorm.some(t => t.includes('desabilitamos sua conta') || t.includes('we disabled your account'));

      const any = !!hit || !!disabledCheckpoint;
      if (any) {
        snippet =
          texts.find(s => /desabilitamos sua conta|desativamos sua conta|suspens/i.test(String(s||''))) ||
          texts.slice(0, 30).join(' | ').slice(0, 420);
      }
      return { hit: any, more, disabledCheckpoint, snippet };
    });

    if (v && v.hit) {
      const reason = v && v.disabledCheckpoint ? 'disabled_checkpoint' : 'suspended_ui';
      return { banned: true, reason, snippet: v.snippet || '' };
    }
  } catch {}
  return { banned: false };
}

module.exports = {
  openBrowser,
  configureProfile,
  invocarHumano,
  patchPage,
  blindarPaginaDaConta,
  newPageDaConta,
  bindAccountIdentity,
  resolvePatchCoordsForProfile,
  injectCookies,
  ensureMinimizedWindowForPage,
  pruneExtraWindows, // expose for worker (força prune)
  pruneHumanToOneTab, // militar: modo humano => 1 aba
  getPageCount: async function (browser) {
    if (!browser) return 0;
    try { return await browser.getPageCount(); } catch { return 0; }
  },
  forceCloseExtras: async function (browser) {
    if (!browser) return;
    try { await browser.forceCloseExtras(); } catch {}
  },
  forceCloseExtrasHard: async function (browser) {
    if (!browser) return;
    try {
      if (typeof browser.forceCloseExtrasHard === 'function') await browser.forceCloseExtrasHard();
      else if (typeof browser.forceCloseExtras === 'function') await browser.forceCloseExtras();
    } catch {}
  },
  attachHealthProbes, // NOVO!
  hardCleanProfileOnDisk,
  detectMessengerTempBlock, // NOVO: exportado para uso pelo worker
  detectLimitOverlayDeep,      // <----- NOVO
  detectLimitOverlayEverywhere,
  dismissAutomationSuspect,
  textHitsLimitNormalized,     // <----- NOVO (opcional, caso queira reusar)
  // ======= ADICIONE ESTES DOIS:
  resolveNonceIfPresent,
  clickContinuarComo,
  clickVoltarParaFacebook,
  // ==== Messenger PIN modal (exportado p/ worker curador)
  detectMessengerPinModal,
  tryDismissMessengerPinModal,
  gptRemediateFbUi,
  ensureFbUiUnblocked,
  installOneTabGuard,
  resolveOneTabHardCap,
  pageIsBlinding: _pageIsBlinding,
  installAboutBlankKiller,
  // ==== NOVOS:
  detectLoginRequired,
  detectVirtusIdentityBlock,
  tryClickAymhContinuar,
  // ==== CAPTCHA/CONFIRME-HUMANO (SEM OCR IMPLEMENTADO):
  clickContinueByLabel,
  waitForContinueEnabled,
  detectCaptchaChallenge,
  focusCaptchaInput,
  fillCaptchaAndContinue,
  waitForCaptchaTurnover,
  solveCaptchaWithGroq,
  identityAssistStep,
  hackedAssistStep,
  tryLoginEmailPass,
  collectFreshCookies,
  detectAccountSuspended,
  detectMarketplaceDisabled,
  killChromeProfileProcesses,
  closeChromeProfileProcessesGraceful,
  getChromeProfilePids,
  getChromeProfilePidsMeta
};