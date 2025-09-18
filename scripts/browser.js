// scripts/browser.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const utils = require('./utils.js');

puppeteer.use(StealthPlugin());

/**
 * Traz a janela do navegador para frente e maximiza.
 * Use SOMENTE ao injetar cookies ou invocar humano.
 */
async function bringWindowToFront(page) {
  try {
    await page.bringToFront();
    const client = await page.target().createCDPSession();
    const { windowId } = await client.send('Browser.getWindowForTarget');
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
  } catch (e) {
    try { await page.bringToFront(); } catch {}
  }
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
    console.log('[COOKIES] PARA INJETAR FINAL:', filtered);
    await page.setCookie(...filtered);
    console.log('[COOKIES] setCookie OK');
  } catch (e) {
    console.warn('[browser.js] Erro ao injetar cookies:', e && e.message);
  }
}

// ===============================
// patchPage agora usa leitura correta do manifest
// ===============================
async function patchPage(nome, page, coords) {
  // LEITURA DE MANIFEST VIA userDataDir DEFINIDO EM perfis.json
  const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const ua = manifest.uaString;
  const uaCh = manifest.uaCh || {};
  const viewport = manifest.fp?.viewport || { width: 1366, height: 768 };
  const dpr = manifest.fp?.dpr || 1;
  const hardwareConcurrency = manifest.fp?.hardwareConcurrency || 8;

  // --- PATCH FULL UA/UA-CH ---
  if (ua) await page.setUserAgent(ua);
  if (ua && uaCh && uaCh.brands) {
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.setUserAgentOverride', {
        userAgent: ua,
        userAgentMetadata: uaCh,
      });
    } catch(e) {
      console.warn('[patchPage] Falha ao setar UA-CH:', e && e.message);
    }
  }

  // --- IDIOMA E REGION ---
  await page.setExtraHTTPHeaders({ 'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' });
  await page.emulateTimezone('America/Sao_Paulo');

  // --- viewport, deviceScale, threads ---
  await page.evaluateOnNewDocument((hwc) => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hwc });
  }, hardwareConcurrency);

  // --- LANGUAGE/PLATFORM PATCH anti-detect ---
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'pt-BR' });
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });

  // --- GEOLOCALIZAÇÃO ---
  if (coords && coords.latitude) {
    try { await page.setGeolocation(coords); } catch(e){}
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
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

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

  if (enableVirtusMessengerBlock) {
    try {
      await page.setRequestInterception(true);
      page.on('request', req => {
        const reqUrl = req.url();
        // Não bloquear no Marketplace Create! (whitelist para create no marketplace)
        if (/facebook\.com\/marketplace\/create/.test(reqUrl)) return req.continue();
        const type = req.resourceType();
        // Block image, media, font, stylesheet exceto whitelist mínimos
        // Whitelist for Messenger:
        // Apenas permite arquivos JS/scripts, XHR, doc, fetch, ws, navigation; bloqueia o RESTANTE no Messenger
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
          // Whitelist mínima para Messenger — Aqui pode-se ajustar um mínimo para, ex, https://www.messenger.com/favicon.ico
          if (/favicon\.ico$/.test(reqUrl) && type === 'image') return req.continue();
          return req.abort();
        }
        return req.continue();
      });
      interceptionConfigured = true;
      //console.log('Virtus Messenger asset interception ativado para resourceType image/media/font/stylesheet');
    } catch (err) {
      //console.log('[Virtus] Messenger: interception failed: ', err && err.message || err);
    }
  }
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

// ==== ATENÇÃO: FUNÇÃO ALTERADA CONFORME SOLICITAÇÃO ====
async function focusWindowRobust(page, { cycles = 3 } = {}) {
  if (!page) return false;
  const target = page.target();
  let cdp = null;
  try { cdp = await target.createCDPSession(); } catch {}
  for (let i = 0; i < cycles; i++) {
    try { await page.bringToFront(); } catch {}
    if (cdp) {
      try {
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        if (windowId != null) {
          try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); } catch {}
          await sleep(35);
          try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch {}
          await sleep(35);
          try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }); } catch {}
          await sleep(35);
          try { await cdp.send('Page.bringToFront'); } catch {}
        }
      } catch {}
    }
    await sleep(55);
    // Não cheque hasFocus no meio, só no fim
  }
  return await hasFocus(page);
}
/* ==== FIM DA FUNÇÃO ALTERADA ==== */

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

/**
 * Mata processos do Chrome usando ESTE userDataDir (Windows).
 */
function killChromeProfileProcesses(userDataDir) {
  if (process.platform !== 'win32') return;
  try {
    const { execFileSync } = require('child_process');
    const dirForPs = userDataDir.replace(/\\/g, '\\\\').replace(/"/g, '""');
    const psCmd = `
      $p = [regex]::Escape("${dirForPs}");
      Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
        Where-Object { $_.CommandLine -match $p } |
        ForEach-Object {
          try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    `;
    execFileSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','-Bypass','-Command', psCmd], { stdio: 'ignore' });
  } catch (e) {
    try {
      const { execFileSync } = require('child_process');
      const needle = userDataDir.replace(/\\/g, '\\\\');
      const query = `name='chrome.exe' and CommandLine like '%${needle}%'`;
      execFileSync('wmic', ['process', 'where', query, 'call', 'terminate'], { stdio: 'ignore' });
    } catch {}
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
    console.log(`[BROWSER][${label}] (primeiras linhas) >>>\n${lines}\n<<< [fim do log]`);
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
function ensureChromeProfilePreferences(userDataDir) {
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
    writeJsonAtomic(prefsPath, prefs);

    // Local State
    const localStatePath = path.join(userDataDir, 'Local State');
    const ls = readJsonSafe(localStatePath, {}) || {};
    ls.exited_cleanly = true;
    writeJsonAtomic(localStatePath, ls);
  } catch (e) {
    try { console.warn('[BROWSER][prefs] falha ao normalizar preferências:', e && e.message || e); } catch {}
  }
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
  const t0 = Date.now();
  let iterations = 0;
  try {
    const proc = browser.process && browser.process();
    if (proc && proc.pid) {
      console.log(`[BROWSER][PID] ${proc.pid}`);
    }
  } catch {}

  // Proteção ULTRA CONSCIENTE
  try {
    if (
      robeMeta &&
      nome &&
      (
        (robeMeta[nome]?.emExecucao === true) ||
        (ctrl?.skipPruneUntil > Date.now())
      )
    ) {
      // Militar: prune adiado devido Robe emExecucao/skipPruneUntil
      if (process.env.DEBUG) {
        console.log(`[BROWSER][PRUNE][SKIP] Militar: prune adiado devido Robe emExecucao/skipPruneUntil para perfil ${nome}`);
      }
      return;
    }
  } catch {}

  let numPagesAfter = 0;

  while ((Date.now() - t0) < timeoutMs) {
    iterations++;
    try {
      const pages = await browser.pages();
      const pageInfos = [];
      for (const p of pages) {
        let u = '';
        try { u = p.url(); } catch {}
        pageInfos.push(u || 'about:blank');
      }
      if (pages.length <= 1) {
        if (iterations === 1) console.log(`[BROWSER][PRUNE] pages=${pages.length} urls=${JSON.stringify(pageInfos)}`);
        break;
      }
      console.log(`[BROWSER][PRUNE] detected ${pages.length} pages, closing extras... urls=${JSON.stringify(pageInfos)}`);
      // Mantém a mainPage; fecha as demais
      for (const p of pages) {
        if (p === mainPage) continue;
        try {
          await p.close({ runBeforeUnload: false }).catch(()=>{});
        } catch {}
      }
      // Pequena pausa e revalida
      await sleep(intervalMs);
    } catch (e) {
      break;
    }
  }

  // Atualiza robeMeta[nome].numPages pós-prune
  try {
    if (robeMeta && nome) {
      numPagesAfter = await browser.pages().then(arr => arr.length).catch(() => 0);
      robeMeta[nome].numPages = numPagesAfter;
      // Militar: numPages atualizado para painel
    }
  } catch {}

  return;
}

// END -- PRUNING PATCH

// ====== FIND CHROME STABLE - Only use Chrome Stable, nunca Chromium ======
function findChromeStable() {
  // 1. CHROME_PATH env explicit override
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  // 2. Default installs, by OS
  const candidates = [];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
    );
  } else {
    candidates.push(
      '/opt/google/chrome/chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium'
    );
  }
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  throw new Error('Chrome Stable não encontrado. Favor instalar o Chrome Stable OU setar a variável de ambiente CHROME_PATH.');
}

let globalPruneIntervalByBrowser = new Map(); // {browser: intervalId}

//
// For PRUNER attach
//
const robeMetaGlobal = {};   // { nome: { emExecucao: false, ... } }
const ctrlGlobal = {};       // { nome: { skipPruneUntil: 0, ... } }

/**
 * Ativar perfil: abre browser dedicado.
 */
async function openBrowser(manifest, { robeMeta=robeMetaGlobal, nome=manifest.nome, ctrl=ctrlGlobal[manifest.nome] || (ctrlGlobal[manifest.nome]={}) } = {}) {
  let browser = null;
  let pruneTimer = null;
  try {
    const coords = utils.getCoords(manifest.cidade || '');

    // GUARDA: RAM, userDataDir correto
    ensureUserDataDirUnderChrome(manifest);
    const userDataDir = manifest.userDataDir;

    // RAM: Garantir preferências, evitar restauração
    ensureChromeProfilePreferences(userDataDir);

    try { fs.accessSync(userDataDir, fs.constants.W_OK); } catch (e) {
      console.error('[BROWSER][DEBUG] ERRO NO userDataDir:', userDataDir, e && e.stack || e);
      throw new Error('UserDataDir sem permissão de escrita: ' + userDataDir);
    }

    // RAM: Encerra processos do perfil e limpa locks
    try { killChromeProfileProcesses(userDataDir); } catch {}
    try { cleanupUserDataLocks(userDataDir); } catch {}

    console.log('[BROWSER][DEBUG] userDataDir:', userDataDir);

    const chromeLogFile = path.join(userDataDir, 'chrome_launch.log');
    try { if (fs.existsSync(chromeLogFile)) fs.unlinkSync(chromeLogFile); } catch {}

    // FLAGS “OURO” ONLY!
    const launchArgs = [
      '--no-first-run', // Não exibe onboarding
      '--no-default-browser-check', // Não pergunta padrão
      '--password-store=basic', // Evita prompts/chaves desktop
      '--disable-notifications', // Silencia push/browser
      '--disable-extensions', // Zero extensão custom
      '--lang=pt-BR', // GOAL: idioma fixo PT-BR
      '--disable-background-timer-throttling', // Não pausa timers de fundo
      '--disable-backgrounding-occluded-windows', // Prev. throttling CPU tabs background
      '--disable-renderer-backgrounding', // Garantir render foreground
      '--process-per-site', // Cada site processo
      '--disable-features=TranslateUI,ProfilePicker,OptimizationHints,HardwareMediaKeyHandling,MediaRouter,AutomationControlled,CalculateNativeWinOcclusion', // DEFS: disable detection, hints, popups, media router, win occlusion
      '--disk-cache-size=104857600', // 100MB de cap em disco
      '--media-cache-size=0', // Zero cache de mídia
      '--window-size=1366,768', // Sempre inicializa janela visível/tamanho padrão
      '--start-maximized' // Maximizada sempre
      // Removido: 'no-zygote', 'single-process', 'disable-gpu', GPU flags
    ];

    // ENV para adicionar argumentos de debug
    const extraArgsEnv = (process.env.CHROME_EXTRA_ARGS || '').trim();
    if (extraArgsEnv) {
      const tokens = extraArgsEnv.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const cleaned = tokens.map(t => t.replace(/^"(.*)"$/, '$1')).filter(Boolean);
      if (cleaned.length) {
        console.log('[BROWSER][DEBUG] CHROME_EXTRA_ARGS:', cleaned);
        launchArgs.push(...cleaned);
      }
    }

    // HEADFUL sempre
    const isHeadless = process.env.OVERRIDE_HEADLESS === '1' || process.env.HEADLESS === '1';

    // DEFAULT VIEWPORT: null SEMPRE
    const defaultViewport = null;

    // GUARDA: Chrome Stable only
    const executablePath = findChromeStable();

    async function tryLaunch(args, tag) {
      try {
        if (process.env.DEBUG) {
          console.log(`>> [BROWSER][STEP] Puppeteer about to launch (${tag}).`);
        }
        const b = await puppeteer.launch({
          headless: isHeadless ? true : false,
          executablePath,
          userDataDir,
          args: launchArgs,
          defaultViewport,
          dumpio: !!process.env.DEBUG,
        });
        if (process.env.DEBUG) {
          const spawnargs = b.process && b.process() ? b.process().spawnargs : null;
          console.log('[BROWSER][DEBUG] spawnargs:', spawnargs);
        }
        return b;
      } catch (e) {
        if (process.env.DEBUG) {
          console.error(`[BROWSER][CRASH][${tag}]`, e && e.stack || e);
          printChromeLog(chromeLogFile, tag);
        } else {
          console.error(`[BROWSER][CRASH][${tag}]`, e && e.message || e);
        }
        return null;
      }
    }

    let browserTry = await tryLaunch(launchArgs, 'LAUNCH 1');

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      browserTry = await tryLaunch(launchArgs, 'LAUNCH 2');
    }

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      browserTry = await tryLaunch(launchArgs, 'LAUNCH 3');
    }

    if (!browserTry) {
      throw new Error('Browser não iniciou após 3 tentativas. Veja logs acima e o arquivo chrome_launch.log do perfil.');
    }
    browser = browserTry;

    // 1) Garantir pages()
    let pages;
    try {
      if (process.env.DEBUG) console.log('>> [BROWSER][STEP] browser.pages() about to call');
      pages = await browser.pages();
      if (process.env.DEBUG) console.log('>> [BROWSER][STEP] browser.pages() returned:', pages && pages.length);
    } catch (e) {
      await safeCloseBrowser(browser);
      throw e;
    }

    // 1.1) Janela única — fecha extras, se surgirem
    try {
      const mainPage = pages && pages[0];
      await pruneExtraWindows(browser, mainPage, { timeoutMs: 5000, intervalMs: 250, robeMeta, nome, ctrl });
      // GUARDA: RAM pruning ultra-militar - pruning periódico (2min)
      try {
        pruneTimer = setInterval(async () => {
          try {
            // Proteção: skip pruning se ativo
            await pruneExtraWindows(browser, (await browser.pages())[0], { timeoutMs: 5000, intervalMs: 250, robeMeta, nome, ctrl });
          } catch (_) {}
        }, 120 * 1000); // 120s
        globalPruneIntervalByBrowser.set(browser, pruneTimer);
        browser.once('disconnected', () => {
          if (pruneTimer) clearInterval(pruneTimer);
          globalPruneIntervalByBrowser.delete(browser);
        });
      } catch (_) {}
    } catch (e) {
      console.warn('[BROWSER][PRUNE] falha ao garantir janela única:', e && e.message || e);
    }

    // 2) Maximizar janela (se falhar, segue)
    try {
      const first = (await browser.pages())[0];
      const client = await first.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'maximized' }
      });
      if (process.env.DEBUG) console.log('>> [BROWSER][STEP] Janela maximizada [OK]');
    } catch (e) {
      if (process.env.DEBUG) console.warn('[BROWSER] Falha ao maximizar (seguindo normal):', e && e.message);
    }

    // 3) Permissões GEO (se falhar, segue)
    try {
      const context = browser.defaultBrowserContext();
      const origins = [
        'https://facebook.com',
        'https://www.facebook.com',
        'https://m.facebook.com',
        'https://business.facebook.com',
        'https://messenger.com',
        'https://www.messenger.com'
      ];
      for (const o of origins) {
        await context.overridePermissions(o, ['geolocation']);
      }
      if (process.env.DEBUG) console.log('>> [BROWSER][STEP] Permissão GEO concedida [OK]');
    } catch (e) {
      if (process.env.DEBUG) console.warn('[BROWSER][Permissão GEO] Falha ao conceder geolocalização:', e && e.message);
    }

    // 4) Espera por pelo menos 1 page pronta
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

    // 5) patchPage na primeira aba — se falhar, fecha e relança
    try {
      const page = (await browser.pages())[0];
      await patchPage(manifest.nome, page, coords);
    } catch (e) {
      await safeCloseBrowser(browser);
      throw e;
    }

    // RAM: expose pages (sanity check)
    browser.getPageCount = async () => (await browser.pages()).length;
    browser.forceCloseExtras = async () => {
      try {
        const pages = await browser.pages();
        if (pages && pages.length > 1) {
          const mainPage = pages[0];
          for (const p of pages.slice(1)) {
            if (typeof p.close === 'function') await p.close({ runBeforeUnload: false }).catch(()=>{});
          }
        }
      } catch {}
    };

    return browser;
  } catch (err) {
    try { await safeCloseBrowser(browser); } catch {}
    console.error('========================================================');
    if (process.env.DEBUG) {
      console.error('[BROWSER][ERRO FATAL ao abrir Puppeteer/browser]:', err && err.stack || err);
    } else {
      console.error('[BROWSER][ERRO FATAL ao abrir Puppeteer/browser]:', err && err.message || err);
    }
    console.error('========================================================');
    throw err;
  }
}

// ===============
// configureProfile USA A LEITURA correta do manifest
// ===============
async function configureProfile(browser, nome) {
  console.log('[CONFIG] Iniciando configureProfile para', nome);

  let pages;
  try {
    console.log('=== CHECKPOINT 1A: Antes de pegar pages (await browser.pages())');
    pages = await browser.pages();
    console.log('=== CHECKPOINT 1B: Depois de pegar pages (await browser.pages())');
  } catch (e) {
    console.error('[CONFIG][ERRO][CHECKPOINT 1][browser.pages()]:', e && e.stack ? e.stack : e);
    throw e;
  }

  // NOVO: TRAZ FOCO AO INJETAR COOKIES
  await bringWindowToFront(pages[0]);

  let page, manifest, coords;
  try {
    console.log('=== CHECKPOINT 2A: Antes de patchPage');
    page = pages[0];
    // LEITURA DE MANIFEST VIA userDataDir DEFINIDO EM perfis.json
    const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    coords = utils.getCoords(manifest.cidade || '');
    await patchPage(nome, page, coords);
    console.log('=== CHECKPOINT 2B: Depois de patchPage');
  } catch (e) {
    console.error('[CONFIG][ERRO][CHECKPOINT 2][patchPage]:', e && e.stack ? e.stack : e);
    throw e;
  }

  if (cookiesSeed) {
    try {
      console.log('=== CHECKPOINT 3A: Antes de preparar cookiesSeed ===');
      const utilsLocal = require('./utils.js');
      let cookiesArr = utilsLocal.normalizeCookies(cookiesSeed);
      console.log('[COOKIES][FINAL][PARA INJETAR]:', cookiesArr);

      const CRITICOS = ['c_user', 'xs', 'fr', 'sb', 'datr'];
      const now = Math.floor(Date.now() / 1000);
      const VENC = now + 180 * 24 * 60 * 60;

      cookiesArr = cookiesArr.map(c => {
        let ck = { ...c };
        if (CRITICOS.includes(ck.name)) {
          if (!ck.expirationDate || typeof ck.expirationDate !== 'number' || ck.expirationDate < now) ck.expirationDate = VENC;
          if (ck.expirationDate > 9999999999) ck.expirationDate = Math.floor(ck.expirationDate / 1000);
          ck.sameSite = 'None';
          ck.secure = true;
        }
        if (ck.name === 'c_user') ck.httpOnly = false;
        if (ck.name === 'xs') ck.httpOnly = true;
        if (!ck.domain) ck.domain = '.facebook.com';
        if (!ck.path) ck.path = '/';
        if (typeof ck.value === 'string') ck.value = ck.value.trim();
        if (typeof ck.name === 'string') ck.name = ck.name.trim();
        return ck;
      });

      if (cookiesArr.find(c => c.name === 'c_user') && cookiesArr.find(c => c.name === 'xs')) {
        try {
          console.log('=== CHECKPOINT 4A: Antes de limpeza de cookies via CDP');
          const client = await page.target().createCDPSession();
          await client.send('Network.clearBrowserCookies');
          console.log('=== CHECKPOINT 4B: Depois de limpeza de cookies via CDP');
        } catch(e) {
          console.warn('[CONFIG][ERRO][CHECKPOINT 4][Não conseguiu limpar cookies via CDP]:', e && e.stack ? e.stack : e);
        }

        for (const cookie of cookiesArr) {
          try {
            if (typeof cookie.expirationDate === "number") {
              cookie.expires = cookie.expirationDate;
              delete cookie.expirationDate;
            }
            if (cookie.name === 'c_user' && typeof cookie.value === 'string') {
              cookie.value = cookie.value.replace(/\s+/g,'');
            }
            if (CRITICOS.includes(cookie.name)) {
              const hostOnly1 = { ...cookie, url: 'https://facebook.com' }; delete hostOnly1.domain;
              const hostOnly2 = { ...cookie, url: 'https://www.facebook.com' }; delete hostOnly2.domain;
              const domainC = { ...cookie, domain: '.facebook.com' }; delete domainC.url;
              try { await page.setCookie(hostOnly1); } catch(e) { console.warn(`[CONFIG] setCookie hostOnly1 ${cookie.name}`, e && e.message); }
              try { await page.setCookie(hostOnly2); } catch(e) { console.warn(`[CONFIG] setCookie hostOnly2 ${cookie.name}`, e && e.message); }
              try { await page.setCookie(domainC); } catch(e) { console.warn(`[CONFIG] setCookie domainC ${cookie.name}`, e && e.message); }
            } else {
              try { await page.setCookie(cookie); } catch(e) { console.warn(`[CONFIG] setCookie other ${cookie.name}`, e && e.message); }
            }
          } catch(e) {
            console.warn(`[CONFIG] Loop setCookie ${cookie.name}`, e && e.message);
          }
        }

        try {
          const ckFb = await page.cookies('https://facebook.com');
          const ckWwwFb = await page.cookies('https://www.facebook.com');
          const ckMsg = await page.cookies('https://messenger.com');
          console.log('[COOKIES][DEPOIS DA INJEÇÃO][facebook.com]', ckFb);
          console.log('[COOKIES][DEPOIS DA INJEÇÃO][www.facebook.com]', ckWwwFb);
          console.log('[COOKIES][DEPOIS DA INJEÇÃO][messenger.com]', ckMsg);
        } catch(e){
          console.warn('[CONFIG][ERRO][CHECKPOINT 6][Log Final dos cookies]', e && e.stack ? e.stack : e);
        }
      } else {
        console.warn('[CONFIG] Cookies lidos não possuem c_user ou xs!');
      }
      console.log('=== CHECKPOINT 7: Fim de processamento cookiesSeed');
    } catch(e) {
      console.error('[CONFIG][ERRO][CHECKPOINT 3][Preparando/transformando cookiesSeed]:', e && e.stack ? e.stack : e);
      throw e;
    }
  }

  try {
    console.log('=== CHECKPOINT 8A: Antes de page.goto("https://facebook.com/")');
    await page.goto('https://facebook.com/', { waitUntil: 'domcontentloaded' }).catch((e) => {
      console.warn('[CONFIG][ERRO][CHECKPOINT 8][goto facebook.com.catch]:', e && e.stack ? e.stack : e);
    });

    try {
      const title = await page.title();
      const url = page.url();
      console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
    } catch(logerr) {
      console.log('[STATE] Erro ao obter título/URL após goto facebook.com:', logerr && logerr.stack ? logerr.stack : logerr);
    }

    console.log('=== CHECKPOINT 8B: Depois de page.goto("https://facebook.com/")');
  } catch(e) {
    console.error('[CONFIG][ERRO][CHECKPOINT 8][page.goto facebook.com]:', e && e.stack ? e.stack : e);
    throw e;
  }

  try {
    console.log('=== CHECKPOINT 9A: Antes do delay após logar/principal (6s) ===');
    await new Promise(r => setTimeout(r, 6000));
    console.log('=== CHECKPOINT 9B: Depois do delay após logar/principal (6s) ===');
  } catch(e) {
    console.error('[CONFIG][ERRO][CHECKPOINT 9][Delay de 6s após logar/principal]:', e && e.stack ? e.stack : e);
    throw e;
  }

  const openedPages = [];
  try {
    console.log('=== CHECKPOINT 10A: Antes de abrir abas auxiliares ===');
    openedPages[0] = page;

    // Aba 1 — criar item
    try {
      console.log('=== CHECKPOINT 10.1A: Antes de newPage (marketplace)');
      openedPages[1] = await browser.newPage();
      await patchPage(nome, openedPages[1], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[1].goto('https://www.facebook.com/marketplace', { waitUntil: 'domcontentloaded' }).catch((e) => {
        console.warn('[CONFIG][ERRO][CHECKPOINT 10.1][goto marketplace.catch]:', e && e.stack ? e.stack : e);
      });
      try {
        const title = await openedPages[1].title();
        const url = await openedPages[1].url();
        console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
      } catch(logerr) {
        console.log('[STATE] Erro ao obter título/URL após goto marketplace:', logerr && logerr.stack ? logerr.stack : logerr);
      }
      console.log('=== CHECKPOINT 10.1D: goto marketplace OK');
      await new Promise(r => setTimeout(r, 6000));
      console.log('=== CHECKPOINT 10.1E: Delay após marketplace OK');
    } catch(e) {
      console.error('[CONFIG][ERRO][CHECKPOINT 10.1][Aba Marketplace]:', e && e.stack ? e.stack : e);
    }

    // Aba 2 — idioma
    try {
      await new Promise(r => setTimeout(r, 1000));
      console.log('=== CHECKPOINT 10.2A: Antes de newPage (idioma)');
      openedPages[2] = await browser.newPage();
      await patchPage(nome, openedPages[2], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[2].goto('https://www.facebook.com/settings/?tab=language', { waitUntil: 'domcontentloaded' }).catch((e) => {
        console.warn('[CONFIG][ERRO][CHECKPOINT 10.2][goto idioma.catch]:', e && e.stack ? e.stack : e);
      });
      try {
        const title = await openedPages[2].title();
        const url = await openedPages[2].url();
        console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
      } catch(logerr) {
        console.log('[STATE] Erro ao obter título/URL após goto idioma:', logerr && logerr.stack ? logerr.stack : logerr);
      }
      console.log('=== CHECKPOINT 10.2D: goto idioma OK');
      await new Promise(r => setTimeout(r, 6000));
      console.log('=== CHECKPOINT 10.2E: Delay após idioma OK');
    } catch(e) {
      console.error('[CONFIG][ERRO][CHECKPOINT 10.2][Aba Idioma]:', e && e.stack ? e.stack : e);
    }

    // Aba 3 — messenger
    try {
      await new Promise(r => setTimeout(r, 1000));
      console.log('=== CHECKPOINT 10.3A: Antes de newPage (messenger)');
      openedPages[3] = await browser.newPage();
      await patchPage(nome, openedPages[3], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[3].goto('https://www.messenger.com/', { waitUntil: 'domcontentloaded' }).catch((e) => {
        console.warn('[CONFIG][ERRO][CHECKPOINT 10.3][goto messenger.catch]:', e && e.stack ? e.stack : e);
      });

      try {
        await openedPages[3].reload({ waitUntil: 'domcontentloaded' });
        await new Promise(r => setTimeout(r, 600));
      } catch(e) {
        console.log('[CONFIG][CHECKPOINT Messenger]: Erro no reload, segue...');
      }

      const SEL = 'button[type="submit"], button[aria-label*="Continuar"]';
      try {
        await openedPages[3].waitForSelector(SEL, { timeout: 12000, visible: true });
        await new Promise(r => setTimeout(r, 800));
        await Promise.all([
            openedPages[3].waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }),
            openedPages[3].click(SEL)
        ]);
        console.log('[CONFIG][CHECKPOINT Messenger]: Cliquei no botão "Continuar como..." e aguardei navegação.');
      } catch {
        console.log('[CONFIG][CHECKPOINT Messenger]: Botão não apareceu ou navegação falhou, segue normal.');
      }

      try {
        const title = await openedPages[3].title();
        const url = await openedPages[3].url();
        console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
      } catch(logerr) {
        console.log('[STATE] Erro ao obter título/URL após goto messenger:', logerr && logerr.stack ? logerr.stack : logerr);
      }
      console.log('=== CHECKPOINT 10.3D: goto messenger OK');
      await new Promise(r => setTimeout(r, 6000));
      console.log('=== CHECKPOINT 10.3E: Delay após messenger OK');
    } catch(e) {
      console.error('[CONFIG][ERRO][CHECKPOINT 10.3][Aba Messenger]:', e && e.stack ? e.stack : e);
    }

    console.log('=== CHECKPOINT 10B: Depois de abrir abas auxiliares ===');
  } catch(e) {
    console.error('[CONFIG][ERRO][CHECKPOINT 10][Abrindo abas auxiliares]:', e && e.stack ? e.stack : e);
    throw e;
  }

  // GUARDA: PRUNING pós-configureProfile (fechar extras, manter só main)
  try {
    if (browser && typeof browser.pages === 'function') {
      const allPages = await browser.pages();
      if (allPages.length > 1) {
        const mainPage = allPages[0];
        for (const p of allPages.slice(1)) {
          if (typeof p.close === 'function') await p.close({ runBeforeUnload: false }).catch(()=>{});
        }
        await pruneExtraWindows(browser, mainPage, { timeoutMs: 5000, intervalMs: 250 });
      }
    }
  } catch (e) {
    console.warn('[CONFIG] pruning extra windows pós-chamada configureProfile:', e && e.message);
  }

  console.log('=== CHECKPOINT 14: Todas abas abertas/logadas, firmadas e curadas. Configuração concluída!');
  console.log('[CONFIG] configureProfile FINALIZADO em', nome);
}

// ===============
// invocarHumano USA A LEITURA correta do manifest se precisar
// ===============
async function invocarHumano(browser, nome) {
  try {
    const pages = await browser.pages();
    const page = pages && pages[0];
    if (!page) return;
    // Traz foco ao navegador
    await bringWindowToFront(page);
    // Vai para o painel vendedor Marketplace
    const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
    try {
      await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      try { await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
    }
    // Garante focus de novo pós-navegação (opcional: repetir)
    await bringWindowToFront(page);
  } catch (e) {
    try { console.warn('[BROWSER][invocarHumano] erro:', e && e.message || e); } catch {}
  }
}

module.exports = {
  openBrowser,
  configureProfile,
  invocarHumano,
  patchPage,
  injectCookies,
  ensureMinimizedWindowForPage,
  pruneExtraWindows, // expose for worker (força prune)
  getPageCount: async function (browser) {
    if (!browser) return 0;
    try { return await browser.getPageCount(); } catch { return 0; }
  },
  forceCloseExtras: async function (browser) {
    if (!browser) return;
    try { await browser.forceCloseExtras(); } catch {}
  }
};