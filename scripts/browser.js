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
const { readGroqConfig } = require('./groqConfig.js');
const provisionAudit = require('./provisionAudit.js');

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
    const ESSENTIAL = new Set(['c_user', 'xs', 'fr', 'sb', 'datr']);
    const normalizeDomain = (d) => {
      let dd = String(d || '.facebook.com').replace(/\s/g, '').toLowerCase();
      if (!dd) dd = '.facebook.com';
      if (!dd.startsWith('.')) dd = '.' + dd;
      if (dd.includes('messenger.com')) return '.messenger.com';
      if (dd.includes('facebook.com')) return '.facebook.com';
      return '.facebook.com';
    };
    const fixDomain = (d) => {
      return normalizeDomain(d);
    };
    const fixPath = (p) => (typeof p === 'string' ? p.trim() : '/');
    const ascii = (s) => String(s || '').normalize('NFD').replace(/[^\w\-]/g, '');
    const filteredBase = cookies.map(c => {
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
    // Chromium (RM7) ficou mais estrito no isolamento de domínio:
    // se vier só .facebook.com, espelhamos cookies essenciais para .messenger.com.
    const expanded = [];
    for (const c of filteredBase) {
      expanded.push(c);
      if (ESSENTIAL.has(String(c.name || '')) && String(c.domain || '').includes('facebook.com')) {
        expanded.push({ ...c, domain: '.messenger.com' });
      }
    }
    const seen = new Set();
    const filtered = expanded.filter((c) => {
      const key = `${String(c.name||'')}|${String(c.domain||'')}|${String(c.path||'/')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  // Chromium pode fechar alvo muito cedo em hosts sob pressão; isso não pode matar a ativação inteira.
  try {
    await page.evaluateOnNewDocument((hwc) => {
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hwc, configurable: true });
      } catch {}
    }, hardwareConcurrency);
  } catch {}

  // --- LANGUAGE/PLATFORM PATCH anti-detect ---
  try {
    await page.evaluateOnNewDocument(() => {
      const safeDefine = (obj, key, getter) => {
        try {
          Object.defineProperty(obj, key, { get: getter, configurable: true });
        } catch {}
      };
      safeDefine(navigator, 'language', () => 'pt-BR');
      safeDefine(navigator, 'languages', () => ['pt-BR', 'pt', 'en-US', 'en']);
      safeDefine(navigator, 'platform', () => 'Win32');
      safeDefine(navigator, 'webdriver', () => undefined);
      window.chrome = window.chrome || { runtime: {} };
      // Keep Notification API shape present to avoid marketplace runtime ReferenceError.
      // We force denied semantics, so behavior stays non-intrusive.
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
    });
  } catch {}

  // --- GEOLOCALIZAÇÃO ---
  if (coords && coords.latitude) {
    try { await page.setGeolocation(coords); } catch(e){}
  }

  // --- OCULTAR BANNER AUTOMATION ---
  try {
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
  } catch {}

  // --- INJEÇÃO DO DISMISS AUTOMÁTICO DO OVERLAY "SUSPEITAMOS..." ---
  try {
    // Exponha como function para page
    await page.exposeFunction('__dismissAutomationSuspect', () =>
      dismissAutomationSuspect(page, nome).catch(()=>false)
    );
    // Injeta um scanner após DOMContentLoaded: tenta algumas vezes nas primeiras rodadas
    try {
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
    } catch {}
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
    // #region agent log (debug)
    // Diagnóstico do porquê caiu em probe_failed (sem HTML/sem segredos)
    try {
      let hrefSafe = '';
      try { hrefSafe = (page && typeof page.url === 'function') ? String(page.url() || '') : ''; } catch {}
      const msg = (e && e.message) ? String(e.message) : String(e || '');
    } catch {}
    // #endregion
    // Fail-safe enterprise: se o probe falhar, não podemos concluir "liberado".
    // Mantemos como loginRequired=true para evitar ações erradas.
    try {
      const hrefSafe = (page && typeof page.url === 'function') ? String(page.url() || '') : '';
      const titleSafe = (page && typeof page.title === 'function') ? String(page.title() || '') : '';
      const msg = (e && e.message) ? String(e.message) : String(e || '');
      return { loginRequired: true, reason: 'probe_failed', domain: null, url: hrefSafe ? hrefSafe.slice(0, 260) : null, title: titleSafe ? titleSafe.slice(0, 120) : null, evidence: { probeError: { name: (e && e.name) ? String(e.name).slice(0, 80) : null, msg: msg.slice(0, 260) } } };
    } catch {}
    return { loginRequired: true, reason: 'probe_failed' };
  }
}

function isTransientMainFrameError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.includes('requesting main frame too early') ||
    msg.includes('main frame') ||
    msg.includes('target closed')
  );
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
    // Idioma/tradução (enterprise):
    // - força idioma preferencial PT-BR;
    // - desativa prompt de tradução para evitar "popup" e página em inglês no bootstrap.
    prefs.intl = prefs.intl || {};
    prefs.intl.accept_languages = 'pt-BR,pt';
    prefs.translate = prefs.translate || {};
    prefs.translate.enabled = false;
    prefs.translate.translate_site_blacklist = Array.isArray(prefs.translate.translate_site_blacklist)
      ? Array.from(new Set([...(prefs.translate.translate_site_blacklist || []), '*']))
      : ['*'];
    writeJsonAtomic(prefsPath, prefs);

    // Local State
    const localStatePath = path.join(userDataDir, 'Local State');
    const ls = readJsonSafe(localStatePath, {}) || {};
    ls.exited_cleanly = true;
    ls.intl = ls.intl || {};
    ls.intl.app_locale = 'pt-BR';
    ls.intl.accept_languages = 'pt-BR,pt';
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
        if (/facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u)) continue;
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
        const pages = await browser.pages();
        const beforeCount = Array.isArray(pages) ? pages.length : 0;
        let limOpt = (typeof maxPagesWhenAllow === 'function') ? Number(maxPagesWhenAllow()) : Number(maxPagesWhenAllow);
        if (!Number.isFinite(limOpt) || limOpt < 1) limOpt = 1;
        const lim = (allow && allow()) ? limOpt : 1;
        if (Array.isArray(pages) && pages.length > lim) {
          let reason = '';
          try {
            reason = (typeof getReason === 'function') ? String(getReason() || '') : String(getReason || '');
          } catch { reason = ''; }

          const closedUrls = [];
          // Mantenha a primeira (main) e feche todas as demais
          for (let i = pages.length - 1; i >= 1; i--) {
            if (pages.length <= lim) break;
            const p = pages[i];
            let u = '';
            try { u = await p.url().catch(()=>''); } catch {}
            if (/facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u)) continue; // Nunca fechar create item/vehicle
            try { closedUrls.push(String(u || '')); } catch {}
            try { await p.close({ runBeforeUnload: false }).catch(()=>{}); }
            catch {}
          }
          const cur = await browser.pages();
          const afterCount = (cur && cur.length) || 0;
          log('[PRUNER][HARD] Guard fechou abas extras', { nome, final: afterCount, lim, reason });
          try {
            if (onPrune) {
              Promise.resolve(onPrune({
                nome,
                lim,
                beforeCount,
                afterCount,
                reason,
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

function resolveBrowserEngine() {
  const raw = String(process.env.BROWSER_ENGINE || 'chromium').trim().toLowerCase();
  if (raw === 'chrome' || raw === 'chromium') return raw;
  return 'chromium';
}

function getPuppeteerManagedBrowserPath() {
  try {
    if (puppeteer && typeof puppeteer.executablePath === 'function') {
      const p = String(puppeteer.executablePath() || '').trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {}
  try {
    const pptr = require('puppeteer');
    if (pptr && typeof pptr.executablePath === 'function') {
      const p = String(pptr.executablePath() || '').trim();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// ====== FIND BROWSER EXECUTABLE ======
// Regra Fase 1:
// - default: chromium
// - BROWSER_ENGINE=chromium => NÃO faz fallback para Chrome
// - BROWSER_ENGINE=chrome => usa apenas Chrome
function findChromeStable() {
  const engine = resolveBrowserEngine();
  const envChrome = String(process.env.CHROME_PATH || '').trim();
  const envChromium = String(process.env.CHROMIUM_PATH || '').trim();

  if (engine === 'chromium') {
    if (envChromium && fs.existsSync(envChromium)) {
      return { engine, executablePath: envChromium, source: 'env:CHROMIUM_PATH' };
    }

    const chromiumCandidates = [];
    if (process.platform === 'win32') {
      chromiumCandidates.push(
        path.join(process.env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Chromium', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Chromium', 'Application', 'chrome.exe')
      );
    } else if (process.platform === 'darwin') {
      chromiumCandidates.push(
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        path.join(os.homedir(), 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
      );
    } else {
      chromiumCandidates.push('/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium');
    }

    for (const file of chromiumCandidates) {
      if (file && fs.existsSync(file)) return { engine, executablePath: file, source: 'default:chromium' };
    }

    // Fase 1 sem fallback para Chrome do sistema:
    // aceita também o browser gerenciado pelo Puppeteer (Chrome for Testing) quando presente.
    // Isso cobre hosts onde o runtime foi provisionado via npm install, mesmo sem Chromium global no PATH.
    const pptrManaged = getPuppeteerManagedBrowserPath();
    if (pptrManaged) {
      return { engine, executablePath: pptrManaged, source: 'puppeteer-managed' };
    }

    if (process.platform === 'win32') {
      throw new Error('Chromium não encontrado (modo estrito). Instale Chromium, configure CHROMIUM_PATH, ou garanta browser gerenciado do Puppeteer. Dica: winget install -e --id Chromium.Chromium -h');
    }
    throw new Error('Chromium não encontrado (modo estrito). Instale Chromium, configure CHROMIUM_PATH, ou garanta browser gerenciado do Puppeteer.');
  }

  if (envChrome && fs.existsSync(envChrome)) {
    return { engine, executablePath: envChrome, source: 'env:CHROME_PATH' };
  }

  const chromeCandidates = [];
  if (process.platform === 'win32') {
    chromeCandidates.push(
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    );
  } else if (process.platform === 'darwin') {
    chromeCandidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
    );
  } else {
    chromeCandidates.push('/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome');
  }
  for (const file of chromeCandidates) {
    if (file && fs.existsSync(file)) return { engine, executablePath: file, source: 'default:chrome' };
  }
  throw new Error('Chrome não encontrado (modo estrito). Instale Chrome ou defina CHROME_PATH.');
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

    // Fase 1: engine explícita com resolução auditável.
    const browserBin = findChromeStable();
    const executablePath = browserBin.executablePath;
    const isManagedChromium = browserBin && browserBin.engine === 'chromium' && browserBin.source === 'puppeteer-managed';
    try {
      logger.info('[BROWSER][ENGINE] executable resolved', {
        engine: browserBin.engine,
        source: browserBin.source,
        executablePath
      });
    } catch {}

    const safeLaunchArgs = (() => {
      if (!isManagedChromium) return [...launchArgs];
      const strip = new Set([
        '--process-per-site'
      ]);
      const base = launchArgs.filter((a) => !strip.has(String(a || '')));
      return [...base, '--disable-background-networking'];
    })();
    const ultraSafeLaunchArgs = (() => {
      if (!isManagedChromium) return [...safeLaunchArgs];
      return [
        '--no-first-run',
        '--no-default-browser-check',
        '--password-store=basic',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-features=TranslateUI,ProfilePicker,OptimizationHints,HardwareMediaKeyHandling,MediaRouter,CalculateNativeWinOcclusion',
        '--window-size=1366,768',
        '--start-maximized'
      ];
    })();

    async function tryLaunch(args, tag) {
      try {
        if (process.env.BROWSER_DEBUG === '1') {
          logger.debug(`>> [BROWSER][STEP] Puppeteer about to launch (${tag}).`);
        }
        const b = await puppeteer.launch({
          headless: isHeadless ? true : false,
          executablePath,
          userDataDir,
          args,
          defaultViewport,
          pipe: true,
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
      try { await sleep(350); } catch {}
      browserTry = await tryLaunch(safeLaunchArgs, 'LAUNCH 2_SAFE');
    }

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      try { await sleep(700); } catch {}
      browserTry = await tryLaunch(safeLaunchArgs, 'LAUNCH 3_SAFE');
    }

    if (!browserTry) {
      try { killChromeProfileProcesses(userDataDir, openingMap); } catch {}
      try { cleanupUserDataLocks(userDataDir); } catch {}
      try { await sleep(1200); } catch {}
      browserTry = await tryLaunch(ultraSafeLaunchArgs, 'LAUNCH 4_ULTRA_SAFE');
    }

    if (!browserTry) {
      throw new Error('Browser não iniciou após 4 tentativas. Veja logs acima e o arquivo chrome_launch.log do perfil.');
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
      let patched = false;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const page = (await browser.pages())[0];
          if (!page) throw new Error('patchPage: nenhuma aba disponível');
          await patchPage(manifest.nome, page, coords);
          patched = true;
          break;
        } catch (e) {
          lastErr = e;
          if (!isTransientMainFrameError(e) || attempt >= 3) break;
          try { await sleep(300 * attempt); } catch {}
        }
      }
      if (!patched) throw (lastErr || new Error('patchPage_failed'));
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
    // Enterprise HARDCORE: fecha TUDO exceto a aba 0 (independente de URL).
    browser.forceCloseExtrasHard = async () => {
      try {
        const pages = await browser.pages();
        if (pages && pages.length > 1) {
          for (const p of pages.slice(1)) {
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
        Array.from(document.querySelectorAll('button,div[role="button"]')).some(el => {
          const t = norm(el.innerText || el.textContent || '');
          const al = norm(el.getAttribute('aria-label') || '');
          // pode vir como "Criar PIN" ou "Mais opções" (fluxo alternativo)
          return t.includes('criar pin') || al.includes('criar pin') || t.includes('mais opcoes') || t.includes('mais opções') || al.includes('mais opcoes') || al.includes('mais opções');
        });

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
        const dlg = document.querySelector('div[role="dialog"]') || document;
        const buttons = Array.from(dlg.querySelectorAll('button,[role="button"]')).slice(0, 220);
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

  async function clickMoreOptionsThenSkip() {
    // Alguns modais de “Crie um PIN…” não mostram “Criar PIN” e sim “Mais opções”.
    // Estratégia: clicar "Mais opções" e depois "Agora não"/"Pular"/"No momento não".
    try {
      const didMore = await page.evaluate(() => {
        const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"]'));
        const scope = dialogs[0] || document;
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
        const dlg = document.querySelector('div[role="dialog"]') || document;
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

  async function tryEnterPin(pinValue = DEFAULT_PIN, round = 1) {
    // Regra ultra enterprise (anti-loop): NO MODAL DE PIN, NÃO clicar em X/voltar/fechar.
    // Só focar o input e digitar com cadência humana (digit-by-digit), depois Enter.
    try {
      const sel = [
        'input[aria-label="PIN"][maxlength="6"]',
        'input#mw-numeric-code-input-prevent-composer-focus-steal',
        'input[type="text"][maxlength="6"]',
        'input[type="tel"][maxlength="6"]'
      ];
      let h = null;
      for (const s of sel) {
        try {
          h = await page.$(s).catch(()=>null);
          if (h) break;
        } catch {}
      }
      if (!h) return { ok: false, error: 'pin_input_not_found' };

      // Foco + limpar sem "ruído"
      try { await h.click({ clickCount: 3, delay: 60 }).catch(()=>{}); } catch {}
      try { await page.keyboard.press('Backspace').catch(()=>{}); } catch {}
      await sleep(220);

      // Digitar 8 8 2 5 8 4 com calma
      const digits = String(pinValue || '').trim();
      if (!digits || digits.length < 6) return { ok: false, error: 'pin_value_invalid' };
      // Preencher também por JS (React-friendly) + eventos (alguns modais ignoram só teclado).
      try {
        await page.evaluate((el, val) => {
          try {
            const v = String(val || '');
            try { el.focus(); } catch {}
            const proto = el && el.constructor ? el.constructor.prototype : null;
            const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
            if (desc && typeof desc.set === 'function') desc.set.call(el, v);
            else el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } catch {}
        }, h, digits).catch(()=>{});
      } catch {}
      for (const ch of digits) {
        try { await page.keyboard.type(String(ch), { delay: 240 }).catch(()=>{}); } catch {}
      }

      await sleep(420);
      // Preferir Enter (menos risco de clicar fora e fazer o modal “piscar”)
      // Submit: tentar CTA primário do dialog; se não encontrar, usa Enter como fallback.
      let clickedSubmit = false;
      try {
        clickedSubmit = await page.evaluate(() => {
          function norm(s){
            try { return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
            catch { return String(s||'').toLowerCase(); }
          }
          const dlg = document.querySelector('div[role="dialog"]') || document;
          const btns = Array.from(dlg.querySelectorAll('button,[role="button"],a[role="button"],input[type="submit"]')).slice(0, 240);
          const words = ['confirmar','confirm','continuar','continue','avancar','avançar','next','ok','done','concluir','finalizar','salvar','save'];
          for (const b of btns) {
            const disabled = (b.getAttribute('aria-disabled') === 'true') || (b.getAttribute('disabled') != null) || (String(b.getAttribute('tabindex')||'') === '-1');
            if (disabled) continue;
            const t = norm(b.innerText || b.value || b.textContent || '');
            const al = norm(b.getAttribute('aria-label') || '');
            if (!t && !al) continue;
            if (words.some(w => t.includes(w) || al.includes(w))) { try { b.click(); return true; } catch {} }
          }
          return false;
        }).catch(()=>false);
      } catch {}
      if (!clickedSubmit) {
        try { await page.keyboard.press('Enter').catch(()=>{}); } catch {}
      }

      // Espera determinística: modal desaparecer / input sumir (até 12s)
      const cleared = await page.waitForFunction(() => {
        try {
          const norm = s => (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
          const txt = norm(document.body ? (document.body.innerText || '') : '');
          const hasPinInput =
            !!document.querySelector('input[aria-label="PIN"][maxlength="6"]') ||
            !!document.querySelector('input#mw-numeric-code-input-prevent-composer-focus-steal') ||
            Array.from(document.querySelectorAll('input[type="text"][maxlength="6"],input[type="tel"][maxlength="6"]'))
              .some(el => norm(el.getAttribute('aria-label')||'') === 'pin');
          const pinText =
            txt.includes('insira seu pin') ||
            txt.includes('inserir seu pin') ||
            (txt.includes('restaurar') && txt.includes('historico') && txt.includes('pin'));
          return !(hasPinInput && pinText);
        } catch { return false; }
      }, { timeout: 12_000 }).then(()=>true).catch(()=>false);

      await sleep(800);
      return { ok: true, entered: true, submitClicked: !!clickedSubmit, cleared, confirmed: (Number(round) >= 2) };
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

    // Se for modal de "Criar PIN", a regra é: tentar CRIAR PIN (não pular) — fallbacks só se falhar.
    if (det.kind === 'create_pin' && det.hasCreateBtn) {
      try {
        pinLog({ event: 'pin_create_click_attempt', attempt });
        let createClicked = false;
        for (let k = 1; k <= 3; k++) {
          createClicked = await clickCreatePinButton();
          try { pinLog({ event: 'pin_create_click_try', attempt, k, ok: !!createClicked }); } catch {}
          if (createClicked) break;
          await sleep(650);
        }
        await sleep(900);
        if (createClicked) {
          pinLog({ event: 'pin_create_clicked', attempt });
          const t0 = Date.now();
          while (Date.now() - t0 < 12_000) {
        const detAfterCreate = await detectMessengerPinModal(page);
            if (detAfterCreate.present && detAfterCreate.kind === 'pin_input' && detAfterCreate.hasPinInput) {
          det.kind = 'pin_input';
          det.hasPinInput = true;
              try { pinLog({ event: 'pin_input_visible_after_create', attempt, waitMs: Date.now() - t0 }); } catch {}
              break;
            }
            await sleep(450);
          }
        } else {
          // Fallback: só se realmente não conseguimos clicar em "Criar PIN".
          const more = await clickMoreOptionsThenSkip();
          pinLog({ event: 'pin_more_options_fallback', attempt, ok: !!(more && more.ok), error: more && more.error });
        }
      } catch (e) {
        pinLog({ event: 'pin_create_click_error', attempt, error: (e && e.message) || String(e) });
      }
    }

    // PIN INPUT: só digita. Não clicar em nada (anti-loop).
    if (det.kind === 'pin_input' && det.hasPinInput) {
      try {
        pinLog({ event: 'pin_enter_attempt', attempt, pin: DEFAULT_PIN });
        const enterResult = await tryEnterPin(DEFAULT_PIN, 1);
        if (enterResult.ok) {
          pinLog({ event: 'pin_entered', attempt, pin: DEFAULT_PIN, confirmed: !!enterResult.confirmed, submitClicked: !!enterResult.submitClicked, clearedWaitOk: !!enterResult.cleared });
          await sleep(1500); // Aguarda processamento
          // Verifica se o modal sumiu após digitar o PIN
          const detAfter = await detectMessengerPinModal(page);
          if (!detAfter.present) {
            pinLog({ event: 'pin_success_modal_dismissed', attempt });
            return { ok: true, dismissed: true, pinEntered: true };
          }
          // Se ainda está presente, pode ser que precise confirmar digitando de novo (comum em conta nova)
          pinLog({ event: 'pin_entered_but_modal_still_present', attempt });
          if (detAfter.kind === 'pin_input' && detAfter.hasPinInput) {
            pinLog({ event: 'pin_confirm_second_entry_attempt', attempt, pin: DEFAULT_PIN });
            const enter2 = await tryEnterPin(DEFAULT_PIN, 2);
            if (enter2.ok) {
              pinLog({ event: 'pin_second_entry_done', attempt, confirmed: !!enter2.confirmed });
              await sleep(1800);
              const detAfter2 = await detectMessengerPinModal(page);
              if (!detAfter2.present) {
                pinLog({ event: 'pin_success_modal_dismissed_after_second', attempt });
                return { ok: true, dismissed: true, pinEntered: true };
              }
            } else {
              pinLog({ event: 'pin_second_entry_failed', attempt, error: enter2.error });
            }
          }
        } else {
          pinLog({ event: 'pin_enter_failed', attempt, error: enterResult.error });
        }
      } catch (e) {
        pinLog({ event: 'pin_enter_exception', attempt, error: (e && e.message) || String(e) });
      }
      // Anti-loop: no pin_input não fazemos "trusted clicks" (Fechar/Não restaurar/voltar).
      // Deixe o worker/nurse aplicar cooldown e reavaliar depois.
      return { ok: false, error: 'pin_still_present', dismissed: false, pinEntered: true };
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
  if (dbg) logger.debug('[CONFIG] configureProfile (3-tabs) begin', { nome });

  // Objetivo enterprise (conta nova / inject cookies): manter 3 abas fixas e previsíveis:
  // 0) facebook.com  1) marketplace/create/(item|vehicle)  2) messenger.com/marketplace
  let pages = [];
  try { pages = await browser.pages().catch(()=>[]); } catch { pages = []; }
  if (!pages || !pages.length) {
    try { pages = [await browser.newPage()]; } catch {}
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

  // Ler manifest (fonte de verdade) + fallback de cidade via perfis.json só para coords
  let manifest = null;
  let coords = null;
  let robeMode = 'itens';
  try {
    manifest = await manifestStore.read(nome).catch(()=>null);
    if (manifest && manifest.robeMode) robeMode = String(manifest.robeMode);
  } catch {}
  try {
    // fallback cidade para coords (não bloqueante)
    const perfisArr = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'perfis.json')));
    const perfil = perfisArr.find(p => p && p.nome === nome);
    const city = (manifest && manifest.cidade) ? String(manifest.cidade) : String((perfil && perfil.cidade) || '');
    coords = utils.getCoords(city || '');
  } catch {}

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
  const msgUrl = 'https://www.messenger.com/marketplace';

  // Aba 0 — Facebook base
  try {
    await patchPage(nome, p0, coords);
  } catch (e) {
    if (dbg) logger.debug('[CONFIG] patchPage p0 fail', { nome, error: (e && e.message) || String(e) });
    throw e;
  }
  await injectCookies(p0, cookies);
  try { await p0.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
  try { await sleep(900); } catch {}
  try {
    const ui0 = await ensureFbUiUnblocked(p0, nome, { reasonBase: 'configure_fb0', allowGpt: true, maxRounds: 3 }).catch(()=>null);
    if (dbg) logger.debug('[CONFIG] fb0 ui', { nome, ui: ui0 || null });
  } catch {}
  // Se já caiu em login_form, não faz sentido abrir as outras abas (o worker seguirá para login+senha).
  try {
    const lr0 = await detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
    if (dbg) logger.debug('[CONFIG] fb0 lr', { nome, lr: lr0 || null, url: (p0.url ? String(p0.url()||'') : '') });
    if (lr0 && lr0.loginRequired && String(lr0.reason || '').toLowerCase().includes('login_form')) {
      return;
    }
  } catch {}

  // Aba 1 — Create (Robe)
  let p1 = null;
  try {
    p1 = await browser.newPage();
    await patchPage(nome, p1, coords);
    await injectCookies(p1, cookies);
    await p1.goto(createUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await sleep(1200);
    const ui1 = await ensureFbUiUnblocked(p1, nome, { reasonBase: 'configure_create', allowGpt: true, maxRounds: 3 }).catch(()=>null);
    if (dbg) logger.debug('[CONFIG] create ui', { nome, createUrl, ui: ui1 || null });
  } catch (e) {
    if (dbg) logger.debug('[CONFIG] create tab fail', { nome, error: (e && e.message) || String(e) });
  }

  // Aba 2 — Messenger (Virtus)
  let p2 = null;
  try {
    p2 = await browser.newPage();
    await patchPage(nome, p2, coords);
    await injectCookies(p2, cookies);
    await p2.goto(msgUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await sleep(900);
    try { await p2.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
    await sleep(900);

    // Nonce + “Continuar como...”
    await resolveNonceIfPresent(p2, { logPrefix: '[CONFIG][Messenger][nonce]' });
    const clicked = await clickContinuarComo(p2, { logPrefix: '[CONFIG][Messenger][continuar]' });
      if (!clicked) {
      await resolveNonceIfPresent(p2, { logPrefix: '[CONFIG][Messenger][nonce-2]' });
      await clickContinuarComo(p2, { logPrefix: '[CONFIG][Messenger][continuar-2]' });
    }

    // Curador: modal do PIN (determinístico, sem GPT — GPT tende a clicar/fechar e causar loop)
    try {
      const pin1 = await tryDismissMessengerPinModal(p2, { logPrefix: '[CONFIG][Messenger][pin]', maxTries: 4 });
        if (!pin1.ok) {
        // Uma espera extra e re-tenta 1 vez (sem cliques adicionais)
        await sleep(2500);
        const pin2 = await tryDismissMessengerPinModal(p2, { logPrefix: '[CONFIG][Messenger][pin-retry]', maxTries: 2 });
        if (!pin2.ok) {
          const still = await detectMessengerPinModal(p2);
          if (still.present) {
            // Fallback enterprise: permitir GPT ajudar a clicar “Criar PIN”/“Continuar sem PIN”
            // APENAS se a solução determinística falhar.
            try {
              await ensureFbUiUnblocked(p2, nome, { reasonBase: 'configure_msg_pin', allowGpt: true, maxRounds: 4 }).catch(()=>null);
            } catch {}
            await sleep(1200);
            const pin3 = await tryDismissMessengerPinModal(p2, { logPrefix: '[CONFIG][Messenger][pin-gpt-retry]', maxTries: 2 }).catch(()=>({ ok:false }));
            const still2 = await detectMessengerPinModal(p2).catch(()=>({ present:false }));
            if (still2 && still2.present) throw new Error('messenger_pin_modal');
            if (!pin3 || pin3.ok !== true) {
              // Se resolveu via UI unblock, ok; se não, o erro acima já aborta.
            }
          }
          }
        }
      } catch (e) {
        throw e;
      }

    const ui2 = await ensureFbUiUnblocked(p2, nome, { reasonBase: 'configure_msg', allowGpt: true, maxRounds: 3 }).catch(()=>null);
    if (dbg) logger.debug('[CONFIG] msg ui', { nome, ui: ui2 || null });
  } catch (e) {
    if (dbg) logger.debug('[CONFIG] messenger tab fail', { nome, error: (e && e.message) || String(e) });
    // Se ficou preso em PIN no provision, não mascarar: deixe o worker registrar/flaggear corretamente.
    const msg = (e && e.message) ? String(e.message) : String(e);
    if (/messenger_pin_modal/i.test(msg)) throw e;
  }

  if (dbg) {
    try {
      const ps = await browser.pages().catch(()=>[]);
      const urls = [];
      for (const pg of (ps || []).slice(0, 5)) { try { urls.push(String(pg.url() || '')); } catch { urls.push(''); } }
      logger.debug('[CONFIG] configureProfile (3-tabs) end', { nome, tabs: (ps || []).length, urls, robeMode, createUrl });
    } catch {}
  }
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
    // Enterprise: se já está em login/checkpoint/appeal/recover, NÃO navegar.
    // O humano precisa ver a tela problemática atual.
    let u0 = '';
    try { u0 = (typeof page.url === 'function') ? (page.url() || '') : ''; } catch {}
    const u = String(u0 || '').toLowerCase();
    const isProblemUrl =
      u.includes('/login') ||
      u.includes('/checkpoint') ||
      u.includes('/recover') ||
      u.includes('/help/contact') ||
      u.includes('/appeal');

    if (!isProblemUrl) {
    // Vai para o painel vendedor Marketplace
    const SELLING_URL = 'https://www.facebook.com/marketplace/you/selling';
    try {
      await page.goto(SELLING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      try { await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      }
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
          // Override por perfil (ex.: bootstrap precisa de mais tempo para navegar)
          let maxAge = ABOUTBLANK_MAX_AGE_MS;
          try {
            const ov = (browser && browser._aboutBlankMaxAgeMs && browser._aboutBlankMaxAgeMs[nome]) || 0;
            if (ov && Number.isFinite(Number(ov)) && Number(ov) > 0) maxAge = Number(ov);
          } catch {}
          const sup = (browser && browser._suppressBlankKillUntil && browser._suppressBlankKillUntil[nome]) || 0;
          const suppressed = (browser && browser._robeActiveFor === nome) || (sup > now);

          if (suppressed) {
            if (age != null && age >= maxAge) {
              // #region agent log
              // #endregion
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
          // #region agent log
          // #endregion
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

      return { hasRoyal, hasInputs, hasEmailInput, hasPassInput, hasLoginUiHints, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, hasIdentitySubmitted, identityStrongHints, bodyHasIdentityHints, hasHackedReview, hasPasswordResetRequired, hasBackToFacebookUnlocked, hasContentNotAvailable, hasPageNotAvailable, hasHumanConfirmPreScreen, hasCaptchaPromptText, hasCaptchaImg, hasCaptchaInput, hasContinueBtn, href0, path0, title0 };
    });

    const domain = (/messenger\.com/i.test(href) ? 'messenger' : 'facebook');
    const path = (v && v.path0) ? String(v.path0) : '';
    const strongLoginPath = /\/(login|checkpoint|recover|two_step_verification|security)/i.test(path);
    const hasRoyal = !!(v && v.hasRoyal);
    const hasInputs = !!(v && v.hasInputs);
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

    // Bug/erro do Messenger: "Esta página não está disponível"
    // Não é login_form/captcha; requer checagem ativa no worker (FB create -> SMS cliff?).
    if (hasPageNotAvailable) {
      return {
        loginRequired: true,
        reason: 'messenger_page_not_available',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasPageNotAvailable, path }
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
    if (domain === 'messenger' && hasInputs && (hasRoyal || hasLoginUiHints || looksLikeLoggedOutTitle || looksLikeLoginUrl)) {
      return {
        loginRequired: true,
        reason: 'login_form',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
      };
    }

    // Detecção mais conservadora para evitar falso positivo:
    // - login_form só é válido se a rota for claramente de login/checkpoint
    // - checkpoint/captcha também exige rota/sinais de checkpoint
    // IMPORTANT: em algumas telas, o form aparece em rotas como /marketplace ou /index.php (logged-out),
    // então não podemos depender apenas do path.
    if (hasInputs && (hasRoyal || hasLoginUiHints) && (strongLoginPath || looksLikeLoginUrl || looksLikeLoggedOutTitle || hasLoginUiHints)) {
      return {
        loginRequired: true,
        reason: 'login_form',
        domain,
        url: (v && v.href0) ? String(v.href0) : href,
        title,
        evidence: { hasRoyal, hasInputs, hasPersonaText, hasCheckpointText, hasIdentityText, hasTwoFactorText, hasAppealSubmitted, path }
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

// ==== CAPTCHA/CONFIRME-HUMANO HELPERS (SEM OCR IMPLEMENTADO) ====

async function clickContinueByLabel(page, { maxWaitMs = 10_000 } = {}) {
  try {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1500, Number(maxWaitMs || 0) || 0);
    while (Date.now() < deadline) {
      const r = await page.evaluate(() => {
        function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
        const candidates = Array.from(document.querySelectorAll('[role="button"],button,a')).slice(0, 1600);
        const pick = () => {
          for (const el of candidates) {
            const aria = norm(el.getAttribute && el.getAttribute('aria-label') ? el.getAttribute('aria-label') : '');
            const txt = norm(el.innerText || el.textContent || '');
            if (aria === 'continuar' || txt === 'continuar') return el;
          }
          return null;
        };
        const el = pick();
        if (!el) return { ok: false, error: 'continue_not_found' };
        // heurística “clicável”
        const ariaDisabled = (el.getAttribute && el.getAttribute('aria-disabled')) ? String(el.getAttribute('aria-disabled')) : '';
        const tabIndex = (el.getAttribute && el.getAttribute('tabindex')) ? String(el.getAttribute('tabindex')) : '';
        const disabled = (ariaDisabled === 'true') || (tabIndex === '-1');
        // clicar mesmo se disabled=false; se disabled=true, retornamos info e não clicamos
        if (disabled) return { ok: false, error: 'continue_disabled', ariaDisabled, tabIndex };
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        try { el.click(); } catch {}
        return { ok: true };
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
    await page.waitForTimeout(600);
  } catch {}

  try {
    // aguarda inputs aparecerem (evita “atropelo” de render)
    await page.waitForSelector('input[name="email"], input#email', { timeout: 12000 }).catch(()=>{});
    await page.waitForSelector('input[name="pass"], input#pass', { timeout: 12000 }).catch(()=>{});

    // limpa e digita com pequeno delay humano
    await page.evaluate(() => {
      const e = document.querySelector('input[name="email"], input#email');
      const p = document.querySelector('input[name="pass"], input#pass');
      if (e) e.value = '';
      if (p) p.value = '';
    }).catch(()=>{});
    await page.type('input[name="email"], input#email', email, { delay: 28 }).catch(()=>{});
    await page.type('input[name="pass"], input#pass', pass, { delay: 28 }).catch(()=>{});
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'type_failed' };
  }

  // 3) marcar "manter-me conectado" se existir
  await _maybeClickKeepConnected(page);

  // 4) submit (enterprise): click -> Enter -> form.submit -> GPT -> click (2a)
  try {
    // dá um respiro pra UI renderizar botões/handlers após preencher inputs
    await sleep(600);
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
      // fallback 1: Enter no campo senha
      try {
        await page.focus('input[name="pass"], input#pass').catch(()=>{});
        await page.keyboard.press('Enter').catch(()=>{});
        await sleep(450);
      } catch {}

      // fallback 2: form.submit()
      try {
        const submitted = await page.evaluate(() => {
          const form =
            document.querySelector('form#login_form') ||
            document.querySelector('form[data-testid="royal_login_form"]') ||
            document.querySelector('form[action*="/login/password/"]');
          if (!form) return false;
          try { form.submit(); return true; } catch { return false; }
        });
        if (submitted) await sleep(450);
      } catch {}

      // fallback 3: GPT (opcional) e tenta clique novamente 1x
      if (allowGpt && nome) {
        try { await gptRemediateFbUi(page, nome, { reason: 'login_submit_fallback', stage: 'login_submit' }); } catch {}
        await sleep(900);
        const clicked2 = await page.evaluate(() => {
          // inclui botões que não são submit mas funcionam como CTA
          const norm = (s) => (s || '').toLowerCase();
          const btn =
            document.querySelector('button#loginbutton, button[name="login"], button[type="submit"], [data-testid="royal-login-button"]') ||
            document.querySelector('form#login_form button[type="submit"]') ||
            document.querySelector('form[data-testid="royal_login_form"] button[type="submit"]') ||
            Array.from(document.querySelectorAll('button,div[role="button"],a[role="button"]')).find(el => {
              const t = norm(el.innerText || el.textContent || '');
              return t === 'entrar' || t === 'continuar' || t.includes('continuar') || t.includes('entrar') || t.includes('log in') || t.includes('sign in');
            });
          if (!btn) return false;
          try { btn.click(); return true; } catch { return false; }
        }).catch(()=>false);
        if (!clicked2) return { ok: false, error: 'login_submit_failed' };
      } else {
        return { ok: false, error: 'login_submit_failed' };
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
  installAboutBlankKiller,
  // ==== NOVOS:
  detectLoginRequired,
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
  killChromeProfileProcesses,
  closeChromeProfileProcessesGraceful,
  getChromeProfilePids,
  getChromeProfilePidsMeta
};