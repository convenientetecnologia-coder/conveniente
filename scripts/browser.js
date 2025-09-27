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
    if (process.env.BROWSER_DEBUG === '1') {
      console.log('[COOKIES] PARA INJETAR FINAL:', filtered);
    }
    await page.setCookie(...filtered);
    if (process.env.BROWSER_DEBUG === '1') {
      console.log('[COOKIES] setCookie OK');
    }
  } catch (e) {
    if (process.env.BROWSER_DEBUG === '1') {
      console.warn('[browser.js] Erro ao injetar cookies:', e && e.message);
    }
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
  try { if (ua) await page.setUserAgent(ua); } catch {}
  if (ua && uaCh && uaCh.brands) {
    try {
      const client = await page.target().createCDPSession();
      await client.send('Network.setUserAgentOverride', {
        userAgent: ua,
        userAgentMetadata: uaCh,
      });
    } catch(e) {
      if (process.env.BROWSER_DEBUG === '1') {
        console.warn('[patchPage] Falha ao setar UA-CH:', e && e.message);
      }
    }
  }

  // --- IDIOMA E REGION ---
  // ATENÇÃO: idioma/timezone agora podem ser configurados via env BROWSER_LANG e BROWSER_TZ
  const patchLang = process.env.BROWSER_LANG || 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7';
  const patchTz = process.env.BROWSER_TZ || 'America/Sao_Paulo';
  try { await page.setExtraHTTPHeaders({ 'accept-language': patchLang }); } catch {}
  try { await page.emulateTimezone(patchTz); } catch {}

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
            return req.abort();
          }
          if (type === 'image') {
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

/**
 * Mata processos do Chrome usando ESTE userDataDir (Windows).
 */
function killChromeProfileProcesses(userDataDir, openingMap) {
  if (process.platform !== 'win32') return;
  try {
    // Nunca mate Chromes associados ao map de perfis em abertura (openingMap[nome] = true).
    // Isso protege contra race de avalanche/init!
    if (openingMap && typeof openingMap === 'object' && userDataDir) {
      let nomePerfil = null;

      // 1) Tenta ler manifest.json dentro do próprio userDataDir
      try {
        const manifestPath = path.join(userDataDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest && manifest.nome) nomePerfil = String(manifest.nome);
        }
      } catch {}

      // 2) Tenta resolver via dados/perfis.json
      if (!nomePerfil) {
        try {
          const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
          if (Array.isArray(perfisArr)) {
            const perfil = perfisArr.find(p =>
              p && p.userDataDir &&
              path.normalize(String(p.userDataDir)) === path.normalize(String(userDataDir))
            );
            if (perfil && perfil.nome) nomePerfil = String(perfil.nome);
          }
        } catch {}
      }

      // 3) Fallback: tenta basenome do diretório
      if (!nomePerfil) {
        try {
          const base = path.basename(userDataDir);
          if (base && base.length && base !== 'Conveniente' && base !== 'User Data') {
            nomePerfil = base;
          }
        } catch {}
      }

      if (nomePerfil && openingMap[nomePerfil] === true) {
        if (process.env.BROWSER_DEBUG === '1') {
          console.log(`[BROWSER] SKIP KILL, nome em opening: ${nomePerfil}`);
        }
        return; // Proteção: não mata processos deste perfil enquanto está em abertura
      }
    }

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
    try { if (process.env.BROWSER_DEBUG === '1') { console.warn('[BROWSER][prefs] falha ao normalizar preferências:', e && e.message || e); } } catch {}
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
      if (process.env.BROWSER_DEBUG === '1') {
        console.log(`[BROWSER][PID] ${proc.pid}`);
      }
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
      if (process.env.BROWSER_DEBUG === '1') {
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
        if (iterations === 1 && process.env.BROWSER_DEBUG === '1') console.log(`[BROWSER][PRUNE] pages=${pages.length} urls=${JSON.stringify(pageInfos)}`);
        break;
      }
      if (process.env.BROWSER_DEBUG === '1') {
        console.log(`[BROWSER][PRUNE] detected ${pages.length} pages, closing extras... urls=${JSON.stringify(pageInfos)}`);
      }
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

// ====== FIND CHROME STABLE ======
// Tenta Chrome Stable por CHROME_PATH/CHROMIUM_PATH variáveis de ambiente, depois paths padrão de OS.
function findChromeStable() {
  const envChrome = process.env.CHROME_PATH;
  if (envChrome && fs.existsSync(envChrome)) {
    return envChrome;
  }
  const envChromium = process.env.CHROMIUM_PATH;
  if (envChromium && fs.existsSync(envChromium)) {
    return envChromium;
  }

  // Default installs, by OS
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

  // Adiciona ao final dos candidatos o path do Chromium por variável de ambiente, se definido
  if (envChromium) {
    candidates.push(envChromium);
  }

  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
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
    try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
    try { cleanupUserDataLocks(userDataDir); } catch {}

    if (process.env.BROWSER_DEBUG === '1') {
      console.log('[BROWSER][DEBUG] userDataDir:', userDataDir);
    }

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
        if (process.env.BROWSER_DEBUG === '1') {
          console.log('[BROWSER][DEBUG] CHROME_EXTRA_ARGS:', cleaned);
        }
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
        if (process.env.BROWSER_DEBUG === '1') {
          console.log(`>> [BROWSER][STEP] Puppeteer about to launch (${tag}).`);
        }
        const b = await puppeteer.launch({
          headless: isHeadless ? true : false,
          executablePath,
          userDataDir,
          args: launchArgs,
          defaultViewport,
          dumpio: !!process.env.BROWSER_DEBUG,
        });
        if (process.env.BROWSER_DEBUG === '1') {
          const spawnargs = b.process && b.process() ? b.process().spawnargs : null;
          console.log('[BROWSER][DEBUG] spawnargs:', spawnargs);
        }
        return b;
      } catch (e) {
        if (process.env.BROWSER_DEBUG === '1') {
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
      try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      browserTry = await tryLaunch(launchArgs, 'LAUNCH 2');
    }

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
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
      if (process.env.BROWSER_DEBUG === '1') console.log('>> [BROWSER][STEP] browser.pages() about to call');
      pages = await browser.pages();
      if (process.env.BROWSER_DEBUG === '1') console.log('>> [BROWSER][STEP] browser.pages() returned:', pages && pages.length);
    } catch (e) {
      await safeCloseBrowser(browser);
      throw e;
    }

    // 1.1) Inicialmente NÃO execute prune nem arme timer de prune durante abertura/configuração.
    // Só rode pruning/timer após entrar realmente em modo de produção (Virtus ON/start_work).
    // Permaneça inativo aqui.

    // 2) Maximizar janela (se falhar, segue)
    try {
      const first = (await browser.pages())[0];
      const client = await first.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'maximized' }
      });
      if (process.env.BROWSER_DEBUG === '1') console.log('>> [BROWSER][STEP] Janela maximizada [OK]');
    } catch (e) {
      if (process.env.BROWSER_DEBUG === '1') console.warn('[BROWSER] Falha ao maximizar (seguindo normal):', e && e.message);
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
      if (process.env.BROWSER_DEBUG === '1') console.log('>> [BROWSER][STEP] Permissão GEO concedida [OK]');
    } catch (e) {
      if (process.env.BROWSER_DEBUG === '1') console.warn('[BROWSER][Permissão GEO] Falha ao conceder geolocalização:', e && e.message);
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
    if (process.env.BROWSER_DEBUG === '1') {
      console.error('[BROWSER][ERRO FATAL ao abrir Puppeteer/browser]:', err && err.stack || err);
    } else {
      console.error('[BROWSER][ERRO FATAL ao abrir Puppeteer/browser]:', err && err.message || err);
    }
    console.error('========================================================');
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
      try { if (process.env.BROWSER_DEBUG === '1') { console.log(`${logPrefix} clickByXPath err:`, e && e.message || e); } } catch {}
    }
  }
  return false;
}

async function resolveNonceIfPresent(page, { logPrefix='[messenger][nonce]', maxCycles = 3 } = {}) {
  for (let i = 0; i < maxCycles; i++) {
    const url = page.url() || '';
    if (!/messenger.com\/login\/nonce/i.test(url)) return true;

    try { if (process.env.BROWSER_DEBUG === '1') { console.log(`${logPrefix} detectado em ${url}`); } } catch {}

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
  // Seletor CSS universal para “Continuar como ...”
  const btn = await waitAny(page, [
    'button[type="submit"]',
    'button[aria-label*="Continuar"]',
    'div[role="button"][aria-label*="Continuar"]',
    'button[aria-label*="Continue"]',
    'div[role="button"][aria-label*="Continue"]'
  ], { timeout, visible: true });

  if (btn) {
    try {
      await page.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }), btn);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}),
        btn.click({ delay: 80 })
      ]);
      return true;
    } catch (e) {
      try { if (process.env.BROWSER_DEBUG === '1') { console.log(`${logPrefix} click via CSS falhou:`, e && e.message || e); } } catch {}
    }
  }

  // Fallback por XPath
  const ok = await clickByXPath(page, [
    '//button[contains(.,"Continuar") or .//span[contains(.,"Continuar")]]',
    '//div[@role="button"][.//span[contains(.,"Continuar")]]',
    '//button[contains(.,"Continue") or .//span[contains(.,"Continue")]]'
  ], { waitNav: true, timeoutNav: 15000, logPrefix });

  return ok;
}

// ===============
// configureProfile USA A LEITURA correta do manifest
// ===============
async function configureProfile(browser, nome, cookiesOverride = null) {
  if (process.env.CONFIGURE_DEBUG === '1') {
    console.log('[CONFIG] Iniciando configureProfile para', nome);
  }

  let pages;
  try {
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 1A: Antes de pegar pages (await browser.pages())');
    pages = await browser.pages();
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 1B: Depois de pegar pages (await browser.pages())');
  } catch (e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      console.error('[CONFIG][ERRO][CHECKPOINT 1][browser.pages()]:', e && e.stack ? e.stack : e);
    }
    throw e;
  }

  // NOVO: TRAZ FOCO AO INJETAR COOKIES
  await bringWindowToFront(pages[0]);

  let page, manifest, coords;
  try {
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 2A: Antes de patchPage');
    page = pages[0];
    // LEITURA DE MANIFEST VIA userDataDir DEFINIDO EM perfis.json
    const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    coords = utils.getCoords(manifest.cidade || '');
    await patchPage(nome, page, coords);
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 2B: Depois de patchPage');
  } catch (e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      console.error('[CONFIG][ERRO][CHECKPOINT 2][patchPage]:', e && e.stack ? e.stack : e);
    }
    throw e;
  }

  // ==================== PATCH INJEÇÃO UNIVERSAL ====================
  // Injete TODOS os cookies (normalizados) direto na Facebook antes de navegar:
  await injectCookies(pages[0], manifest.cookies);
  // ================================================================

  try {
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 8A: Antes de page.goto("https://facebook.com/")');
    await pages[0].goto('https://facebook.com/', { waitUntil: 'domcontentloaded' }).catch((e) => {
      if (process.env.CONFIGURE_DEBUG === '1') {
        console.warn('[CONFIG][ERRO][CHECKPOINT 8][goto facebook.com.catch]:', e && e.stack ? e.stack : e);
      }
    });

    try {
      const title = await pages[0].title();
      const url = pages[0].url();
      if (process.env.CONFIGURE_DEBUG === '1') {
        console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
      }
    } catch(logerr) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        console.log('[STATE] Erro ao obter título/URL após goto facebook.com:', logerr && logerr.stack ? logerr.stack : logerr);
      }
    }

    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 8B: Depois de page.goto("https://facebook.com/")');
  } catch(e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      console.error('[CONFIG][ERRO][CHECKPOINT 8][page.goto facebook.com]:', e && e.stack ? e.stack : e);
    }
    throw e;
  }

  try {
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 9A: Antes do delay após logar/principal (6s) ===');
    await new Promise(r => setTimeout(r, 6000));
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 9B: Depois do delay após logar/principal (6s) ===');
  } catch(e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      console.error('[CONFIG][ERRO][CHECKPOINT 9][Delay de 6s após logar/principal]:', e && e.stack ? e.stack : e);
    }
    throw e;
  }

  const openedPages = [];
  try {
    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10A: Antes de abrir abas auxiliares ===');
    openedPages[0] = pages[0];

    // Aba 1 — criar item
    try {
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.1A: Antes de newPage (marketplace)');
      openedPages[1] = await browser.newPage();
      await patchPage(nome, openedPages[1], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[1].goto('https://www.facebook.com/marketplace', { waitUntil: 'domcontentloaded' }).catch((e) => {
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.warn('[CONFIG][ERRO][CHECKPOINT 10.1][goto marketplace.catch]:', e && e.stack ? e.stack : e);
        }
      });
      try {
        const title = await openedPages[1].title();
        const url = await openedPages[1].url();
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
        }
      } catch(logerr) {
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log('[STATE] Erro ao obter título/URL após goto marketplace:', logerr && logerr.stack ? logerr.stack : logerr);
        }
      }
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.1D: goto marketplace OK');
      await new Promise(r => setTimeout(r, 6000));
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.1E: Delay após marketplace OK');
    } catch(e) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        console.error('[CONFIG][ERRO][CHECKPOINT 10.1][Aba Marketplace]:', e && e.stack ? e.stack : e);
      }
    }

    // Aba 2 — idioma
    try {
      await new Promise(r => setTimeout(r, 1000));
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.2A: Antes de newPage (idioma)');
      openedPages[2] = await browser.newPage();
      await patchPage(nome, openedPages[2], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[2].goto('https://www.facebook.com/settings/?tab=language', { waitUntil: 'domcontentloaded' }).catch((e) => {
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.warn('[CONFIG][ERRO][CHECKPOINT 10.2][goto idioma.catch]:', e && e.stack ? e.stack : e);
        }
      });
      try {
        const title = await openedPages[2].title();
        const url = await openedPages[2].url();
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
        }
      } catch(logerr) {
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log('[STATE] Erro ao obter título/URL após goto idioma:', logerr && logerr.stack ? logerr.stack : logerr);
        }
      }
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.2D: goto idioma OK');
      await new Promise(r => setTimeout(r, 6000));
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.2E: Delay após idioma OK');
    } catch(e) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        console.error('[CONFIG][ERRO][CHECKPOINT 10.2][Aba Idioma]:', e && e.stack ? e.stack : e);
      }
    }

    // Aba 3 — MESSENGER: PATCH UNIVERSAL COOKIES
    try {
      await new Promise(r => setTimeout(r, 1000));
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.3A: Antes de newPage (messenger)');
      openedPages[3] = await browser.newPage();
      await patchPage(nome, openedPages[3], coords);
      await new Promise(r => setTimeout(r, 1000));

      // 1. Injete cookies (normalizados) ANTES de navegar:
      await injectCookies(openedPages[3], manifest.cookies);

      // 2. Vai para Messenger e FAZ RELOAD (comportamento do legado!):
      await openedPages[3].goto('https://www.messenger.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      await sleep(800);
      try {
        await openedPages[3].reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(800);
      } catch {
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log('[CONFIG][Messenger] reload inicial falhou, seguindo...');
        }
      }

      // 3. Resolve nonce se aparecer:
      await resolveNonceIfPresent(openedPages[3], { logPrefix: '[CONFIG][Messenger][nonce]' });

      // 4. TENTA CLIQUE CONTINUAR COMO... (super robusto!)
      const clicked = await clickContinuarComo(openedPages[3], { logPrefix: '[CONFIG][Messenger][continuar]' });

      if (!clicked) {
        // 5. Tente resolver nonce e clique de novo
        await resolveNonceIfPresent(openedPages[3], { logPrefix: '[CONFIG][Messenger][nonce-2]' });
        await clickContinuarComo(openedPages[3], { logPrefix: '[CONFIG][Messenger][continuar-2]' });
      }

      // 6. Loga título/URL final
      try {
        const title = await openedPages[3].title();
        const url = await openedPages[3].url();
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log(`[STATE] Messenger Após fluxo: "${title}" | URL: ${url}`);
        }
      } catch(logerr) {
        if (process.env.CONFIGURE_DEBUG === '1') {
          console.log('[STATE] Erro ao obter título/URL após fluxo messenger:', logerr && logerr.stack ? logerr.stack : logerr);
        }
      }
      if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10.3Z: Fluxo Messenger finalizado (robusto)');

      await new Promise(r => setTimeout(r, 4000)); // settle curto
    } catch(e) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        console.error('[CONFIG][ERRO][CHECKPOINT 10.3][Aba Messenger robusta]:', e && e.stack ? e.stack : e);
      }
    }
    // FIM ABA MESSENGER PATCH UNIVERSAL COOKIES

    if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 10B: Depois de abrir abas auxiliares ===');
  } catch(e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      console.error('[CONFIG][ERRO][CHECKPOINT 10][Abrindo abas auxiliares]:', e && e.stack ? e.stack : e);
    }
    throw e;
  }

  // (REMOVIDO BLOCO DE PRUNING APÓS CONFIGURATION CONFORME INSTRUÇÃO)

  if (process.env.CONFIGURE_DEBUG === '1') console.log('=== CHECKPOINT 14: Todas abas abertas/logadas, firmadas e curadas. Configuração concluída!');
  if (process.env.CONFIGURE_DEBUG === '1') console.log('[CONFIG] configureProfile FINALIZADO em', nome);
}

// ===============
// invocarHumano USA A LEITURA correta do manifest se precisar
// Desabilitado por padrão: abrir interface/painel automático só pode via opt-in, frontend ou chamada manual/intencional.
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
    try { if (process.env.BROWSER_DEBUG === '1') { console.warn('[BROWSER][invocarHumano] erro:', e && e.message || e); } } catch {}
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
        window.addEventListener('unhandledrejection', (e) => safeCall({ type:'js_unhandledrejection', msg: (e && (e.reason && e.reason.message || e.reason)) || '' }));
      })();
    });
  } catch {}
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
  },
  attachHealthProbes, // NOVO!
};