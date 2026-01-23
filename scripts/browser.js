// scripts/browser.js
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const utils = require('./utils.js');
const logger = require('./logger.js');
const gptFallback = require('./gptFallback.js');

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
        logger.warn('[patchPage] Falha ao setar UA-CH: ' + (e && e.message));
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
            if (process.env.VIRTUS_BLOCK_IMAGES === '1') {
              if (/favicon\.ico$/i.test(u)) return req.continue();
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
  } catch {}
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
    const ps = `
      $procs = Get-CimInstance Win32_Process |
        Where-Object { $_.Name -eq 'chrome.exe' -or $_.Name -eq 'chromium.exe' } |
        Select-Object ProcessId, Name, CommandLine;
      $procs | ConvertTo-Json -Compress
    `;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024 }
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
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mata processos do Chrome usando ESTE userDataDir (Windows).
 * Implementação real usando PowerShell + taskkill.
 */
function killChromeProfileProcesses(userDataDir, openingMap) {
  if (process.platform !== 'win32') return;
  try {
    const expected = normalizePathForCompare(userDataDir);
    if (!expected) return;
    const procs = listChromeProcessesWin();
    const toKill = new Set();
    for (const pr of procs) {
      const ud = extractUserDataDirFromCmd(pr.cmd);
      if (ud) {
        if (normalizePathForCompare(ud) === expected) {
          toKill.add(pr.pid);
        }
      } else {
        // fallback: se não achou o param, mas cmd contém o path inteiro
        if (pr.cmd && normalizePathForCompare(pr.cmd).includes(expected)) {
          toKill.add(pr.pid);
        }
      }
    }
    if (!toKill.size) return;
    let killed = 0;
    for (const pid of toKill) {
      if (taskkillTreeWin(pid)) killed++;
    }
    try {
      if (killed > 0) {
        logger.warn('[BROWSER][KILL][userDataDir] Chrome órfão removido', { userDataDir, killed });
      }
    } catch {}
  } catch {}
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
    try { if (process.env.BROWSER_DEBUG === '1') { logger.warn('[BROWSER][prefs] falha ao normalizar preferências: ' + ((e && e.message) || e)); } } catch {}
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
  // 1) Sempre fecha about:blank extras (nunca aguarda flags)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      try {
        if (mainPage && p === mainPage) continue;
        if (!mainPage && pages[0] && p === pages[0]) continue;
        let u = ''; try { u = p.url(); } catch {}
        if (!u || u === 'about:blank') {
          await p.close({ runBeforeUnload: false }).catch(()=>{});
        }
      } catch {}
    }
  } catch {}

  // 2) Se em Robe/config/etc, não faz prune amplo
  const isRobeActive = robeMeta && nome && robeMeta[nome] && robeMeta[nome].emExecucao === true;
  const sendLockActive = ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active;
  const isConfig = ctrl && ctrl.configurando === true;
  const isHuman = ctrl && ctrl.humanControl === true;
  const robeActiveFor = (browser && browser._robeActiveFor === nome);

  if (isRobeActive || robeActiveFor || sendLockActive || isConfig || isHuman) {
    return;
  }

  // 3) Prune amplo padrão (mais de 1 page)
  const t0 = Date.now();
  while ((Date.now() - t0) < timeoutMs) {
    try {
      const pages = await browser.pages();
      if (pages.length <= 1) break;
      for (const p of pages) {
        if (mainPage && p === mainPage) continue;
        if (!mainPage && pages[0] && p === pages[0]) continue;
        let u = ''; try { u = p.url(); } catch {}
        if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue;
        await p.close({ runBeforeUnload: false }).catch(()=>{});
      }
      await sleep(intervalMs);
    } catch { break; }
  }
}

// END -- PRUNING PATCH

// ===== Hard One-Tab Guard (evento alvo criado/destruído) =====
function installOneTabGuard(browser, nome, {
  allow = () => false,              // função externa que diz se “mais de 1 aba” é permitido
  maxPagesWhenAllow = 2,            // máximo permitido quando allow() é true (Robe/config)
  onNumPages = null,                // callback para atualizar robeMeta[nome].numPages
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
        const pages = await browser.pages();
        let limOpt = (typeof maxPagesWhenAllow === 'function') ? Number(maxPagesWhenAllow()) : Number(maxPagesWhenAllow);
        if (!Number.isFinite(limOpt) || limOpt < 1) limOpt = 1;
        const lim = (allow && allow()) ? limOpt : 1;
        if (Array.isArray(pages) && pages.length > lim) {
          // Mantenha a primeira (main) e feche todas as demais
          for (let i = pages.length - 1; i >= 1; i--) {
            if (pages.length <= lim) break;
            const p = pages[i];
            let u = '';
            try { u = await p.url().catch(()=>''); } catch {}
            if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue; // Nunca fechar create item
            try { await p.close({ runBeforeUnload: false }).catch(()=>{}); }
            catch {}
          }
          const cur = await browser.pages();
          log('[PRUNER][HARD] Guard fechou abas extras', { nome, final: (cur && cur.length) || 0, lim });
        }
      } catch (e) {
        if (process.env.PRUNE_DEBUG === '1') {
          log('[PRUNER][HARD] erro enforce', { nome, error: (e && e.message) || String(e) });
        }
      } finally {
        await reportNum();
      }
    }

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

    // Varredura inicial
    setTimeout(enforceHardCap, 400);

  } catch {}
}

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
      logger.error('[BROWSER][DEBUG] ERRO NO userDataDir:', { userDataDir }, e);
      throw new Error('UserDataDir sem permissão de escrita: ' + userDataDir);
    }

    // RAM: Encerra processos do perfil e limpa locks
    try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
    try { cleanupUserDataLocks(userDataDir); } catch {}

    if (process.env.BROWSER_DEBUG === '1') {
      logger.debug('[BROWSER][DEBUG] userDataDir: ' + userDataDir);
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

    // Permite ativar auto-aceite da permissão de camera/mic real por flag do Chrome, via env
    if (process.env.MEDIA_AUTO_UI === '1') {
      launchArgs.push('--use-fake-ui-for-media-stream');
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

    // HEADFUL sempre
    const isHeadless = process.env.OVERRIDE_HEADLESS === '1' || process.env.HEADLESS === '1';

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

    // 2) Maximizar janela (se falhar, segue)
    try {
      const first = (await browser.pages())[0];
      const client = await first.target().createCDPSession();
      const { windowId } = await client.send('Browser.getWindowForTarget');
      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'maximized' }
      });
      if (process.env.BROWSER_DEBUG === '1') logger.debug('>> [BROWSER][STEP] Janela maximizada [OK]');
    } catch (e) {
      logger.warn('[BROWSER] Falha ao maximizar (seguindo normal): ' + ((e && e.message) || e));
    }

    // 2. PATCH: Configuração defaultTimeout, defaultNavigationTimeout e interceptação beforeunload para TODAS as new pages!
    try {
      const setDefaults = async (p) => {
        try {
          p.setDefaultTimeout(30000); // 30s ações padrão
          p.setDefaultNavigationTimeout(45000); // 45s navegação
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
      const pagesNow = await browser.pages();
      for (const p of (pagesNow||[])) await setDefaults(p);
      browser.on('targetcreated', async (t) => {
        try {
          const p = await t.page().catch(()=>null);
          if (p) await setDefaults(p);
        } catch {}
      });
    } catch {}

    // 3) Permissões: GEO + CAMERA + MICROFONE (militar, multi-origin, dinâmico)
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

      // Blindagem dinâmica: qualquer nova target criada/alterada (iframe/popup/flow) -> re-grant
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
            let u = '';
            try { u = await p.url(); } catch {}
            if (/facebook.com\/marketplace\/create\/item/i.test(u)) continue;
            if (typeof p.close === 'function') await p.close({ runBeforeUnload: false }).catch(()=>{});
          }
        }
      } catch {}
    };

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
      try { if (process.env.BROWSER_DEBUG === '1') { logger.debug(`${logPrefix} click via CSS falhou: ` + ((e && e.message) || e)); } } catch {}
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

async function detectMessengerPinModal(page) {
  try {
    // NÃO restringir por URL: em alguns fluxos o Messenger pode estar embutido/redirectado
    // e ainda assim renderizar o modal do PIN. O detector já exige sinais fortes (texto + input/botão).
    return await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const txt = norm(document.body ? (document.body.innerText || '') : '');
      // Caso A (mais comum): “Insira seu PIN para restaurar seu histórico de conversa”
      const pinText =
        txt.includes('insira seu pin') ||
        txt.includes('inserir seu pin') ||
        (txt.includes('restaurar') && txt.includes('historico') && txt.includes('pin'));
      const hasPinInput =
        !!document.querySelector('input[aria-label="PIN"][maxlength="6"]') ||
        !!document.querySelector('input#mw-numeric-code-input-prevent-composer-focus-steal') ||
        Array.from(document.querySelectorAll('input[type="text"][maxlength="6"]')).some(el => norm(el.getAttribute('aria-label')||'') === 'pin');

      // Caso B (às vezes aparece após tentar fechar): “Continuar sem restaurar?”
      const contText =
        txt.includes('continuar sem restaurar') ||
        (txt.includes('nao restaurar') && txt.includes('mensagens'));
      const hasNaoRestaurarBtn =
        Array.from(document.querySelectorAll('button,[role="button"]'))
          .some(el => {
            const t = norm(el.innerText || el.textContent || '');
            const al = norm(el.getAttribute('aria-label') || '');
            const disabled = (el.getAttribute('aria-disabled') === 'true') || (el.getAttribute('disabled') != null);
            if (disabled) return false;
            return t.includes('nao restaurar mensagens') || al.includes('nao restaurar mensagens');
          });

      // Legado: alguns fluxos mostram “Criar PIN” (mantemos também)
      const createText =
        txt.includes('crie um pin') ||
        txt.includes('criar pin') ||
        txt.includes('seu pin restaura') ||
        txt.includes('sem um pin');
      const hasCreateBtn =
        !!document.querySelector('[role="button"][aria-label*="Criar PIN"], button[aria-label*="Criar PIN"]') ||
        Array.from(document.querySelectorAll('button,div[role="button"]')).some(el => norm(el.innerText || el.textContent || '').includes('criar pin'));

      const present =
        (pinText && hasPinInput) ||
        (contText && hasNaoRestaurarBtn) ||
        (createText && hasCreateBtn);

      return {
        present: !!present,
        kind: (pinText && hasPinInput) ? 'pin_input'
          : (contText && hasNaoRestaurarBtn) ? 'continue_without_restore'
          : (createText && hasCreateBtn) ? 'create_pin'
          : null,
        hasPinInput,
        hasNaoRestaurarBtn,
        hasCreateBtn
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
      // variações PT-BR / sem acento
      const xps = [
        '//div[@role="dialog"]//button[contains(.,"Não restaurar mensagens")]',
        '//div[@role="dialog"]//button[contains(.,"Nao restaurar mensagens")]',
        '//div[@role="dialog"]//div[@role="button"][contains(.,"Não restaurar mensagens")]',
        '//div[@role="dialog"]//div[@role="button"][contains(.,"Nao restaurar mensagens")]',
      ];
      for (const xp of xps) {
        const els = await page.$x(xp).catch(()=>[]);
        if (els && els[0]) {
          await els[0].click({ delay: 60 }).catch(()=>{});
          return true;
        }
      }
      return false;
    } catch { return false; }
  }

  async function clickCreatePinButton() {
    try {
      const clicked = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        for (const b of buttons) {
          const disabled = (b.getAttribute('aria-disabled') === 'true') || (b.getAttribute('disabled') != null) || (String(b.getAttribute('tabindex')||'') === '-1');
          if (disabled) continue;
          const t = norm(b.innerText || b.textContent || '');
          const al = norm(b.getAttribute('aria-label') || '');
          if (t.includes('criar pin') || al.includes('criar pin')) {
            b.click();
            return true;
          }
        }
        return false;
      });
      return clicked;
    } catch { return false; }
  }

  async function tryEnterPin(pinValue = DEFAULT_PIN) {
    try {
      // Encontra o input de PIN e digita o valor
      const entered = await page.evaluate((pin) => {
        const pinInput =
          document.querySelector('input[aria-label="PIN"][maxlength="6"]') ||
          document.querySelector('input#mw-numeric-code-input-prevent-composer-focus-steal') ||
          Array.from(document.querySelectorAll('input[type="text"][maxlength="6"]')).find(el => {
            const al = (el.getAttribute('aria-label') || '').toLowerCase();
            return al.includes('pin');
          }) ||
          null;
        if (!pinInput) return { ok: false, error: 'pin_input_not_found' };
        
        // Foca no input
        pinInput.focus();
        // Limpa o input (caso tenha algo)
        pinInput.value = '';
        // Digita o PIN
        pinInput.value = pin;
        // Dispara eventos de input para garantir que o React detecte
        const inputEvent = new Event('input', { bubbles: true });
        pinInput.dispatchEvent(inputEvent);
        const changeEvent = new Event('change', { bubbles: true });
        pinInput.dispatchEvent(changeEvent);
        
        return { ok: true, pinLength: pin.length };
      }, pinValue);

      if (entered && entered.ok) {
        await sleep(300);
        // Tenta pressionar Enter ou encontrar botão de confirmação
        const confirmed = await page.evaluate(() => {
          const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
          // Procura botão "Confirmar", "Avançar", "Continuar", etc.
          const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
          for (const b of buttons) {
            const disabled = (b.getAttribute('aria-disabled') === 'true') || (b.getAttribute('disabled') != null) || (String(b.getAttribute('tabindex')||'') === '-1');
            if (disabled) continue;
            const t = norm(b.innerText || b.textContent || '');
            const al = norm(b.getAttribute('aria-label') || '');
            if (t.includes('confirmar') || t.includes('avancar') || t.includes('continuar') || 
                al.includes('confirmar') || al.includes('avancar') || al.includes('continuar')) {
              b.click();
              return true;
            }
          }
          return false;
        });
        
        if (!confirmed) {
          // Se não encontrou botão, tenta Enter
          await page.keyboard.press('Enter').catch(()=>{});
          await sleep(500);
        } else {
          await sleep(800);
        }
        
        return { ok: true, entered: true, confirmed: !!confirmed };
      }
      return { ok: false, error: entered?.error || 'pin_enter_failed' };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'pin_enter_exception' };
    }
  }

  for (let attempt = 1; attempt <= Math.max(1, maxTries); attempt++) {
    const det = await detectMessengerPinModal(page);
    if (!det.present) return { ok: true, dismissed: false };

    // snapshot mínimo sempre que detecta (ajuda a comparar DOM real vs esperado)
    try {
      pinLog({ event: 'pin_present', attempt, kind: det.kind || null, hasPinInput: !!det.hasPinInput, hasNaoRestaurarBtn: !!det.hasNaoRestaurarBtn, hasCreateBtn: !!det.hasCreateBtn });
    } catch {}

    // NOVO: Se for modal de "Criar PIN", clica no botão primeiro
    if (det.kind === 'create_pin' && det.hasCreateBtn) {
      try {
        pinLog({ event: 'pin_create_click_attempt', attempt });
        const createClicked = await clickCreatePinButton();
        await sleep(1000);
        if (createClicked) {
          pinLog({ event: 'pin_create_clicked', attempt });
        }
        // Após clicar, pode aparecer o input de PIN, então continua o fluxo
        // Re-detecta para ver se agora é pin_input
        const detAfterCreate = await detectMessengerPinModal(page);
        if (detAfterCreate.present && detAfterCreate.kind === 'pin_input') {
          det.kind = 'pin_input';
          det.hasPinInput = true;
        }
      } catch (e) {
        pinLog({ event: 'pin_create_click_error', attempt, error: (e && e.message) || String(e) });
      }
    }

    // NOVO: Se for modal de "Insira seu PIN" (pin_input), digita o PIN automaticamente
    if (det.kind === 'pin_input' && det.hasPinInput) {
      try {
        pinLog({ event: 'pin_enter_attempt', attempt, pin: DEFAULT_PIN });
        const enterResult = await tryEnterPin(DEFAULT_PIN);
        if (enterResult.ok) {
          pinLog({ event: 'pin_entered', attempt, pin: DEFAULT_PIN, confirmed: !!enterResult.confirmed });
          await sleep(1500); // Aguarda processamento
          // Verifica se o modal sumiu após digitar o PIN
          const detAfter = await detectMessengerPinModal(page);
          if (!detAfter.present) {
            pinLog({ event: 'pin_success_modal_dismissed', attempt });
            return { ok: true, dismissed: true, pinEntered: true };
          }
          // Se ainda está presente, pode ser que precise de confirmação adicional
          pinLog({ event: 'pin_entered_but_modal_still_present', attempt });
        } else {
          pinLog({ event: 'pin_enter_failed', attempt, error: enterResult.error });
        }
      } catch (e) {
        pinLog({ event: 'pin_enter_exception', attempt, error: (e && e.message) || String(e) });
      }
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

async function tryApplySelectorHints(page, selectorHints) {
  const hints = Array.isArray(selectorHints) ? selectorHints : [];
  for (const selRaw of hints) {
    const sel = String(selRaw || '').trim();
    if (!sel) continue;
    // guardrails básicos (evita seletor “perigoso”)
    if (sel.length > 220) continue;
    if (/script|iframe|object|embed/i.test(sel)) continue;
    try {
      const clicked = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        // precisa estar dentro de um dialog/modal para evitar cliques destrutivos fora
        const inDialog = !!(el.closest && el.closest('div[role="dialog"]'));
        if (!inDialog) return false;
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (!r || r.width < 2 || r.height < 2) return false;
        if (typeof el.click === 'function') { el.click(); return true; }
        return false;
      }, sel);
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

  const applied = await tryApplySelectorHints(page, result.selectorHints);
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
      const okWords = ['continuar', 'concordo', 'aceitar', 'permitir', 'entendi', 'ok'];
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
      const okWords = ['continuar', 'aceitar', 'ok', 'entendi', 'confirmar', 'fechar'];
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
    const consent = await _detectFbConsentOrBlockingPage(page);
    if (consent && consent.present && consent.kind === 'consent') {
      const det = await _tryDismissFbConsent(page);
      if (det && det.ok) continue;
      // Consent às vezes é “full page” sem dialog; se falhar, chama GPT para diagnóstico/evidência.
      if (allowGpt && nome) {
        await gptRemediateFbUi(page, nome, { reason: `${reasonBase}_consent`, stage: `round_${i}` }).catch(()=>null);
        await sleep(900);
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
  if (process.env.CONFIGURE_DEBUG === '1') {
    logger.debug('[CONFIG] Iniciando configureProfile para ' + nome);
  }

  let pages;
  try {
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 1A: Antes de pegar pages (await browser.pages())');
    pages = await browser.pages();
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 1B: Depois de pegar pages (await browser.pages())');
  } catch (e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      logger.debug('[CONFIG][ERRO][CHECKPOINT 1][browser.pages()]: ' + ((e && e.stack) ? e.stack : e));
    }
    throw e;
  }

  // NOVO: TRAZ FOCO AO INJETAR COOKIES
  await bringWindowToFront(pages[0]);

  let page, manifest, coords;
  try {
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 2A: Antes de patchPage');
    page = pages[0];
    // LEITURA DE MANIFEST VIA userDataDir DEFINIDO EM perfis.json
    const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    coords = utils.getCoords(manifest.cidade || '');
    await patchPage(nome, page, coords);
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 2B: Depois de patchPage');
  } catch (e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      logger.debug('[CONFIG][ERRO][CHECKPOINT 2][patchPage]: ' + ((e && e.stack) ? e.stack : e));
    }
    throw e;
  }

  // ==================== PATCH INJEÇÃO UNIVERSAL ====================
  // Injete TODOS os cookies (normalizados) direto na Facebook antes de navegar:
  await injectCookies(pages[0], manifest.cookies);
  // ================================================================

  try {
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 8A: Antes de page.goto("https://facebook.com/")');
    await pages[0].goto('https://facebook.com/', { waitUntil: 'domcontentloaded' }).catch((e) => {
      if (process.env.CONFIGURE_DEBUG === '1') {
        logger.debug('[CONFIG][ERRO][CHECKPOINT 8][goto facebook.com.catch]: ' + ((e && e.stack) ? e.stack : e));
      }
    });

    try {
      const title = await pages[0].title();
      const url = pages[0].url();
      if (process.env.CONFIGURE_DEBUG === '1') {
        logger.debug(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
      }
    } catch(logerr) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        logger.debug('[STATE] Erro ao obter título/URL após goto facebook.com: ' + ((logerr && logerr.stack) ? logerr.stack : logerr));
      }
    }

    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 8B: Depois de page.goto("https://facebook.com/")');
  } catch(e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      logger.debug('[CONFIG][ERRO][CHECKPOINT 8][page.goto facebook.com]: ' + ((e && e.stack) ? e.stack : e));
    }
    throw e;
  }

  try {
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 9A: Antes do delay após logar/principal (6s) ===');
    await new Promise(r => setTimeout(r, 6000));
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 9B: Depois do delay após logar/principal (6s) ===');
  } catch(e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      logger.debug('[CONFIG][ERRO][CHECKPOINT 9][Delay de 6s após logar/principal]: ' + ((e && e.stack) ? e.stack : e));
    }
    throw e;
  }

  const openedPages = [];
  try {
    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10A: Antes de abrir abas auxiliares ===');
    openedPages[0] = pages[0];

    // Aba 1 — criar item
    try {
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.1A: Antes de newPage (marketplace)');
      openedPages[1] = await browser.newPage();
      await patchPage(nome, openedPages[1], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[1].goto('https://www.facebook.com/marketplace', { waitUntil: 'domcontentloaded' }).catch((e) => {
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug('[CONFIG][ERRO][CHECKPOINT 10.1][goto marketplace.catch]: ' + ((e && e.stack) ? e.stack : e));
        }
      });
      try {
        const title = await openedPages[1].title();
        const url = await openedPages[1].url();
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
        }
      } catch(logerr) {
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug('[STATE] Erro ao obter título/URL após goto marketplace: ' + ((logerr && logerr.stack) ? logerr.stack : logerr));
        }
      }
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.1D: goto marketplace OK');
      await new Promise(r => setTimeout(r, 6000));
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.1E: Delay após marketplace OK');
    } catch(e) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        logger.debug('[CONFIG][ERRO][CHECKPOINT 10.1][Aba Marketplace]: ' + ((e && e.stack) ? e.stack : e));
      }
    }

    // Aba 2 — idioma
    try {
      await new Promise(r => setTimeout(r, 1000));
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.2A: Antes de newPage (idioma)');
      openedPages[2] = await browser.newPage();
      await patchPage(nome, openedPages[2], coords);
      await new Promise(r => setTimeout(r, 1000));
      await openedPages[2].goto('https://www.facebook.com/settings/?tab=language', { waitUntil: 'domcontentloaded' }).catch((e) => {
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug('[CONFIG][ERRO][CHECKPOINT 10.2][goto idioma.catch]: ' + ((e && e.stack) ? e.stack : e));
        }
      });
      try {
        const title = await openedPages[2].title();
        const url = await openedPages[2].url();
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug(`[STATE] Após goto: Título: "${title}" | URL: ${url}`);
        }
      } catch(logerr) {
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug('[STATE] Erro ao obter título/URL após goto idioma: ' + ((logerr && logerr.stack) ? logerr.stack : logerr));
        }
      }
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.2D: goto idioma OK');
      await new Promise(r => setTimeout(r, 6000));
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.2E: Delay após idioma OK');
    } catch(e) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        logger.debug('[CONFIG][ERRO][CHECKPOINT 10.2][Aba Idioma]: ' + ((e && e.stack) ? e.stack : e));
      }
    }

    // Aba 3 — MESSENGER: PATCH UNIVERSAL COOKIES
    try {
      await new Promise(r => setTimeout(r, 1000));
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.3A: Antes de newPage (messenger)');
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
          logger.debug('[CONFIG][Messenger] reload inicial falhou, seguindo...');
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
          logger.debug(`[STATE] Messenger Após fluxo: "${title}" | URL: ${url}`);
        }
      } catch(logerr) {
        if (process.env.CONFIGURE_DEBUG === '1') {
          logger.debug('[STATE] Erro ao obter título/URL após fluxo messenger: ' + ((logerr && logerr.stack) ? logerr.stack : logerr));
        }
      }
      if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10.3Z: Fluxo Messenger finalizado (robusto)');

      // 7) Curador enterprise: modal do PIN (fecha determinístico; se falhar, GPT + re-tenta)
      try {
        const pin1 = await tryDismissMessengerPinModal(openedPages[3], { logPrefix: '[CONFIG][Messenger][pin]', maxTries: 4 });
        if (!pin1.ok) {
          // fallback GPT com histórico (tenta 2 rodadas)
          for (let k = 1; k <= 2; k++) {
            await gptRemediateFbUi(openedPages[3], nome, { reason: 'messenger_pin_modal', stage: `configure_pin_try_${k}` }).catch(()=>null);
            const pin2 = await tryDismissMessengerPinModal(openedPages[3], { logPrefix: '[CONFIG][Messenger][pin-postgpt]', maxTries: 1 });
            if (pin2.ok) break;
          }
          const still = await detectMessengerPinModal(openedPages[3]);
          if (still.present) {
            throw new Error('messenger_pin_modal');
          }
        }
      } catch (e) {
        // deixe falhar o configure (isso vai virar job error e pedir humano, mas a conta fica assigned no CT)
        throw e;
      }

      await new Promise(r => setTimeout(r, 4000)); // settle curto
    } catch(e) {
      if (process.env.CONFIGURE_DEBUG === '1') {
        logger.debug('[CONFIG][ERRO][CHECKPOINT 10.3][Aba Messenger robusta]: ' + ((e && e.stack) ? e.stack : e));
      }
    }
    // FIM ABA MESSENGER PATCH UNIVERSAL COOKIES

    if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 10B: Depois de abrir abas auxiliares ===');
  } catch(e) {
    if (process.env.CONFIGURE_DEBUG === '1') {
      logger.debug('[CONFIG][ERRO][CHECKPOINT 10][Abrindo abas auxiliares]: ' + ((e && e.stack) ? e.stack : e));
    }
    throw e;
  }

  // (REMOVIDO BLOCO DE PRUNING APÓS CONFIGURATION CONFORME INSTRUÇÃO)

  if (process.env.CONFIGURE_DEBUG === '1') logger.debug('=== CHECKPOINT 14: Todas abas abertas/logadas, firmadas e curadas. Configuração concluída!');
  if (process.env.CONFIGURE_DEBUG === '1') logger.debug('[CONFIG] configureProfile FINALIZADO em ' + nome);
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
    try { if (process.env.BROWSER_DEBUG === '1') { logger.warn('[BROWSER][invocarHumano] erro: ' + ((e && e.message) || e)); } } catch {}
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
      const key = keyFor(target);
      if (!key) return;
      try { browser._pageBirth[key] = browser._pageBirth[key] || Date.now(); } catch {}

      // CANCELADORES - NÃO BUSQUE page.url()
      try {
        page.once('close', () => clearTimer(key));
      } catch {}

      async function check() {
        try {
          if (page.isClosed && page.isClosed()) return;
          const u = page.url ? page.url() : '';
          if (u && u !== 'about:blank') return;

          const now = Date.now();
          const birth = (browser && browser._pageBirth && browser._pageBirth[key]) || 0;
          const age = birth ? (now - birth) : null;
          const sup = (browser && browser._suppressBlankKillUntil && browser._suppressBlankKillUntil[nome]) || 0;
          const suppressed = (browser && browser._robeActiveFor === nome) || (sup > now);

          if (suppressed) {
            if (age != null && age >= ABOUTBLANK_MAX_AGE_MS) {
              try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
              try { await issues.append(nome, 'mil_action', 'about_blank_killed_max_age'); } catch {}
              return;
            }
            // Rearmável: tenta de novo depois
            const t2 = setTimeout(() => { check().catch(()=>{}); }, ABOUTBLANK_RETRY_MS);
            timers.set(key, t2);
            return;
          }

          // Fora de Robe e sem suppress => mata imediatamente
          try { await page.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
          try { await issues.append(nome, 'mil_action', 'about_blank_killed'); } catch {}
        } finally {
          clearTimer(key);
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
      if (u && u !== 'about:blank') clearTimer(key);
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
      const hasInputs = !!document.querySelector('input[name="email"], input#email') && !!document.querySelector('input[name="pass"], input#pass');
      const href0 = String(location && location.href ? location.href : '');
      const path0 = String(location && location.pathname ? location.pathname : '');
      const title0 = String(document && document.title ? document.title : '');
      // 2) Checkpoint/captcha
      const h1 = Array.from(document.querySelectorAll('h1,h2,span,div')).slice(0,2000).map(el => norm(el.innerText||el.textContent||''));
      const hasPersonaText = h1.some(t => t.includes('confirme que voce e uma pessoa') || t.includes('confirm that you are a person'));
      const hasCheckpointText = h1.some(t => t.includes('checkpoint') || t.includes('verificacao') || t.includes('verificacao de seguranca') || t.includes('security check'));
      // 3) Confirmação de identidade (ex.: selfie/vídeo) — NÃO é resolvível automaticamente, mas precisa ser “visto”.
      const hasIdentityText = h1.some(t =>
        t.includes('confirme sua identidade') ||
        t.includes('confirm your identity') ||
        t.includes('gravar uma selfie de video') ||
        t.includes('grave uma selfie de video') ||
        t.includes('video selfie') ||
        (t.includes('selfie') && t.includes('video'))
      );
      return { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, href0, path0, title0 };
    });

    const domain = (/messenger\.com/i.test(href) ? 'messenger' : 'facebook');
    const path = (v && v.path0) ? String(v.path0) : '';
    const strongLoginPath = /\/(login|checkpoint|recover|two_step_verification|security)/i.test(path);
    const hasRoyal = !!(v && v.hasRoyal);
    const hasInputs = !!(v && v.hasInputs);
    const hasPersonaText = !!(v && v.hasPersonaText);
    const hasCheckpointText = !!(v && v.hasCheckpointText);
    const hasIdentityText = !!(v && v.hasIdentityText);
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

    // Detecção mais conservadora para evitar falso positivo:
    // - login_form só é válido se a rota for claramente de login/checkpoint
    // - checkpoint/captcha também exige rota/sinais de checkpoint
    // IMPORTANT: em algumas telas, o form aparece em rotas como /marketplace ou /index.php (logged-out),
    // então não podemos depender apenas do path.
    if (hasRoyal && hasInputs && (strongLoginPath || looksLikeLoginUrl || looksLikeLoggedOutTitle)) {
      return {
        loginRequired: true,
        reason: 'login_form',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, path }
      };
    }
    if (hasIdentityText && (strongLoginPath || /checkpoint/i.test(title))) {
      return {
        loginRequired: true,
        reason: 'identity_confirm_selfie',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, path }
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
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, path }
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
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, path }
      };
    }

    return {
      loginRequired: false,
      reason: '',
      domain,
      url: (v && v.href0) ? String(v.href0) : href,
      title,
      evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, path }
    };
  } catch {}
  return { loginRequired: false };
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

async function tryLoginEmailPass(page, { login, password, nome, allowGpt = true } = {}) {
  const email = String(login || '').trim();
  const pass = String(password || '').trim();
  if (!email || !pass) return { ok: false, error: 'missing_credentials' };

  // 1) tentar “destravar” telas comuns (continuar como / modal) para cair no formulário
  await _maybeClickCloseX(page);
  await _maybeClickUseAnotherProfile(page);

  // 2) preencher formulário (FB / Messenger)
  try {
    await page.waitForTimeout(400);
  } catch {}

  try {
    await page.type('input[name="email"], input#email', email, { delay: 20 }).catch(()=>{});
    await page.type('input[name="pass"], input#pass', pass, { delay: 20 }).catch(()=>{});
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'type_failed' };
  }

  // 3) marcar "manter-me conectado" se existir
  await _maybeClickKeepConnected(page);

  // 4) submit
  try {
    const clicked = await page.evaluate(() => {
      const btn =
        document.querySelector('button#loginbutton, button[name="login"], button[type="submit"], [data-testid="royal-login-button"]') ||
        document.querySelector('form#login_form button[type="submit"]') ||
        document.querySelector('form[data-testid="royal_login_form"] button[type="submit"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) {
      // Fallback GPT (opcional): tenta remover modal/selector e depois tenta novamente 1x
      if (allowGpt && nome) {
        try { await gptRemediateFbUi(page, nome, { reason: 'login_button_not_found', stage: 'login_submit' }); } catch {}
        try {
          const clicked2 = await page.evaluate(() => {
            const btn =
              document.querySelector('button#loginbutton, button[name="login"], button[type="submit"], [data-testid="royal-login-button"]') ||
              document.querySelector('form#login_form button[type="submit"]') ||
              document.querySelector('form[data-testid="royal_login_form"] button[type="submit"]');
            if (!btn) return false;
            btn.click();
            return true;
          });
          if (!clicked2) return { ok: false, error: 'login_button_not_found' };
        } catch {}
      } else {
        return { ok: false, error: 'login_button_not_found' };
      }
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'click_failed' };
  }

  // 5) aguardar navegação estabilizar
  try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
  try { await sleep(1500); } catch {}
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
async function detectAccountSuspended(page) {
  try {
    const href = (page && typeof page.url === 'function') ? (page.url() || '') : '';
    const isFbOrMsg = /(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(href);
    if (!isFbOrMsg) return { banned: false };

    const v = await page.evaluate(() => {
      function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
      const nodes = Array.from(document.querySelectorAll('h1,h2,span,div')).slice(0,2500);
      const texts = nodes.map(el => (el.innerText || el.textContent || '')).filter(Boolean);
      const tnorm = texts.map(norm);

      // Multilíngue PT/EN/ES variantes para “suspensa/suspendida/suspended”
      const hit = tnorm.some(t =>
        t.includes('sua conta foi suspensa') ||
        t.includes('sua conta esta suspensa') ||
        t.includes('your account was suspended') ||
        t.includes('your account is suspended') ||
        t.includes('tu cuenta ha sido suspendida') ||
        t.includes('tu cuenta esta suspendida')
      );

      // Evidência adicional contendo prazo/efeito (opcional e robusta)
      const more = tnorm.some(t =>
        t.includes('nao esta visivel no facebook') ||
        t.includes('you cannot use it right now') ||
        t.includes('no puedes usarla ahora') ||
        t.includes('sera desabilitada permanentemente') ||
        t.includes('will be permanently disabled')
      );

      let snippet = '';
      if (hit) {
        snippet = texts.find(s => /[Ss]uspens[oa]/.test(s)) || texts.slice(0,20).join(' | ').slice(0,300);
      }
      return { hit, more, snippet };
    });

    if (v && v.hit) {
      return { banned: true, reason: 'suspended_ui', snippet: v.snippet || '' };
    }
  } catch {}
  return { banned: false };
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
  hardCleanProfileOnDisk,
  detectMessengerTempBlock, // NOVO: exportado para uso pelo worker
  detectLimitOverlayDeep,      // <----- NOVO
  detectLimitOverlayEverywhere,
  dismissAutomationSuspect,
  textHitsLimitNormalized,     // <----- NOVO (opcional, caso queira reusar)
  // ======= ADICIONE ESTES DOIS:
  resolveNonceIfPresent,
  clickContinuarComo,
  // ==== Messenger PIN modal (exportado p/ worker curador)
  detectMessengerPinModal,
  tryDismissMessengerPinModal,
  gptRemediateFbUi,
  ensureFbUiUnblocked,
  installOneTabGuard,
  installAboutBlankKiller,
  // ==== NOVOS:
  detectLoginRequired,
  tryLoginEmailPass,
  collectFreshCookies,
  detectAccountSuspended,
  killChromeProfileProcesses
};