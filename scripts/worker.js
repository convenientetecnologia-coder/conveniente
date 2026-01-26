// scripts/worker.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');
const logger = require('./logger.js');
const { detectLimitOverlayDeep, detectLimitOverlayEverywhere } = require('./browser.js');

const browserHelper = require('./browser.js');
const virtusHelper = require('./virtus.js');
const robeHelper   = require('./robe.js');
const robeQueue    = require('./robeQueue.js');
const utils        = require('./utils.js');
const fotos        = require('./fotos.js');
const reloadManager = require('./reloadManager.js');

const issues = require('./issues.js');
const manifestStore = require('./manifestStore.js');
const fileStore = require('./fileStore.js');
const gptFallback = require('./gptFallback.js');
const provisionAudit = require('./provisionAudit.js');
const { readCtConfig } = require('./ctConfig.js');

// =========================
// BUILD/BOOT EVIDENCE (ultra enterprise)
// =========================
// Objetivo: prova irrefutável de que o worker carregou o código novo (e com quais envs).
const WORKER_BUILD_TAG = '2026-01-25_ultra_enterprise_diag_v1';
try {
  provisionAudit.append({
    ts: Date.now(),
    event: 'worker_boot',
    buildTag: WORKER_BUILD_TAG,
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    humanOverlayEnv: String(process.env.HUMAN_OVERLAY || '').trim(),
    portEnv: String(process.env.PORT || '').trim(),
    shardEnv: String(process.env.SHARD || process.env.SHARDS || '').trim(),
    ctBaseUrlConfigured: (() => { try { const c = readCtConfig(); return !!(c && c.ctBaseUrl); } catch { return false; } })(),
    logIngestSecretConfigured: (() => { try { const c = readCtConfig(); return !!(c && c.logIngestSecret); } catch { return false; } })()
  });
} catch {}

const DATA_DIR = path.join(__dirname, '..', 'dados');
const DIAG_DIR = path.join(DATA_DIR, 'diag');
const LR_EVENTS_JSONL = path.join(DATA_DIR, 'login_required_events.jsonl');
const LR_EVIDENCE_JSONL = path.join(DATA_DIR, 'login_remediate_evidence.jsonl');
const HOSTID_PATH = path.join(DATA_DIR, '.telemetry_hostid');

function ensureDirSync(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function safeFilePart(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 60) || 'x';
}
function appendJsonl(fp, obj) {
  try {
    ensureDirSync(path.dirname(fp));
    fs.appendFileSync(fp, JSON.stringify(obj) + '\n', 'utf8');
  } catch {}
}

async function appendLoginRemediateEvidence({ nome, operator, step, page, note } = {}) {
  try {
    if (!nome || !page) return;
    const url = (() => { try { return page.url ? String(page.url() || '') : ''; } catch { return ''; } })();
    const title = await page.title().catch(()=> '');
    const lr = await browserHelper.detectLoginRequired(page).catch(()=>({ loginRequired:false }));
    const html = await page.content().catch(()=> '');
    const htmlSnippet = String(html || '').slice(0, 4000);
    const screenshotBase64 = await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false, encoding: 'base64' }).catch(()=> '');
    appendJsonl(LR_EVIDENCE_JSONL, {
      ts: Date.now(),
      perfil: String(nome),
      operator: String(operator || ''),
      step: String(step || ''),
      note: note ? String(note).slice(0, 300) : null,
      url,
      title,
      lr,
      htmlSnippet,
      screenshotBase64: screenshotBase64 ? String(screenshotBase64).slice(0, 220000) : '' // hard cap
    });
  } catch {}
}
async function captureLoginRequiredEvidence(nome, page, lr) {
  try {
    if (!nome || !page) return;
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    const last = Number(robeMeta[nome].lastLREvidenceAt || 0) || 0;
    // Rate limit: no máximo 1 evidência a cada 30 minutos por perfil
    if (last > 0 && (now - last) < (30 * 60 * 1000)) return;
    robeMeta[nome].lastLREvidenceAt = now;

    const dir = path.join(DIAG_DIR, 'login_required', safeFilePart(nome));
    ensureDirSync(dir);
    const reason = safeFilePart(lr && lr.reason);
    const ts = now;
    const base = `${ts}_${reason}`;
    const png = path.join(dir, base + '.png');
    const html = path.join(dir, base + '.html');

    try { await page.screenshot({ path: png, fullPage: false }).catch(()=>{}); } catch {}
    try {
      const content = await page.content().catch(()=>null);
      if (content) fs.writeFileSync(html, String(content), 'utf8');
    } catch {}
    return true;
  } catch {}
  return false;
}

const _profileOpLocks = new Map();
async function lockProfileAction(nome, fn) {
  if (!nome) return fn();
  const prev = _profileOpLocks.get(nome) || Promise.resolve();
  let resolveNext;
  const next = new Promise(res => resolveNext = res);
  _profileOpLocks.set(nome, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    resolveNext();
    if (_profileOpLocks.get(nome) === next) _profileOpLocks.delete(nome);
  }
}

async function readAccountFlags(nome) {
  try {
    const m = await manifestStore.read(nome).catch(()=>null);
    return (m && m.accountFlags) ? m.accountFlags : {};
  } catch { return {}; }
}

function readHostIdSync() {
  try {
    if (fs.existsSync(HOSTID_PATH)) {
      const v = fs.readFileSync(HOSTID_PATH, 'utf8').trim();
      return v || '';
    }
  } catch {}
  return '';
}

async function fetchCredentialsFromCT({ profileName } = {}) {
  const cfg = readCtConfig();
  const base = String(cfg && cfg.ctBaseUrl || '').trim();
  const secret = String(cfg && cfg.logIngestSecret || '').trim();
  const hostId = readHostIdSync();
  const p = String(profileName || '').trim();
  if (!base || !secret || !hostId || !p) return { ok: false, error: 'ct_config_missing' };
  try {
    const Aborter = global.AbortController || require('node-abort-controller');
    const ac = new Aborter();
    const t = setTimeout(() => { try { ac.abort(); } catch {} }, 8000);
    const resp = await fetch(`${base}/api/stock/profile_credentials_secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Log-Secret': secret },
      body: JSON.stringify({ hostId, profileName: p }),
      signal: ac.signal
    });
    clearTimeout(t);
    const j = await resp.json().catch(()=>null);
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) ? String(j.error) : `http_${resp.status}` };
    const login = String(j.login || '').trim();
    const password = String(j.password || '').trim();
    if (!login || !password) return { ok: false, error: 'missing_credentials' };
    return { ok: true, login, password, stockAccountId: j.stockAccountId || null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function archiveBanWithEvidenceToCT({ profileName, reason = 'banned_detected', evidenceB64 = '', evidenceUrl = '' } = {}) {
  const cfg = readCtConfig();
  const base = String(cfg && cfg.ctBaseUrl || '').trim();
  const secret = String(cfg && cfg.logIngestSecret || '').trim();
  const hostId = readHostIdSync();
  const p = String(profileName || '').trim();
  if (!base || !secret || !hostId || !p) return { ok: false, error: 'ct_config_missing' };
  try {
    const Aborter = global.AbortController || require('node-abort-controller');
    const ac = new Aborter();
    const t = setTimeout(() => { try { ac.abort(); } catch {} }, 12000);
    const resp = await fetch(`${base}/api/stock/assigned/archive_with_evidence_secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Log-Secret': secret },
      body: JSON.stringify({
        hostId,
        profileName: p,
        reason: String(reason || 'banned_detected').slice(0, 120),
        by: 'auto',
        evidenceB64: String(evidenceB64 || '').trim(),
        evidenceUrl: String(evidenceUrl || '').trim()
      }),
      signal: ac.signal
    });
    clearTimeout(t);
    const j = await resp.json().catch(()=>null);
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) ? String(j.error) : `http_${resp.status}` };
    return { ok: true, archived: true, stockAccountId: j.id || null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function setLoginRequiredFlag(nome, { reason = '', source = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.loginRequired === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.loginRequired = true;
      man.accountFlags.loginReason = String(reason||'');
      man.accountFlags.loginSource = String(source||'');
      man.accountFlags.lastLoginRequiredAt = Date.now();
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'login_required_detected',
        `reason=${reason||''} source=${source||''} at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].loginRequired = true;
    robeMeta[nome].loginReason = reason || '';
    robeMeta[nome].loginSource = source || '';

    // Blindagem enterprise: se loginRequired foi detectado, Virtus NÃO pode ficar "Online".
    // Isso evita telemetria falsa (trabalhando=true) e evita loops de automação em tela de login.
    try {
      const ctrl = controllers.get(nome);
      if (ctrl) {
        ctrl.trabalhando = false;
        try { await stopVirtus(nome); } catch {}
      }
    } catch {}

    try { await snapshotStatusAndWrite(); } catch {}
  } catch {}
}

// Quando o fluxo automático tentou (cookies + login/senha) e falhou, marca persistente.
// Regra enterprise: NÃO re-tentar automaticamente em loop; só "Retomar trabalho" libera nova tentativa.
async function setLoginRemediateFailedFlag(nome, { reason = '', source = '', stage = '' } = {}) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.loginRemediateFailed = true;
      man.accountFlags.loginRemediateFailedAt = Date.now();
      man.accountFlags.loginRemediateFailedReason = String(reason || '').slice(0, 220);
      man.accountFlags.loginRemediateFailedSource = String(source || '').slice(0, 120);
      if (stage) man.accountFlags.loginRemediateFailedStage = String(stage || '').slice(0, 80);
      man.accountFlags.loginRemediateFailedCount = Number(man.accountFlags.loginRemediateFailedCount || 0) + 1;
      return man;
    });
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].loginRemediateFailed = true;
    robeMeta[nome].loginRemediateFailedReason = String(reason || '').slice(0, 220);
    robeMeta[nome].whyNotOpen = 'login_remediate_failed';
  } catch {}
}

// ===== Human Overlay (HUD) =====
// Objetivo: quando entrar em modo humano, mostrar painel fixo no navegador com nome/motivo/login/senha e botões (copiar/retomar).
const HUMAN_OVERLAY_CFG = {
  enabled: String(process.env.HUMAN_OVERLAY || '').trim() !== '0',
  maxPagesScan: 8
};

function _overlayReasonFromFlags(flags) {
  try {
    flags = (flags && typeof flags === 'object') ? flags : {};
    if (flags.banned === true) return `banned:${flags.bannedReason || ''}`.trim();
    if (flags.twoFactor === true) return `two_factor:${flags.twoFactorReason || ''}`.trim();
    if (flags.appealSubmitted === true) return 'appeal_submitted';
    if (flags.messengerPin === true) return `messenger_pin:${flags.messengerPinReason || ''}`.trim();
    if (flags.loginRemediateFailed === true) return `login_remediate_failed:${flags.loginRemediateFailedReason || ''}`.trim();
    if (flags.loginRequired === true) return String(flags.loginReason || 'login_required');
    return 'human_mode';
  } catch { return 'human_mode'; }
}

async function _buildHumanOverlayData(nome) {
  try {
    const perfisArr = loadPerfisJson();
    const p = Array.isArray(perfisArr) ? perfisArr.find(x => x && x.nome === nome) : null;
    const man = await manifestStore.read(nome).catch(()=>null);
    const flags = (man && man.accountFlags) ? man.accountFlags : (await readAccountFlags(nome).catch(()=>({})));

    const desired = readJsonFile(desiredPath, { perfis: {} });
    const want = (desired && desired.perfis && desired.perfis[nome]) ? desired.perfis[nome] : {};

    let login = man && (man.login || man.email || man.user || man.username) ? String(man.login || man.email || man.user || man.username) : '';
    let password = man && (man.password || man.pass) ? String(man.password || man.pass) : '';

    // Enterprise: se manifest não tem credenciais, tenta buscar do CT (assigned->stock).
    // Cache curto em memória para não spammar CT.
    try {
      if (!String(login || '').trim() || !String(password || '').trim()) {
        robeMeta[nome] = robeMeta[nome] || {};
        const cache = robeMeta[nome].overlayCredCache || null;
        const now = Date.now();
        if (cache && cache.ts && (now - Number(cache.ts || 0)) < 5 * 60 * 1000 && cache.login && cache.password) {
          login = String(cache.login || '');
          password = String(cache.password || '');
        } else {
          const rr = await fetchCredentialsFromCT({ profileName: nome }).catch(()=>null);
          if (rr && rr.ok) {
            login = String(rr.login || '');
            password = String(rr.password || '');
            robeMeta[nome].overlayCredCache = { ts: now, login, password, stockAccountId: rr.stockAccountId || null };
          }
        }
      }
    } catch {}

    const data = {
      enabled: true,
      nome: String(nome || ''),
      label: p && p.label ? String(p.label) : '',
      cidade: p && p.cidade ? String(p.cidade) : '',
      uaPresetId: p && p.uaPresetId ? String(p.uaPresetId) : '',
      stockAccountId: (robeMeta[nome] && robeMeta[nome].overlayCredCache && robeMeta[nome].overlayCredCache.stockAccountId) ? robeMeta[nome].overlayCredCache.stockAccountId : null,
      login,
      password,
      reason: _overlayReasonFromFlags(flags),
      flags: {
        loginRequired: flags && flags.loginRequired === true,
        loginReason: flags ? (flags.loginReason || '') : '',
        banned: flags && flags.banned === true,
        appealSubmitted: flags && flags.appealSubmitted === true,
        messengerPin: flags && flags.messengerPin === true,
        loginRemediateFailed: flags && flags.loginRemediateFailed === true
      },
      desired: {
        active: want && want.active === true,
        virtus: want && want.virtus ? String(want.virtus) : '',
        humanHold: want && want.humanHold === true
      },
      ts: Date.now()
    };
    return data;
  } catch {
    return { enabled: true, nome: String(nome || ''), label: '', cidade: '', login: '', password: '', reason: 'human_mode', ts: Date.now() };
  }
}

async function _setOverlayDataOnPage(page, data) {
  try {
    await page.evaluate((d) => {
      try {
        window.__ctHumanOverlaySetData && window.__ctHumanOverlaySetData(d);
      } catch {}
    }, data).catch(()=>{});
  } catch {}
}

async function _installOverlayOnPage(nome, page) {
  if (!page) return;
  try {
    // Expor callback de "Retomar trabalho" (executa no Node, sem depender de HTTP/CORS).
    try {
      await page.exposeFunction('__ctHumanOverlayResume', async () => {
        try {
          // Evidência enterprise (sem credenciais)
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_resume_clicked', nome: String(nome || '') }); } catch {}
        } catch {}
        try { await handlers['human-resume']({ nome }); } catch {}
        try { await syncHumanOverlay(nome); } catch {}
        return true;
      });
    } catch {}

    // Injeção persistente (recria em toda navegação) + injeção imediata no documento atual.
    try {
      const overlayInstall = () => {
        try {
          if (window.__ctHumanOverlayInstalled) return;
          window.__ctHumanOverlayInstalled = true;

          const HOST_ID = 'ct-human-overlay-host';
          const nowIso = () => { try { return new Date().toISOString(); } catch { return ''; } };

          function ensureHost() {
            let host = document.getElementById(HOST_ID);
            if (host) return host;
            host = document.createElement('div');
            host.id = HOST_ID;
            host.style.position = 'fixed';
            host.style.top = '12px';
            host.style.right = '12px';
            host.style.zIndex = '2147483647';
            host.style.pointerEvents = 'auto';
            host.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
            document.documentElement.appendChild(host);

            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
              <style>
                .wrap{ width: 360px; background:#0b1220; color:#e6e9ef; border:1px solid rgba(255,255,255,.18); border-radius:12px; box-shadow:0 12px 30px rgba(0,0,0,.45); overflow:hidden; }
                .hdr{ display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,.06); }
                .ttl{ font-weight:700; font-size:13px; letter-spacing:.2px; }
                .tag{ font-size:11px; opacity:.9; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.14); }
                .body{ padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
                .row{ display:flex; gap:8px; align-items:flex-start; }
                .k{ width:90px; font-size:11px; opacity:.8; padding-top:2px; }
                .v{ flex:1; font-size:12px; word-break:break-word; }
                .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
                .btns{ display:flex; gap:8px; flex-wrap:wrap; }
                button{ cursor:pointer; border-radius:10px; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.08); color:#e6e9ef; padding:8px 10px; font-size:12px; }
                button:hover{ background:rgba(255,255,255,.12); }
                button.primary{ background:#2563eb; border-color:rgba(255,255,255,.18); }
                button.primary:hover{ background:#1d4ed8; }
                button.danger{ background:rgba(239,68,68,.18); border-color:rgba(239,68,68,.35); }
                .hint{ font-size:11px; opacity:.75; line-height:1.25; }
                .ok{ color:#86efac; }
                .bad{ color:#fca5a5; }
                .warn{ color:#fde68a; }
              </style>
              <div class="wrap" id="wrap">
                <div class="hdr">
                  <div>
                    <div class="ttl">Modo Humano — Conveniente</div>
                    <div class="hint" id="sub"></div>
                  </div>
                  <div class="tag" id="tag">HUMANO</div>
                </div>
                <div class="body">
                  <div class="row"><div class="k">Conta</div><div class="v" id="nome"></div></div>
                  <div class="row"><div class="k">Motivo</div><div class="v mono" id="reason"></div></div>
                  <div class="row"><div class="k">Login</div><div class="v mono" id="login"></div></div>
                  <div class="row"><div class="k">Senha</div><div class="v mono" id="pass"></div></div>
                  <div class="btns">
                    <button id="copyLogin">Copiar login</button>
                    <button id="copyPass">Copiar senha</button>
                    <button class="primary" id="resume">Retomar trabalho</button>
                    <button class="danger" id="hide">Fechar</button>
                  </div>
                  <div class="hint" id="hint"></div>
                </div>
              </div>
            `;

            const $ = (id) => shadow.getElementById(id);
            const copyText = async (txt) => {
              const s = String(txt || '');
              if (!s) return false;
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(s);
                  return true;
                }
              } catch {}
              try {
                const ta = document.createElement('textarea');
                ta.value = s;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return !!ok;
              } catch {}
              return false;
            };

            $('copyLogin')?.addEventListener('click', async () => {
              const d = window.__ctHumanOverlayData || {};
              await copyText(d.login || '');
            });
            $('copyPass')?.addEventListener('click', async () => {
              const d = window.__ctHumanOverlayData || {};
              await copyText(d.password || '');
            });
            $('hide')?.addEventListener('click', () => {
              try { host.style.display = 'none'; } catch {}
            });
            $('resume')?.addEventListener('click', async () => {
              try {
                if (!confirm('Retomar trabalho nesta conta?')) return;
              } catch {}
              try { host.style.display = 'none'; } catch {}
              try {
                if (window.__ctHumanOverlayResume) {
                  await window.__ctHumanOverlayResume();
                }
              } catch {}
            });

            return host;
          }

          function render() {
            const d = window.__ctHumanOverlayData || null;
            const enabled = !!(d && d.enabled === true);
            const host = document.getElementById(HOST_ID);
            if (!enabled) {
              if (host) host.style.display = 'none';
              return;
            }
            const h = ensureHost();
            try { h.style.display = 'block'; } catch {}
            const shadow = h.shadowRoot;
            if (!shadow) return;
            const $ = (id) => shadow.getElementById(id);
            const nome = [d.nome, d.label ? `— ${d.label}` : '', d.cidade ? `(${d.cidade})` : ''].filter(Boolean).join(' ');
            $('nome').textContent = nome;
            $('reason').textContent = String(d.reason || '');
            $('login').textContent = String(d.login || '');
            $('pass').textContent = String(d.password || '');
            $('sub').textContent = `Atualizado: ${nowIso()}`;

            const f = d.flags || {};
            let statusTxt = '';
            if (f.banned) statusTxt = 'Conta suspensa/banida';
            else if (f.twoFactor) statusTxt = '2FA requerido (excluída)';
            else if (f.appealSubmitted) statusTxt = 'Recurso em análise (monitor 1h)';
            else if (f.loginRemediateFailed) statusTxt = 'Login/Cookies falhou (humano)';
            else if (f.loginRequired) statusTxt = 'Login requerido';
            else statusTxt = 'Modo humano ativo';
            $('hint').textContent = statusTxt;
          }

          window.__ctHumanOverlaySetData = (d) => {
            try { window.__ctHumanOverlayData = d || {}; } catch {}
            try { render(); } catch {}
          };
          window.__ctHumanOverlayHide = () => {
            try {
              const h = document.getElementById(HOST_ID);
              if (h) h.style.display = 'none';
            } catch {}
          };

          window.addEventListener('DOMContentLoaded', () => { try { render(); } catch {} }, { once: true });
          // Resiliência: se SPA mexer no DOM e remover, recria.
          setInterval(() => { try { render(); } catch {} }, 5000);
        } catch {}
      };
      // 1) Para futuras navegações
      await page.evaluateOnNewDocument(overlayInstall);
      // 2) Para a página atual (senão o overlay só aparece após navegar/recarregar)
      await page.evaluate(overlayInstall).catch(()=>{});
    } catch {}
  } catch {}
}

async function syncHumanOverlay(nome) {
  try {
    if (!HUMAN_OVERLAY_CFG.enabled) {
      try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_disabled', nome: String(nome || ''), env: String(process.env.HUMAN_OVERLAY || '').trim() }); } catch {}
      return;
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return;

    const desired = readJsonFile(desiredPath, { perfis: {} });
    const wantHold = !!(desired && desired.perfis && desired.perfis[nome] && desired.perfis[nome].humanHold === true);
    const want = wantHold || (ctrl.humanControl === true);

    const pages = await ctrl.browser.pages().catch(()=>[]);
    const data = want ? await _buildHumanOverlayData(nome) : { enabled: false, nome: String(nome || ''), ts: Date.now() };

    const diag = [];
    const scanned = (pages || []).slice(0, HUMAN_OVERLAY_CFG.maxPagesScan);
    for (const pg of scanned) {
      if (!pg) continue;
      if (want) {
        await _installOverlayOnPage(nome, pg);
      }
      await _setOverlayDataOnPage(pg, data);
      // Diagnóstico enterprise: prova irrefutável de que o overlay foi instalado/atualizado nesta aba.
      try {
        const d = await pg.evaluate(() => {
          try {
            const hostId = 'ct-human-overlay-host';
            return {
              url: (typeof location !== 'undefined' && location && location.href) ? String(location.href) : '',
              installed: !!window.__ctHumanOverlayInstalled,
              hasSetData: typeof window.__ctHumanOverlaySetData === 'function',
              hasResume: typeof window.__ctHumanOverlayResume === 'function',
              hasHost: !!document.getElementById(hostId),
              hostVisible: (() => {
                try {
                  const h = document.getElementById(hostId);
                  if (!h) return false;
                  const ds = String((h.style && h.style.display) || '');
                  return ds !== 'none';
                } catch { return false; }
              })()
            };
          } catch (e) {
            return { url: '', installed: false, hasSetData: false, hasResume: false, hasHost: false, hostVisible: false, error: String(e && e.message || e) };
          }
        }).catch((e) => ({ url: '', installed: false, hasSetData: false, hasResume: false, hasHost: false, hostVisible: false, error: String(e && e.message || e) }));
        diag.push(d);
      } catch (e) {
        diag.push({ url: '', installed: false, hasSetData: false, hasResume: false, hasHost: false, hostVisible: false, error: String(e && e.message || e) });
      }
    }
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'human_overlay_sync',
        nome: String(nome || ''),
        wantHold: !!wantHold,
        want: !!want,
        pagesCount: Array.isArray(pages) ? pages.length : 0,
        scanned: scanned.length,
        diag: diag.slice(0, 4) // evita log gigante
      });
    } catch {}
  } catch {}
}

async function ensureHumanOverlay(nome, ctrl, { reason = '' } = {}) {
  try {
    if (!HUMAN_OVERLAY_CFG.enabled) {
      try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_ensure_skipped_disabled', nome: String(nome || ''), reason: String(reason || '').slice(0, 120) }); } catch {}
      return;
    }
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return;
    // Evidência enterprise (sem credenciais)
    try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_installed', nome: String(nome || ''), reason: String(reason || '').slice(0, 120) }); } catch {}

    // Instala nos pages atuais + sincroniza data.
    await syncHumanOverlay(nome);

    // Hook para novas abas (1x por perfil).
    robeMeta[nome] = robeMeta[nome] || {};
    if (robeMeta[nome].humanOverlayHooked === true) return;
    robeMeta[nome].humanOverlayHooked = true;
    try {
      ctrl.browser.on('targetcreated', async (t) => {
        try {
          if (!t || typeof t.type !== 'function') return;
          if (t.type() !== 'page') return;
          const pg = await t.page().catch(()=>null);
          if (!pg) return;
          await syncHumanOverlay(nome);
        } catch {}
      });
    } catch {}
  } catch {}
}

// ===== Recurso/Apelação (monitoramento) =====
const APPEAL_CFG = {
  intervalMs: 60 * 60 * 1000,      // 1h
  firstDelayMs: 60 * 60 * 1000,    // 1h (timer inicial após "Retomar trabalho")
  maxPagesScan: 8
};

async function setAppealSubmittedFlag(nome, { source = '', url = '', title = '' } = {}) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.appealSubmitted = true;
      man.accountFlags.appealSubmittedAt = Number(man.accountFlags.appealSubmittedAt || 0) || Date.now();
      man.accountFlags.appealSource = String(source || '').slice(0, 80);
      man.accountFlags.appealUrl = String(url || '').slice(0, 300);
      man.accountFlags.appealTitle = String(title || '').slice(0, 200);
      // Por padrão, não começa a monitorar imediatamente: "Retomar trabalho" arma o monitor.
      if (!man.accountFlags.appealNextCheckAt) man.accountFlags.appealNextCheckAt = 0;
      man.accountFlags.appealLastReason = 'appeal_submitted';
      return man;
    });
    // Evidência enterprise: provision_audit é allowlisted via fetch_logs.
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_detected',
        nome: String(nome || ''),
        source: String(source || '').slice(0, 80),
        url: String(url || '').slice(0, 220),
        title: String(title || '').slice(0, 120)
      });
    } catch {}
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].appealSubmitted = true;
    robeMeta[nome].whyNotOpen = 'appeal_submitted';
  } catch {}

  // Modo seguro: automação OFF e browser disponível para inspeção.
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
      return d;
    });
  } catch {}
  try {
    const ctrl = controllers.get(nome);
    if (ctrl) {
      ctrl.humanControl = true;
      ctrl.trabalhando = false;
      try { await stopVirtus(nome); } catch {}
    }
  } catch {}
  try {
    const ctrl = controllers.get(nome);
    if (ctrl) await ensureHumanOverlay(nome, ctrl, { reason: 'appeal_submitted' });
  } catch {}
}

async function armAppealMonitor(nome, { delayMs = APPEAL_CFG.firstDelayMs } = {}) {
  try {
    const next = Date.now() + Math.max(60_000, Number(delayMs || 0) || 0);
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      if (man.accountFlags.appealSubmitted !== true) return man;
      man.accountFlags.appealLastArmedAt = Date.now();
      man.accountFlags.appealNextCheckAt = next;
      return man;
    });
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_armed',
        nome: String(nome || ''),
        nextAt: next,
        delayMs: Math.max(0, next - Date.now())
      });
    } catch {}
  } catch {}
}

async function clearAppealSubmittedFlag(nome) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      delete man.accountFlags.appealSubmitted;
      delete man.accountFlags.appealSubmittedAt;
      delete man.accountFlags.appealSource;
      delete man.accountFlags.appealUrl;
      delete man.accountFlags.appealTitle;
      delete man.accountFlags.appealNextCheckAt;
      delete man.accountFlags.appealLastCheckAt;
      delete man.accountFlags.appealLastReason;
      delete man.accountFlags.appealLastArmedAt;
      return man;
    });
    if (robeMeta[nome]) {
      delete robeMeta[nome].appealSubmitted;
      if (robeMeta[nome].whyNotOpen === 'appeal_submitted') delete robeMeta[nome].whyNotOpen;
    }
  } catch {}
}

async function appealMonitorCheckNow(nome, ctrl) {
  const now = Date.now();
  try {
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'no_browser' };
    const pages = await ctrl.browser.pages().catch(()=>[]);
    const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
    const pickFb = () => {
      for (const pg of (pages || []).slice(0, APPEAL_CFG.maxPagesScan)) {
        const u = safeUrl(pg);
        if (/facebook\.com/i.test(u)) return pg;
      }
      return (pages && pages[0]) || null;
    };
    const pg = pickFb();
    if (!pg) return { ok: false, error: 'no_pages' };

    try {
      provisionAudit.append({
        ts: now,
        event: 'appeal_monitor_check_begin',
        nome: String(nome || ''),
        url: String(safeUrl(pg) || '').slice(0, 220)
      });
    } catch {}

    // Refresh leve + detecção
    try { await pg.bringToFront?.().catch(()=>{}); } catch {}
    await pg.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await sleep(900);
    const lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:false }));

    // Atualiza telemetria do monitor
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        if (man.accountFlags.appealSubmitted !== true) return man;
        man.accountFlags.appealLastCheckAt = now;
        man.accountFlags.appealLastReason = lr && lr.loginRequired ? String(lr.reason || '') : '';
        man.accountFlags.appealNextCheckAt = now + APPEAL_CFG.intervalMs;
        return man;
      });
    } catch {}

    if (!lr || lr.loginRequired !== true) {
      // Liberou: limpa flags e retoma trabalho normal
      await clearAppealSubmittedFlag(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d.perfis = d.perfis || {};
          d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'on' };
          return d;
        });
      } catch {}
      try {
        ctrl.humanControl = false;
        if (automationAllowed(ctrl)) {
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
          ctrl.trabalhando = true;
        }
        try { unfreezeCooldownIfWorking(nome); } catch {}
      } catch {}
      try { await issues.append(nome, 'mil_action', 'appeal_monitor_resolved_active'); } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'appeal_monitor_resolved_active',
          nome: String(nome || '')
        });
      } catch {}
      return { ok: true, resolved: true };
    }

    // Ainda bloqueado.
    const rr = String(lr.reason || '').toLowerCase();
    if (rr.includes('appeal_submitted')) {
      try { await issues.append(nome, 'mil_action', 'appeal_monitor_still_pending'); } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'appeal_monitor_still_pending',
          nome: String(nome || ''),
          reason: String(lr.reason || '').slice(0, 200),
          nextAt: now + APPEAL_CFG.intervalMs
        });
      } catch {}
      return { ok: true, pending: true };
    }

    // Mudou para outro bloqueio (login/checkpoint/captcha etc): delega para pipeline existente.
    try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' }); } catch {}
    try { await issues.append(nome, 'mil_action', `appeal_monitor_transition reason=${rr}`); } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_transition',
        nome: String(nome || ''),
        reason: String(lr.reason || '').slice(0, 220),
        nextAt: now + APPEAL_CFG.intervalMs
      });
    } catch {}
    return { ok: true, transitioned: true, reason: rr };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        if (man.accountFlags.appealSubmitted !== true) return man;
        man.accountFlags.appealLastCheckAt = now;
        man.accountFlags.appealLastReason = `error:${msg}`.slice(0, 120);
        man.accountFlags.appealNextCheckAt = now + APPEAL_CFG.intervalMs;
        return man;
      });
    } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_error',
        nome: String(nome || ''),
        error: String(msg || '').slice(0, 220),
        nextAt: now + APPEAL_CFG.intervalMs
      });
    } catch {}
    return { ok: false, error: msg };
  }
}

async function setBannedFlag(nome, { reason = '', snippet = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.banned === true;
    // Evidence + auto-delete (ultra enterprise):
    // - arquiva no CT (Excluídas) com print
    // - deleta o perfil local para liberar slot
    // Guardrails:
    // - não logar credenciais
    // - best-effort (não pode travar o worker)
    // - nunca para estados não-banned (appeal/captcha/identity não passam aqui)
    try {
      // 1) Captura screenshot (se o browser estiver aberto)
      let b64 = '';
      let url = '';
      try {
        const ctrl = controllers.get(nome);
        const pages = ctrl && ctrl.browser ? await ctrl.browser.pages().catch(()=>[]) : [];
        const p0 = pages && pages[0];
        if (p0) {
          try { url = (typeof p0.url === 'function') ? (p0.url() || '') : ''; } catch {}
          try {
            const buf = await p0.screenshot({ type: 'jpeg', quality: 75, fullPage: true }).catch(()=>null);
            if (buf && buf.length) b64 = Buffer.from(buf).toString('base64');
          } catch {}
        }
      } catch {}

      // 2) Arquiva no CT com evidence (se CT configurado)
      try {
        const rr = await archiveBanWithEvidenceToCT({
          profileName: nome,
          reason: `banned:${String(reason||'banned').slice(0,80)}`,
          evidenceB64: b64,
          evidenceUrl: url
        });
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'auto_archive_banned_ct',
            nome: String(nome||''),
            ok: !!(rr && rr.ok),
            error: rr && rr.ok ? null : String(rr && rr.error || 'error').slice(0, 180),
            stockAccountId: rr && rr.stockAccountId || null
          });
        } catch {}
      } catch {}

      // 3) Deleta o perfil local (best-effort)
      try {
        const rr = await (async () => {
          try {
            // IMPORTANTE (enterprise):
            // Não chamar o endpoint HTTP DELETE /api/perfis/:nome daqui.
            // setBannedFlag pode rodar dentro de lockProfileAction; o endpoint DELETE chama worker.deactivate e pode deadlockar.

            // 3.1) desired OFF (evita reabrir)
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
                return d;
              });
            } catch {}

            // 3.2) hard close do controller (se ativo)
            try {
              const ctrl = controllers.get(nome);
              if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
                try { if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') await ctrl.virtus.stop(); } catch {}
                ctrl.virtus = null;
                ctrl.trabalhando = false;
                try { await withTimeout('auto_banned_hard_close', hardCloseController(nome, ctrl, { reason: 'auto_banned_delete', allowKillUserDataDir: false }), 75_000).catch(()=>null); } catch {}
              }
            } catch {}
            try { controllers.delete(nome); } catch {}
            try { stopPruneLoop(nome); } catch {}

            // 3.3) remover userDataDir externo (se houver) e remover do perfis.json
            try {
              const perfisArr = loadPerfisJson();
              const perfil = Array.isArray(perfisArr) ? perfisArr.find(p => p && p.nome === nome) : null;
              const udir = perfil && perfil.userDataDir ? String(perfil.userDataDir) : '';
              if (udir) {
                try { if (fs.existsSync(udir)) fileStore.rimrafSync(udir); } catch {}
              }
              const arr2 = Array.isArray(perfisArr) ? perfisArr.filter(p => p && p.nome !== nome) : [];
              try { savePerfisJson(arr2); } catch {}
            } catch {}

            // 3.4) remover desired entry e diretório do perfil (manifest/meta)
            try { await fileStore.removeDesired(nome); } catch {}
            try {
              const dir = path.join(fileStore.perfisDir, nome);
              try { fileStore.rimrafSync(dir); } catch {}
            } catch {}

            // 3.5) limpeza cosmética do status.json
            try {
              const st = fileStore.readJsonSafe(fileStore.statusPath, null);
              if (st && Array.isArray(st.perfis)) {
                st.perfis = st.perfis.filter(p => p && p.nome !== nome);
                fileStore.writeJsonAtomic(fileStore.statusPath, st);
              }
            } catch {}

            try { await snapshotStatusAndWrite(); } catch {}
            return { ok: true };
          } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
          }
        })();
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'auto_delete_banned_profile',
            nome: String(nome||''),
            ok: !!(rr && rr.ok),
            error: rr && rr.ok ? null : String(rr && rr.error || 'error').slice(0, 180)
          });
        } catch {}
      } catch {}
    } catch {}
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.banned = true;
      man.accountFlags.bannedAt = Date.now();
      man.accountFlags.bannedReason = String(reason||'');
      man.accountFlags.bannedText = String(snippet||'').slice(0, 400);
      // Enterprise: se chegou ao ban, não faz sentido manter "loginRemediateFailed" mascarando o estado.
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'account_banned_detected',
        `reason=${reason||''} snippet="${(snippet||'').slice(0,120)}" at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].banned = true;
    // Mantém coerência no runtime store também.
    delete robeMeta[nome].loginRemediateFailed;
    delete robeMeta[nome].loginRemediateFailedReason;
  } catch {}
}

// 2FA (two-factor) => exclusão automática (ultra enterprise)
// Regra do cliente: 2FA não é automatizável e não deve consumir slot do estoque.
async function setTwoFactorFlag(nome, { reason = 'two_factor', snippet = '' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.twoFactor === true;

    // Evidence + auto-delete:
    // - arquiva no CT (Excluídas) com print
    // - deleta o perfil local para liberar slot
    try {
      // 1) Captura screenshot (se o browser estiver aberto)
      let b64 = '';
      let url = '';
      try {
        const ctrl = controllers.get(nome);
        const pages = ctrl && ctrl.browser ? await ctrl.browser.pages().catch(()=>[]) : [];
        const p0 = pages && pages[0];
        if (p0) {
          try { url = (typeof p0.url === 'function') ? (p0.url() || '') : ''; } catch {}
          try {
            const buf = await p0.screenshot({ type: 'jpeg', quality: 75, fullPage: true }).catch(()=>null);
            if (buf && buf.length) b64 = Buffer.from(buf).toString('base64');
          } catch {}
        }
      } catch {}

      // 2) Arquiva no CT com evidence (se CT configurado)
      try {
        const rr = await archiveBanWithEvidenceToCT({
          profileName: nome,
          reason: `two_factor:${String(reason||'two_factor').slice(0,80)}`,
          evidenceB64: b64,
          evidenceUrl: url
        });
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'auto_archive_two_factor_ct',
            nome: String(nome||''),
            ok: !!(rr && rr.ok),
            error: rr && rr.ok ? null : String(rr && rr.error || 'error').slice(0, 180),
            stockAccountId: rr && rr.stockAccountId || null
          });
        } catch {}
      } catch {}

      // 3) Deleta o perfil local (best-effort) — mesmo mecanismo do ban (sem HTTP, evita deadlock)
      try {
        const rr = await (async () => {
          try {
            // desired OFF
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
                return d;
              });
            } catch {}

            // hard close do controller (se ativo)
            try {
              const ctrl = controllers.get(nome);
              if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
                try { if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') await ctrl.virtus.stop(); } catch {}
                ctrl.virtus = null;
                ctrl.trabalhando = false;
                try { await withTimeout('auto_two_factor_hard_close', hardCloseController(nome, ctrl, { reason: 'auto_two_factor_delete', allowKillUserDataDir: false }), 75_000).catch(()=>null); } catch {}
              }
            } catch {}
            try { controllers.delete(nome); } catch {}
            try { stopPruneLoop(nome); } catch {}

            // remover userDataDir externo e perfis.json
            try {
              const perfisArr = loadPerfisJson();
              const perfil = Array.isArray(perfisArr) ? perfisArr.find(p => p && p.nome === nome) : null;
              const udir = perfil && perfil.userDataDir ? String(perfil.userDataDir) : '';
              if (udir) {
                try { if (fs.existsSync(udir)) fileStore.rimrafSync(udir); } catch {}
              }
              const arr2 = Array.isArray(perfisArr) ? perfisArr.filter(p => p && p.nome !== nome) : [];
              try { savePerfisJson(arr2); } catch {}
            } catch {}

            // remover desired e diretório do perfil
            try { await fileStore.removeDesired(nome); } catch {}
            try {
              const dir = path.join(fileStore.perfisDir, nome);
              try { fileStore.rimrafSync(dir); } catch {}
            } catch {}

            // limpeza status.json
            try {
              const st = fileStore.readJsonSafe(fileStore.statusPath, null);
              if (st && Array.isArray(st.perfis)) {
                st.perfis = st.perfis.filter(p => p && p.nome !== nome);
                fileStore.writeJsonAtomic(fileStore.statusPath, st);
              }
            } catch {}

            try { await snapshotStatusAndWrite(); } catch {}
            return { ok: true };
          } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
          }
        })();
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'auto_delete_two_factor_profile',
            nome: String(nome||''),
            ok: !!(rr && rr.ok),
            error: rr && rr.ok ? null : String(rr && rr.error || 'error').slice(0, 180)
          });
        } catch {}
      } catch {}
    } catch {}

    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.twoFactor = true;
      man.accountFlags.twoFactorAt = Date.now();
      man.accountFlags.twoFactorReason = String(reason||'');
      man.accountFlags.twoFactorText = String(snippet||'').slice(0, 400);
      // 2FA exclui do fluxo, então não faz sentido manter flags que induzem auto-remediação
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      return man;
    });

    if (!already) {
      try {
        await issues.append(
          nome,
          'account_two_factor_detected',
          `reason=${reason||''} snippet="${(snippet||'').slice(0,120)}" at=${new Date().toISOString()}`
        );
      } catch {}
    }

    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].twoFactor = true;
  } catch {}
}

async function setMessengerPinFlag(nome, { reason = 'messenger_pin_modal', source = 'messenger' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.messengerPin === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.messengerPin = true;
      man.accountFlags.messengerPinReason = String(reason || '');
      man.accountFlags.messengerPinSource = String(source || '');
      man.accountFlags.messengerPinAt = Date.now();
      return man;
    });
    if (!already) {
      await issues.append(nome, 'mil_action', `messenger_pin_detected reason=${reason||''} source=${source||''} at=${new Date().toISOString()}`);
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].messengerPin = true;
    robeMeta[nome].whyNotOpen = 'messenger_pin_modal';
  } catch {}
}

async function clearAccountFlags(nome, which = ['loginRequired','banned']) {
  try {
    const prev = await readAccountFlags(nome);
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      if (which.includes('loginRequired')) {
        if (man.accountFlags.loginRequired || man.accountFlags.loginReason || man.accountFlags.loginSource) {
          delete man.accountFlags.loginRequired;
          delete man.accountFlags.loginReason;
          delete man.accountFlags.loginSource;
          delete man.accountFlags.lastLoginRequiredAt;
        }
      }
      if (which.includes('loginRemediateFailed')) {
        if (
          man.accountFlags.loginRemediateFailed ||
          man.accountFlags.loginRemediateFailedAt ||
          man.accountFlags.loginRemediateFailedReason ||
          man.accountFlags.loginRemediateFailedSource ||
          man.accountFlags.loginRemediateFailedStage ||
          man.accountFlags.loginRemediateFailedCount
        ) {
          delete man.accountFlags.loginRemediateFailed;
          delete man.accountFlags.loginRemediateFailedAt;
          delete man.accountFlags.loginRemediateFailedReason;
          delete man.accountFlags.loginRemediateFailedSource;
          delete man.accountFlags.loginRemediateFailedStage;
          delete man.accountFlags.loginRemediateFailedCount;
        }
      }
      if (which.includes('banned')) {
        if (man.accountFlags.banned || man.accountFlags.bannedAt || man.accountFlags.bannedReason || man.accountFlags.bannedText) {
          delete man.accountFlags.banned;
          delete man.accountFlags.bannedAt;
          delete man.accountFlags.bannedReason;
          delete man.accountFlags.bannedText;
        }
      }
      if (which.includes('messengerPin')) {
        if (man.accountFlags.messengerPin || man.accountFlags.messengerPinReason || man.accountFlags.messengerPinSource || man.accountFlags.messengerPinAt) {
          delete man.accountFlags.messengerPin;
          delete man.accountFlags.messengerPinReason;
          delete man.accountFlags.messengerPinSource;
          delete man.accountFlags.messengerPinAt;
        }
      }
      if (Object.keys(man.accountFlags).length === 0) delete man.accountFlags;
      return man;
    });
    if (which.includes('loginRequired') && (prev && prev.loginRequired)) {
      await issues.append(nome, 'login_required_cleared', `at=${new Date().toISOString()}`);
    }
    if (which.includes('banned') && (prev && prev.banned)) {
      await issues.append(nome, 'account_banned_cleared', `at=${new Date().toISOString()}`);
    }
    if (which.includes('messengerPin') && (prev && prev.messengerPin)) {
      await issues.append(nome, 'mil_action', `messenger_pin_cleared at=${new Date().toISOString()}`);
    }
    robeMeta[nome] = robeMeta[nome] || {};
    if (which.includes('loginRequired')) {
      delete robeMeta[nome].loginRequired;
      delete robeMeta[nome].loginReason;
      delete robeMeta[nome].loginSource;
    }
    if (which.includes('loginRemediateFailed')) {
      delete robeMeta[nome].loginRemediateFailed;
      delete robeMeta[nome].loginRemediateFailedReason;
      // Durante failFast, whyNotOpen pode ser um motivo específico (two_factor, ui_blocked:..., etc).
      // Ao "Retomar trabalho", sempre limpa.
      if (typeof robeMeta[nome].whyNotOpen === 'string') delete robeMeta[nome].whyNotOpen;
    }
    if (which.includes('banned')) delete robeMeta[nome].banned;
    if (which.includes('messengerPin')) {
      delete robeMeta[nome].messengerPin;
      if (robeMeta[nome].whyNotOpen === 'messenger_pin_modal') delete robeMeta[nome].whyNotOpen;
    }
    await snapshotStatusAndWrite();
  } catch {}
}

const SHARD_PROFILES = (() => { try { return JSON.parse(process.env.SHARD_PROFILES || '[]'); } catch { return []; }})();
let SHARD_SET = new Set(Array.isArray(SHARD_PROFILES) ? SHARD_PROFILES : []);
const STATUS_FILE_NAME = process.env.STATUS_FILE_NAME || 'status.json';

function inShard(nome) { return SHARD_SET.size === 0 ? true : SHARD_SET.has(nome); }

async function isLimitPostingActive(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil || 0) > Date.now());
  } catch { return false; }
}

function isLimitPostingRes(res) {
  return !!(res && (res.limitPosting === true || res.error === 'limit_posting' || res.HALT === true));
}

async function detectFbLimitInAnyPage(ctrl) {
  try {
    if (!ctrl || !ctrl.browser || typeof ctrl.browser.pages !== 'function') return false;
    const pages = await ctrl.browser.pages();
    for (const p of pages) {
      try {
        const url = p.url ? p.url() : '';
        if (/facebook\.com\/marketplace\/(create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(url)) {
          const deep = await detectLimitOverlayDeep(p, { alsoCheckFrames: true });
          if (deep && deep.blocked) return true;
          const det = await require('./browser.js').detectMessengerTempBlock(p);
          if (det && det.blocked && det.domain === 'facebook') return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// REMOVIDO: pidusage e ps-list usam WMI/PowerShell internamente no Windows
// Placeholders explícitos para garantir que nunca haverá uso em runtime
const pidusage = null;
const psList = null;

const { execFile } = require('child_process');

const supervisorClient = require('./supervisorClient.js');
const provisionLock = require('./provisionLock.js');
const { getAvailableMB } = utils;

const HEALTH_CFG = {
  TICK_MS: 10000,
  DEAD_NO_EVENT_MS: 45000,
  DEAD_NO_DOM_MS: 45000,
  DEAD_NO_NET_MS: 60000,
  RECOVERY_COOLDOWN_MS: {
    reload: 30000,
    navHome: 45000,
    newPage: 60000
  },
  SUCCESS_RESET_MS: 20000,
  MAX_SOFT_RELOADS_10MIN: 2,
  MAX_NAVHOME_10MIN: 2,
  MAX_NEWPAGE_30MIN: 2,
  ESCALATE_TO_REOPEN_AFTER: 2,
  ABOUT_BLANK_GRACE_MS: 7000
};

const PHANTOM_CFG = {
  INITIAL_GRACE_MS: 9000,
  PERSIST_MS: 20000,
  CHECK_INTERVAL_MS: 5000,
  COOLDOWN_BETWEEN_TRIES_MS: 30000,
  MAX_PHTM_RELOADS_10M: 2,
  MAX_PHTM_NAV_10M: 2,
  MAX_PHTM_NEWPAGE_30M: 2,
  ESCALATE_AFTER_STEPS: 2
};
function _prune(arr, ms) {
  const now = Date.now();
  return (arr||[]).filter(ts => (now - ts) < ms);
}
function getPhantomState(nome) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].phantom = robeMeta[nome].phantom || {
    firstSeenAt: 0,
    lastOkAt: 0,
    lastActionAt: 0,
    actions10m: [],
    navs10m: [],
    reloads10m: [],
    newpages30m: [],
    failures: 0
  };
  return robeMeta[nome].phantom;
}
async function evaluateChatsState(page) {
  try {
    const res = await page.evaluate(() => {
      const norm = (s) => (s||'').toLowerCase();
      let grid = Array.from(document.querySelectorAll('div[role="grid"]'))
      .find(g => {
        const al = (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby') || '');
        const t = norm(al);
        return t.includes('conversas') || t.includes('conversations');
      });
      if (!grid) {
        const pagelet = document.querySelector('div[data-pagelet="MWThreadList"]');
        if (pagelet) {
          const g2 = pagelet.querySelector('div[role="grid"]');
          if (g2) grid = g2;
        }
      }
      let rows = 0, anchors = 0, skeletons = 0;
      if (grid) {
        rows = grid.querySelectorAll('div[role="row"]').length;
        anchors = grid.querySelectorAll('a[href^="/marketplace/t/"]').length;
        skeletons = grid.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      } else {
        skeletons = document.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      }
      return { hasGrid: !!grid, rows, anchors, skeletons };
    });
    return res || { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  } catch {
    return { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  }
}
function isPhantomFromSnapshot(snap) {
  const noThreads = (snap.rows === 0 && snap.anchors === 0);
  if (noThreads && snap.skeletons > 0) return true;
  return false;
}
function isOkFromSnapshot(snap) {
  return (snap.rows > 0 || snap.anchors > 0);
}
async function tryFixPhantom(nome, page) {
  const ctrlGuard = controllers.get(nome);
  if (ctrlGuard && (ctrlGuard.humanControl === true || ctrlGuard.configurando === true)) return false;
  const ph = getPhantomState(nome);
  const now = Date.now();
  ph.actions10m = _prune(ph.actions10m, 10601000);
  ph.navs10m = _prune(ph.navs10m, 10601000);
  ph.reloads10m = _prune(ph.reloads10m, 10601000);
  ph.newpages30m = _prune(ph.newpages30m, 30601000);

  if ((now - ph.lastActionAt) < PHANTOM_CFG.COOLDOWN_BETWEEN_TRIES_MS) return false;

  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || ctrl.configurando) return false;
  if (robeMeta[nome] && robeMeta[nome].emExecucao) return false;

  if (ph.navs10m.length < PHANTOM_CFG.MAX_PHTM_NAV_10M) {
    try {
      await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
      ph.navs10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:navHome');
      return true;
    } catch {}
  }
  if (ph.reloads10m.length < PHANTOM_CFG.MAX_PHTM_RELOADS_10M) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      ph.reloads10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:reload');
      return true;
    } catch {}
  }
  if (ph.newpages30m.length < PHANTOM_CFG.MAX_PHTM_NEWPAGE_30M) {
    try {
      const ctrl2 = controllers.get(nome);
      const np = await ctrl2.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        await browserHelper.patchPage(nome, np, utils.getCoords(man && man.cidade || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl2.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl2.mainPage = np;
      await wirePageObservers(nome, np);
      ph.newpages30m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:newPage');
      return true;
    } catch {}
  }
  ph.failures = (ph.failures || 0) + 1;
  await issues.append(nome, 'mil_action', `phantom_escalate:reopen failures=${ph.failures}`);
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return true;
  }
  await handlers.deactivate({ nome, reason: 'phantom_reopen', policy: 'preserveDesired' });
  setKillGuard(nome);
  ph.lastActionAt = now;
  return true;
}

const healthState = new Map();
function getHealth(nome) {
  const now = Date.now();
  if (!healthState.has(nome)) {
    healthState.set(nome, {
      lastOkAt: 0, lastDomEventAt: 0, lastNetEventAt: 0, lastConsoleErrorAt: 0,
      lastUrl: '', lastTitle: '', stage: 'ok', nextTryAt: 0,
      counters: { softReloads10m: [], navHomes10m: [], newPages30m: [], cyclesWithoutLife: 0 },
      newPageInFlight: false,
      lastNewPageAt: 0
    });
  }
  return healthState.get(nome);
}
function _pruneWindow(arr, ms) {
  const now = Date.now();
  return arr.filter(ts => (now - ts) < ms);
}

const AUTO_CFG = {
  MEM_ENTER_MB: 2048,
  MEM_EXIT_MB: 3072,
  CPU_ENTER: 85,
  CPU_EXIT: 70,
  EMA_ALPHA_CPU: 0.30,
  EMA_ALPHA_MEM: 0.20,
  HOT_TICKS: 3,
  COOL_TICKS: 3,
  MIN_HOLD_MS: 45000,
  ROBE_LIGHT_MIN_SPACING_MS: 60000,
  RAM_KILL_MB: 1600,
  RAM_WARN_MB: 700
};

const ramPolicy = require('./ramPolicy.js');

// RAM mínima dinâmica (ultra enterprise):
// - Operação normal: 2GB + 1GB por node (nós = ceil(totalGB/16))
// - Durante provision (somente dono do lock): 2GB + pico cookies (~1.5GB)
function getOpenMinFreeMB(operator = '') {
  const staticOverride = parseInt(process.env.OPEN_MIN_FREE_MB || '0', 10);
  if (Number.isFinite(staticOverride) && staticOverride > 0) return staticOverride;

  const snap = ramPolicy.snapshotPolicy();
  const op = String(operator || '').trim();
  try {
    const lk = provisionLock.get();
    if (lk && lk.active && provisionLock.ownerMatchesOperator(lk.lock, op)) {
      return snap.reserveProvisionMB;
    }
  } catch {}
  return snap.reserveNormalMB;
}
const BROWSER_CLOSE_TIMEOUT_MS = parseInt(process.env.BROWSER_CLOSE_TIMEOUT_MS || '15000', 10);
const HEADROOM_AFTER_OPEN_MB = parseInt(process.env.HEADROOM_AFTER_OPEN_MB || '0', 10);
const TARGET_ALIVE = parseInt(process.env.TARGET_ALIVE || '0', 10);

// Sinal de saturação SEM WMI: event-loop lag (ms)
// - Quando o loop trava, o sistema “se perde” (timers atrasam, navegação falha, about:blank se acumula).
// - Este é o gatilho enterprise para backpressure antes de quebrar.
const LOOPLAG_ENTER_MS = parseInt(process.env.CT_LOOPLAG_ENTER_MS || '250', 10);
const LOOPLAG_EXIT_MS  = parseInt(process.env.CT_LOOPLAG_EXIT_MS  || '120', 10);
const LOOPLAG_MAX_ENTER_MS = parseInt(process.env.CT_LOOPLAG_MAX_ENTER_MS || '1500', 10);
const LOOPLAG_MAX_EXIT_MS  = parseInt(process.env.CT_LOOPLAG_MAX_EXIT_MS  || '600', 10);
const GOVERNOR_TICK_MS = parseInt(process.env.CT_GOVERNOR_TICK_MS || '2000', 10);

const autoMode = {
  mode: 'full', since: Date.now(), reason: 'supervisor_controlled',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }

// Event loop delay monitor (ultra leve; sem WMI)
const _loopDelay = monitorEventLoopDelay({ resolution: 20 });
try { _loopDelay.enable(); } catch {}
function readLoopLagMs() {
  try {
    const meanMs = Math.round(Number(_loopDelay.mean || 0) / 1e6);
    const maxMs = Math.round(Number(_loopDelay.max || 0) / 1e6);
    try { _loopDelay.reset(); } catch {}
    return { meanMs, maxMs };
  } catch {
    return { meanMs: 0, maxMs: 0 };
  }
}

async function governorTick() {
  try {
    const now = Date.now();
    if (autoMode.lastEval && (now - autoMode.lastEval) < Math.max(500, GOVERNOR_TICK_MS - 200)) return;
    autoMode.lastEval = now;

    const freeMB = getAvailableMB();
    const lag = readLoopLagMs();
    autoMode.eventLoopLagMs = lag.meanMs;
    autoMode.eventLoopLagMaxMs = lag.maxMs;
    autoMode.freeEmaMB = _ema(autoMode.freeEmaMB, freeMB, AUTO_CFG.EMA_ALPHA_MEM);

    const hotNow =
      (freeMB > 0 && freeMB <= AUTO_CFG.MEM_ENTER_MB) ||
      (lag.meanMs >= LOOPLAG_ENTER_MS) ||
      (lag.maxMs >= LOOPLAG_MAX_ENTER_MS);
    const coolNow =
      (freeMB > 0 && freeMB >= AUTO_CFG.MEM_EXIT_MB) &&
      (lag.meanMs <= LOOPLAG_EXIT_MS) &&
      (lag.maxMs <= LOOPLAG_MAX_EXIT_MS);

    if (hotNow) { autoMode.hot = Math.min(20, (autoMode.hot || 0) + 1); autoMode.cool = 0; }
    else if (coolNow) { autoMode.cool = Math.min(20, (autoMode.cool || 0) + 1); autoMode.hot = 0; }

    if (autoMode.mode === 'full') {
      if (autoMode.hot >= AUTO_CFG.HOT_TICKS && _canSwitch()) {
        autoMode.mode = 'light';
        autoMode.since = now;
        autoMode.reason = (freeMB > 0 && freeMB <= AUTO_CFG.MEM_ENTER_MB) ? 'mem_low' : 'loop_lag';
        try { await milLog('mil_action', `governor_enter_slow reason=${autoMode.reason} freeMB=${freeMB} lagMeanMs=${lag.meanMs} lagMaxMs=${lag.maxMs}`); } catch {}
      }
    } else {
      if (autoMode.cool >= AUTO_CFG.COOL_TICKS && _canSwitch()) {
        autoMode.mode = 'full';
        autoMode.since = now;
        autoMode.reason = 'recovered';
        autoMode.hot = 0;
        autoMode.cool = 0;
        try { await milLog('mil_action', `governor_exit_slow freeMB=${freeMB} lagMeanMs=${lag.meanMs} lagMaxMs=${lag.maxMs}`); } catch {}
      }
    }
  } catch {}
}

let _statusLock = Promise.resolve();

async function milLog(type, msg) {
  try { await reportAction('system', type || 'mil_action', String(msg || '')); } catch {}
}

let opening = {};

async function killPids(pids = []) {
  for (const pid of (pids || [])) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function killProcessTreeByRootPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      // Versão sem WMI: usa taskkill para matar o processo raiz e toda a árvore.
      await new Promise((res) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }, () => res());
      });
    } else {
      return;
    }
  } catch {}
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function hardCloseController(nome, ctrl, { reason = '', allowKillUserDataDir = true } = {}) {
  const t0 = Date.now();
  try {
    provisionAudit.append({
      event: 'worker_hard_close_begin',
      nome: String(nome || ''),
      reason: String(reason || ''),
      freeMB: getAvailableMB(),
      allowKillUserDataDir: !!allowKillUserDataDir
    });
  } catch {}
  let rootPid = (robeMeta[nome] && robeMeta[nome].rootPid) || null;
  try {
    if (!rootPid && ctrl && ctrl.browser && typeof ctrl.browser.process === 'function') {
      const proc = ctrl.browser.process();
      if (proc && proc.pid) rootPid = proc.pid;
    }
  } catch {}
  let userDataDir = null;
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (man && man.userDataDir) userDataDir = String(man.userDataDir);
  } catch {}
  let closeOutcome = { ok: false, timeout: false, err: null };
  const closePromise = (async () => {
    try {
      if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
        await ctrl.browser.close().catch(()=>{});
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e };
    }
  })();
  const raced = await Promise.race([
    closePromise,
    sleep(BROWSER_CLOSE_TIMEOUT_MS).then(() => ({ ok: false, timeout: true }))
  ]);
  closeOutcome = raced || closeOutcome;
  // Se fechou ou não, garantimos hard-kill se necessário
  // Regra:
  // - Se timeout OU pid ainda vivo => taskkill
  // - Se allowKillUserDataDir => também kill por userDataDir (remove órfãos)
  if (rootPid && (!closeOutcome.ok || closeOutcome.timeout || isPidAlive(rootPid))) {
    try { await killProcessTreeByRootPid(rootPid); } catch {}
  }
  if (allowKillUserDataDir && userDataDir) {
    try { browserHelper.killChromeProfileProcesses(userDataDir); } catch {}
  }
  const durMs = Date.now() - t0;
  try {
    await issues.append(
      nome,
      'mil_action',
      `deactivate_hard reason=${reason} closeOk=${!!closeOutcome.ok} timeout=${!!closeOutcome.timeout} durMs=${durMs} rootPid=${rootPid || 0} userDataDir="${userDataDir || ''}"`
    );
  } catch {}
  try {
    provisionAudit.append({
      event: 'worker_hard_close_done',
      nome: String(nome || ''),
      reason: String(reason || ''),
      freeMB: getAvailableMB(),
      durMs,
      rootPid: rootPid || null,
      userDataDir: userDataDir || null
    });
  } catch {}
  return { ok: true, durMs, rootPid: rootPid || null, userDataDir: userDataDir || null };
}

async function killStrayChromes() {
  // Intencionalmente no-op: 110% sem WMI/PowerShell e sem ps-list
  return;
}

try {
  logger.info('[WORKER][BOOT]', {
    pid: process.pid,
    execPath: process.execPath,
    versions: process.versions,
    npm_node_execpath: process.env.npm_node_execpath || '',
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '',
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd()
  });
} catch (e) {
  try { logger.warn('[WORKER][BOOT] log error', { error: e && e.message || e }); } catch {}
}
try {
  logger.info(`[WORKER][BOOT][SHARD] pid=${process.pid} shardSize=${SHARD_SET.size}`);
} catch {}

setImmediate(() => { try { snapshotStatusAndWrite().catch(()=>{}); } catch {} });

const perfisPath = path.join(__dirname, '../dados', 'perfis.json');
const presetsPath = path.join(__dirname, '../dados', 'ua_presets.json');
const perfisDir = path.join(__dirname, '../dados', 'perfis');

const desiredPath = path.join(__dirname, '../dados', 'desired.json');
const statusPath  = path.join(__dirname, '../dados', STATUS_FILE_NAME);

function readJsonFile(file, fallback) {
try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
try {
const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const tmp = file + '.tmp';
const fd = fs.openSync(tmp, 'w');
try {
  fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
try { fs.unlinkSync(file); } catch {}
try { fs.renameSync(tmp, file); }
catch {
fs.copyFileSync(tmp, file);
try { fs.unlinkSync(tmp); } catch {}
}
return true;
} catch {
return false;
}
}
function ensureDesired() {
try {
if (!fs.existsSync(desiredPath)) writeJsonAtomic(desiredPath, { perfis: {} });
} catch {}
}

function manifestPathOf(nome) {
  const perfisArr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  return path.join(perfil.userDataDir, 'manifest.json');
}

async function freezeCooldownIfNotWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (working && !humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if (m.robeCooldownUntil && m.robeCooldownUntil > now) {
        m.robeCooldownRemainingMs = m.robeCooldownUntil - now;
        m.robeCooldownUntil = 0;
      }
      return m;
    });
  } catch {}
}

async function unfreezeCooldownIfWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (!working || humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if ((m.robeCooldownUntil || 0) <= now) {
        const remaining = Number(m.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          m.robeCooldownUntil = now + remaining;
          m.robeCooldownRemainingMs = 0;
        }
      }
      return m;
    });
  } catch {}
}

const ERROR_TYPES = new Set(['robe_error', 'robe_no_photo', 'virtus_blocked', 'virtus_no_composer', 'virtus_send_failed']);

function countErrorsLocal(nome) {
  try {
    const file = path.join(perfisDir, nome, 'issues.json');
    const arr = readJsonFile(file, []);
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const it of arr) {
      const t = (it && it.type) ? String(it.type) : '';
      if (ERROR_TYPES.has(t)) n++;
    }
    return n;
  } catch { return 0; }
}

async function ensureManifestValid(nome) {
  function hasEssentials(man) {
    return man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
  }
  let manifest = await manifestStore.read(nome).catch(()=>null);
  if (manifest && hasEssentials(manifest)) return manifest;
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (perfil && hasEssentials(perfil)) {
      const merged = Object.assign({}, perfil, manifest || {});
      if (merged.userDataDir && !fs.existsSync(merged.userDataDir)) {
        fs.mkdirSync(merged.userDataDir, { recursive: true });
      }
      await manifestStore.update(nome, () => merged);
      return merged;
    }
  } catch {}
  return null;
}

async function computeManifestStatus(nome) {
  try {
    const man = await manifestStore.read(nome);
    if (!man) return 'unknown';
    const ok = man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
    return ok ? 'ok' : 'incomplete';
  } catch { return 'unknown'; }
}

async function reportAction(nome, type, message) {
try {
if (!nome) return;
if (!issues || typeof issues.append !== 'function') return;
const msg = String(message == null ? '' : message).slice(0, 400);
await issues.append(nome, type, msg);
} catch {}
}

const controllers = new Map();

const robeMeta = {};

function memorySweep() {
  try {
    const nomesValidos = new Set(loadPerfisJson().map(p => p.nome));
    for (const [n] of healthState) if (!nomesValidos.has(n) && !controllers.has(n)) healthState.delete(n);
    for (const [n] of profileFailures) if (!nomesValidos.has(n) && !controllers.has(n)) profileFailures.delete(n);
    for (const n of Object.keys(robeMeta)) {
      if (!nomesValidos.has(n) && !controllers.has(n)) delete robeMeta[n];
    }
  } catch {}
}
setInterval(memorySweep, 10 * 60 * 1000);

// Governor (NORMAL/SLOW) — roda sempre, ultra leve (sem WMI)
setInterval(() => { governorTick().catch(()=>{}); }, GOVERNOR_TICK_MS);

function killGuardActive(nome) {
  return robeMeta[nome]?.killGuardUntil && robeMeta[nome].killGuardUntil > Date.now();
}
function setKillGuard(nome, ms=90000) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].killGuardUntil = Date.now() + ms;
}

try {
  const perfisArr = loadPerfisJson();
  for (const p of perfisArr) {
    if (p && p.nome && p.userDataDir) {
      const manifestPath = path.join(p.userDataDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (man.frozenUntil && man.frozenUntil > Date.now()) {
          robeMeta[p.nome] = robeMeta[p.nome] || {};
          robeMeta[p.nome].frozenUntil = man.frozenUntil;
          if (man.frozenReason) robeMeta[p.nome].frozenReason = man.frozenReason;
          if (man.frozenAt) robeMeta[p.nome].frozenAt = man.frozenAt;
          if (man.frozenSetBy) robeMeta[p.nome].frozenSetBy = man.frozenSetBy;
        }
      }
    }
  }
} catch (err) {
  try { logger.warn('[BOOT] Erro ao repopular frozenUntil dos manifests', { error: err && err.message || err }); } catch {}
}

const _issuesAppendOrig = issues && issues.append ? issues.append.bind(issues) : null;
if (_issuesAppendOrig) {
  issues.append = async function(nome, type, msg) {
    try {
      const now = Date.now();
      let url = '', readyState = '', pagesCount = 0;
      let deltaDom = '', deltaNet = '';
      let healthStage = '';
      let killGuardUntil = robeMeta[nome]?.killGuardUntil || 0;
      let recoveryHysteresisUntil = robeMeta[nome]?.recoveryHysteresisUntil || 0;
      let blockHysteresisUntil = robeMeta[nome]?.blockHysteresisUntil || 0;
      let strikes = 0;

      const ctrl = controllers.get(nome);
      let page = null;
      if (ctrl && ctrl.browser) {
        try {
          const pages = await ctrl.browser.pages().catch(()=>[]);
          pagesCount = Array.isArray(pages) ? pages.length : 0;
          if (pages && pages[0]) page = pages[0];
        } catch {}
      }
      if (page) {
        try { url = typeof page.url === 'function' ? (page.url() || '') : ''; } catch {}
        try {
          readyState = await Promise.race([
            (async () => await page.evaluate(() => document.readyState).catch(()=>''))(),
            new Promise(res => setTimeout(()=>res(''), 300))
          ]);
        } catch {}
      }
      const st = getHealth && getHealth(nome);
      if (st) {
        healthStage = st.stage || '';
        if (st.lastDomEventAt) deltaDom = String(now - st.lastDomEventAt);
        if (st.lastNetEventAt) deltaNet = String(now - st.lastNetEventAt);
      }
      const rm = robeMeta[nome] || {};
      strikes = rm.noPagesStrikes || rm.zombieStrikes || (Array.isArray(rm.blockDetectWindow) ? rm.blockDetectWindow.length : 0) || 0;

      const extra = ` url=${url||''} readyState=${readyState||''} deltaDom=${deltaDom} deltaNet=${deltaNet} pagesCount=${pagesCount} strikes=${strikes} killGuardUntil=${killGuardUntil||0} recoveryHysteresisUntil=${recoveryHysteresisUntil||0} blockHysteresisUntil=${blockHysteresisUntil||0} healthStage=${healthStage||''}`;
      const newMsg = (msg == null ? '' : String(msg)) + extra;
      return await _issuesAppendOrig(nome, type, newMsg);
    } catch (e) {
      try { return await _issuesAppendOrig(nome, type, msg); } catch {}
    }
  };
}

function isFrozenNow(nome) {
  const now = Date.now();
  const inMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
  let inDisk = 0;
  try {
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (man && typeof man.frozenUntil === 'number') inDisk = man.frozenUntil;
    }
  } catch {}
  const until = Math.max(inMem, inDisk || 0);
  return until > now ? until : 0;
}

const activationLocks = new Map();

async function activateOnce(nome, source = '', operator = '') {
  if (opening[nome]) return { ok: false, error: 'already_opening' };

  if (controllers.has(nome)) {
    return { ok: true, already: true };
  }

  const inflight = activationLocks.get(nome);
  if (inflight) {
    try { await inflight.catch(() => {}); } catch {}
    return controllers.has(nome)
      ? { ok: true, already: true }
      : { ok: false, error: 'activation_in_progress' };
  }

  opening[nome] = true;
  let _supervisorSlotGranted = false;
  let _humanHoldAtStart = false;
  let _humanHoldAllowOpen = false;
  try {
    if (SHARD_SET.size && !inShard(nome)) {
      await reportAction(nome, 'mil_action', 'activate_skip_wrong_shard');
      logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=false size=${SHARD_SET.size}`);
      return { ok: false, error: 'wrong_shard' };
    }
    logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=${inShard(nome)} size=${SHARD_SET.size}`);

    if (killGuardActive(nome)) {
      await reportAction(nome, 'guard_skip_open', 'Abertura negada por kill_guard_until');
      return { ok:false, error:"kill_guard_until" };
    }

    // Hardening: durante stock_provision (maintenance lock), bloquear novas aberturas,
    // EXCETO se o operador for o dono do lock (stock_provision:<batchId>).
    try {
      const op = String(operator || '').trim();
      const lk = provisionLock.shouldBlock(op);
      if (lk && lk.block) {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].activationHeldUntil = Date.now() + 5000;
        await reportAction(nome, 'mil_action', 'activation_hold_by_provision_lock');
        return { ok: false, error: 'maintenance_provision' };
      }
    } catch {}

    try {
      const desired = readJsonFile(desiredPath, { perfis: {} });
      _humanHoldAtStart = !!(desired && desired.perfis && desired.perfis[nome] && desired.perfis[nome].humanHold === true);
      if (_humanHoldAtStart) {
        const op = String(operator || '').trim();
        const isHumanOp = /(^admin|^ui|manual|user|humano|human)/i.test(op);
        // Regra enterprise: humanHold deve bloquear automação, mas NÃO deve impedir o humano de abrir o navegador.
        // Também permite bulk open (abrir tudo) reabrir navegadores em modo humano após restart.
        const isBulkOpen = /(bulk_open_all|open_all_24h|open-all-24h|abrir_tudo|abrir tudo)/i.test(op);
        _humanHoldAllowOpen = !!(isHumanOp || isBulkOpen);
        if (!_humanHoldAllowOpen) {
          await reportAction(nome, 'mil_action', 'activate_skip_human_hold');
          return { ok: false, error: 'human_hold' };
        }
      }
    } catch {}

    const slotResp = await supervisorClient.requestOpen(nome, null, { operator: String(operator || '').trim() })
      .catch(()=>({ok:false, error:'supervisor_unreachable'}));
    if (!slotResp || !slotResp.ok) {
      robeMeta[nome] = robeMeta[nome] || {};
      // NOVO: Reduzido de 30s para 5s (supervisor já controla velocidade via cooldowns)
      robeMeta[nome].activationHeldUntil = Date.now() + 5000;
      await reportAction(nome, 'mil_action', `activation_hold_by_supervisor reason=${(slotResp && slotResp.reason) || 'unknown'}`);
      return { ok:false, error: `supervisor_denied:${(slotResp && slotResp.reason) || 'unknown'}` };
    }
    _supervisorSlotGranted = true;

    if (!nome) {
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'Nome ausente' };
    }

    if (isFrozenNow(nome)) {
      await reportAction(nome, 'mil_action', 'block_activate_frozen');
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'account_is_frozen' };
    }

    const job = (async () => {
      logger.info('[WORKER][activateOnce] start', { nome, source });
      try {
        logger.info('[WORKER][activateOnce] start nome=' + nome + ' source=' + source);
        const manifest = await ensureManifestValid(nome);
        if (!manifest) {
          await freezeProfileFor(nome, 12*60*60*1000, 'manifest_incomplete', 'system');
          await reportAction(nome, 'robe_error', 'manifest incompleto na ativação; perfil congelado 12h');
          if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
          return { ok:false, error: 'manifest_incomplete' };
        }

        {
          const freeMB = getAvailableMB();
          const minFreeMB = getOpenMinFreeMB(operator); // RAM mínima dinâmica (considera provision lock)
          if (freeMB <= minFreeMB) {
            await reportAction(nome, 'mem_block_activate', `RAM livre=${freeMB}MB <= ${minFreeMB}MB (gate, activeNodes=${robeQueue.activeCount()})`);
            throw new Error('ram_insuficiente_para_ativar');
          }
        }

        const browser = await browserHelper.openBrowser(manifest);
        if (!browser || typeof browser.newPage !== 'function') {
          throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
        }
        const proc = browser.process && browser.process();
        if (proc && proc.pid && Number.isFinite(proc.pid)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].rootPid = proc.pid;
          logger.info('[WORKER][activateOnce] rootPid setado', { nome, rootPid: proc.pid });
        } else {
          logger.warn('[WORKER][activateOnce] rootPid NÃO setado', {
            nome,
            hasProcessFn: !!(browser.process),
            proc: !!proc,
            pid: proc?.pid
          });
          setTimeout(async () => {
            try {
              const proc2 = browser.process && browser.process();
              if (proc2 && proc2.pid) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].rootPid = proc2.pid;
                logger.info('[WORKER][activateOnce] rootPid recapturado (delayed)', { nome, rootPid: proc2.pid });
              }
            } catch {}
          }, 2000);
        }
        controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });

        // Enterprise: se está em humanHold e o operador é humano, abre em modo humano (sem automação).
        if (_humanHoldAtStart && _humanHoldAllowOpen) {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            ctrl.humanControl = true;
            ctrl.trabalhando = false;
            try { await stopVirtus(nome); } catch {}
            await reportAction(nome, 'mil_action', 'opened_in_human_mode (humanHold=true)');
            try { await issues.append(nome, 'mil_action', 'opened_in_human_mode_human_hold'); } catch {}
            try { await ensureHumanOverlay(nome, ctrl, { reason: 'opened_in_human_mode_human_hold' }); } catch {}
            // Anti-tela-preta: garanta uma aba navegada para o humano (não depende de retomar trabalho)
            try {
              const pages = await ctrl.browser.pages().catch(()=>[]);
              let p0 = pages && pages[0];
              const u0 = (() => { try { return p0 && typeof p0.url === 'function' ? String(p0.url() || '') : ''; } catch { return ''; } })();
              if (!p0 || !u0 || u0 === 'about:blank') {
                p0 = await ctrl.browser.newPage().catch(()=>null);
                if (p0) {
                  try {
                    const man = await manifestStore.read(nome).catch(()=>null);
                    await browserHelper.patchPage(nome, p0, utils.getCoords(man && man.cidade || '')).catch(()=>{});
                  } catch {}
                }
              }
              if (p0) {
                await p0.bringToFront?.().catch(()=>{});
                await p0.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
                await new Promise(r => setTimeout(r, 1400));
                await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: 'human_mode_entry_on_open', allowGpt: true, maxRounds: 2 }).catch(()=>null);
                ctrl.mainPage = p0;

                // Remover abas about:blank sobrando (economia de RAM / "Abas: 2" indevido)
                try {
                  const ps = await ctrl.browser.pages().catch(()=>[]);
                  for (const pg of (ps || [])) {
                    if (!pg || pg === p0) continue;
                    const uu = (() => { try { return pg.url ? String(pg.url()||'') : ''; } catch { return ''; } })();
                    if (!uu || uu === 'about:blank') {
                      try { await pg.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
                    }
                  }
                } catch {}
              }
            } catch {}
          }
        }

        // Enterprise: se este perfil está marcado como "loginRemediateFailed",
        // abrir já em modo humano (sem automação) ao invés de tentar loops automáticos.
        try {
          const flags = await readAccountFlags(nome).catch(()=>({}));
          if (flags && flags.loginRemediateFailed === true) {
            const ctrl = controllers.get(nome);
            if (ctrl) {
              ctrl.humanControl = true;
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              await reportAction(nome, 'mil_action', 'opened_in_human_mode (loginRemediateFailed=true)');
              try { await issues.append(nome, 'mil_action', 'opened_in_human_mode_login_failed'); } catch {}
              try { await ensureHumanOverlay(nome, ctrl, { reason: 'opened_in_human_mode_login_failed' }); } catch {}
              // Anti-tela-preta: garanta uma aba navegada para o humano (não depende de retomar trabalho)
              try {
                const pages = await ctrl.browser.pages().catch(()=>[]);
                let p0 = pages && pages[0];
                const u0 = (() => { try { return p0 && typeof p0.url === 'function' ? String(p0.url() || '') : ''; } catch { return ''; } })();
                if (!p0 || !u0 || u0 === 'about:blank') {
                  p0 = await ctrl.browser.newPage().catch(()=>null);
                  if (p0) {
                    try {
                      const man = await manifestStore.read(nome).catch(()=>null);
                      await browserHelper.patchPage(nome, p0, utils.getCoords(man && man.cidade || '')).catch(()=>{});
                    } catch {}
                  }
                }
                if (p0) {
                  await p0.bringToFront?.().catch(()=>{});
                  await p0.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
                  await new Promise(r => setTimeout(r, 1400));
                  await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: 'human_mode_entry_on_open', allowGpt: true, maxRounds: 2 }).catch(()=>null);
                  ctrl.mainPage = p0;

                  // Remover abas about:blank sobrando (economia de RAM / "Abas: 2" indevido)
                  try {
                    const ps = await ctrl.browser.pages().catch(()=>[]);
                    for (const pg of (ps || [])) {
                      if (!pg || pg === p0) continue;
                      const uu = (() => { try { return pg.url ? String(pg.url()||'') : ''; } catch { return ''; } })();
                      if (!uu || uu === 'about:blank') {
                        try { await pg.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
                      }
                    }
                  } catch {}
                }
              } catch {}
            }
          }
        } catch {}

        // Enterprise: se está em "Recurso em análise" (appealSubmitted),
        // abrir já em modo humano (sem automação) e manter Virtus OFF.
        try {
          const flags2 = await readAccountFlags(nome).catch(()=>({}));
          if (flags2 && flags2.appealSubmitted === true) {
            const ctrl = controllers.get(nome);
            if (ctrl) {
              ctrl.humanControl = true;
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              try {
                await fileStore.withDesiredFileLockUpdate((d) => {
                  d.perfis = d.perfis || {};
                  d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
                  return d;
                });
              } catch {}
              await reportAction(nome, 'mil_action', 'opened_in_human_mode (appealSubmitted=true)');
              try { await issues.append(nome, 'mil_action', 'opened_in_human_mode_appeal_submitted'); } catch {}
              try { await browserHelper.invocarHumano(ctrl.browser, nome); } catch {}
              try { freezeCooldownIfNotWorking(nome); } catch {}
              try { await ensureHumanOverlay(nome, ctrl, { reason: 'opened_in_human_mode_appeal_submitted' }); } catch {}
              try { await snapshotStatusAndWrite(); } catch {}
            }
          }
        } catch {}

        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].activatedAt = Date.now();
        robeMeta[nome].ramHist = [];
        robeMeta[nome].cpuHistory = [];
        robeMeta[nome].lastWarn = null;

        try { healer.lastProgressAt = Date.now(); } catch {}

        try { attachBrowserLifecycle(nome, browser); } catch {}
        try {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            const pages = await browser.pages().catch(()=>[]);
            if (pages && pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
            maybeStartPruneLoop(nome, ctrl.browser, ctrl.mainPage);
            try {
              browserHelper.installOneTabGuard(ctrl.browser, nome, {
                allow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  return !!(c && (c.configurando === true || c.humanControl === true || rm.emExecucao === true));
                },
                maxPagesWhenAllow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  if (c && c.humanControl === true) return Number.MAX_SAFE_INTEGER;
                  return rm.emExecucao === true ? 3 : 10;
                },
                onNumPages: (n) => {
                  robeMeta[nome] = robeMeta[nome] || {};
                  robeMeta[nome].numPages = n;
                  snapshotStatusAndWrite().catch(()=>{});
                }
              });
            } catch {}
            try {
              browserHelper.installAboutBlankKiller(ctrl.browser, nome, { graceMs: 7000 });
            } catch {}
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].closingReason = null;
        logger.info('[WORKER][activateOnce] done nome=' + nome + ' source=' + source);
        logger.info('[WORKER][activateOnce] concluído', { nome, source });
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'ok'); } catch {} }

        return { ok: true };
      } catch (e) {
        try {
          const st = readJsonFile(statusPath, null) || { perfis: [] };
          let found = false;
          if (Array.isArray(st.perfis)) {
            st.perfis = st.perfis.map(p => {
              if (p && p.nome === nome) { found = true; return { ...p, active: false }; }
              return p;
            });
          }
          if (!found) st.perfis.push({ nome, active: false });
          _statusLock = _statusLock.then(async () => {
            const ok = writeJsonAtomic(statusPath, st);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|activateOnce_fail_status`); } catch {} }
          });
        } catch {}
        try { await reportAction(nome, 'activate_failed', 'Falha ao abrir navegador: ' + (e && e.message)); } catch {}
        if (e && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(String(e && e.message || e))) {
          robeMeta[nome] = robeMeta[nome] || {};
          // NOVO: Reduzido de 15s para 5s (supervisor já controla velocidade)
          robeMeta[nome].activationHeldUntil = Date.now() + 5000;
          try { await reportAction(nome, 'mil_action', 'activation_hold_due_ram 5s (activateOnce)'); } catch {}
        }
        logger.error('[WORKER][activateOnce] fail', { nome, source, err: e && e.message || e }, e);
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
        return { ok: false, error: e && e.message || String(e) };
      } finally {
        activationLocks.delete(nome);
      }
    })();

    activationLocks.set(nome, job);
    return await job;
  } finally {
    delete opening[nome];
  }
}

function sendReply(msgId, data) {
  if (process && process.send) {
    process.send({ replyTo: msgId, data });
  }
}

function loadPerfisJson() {
  try {
    const arr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
    if (!SHARD_SET.size) return arr;
    return arr.filter(p => p && p.nome && inShard(p.nome));
  } catch { return []; }
}
function savePerfisJson(arr) {
  try { fs.writeFileSync(perfisPath, JSON.stringify(arr, null, 2)); } catch {}
}

function pickUaPreset() {
  const presets = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
  const perfis = loadPerfisJson();
  const count = {};
  for (const p of presets) count[p.id] = 0;
  for (const pf of perfis) {
    if (pf.uaPresetId) count[pf.uaPresetId] = (count[pf.uaPresetId] || 0) + 1;
  }
  let min = Math.min(...Object.values(count));
  const candidates = presets.filter(p => count[p.id] === min);
  candidates.sort(() => Math.random() - 0.5);
  return candidates[0];
}

async function normalizeCooldown(nome) {
  try {
    const now = Date.now();
    const ctrl = controllers.get(nome);
    const man = await manifestStore.read(nome).catch(()=>null);
    try {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].pauseReason = man.robePauseReason || null;
    } catch {}
    if (!man) return 0;
    const until = Number(man.robeCooldownUntil || 0);
    const remaining = Number(man.robeCooldownRemainingMs || 0);
    const leftUntil = until > now ? (until - now) : 0;
    const leftRem = remaining > 0 ? remaining : 0;

    if (leftUntil > 0 && leftRem > 0 && Math.abs(leftUntil - leftRem) > 60*1000) {
      const winner = Math.max(leftUntil, leftRem);
      if (ctrl && ctrl.trabalhando && !ctrl.humanControl) {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = now + winner;
          m.robeCooldownRemainingMs = 0;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using until=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      } else {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = 0;
          m.robeCooldownRemainingMs = winner;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using remaining=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      }
    }
    const finalMs = leftUntil > 0 ? leftUntil : leftRem;
    try {
      if (finalMs === 0) {
        await releaseLimitPostingIfExpired(nome);
      }
    } catch {}
    return Math.max(0, Math.floor(finalMs/1000));
  } catch { return 0; }
}

async function releaseLimitPostingIfExpired(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (!man) return false;
    const now = Date.now();
    const hasLimitPosting = (man.robePauseReason === 'limit_posting');
    const stillOn = (Number(man.robeCooldownUntil||0) > now) || (Number(man.robeCooldownRemainingMs||0) > 0);
    if (hasLimitPosting && !stillOn) {
      await manifestStore.update(nome, m => {
        m = m || {};
        if (m.robePauseReason === 'limit_posting') delete m.robePauseReason;
        return m;
      });
      robeMeta[nome] = robeMeta[nome] || {};
      delete robeMeta[nome].pauseReason;
      try { await issues.append(nome, 'mil_action', 'limit_posting_release'); } catch {}
      return true;
    }
  } catch {}
  return false;
}

function robeCooldownLeft(nome) {
  let left = 0;
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const p = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const now = Date.now();
      if (working && !humanControl) {
        const until = Number(p.robeCooldownUntil || 0);
        if (until > now) {
          left = Math.floor((until - now) / 1000);
        }
      } else {
        const remaining = Number(p.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          left = Math.floor(remaining > 0 ? remaining / 1000 : 0);
        } else {
          const until = Number(p.robeCooldownUntil || 0);
          if (until > now) {
            left = Math.floor((until - now) / 1000);
          }
        }
      }
      if (left < 0) left = 0;
    }
  } catch {}
  return left;
}

async function robeLastPosted(nome) {
  let ts = 0;
  try {
    const p = await manifestStore.read(nome).catch(()=>null);
    if (p && p.ultimaPostagemRobe) ts = p.ultimaPostagemRobe;
  } catch {}
  return ts;
}

function robeUpdateMeta(nome, patch) {
  robeMeta[nome] = robeMeta[nome] || {};
  Object.assign(robeMeta[nome], patch || {});
}

function getWorkingProfileNames() {
  const nomes = [];
  controllers.forEach((ctrl, nome) => {
    if (ctrl && ctrl.browser && ctrl.trabalhando) nomes.push(nome);
  });
  return nomes;
}

async function closeExtraPages(browser, mainPage, nome) {
  try {
    const issues = require('./issues.js');
    const pages = await browser.pages();
    let closed = 0;

    const ctrl = controllers.get(nome);
    const sendLockActive = ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active;
    const inRobe = (browser && browser._robeActiveFor === nome) || (nome && robeMeta[nome] && robeMeta[nome].emExecucao === true);
    const inConfig = ctrl && ctrl.configurando === true;
    const inHuman = ctrl && ctrl.humanControl === true;

    if (!(sendLockActive || inRobe || inConfig || inHuman)) {
      for (const p of pages) {
        try {
          if (mainPage && p === mainPage) continue;
          if (!mainPage && pages[0] && p === pages[0]) continue;
          let url = ''; try { url = typeof p.url === 'function' ? url = p.url() : ''; } catch {}
          if (!url || url === 'about:blank') {
            await p.close({ runBeforeUnload: false }).catch(()=>{});
            closed++;
          }
        } catch {}
      }
    }

    if (!(sendLockActive || inRobe || inConfig || inHuman)) {
      const again = await browser.pages();
      for (const p of again) {
        if (mainPage && p === mainPage) continue;
        if (!mainPage && again[0] && p === again[0]) continue;
        let url = ''; try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
        if (/facebook\.com\/marketplace\/create\/item/i.test(url)) continue;
        await p.close({ runBeforeUnload: false }).catch(()=>{});
        closed++;
      }
    }

    if (closed > 0) {
      logger.info('[PRUNER] Fechou abas extras', { nome, closed });
      try { await issues.append(nome, 'mil_action', `pruner_closed_extras n=${closed}`); } catch {}
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
    }
  }
}

const _pruners = new Map();

function maybeStartPruneLoop(nome, browser, mainPage) {
  if (_pruners.has(nome)) return;
  const interval = setInterval(async () => {
    try {
      await closeExtraPages(browser, mainPage, nome);
    } catch (e) {
      if (process.env.PRUNE_DEBUG === '1') {
        logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
      }
    }
  }, 2*60*1000);
  _pruners.set(nome, interval);
}

function stopPruneLoop(nome) {
  if (_pruners.has(nome)) {
    clearInterval(_pruners.get(nome));
    _pruners.delete(nome);
  }
}

let ramMonitorInterval = null;

// ====== ELEIÇÃO DE LÍDER DE MÉTRICAS (UM POR HOST) ======
// Somente o líder executa o monitor pesado de RAM/CPU (WMI/pidusage).
// Demais workers apenas aguardam e consomem os dados via robeMeta/status.json.
const METRICS_LEADER_FILE = path.join(__dirname, '..', 'dados', 'metrics_leader.lock');
const METRICS_LEADER_STALE_MS = 60 * 1000; // 60s
let isMetricsLeaderFlag = false;

function ensureMetricsLeader() {
  try {
    const now = Date.now();

    // Se já somos líder, apenas atualiza o heartbeat no arquivo
    if (isMetricsLeaderFlag) {
      try {
        fs.writeFileSync(
          METRICS_LEADER_FILE,
          JSON.stringify({ pid: process.pid, ts: now }),
          'utf8'
        );
      } catch {}
      return true;
    }

    // Tenta adquirir lock criando o arquivo em modo exclusivo
    try {
      const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      isMetricsLeaderFlag = true;
      return true;
    } catch {
      // Arquivo já existe — verificar se está STALE
      let data = null;
      try {
        const raw = fs.readFileSync(METRICS_LEADER_FILE, 'utf8');
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      const ts = data && typeof data.ts === 'number' ? data.ts : 0;
      if (!ts || (now - ts) > METRICS_LEADER_STALE_MS) {
        // Considera líder anterior como morto/stale — tenta assumir
        try { fs.unlinkSync(METRICS_LEADER_FILE); } catch {}
        try {
          const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
          try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
          } finally {
            fs.closeSync(fd);
          }
          isMetricsLeaderFlag = true;
          return true;
        } catch {
          // Outro processo venceu a corrida — não somos líder
          return false;
          }
      }
      // Arquivo recente: outro worker é o líder
      return false;
        }
      } catch {
    return false;
      }
    }

// Helpers para coleta de memória por PID — sem WMI/PowerShell
async function getWinTasklistMap() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO','CSV','/NH'], { windowsHide: true, maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const lines = stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
        let s = line.trim();
        if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
        const cols = s.split('","'); // simples e robusto p/ tasklist
        if (cols.length < 5) continue;
        const pidStr = cols[1].trim();
        const memStr = cols[4].trim(); // ex.: "123.456 K" (com separador)
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) continue;
        const memKB = parseInt(memStr.replace(/[^\d]/g, ''), 10); // remove pontos/virgulas/K
        if (!Number.isFinite(memKB)) continue;
        const memMB = Math.round(memKB / 1024);
        map[pid] = memMB;
      }
      resolve(map);
    });
  });
}

async function getPosixPsMap() {
  // Linux/macOS: ps -o pid=,rss= (rss em KB)
  // macOS usa 'ps -axo pid=,rss=' e Linux também aceita 'ps -o pid=,rss='
  const args = process.platform === 'darwin'
    ? ['-axo','pid=,rss=']
    : ['-o','pid=,rss=','-A'];
  return new Promise((resolve) => {
    execFile('ps', args, { maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const lines = stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parseInt(parts[0], 10);
        const rssKB = parseInt(parts[1], 10);
        if (!Number.isFinite(pid) || !Number.isFinite(rssKB)) continue;
        const memMB = Math.round(rssKB / 1024);
        map[pid] = memMB;
      }
      resolve(map);
    });
  });
}

// === INÍCIO: PID discovery via CDP/Tracing (sem WMI) ===
const PIDS_CACHE_TTL_MS = parseInt(process.env.RAM_PIDS_CACHE_TTL_MS || '30000', 10); // 30s
const PIDS_TRACE_MS     = parseInt(process.env.RAM_PIDS_TRACE_MS || '240', 10);       // ~240ms
const PIDS_REFRESH_PER_TICK = parseInt(process.env.RAM_PIDS_REFRESH_PER_TICK || '2', 10);

async function readIOStreamChunks(session, stream) {
  const chunks = [];
  while (true) {
    const chunk = await session.send('IO.read', { handle: stream, size: 1 << 20 }).catch(()=>null);
    if (!chunk) break;
    if (chunk.data) chunks.push(chunk.data);
    if (chunk.eof) break;
  }
  try { await session.send('IO.close', { handle: stream }).catch(()=>{}); } catch {}
  return chunks.join('');
}

async function collectChromePidsViaTracing(browser, { sampleMs = PIDS_TRACE_MS } = {}) {
  try {
    if (!browser || !browser.isConnected || (browser.isConnected && browser.isConnected() === false)) return [];
    const target = browser.target();
    if (!target || !target.createCDPSession) return [];
    const session = await target.createCDPSession();
    const pids = new Set();
    const tracingComplete = new Promise((resolve) => {
      const onComplete = async (ev) => {
        try {
          const stream = ev && ev.stream;
          if (!stream) return resolve([]);
          const data = await readIOStreamChunks(session, stream);
          // data é um JSON com traceEvents
          try {
            const obj = JSON.parse(data);
            const arr = Array.isArray(obj && obj.traceEvents) ? obj.traceEvents : [];
            for (const e of arr) {
              if (e && typeof e.pid === 'number') pids.add(e.pid);
            }
          } catch {} 
        } finally {
          resolve(Array.from(pids));
        }
      };
      session.on('Tracing.tracingComplete', onComplete);
    });
    // Start Tracing com memory-infra (rápido e leve)
    await session.send('Tracing.start', {
      categories: 'disabled-by-default-memory-infra',
      transferMode: 'ReturnAsStream',
      options: 'record-as-much-as-possible'
    }).catch(()=>{});
    // Aguarda um pequeno sampling
    await new Promise(r => setTimeout(r, Math.max(120, sampleMs)));
    // Stop
    try { await session.send('Tracing.end').catch(()=>{}); } catch {}
    const res = await tracingComplete;
    try { await session.detach && session.detach().catch(()=>{}); } catch {}
    return Array.isArray(res) ? res : [];
  } catch {
    return [];
  }
}

async function getControllerPidsCached(nome, ctrl, { forceRefresh = false } = {}) {
  try {
    if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) return [];
    robeMeta[nome] = robeMeta[nome] || {};
    const cache = robeMeta[nome]._pidCache || { pids: [], ts: 0 };
    const expired = (Date.now() - cache.ts) > PIDS_CACHE_TTL_MS;
    if (!forceRefresh && !expired && Array.isArray(cache.pids) && cache.pids.length) {
      return cache.pids.slice(0);
    }
    // Força refresh (tranquilo: curto e leve)
    const pids = await collectChromePidsViaTracing(ctrl.browser).catch(()=>[]);
    // Garante incluir o rootPid (fallback)
    const root = robeMeta[nome].rootPid || null;
    const set = new Set(Array.isArray(pids) ? pids : []);
    if (root && Number.isFinite(root)) set.add(root);
    const arr = Array.from(set);
    robeMeta[nome]._pidCache = { pids: arr, ts: Date.now() };
    return arr.slice(0);
  } catch {
    return [];
  }
}
// === FIM: PID discovery via CDP/Tracing (sem WMI) ===

// Pequeno lock para evitar overlap de ticks
let _ramTickBusy = false;

async function ramCpuMonitorTick() {
  if (_ramTickBusy) {
    // agenda próximo tick mesmo se estiver ocupada (anti overlap)
    const WIN_INTERVAL_MS = parseInt(process.env.WIN_RAM_TICK_MS || '10000', 10);
    const NIX_INTERVAL_MS = 8000 + Math.floor(Math.random() * 2000);
    const INTERVAL_MS = (process.platform === 'win32') ? WIN_INTERVAL_MS : NIX_INTERVAL_MS;
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
    return;
  }

  _ramTickBusy = true;
  const WIN_INTERVAL_MS = parseInt(process.env.WIN_RAM_TICK_MS || '12000', 10); // 12s padrão Windows
  const NIX_INTERVAL_MS = 9000 + Math.floor(Math.random() * 2000); // ~9–11s POSIX
  const INTERVAL_MS = (process.platform === 'win32') ? WIN_INTERVAL_MS : NIX_INTERVAL_MS;

  try {
    // Se não há nenhum browser ativo neste worker, não gasta CPU
    if (!controllers || controllers.size === 0) {
      for (const nome of Object.keys(robeMeta)) {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].ramMB = null;
        robeMeta[nome].cpuPercent = null;
      }
      await snapshotStatusAndWrite();
      return;
    }

    // Tira um snapshot do OS (uma chamada só por tick, leve)
    const pidMemMap = process.platform === 'win32'
      ? await getWinTasklistMap()
      : await getPosixPsMap();

    // Refrescamos no máximo N perfis por tick (demais usam cache)
    const entries = Array.from(controllers.entries());
    const refreshBudget = Math.min(PIDS_REFRESH_PER_TICK, entries.length);
    for (let i = 0; i < refreshBudget; i++) {
      const [n, c] = entries[(i + (ramCpuMonitorTick._rr || 0)) % entries.length];
      try { await getControllerPidsCached(n, c, { forceRefresh: true }); } catch {}
    }
    ramCpuMonitorTick._rr = ((ramCpuMonitorTick._rr || 0) + refreshBudget) % Math.max(1, entries.length);

    // Atualiza todos os perfis controlados por este worker
    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
          continue;
        }

        // Captura rootPid se ainda não existir
        robeMeta[nome] = robeMeta[nome] || {};
        if (!robeMeta[nome].rootPid) {
          try {
            const proc = ctrl.browser.process && ctrl.browser.process();
            if (proc && proc.pid) {
              robeMeta[nome].rootPid = proc.pid;
            }
          } catch {}
        }

        // NOVO: soma de root + filhos (pelo CDP Tracing) + tasklist/ps
        // Aplica fator de correção para aproximar Private Working Set (evita duplicação de memória compartilhada)
        const RAM_CORRECTION_FACTOR = parseFloat(process.env.RAM_CORRECTION_FACTOR || '0.435'); // 0.435 = ~43.5% (ajuste fino)
        const pids = await getControllerPidsCached(nome, ctrl, { forceRefresh: false });
        let totalMB = 0;
        if (Array.isArray(pids) && pids.length) {
          for (const pid of pids) {
            const v = pidMemMap[pid];
            if (typeof v === 'number' && v >= 0) totalMB += v;
          }
          // Aplica fator de correção para aproximar Private Working Set (Windows: Working Set inclui memória compartilhada)
          if (process.platform === 'win32' && RAM_CORRECTION_FACTOR > 0 && RAM_CORRECTION_FACTOR <= 1) {
            totalMB = Math.round(totalMB * RAM_CORRECTION_FACTOR);
          }
        } else {
          // fallback duro (só rootPid) se cache vazio
          const root = robeMeta[nome].rootPid || null;
          if (root && Number.isFinite(root) && typeof pidMemMap[root] === 'number') {
            totalMB = pidMemMap[root];
            // Aplica fator de correção também no fallback
            if (process.platform === 'win32' && RAM_CORRECTION_FACTOR > 0 && RAM_CORRECTION_FACTOR <= 1) {
              totalMB = Math.round(totalMB * RAM_CORRECTION_FACTOR);
            }
          } else {
            totalMB = 0;
          }
        }
        robeMeta[nome].ramMB = totalMB || null;
        // CPU por perfil permanece null (sem WMI/PowerShell). O frontend já é null-aware
        robeMeta[nome].cpuPercent = null;

      } catch {
        try {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
        } catch {}
      }
    }

    await snapshotStatusAndWrite();
  } catch (e) {
    try { logger.warn('[RAM-TICK] erro', { error: (e && e.message) || e }); } catch {}
  } finally {
    _ramTickBusy = false;
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
  }
}

function normalizePath(x) { return String(x||'').replace(/\\/g,'/'); }

function extractUserDataDir(cmd) {
  if (!cmd) return null;
  const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(cmd);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// Função para obter Private Working Set no Windows (evita duplicação de memória compartilhada)
// 110% sem WMI/PowerShell — não coleta nada (pidusage e ps-list usam WMI internamente)
async function getPidPrivateWSBytes(pids) {
  // 110% sem WMI/PowerShell — não coleta nada
  return {};
}

setTimeout(ramCpuMonitorTick, 5000);

// ====== Robe dinâmico (itens vs veiculos) ======
async function getRobeModuleFor(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    const mode = (man && man.robeMode) ? String(man.robeMode) : 'itens';
    if (mode === 'veiculos') {
      return require('./robeVeiculos.js');
    }
    return require('./robe.js');
  } catch {
    return require('./robe.js');
  }
}

// Wrapper: startRobeDynamic (substitui hook global robeHelper.startRobe)
async function startRobeDynamic(browser, nome, robePauseMs, workingNow) {
  let manifest = null;
  try { manifest = await manifestStore.read(nome); } catch{}
  if (!manifest) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_unavailable (no freeze)');
    return { ok: false, error: 'manifest_unavailable' };
  }
  if (!manifest.cookies || !manifest.fp) {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_incomplete (no freeze)');
    return { ok: false, error: 'manifest_incomplete' };
  }
  const now = Date.now();
  if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > now) {
    return { ok: false, error: 'ram_backoff' };
  }
  try {
    const mod = await getRobeModuleFor(nome);
    return await mod.startRobe(browser, nome, robePauseMs, workingNow);
  } catch (e) {
    await reportAction(nome, 'robe_error', `Erro técnico no Robe: ${(e&&e.message)||e}. Cooldown padrão (15–30min) será aplicado pelo módulo.`);
    return { ok: false, error: String(e&&e.message||e) };
  }
}

async function robeTickGlobal() {
  // Hardening: durante provisionamento, pausar Robe/automação para evitar concorrência.
  try {
    if (provisionLock.isActive()) {
      try {
        robeTickGlobal._lastProvisionLockLogAt = robeTickGlobal._lastProvisionLockLogAt || 0;
        const now = Date.now();
        const last = Number(robeTickGlobal._lastProvisionLockLogAt || 0) || 0;
        if (!last || (now - last) > 60000) {
          robeTickGlobal._lastProvisionLockLogAt = now;
          await milLog('mil_action', 'robeTickGlobal_skip_due_provision_lock');
        }
      } catch {}
      return;
    }
  } catch {}
  // Virtus-first: em modo lento (CPU/loop lag), o Robe pode pausar para manter atendimento.
  if (autoMode && autoMode.mode && autoMode.mode !== 'full') {
    try {
      autoMode.light = autoMode.light || {};
      autoMode.light.robeSkipped = Number(autoMode.light.robeSkipped || 0) + 1;
      const now = Date.now();
      const lastLog = Number(autoMode.light._lastRobeSkipLogAt || 0) || 0;
      if (!lastLog || (now - lastLog) > 60000) {
        autoMode.light._lastRobeSkipLogAt = now;
        await milLog('mil_action', `robeTickGlobal_skip_due_slowmode mode=${autoMode.mode} reason=${autoMode.reason || ''}`);
      }
    } catch {}
    return;
  }

  const perfisArr = loadPerfisJson();
  const nomesAll = perfisArr.map(p => p.nome);
  const prontosArr = await Promise.all(nomesAll.map(async (nome) => {
    if (isFrozenNow(nome)) return null;
    if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
      return null;
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.trabalhando || ctrl.configurando || ctrl.humanControl) return null;
    // Self-heal: se cooldown foi "congelado" (robeCooldownRemainingMs) enquanto o perfil voltou a trabalhar,
    // garanta a retomada do countdown. Isso elimina o bug de cooldown travado pós-remediação/pausas.
    try { await unfreezeCooldownIfWorking(nome); } catch {}
    const cooldown = await normalizeCooldown(nome);
    const inFila = robeQueue.inQueue(nome);
    const exec = robeQueue.isActive(nome);
    const manGate = await manifestStore.read(nome).catch(()=>null);
    if (manGate && manGate.robePauseReason === 'limit_posting' && (manGate.robeCooldownUntil || 0) > Date.now()) {
      try { await issues.append(nome, 'mil_action', 'skip_robe_enqueue_due_limit_posting_active'); } catch {}
      return null;
    }
    return (cooldown === 0 && (!inFila) && (!exec)) ? nome : null;
  }));
  const prontos = prontosArr.filter(Boolean);

  for (const nome of prontos) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) continue;

    logger.info('[WORKER][robeTickGlobal] Enfileirando', { nome, cooldown: await normalizeCooldown(nome), inQueue: robeQueue.inQueue(nome), isActive: robeQueue.isActive(nome) });

    robeQueue.enqueue(nome, async () => {

      robeUpdateMeta(nome, { emExecucao: true, emFila: false });

      let virtusWasRunning = false;
      const ctrl = controllers.get(nome);
      const workingNow = getWorkingProfileNames();
      if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        robeUpdateMeta(nome, { estado: 'erro' });
        try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (guard)'); } catch {}
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        return;
      }

      try { logger.info('[WORKER][robeTickGlobal] Robe start', { nome }); } catch {}
      try { await reportAction(nome, 'robe_start', 'Iniciando Robe via fila global'); } catch {}

      let mainPage = null;
      try {
        if (ctrl && ctrl.browser && !ctrl.mainPage) {
          try {
            const pages = await ctrl.browser.pages();
            if (pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
          } catch {}
        }
        mainPage = ctrl.mainPage;

        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          virtusWasRunning = true;
          try { await ctrl.virtus.stop(); } catch {}
          ctrl.virtus = null;
        }

        try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

        const robePauseMs = (15 + Math.floor(Math.random() * 16)) * 60 * 1000;

        let res;
        try {
          res = await startRobeDynamic(ctrl.browser, nome, robePauseMs, workingNow);
        } catch (e) {
          if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].limitPostingThisRun = Date.now();
            robeMeta[nome].pauseReason = 'limit_posting';
            robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
            try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robeTickGlobal)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          try { logger.warn('[WORKER][robeTickGlobal] Robe error', { nome, error: e && e.message || e }); } catch {}
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (isLimitPostingRes(res)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].limitPostingThisRun = Date.now();
          robeMeta[nome].pauseReason = 'limit_posting';
          robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
          await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h');
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (res && res.ok) {
          try {
            await manifestStore.update(nome, (m) => {
              m = m || {};
              m.ultimaPostagemRobe = Date.now();
              return m;
            });
          } catch {}
          const last = await robeLastPosted(nome);
          robeUpdateMeta(nome, {
            estado: 'ok',
            cooldownSec: await normalizeCooldown(nome),
            proximaPostagem: last + robePauseMs,
            ultimaPostagem: Date.now()
          });
          try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso'); } catch {}
          try { logger.info('[WORKER][robeTickGlobal] Robe success', { nome }); } catch {}
        } else {
          robeUpdateMeta(nome, {
            estado: 'idle',
            cooldownSec: await normalizeCooldown(nome)
          });
        }
      } catch (e) {
        robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
      } finally {
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
          await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
          delete robeMeta[nome].limitPostingThisRun;
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
          robeUpdateMeta(nome, { emExecucao: false });
          if (virtusWasRunning && automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              ctrl.trabalhando = true;
              await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
            } catch {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          }
          await snapshotStatusAndWrite();
          return;
        }
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

        robeUpdateMeta(nome, { emExecucao: false });

        if (virtusWasRunning) {
          if (automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              ctrl.trabalhando = true;
            } catch (e) {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          } else {
            ctrl.virtus = null;
            ctrl.trabalhando = false;
          }
          await snapshotStatusAndWrite();
        }

        try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado'); } catch {}
        try { logger.info('[WORKER][robeTickGlobal] Robe end', { nome }); } catch {}
      }
    });

    robeUpdateMeta(nome, { emFila: true });
  }

  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!robeQueue.inQueue(n)) delete m.emFila;
    if (!robeQueue.isActive(n)) delete m.emExecucao;
  }
}

setInterval(robeTickGlobal, 7000);
setTimeout(robeTickGlobal, 3500);

async function fotosGcTick() {
  try {
    const res = await fotos.gcSweep();
    if (res && (res.deletedFiles || res.removedIndex || res.resetGens)) {
      logger.info('[FOTOS][GC] resultado', { deletedFiles: res.deletedFiles, removedIndex: res.removedIndex, resetGens: res.resetGens });
    }
  } catch (e) {
    // index_lock_timeout é esperado quando há contenção (muitas operações simultâneas)
    // Não é crítico, apenas indica que o GC será tentado novamente no próximo ciclo
    const msg = (e && e.message) || String(e);
    if (msg.includes('index_lock_timeout')) {
      // Silencioso: timeout de lock é normal em alta contenção
    } else {
      logger.warn('[FOTOS][GC] erro', { error: msg });
    }
  }
}
setInterval(fotosGcTick, 90_000);
setTimeout(fotosGcTick, 8000);

async function stopVirtus(nome) {
const ctrl = controllers.get(nome);
if (!ctrl) return;
try {
if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
await ctrl.virtus.stop().catch(()=>{});
}
} catch {}
ctrl.virtus = null;
ctrl.trabalhando = false;
ctrl.virtusEpoch = (ctrl.virtusEpoch || 0) + 1;
if (ctrl.browser) {
  ctrl.browser._fenceEpochMap = ctrl.browser._fenceEpochMap || {};
  ctrl.browser._fenceEpochMap[nome] = ctrl.virtusEpoch;
}
try { freezeCooldownIfNotWorking(nome); } catch {}
await snapshotStatusAndWrite();
}

// ===== Ultra enterprise: quiescência determinística para operações críticas (inject cookies / provision) =====
function _quiesceSnapshot({ excludeNome } = {}) {
  const snap = {
    controllers: controllers.size,
    busyNames: [],
    busyDetails: [],
    virtusOnlineNames: [],
    pauseableVirtusNames: [],
    pauseableVirtusDetails: []
  };
  for (const [n, c] of controllers.entries()) {
    if (!c) continue;
    const nome = String(n);
    if (excludeNome && nome === String(excludeNome)) continue;
    const sendLockActive = !!(c.browser && c.browser._sendLock && c.browser._sendLock.active);
    const robeEmExecucao = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
    const inConfig = (c.configurando === true);
    const inHuman = (c.humanControl === true);
    const virtusOnline = !!c.virtus;
    if (virtusOnline) snap.virtusOnlineNames.push(nome);
    if (sendLockActive || robeEmExecucao) {
      snap.busyNames.push(nome);
      snap.busyDetails.push({ nome, sendLockActive, robeEmExecucao, inConfig, inHuman, virtusOnline, trabalhando: !!c.trabalhando });
    }
    // "pausável": virtus online e não está ocupado/humano/config
    if (virtusOnline && !sendLockActive && !robeEmExecucao && !inConfig && !inHuman) {
      snap.pauseableVirtusNames.push(nome);
      snap.pauseableVirtusDetails.push({ nome, virtusOnline, trabalhando: !!c.trabalhando });
    }
  }
  return snap;
}

async function waitGlobalQuiesce({ opKind, operator, targetNome, waitBusyMs, waitPauseMs, require = true } = {}) {
  const op = String(operator || '').trim() || null;
  const kind = String(opKind || 'unknown');
  const target = targetNome ? String(targetNome) : null;
  const busyMax = Math.max(0, Number(waitBusyMs || 0) || 0);
  const pauseMax = Math.max(0, Number(waitPauseMs || 0) || 0);
  const startedAt = Date.now();

  const audit = (obj) => {
    try {
      provisionAudit.append({ ts: Date.now(), event: 'quiesce', kind, operator: op, target, ...obj });
    } catch {}
  };

  audit({ phase: 'begin', busyMax, pauseMax, snap: _quiesceSnapshot({ excludeNome: target }) });

  // (1) Espera busy (send/post) finalizar
  if (busyMax > 0) {
    const t0 = Date.now();
    while ((Date.now() - t0) < busyMax) {
      const s = _quiesceSnapshot({ excludeNome: target });
      if (s.busyNames.length === 0) break;
      await sleep(900);
    }
    const s2 = _quiesceSnapshot({ excludeNome: target });
    const okBusy = (s2.busyNames.length === 0);
    audit({ phase: 'busy_done', ok: okBusy, busyNames: s2.busyNames.slice(0, 50), busyDetails: s2.busyDetails.slice(0, 50) });
    if (require && !okBusy) {
      const err = `busy_timeout count=${s2.busyNames.length}`;
      audit({ phase: 'fail', error: err });
      throw new Error(err);
    }
  }

  // (2) Pausa Virtus para todos que são pausáveis
  const paused = [];
  const s3 = _quiesceSnapshot({ excludeNome: target });
  for (const nome of s3.pauseableVirtusNames) {
    try {
      const wasWorking = !!(controllers.get(nome)?.trabalhando);
      await stopVirtus(nome);
      paused.push({ nome, wasWorking });
    } catch {}
  }
  audit({ phase: 'pause_sent', pausedCount: paused.length, pausedNames: paused.map(x => x.nome).slice(0, 50) });

  // (3) Espera nenhum Virtus "pausável" permanecer online
  if (pauseMax > 0) {
    const t1 = Date.now();
    while ((Date.now() - t1) < pauseMax) {
      const s = _quiesceSnapshot({ excludeNome: target });
      if (s.pauseableVirtusNames.length === 0) break;
      await sleep(600);
    }
    const s4 = _quiesceSnapshot({ excludeNome: target });
    const okPause = (s4.pauseableVirtusNames.length === 0);
    audit({ phase: 'pause_done', ok: okPause, pauseableVirtusNames: s4.pauseableVirtusNames.slice(0, 50), virtusOnlineNames: s4.virtusOnlineNames.slice(0, 50) });
    if (require && !okPause) {
      const err = `pause_timeout count=${s4.pauseableVirtusNames.length}`;
      audit({ phase: 'fail', error: err });
      throw new Error(err);
    }
  }

  audit({ phase: 'done', elapsedMs: Date.now() - startedAt, pausedCount: paused.length });
  return { ok: true, elapsedMs: Date.now() - startedAt, paused };
}

function attachBrowserLifecycle(nome, browser) {
browser.once('disconnected', async () => {
try {
logger.info('[WORKER][BROWSER] disconnected', { nome });
try { robeQueue.skip && robeQueue.skip(nome); } catch {}

const ctrl = controllers.get(nome);
if (ctrl) { ctrl.humanControl = false; ctrl.configurando = false; }
try {
  if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
    await ctrl.virtus.stop().catch(()=>{});
  }
} catch {}

try { freezeCooldownIfNotWorking(nome); } catch {}

controllers.delete(nome);

// LIMPA rootPid para evitar consultas em PIDs órfãos (WMI-free+ps-tree)
try {
  if (robeMeta[nome]) {
    robeMeta[nome].rootPid = null;
  }
} catch {}

try { healthState.delete(nome); } catch {}
try { profileFailures.delete(nome); } catch {}
try {
  if (robeMeta[nome]) {
    delete robeMeta[nome].emExecucao;
    delete robeMeta[nome].emFila;
    delete robeMeta[nome].cpuHistory;
    delete robeMeta[nome].ramHist;
    delete robeMeta[nome].reloadAttemptsWindow;
    delete robeMeta[nome].blockDetectWindow;
  }
} catch {}

try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}

stopPruneLoop(nome);

try { registerFailure(nome, 'disconnected', 'external'); } catch {}
try {
  const d = readJsonFile(desiredPath, { perfis: {} });
  const isDesiredActive = d.perfis?.[nome]?.active === true;
  const isHold = d.perfis?.[nome]?.humanHold === true;
  robeMeta[nome] = robeMeta[nome] || {};
  const now = Date.now();

  if (!isFrozenNow(nome) && isDesiredActive && !isHold) {
    if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
      robeMeta[nome].reopenAt = now + ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
      robeMeta[nome].closingReason = 'disconnected';
      issues.append(nome, 'mil_action', 'nurse_reopen_scheduled(disconnected)').catch(()=>{});
      // NOVO: Reduzido de 30s para 5s (reabertura quase imediata, supervisor controla velocidade)
      setKillGuard(nome, 5000);
    } else {
      issues.append(nome, 'mil_action', 'reopen_preserved_existing(disconnected)').catch(()=>{});
    }
  } else {
    robeMeta[nome].reopenAt = null;
    issues.append(nome, 'mil_action', isFrozenNow(nome) ? 
      'reopen_suppressed_frozen' : (isHold ? 'reopen_suppressed_human_hold' : 'reopen_suppressed_desired_off')).catch(()=>{});
  }
} catch {}

try { await snapshotStatusAndWrite(); } catch {}
} catch (e) {
  try { logger.warn('[WORKER][BROWSER] disconnect handler err', { error: e && e.message || e }); } catch {}
}
try {
  browser.removeAllListeners && browser.removeAllListeners('targetcreated');
  browser.removeAllListeners && browser.removeAllListeners('targetchanged');
  browser.removeAllListeners && browser.removeAllListeners('targetdestroyed');
} catch {}
});
}

function resolveChromeUserDataRoot() {
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
    const os = require('os');
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  const os = require('os');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

function automationAllowed(ctrl, { operator } = {}) {
  // Hardening: durante stock_provision, bloquear automação (Robe/Virtus),
  // mas permitir o fluxo do PRÓPRIO provisionamento quando o operador é o dono do lock.
  try {
    const op = String(operator || '').trim();
    const lk = provisionLock.shouldBlock(op);
    if (lk && lk.block) return false;
  } catch {
    try { if (provisionLock.isActive()) return false; } catch {}
  }
  return !!(ctrl && !ctrl.humanControl && !ctrl.configurando && !ctrl.trabalhando);
}

async function start_work({ nome, operator }) {
  return lockProfileAction(nome, async () => {
    logger.info('[HANDLER] start_work chamada', { nome });

    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.())
      return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    if (ctrl.humanControl || ctrl.configurando) {
      await issues.append(nome, 'mil_action', 'start_work_denied (human/config mode)');
      logger.warn('[HANDLER] start_work denied (human/config mode)', { nome });
      return { ok: false, error: 'profile_in_human_or_config' };
    }

    // Guardrail enterprise: se flags persistentes indicam PIL, bloquear automação SEMPRE.
    // Isso garante que "Recurso em análise" (appealSubmitted) e "Conta suspensa" não voltem a ficar Virtus Online após restart/open-all.
    try {
      const flags = await readAccountFlags(nome).catch(()=>({}));
      if (flags && flags.banned === true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'banned', reason: String(flags.bannedReason||flags.reason||'').slice(0,120) }); } catch {}
        try { await setBannedFlag(nome, { reason: String(flags.bannedReason || 'banned'), snippet: String(flags.bannedText || '') }); } catch {}
        return { ok: false, error: 'banned' };
      }
      if (flags && flags.twoFactor === true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'two_factor', reason: String(flags.twoFactorReason||flags.reason||'two_factor').slice(0,120) }); } catch {}
        try { await setTwoFactorFlag(nome, { reason: String(flags.twoFactorReason || 'two_factor'), snippet: String(flags.twoFactorText || '') }); } catch {}
        return { ok: false, error: 'two_factor' };
      }
      if (flags && flags.appealSubmitted === true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'appeal_submitted', nextAt: Number(flags.appealNextCheckAt||0)||0 }); } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
            return d;
          });
        } catch {}
        try {
          ctrl.humanControl = true;
          ctrl.trabalhando = false;
          await stopVirtus(nome).catch(()=>{});
        } catch {}
        try { await ensureHumanOverlay(nome, ctrl, { reason: 'start_work_blocked_appeal_submitted' }); } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        return { ok: false, error: 'appeal_submitted' };
      }
    } catch {}
    if (ctrl.trabalhando && ctrl.virtus) {
      logger.info('[HANDLER] start_work ok (já trabalhando)', { nome });
      return { ok: true };
    }
    if (ctrl._virtusStarting) {
      logger.info('[HANDLER] start_work ok (_virtusStarting)', { nome });
      return { ok: true };
    }

    try {
      ctrl._virtusStarting = true;
      // Hardening: respeitar lock de provisionamento (maintenance_provision),
      // mas permitir o fluxo do dono do lock via operator (stock_provision:<batchId>).
      if (!automationAllowed(ctrl, { operator })) {
        await issues.append(nome, 'mil_action', 'automation_not_allowed');
        logger.warn('[HANDLER] automation_not_allowed em start_work', { nome });
        return { ok: false, error: 'automation_not_allowed' };
      }
      ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);

      // Enterprise: preflight rápido ANTES de iniciar Virtus:
      // - se detectou banned/suspended/disabled -> auto arquivar+deletar (libera slot)
      // - se detectou appeal_submitted -> manter humano + armar monitor (1h)
      try {
        const pages = await ctrl.browser.pages().catch(()=>[]);
        const p0 = pages && pages[0];
        if (p0) {
          const bd = await browserHelper.detectBannedUi(p0).catch(()=>null);
          if (bd && bd.banned) {
            try { await setBannedFlag(nome, { reason: bd.reason || 'suspended_ui', snippet: bd.snippet || '' }); } catch {}
            try { await issues.append(nome, 'mil_action', `start_work_preflight_banned reason=${String(bd.reason||'').slice(0,80)}`); } catch {}
            return { ok: false, error: 'banned' };
          }
          const lr = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
          // 2FA => exclusão automática (não é humano, não é automação)
          if (lr && lr.loginRequired) {
            const rr = String(lr.reason || '').toLowerCase();
            if (rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor')) {
              try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String((lr && lr.title) ? lr.title : '') }); } catch {}
              try { await issues.append(nome, 'mil_action', `start_work_preflight_two_factor reason=${rr}`); } catch {}
              return { ok: false, error: 'two_factor' };
            }
          }
          if (lr && lr.loginRequired && String(lr.reason || '').toLowerCase().includes('appeal')) {
            try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
            ctrl.humanControl = true;
            ctrl.trabalhando = false;
            try { await stopVirtus(nome); } catch {}
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
                return d;
              });
            } catch {}
            try { await ensureHumanOverlay(nome, ctrl, { reason: 'start_work_preflight_appeal_submitted' }); } catch {}
            try { await snapshotStatusAndWrite(); } catch {}
            try { await issues.append(nome, 'mil_action', `start_work_preflight_appeal_submitted reason=${String(lr.reason||'').slice(0,80)}`); } catch {}
            return { ok: false, error: 'appeal_submitted' };
          }
        }
      } catch {}

      // Enterprise: pós-provision (new_account) faz um check rápido do Marketplace
      // em uma segunda aba e fecha logo em seguida. Mantém a aba 0 (Messenger/Virtus) como principal.
      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        const now = Date.now();
        const until = man ? Number(man.robeCooldownUntil || 0) || 0 : 0;
        const isNewAcc = !!(man && String(man.robePauseReason || '').toLowerCase() === 'new_account');
        const longCooldown = (until > (now + (23 * 60 * 60 * 1000))); // ~24h
        if (isNewAcc && longCooldown) {
          // 0) garantir que a aba 0 está em Messenger (Virtus usa essa aba)
          try {
            const pages0 = await ctrl.browser.pages().catch(()=>[]);
            if (pages0 && pages0[0]) {
              await pages0[0].goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
            }
          } catch {}
          // 1) abre aba 1, vai na rota REAL do Robe (Facebook create/item) só para confirmar sessão
          try {
            const p = await ctrl.browser.newPage().catch(()=>null);
            if (p) {
              await p.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
              let u = ''; let t = '';
              try { u = (typeof p.url === 'function') ? (p.url() || '') : ''; } catch {}
              try { t = (typeof p.title === 'function') ? (await p.title().catch(()=>'')) : ''; } catch {}
              await issues.append(nome, 'mil_action', `post_provision_marketplace_check url=${String(u||'').slice(0,180)} title=${String(t||'').slice(0,80)}`);
              try { await p.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
            }
          } catch (e) {
            try { await issues.append(nome, 'mil_action', `post_provision_marketplace_check_failed ${String(e && e.message || e).slice(0,160)}`); } catch {}
          }
        }
      } catch {}

      ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
    // Para o fluxo stock_provision:<batchId>, liberar automação apenas se ele for o dono do lock.
    if (!automationAllowed(ctrl, { operator })) {
      await issues.append(nome, 'mil_action', 'start_work_denied (automation_not_allowed)');
      logger.warn('[HANDLER] start_work denied (automation_not_allowed)', { nome, operator: String(operator || '').trim() });
      return { ok: false, error: 'automation_not_allowed' };
    }

    ctrl.trabalhando = true;
      try {
        await browserHelper.forceCloseExtras(ctrl.browser);
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      if (ctrl.browser && typeof browserHelper.forceCloseExtras === 'function') {
        await browserHelper.forceCloseExtras(ctrl.browser);
      }

      try {
        await unfreezeCooldownIfWorking(nome);
        await normalizeCooldown(nome);
      } catch {}

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] start_work ok', { nome });
      return { ok: true };
    } catch (e) {
      logger.error('[HANDLER] start_work erro', { nome, error: e && e.message }, e);
      return { ok: false, error: e && e.message || String(e) };
    } finally {
      ctrl._virtusStarting = false;
    }
  });
}

const handlers = {
  async ['criar-perfil']({ cidade, cookies }) {
    logger.info('[HANDLER] criar-perfil chamada', { cidadeProvided: !!cidade, cookiesProvided: !!cookies });
    if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };
    if (!fs.existsExists(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

    let nome = utils.slugify(cidade) + '-' + Date.now();
    while (fs.existsSync(path.join(perfisDir, nome))) nome += Math.floor(Math.random() * 100);

    const preset = pickUaPreset();
    if (!preset) return { ok: false, error: 'UA preset esgotado.' };

    const cookiesArr = utils.normalizeCookies(cookies);
    if (!cookiesArr.length || !cookiesArr.find(c => c.name === 'c_user') || !cookiesArr.find(c => c.name === 'xs')) {
      return { ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' };
    }

    const perfilObj = {
      nome,
      cidade,
      uaPresetId: preset.id,
      uaString: preset.uaString,
      uaCh: preset.uaCh,
      fp: {
        viewport: preset.viewport || (preset.fp && preset.fp.viewport) || { width: 1366, height: 768 },
        dpr: preset.dpr || (preset.fp && preset.fp.dpr) || 1,
        hardwareConcurrency: preset.hardwareConcurrency || (preset.fp && preset.fp.hardwareConcurrency) || 4
      },
      cookies: cookiesArr,
      robeCooldownUntil: 0,
      configuredAt: null,
      userDataDir: path.join(resolveChromeUserDataRoot(), 'Conveniente', nome)
    };
    try { fs.mkdirSync(perfilObj.userDataDir, { recursive: true }); } catch {}

    const perfisArr = loadPerfisJson();
    perfisArr.push(perfilObj);
    savePerfisJson(perfisArr);

    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        return Object.assign({}, m, perfilObj);
      });
    } catch {}

    logger.info('[HANDLER] criar-perfil ok', { nome });
    return { ok: true, perfil: perfilObj };
  },

  async activate({ nome, operator }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] activate chamada', { nome });
      const r = await activateOnce(nome, 'message', operator);
      logger.info('[HANDLER] activate resultado', { nome, ok: !!(r && r.ok), error: r && r.error });
      return r;
    });
  },

  async deactivate({ nome, reason, policy }) {
  return lockProfileAction(nome, async () => {
  logger.info('[HANDLER] deactivate chamada', { nome, reason, policy });
  try {
    provisionAudit.append({
      event: 'worker_deactivate_handler_called',
      nome: String(nome || ''),
      reason: String(reason || ''),
      policy: policy == null ? null : String(policy),
      freeMB: getAvailableMB()
    });
  } catch {}
  const preserve = (policy === 'preserveDesired');
  let reopenDelayMs = 0;
  if (preserve) {
    try { registerFailure(nome, reason || 'deactivate_preserve'); } catch {}
    if (reason === 'ramKill' || reason === 'cpuKill') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_RAMCPU_MS + Math.floor(Math.random()*120000);
    } else if (reason === 'virtus_block') {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
    } else {
      reopenDelayMs = ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
    }
  }
  const ctrl = controllers.get(nome);
  if (!ctrl) {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    if (preserve && !isFrozenNow(nome) && !isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      const now = Date.now();
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else if (preserve && isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] deactivate concluído (controller ausente)', { nome });
    return { ok: true };
  }
  // antes de mexer em browser:
  try {
    if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
      await ctrl.virtus.stop();
    }
  } catch {}
  ctrl.virtus = null;
  ctrl.trabalhando = false;
  // HARD CLOSE militar
  try {
    await hardCloseController(nome, ctrl, {
      reason: reason || 'deactivate',
      allowKillUserDataDir: !preserve
    });
  } catch {}
  // cleanup pós-fechamento
  try {
    const root = robeMeta[nome]?.rootPid;
    if (root) robeMeta[nome].rootPid = null;
  } catch {}
  try { freezeCooldownIfNotWorking(nome); } catch {}
  controllers.delete(nome);

  try {
    if (robeMeta[nome]) {
      delete robeMeta[nome].emExecucao;
      delete robeMeta[nome].emFila;
      delete robeMeta[nome].cpuHistory;
      delete robeMeta[nome].ramHist;
      delete robeMeta[nome].reloadAttemptsWindow;
      delete robeMeta[nome].blockDetectWindow;
    }
  } catch {}

  stopPruneLoop(nome);
  if (!preserve) {
    try {
      await fileStore.withDesiredFileLockUpdate((d) => {
        d.perfis = d.perfis || {};
        d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
        return d;
      });
    } catch (e) {
      try { await issues.append('system','persist_failed', `${nome}|deactivate_desired_write`); } catch {}
    }
  } else {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    if (!isHold) {
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else {
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
  }
  await snapshotStatusAndWrite();
  logger.info('[HANDLER] deactivate concluído', { nome, reason, policy });
  return { ok: true };
  });
},

  async configure({ nome, operator } = {}) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] configure chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 10601000;

      const perfisArr = loadPerfisJson();
      const perfil = perfisArr.find(p => p && p.nome === nome);
      if (!perfil || !perfil.userDataDir) return { ok: false, error: 'Perfil não encontrado!' };
      const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return { ok: false, error: 'Manifest não existe para este perfil!' };
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.cookies) || !manifest.cookies.length) {
        try { await issues.append(nome, 'cookie_inject_failed', 'Cookies não encontrados no manifest!'); } catch {}
        return { ok: false, error: 'Cookies não encontrados no manifest!' };
      }
      ctrl.configurando = true;

      const op = String(operator || '').trim();
      const isStockProvision = (op && op.toLowerCase().startsWith('stock_provision'));
      const mustHaveProvisionLock = String(process.env.CONFIGURE_REQUIRE_PROVISION_LOCK || '1').trim() === '1';
      if (mustHaveProvisionLock) {
        try {
          if (!provisionLock.isActive()) {
            // Contrato enterprise: configure deve rodar sob provisionLock para bloquear Robe/nurse e evitar flapping.
            // (A rota API já adquire lock; stock_provision e login_remediate também usam lock global próprio.)
            return { ok: false, error: 'configure_requires_provision_lock' };
          }
        } catch {
          return { ok: false, error: 'configure_requires_provision_lock' };
        }
      }
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'configure_begin',
          nome: String(nome || ''),
          operator: op || null,
          isStockProvision: !!isStockProvision,
          mustHaveProvisionLock: !!mustHaveProvisionLock
        });
      } catch {}
      const pausedGlobal = [];
      const closedForRam = [];
      let enteredHuman = false;
      const targetWasWorking = !!ctrl.trabalhando;
      const desiredBefore = readJsonFile(desiredPath, { perfis: {} });
      const targetDesiredBefore = (desiredBefore && desiredBefore.perfis && desiredBefore.perfis[nome]) ? { ...(desiredBefore.perfis[nome] || {}) } : {};

      const invokeHumanForConfigure = async (reason) => {
        const why = String(reason || 'configure_failed');
        enteredHuman = true;
        try {
          provisionAudit.append({ ts: Date.now(), event: 'configure_human_hold', nome: String(nome || ''), operator: op || null, reason: why });
        } catch {}
        try { await setLoginRequiredFlag(nome, { reason: why, source: 'configure' }); } catch {}
        try { await setLoginRemediateFailedFlag(nome, { reason: why, source: 'configure', stage: 'configure' }); } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            // Regra enterprise: manter browser aberto para inspeção humana
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
            return d;
          });
        } catch {}
        try {
          ctrl.humanControl = true;
          ctrl.trabalhando = false;
          try { await stopVirtus(nome); } catch {}
        } catch {}
      };

      const reasonPriority = (r) => {
        const s = String(r || '').toLowerCase();
        if (s.includes('two_factor') || s.includes('2fa')) return 6;
        if (s.includes('identity')) return 5;
        if (s.includes('captcha')) return 4;
        if (s.includes('checkpoint')) return 3;
        if (s.includes('appeal')) return 2;
        if (s.includes('login_form')) return 1;
        return 0;
      };

      try {
        // Ultra enterprise: antes de injetar cookies, garantir quiescência global (Virtus/Robe pausados)
        // Importante: se pausarmos Virtus de outros perfis, precisamos retomar ao final.
        {
          const require = String(process.env.CONFIGURE_REQUIRE_QUIESCE || '1').trim() === '1';
          const waitBusyMs = Math.max(0, Number(process.env.CONFIGURE_WAIT_BUSY_MS || 120000) || 120000);
          const waitPauseMs = Math.max(0, Number(process.env.CONFIGURE_WAIT_PAUSE_MS || 45000) || 45000);
          try { provisionAudit.append({ ts: Date.now(), event: 'configure_quiesce_begin', nome: String(nome||''), operator: op || null, require, waitBusyMs, waitPauseMs }); } catch {}
          const q = await waitGlobalQuiesce({ opKind: 'configure', operator: op, targetNome: nome, waitBusyMs, waitPauseMs, require });
          for (const it of (q && q.paused) ? q.paused : []) pausedGlobal.push(it);
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'configure_quiesce_done',
              nome: String(nome || ''),
              operator: op || null,
              pausedCount: pausedGlobal.length,
              pausedNames: pausedGlobal.map(x => x && x.nome).filter(Boolean).slice(0, 60)
            });
          } catch {}
        }

        // Headroom (enterprise): se necessário, fecha o mínimo possível (preserveDesired) e o nurse reabre depois.
        try {
          const snapPolicy = ramPolicy.snapshotPolicy();
          const minFreeMB = snapPolicy.reserveProvisionMB;
          const maxHardDeactivations = Math.max(0, Number(process.env.CONFIGURE_MAX_HARD_DEACTIVATIONS || 2) || 2);
          let free = getAvailableMB();
          if (free < minFreeMB) {
            try { provisionAudit.append({ ts: Date.now(), event: 'configure_headroom_check', nome, operator: op, freeMB: free, minFreeMB }); } catch {}
          }
          while (free < minFreeMB && closedForRam.length < maxHardDeactivations) {
            const candidates = [];
            controllers.forEach((c, n) => {
              if (!n || String(n) === String(nome)) return;
              if (!c || !c.browser) return;
              if (c.humanControl === true || c.configurando === true) return;
              if (c.browser._sendLock && c.browser._sendLock.active) return;
              if (robeMeta[n] && robeMeta[n].emExecucao === true) return;
              const ramMB = (robeMeta[n] && typeof robeMeta[n].ramMB === 'number') ? robeMeta[n].ramMB : (typeof c.ramMB === 'number' ? c.ramMB : 0);
              candidates.push({ nome: String(n), trabalhando: !!c.trabalhando, ramMB: Number(ramMB || 0) || 0 });
            });
            candidates.sort((a, b) => {
              if (a.trabalhando !== b.trabalhando) return (a.trabalhando ? 1 : -1) - (b.trabalhando ? 1 : -1);
              return (Number(b.ramMB) || 0) - (Number(a.ramMB) || 0);
            });
            const pick = candidates[0];
            if (!pick || !pick.nome) break;
            try {
              await handlers.deactivate({ nome: pick.nome, reason: 'ramKill', policy: 'preserveDesired' });
              closedForRam.push(pick.nome);
              try { provisionAudit.append({ ts: Date.now(), event: 'configure_headroom_closed', nome: String(nome||''), operator: op || null, closedNome: pick.nome, closedSoFar: closedForRam.length }); } catch {}
            } catch {}
            await sleep(1600);
            free = getAvailableMB();
          }
        } catch {}

        // Sempre pausar Virtus do próprio alvo antes de reinjetar cookies
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_stop_virtus', nome: String(nome||''), operator: op || null }); } catch {}
        try { await stopVirtus(nome); } catch {}

        // Operação de configuração é crítica: mantém Virtus OFF enquanto configura
        try {
          await fileStore.withDesiredFileLockUpdate((desired) => {
            desired.perfis = desired.perfis || {};
            desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
            return desired;
          });
        } catch {}

        try { provisionAudit.append({ ts: Date.now(), event: 'configure_inject_cookies_begin', nome: String(nome||''), operator: op || null }); } catch {}
        await browserHelper.configureProfile(ctrl.browser, nome, manifest.cookies);
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_inject_cookies_done', nome: String(nome||''), operator: op || null }); } catch {}

        // Pós-injeção: validar estado real (login_required / appeal_submitted / etc)
        let best = null;
        let bestPage = null;
        try {
          const pages = await ctrl.browser.pages().catch(()=>[]);
          for (const pg of (pages || []).slice(0, 8)) {
            const det = await browserHelper.detectLoginRequired(pg).catch(()=>null);
            if (det && det.loginRequired) {
              if (!best || reasonPriority(det.reason) > reasonPriority(best.reason)) {
                best = det;
                bestPage = pg;
              }
            }
          }
        } catch {}
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'configure_post_inject_login_check',
            nome: String(nome || ''),
            operator: op || null,
            loginRequired: !!(best && best.loginRequired),
            reason: best ? String(best.reason || '') : '',
            domain: best ? String(best.domain || '') : '',
            url: best ? String(best.url || '').slice(0, 220) : '',
            title: best ? String(best.title || '').slice(0, 180) : ''
          });
        } catch {}

        if (best && best.loginRequired) {
          const rr = String(best.reason || '').toLowerCase();
          if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
            await setAppealSubmittedFlag(nome, { source: best.domain || 'facebook', url: best.url || '', title: best.title || '' });
            try { provisionAudit.append({ ts: Date.now(), event: 'configure_abort_appeal_submitted', nome: String(nome||''), operator: op || null, url: String(best.url || '').slice(0, 220) }); } catch {}
            return { ok: false, error: 'appeal_submitted' };
          }

          // Fallback: tentar login/senha (mesmo padrão do login_remediate)
          let login2 = null, password2 = null;
          try {
            const man = await manifestStore.read(nome).catch(()=>null);
            const login = man && (man.login || man.email || man.user || man.username);
            const password = man && (man.password || man.pass);
            if (login && password) { login2 = String(login).trim(); password2 = String(password); }
          } catch {}
          if (!login2 || !password2) {
            const fb = await fetchCredentialsFromCT({ profileName: nome });
            if (fb && fb.ok) { login2 = fb.login; password2 = fb.password; }
          }
          if (!login2 || !password2) {
            await invokeHumanForConfigure('missing_credentials');
            return { ok: false, error: 'missing_credentials' };
          }

          try {
            if (bestPage) {
              try { provisionAudit.append({ ts: Date.now(), event: 'configure_login_fallback_begin', nome: String(nome||''), operator: op || null }); } catch {}
              await browserHelper.ensureFbUiUnblocked(bestPage, nome, { reasonBase: 'configure_login', allowGpt: true, maxRounds: 2 }).catch(()=>null);
              await browserHelper.tryLoginEmailPass(bestPage, { nome, login: login2, password: password2, allowGpt: true }).catch(()=>null);
              await sleep(900);
            }
          } catch {}

          const after = await (bestPage ? browserHelper.detectLoginRequired(bestPage).catch(()=>({ loginRequired:false })) : ({ loginRequired:false }));
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'configure_login_fallback_done',
              nome: String(nome || ''),
              operator: op || null,
              stillLoginRequired: !!(after && after.loginRequired),
              reason: after ? String(after.reason || '') : '',
              url: after ? String(after.url || '').slice(0, 220) : ''
            });
          } catch {}
          if (after && after.loginRequired) {
            await invokeHumanForConfigure(`still_login_required:${String(after.reason||'login')}`);
            return { ok: false, error: `still_login_required:${String(after.reason||'login')}` };
          }

          // Atualiza cookies frescos (best-effort)
          try {
            const fresh = await browserHelper.collectFreshCookies(bestPage || (await ctrl.browser.pages().then(ps=>ps[0]).catch(()=>null)));
            if (fresh && fresh.ok && Array.isArray(fresh.cookies) && fresh.cookies.length) {
              await manifestStore.update(nome, (m) => {
                m = m || {};
                m.cookies = fresh.cookies;
                m.cookiesUpdatedAt = Date.now();
                return m;
              });
            }
          } catch {}
        }

        // Sucesso: limpa flags e segue.
        try { await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed']); } catch {}
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_success', nome: String(nome||''), operator: op || null, closedForRamCount: closedForRam.length }); } catch {}
        logger.info('[HANDLER] configure ok', { nome, closedForRamCount: closedForRam.length });
        return { ok: true, closedForRam };
      } catch (e) {
        try { await issues.append(nome, 'cookie_inject_failed', e && e.message || e); } catch {}
        logger.error('[HANDLER] configure erro', { nome, error: e && e.message || e }, e);
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_exception', nome: String(nome||''), operator: op || null, error: (e && e.message) ? String(e.message) : String(e) }); } catch {}
        // Se falhou tecnicamente, entra em humano (padrão enterprise) para evitar ficar preso sem ação.
        try { await invokeHumanForConfigure((e && e.message) || String(e)); } catch {}
        return { ok: false, error: e && e.message || 'falha_injetar_cookies' };
      } finally {
        ctrl.configurando = false;
        // Regra enterprise:
        // - configure (falha) => entra em modo humano (para inspeção/resolução)
        // - configure (sucesso) => NÃO força modo humano; restaura estado desejado e retoma automação
        // - stock_provision ainda controla "start_work" no pipeline (dashboard.js)
        ctrl.humanControl = enteredHuman ? true : false;
        stopPruneLoop(nome);
        // Retoma Virtus dos perfis que estavam trabalhando e foram pausados para quiescência.
        try {
          const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
          const resumed = [];
          for (const it of pausedGlobal) {
            try {
              if (!it || !it.nome) continue;
              const n = String(it.nome);
              if (n === String(nome)) continue;
              const want = desiredSnap && desiredSnap.perfis ? (desiredSnap.perfis[n] || {}) : {};
              if (!(it.wasWorking === true)) continue;
              if (want && want.virtus === 'off') continue; // respeita desired
              const c = controllers.get(n);
              if (!c || !c.browser || !c.browser.isConnected?.()) continue;
              if (!automationAllowed(c)) continue;
              c.virtusEpoch = (c.virtusEpoch || 0);
              c.virtus = virtusHelper.startVirtus(c.browser, n, { restrictTab: 0, epoch: c.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              c.trabalhando = true;
              try { unfreezeCooldownIfWorking(n); } catch {}
              resumed.push(n);
            } catch {}
          }
          try { provisionAudit.append({ ts: Date.now(), event: 'configure_quiesce_resumed', nome: String(nome||''), operator: op, resumedCount: resumed.length, resumed: resumed.slice(0, 40) }); } catch {}
        } catch {}

        // Restaura desired do alvo (manual) e retoma Virtus do alvo (best-effort) se estava trabalhando.
        try {
          if (!enteredHuman && !isStockProvision) {
            await fileStore.withDesiredFileLockUpdate((d) => {
              d.perfis = d.perfis || {};
              const cur = d.perfis[nome] || {};
              // Mantém active como está (evita desligar por engano), mas restaura virtus ao que era antes.
              const wantVirtus = (targetDesiredBefore && typeof targetDesiredBefore.virtus === 'string') ? targetDesiredBefore.virtus : cur.virtus;
              d.perfis[nome] = { ...cur, virtus: wantVirtus };
              return d;
            });
          }
        } catch {}
        try {
          if (!enteredHuman && !isStockProvision && targetWasWorking) {
            const d2 = readJsonFile(desiredPath, { perfis: {} });
            const want = d2 && d2.perfis ? (d2.perfis[nome] || {}) : {};
            if (want && want.virtus !== 'off' && ctrl && ctrl.browser && ctrl.browser.isConnected?.() && automationAllowed(ctrl)) {
              ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              ctrl.trabalhando = true;
              try { unfreezeCooldownIfWorking(nome); } catch {}
            }
          }
        } catch {}
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'configure_finalize',
            nome: String(nome || ''),
            operator: op || null,
            enteredHuman: !!enteredHuman,
            closedForRamCount: closedForRam.length,
            closedForRam: closedForRam.slice(0, 60)
          });
        } catch {}
        await snapshotStatusAndWrite();
      }
    });
  },

  // ===== NOVO: login_remediate (cookies -> login/senha -> humano) =====
  async login_remediate({ nome, operator, options } = {}) {
    return lockProfileAction(nome, async () => {
      const startedAt = Date.now();
      const op = String(operator || '').trim() || `login_remediate:${String(nome || '').trim()}:${startedAt}`;
      const opts = (options && typeof options === 'object') ? options : {};
      const maxHardDeactivations = Math.max(0, Number(opts.maxHardDeactivations || 2) || 2);
      const waitBusyMs = Math.max(0, Number(opts.waitBusyMs || 120000) || 120000);
      const overrideHumanHold = (opts.overrideHumanHold === true || opts.overrideHumanHold === 1 || String(opts.overrideHumanHold || '').toLowerCase() === 'true');
      const totalTimeoutMs = Math.max(60_000, Number(opts.totalTimeoutMs || 0) || (8 * 60 * 1000));
      const stageTimeoutMs = {
        activate: Math.max(20_000, Number(opts.activateTimeoutMs || 0) || 90_000),
        injectCookies: Math.max(30_000, Number(opts.injectCookiesTimeoutMs || 0) || (4 * 60 * 1000)),
        loginFb: Math.max(20_000, Number(opts.loginFbTimeoutMs || 0) || 120_000),
        loginMsg: Math.max(20_000, Number(opts.loginMsgTimeoutMs || 0) || 120_000),
        collectCookies: Math.max(20_000, Number(opts.collectCookiesTimeoutMs || 0) || 90_000)
      };

      const snapPolicy = ramPolicy.snapshotPolicy();
      const minFreeMB = snapPolicy.reserveProvisionMB;

      const deadlineAt = startedAt + totalTimeoutMs;
      const timeLeftMs = () => Math.max(0, deadlineAt - Date.now());
      const withTimeout = async (label, p, ms) => {
        const t = Math.max(1000, Math.min(ms, timeLeftMs()));
        let id;
        const to = new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`timeout:${label}`)), t); });
        try { return await Promise.race([p, to]); }
        finally { try { clearTimeout(id); } catch {} }
      };
      const failFastToHuman = async (reason) => {
        const why = String(reason || 'login_remediate_failed');
        try {
          await setLoginRequiredFlag(nome, { reason: why, source: 'login_remediate' });
        } catch {}
        try {
          await setLoginRemediateFailedFlag(nome, { reason: why, source: 'login_remediate', stage: 'failFast' });
        } catch {}
        // Hard safety: travar automação + deixar evidência visível
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            // Regra enterprise:
            // - manter o navegador ABERTO para inspeção humana (invocar humano real)
            // - automação OFF até o usuário "Retomar trabalho"
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
            return d;
          });
        } catch {}

        // Mantém o browser aberto e entra em modo humano (se estiver conectado)
        try {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            ctrl.humanControl = true;
            ctrl.trabalhando = false;
            try { await stopVirtus(nome); } catch {}
          }
        } catch {}

        // Blindagem UX: se o navegador está “preto”/blank, garante ao menos uma aba navegada/visível para o humano.
        try {
          const ctrl = controllers.get(nome);
          if (ctrl && ctrl.browser && typeof ctrl.browser.pages === 'function' && ctrl.browser.isConnected?.()) {
            const pages = await ctrl.browser.pages().catch(()=>[]);
            const p0 = pages && pages[0];
            const u0 = (() => { try { return p0 && typeof p0.url === 'function' ? String(p0.url() || '') : ''; } catch { return ''; } })();
            const needsNewPage = (!p0 || !u0 || u0 === 'about:blank');
            const ensurePage = async (page) => {
              try { await page.bringToFront?.().catch(()=>{}); } catch {}
              // navega para uma tela “humana” padrão (Messenger Marketplace) para inspeção imediata
              await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
              await new Promise(r => setTimeout(r, 1600));
              await browserHelper.ensureFbUiUnblocked(page, nome, { reasonBase: 'human_mode_entry', allowGpt: true, maxRounds: 2 }).catch(()=>null);
            };
            if (needsNewPage) {
              const np = await ctrl.browser.newPage().catch(()=>null);
              if (np) {
                try {
                  const man = await manifestStore.read(nome).catch(()=>null);
                  await browserHelper.patchPage(nome, np, utils.getCoords(man && man.cidade || '')).catch(()=>{});
                } catch {}
                await ensurePage(np);
                ctrl.mainPage = np;
                try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
              }
            } else {
              await ensurePage(p0);
              ctrl.mainPage = p0;
            }
          }
        } catch {}

        // UX/telemetria: expõe o motivo como whyNotOpen (mesmo com browser aberto, ajuda a UI/diagnóstico)
        try {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].whyNotOpen = why;
        } catch {}

        try { await snapshotStatusAndWrite(); } catch {}
      };

      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'login_remediate_begin',
          nome: String(nome || ''),
          operator: op,
          minFreeMB,
          maxHardDeactivations,
          waitBusyMs,
          totalTimeoutMs,
          stageTimeoutMs,
          overrideHumanHold
        });
      } catch {}

      // 0) lock global (isola e pausa automações)
      const lk = provisionLock.tryAcquire({
        owner: op,
        ttlMs: Math.max(9 * 60 * 1000, waitBusyMs + 7 * 60 * 1000),
        meta: { nome: String(nome || ''), kind: 'login_remediate', startedAt }
      });
      if (!lk || !lk.ok) {
        const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
        return { ok: false, error: `provision_lock_busy${curOwner ? ` owner=${curOwner}` : ''}`, lock: lk && lk.lock ? lk.lock : null };
      }

      const steps = [];
      const pushStep = (s) => {
        try {
          const ev = Object.assign({ ts: Date.now() }, s || {});
          steps.push(ev);
          // Log incremental: mesmo se travar, fica evidência no provision_audit.jsonl
          try {
            provisionAudit.append({ ts: ev.ts, event: 'login_remediate_step', nome: String(nome || ''), operator: op, step: ev.step || null, data: ev });
          } catch {}
        } catch {}
      };
      try {
      // 0.5) se este login_remediate foi explicitamente disparado (operador), pode limpar humanHold para permitir execução.
      if (overrideHumanHold) {
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), humanHold: false };
            return d;
          });
          pushStep({ step: 'human_hold_cleared' });
        } catch (e) {
          pushStep({ step: 'human_hold_clear_failed', error: (e && e.message) || String(e) });
        }
      }

      // 1) garantir browser aberto
      let ctrl = controllers.get(nome);
      const targetWasActive = !!(ctrl && ctrl.browser && ctrl.browser.isConnected?.());
      const targetWasWorking = !!(ctrl && ctrl.trabalhando);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        pushStep({ step: 'activate_needed' });
        const a = await withTimeout('activate', activateOnce(nome, 'message', op), stageTimeoutMs.activate);
        if (!a || a.ok === false) {
          try { provisionLock.release({ owner: op }); } catch {}
          return { ok: false, error: (a && a.error) ? String(a.error) : 'activate_failed', steps };
        }
        ctrl = controllers.get(nome);
      }
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        try { provisionLock.release({ owner: op }); } catch {}
        return { ok: false, error: 'browser_not_connected', steps };
      }

      // 2) Ultra enterprise: quiescência determinística antes de injetar cookies
      // - espera envios/postagens ativos terminarem (busy)
      // - pausa Virtus de todos os perfis "pausáveis"
      // Se não conseguir quiescer dentro do timeout: aborta (sem falso positivo).
      const pausedVirtus = []; // [{ nome, wasWorking }]
      try {
        const require = true;
        const waitPauseMs = Math.max(0, Number(opts.waitPauseMs || 45_000) || 45_000);
        const q = await waitGlobalQuiesce({ opKind: 'login_remediate', operator: op, targetNome: nome, waitBusyMs, waitPauseMs, require });
        for (const it of (q && q.paused) ? q.paused : []) pausedVirtus.push(it);
        pushStep({ step: 'virtus_paused', count: pausedVirtus.length, names: pausedVirtus.map(x => x.nome).slice(0, 30) });
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : String(e);
        pushStep({ step: 'quiesce_failed', error: msg });
        try { provisionLock.release({ owner: op }); } catch {}
        // Fail fast: não injeta cookies se não conseguiu pausar/esperar busy.
        await failFastToHuman(msg);
        return { ok: false, error: `quiesce_failed:${msg}`, steps, pausedVirtus };
      }

      // 3) garantir headroom (fechar o mínimo necessário)
      const closedForRam = [];
      try {
        let free = getAvailableMB();
        pushStep({ step: 'headroom_check', freeMB: free, minFreeMB });
        while (free < minFreeMB && closedForRam.length < maxHardDeactivations) {
          // pick: não-human, não-config, não-robe ativo; preferir não trabalhando, maior RAM
          const candidates = [];
          controllers.forEach((c, n) => {
            if (!n || String(n) === String(nome)) return;
            if (!c || !c.browser) return;
            if (c.humanControl === true || c.configurando === true) return;
            if (c.browser._sendLock && c.browser._sendLock.active) return;
            if (robeMeta[n] && robeMeta[n].emExecucao === true) return;
            const ramMB = (robeMeta[n] && typeof robeMeta[n].ramMB === 'number') ? robeMeta[n].ramMB : (typeof c.ramMB === 'number' ? c.ramMB : 0);
            candidates.push({ nome: String(n), trabalhando: !!c.trabalhando, ramMB: Number(ramMB || 0) || 0 });
          });
          candidates.sort((a, b) => {
            if (a.trabalhando !== b.trabalhando) return (a.trabalhando ? 1 : -1) - (b.trabalhando ? 1 : -1);
            return (Number(b.ramMB) || 0) - (Number(a.ramMB) || 0);
          });
          const pick = candidates[0];
          if (!pick || !pick.nome) break;
          pushStep({ step: 'deactivate_for_ram', pick: pick.nome, freeMB_before: free });
          try {
            await handlers.deactivate({ nome: pick.nome, reason: 'ramKill', policy: 'preserveDesired' });
            closedForRam.push(pick.nome);
          } catch {}
          await new Promise(r => setTimeout(r, 1800));
          free = getAvailableMB();
          pushStep({ step: 'headroom_after_deactivate', freeMB: free, minFreeMB });
        }
      } catch {
        pushStep({ step: 'headroom_recover_failed' });
      }

      // 4) tentativa 1: reinjetar cookies (configureProfile)
      ctrl.configurando = true;
      try {
        const man0 = await manifestStore.read(nome).catch(()=>null);
        const cookies = (man0 && Array.isArray(man0.cookies)) ? man0.cookies : [];
        if (!cookies.length) {
          pushStep({ step: 'missing_cookies_in_manifest' });
          await failFastToHuman('missing_cookies_in_manifest');
          return { ok: false, error: 'missing_cookies_in_manifest', steps };
        }
        // Blindagem: durante configureProfile (abre várias abas), não deixar aboutBlankKiller matar as abas ainda em load.
        try {
          const guard = (ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {});
          guard[nome] = Date.now() + (6 * 60 * 1000);
        } catch {}
        pushStep({ step: 'attempt1_inject_cookies_begin' });
        await withTimeout('injectCookies', browserHelper.configureProfile(ctrl.browser, nome, cookies), stageTimeoutMs.injectCookies);
        pushStep({ step: 'attempt1_inject_cookies_done' });
      } catch (e) {
        pushStep({ step: 'attempt1_inject_cookies_fail', error: (e && e.message) || String(e) });
      } finally {
        ctrl.configurando = false;
        // Não remove suppress imediatamente: popups/redirects podem abrir abas e ficar blank por alguns segundos após configure.
      }

      // 5) validar loginRequired em TODAS as abas reais (sem “puxar” tudo para /marketplace)
      let lrMessenger = null;
      let lrFacebook = null;
      let uiMessenger = null;
      let uiFacebook = null;
      try {
        const pages = await ctrl.browser.pages().catch(()=>[]);
        const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
        const pick = (pred) => {
          for (const pg of (pages || [])) {
            const u = safeUrl(pg);
            if (!u) continue;
            try { if (pred(u, pg)) return pg; } catch {}
          }
          return null;
        };

        // Seleção robusta por URL (evita falso positivo por ordem de abas variar)
        const pMsg = pick((u) => /messenger\.com/i.test(u)); // Messenger (Virtus)
        const pCreate = pick((u) => /facebook\.com\/marketplace\/create\/item/i.test(u)); // Robe create (FB)
        const pFb = pick((u) => /facebook\.com\/marketplace/i.test(u)); // Marketplace (FB) fallback
        const pLang = pick((u) => /facebook\.com\/settings\/language/i.test(u)); // sanity
        const pAny = (pages && pages[0]) || pMsg || pCreate || pFb || null;

        const checkOne = async (page, label) => {
          if (!page) return null;
          // Blindagem: garanta que estamos checando o domínio correto
          try {
            const u0 = safeUrl(page);
            if (label === 'msg' && !/messenger\.com/i.test(u0)) {
              await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
              await new Promise(r => setTimeout(r, 2200));
            }
            if (label.startsWith('fb') && !/facebook\.com/i.test(u0)) {
              // Regra 110% enterprise: para validar Facebook/Marketplace para Robe, a rota REAL é create/item.
              // Evita falso "ok" do feed (/marketplace) e também evita a aba 0 ficar navegando para o lugar errado.
              const targetUrl = 'https://www.facebook.com/marketplace/create/item';
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
              await new Promise(r => setTimeout(r, 2200));
            }
          } catch {}
          await appendLoginRemediateEvidence({ nome, operator: op, step: `pre_check_${label}`, page, note: `before check ${label}` });
          // “olhos”: resolve popups/consent antes de validar login
          const ui = await browserHelper.ensureFbUiUnblocked(page, nome, { reasonBase: `login_remediate_${label}`, allowGpt: true, maxRounds: 3 }).catch(()=>null);
          pushStep({ step: `ui_unblock_${label}`, ui });
          const lr = await browserHelper.detectLoginRequired(page).catch(()=>({ loginRequired:false }));
          if (lr && lr.loginRequired) {
            try { await captureLoginRequiredEvidence(nome, page, lr); } catch {}
          }
          await appendLoginRemediateEvidence({ nome, operator: op, step: `post_check_${label}`, page, note: lr && lr.loginRequired ? 'loginRequired=true' : 'loginRequired=false' });
          return { ui, lr };
        };

        // A ordem importa: primeiro Messenger (Virtus), depois Facebook create/feed.
        // Importante: para declarar sucesso, é obrigatório ter validado Messenger + Facebook.
        const rMsg = await checkOne(pMsg || pAny, 'msg');
        uiMessenger = rMsg && rMsg.ui;
        lrMessenger = rMsg && rMsg.lr;

        const rCreate = await checkOne(pCreate || pFb || pAny, 'fb_create');
        uiFacebook = rCreate && rCreate.ui;
        lrFacebook = rCreate && rCreate.lr;

        // sanity checks (não afetam decisão principal, mas deixam evidência)
        await checkOne(pFb || pAny, 'fb_main');
        await checkOne(pLang, 'fb_lang');
      } catch {}
      pushStep({ step: 'post_inject_login_check', lrMessenger, lrFacebook, uiMessenger, uiFacebook });

      // Blindagem: se não conseguimos validar os 2 lados (Messenger + Facebook), NÃO pode dar sucesso.
      if (!lrMessenger || !lrFacebook) {
        pushStep({ step: 'missing_required_tabs_for_validation', hasMsg: !!lrMessenger, hasFb: !!lrFacebook });
        await failFastToHuman('validation_incomplete_missing_tabs');
        return { ok: false, error: 'validation_incomplete_missing_tabs', steps, closedForRam, pausedVirtus };
      }

      const needsLogin =
        (lrMessenger && lrMessenger.loginRequired) ||
        (lrFacebook && lrFacebook.loginRequired);

      const hardBlockReason = (lr) => {
        const r = String(lr && lr.reason || '').toLowerCase();
        return (r.includes('captcha') || r.includes('checkpoint') || r.includes('identity') || r.includes('two_factor') || r.includes('2fa') || r.includes('two factor'));
      };

      // 5.5) Blindagem enterprise: se a conta estiver desabilitada/banida em qualquer ponto,
      // marca ban e aborta imediatamente (sem "falso positivo" de login/cookies falhou).
      const checkAndAbortIfBanned = async (page, stage) => {
        try {
          const bd = await browserHelper.detectAccountSuspended(page).catch(()=>({ banned:false }));
          if (bd && bd.banned) {
            pushStep({ step: 'banned_detected', stage: String(stage||''), reason: bd.reason || '', snippet: (bd.snippet || '').slice(0, 420) });
            try { await setBannedFlag(nome, { reason: bd.reason || 'banned', snippet: bd.snippet || '' }); } catch {}
            await failFastToHuman(`banned:${bd.reason || 'banned'}`);
            return true;
          }
        } catch {}
        return false;
      };

      // 6) tentativa 2: login+senha (apenas se for login_form; caso contrário invoca humano)
      if (needsLogin) {
        const bad = (hardBlockReason(lrMessenger) || hardBlockReason(lrFacebook));
        if (bad) {
          pushStep({ step: 'non_automatable_login_state', lrMessenger, lrFacebook });
          const why = String((lrMessenger && lrMessenger.reason) || (lrFacebook && lrFacebook.reason) || 'login_requires_human');
          await failFastToHuman(why);
          return { ok: false, error: why, steps, closedForRam, pausedVirtus };
        }

        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const login = man && (man.login || man.email || man.user || man.username);
          const password = man && (man.password || man.pass);
          if (!login || !password) {
            pushStep({ step: 'missing_credentials_in_manifest' });
            // Fallback enterprise: tenta buscar do CT/Estoque (hostId+profileName) e persistir no manifest.
            const fb = await fetchCredentialsFromCT({ profileName: nome });
            pushStep({ step: 'ct_credentials_fetch', ok: !!fb.ok, error: fb && fb.error, stockAccountId: fb && fb.stockAccountId || null });
            if (fb && fb.ok) {
              try {
                await manifestStore.update(nome, (m) => {
                  m = m || {};
                  m.login = String(fb.login);
                  m.password = String(fb.password);
                  m.credentialsUpdatedAt = Date.now();
                  return m;
                });
                pushStep({ step: 'manifest_credentials_updated' });
              } catch {}
              // Recarrega credenciais e segue pro login+senha
            } else {
              await failFastToHuman('missing_credentials');
              return { ok: false, error: 'missing_credentials', steps, closedForRam, pausedVirtus };
            }
          }

          const pages = await ctrl.browser.pages().catch(()=>[]);
          const p0 = pages && pages[0];
          if (!p0) throw new Error('no_page0');

          const man2 = await manifestStore.read(nome).catch(()=>null);
          const login2 = man2 && (man2.login || man2.email || man2.user || man2.username);
          const password2 = man2 && (man2.password || man2.pass);
          if (!login2 || !password2) {
            pushStep({ step: 'missing_credentials_after_ct_fetch' });
            await failFastToHuman('missing_credentials');
            return { ok: false, error: 'missing_credentials', steps, closedForRam, pausedVirtus };
          }

          // Facebook primeiro (tende a refletir no Messenger)
          pushStep({ step: 'attempt2_login_fb_begin' });
          // Regra enterprise: validar/login sempre na rota real do Robe (create/item), não no feed.
          await p0.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
          await new Promise(r => setTimeout(r, 2600));
          await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: 'login_remediate_before_login_fb', allowGpt: true, maxRounds: 2 }).catch(()=>null);
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'before_login_fb', page: p0, note: 'fb before submit' });
          if (await checkAndAbortIfBanned(p0, 'before_login_fb')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };
          const rfb = await withTimeout('loginFb', browserHelper.tryLoginEmailPass(p0, { nome, login: login2, password: password2, allowGpt: true }), stageTimeoutMs.loginFb);
          pushStep({ step: 'attempt2_login_fb_done', result: rfb });
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'after_login_fb', page: p0, note: `fb result ok=${!!(rfb&&rfb.ok)} err=${rfb&&rfb.error||''}` });
          if (await checkAndAbortIfBanned(p0, 'after_login_fb')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };

          // Regra ultra enterprise: se FB cair em 2FA/captcha/checkpoint/identity, não adianta seguir para Messenger.
          try {
            const lrAfterFb = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
            if (lrAfterFb && lrAfterFb.loginRequired && hardBlockReason(lrAfterFb)) {
              pushStep({ step: 'non_automatable_after_login_fb', lr: lrAfterFb });
              await failFastToHuman(String(lrAfterFb.reason || 'login_requires_human'));
              return { ok: false, error: String(lrAfterFb.reason || 'login_requires_human'), steps, closedForRam, pausedVirtus };
            }
          } catch {}

          // Messenger depois (se necessário)
          pushStep({ step: 'attempt2_login_msg_begin' });
          await p0.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
          await new Promise(r => setTimeout(r, 2600));
          await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: 'login_remediate_before_login_msg', allowGpt: true, maxRounds: 2 }).catch(()=>null);
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'before_login_msg', page: p0, note: 'msg before submit' });
          if (await checkAndAbortIfBanned(p0, 'before_login_msg')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };
          const rmsg = await withTimeout('loginMsg', browserHelper.tryLoginEmailPass(p0, { nome, login: login2, password: password2, allowGpt: true }), stageTimeoutMs.loginMsg);
          pushStep({ step: 'attempt2_login_msg_done', result: rmsg });
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'after_login_msg', page: p0, note: `msg result ok=${!!(rmsg&&rmsg.ok)} err=${rmsg&&rmsg.error||''}` });
          if (await checkAndAbortIfBanned(p0, 'after_login_msg')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };

          // Se Messenger cair em estado não automatizável, também fail-fast.
          try {
            const lrAfterMsg = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
            if (lrAfterMsg && lrAfterMsg.loginRequired && hardBlockReason(lrAfterMsg)) {
              pushStep({ step: 'non_automatable_after_login_msg', lr: lrAfterMsg });
              await failFastToHuman(String(lrAfterMsg.reason || 'login_requires_human'));
              return { ok: false, error: String(lrAfterMsg.reason || 'login_requires_human'), steps, closedForRam, pausedVirtus };
            }
          } catch {}

          // revalidar
          await new Promise(r => setTimeout(r, 1400));
          lrMessenger = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));

          // Facebook: validar create/item (Robe real) — sem navegar para o feed.
          const uiRetryUnblock = async (label, rounds = 4) => {
            // Espera extra para evitar "unknown" por race de navegação/contexto
            await new Promise(r => setTimeout(r, 1600));
            let ui = await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: `login_remediate_${label}`, allowGpt: true, maxRounds: rounds }).catch(()=>null);
            if (ui && ui.ok === false && ui.kind === 'unknown') {
              // Retry com reload: muitos "unknown" são contexto destruído durante redirect
              try { await p0.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
              await new Promise(r => setTimeout(r, 1800));
              ui = await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: `login_remediate_${label}_retry`, allowGpt: true, maxRounds: rounds }).catch(()=>null);
            }
            return ui;
          };

          // Create item (Robe real)
          let uiCreate = null;
          let lrCreate = null;
          await p0.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
          uiCreate = await uiRetryUnblock('post_login_create_item', 4);
          if (await checkAndAbortIfBanned(p0, 'post_login_create_item')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };
          lrCreate = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
          pushStep({ step: 'post_login_check_create_item', lrCreate, uiCreate });
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'final_check', page: p0, note: `final lrMsg=${!!(lrMessenger&&lrMessenger.loginRequired)} lrFb=${!!(lrFacebook&&lrFacebook.loginRequired)} lrCreate=${!!(lrCreate&&lrCreate.loginRequired)} uiFbOk=${!!(uiFacebook&&uiFacebook.ok)} uiCreateOk=${!!(uiCreate&&uiCreate.ok)}` });
          if (await checkAndAbortIfBanned(p0, 'final_check')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };

          // Se create item está bloqueado, reflita em uiFacebook para decisão abaixo
          if (uiCreate && uiCreate.ok === false) uiFacebook = uiCreate;
          if (lrCreate && lrCreate.loginRequired) lrFacebook = lrCreate;

        } catch (e) {
          pushStep({ step: 'attempt2_login_fail', error: (e && e.message) || String(e) });
        }
      }

      const uiOk =
        (!uiMessenger || uiMessenger.ok === true) &&
        (!uiFacebook || uiFacebook.ok === true);

      const success =
        !(lrMessenger && lrMessenger.loginRequired) &&
        !(lrFacebook && lrFacebook.loginRequired) &&
        !!uiOk;

      // Hard rule: se cair em captcha/checkpoint/identity, NÃO é sucesso e deve invocar humano.
      const nonAutomatableReason = (lr) => {
        const r = String(lr && lr.reason || '').toLowerCase();
        if (!r) return '';
        if (r.includes('captcha')) return r;
        if (r.includes('checkpoint')) return r;
        if (r.includes('identity')) return r;
        if (r.includes('two_factor') || r.includes('2fa') || r.includes('two factor')) return 'two_factor';
        return '';
      };
      const na = nonAutomatableReason(lrMessenger) || nonAutomatableReason(lrFacebook);
      if (na) {
        pushStep({ step: 'non_automatable_after_login', reason: na, lrMessenger, lrFacebook });
        // 2FA => exclusão automática (não vira humano)
        if (String(na) === 'two_factor') {
          try { await setTwoFactorFlag(nome, { reason: 'two_factor', snippet: '' }); } catch {}
          return { ok: false, error: 'two_factor', steps, closedForRam, pausedVirtus };
        }
        try { await setLoginRequiredFlag(nome, { reason: na, source: 'login_remediate' }); } catch {}
        await failFastToHuman(na);
        return { ok: false, error: na, steps, closedForRam, pausedVirtus };
      }

      // Se não é loginRequired, mas a UI está bloqueada (consent/popup não resolvido), NÃO marque sucesso.
      if (!uiOk) {
        const kind = (uiFacebook && uiFacebook.kind) || (uiMessenger && uiMessenger.kind) || 'ui_blocked';
        pushStep({ step: 'ui_blocked_after_login', kind, uiMessenger, uiFacebook });
        try { await setLoginRequiredFlag(nome, { reason: `ui_blocked:${kind}`, source: 'login_remediate' }); } catch {}
        await failFastToHuman(`ui_blocked:${kind}`);
        return { ok: false, error: `ui_blocked:${kind}`, steps, closedForRam, pausedVirtus };
      }

      if (success) {
        pushStep({ step: 'login_remediate_success' });
        // Atualiza cookies frescos no manifest (pipeline imediato)
        try {
          const fresh = await withTimeout('collectCookies', browserHelper.collectFreshCookies(ctrl.browser), stageTimeoutMs.collectCookies);
          pushStep({ step: 'collect_fresh_cookies', ok: !!fresh.ok, count: fresh && fresh.cookies ? fresh.cookies.length : 0, error: fresh && fresh.error });
          if (fresh && fresh.ok && Array.isArray(fresh.cookies) && fresh.cookies.length) {
            await manifestStore.update(nome, (m) => {
              m = m || {};
              m.cookies = fresh.cookies;
              m.cookiesUpdatedAt = Date.now();
              return m;
            });
            pushStep({ step: 'manifest_cookies_updated' });
          }
        } catch {}
        try { await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed']); } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
      } else {
        pushStep({ step: 'login_remediate_failed', lrMessenger, lrFacebook });
        try { await setLoginRequiredFlag(nome, { reason: (lrMessenger && lrMessenger.reason) || (lrFacebook && lrFacebook.reason) || 'login_required', source: 'login_remediate' }); } catch {}
        await failFastToHuman('login_remediate_failed');
      }

      const out = {
        ok: !!success,
        nome: String(nome || ''),
        success: !!success,
        durationMs: Date.now() - startedAt,
        steps,
        closedForRam,
        pausedVirtus
      };

      // 7) restaurar estado (mínimo impacto):
      // - perfis que estavam trabalhando antes: retomar Virtus
      // - perfil alvo: só retomar se ele estava trabalhando antes E a remediação deu sucesso
      try {
        const resumed = [];
        const tryResume = (n) => {
          try {
            const ctrlR = controllers.get(n);
            if (!ctrlR || !ctrlR.browser || !ctrlR.browser.isConnected?.()) return false;
            if (ctrlR.humanControl === true || ctrlR.configurando === true) return false;
            if (!automationAllowed(ctrlR)) return false;
            ctrlR.virtus = virtusHelper.startVirtus(ctrlR.browser, n, {
              restrictTab: 0,
              epoch: ctrlR.virtusEpoch || 0,
              slowMode: (autoMode && autoMode.mode !== 'full'),
              governorMode: (autoMode && autoMode.mode) || 'full'
            });
            ctrlR.trabalhando = true;
            resumed.push(n);
            return true;
          } catch { return false; }
        };

        for (const it of pausedVirtus) {
          if (!it || !it.nome) continue;
          if (it.wasWorking === true) tryResume(it.nome);
        }
        if (success && targetWasWorking === true) {
          tryResume(String(nome));
        }
        pushStep({ step: 'virtus_resumed', count: resumed.length, names: resumed.slice(0, 30), targetWasActive, targetWasWorking });
        try { await snapshotStatusAndWrite(); } catch {}
      } catch {}

      // 8) Pós-sucesso enterprise:
      // - fechar o navegador do perfil (remove aba create/item, libera RAM)
      // - reabrir perfis fechados por RAM (mínimo impacto, gradual)
      // - reabrir e iniciar trabalho do perfil alvo (se solicitado)
      try {
        const opts2 = (options && typeof options === 'object') ? options : {};
        const closeAfterSuccess = !(opts2.closeAfterSuccess === false || opts2.closeAfterSuccess === 0 || String(opts2.closeAfterSuccess||'').toLowerCase()==='false');
        const startAfterSuccess = !(opts2.startAfterSuccess === false || opts2.startAfterSuccess === 0 || String(opts2.startAfterSuccess||'').toLowerCase()==='false');
        const reopenClosedForRam = !(opts2.reopenClosedForRam === false || opts2.reopenClosedForRam === 0 || String(opts2.reopenClosedForRam||'').toLowerCase()==='false');

        if (success && closeAfterSuccess) {
          pushStep({ step: 'post_success_close_target_begin' });
          // NÃO usar handlers.deactivate aqui (ele reentra em lockProfileAction e pode deadlockar).
          try {
            const ctrlClose = controllers.get(nome);
            if (ctrlClose && ctrlClose.browser && ctrlClose.browser.isConnected?.()) {
              try { if (ctrlClose.virtus && typeof ctrlClose.virtus.stop === 'function') await ctrlClose.virtus.stop(); } catch {}
              ctrlClose.virtus = null;
              ctrlClose.trabalhando = false;
              await withTimeout('post_success_hard_close', hardCloseController(nome, ctrlClose, { reason: 'login_remediate_post_success', allowKillUserDataDir: false }), 60_000).catch(()=>null);
              try { controllers.delete(nome); } catch {}
              try { stopPruneLoop(nome); } catch {}
              try { freezeCooldownIfNotWorking(nome); } catch {}
              try { await snapshotStatusAndWrite(); } catch {}
            }
          } catch {}
          pushStep({ step: 'post_success_close_target_done' });
        }

        if (success && reopenClosedForRam && Array.isArray(closedForRam) && closedForRam.length) {
          // Já foram fechados com policy=preserveDesired; o worker agenda reopenAt.
          // Aqui apenas “dá um empurrão” para reabrir mais cedo de forma gradual, sem reentrar em locks.
          const nudged = [];
          const now = Date.now();
          for (let i = 0; i < closedForRam.length; i++) {
            const n = String(closedForRam[i] || '').trim();
            if (!n) continue;
            try {
              robeMeta[n] = robeMeta[n] || {};
              const when = now + 1500 + (i * 1200);
              if (!robeMeta[n].reopenAt || robeMeta[n].reopenAt > when) robeMeta[n].reopenAt = when;
              nudged.push(n);
            } catch {}
          }
          pushStep({ step: 'reopen_closed_for_ram_nudged', count: nudged.length, names: nudged.slice(0, 30) });
        }

        if (success && startAfterSuccess) {
          // NÃO usar handlers.activate/start_work aqui (reentrância de lockProfileAction).
          // Estratégia enterprise determinística:
          // 1) patch desired (fonte de verdade) -> active=true, virtus=on, humanHold=false
          // 2) fechar browser temporário (já feito acima, se closeAfterSuccess)
          // 3) tentar ativar + iniciar Virtus com retries curtos
          //    - se falhar, NÃO travar/loop infinito: deixa nurse/desired completar.
          try {
            await fileStore.withDesiredFileLockUpdate((d) => {
              d.perfis = d.perfis || {};
              d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'on', humanHold: false };
              return d;
            });
            pushStep({ step: 'post_success_desired_updated', active: true, virtus: 'on' });
          } catch (e) {
            pushStep({ step: 'post_success_desired_update_fail', error: (e && e.message) || String(e) });
          }

          // Nudge: se estiver fechado agora, acelera nurse para reabrir.
          try {
            robeMeta[nome] = robeMeta[nome] || {};
            const when = Date.now() + 900;
            if (!robeMeta[nome].reopenAt || robeMeta[nome].reopenAt > when) robeMeta[nome].reopenAt = when;
          } catch {}

          // Tentativas curtas de ativação; se falhar, nurse/desired completa sem bloquear o fluxo.
          pushStep({ step: 'post_success_activate_once_begin' });
          let actOk = false;
          let lastActErr = null;
          const maxActAttempts = Math.max(1, Math.min(4, Number(opts2.maxPostSuccessActivateAttempts || 3) || 3));
          for (let attempt = 1; attempt <= maxActAttempts; attempt++) {
            pushStep({ step: 'post_success_activate_once_attempt', attempt });
            let act = null;
            try {
              act = await withTimeout('post_success_activate_once', activateOnce(nome, 'login_remediate_post_success', op), Math.min(90_000, stageTimeoutMs.activate || 90_000));
            } catch (e) {
              lastActErr = (e && e.message) || String(e);
              pushStep({ step: 'post_success_activate_once_attempt_fail', attempt, error: lastActErr });
            }
            if (act && act.ok) {
              actOk = true;
              break;
            }
            if (act && act.error) lastActErr = String(act.error);
            await sleep(900 + (attempt * 600));
          }
          pushStep({ step: 'post_success_activate_once_done', ok: actOk, error: lastActErr });

          // Só inicia Virtus se tiver controller+browser (evita "no_browser" enganoso).
          pushStep({ step: 'post_success_start_virtus_begin' });
          try {
            const ctrlNow = controllers.get(nome);
            if (ctrlNow && ctrlNow.browser && ctrlNow.browser.isConnected?.()) {
              if (!automationAllowed(ctrlNow, { operator: op })) {
                pushStep({ step: 'post_success_start_virtus_denied', error: 'automation_not_allowed' });
              } else {
                ctrlNow.virtusEpoch = (ctrlNow.virtusEpoch || 0);
                ctrlNow.virtus = virtusHelper.startVirtus(ctrlNow.browser, nome, {
                  restrictTab: 0,
                  epoch: ctrlNow.virtusEpoch,
                  slowMode: (autoMode && autoMode.mode !== 'full'),
                  governorMode: (autoMode && autoMode.mode) || 'full'
                });
                ctrlNow.trabalhando = true;
                try { await browserHelper.forceCloseExtras(ctrlNow.browser); } catch {}
                try { await snapshotStatusAndWrite(); } catch {}
                pushStep({ step: 'post_success_start_virtus_ok' });
              }
            } else {
              pushStep({ step: 'post_success_deferred_to_nurse', reason: 'no_controller_or_browser' });
            }
          } catch (e) {
            pushStep({ step: 'post_success_start_virtus_fail', error: (e && e.message) || String(e) });
          }
          pushStep({ step: 'post_success_start_virtus_done' });
        }
      } catch {}

      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'login_remediate_done',
          nome: String(nome || ''),
          operator: op,
          ok: !!success,
          durationMs: out.durationMs
        });
      } catch {}

      return out;
      } finally {
        // 7) libera lock global sempre (mesmo com returns/erros)
        try { provisionLock.release({ owner: op }); } catch {}
      }
    });
  },

  start_work,

  async invoke_human({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] invoke_human chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      const robes = robeMeta[nome] || {};
      if (robes.emExecucao) {
        const waitTimeout = 180 * 1000;
        const started = Date.now();
        while ((robeMeta[nome] && robeMeta[nome].emExecucao) && (Date.now() - started < waitTimeout)) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      ctrl.humanControl = true;

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: true };
          return desired;
        });
      } catch {}

      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].reopenAt = null;
        robeMeta[nome].closingReason = null;
      } catch {}

      ctrl.configurando = false;
      stopPruneLoop(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
          return desired;
        });
      } catch {}
      await snapshotStatusAndWrite();

      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 246060*1000;

      try { await stopVirtus(nome); } catch {}

      await browserHelper.invocarHumano(ctrl.browser, nome);

      try { freezeCooldownIfNotWorking(nome); } catch {}
      try { await ensureHumanOverlay(nome, ctrl, { reason: 'invoke_human' }); } catch {}

      await snapshotStatusAndWrite();

      logger.info('[HANDLER] invoke_human ok', { nome });
      return { ok: true };
    });
  },

  async ['human-resume']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] human-resume chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      const flagsBefore = await readAccountFlags(nome).catch(()=>({}));
      const hasAppeal = !!(flagsBefore && flagsBefore.appealSubmitted === true);

      ctrl.humanControl = false;
      // UX enterprise: ao retomar (mesmo que depois volte a humano), ocultar overlay imediatamente e ressincronizar no final.
      try { await syncHumanOverlay(nome); } catch {}
      // Enterprise: "Retomar trabalho" deve limpar TODO estado de falha/hold para voltar ao normal.
      try { await clearAccountFlags(nome, ['loginRequired','banned','loginRemediateFailed','messengerPin']); } catch {}
      try { if (ctrl.browser && ctrl.browser._suppressBlankKillUntil) delete ctrl.browser._suppressBlankKillUntil[nome]; } catch {}

      let pages2 = [];
      try { pages2 = await ctrl.browser.pages(); } catch {}
      if (pages2 && pages2[0]) maybeStartPruneLoop(nome, ctrl.browser, pages2[0]);
      try { await browserHelper.forceCloseExtras(ctrl.browser); } catch {}
      try {
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      let pages;
      try { pages = await ctrl.browser.pages(); } catch {}
      if (pages && pages[0]) {
        try {
          await require('./browser.js').ensureMinimizedWindowForPage(pages[0]);
          await new Promise(r => setTimeout(r, 350));
          await pages[0].goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch {}
      }

      // ===== Enterprise HARDENING: diagnóstico imediato do estado real antes de "voltar a trabalhar" =====
      // Regras:
      // - Se estiver suspensa/banida: marca e invoca humano (não tenta automação).
      // - Se estiver em captcha/identity/checkpoint/2FA: invoca humano (não tenta automação).
      // - Se estiver em login/senha (login_form): agenda login_remediate (cookies -> login -> humano) sob provisionLock/quiesce.
      // - Se estiver em appeal_submitted: não retoma automação; arma monitoramento (1h).
      let scheduledLoginRemediate = false;
      let preflight = { ok: true, state: 'unknown', reason: '' };
      try {
        const p0 = (pages && pages[0]) ? pages[0] : null;
        if (p0) {
          // 0) Suspensa/banida (UI de suspensão)
          const bd = await browserHelper.detectAccountSuspended(p0).catch(()=>({ banned:false }));
          if (bd && bd.banned) {
            preflight = { ok: true, state: 'banned', reason: String(bd.reason || 'suspended_ui') };
            try { await setBannedFlag(nome, { reason: String(bd.reason || 'suspended_ui'), snippet: String(bd.snippet || '') }); } catch {}
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
                return d;
              });
            } catch {}
            try {
              ctrl.humanControl = true;
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              await browserHelper.invocarHumano(ctrl.browser, nome);
              try { freezeCooldownIfNotWorking(nome); } catch {}
              try { await ensureHumanOverlay(nome, ctrl, { reason: 'human_resume_preflight_banned' }); } catch {}
              await snapshotStatusAndWrite();
            } catch {}
            logger.info('[HANDLER] human-resume preflight -> banned', { nome, reason: preflight.reason });
            return { ok: true, preflight };
          }

          // 1) Login required / captcha / identity / appeal_submitted etc.
          const lr = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
          if (lr && lr.loginRequired) {
            const rr = String(lr.reason || '').toLowerCase();
            preflight = { ok: true, state: 'login_required', reason: String(lr.reason || '') };
            try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || 'human_resume' }); } catch {}

            // appeal_submitted: não retoma automação; arma monitoramento (1h) e mantém Virtus OFF.
            if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
              preflight.state = 'appeal_submitted';
              try { await setAppealSubmittedFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
              await snapshotStatusAndWrite();
              try { await ensureHumanOverlay(nome, ctrl, { reason: 'human_resume_preflight_appeal_submitted' }); } catch {}
              logger.info('[HANDLER] human-resume preflight -> appeal_submitted', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }

            // Non-automatable: captcha/identity/checkpoint => humano direto.
            // 2FA => exclusão automática.
            const isTwoFactor = rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor');
            const needsHuman =
              rr.includes('captcha') ||
              rr.includes('identity') ||
              rr.includes('checkpoint');
            if (isTwoFactor) {
              preflight.state = 'two_factor';
              try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(lr && lr.title || '') }); } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> two_factor', { nome, reason: lr.reason || '' });
              return { ok: false, error: 'two_factor', preflight };
            }
            if (needsHuman) {
              preflight.state = 'needs_human';
              try { await setLoginRemediateFailedFlag(nome, { reason: lr.reason || 'login_requires_human', source: 'human_resume', stage: 'human_resume_preflight' }); } catch {}
              try {
                await fileStore.withDesiredFileLockUpdate((d) => {
                  d.perfis = d.perfis || {};
                  d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
                  return d;
                });
              } catch {}
              try {
                ctrl.humanControl = true;
                ctrl.trabalhando = false;
                try { await stopVirtus(nome); } catch {}
                await browserHelper.invocarHumano(ctrl.browser, nome);
                try { freezeCooldownIfNotWorking(nome); } catch {}
                try { await ensureHumanOverlay(nome, ctrl, { reason: 'human_resume_preflight_needs_human' }); } catch {}
              } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> needs_human', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }

            // login_form (ou outros loginRequired "automatable"): agenda login_remediate imediatamente.
            // Requisito do lead: após sucesso, conta nova/retomada deve iniciar com Robe em 24h (igual conta nova).
            try {
              const plus24 = 24 * 60 * 60 * 1000;
              const now = Date.now();
              await manifestStore.update(nome, (m) => {
                m = m || {};
                const curLeft = m.robeCooldownUntil ? (Number(m.robeCooldownUntil || 0) - now) : 0;
                const desiredLeft = plus24;
                const use = Math.max(0, curLeft, desiredLeft);
                m.robeCooldownUntil = now + use;
                m.robePauseReason = 'new_account';
                return m;
              });
              robeUpdateMeta(nome, { pauseReason: 'new_account' });
            } catch {}

            // Evita que Virtus reinicie antes do login_remediate pegar o provisionLock/quiesce.
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'off' };
                return d;
              });
            } catch {}
            try { ctrl.trabalhando = false; } catch {}
            try { await stopVirtus(nome); } catch {}

            scheduledLoginRemediate = true;
            const op2 = `human_resume:${String(nome || '').trim()}:${Date.now()}`;
            setTimeout(() => {
              try {
                handlers.login_remediate({
                  nome,
                  operator: op2,
                  options: { overrideHumanHold: true }
                }).catch(()=>null);
              } catch {}
            }, 0);
            logger.info('[HANDLER] human-resume preflight -> scheduled login_remediate', { nome, reason: lr.reason || '' });
          }
        }
      } catch (e) {
        preflight = { ok: false, state: 'error', reason: (e && e.message) ? String(e.message) : String(e) };
      }

      if (scheduledLoginRemediate) {
        await snapshotStatusAndWrite();
        // desired é setado para virtus=off acima; login_remediate vai resolver e reativar se der certo.
        logger.info('[HANDLER] human-resume ok (login_remediate scheduled)', { nome, preflight });
        return { ok: true, scheduledLoginRemediate: true, preflight };
      }

      // ===== Fluxo original: se não caiu em nenhum estado "especial", retoma automação normal =====
      if (!hasAppeal) {
        if (automationAllowed(ctrl)) {
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
          ctrl.trabalhando = true;
        }
        try { unfreezeCooldownIfWorking(nome); } catch {}
      } else {
        // Estado "recurso_apresentado": não retoma automação; arma monitoramento (1h) e mantém Virtus OFF.
        ctrl.trabalhando = false;
        try { await stopVirtus(nome); } catch {}
        try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
      }

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] human-resume ok', { nome });

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = {
            ...(desired.perfis[nome] || {}),
            active: true,
            humanHold: false,
            virtus: hasAppeal ? 'off' : 'on'
          };
          return desired;
        });
      } catch {}

      return { ok:true };
    });
  },

  async ['robe-play']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] robe-play chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      if (isFrozenNow(nome)) {
        return { ok: false, error: 'account_frozen' }
      }
      if (ctrl && ctrl.configurando) return { ok: false, error: 'perfil_em_configuracao' };

      try {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          m.robeCooldownUntil = Date.now();
          m.robeCooldownRemainingMs = 0;
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
        if (robeMeta[nome]) {
          delete robeMeta[nome].pauseReason;
          delete robeMeta[nome].lastRobeBlockAt;
        }
      } catch {}

      if (!robeQueue.inQueue(nome) && !robeQueue.isActive(nome)) {
        robeUpdateMeta(nome, { emFila: true });
        robeQueue.enqueue(nome, async () => {

          robeUpdateMeta(nome, { emExecucao: true, emFila: false });

          let virtusWasRunning = false;
          const ctrl = controllers.get(nome);
          const workingNow = getWorkingProfileNames();
          if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

          if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
            robeUpdateMeta(nome, { estado: 'erro' });
            try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (robe-play guard)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }

          try { logger.info('[WORKER][robe-play] Robe start', { nome }); } catch {}
          try { await reportAction(nome, 'robe_start', 'Iniciando Robe via robe-play'); } catch {}

          let mainPage = null;
          try {
            if (ctrl && ctrl.browser && !ctrl.mainPage) {
              try {
                const pages = await ctrl.browser.pages();
                if (pages[0]) {
                  ctrl.mainPage = pages[0];
                  try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
                }
              } catch {}
            }
            mainPage = ctrl.mainPage;

            if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
              virtusWasRunning = true;
              try { await ctrl.virtus.stop(); } catch {}
              ctrl.virtus = null;
            }

            try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

            let res;
            try {
              res = await startRobeDynamic(ctrl.browser, nome, (15 + Math.floor(Math.random() * 16)) * 60 * 1000, workingNow);
            } catch (e) {
              if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].limitPostingThisRun = Date.now();
                robeMeta[nome].pauseReason = 'limit_posting';
                robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
                try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robe-play)'); } catch {}
                try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
                return;
              }
              await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão (15–30min) será aplicado por robe.js`);
              robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
              try { logger.warn('[WORKER][robe-play] Robe error', { nome, error: e && e.message || e }); } catch {}
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (isLimitPostingRes(res)) {
              robeMeta[nome] = robeMeta[nome] || {};
              robeMeta[nome].limitPostingThisRun = Date.now();
              robeMeta[nome].pauseReason = 'limit_posting';
              robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
              await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h (robe-play)');
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (res && res.ok) {
              try {
                await manifestStore.update(nome, (m) => {
                  m = m || {};
                  m.ultimaPostagemRobe = Date.now();
                  return m;
                });
              } catch {}
              const last = await robeLastPosted(nome);
              robeUpdateMeta(nome, {
                estado: 'ok',
                cooldownSec: await normalizeCooldown(nome),
                proximaPostagem: last + ((15+Math.floor(Math.random()*16))*60*1000),
                ultimaPostagem: Date.now()
              });
              try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso (robe-play)'); } catch {}
              try { logger.info('[WORKER][robe-play] Robe success', { nome }); } catch {}
            } else {
              robeUpdateMeta(nome, {
                estado: 'idle',
                cooldownSec: await normalizeCooldown(nome)
              });
            }
          } catch (e) {
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          } finally {
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
              await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
              delete robeMeta[nome].limitPostingThisRun;
              try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
              robeUpdateMeta(nome, { emExecucao: false });
              if (virtusWasRunning && automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
                  ctrl.trabalhando = true;
                  await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
                } catch {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              }
              await snapshotStatusAndWrite();
              return;
            }
            try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

            robeUpdateMeta(nome, { emExecucao: false });

            if (virtusWasRunning) {
              if (automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
                  ctrl.trabalhando = true;
                } catch (e) {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              } else {
                ctrl.virtus = null;
                ctrl.trabalhando = false;
              }
              await snapshotStatusAndWrite();
            } else {
              await snapshotStatusAndWrite();
            }

            try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado (robe-play)'); } catch {}
            try { logger.info('[WORKER][robe-play] Robe end', { nome }); } catch {}
          }
        });
        await snapshotStatusAndWrite();
      }
      logger.info('[HANDLER] robe-play ok', { nome });
      return { ok: true };
    });
  },

  async ['robes-release-all']() {
    logger.info('[HANDLER] robes-release-all chamada');
    const perfisArr = loadPerfisJson();
    for (const p of perfisArr) {
      try {
        robeMeta[p.nome] = robeMeta[p.nome] || {};
        delete robeMeta[p.nome].pauseReason;
        delete robeMeta[p.nome].lastRobeBlockAt;
        await manifestStore.update(p.nome, m => {
          m = m || {};
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
      } catch {}
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] robes-release-all ok');
    return { ok: true };
  },

  // ====== HANDLER apply-city - aplica coordenadas da nova cidade em runtime ======
  async ['apply-city']({ nome }) {
    return lockProfileAction(nome, async () => {
      const ctrl = controllers.get(nome);

      // Se navegador não está ativo para este perfil, não há o que aplicar!
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        await issues.append(nome, 'mil_action', 'apply_city_runtime_skip_not_active');

        return { ok: true, active: false };
      }

      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        const cidade = man && man.cidade || '';
        const coords = require('./utils.js').getCoords(cidade || '');

        if (!coords || !coords.latitude || !coords.longitude) {
          await issues.append(nome, 'mil_action', `apply_city_skip coords_unavailable cidade="${cidade||''}"`);

          return { ok: false, error: 'coords_unavailable' };
        }

        const pages = await ctrl.browser.pages().catch(()=>[]);
        let applied = 0;

        for (const p of (pages||[])) {
          try { await p.setGeolocation(coords); applied++; } catch {}
        }

        await issues.append(nome, 'mil_action', `apply_city_runtime_ok cidade="${cidade}" pages=${applied}`);

        // Optionally: update status snapshot
        try { await snapshotStatusAndWrite(); } catch {}

        return { ok: true, appliedPages: applied, cidade };

      } catch (e) {
        await issues.append(nome, 'mil_action', `apply_city_runtime_error ${(e&&e.message)||e}`);

        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  },

  async ['get-status']() {
    try {
      for (const n of Object.keys(robeMeta)) {
        const m = robeMeta[n];
        if (!m) continue;
        if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
        while (m.cpuHistory.length > 8) m.cpuHistory.shift();
        if (!Array.isArray(m.ramHist)) m.ramHist = [];
        while (m.ramHist.length > 8) m.ramHist.shift();
        if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
        while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
        if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
        while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
      }
    } catch {}

    const perfisArr = loadPerfisJson();
    const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
    const perfis = [];
    for (const p of perfisArr) {
      const nome = p.nome;
      let issuesCount = 0;
      try {
        if (issues && typeof issues.countErrors === 'function') {
          const res = issues.countErrors(nome);
          issuesCount = Number(res && res.count) || 0;
        } else {
          issuesCount = countErrorsLocal(nome);
        }
      } catch { issuesCount = 0; }
      const fail = getFailureCounts(nome);
      let manifestStatus = await computeManifestStatus(nome);
      const man = await manifestStore.read(nome).catch(()=>null);
      const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
      const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
      const loginSource = man ? ((man.accountFlags && man.accountFlags.loginSource) || null) : (robeMeta[nome]?.loginSource || null);
      const loginRemediateFailed = man ? !!(man.accountFlags && man.accountFlags.loginRemediateFailed === true) : !!robeMeta[nome]?.loginRemediateFailed;
      const loginRemediateFailedAt = man ? ((man.accountFlags && man.accountFlags.loginRemediateFailedAt) || null) : null;
      const loginRemediateFailedReason = man ? ((man.accountFlags && man.accountFlags.loginRemediateFailedReason) || null) : (robeMeta[nome]?.loginRemediateFailedReason || null);
      const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
      const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
      const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
      const twoFactor = man ? !!(man.accountFlags && man.accountFlags.twoFactor === true) : !!robeMeta[nome]?.twoFactor;
      const twoFactorAt = man ? ((man.accountFlags && man.accountFlags.twoFactorAt) || null) : null;
      const twoFactorReason = man ? ((man.accountFlags && man.accountFlags.twoFactorReason) || null) : null;
      const twoFactorText = man ? ((man.accountFlags && man.accountFlags.twoFactorText) || null) : null;
      const appealSubmitted = man ? !!(man.accountFlags && man.accountFlags.appealSubmitted === true) : !!robeMeta[nome]?.appealSubmitted;
      const appealSubmittedAt = man ? ((man.accountFlags && man.accountFlags.appealSubmittedAt) || null) : null;
      const appealNextCheckAt = man ? ((man.accountFlags && man.accountFlags.appealNextCheckAt) || null) : null;
      const appealLastCheckAt = man ? ((man.accountFlags && man.accountFlags.appealLastCheckAt) || null) : null;
      const appealLastReason = man ? ((man.accountFlags && man.accountFlags.appealLastReason) || null) : null;
      const messengerPin = man ? !!(man.accountFlags && man.accountFlags.messengerPin === true) : !!robeMeta[nome]?.messengerPin;
      const messengerPinReason = man ? ((man.accountFlags && man.accountFlags.messengerPinReason) || null) : null;
      const problem = man
        ? !!((man.accountFlags && man.accountFlags.loginRequired === true) || (man.accountFlags && man.accountFlags.banned === true) || (man.accountFlags && man.accountFlags.twoFactor === true) || (man.accountFlags && man.accountFlags.messengerPin === true))
        : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned || (robeMeta[nome] || {}).twoFactor || (robeMeta[nome] || {}).messengerPin);
      const man0 = await manifestStore.read(nome).catch(()=>null);
      const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';

      // Observabilidade enterprise: flags runtime (usadas para pausa/quiescência determinística)
      const ctrl = controllers.get(nome);
      const virtusOnline = !!(ctrl && ctrl.virtus);
      const sendLockActive = !!(ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active);
      const robeEmExecucao = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);

      perfis.push({
        nome,
        label: p.label || null,
        cidade: p.cidade,
        uaPresetId: p.uaPresetId,
        active: controllers.has(nome),
        trabalhando: !!(controllers.get(nome)?.trabalhando),
        virtusOnline,
        sendLockActive,
        robeEmExecucao,
        configurando: !!(controllers.get(nome)?.configurando),
        humanControl: !!(controllers.get(nome)?.humanControl),
        humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
        issuesCount,
        ramMB: (() => {
          const v = typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null;
          // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
          return v;
        })(),
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
        killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
        reopenAt: robeMeta[nome]?.reopenAt || null,
        manifestStatus,
        closingReason: robeMeta[nome]?.closingReason || null,
        openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
        lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
        loginRequired,
        loginReason,
        loginSource,
        loginRemediateFailed,
        loginRemediateFailedAt,
        loginRemediateFailedReason,
        banned,
        bannedAt,
        bannedText,
        twoFactor,
        twoFactorAt,
        twoFactorReason,
        twoFactorText,
        appealSubmitted,
        appealSubmittedAt,
        appealNextCheckAt,
        appealLastCheckAt,
        appealLastReason,
        messengerPin,
        messengerPinReason,
        problem,
        robeMode
      });
    }
    const robes = {};
    for (const p of perfisArr) {
      const nome = p.nome;
      const fail = getFailureCounts(nome);
      robes[nome] = {
        cooldownSec: await normalizeCooldown(nome),
        estado: robeMeta[nome]?.estado || '',
        proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
        ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
        emFila: !!robeMeta[nome]?.emFila,
        emExecucao: !!robeMeta[nome]?.emExecucao,
        ramMB: (() => {
          const v = typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null;
          // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
          return v;
        })(),
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        pauseReason: robeMeta[nome]?.pauseReason || null,
        lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
      };
      const pauseActive = await (async () => {
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
        } catch { return false; }
      })();
      if (pauseActive) {
        robes[nome].estado = 'paused_limit';
      }
      const man = await manifestStore.read(nome).catch(()=>null);
      if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
        robes[nome].pauseReason = 'limit_posting';
        robes[nome].estado = 'paused_limit';
        await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
      }
    }
    const robeQueueList = robeQueue.queueList();
    const sys = {
      freeMB: Math.round(os.freemem()/(1024*1024)),
      totalMB: Math.round(os.totalmem()/(1024*1024)),
      cores: (os.cpus()||[]).length,
      cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
    };
    return {
      perfis,
      robes,
      robeQueue: robeQueueList,
      autoMode,
      sys,
      // Diagnóstico enterprise: ajuda a provar quando o dashboard está “cego” porque não há controllers vivos.
      _debug: {
        pid: process && process.pid ? process.pid : null,
        buildTag: (typeof WORKER_BUILD_TAG === 'string' ? WORKER_BUILD_TAG : null),
        humanOverlayEnabled: (typeof HUMAN_OVERLAY_CFG === 'object' ? !!HUMAN_OVERLAY_CFG.enabled : null),
        shardSize: SHARD_SET ? SHARD_SET.size : null,
        controllersCount: controllers ? controllers.size : null,
        ts: Date.now()
      }
    };
  },

  async unfreeze({ nome, setBy }) {
    return lockProfileAction(nome, async () => {
      if (!nome) return { ok: false, error: 'nome_obrigatorio' };
      try { await unfreezeProfile(nome, setBy || 'admin'); } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
      return { ok: true };
    });
  },

  async ['unfreeze-all']() {
    try {
      const perfisArr = loadPerfisJson();
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        try { await unfreezeProfile(p.nome, 'admin_all'); } catch {}
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
  },

  async ['set-shard']({ names }) {
    try {
      const newSet = new Set(Array.isArray(names) ? names : []);
      const removed = [];
      for (const nome of SHARD_SET) {
        if (!newSet.has(nome)) removed.push(nome);
      }
      SHARD_SET = newSet;

      // Airbag enterprise: nunca derrubar dezenas por "shard move"
      const MAX_SHARD_MOVE_DEACTIVATIONS = Math.max(0, parseInt(process.env.MAX_SHARD_MOVE_DEACTIVATIONS || '2', 10) || 2);
      let deactivatedCount = 0;

      for (const nome of removed) {
        const ctrl = controllers.get(nome);
        const rm = robeMeta[nome] || {};
        const robeRunning = rm.emExecucao === true || (ctrl && ctrl.browser && ctrl.browser._robeActiveFor === nome);
        const busy = robeRunning || (ctrl && (ctrl.configurando === true || ctrl.humanControl === true));

        if (busy) {
          robeMeta[nome] = rm;
          rm.pendingShardMove = true;
          rm.deferShardMoveUntil = Date.now() + 10*60*1000;
          await issues.append(nome, 'mil_action', 'shard_move_deferred (busy)');
          continue;
        }

        // Se passar do limite, adiar o resto (evita storm)
        if (deactivatedCount >= MAX_SHARD_MOVE_DEACTIVATIONS) {
          robeMeta[nome] = rm;
          rm.pendingShardMove = true;
          rm.deferShardMoveUntil = Date.now() + 15*60*1000;
          await issues.append(nome, 'mil_action', `shard_move_deferred (cap max=${MAX_SHARD_MOVE_DEACTIVATIONS})`);
          continue;
        }

        try { robeQueue.skip && robeQueue.skip(nome); } catch {}
        try {
          if (ctrl && ctrl.browser) {
            await handlers.deactivate({ nome, reason: 'shard_moved', policy: 'preserveDesired' });
            deactivatedCount++;
          }
        } catch {}
        controllers.delete(nome);
        try { healthState.delete(nome); } catch {}
        try { profileFailures.delete(nome); } catch {}
        if (robeMeta[nome]) {
          delete robeMeta[nome].emExecucao;
          delete robeMeta[nome].emFila;
          delete robeMeta[nome].cpuHistory;
          delete robeMeta[nome].ramHist;
          delete robeMeta[nome].reloadAttemptsWindow;
          delete robeMeta[nome].blockDetectWindow;
        }
      }
      await snapshotStatusAndWrite();
      return { ok: true, size: SHARD_SET.size, removed, deactivatedCount, maxDeactivations: MAX_SHARD_MOVE_DEACTIVATIONS };

    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  }
};

async function snapshotStatusAndWrite() {
_statusLock = _statusLock.then(async () => {
try {
try {
  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
    while (m.cpuHistory.length > 8) m.cpuHistory.shift();
    if (!Array.isArray(m.ramHist)) m.ramHist = [];
    while (m.ramHist.length > 8) m.ramHist.shift();
    if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
    while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
    if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
    while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
  }
} catch {}

const perfisArr = loadPerfisJson();
const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
const perfis = [];
for (const p of perfisArr) {
const nome = p.nome;
let issuesCount = 0;
try {
  if (issues && typeof issues.countErrors === 'function') {
    const res = issues.countErrors(nome);
    issuesCount = Number(res && res.count) || 0;
  } else {
    issuesCount = countErrorsLocal(nome);
  }
} catch {}
const fail = getFailureCounts(nome);
let manifestStatus = await computeManifestStatus(nome);
const man = await manifestStore.read(nome).catch(()=>null);
const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
const loginSource = man ? ((man.accountFlags && man.accountFlags.loginSource) || null) : (robeMeta[nome]?.loginSource || null);
const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
const appealSubmitted = man ? !!(man.accountFlags && man.accountFlags.appealSubmitted === true) : !!robeMeta[nome]?.appealSubmitted;
const appealSubmittedAt = man ? ((man.accountFlags && man.accountFlags.appealSubmittedAt) || null) : null;
const appealNextCheckAt = man ? ((man.accountFlags && man.accountFlags.appealNextCheckAt) || null) : null;
const appealLastCheckAt = man ? ((man.accountFlags && man.accountFlags.appealLastCheckAt) || null) : null;
const appealLastReason = man ? ((man.accountFlags && man.accountFlags.appealLastReason) || null) : null;
const messengerPin = man ? !!(man.accountFlags && man.accountFlags.messengerPin === true) : !!robeMeta[nome]?.messengerPin;
const messengerPinReason = man ? ((man.accountFlags && man.accountFlags.messengerPinReason) || null) : null;
const problem = man
  ? !!((man.accountFlags && man.accountFlags.loginRequired === true) || (man.accountFlags && man.accountFlags.banned === true) || (man.accountFlags && man.accountFlags.messengerPin === true) || (man.accountFlags && man.accountFlags.appealSubmitted === true))
  : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned || (robeMeta[nome] || {}).messengerPin || (robeMeta[nome] || {}).appealSubmitted);
const man0 = await manifestStore.read(nome).catch(()=>null);
const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';

perfis.push({
  nome,
  label: p.label || null,
  cidade: p.cidade,
  uaPresetId: p.uaPresetId,
  active: controllers.has(nome),
  trabalhando: !!(controllers.get(nome)?.trabalhando),
  // Observabilidade enterprise (p/ pausas determinísticas durante provisionamento)
  virtusOnline: !!(controllers.get(nome)?.virtus),
  sendLockActive: !!(controllers.get(nome)?.browser && controllers.get(nome).browser._sendLock && controllers.get(nome).browser._sendLock.active),
  robeEmExecucao: !!(robeMeta[nome]?.emExecucao),
  configurando: !!(controllers.get(nome)?.configurando),
  humanControl: !!(controllers.get(nome)?.humanControl),
  humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
  issuesCount,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
  killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
  reopenAt: robeMeta[nome]?.reopenAt || null,
  manifestStatus,
  closingReason: robeMeta[nome]?.closingReason || null,
  openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
  lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
  loginRequired,
  loginReason,
  loginSource,
  banned,
  bannedAt,
  bannedText,
  appealSubmitted,
  appealSubmittedAt,
  appealNextCheckAt,
  appealLastCheckAt,
  appealLastReason,
  messengerPin,
  messengerPinReason,
  problem,
  robeMode
});
}
const robes = {};
for (const p of perfisArr) {
const nome = p.nome;
const fail = getFailureCounts(nome);
robes[nome] = {
  cooldownSec: await normalizeCooldown(nome),
  estado: robeMeta[nome]?.estado || '',
  proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
  ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
  emFila: !!robeMeta[nome]?.emFila,
  emExecucao: !!robeMeta[nome]?.emExecucao,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  pauseReason: robeMeta[nome]?.pauseReason || null,
  lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
};
try {
  if (robes[nome].cooldownSec === 0) {
    await releaseLimitPostingIfExpired(nome);
  }
} catch {}
if (robes[nome].cooldownSec === 0 && robeMeta[nome] && robeMeta[nome].pauseReason === 'fb_block') {
  const ts = robeMeta[nome].lastRobeBlockAt || 0;
  if (ts && (Date.now() - ts) > 25*60*60*1000) {
    delete robeMeta[nome].pauseReason;
    delete robeMeta[nome].lastRobeBlockAt;
  }
}
const pauseActive = await (async () => {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
  } catch { return false; }
})();
if (pauseActive) {
  robes[nome].estado = 'paused_limit';
  robes[nome].pauseReason = 'limit_posting';
  await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
}
}
const robeQueueList = robeQueue.queueList();
const sys = {
  freeMB: Math.round(os.freemem()/(1024*1024)),
  totalMB: Math.round(os.totalmem()/(1024*1024)),
  cores: (os.cpus()||[]).length,
  cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
};
const statusObj = { perfis, robes, robeQueue: robeQueueList, autoMode, sys, ts: Date.now() };

// LOGS DE DIAGNÓSTICO DA RAM — somente quando estiver null/undefined
try {
  // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
  // for (const ent of perfis) {
  //   if (!(typeof ent.ramMB === 'number')) {
  //     logger.warn('[STATUS-WRITE] ramMB é null/undefined', { nome: ent.nome, ramMB: ent.ramMB, hasRobeMeta: !!robeMeta[ent.nome] });
  //   }
  // }
} catch {}

const ok = writeJsonAtomic(statusPath, statusObj);
if (!ok) { try { await issues.append('system','persist_failed', 'status_write'); } catch {} }
} catch (e) {
try { logger.warn('[WORKER][statusWrite] erro', { error: e && e.message || e }); } catch {}
}
});
try { supervisorClient.sendTelemetria({ type: 'hb', alive: controllers.size }); } catch {}
return _statusLock;
}

async function appendIssueNurseDebounced(nome, type, message, key) {
  if (!nome) return;
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].nurseLogDebounce = robeMeta[nome].nurseLogDebounce || {};
  const k = key || type;
  const last = robeMeta[nome].nurseLogDebounce[k] || 0;
  if (Date.now() - last < 60000) return;
  robeMeta[nome].nurseLogDebounce[k] = Date.now();
  await issues.append(nome, type, message);
}

const NURSE_CFG = {
  INTERVAL_MS: 5000,
  PAGE_EVAL_TIMEOUT_MS: 5000
};

const MAX_OPEN_CONCURRENCY = 1;
let slotsInUse = 0;
const OPEN_ACTIVATION_DELAY_MS = parseInt(process.env.OPEN_ACTIVATION_DELAY_MS || '1200', 10);

const ULTRA_RECOVERY = {
  MAX_RELOADS: 2,
  RELOAD_TIMEOUT_MS: 10000,
  RELOAD_POST_WAIT_MS: 250,
  REOPEN_DELAY_SHORT_MS: 5000, // NOVO: Reduzido de 60s para 5s (reabertura quase imediata, supervisor controla velocidade)
  REOPEN_DELAY_RAMCPU_MS: 60000,
  FAIL_WINDOW_MS: 3*60*60*1000,
  FAIL_FREEZE_AFTER: 5,
  FAIL_FREEZE_MS: 2*60*60*1000,
  REOPEN_DELAY_VIRTUS_BLOCK_MS: 2*60*60*1000
};

async function ensureFrozenShutdown(nome, origin = 'frozen') {
  const ctrl = controllers.get(nome);
  if (!ctrl) return;
  try { robeQueue.skip && robeQueue.skip(nome); } catch {}
  try { await reportAction(nome, 'mil_action', 'frozen_kill'); } catch {}
  try {
    await handlers.deactivate({ nome, reason: 'frozen', policy: 'preserveDesired' });
  } catch {}
  try { stopPruneLoop(nome); } catch {}
  try {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].reopenAt = null;
    robeMeta[nome].activationHeldUntil = robeMeta[nome].frozenUntil || (Date.now() + 3600_000);
  } catch {}
  try { await snapshotStatusAndWrite(); } catch {}
}

const INTERNAL_REASONS = new Set(['ramKill','cpuKill','manifest_missing','manifest_incomplete','panic','open_headroom']);
const EXTERNAL_REASONS = new Set(['disconnected','no_pages','zombie','network','fb_dom','messenger_temp_block','blocked']);

function classifyReason(reason, fallback) {
  if (INTERNAL_REASONS.has(reason)) return 'internal';
  if (EXTERNAL_REASONS.has(reason)) return 'external';
  return fallback || 'unknown';
}

function getFailureCounts(nome) {
  const now = Date.now();
  const rec = profileFailures.get(nome);
  if (!rec) return { internal: 0, external: 0, unknown: 0 };
  const pruned = {
    internal: (rec.internal||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    external: (rec.external||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    unknown: (rec.unknown||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS)
  };
  profileFailures.set(nome, pruned);
  return { internal: pruned.internal.length, external: pruned.external.length, unknown: pruned.unknown.length };
}

const profileFailures = new Map();
async function registerFailure(nome, reason, classification) {
  const now = Date.now();
  const cls = classification || classifyReason(reason, 'unknown');
  const rec = profileFailures.get(nome) || { internal: [], external: [], unknown: [] };
  rec.internal = (rec.internal||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.external = (rec.external||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.unknown  = (rec.unknown ||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  if (cls === 'internal') rec.internal.push(now);
  else if (cls === 'external') rec.external.push(now);
  else rec.unknown.push(now);
  profileFailures.set(nome, rec);
  const counts = getFailureCounts(nome);
  try { await issues.append(nome, 'failure', `reason=${reason} class=${cls} internal=${counts.internal} external=${counts.external} unknown=${counts.unknown}`); } catch {}

  const ALLOWED_FREEZE_REASONS = new Set(['manifest_missing','manifest_incomplete']);
  if (ALLOWED_FREEZE_REASONS.has(reason)) {
    await freezeProfileFor(nome, 12*60*60*1000, reason, 'system');
    await ensureFrozenShutdown(nome, reason || 'frozen');
  }
}

async function pageReadyBasic(p0) {
  try {
    const res = await Promise.race([
      (async () => (await p0.evaluate(() => document.readyState)) || 'unknown')(),
      new Promise(res => setTimeout(() => res('timeout'), NURSE_CFG.PAGE_EVAL_TIMEOUT_MS))
    ]);
    return (res === 'interactive' || res === 'complete');
  } catch { return false; }
}

async function tryReloadShort(p0, nome, attempt) {
  try {
    if (process.env.NURSE_DEBUG === '1') {
      await reportAction(nome, 'mil_action', `nurse_reload_try #${attempt} url=${(p0 && p0.url && p0.url()) || ''} readyState=${await (async () => { try { return await p0.evaluate(()=>document.readyState); } catch { return '-'; } })()} reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
    }
  } catch {}
  try {
    await p0.reload({ waitUntil: 'domcontentloaded', timeout: ULTRA_RECOVERY.RELOAD_TIMEOUT_MS }).catch(()=>{});
    await new Promise(r=>setTimeout(r, ULTRA_RECOVERY.RELOAD_POST_WAIT_MS));
  } catch {}
  return await pageReadyBasic(p0);
}

function ms(h) { return h * 60 * 60 * 1000; }

async function freezeProfileFor(nome, msDuration, reason, setBy = 'system') {
  try {
    const now = Date.now();
    let applied = { until: now + msDuration, mode: 'set' };
    await manifestStore.update(nome, (man) => {
      man = man || {};
      const existingMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
      const existingDisk = (man && man.frozenUntil) || 0;
      const existing = Math.max(existingMem, existingDisk, 0);
      let until = now + msDuration;
      let mode = 'set';
      if (existing > now) {
        until = existing + msDuration;
        mode = 'extended';
      }
      applied.until = until;
      applied.mode = mode;

      man.frozenUntil = until;
      man.frozenReason = String(reason || '');
      man.frozenAt = man.frozenAt || now;
      man.frozenSetBy = setBy || 'system';
      return man;
    });

    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].frozenUntil = applied.until;
    robeMeta[nome].frozenReason = String(reason || '');
    robeMeta[nome].frozenAt = robeMeta[nome].frozenAt || now;
    robeMeta[nome].frozenSetBy = setBy || 'system';

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `frozen_${Math.round(msDuration/60000)}min(${applied.mode}): reason=${reason||''} setBy=${setBy} until=${new Date(applied.until).toISOString()}`
      );
    } catch {}

    await ensureFrozenShutdown(nome, reason || 'frozen');
    await snapshotStatusAndWrite();
  } catch {}
}

async function unfreezeProfile(nome, setBy = 'admin') {
  try {
    const now = Date.now();

    robeMeta[nome] = robeMeta[nome] || {};
    delete robeMeta[nome].frozenUntil;
    delete robeMeta[nome].frozenReason;
    delete robeMeta[nome].frozenAt;
    delete robeMeta[nome].frozenSetBy;
    robeMeta[nome].activationHeldUntil = now + 60*1000;
    robeMeta[nome].reloadAttemptsWindow = [];
    robeMeta[nome].unfreezeCount = (robeMeta[nome].unfreezeCount || 0) + 1;
    robeMeta[nome].lastUnfreezeAt = now;
    robeMeta[nome].reopenAt = null;

    await manifestStore.update(nome, (man) => {
      man = man || {};
      if ('frozenUntil' in man) delete man.frozenUntil;
      if ('frozenReason' in man) delete man.frozenReason;
      if ('frozenAt' in man) delete man.frozenAt;
      if ('frozenSetBy' in man) delete man.frozenSetBy;
      return man;
    });

    profileFailures.set(nome, { internal: [], external: [], unknown: [] });

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `unfreeze by=${setBy}`
      );
    } catch {}

    await snapshotStatusAndWrite();
  } catch {}
}

async function detectMessengerTempBlock(page) {
  try {
    const url = page.url ? page.url() : '';
    if (!/messenger.com/i.test(url)) return { blocked: false };
    return await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const texts = Array.from(document.querySelectorAll('h1,h2,span,div'))
        .slice(0, 300)
        .map(el => norm(el.innerText || el.content || el.textContent || ''))
        .filter(Boolean);

      const hasBlocked =
        texts.some(t =>
          t.includes('voce esta bloqueado temporariamente') ||
          t.includes('você está bloqueado temporariamente') ||
          t.includes('youre temporarily blocked') ||
          t.includes('you’re temporarily blocked') ||
          t.includes('temporarily blocked')
        );
      const hasReloadBtn =
        !!document.querySelector('[aria-label*="Recarregar pagina"],[aria-label*="Recarregar página"],[aria-label*="Reload"]');
      return { blocked: hasBlocked, hasReloadBtn };
    });
  } catch { return { blocked: false }; }
}

// =========================================================
// AUTO LOGIN-REMEDIATE (enterprise autopilot)
// - Objetivo: ao detectar loginRequired (login_form) em qualquer perfil aberto,
//   disparar automaticamente o fluxo robusto `login_remediate` com mínimo impacto.
// - Guardrails:
//   - 1 por vez por worker/host (evita storm ao "abrir todos")
//   - backoff por perfil + limite por janela
//   - NUNCA tenta para captcha/checkpoint/identity (vira humanHold)
// =========================================================
const AUTO_LR_CFG = {
  enabled: !(String(process.env.AUTO_LOGIN_REMEDIATE || '').trim() === '0'),
  tickMs: Math.max(2000, Number(process.env.AUTO_LOGIN_REMEDIATE_TICK_MS || 5000) || 5000),
  immediateDelayMs: Math.max(0, Number(process.env.AUTO_LOGIN_REMEDIATE_IMMEDIATE_DELAY_MS || 1200) || 1200),
  minIntervalPerProfileMs: Math.max(60_000, Number(process.env.AUTO_LOGIN_REMEDIATE_MIN_INTERVAL_MS || (20 * 60 * 1000)) || (20 * 60 * 1000)), // 20min
  maxAttemptsPerProfile24h: Math.max(1, Number(process.env.AUTO_LOGIN_REMEDIATE_MAX_ATTEMPTS_24H || 4) || 4),
  backoffFailMs: Math.max(60_000, Number(process.env.AUTO_LOGIN_REMEDIATE_BACKOFF_FAIL_MS || (45 * 60 * 1000)) || (45 * 60 * 1000)), // 45min
  totalTimeoutMs: Math.max(60_000, Number(process.env.AUTO_LOGIN_REMEDIATE_TOTAL_TIMEOUT_MS || (6 * 60 * 1000)) || (6 * 60 * 1000)),
  stageTimeoutMs: {
    activate: Math.max(10_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_ACTIVATE_MS || 90_000) || 90_000),
    injectCookies: Math.max(30_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_INJECT_MS || 240_000) || 240_000),
    loginFb: Math.max(30_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_LOGIN_FB_MS || 120_000) || 120_000),
    loginMsg: Math.max(30_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_LOGIN_MSG_MS || 120_000) || 120_000),
    collectCookies: Math.max(10_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_COLLECT_MS || 90_000) || 90_000),
  }
};

let _autoLoginRemediateRunning = false;
let _autoLoginRemediateRunningNome = null;

function _pruneWindow(arr, winMs) {
  const now = Date.now();
  const a = Array.isArray(arr) ? arr : [];
  return a.filter(ts => ts && (now - ts) <= winMs);
}

function queueAutoLoginRemediate(nome, { reason = '', source = '', immediate = false } = {}) {
  try {
    if (!AUTO_LR_CFG.enabled) return false;
    if (!nome) return false;
    robeMeta[nome] = robeMeta[nome] || {};
    const st = robeMeta[nome].autoLoginRemediate = (robeMeta[nome].autoLoginRemediate || {});
    const now = Date.now();

    st.attempts24h = _pruneWindow(st.attempts24h, 24 * 60 * 60 * 1000);
    if ((st.attempts24h || []).length >= AUTO_LR_CFG.maxAttemptsPerProfile24h) {
      st.queued = false;
      st.nextAt = Math.max(st.nextAt || 0, now + (3 * 60 * 60 * 1000));
      try { issues.append(nome, 'mil_action', `auto_login_remediate_suppressed: max_attempts_24h=${AUTO_LR_CFG.maxAttemptsPerProfile24h}`).catch(()=>{}); } catch {}
      return false;
    }

    const last = Number(st.lastStartAt || 0) || 0;
    const earliest = last ? (last + AUTO_LR_CFG.minIntervalPerProfileMs) : 0;
    const when = Math.max(
      now + (immediate ? AUTO_LR_CFG.immediateDelayMs : 2500),
      earliest,
      Number(st.nextAt || 0) || 0
    );
    st.queued = true;
    st.nextAt = when;
    st.reason = String(reason || '').slice(0, 80);
    st.source = String(source || '').slice(0, 80);
    st.enqueuedAt = now;
    return true;
  } catch {
    return false;
  }
}

async function autoLoginRemediateTick() {
  if (!AUTO_LR_CFG.enabled) return;
  if (_autoLoginRemediateRunning) return;
  // Não competir com provisionamento/manual configure em andamento: evita alternância de lock
  try { if (provisionLock.isActive()) return; } catch {}

  const desired = readJsonFile(desiredPath, { perfis: {} });
  const now = Date.now();

  let best = null;
  for (const [nome, ctrl] of controllers.entries()) {
    if (!nome || !ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) continue;
    if (ctrl.humanControl === true || ctrl.configurando === true) continue;
    if (ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) continue;
    if (robeMeta[nome] && robeMeta[nome].emExecucao === true) continue;

    const want = desired && desired.perfis ? desired.perfis[nome] : null;
    if (want && want.humanHold === true) continue;

    const flags = await readAccountFlags(nome).catch(()=>({}));
    const lrFlag = !!(flags && flags.loginRequired === true);
    const lrFailed = !!(flags && flags.loginRemediateFailed === true);
    const st = robeMeta[nome] && robeMeta[nome].autoLoginRemediate ? robeMeta[nome].autoLoginRemediate : null;
    const queued = !!(st && st.queued);
    const nextAt = st ? (Number(st.nextAt || 0) || 0) : 0;

    // Só tenta se o perfil está marcado como loginRequired (persistido) e está enfileirado (evento detectado).
    if (!lrFlag || !queued) continue;
    // Blindagem anti-loop: se já falhou (cookies+login) recentemente e foi marcado, NÃO tenta de novo automaticamente.
    if (lrFailed) {
      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].autoLoginRemediate = robeMeta[nome].autoLoginRemediate || {};
        robeMeta[nome].autoLoginRemediate.queued = false;
        robeMeta[nome].autoLoginRemediate.nextAt = Math.max(robeMeta[nome].autoLoginRemediate.nextAt || 0, Date.now() + (6 * 60 * 60 * 1000));
      } catch {}
      try { issues.append(nome, 'mil_action', 'auto_login_remediate_skip(loginRemediateFailed=true)').catch(()=>{}); } catch {}
      continue;
    }
    if (nextAt && nextAt > now) continue;

    if (!best || nextAt < best.nextAt) best = { nome, nextAt: nextAt || now };
  }

  if (!best) return;

  const nome = best.nome;
  robeMeta[nome] = robeMeta[nome] || {};
  const st = robeMeta[nome].autoLoginRemediate = (robeMeta[nome].autoLoginRemediate || {});

  _autoLoginRemediateRunning = true;
  _autoLoginRemediateRunningNome = nome;
  st.queued = false;
  st.inFlight = true;
  st.lastStartAt = Date.now();
  st.attempts24h = _pruneWindow(st.attempts24h, 24 * 60 * 60 * 1000);
  st.attempts24h.push(st.lastStartAt);

  const operator = `auto_login_remediate:${nome}:${st.lastStartAt}`;
  try {
    try { provisionAudit.append({ ts: Date.now(), event: 'auto_login_remediate_begin', nome, operator, reason: st.reason || null, source: st.source || null }); } catch {}
    try { await issues.append(nome, 'mil_action', `auto_login_remediate_begin reason=${st.reason||''} source=${st.source||''}`); } catch {}

    const resp = await handlers.login_remediate({
      nome,
      operator,
      options: {
        // Autopilot nunca quebra "humanHold" automaticamente.
        overrideHumanHold: false,
        // Pós-sucesso enterprise: fecha, reabre mínimos e inicia Virtus.
        closeAfterSuccess: true,
        startAfterSuccess: true,
        reopenClosedForRam: true,
        // Guardrails (não fechar muito)
        maxHardDeactivations: 2,
        // Timeouts duros
        totalTimeoutMs: AUTO_LR_CFG.totalTimeoutMs,
        stageTimeoutMs: AUTO_LR_CFG.stageTimeoutMs,
        // Espera um pouco mais se estiver ocupado (robe/postagem/enviando)
        waitBusyMs: 120_000
      }
    });

    st.lastDoneAt = Date.now();
    st.lastOk = !!(resp && resp.ok);
    st.lastError = resp && resp.error ? String(resp.error).slice(0, 160) : null;
    try { provisionAudit.append({ ts: Date.now(), event: 'auto_login_remediate_done', nome, operator, ok: st.lastOk, error: st.lastError || null }); } catch {}

    if (!st.lastOk) {
      // Persistir estado de falha (para abrir em modo humano e impedir loops automáticos)
      try { await setLoginRemediateFailedFlag(nome, { reason: st.lastError || 'login_remediate_failed', source: 'auto_login_remediate', stage: 'auto' }); } catch {}
      // Backoff em falha: evita loop no mesmo perfil.
      st.nextAt = Date.now() + AUTO_LR_CFG.backoffFailMs;
      try { await issues.append(nome, 'mil_action', `auto_login_remediate_backoff ${Math.round(AUTO_LR_CFG.backoffFailMs/60000)}min err=${st.lastError||''}`); } catch {}
    } else {
      // Sucesso: limpa fila.
      st.nextAt = 0;
      st.reason = null;
      st.source = null;
      try { await clearAccountFlags(nome, ['loginRemediateFailed']); } catch {}
    }
  } catch (e) {
    st.lastDoneAt = Date.now();
    st.lastOk = false;
    st.lastError = (e && e.message) ? String(e.message).slice(0, 160) : String(e).slice(0, 160);
    st.nextAt = Date.now() + AUTO_LR_CFG.backoffFailMs;
    try { provisionAudit.append({ ts: Date.now(), event: 'auto_login_remediate_exception', nome, operator, error: st.lastError }); } catch {}
    try { await issues.append(nome, 'mil_action', `auto_login_remediate_exception err=${st.lastError}`); } catch {}
  } finally {
    try {
      st.inFlight = false;
      robeMeta[nome].autoLoginRemediate = st;
    } catch {}
    _autoLoginRemediateRunning = false;
    _autoLoginRemediateRunningNome = null;
  }
}

let _nurseTickRunning = false;
// Throttle: evidência enterprise de pausa durante provisionamento (evita spam a cada 5s)
let _provisionPauseLastLogAt = 0;
let _provisionPauseLastOwner = null;
let _provisionPauseLastUntilMs = 0;

async function nurseTick() {
  if (_nurseTickRunning) return;
  _nurseTickRunning = true;
  try {
    // Ultra enterprise (safety+performance):
    // Se não há browsers abertos, NÃO rode o nurse completo a cada 5s (custa I/O em centenas de perfis).
    // Mas ainda precisamos de um sweep leve para exclusões retroativas (ban/2FA) já marcadas em flags.
    const now0 = Date.now();
    if (controllers.size === 0) {
      try {
        robeMeta.system = robeMeta.system || {};
        const last = Number(robeMeta.system.nurseZeroControllersSweepAt || 0) || 0;
        if (!last || (now0 - last) > 60_000) { // no máximo 1x/min
          robeMeta.system.nurseZeroControllersSweepAt = now0;
          const desired0 = readJsonFile(desiredPath, { perfis: {} });
          for (const nome of Object.keys(desired0.perfis || {})) {
            try {
              const flags = await readAccountFlags(nome).catch(()=>({}));
              // Ban já marcado => tentar excluir (best-effort, idempotente)
              if (flags && flags.banned === true) {
                try { await setBannedFlag(nome, { reason: String(flags.bannedReason || 'banned'), snippet: String(flags.bannedText || '') }); } catch {}
                continue;
              }
              // 2FA já marcado => tentar excluir
              if (flags && flags.twoFactor === true) {
                try { await setTwoFactorFlag(nome, { reason: String(flags.twoFactorReason || 'two_factor'), snippet: String(flags.twoFactorText || '') }); } catch {}
                continue;
              }
              // Compat retroativa: loginRequired+reason two_factor => excluir
              if (flags && flags.loginRequired === true) {
                const rr = String(flags.loginReason || '').toLowerCase();
                if (rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor')) {
                  try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(flags.loginReason || '') }); } catch {}
                  continue;
                }
              }
            } catch {}
          }
        }
      } catch {}
      _nurseTickRunning = false;
      return;
    }
    // Ultra enterprise: durante provisionamento, pausar Virtus de forma controlada
    // (não interromper envio em andamento; não mexer em perfis em config/humano/robe ativo).
    try {
      const lk = provisionLock.get ? provisionLock.get() : (provisionLock.isActive() ? { active: true, lock: null } : { active: false, lock: null });
      if (lk && lk.active) {
        const owner = lk.lock && lk.lock.owner ? String(lk.lock.owner) : null;
        const untilMs = lk.lock && lk.lock.untilMs ? Number(lk.lock.untilMs) : 0;
        const paused = [];
        const skipped = { noVirtus: 0, human: 0, configurando: 0, robeExec: 0, sendLock: 0, other: 0 };

        for (const [n, c] of controllers.entries()) {
          try {
            if (!c || !c.virtus) { skipped.noVirtus++; continue; }
            if (c.humanControl === true) { skipped.human++; continue; }
            if (c.configurando === true) { skipped.configurando++; continue; }
            if (robeMeta[n] && robeMeta[n].emExecucao === true) { skipped.robeExec++; continue; }
            if (c.browser && c.browser._sendLock && c.browser._sendLock.active) { skipped.sendLock++; continue; }
            try { await stopVirtus(n); paused.push(String(n)); } catch { skipped.other++; }
          } catch { skipped.other++; }
        }

        // Evidência enterprise: loga no início do lock (ou mudança de owner) e depois a cada ~30s.
        const now = Date.now();
        const shouldLog =
          (owner && owner !== _provisionPauseLastOwner) ||
          (untilMs && untilMs !== _provisionPauseLastUntilMs) ||
          (now - _provisionPauseLastLogAt) > 30_000 ||
          paused.length > 0;

        if (shouldLog) {
          _provisionPauseLastLogAt = now;
          _provisionPauseLastOwner = owner;
          _provisionPauseLastUntilMs = untilMs;
          try {
            provisionAudit.append({
              ts: now,
              event: 'provision_lock_virtus_pause_tick',
              owner,
              untilMs,
              controllers: controllers.size,
              pausedCount: paused.length,
              pausedNames: paused.slice(0, 40),
              skipped
            });
          } catch {}
        }
      } else {
        // lock acabou: reseta para o próximo provisionamento
        _provisionPauseLastOwner = null;
        _provisionPauseLastUntilMs = 0;
      }
    } catch {}

    const now = Date.now();
    const desired = readJsonFile(desiredPath, { perfis: {} });
    for (const nome of Object.keys(desired.perfis || {})) {
      if (SHARD_SET.size && !inShard(nome)) {
        if (process.env.NURSE_DEBUG === '1') {
          try { logger.info(`[NURSE][SKIP_OTHER_SHARD] ${nome}`); } catch {}
        }
        continue;
      }
      const want = desired.perfis[nome] || {};
      const ctrl = controllers.get(nome);

      // Auto-exclusão enterprise: se já está marcado como banned/suspended, arquiva no CT e deleta o perfil local.
      // Isso cobre casos pós-restart onde a flag já estava setada e não vai passar novamente pelos fluxos de detecção.
      try {
        const flagsB = await readAccountFlags(nome).catch(()=>({}));
        if (flagsB && flagsB.banned === true) {
          robeMeta[nome] = robeMeta[nome] || {};
          const last = Number(robeMeta[nome].banSweepLastAt || 0) || 0;
          if (!last || (now - last) > (2 * 60 * 1000)) { // no máximo 1 tentativa a cada 2min por perfil
            robeMeta[nome].banSweepLastAt = now;
            try {
              provisionAudit.append({
                ts: now,
                event: 'ban_sweep_attempt',
                nome: String(nome || ''),
                reason: String(flagsB.bannedReason || flagsB.reason || '').slice(0, 160)
              });
            } catch {}
            try { await setBannedFlag(nome, { reason: String(flagsB.bannedReason || 'banned'), snippet: String(flagsB.bannedText || '') }); } catch {}
          }
          continue;
        }
      } catch {}

      // Auto-exclusão enterprise: 2FA (persistente) — cobre pós-restart.
      try {
        const flags2 = await readAccountFlags(nome).catch(()=>({}));
        if (flags2 && flags2.twoFactor === true) {
          robeMeta[nome] = robeMeta[nome] || {};
          const last = Number(robeMeta[nome].twoFactorSweepLastAt || 0) || 0;
          if (!last || (now - last) > (2 * 60 * 1000)) {
            robeMeta[nome].twoFactorSweepLastAt = now;
            try { provisionAudit.append({ ts: now, event: 'two_factor_sweep_attempt', nome: String(nome||''), reason: String(flags2.twoFactorReason||'two_factor').slice(0,160) }); } catch {}
            try { await setTwoFactorFlag(nome, { reason: String(flags2.twoFactorReason || 'two_factor'), snippet: String(flags2.twoFactorText || '') }); } catch {}
          }
          continue;
        }
      } catch {}

      // Compat retroativa: versões antigas marcavam 2FA como loginRequired com reason "two_factor/2fa".
      // Se isso acontecer, convertemos para twoFactor e excluímos.
      try {
        const flags3 = await readAccountFlags(nome).catch(()=>({}));
        if (flags3 && flags3.loginRequired === true) {
          const rr = String(flags3.loginReason || flags3.reason || '').toLowerCase();
          const isTwoFactor = rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor');
          if (isTwoFactor) {
            robeMeta[nome] = robeMeta[nome] || {};
            const last = Number(robeMeta[nome].twoFactorCompatSweepLastAt || 0) || 0;
            if (!last || (now - last) > (2 * 60 * 1000)) {
              robeMeta[nome].twoFactorCompatSweepLastAt = now;
              try { provisionAudit.append({ ts: now, event: 'two_factor_compat_sweep_attempt', nome: String(nome||''), reason: rr.slice(0,160) }); } catch {}
              try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(flags3.loginReason || '') }); } catch {}
            }
            continue;
          }
        }
      } catch {}

      // Monitoramento: recurso/apelação submetida (após "Retomar trabalho")
      try {
        const flags = await readAccountFlags(nome).catch(()=>({}));
        if (flags && flags.appealSubmitted === true) {
          // Garantia ultra enterprise: nunca manter Virtus rodando em appealSubmitted.
          try {
            if (ctrl) {
              ctrl.humanControl = true;
              ctrl.trabalhando = false;
              await stopVirtus(nome).catch(()=>{});
              // overlay é o “painel de comando” do humano
              await ensureHumanOverlay(nome, ctrl, { reason: 'nurse_appeal_submitted_guard' }).catch(()=>{});
              await snapshotStatusAndWrite().catch(()=>{});
            }
          } catch {}
          const nextAt = Number(flags.appealNextCheckAt || 0) || 0;
          if (!nextAt || nextAt <= now) {
            // Só monitora se o navegador está aberto; senão, o nurse seguirá a regra normal de desired.active.
            if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'appeal_monitor_check', 'appeal_monitor_check');
              await appealMonitorCheckNow(nome, ctrl).catch(()=>null);
              await snapshotStatusAndWrite().catch(()=>{});
            }
          } else {
            await appendIssueNurseDebounced(nome, 'mil_action', 'appeal_monitor_waiting', 'appeal_monitor_waiting');
          }
          // Enquanto estiver em appealSubmitted, NÃO rodar automação normal (Robe/Virtus).
          continue;
        }
      } catch {}

      if (want.humanHold === true) {
        // Overlay deve aparecer e se manter (retry periódico com debounce).
        try {
          if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
            robeMeta[nome] = robeMeta[nome] || {};
            const last = Number(robeMeta[nome].overlayNurseLastAt || 0) || 0;
            if (!last || (now - last) > 45_000) {
              robeMeta[nome].overlayNurseLastAt = now;
              await syncHumanOverlay(nome).catch(()=>{});
            }
          }
        } catch {}
        await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_human_hold', 'nurse_skip_human_hold');
        continue;
      }

      {
        const rm = robeMeta[nome] || {};
        if (rm.emExecucao === true) {
          await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_robe_running', 'nurse_skip_robe_running');
          continue;
        }
      }

      if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) {
        continue;
      }
      if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'send_lock_skip', 'send_lock_skip');
        continue;
      }

      if (isFrozenNow(nome)) {
        if (ctrl) { await ensureFrozenShutdown(nome, 'nurse_guard'); }
        continue;
      }

      const hs = getHealth && getHealth(nome);
      if (hs && ['recover1','recover2','recover3'].includes(hs.stage)) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'health_recovery_in_progress_skip', 'health_recovery_in_progress_skip');
        continue;
      }

      if (want.active === true && !ctrl) {
        if (isFrozenNow(nome)) continue;

        if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > Date.now()) continue;
        if (robeMeta[nome]?.reopenAt && robeMeta[nome].reopenAt > Date.now()) continue;

        if (slotsInUse >= MAX_OPEN_CONCURRENCY) continue;
        slotsInUse++;
        try {
          await reportAction(nome, 'nurse_restart', 'desired ativo porém controller ausente — tentando ativar');
          try {
            const r = await activateOnce(nome, 'nurse_auto');
            if (!r || !r.ok) {
              const err = (r && r.error) || '';
              if (/ram_insuficiente_para_ativar|supervisor_denied:ram_low|supervisor_denied:slots|headroom_below_min_after_open/.test(err)) {
                await issues.append(nome, 'mil_action', 'open_denied_ram_swap_attempt err='+err);

                const swapped = await trySwapOpen(nome);

                if (!swapped) {
                  robeMeta[nome] = robeMeta[nome] || {};
                  // NOVO: Backoff fixo de 3s ao invés de escalonado (supervisor já controla velocidade)
                  const curBackoff = 3000;
                  robeMeta[nome].openBackoffMs = curBackoff;
                  robeMeta[nome].activationHeldUntil = Date.now() + curBackoff;
                  await issues.append(nome, 'mil_action', `open_backoff set to ${Math.floor(curBackoff/1000)}s (fixed)`);
                  logger.warn('[SWAP] open_backoff set', { nome, backoffMs: curBackoff, reason: err });
                } else {
                  logger.info('[SWAP] swap_open_success (nurse)', { target: nome });
                }
              }
            } else {
              // NOVO: Backoff fixo de 3s ao invés de 15s
              if (robeMeta[nome]) robeMeta[nome].openBackoffMs = 3000;
              logger.info('[NURSE] activateOnce ok', { nome });
            }
          } catch { }
        } finally {
          slotsInUse--;
        }
        await new Promise(r => setTimeout(r, OPEN_ACTIVATION_DELAY_MS));
        continue;
      }

      if (!ctrl || !ctrl.browser) continue;
      let pages = [];
      try { pages = await ctrl.browser.pages().catch(()=>[]); } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].noPagesStrikes = robeMeta[nome].noPagesStrikes || 0;
      robeMeta[nome].lastNoPagesAt = robeMeta[nome].lastNoPagesAt || 0;

      if (!pages || !pages[0]) {
        let retryFailed = false;
        if (ctrl.browser.isConnected?.()) {
          await new Promise(r=>setTimeout(r,400));
          let retryPages = [];
          try { retryPages = await ctrl.browser.pages(); } catch {}
          if (!retryPages || !retryPages[0]) retryFailed = true;
        } else {
          retryFailed = true;
        }
        if (retryFailed) {
          // Mesmo sem páginas, registre um snapshot leve quando a flag LR já está setada.
          // Isso cria o arquivo `login_required_events.jsonl` e prova "flag presa" sem depender do browser aberto.
          try {
            const flags = await readAccountFlags(nome).catch(()=>({}));
            if (flags && flags.loginRequired === true) {
              robeMeta[nome] = robeMeta[nome] || {};
              const now = Date.now();
              const last = Number(robeMeta[nome].lastLRFlagSnapshotNoPagesAt || 0) || 0;
              if (!last || (now - last) > (30 * 60 * 1000)) {
                robeMeta[nome].lastLRFlagSnapshotNoPagesAt = now;
                appendJsonl(LR_EVENTS_JSONL, {
                  ts: now,
                  host: os.hostname(),
                  perfil: nome,
                  event: 'lr_flag_snapshot_no_pages',
                  storedReason: flags.loginReason || null,
                  storedSource: flags.loginSource || null,
                  pagesCount: 0,
                  evidenceCaptured: false,
                  url: null,
                  title: null
                });
              }
            }
          } catch {}

          robeMeta[nome].noPagesStrikes += 1;
          robeMeta[nome].lastNoPagesAt = Date.now();
          await appendIssueNurseDebounced(nome, `suspect_no_pages`, `strike=${robeMeta[nome].noPagesStrikes}`, 'suspect_no_pages');
          if (robeMeta[nome].noPagesStrikes >= 2 && (Date.now() - robeMeta[nome].lastNoPagesAt) >= 5000) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_nopages`, `Strikes=${robeMeta[nome].noPagesStrikes}`, 'action_nurse_kill_nopages');
            await registerFailure(nome, 'no_pages', 'external');
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].noPagesStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].noPagesStrikes = 0;
      }

      const p0 = pages[0];
      try {
        // Se a flag LR já está setada (persistida), capture evidência do estado atual
        // para provar se é falso positivo (ex.: já está logado mas flag ficou presa).
        try {
          const flags = await readAccountFlags(nome).catch(()=>({}));
          if (flags && flags.loginRequired === true) {
            const captured = await captureLoginRequiredEvidence(nome, p0, { reason: 'flag_snapshot' });
            if (captured) {
              let urlNow = null, titleNow = null;
              try { urlNow = (typeof p0.url === 'function') ? (p0.url() || null) : null; } catch {}
              try { titleNow = (typeof p0.title === 'function') ? (await p0.title().catch(()=>null)) : null; } catch {}
              appendJsonl(LR_EVENTS_JSONL, {
                ts: Date.now(),
                host: os.hostname(),
                perfil: nome,
                event: 'lr_flag_snapshot',
                storedReason: flags.loginReason || null,
                storedSource: flags.loginSource || null,
                url: urlNow,
                title: titleNow
              });
            }
          }
        } catch {}

        // === Enterprise: detectar loginRequired em QUALQUER aba (não só pages[0]) ===
        // Prioridade de motivos (mais grave primeiro)
        const reasonPriority = (r) => {
          const s = String(r || '').toLowerCase();
          if (s.includes('identity')) return 5;
          if (s.includes('captcha')) return 4;
          if (s.includes('checkpoint')) return 3;
          if (s.includes('login_form')) return 2;
          return 1;
        };
        let lr = null;
        let lrPage = p0;
        try {
          const scan = [];
          for (const pg of (pages || []).slice(0, 8)) {
            let u = '';
            try { u = (typeof pg.url === 'function') ? (pg.url() || '') : ''; } catch {}
            // só avalia FB/Messenger
            if (!/(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(String(u || ''))) continue;
            const det = await browserHelper.detectLoginRequired(pg).catch(()=>null);
            if (det && typeof det === 'object') {
              scan.push({ u: String(u || '').slice(0, 120), lr: !!det.loginRequired, reason: det.reason || null, domain: det.domain || null });
              if (det.loginRequired) {
                if (!lr || reasonPriority(det.reason) > reasonPriority(lr.reason)) {
                  lr = det;
                  lrPage = pg;
                }
              }
            }
          }
          // Log leve: scan (para auditoria e ajuste fino)
          try {
            const fs = require('fs');
            const path = require('path');
            const fp = path.join(__dirname, '..', 'dados', 'login_required_events.jsonl');
            fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), host: os.hostname(), perfil: nome, event: 'lr_scan_tabs', pages: scan }) + '\n');
          } catch {}
        } catch {}

        if (lr && lr.loginRequired) {
          try {
            const prev = await readAccountFlags(nome).catch(()=>({}));
            const prevLR = !!(prev && prev.loginRequired === true);
            const prevReason = prev && typeof prev.loginReason === 'string' ? prev.loginReason : '';
            const prevSource = prev && typeof prev.loginSource === 'string' ? prev.loginSource : '';
            const curReason = String(lr.reason || '');
            const curSource = String(lr.domain || '');
            const changed = !(prevLR && (String(prevReason) === curReason) && (String(prevSource) === curSource));
            const captured = await captureLoginRequiredEvidence(nome, lrPage || p0, lr);
            if (captured || changed) {
              appendJsonl(LR_EVENTS_JSONL, {
                ts: Date.now(),
                host: os.hostname(),
                perfil: nome,
                event: 'lr_detected',
                reason: curReason,
                source: curSource,
                url: lr.url || null,
                title: lr.title || null,
                evidence: lr.evidence || null
              });
            }

            // GPT fallback (central): envia evidência redacted para o sitechatbot classificar e registrar padrões.
            // Guardrails:
            // - só envia se LOG_INGEST_SECRET estiver configurado (segurança)
            // - rate-limit 30min por perfil+reason (no cliente e também no servidor central)
            try {
              // Evita custo se não houver chance real de envio
              if (String(process.env.LOG_INGEST_SECRET || '').trim()) {
                robeMeta[nome] = robeMeta[nome] || {};
                const now = Date.now();
                const last = Number(robeMeta[nome].lastFbGptIngestAt || 0) || 0;
                if (!last || (now - last) > (30 * 60 * 1000)) {
                  // Para reduzir custo: envia só quando capturou evidência ou houve mudança no motivo
                  if (captured || changed) {
                    const html = await (lrPage || p0).content().catch(()=>null);
                    await gptFallback.ingestFbGpt({
                      perfil: nome,
                      url: lr.url || null,
                      title: lr.title || null,
                      html: html || '',
                      reason: curReason || null,
                      source: `lr:${curSource || 'unknown'}`
                    }).catch(()=>{});
                    robeMeta[nome].lastFbGptIngestAt = now;
                  }
                }
              }
            } catch {}

            // Se for "Confirme sua identidade" (selfie/vídeo), NÃO tentar resolver automaticamente.
            // Ação enterprise: travar automação e pedir humano (humanHold).
            try {
              if (String(curReason || '').toLowerCase().includes('identity')) {
                try { await issues.append(nome, 'mil_action', `identity_required_hold reason=${curReason}`); } catch {}
                try { ctrl.humanControl = true; ctrl.trabalhando = false; } catch {}
                try { await stopVirtus(nome); } catch {}
                try {
                  await fileStore.withDesiredFileLockUpdate((desired) => {
                    desired.perfis = desired.perfis || {};
                    desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: true, virtus: 'off', active: true };
                    return desired;
                  });
                } catch {}
              }
            } catch {}
          } catch {}
          // 2FA => exclusão automática (não é humano, não é automação)
          try {
            const rr0 = String(lr && lr.reason || '').toLowerCase();
            if (rr0.includes('two_factor') || rr0.includes('2fa') || rr0.includes('two factor')) {
              try { await issues.append(nome, 'mil_action', `two_factor_detected_autodelete reason=${rr0}`); } catch {}
              try { await setTwoFactorFlag(nome, { reason: rr0 || 'two_factor', snippet: String(lr && lr.title || '') }); } catch {}
              // Perfil pode ter sido deletado; sair do fluxo atual.
              return;
            }
          } catch {}
          await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' });

          // Enterprise autopilot:
          // - login_form => tentar auto-remediação (cookies -> login/senha) com mínimo impacto (1 por vez)
          // - captcha/checkpoint => segurar em humanHold (não existe automação confiável)
          try {
            const rr = String(lr && lr.reason || '').toLowerCase();
            if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
              try { await issues.append(nome, 'mil_action', `appeal_submitted_hold reason=${rr}`); } catch {}
              try {
                await setAppealSubmittedFlag(nome, {
                  source: lr.domain || '',
                  url: lr.url || '',
                  title: lr.title || ''
                });
              } catch {}
            } else if (rr.includes('captcha') || rr.includes('checkpoint')) {
              try { await issues.append(nome, 'mil_action', `login_requires_human_hold reason=${rr}`); } catch {}
              try { ctrl.humanControl = true; ctrl.trabalhando = false; } catch {}
              try { await stopVirtus(nome); } catch {}
              try {
                await fileStore.withDesiredFileLockUpdate((desired) => {
                  desired.perfis = desired.perfis || {};
                  desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: true, virtus: 'off', active: true };
                  return desired;
                });
              } catch {}
            } else if (rr.includes('login_form')) {
              // Blindagem anti-loop: se já falhou e foi marcado, não re-tenta automaticamente.
              try {
                const flags = await readAccountFlags(nome).catch(()=>({}));
                if (flags && flags.loginRemediateFailed === true) {
                  try { await issues.append(nome, 'mil_action', 'auto_login_remediate_skip(loginRemediateFailed=true)'); } catch {}
                } else {
                  const okQueue = queueAutoLoginRemediate(nome, { reason: lr.reason || '', source: lr.domain || '', immediate: true });
                  if (okQueue) {
                    try { await issues.append(nome, 'mil_action', `auto_login_remediate_queued reason=${String(lr.reason||'').slice(0,80)}`); } catch {}
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
      try {
        const bd = await browserHelper.detectAccountSuspended(p0);
        if (bd && bd.banned) {
          await setBannedFlag(nome, { reason: bd.reason || '', snippet: bd.snippet || '' });
        }
      } catch {}

      // Curador enterprise: PIN do Messenger / "Continuar sem restaurar?"
      try {
        // Só tenta curar quando NÃO está configurando e não está com Robe executando (evita interferir no fluxo de postagem)
        if (ctrl && !ctrl.configurando && !(robeMeta[nome] && robeMeta[nome].emExecucao === true) && ctrl.browser && typeof ctrl.browser.pages === 'function') {
          robeMeta[nome] = robeMeta[nome] || {};
          const nowp = Date.now();
          const lastScan = Number(robeMeta[nome].lastPinScanAt || 0) || 0;
          if (!lastScan || (nowp - lastScan) > 8000) {
            robeMeta[nome].lastPinScanAt = nowp;
            let pagesAll = [];
            try { pagesAll = await ctrl.browser.pages(); } catch { pagesAll = []; }

            // log curto: sempre registra scan (cria messenger_pin.jsonl para auditoria via fetch_logs)
            let scan = [];
            let anyPresent = false;
            let firstMatch = null;
            for (const pg of pagesAll.slice(0, 8)) {
              let urlNow = '';
              try { urlNow = (typeof pg.url === 'function') ? (pg.url() || '') : ''; } catch {}
              const detPin = await browserHelper.detectMessengerPinModal(pg).catch(()=>({ present:false }));
              scan.push({ u: String(urlNow || '').slice(0, 140), p: !!detPin.present, k: detPin.kind || null });
              if (detPin && detPin.present && !firstMatch) firstMatch = { pg, det: detPin, urlNow };
              if (detPin && detPin.present) anyPresent = true;
            }
            try {
              const fsSync2 = require('fs');
              const path2 = require('path');
              const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
              fsSync2.appendFileSync(p, JSON.stringify({ ts: nowp, src:'worker.js', perfil:nome, event:'scan', pages: scan }) + '\n');
            } catch {}

            if (firstMatch) {
              try { await issues.append(nome, 'mil_action', `messenger_pin_seen kind=${firstMatch.det.kind||''}`); } catch {}
              await browserHelper.tryDismissMessengerPinModal(firstMatch.pg, { logPrefix: '[NURSE][PIN]', maxTries: 6 }).catch(()=>null);
              const still = await browserHelper.detectMessengerPinModal(firstMatch.pg).catch(()=>({ present:false }));
              if (still && still.present) {
                // fallback GPT (central) para sugerir clique seguro dentro do modal (selectorHints)
                try {
                  if (browserHelper && typeof browserHelper.gptRemediateFbUi === 'function') {
                    await browserHelper.gptRemediateFbUi(firstMatch.pg, nome, { reason: 'messenger_pin_modal', stage: 'nurse_pin_try_1' }).catch(()=>null);
                    await browserHelper.tryDismissMessengerPinModal(firstMatch.pg, { logPrefix: '[NURSE][PIN][postgpt]', maxTries: 4 }).catch(()=>null);
                  }
                } catch {}
                const still2 = await browserHelper.detectMessengerPinModal(firstMatch.pg).catch(()=>({ present:false }));
                if (still2 && still2.present) {
                  try {
                    const fsSync2 = require('fs');
                    const path2 = require('path');
                    const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
                    fsSync2.appendFileSync(p, JSON.stringify({ ts: Date.now(), src:'worker.js', perfil:nome, event:'gpt_failed_or_insufficient', kind: still2.kind||null }) + '\n');
                  } catch {}
                }
                await setMessengerPinFlag(nome, { reason: still.kind || 'messenger_pin_modal', source: 'nurse' });
                try {
                  const fsSync2 = require('fs');
                  const path2 = require('path');
                  const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
                  fsSync2.appendFileSync(p, JSON.stringify({ ts: Date.now(), src:'worker.js', perfil:nome, event:'pin_still_present', kind: still.kind||null, url: String(firstMatch.urlNow||'').slice(0, 220) }) + '\n');
                } catch {}
              } else {
                await clearAccountFlags(nome, ['messengerPin']).catch(()=>{});
                try {
                  const fsSync2 = require('fs');
                  const path2 = require('path');
                  const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
                  fsSync2.appendFileSync(p, JSON.stringify({ ts: Date.now(), src:'worker.js', perfil:nome, event:'pin_cleared', url: String(firstMatch.urlNow||'').slice(0, 220) }) + '\n');
                } catch {}
              }
            } else if (!anyPresent) {
              // se não há PIN em nenhuma aba, limpa flag (se existir)
              await clearAccountFlags(nome, ['messengerPin']).catch(()=>{});
            }
          }
        }
      } catch {}
      let det = { blocked:false };
      try {
        const urlNow = (typeof p0.url === 'function') ? (p0.url() || '') : '';
        const isMessenger = /messenger.com/i.test(urlNow);
        const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const isCreateOrSellerRoute =
          /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

        if (isMessenger) {
          det = await browserHelper.detectMessengerTempBlock(p0);
          det.domain = 'messenger';
        } else if (robeRunning || isCreateOrSellerRoute) {
          const deep = await detectLimitOverlayDeep(p0, { alsoCheckFrames: true }).catch(()=>null);
          if (deep && deep.blocked) {
            det = { blocked: true, domain: 'facebook' };
          } else {
            det = await browserHelper.detectMessengerTempBlock(p0);
            det.domain = det.domain || 'facebook';
          }
        }
      } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow || [];
      let now2 = Date.now();

      if (det && det.blocked && det.domain === 'messenger') {
        robeMeta[nome].blockDetectWindow.push(now2);
        robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow.filter(ts => now2 - ts <= 5000);
        while (robeMeta[nome].blockDetectWindow.length > 8) robeMeta[nome].blockDetectWindow.shift();

        if (robeMeta[nome].blockDetectWindow.length >= 2 && (!robeMeta[nome].blockHysteresisUntil || robeMeta[nome].blockHysteresisUntil < now2)) {
          await appendIssueNurseDebounced(nome, `action_virtus_block`, `blockDetectWindow=${robeMeta[nome].blockDetectWindow.length}`, 'action_virtus_block');
          robeMeta[nome].blockHysteresisUntil = now2 + 15*60*1000;
          if (killGuardActive(nome)) {
            await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)', 'guard_skip_block');
            continue;
          }
          await stopVirtus(nome);
          if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now2)) {
            robeMeta[nome].reopenAt = now2 + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
            robeMeta[nome].closingReason = 'virtus_block';
          }
          await registerFailure(nome, 'messenger_temp_block', 'external');
          await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
          setKillGuard(nome);
          await snapshotStatusAndWrite();
          continue;
        } else {
          await appendIssueNurseDebounced(nome, `suspect_messenger_block`, `strike=${robeMeta[nome].blockDetectWindow.length}`, 'suspect_messenger_block');
          continue;
        }
      }
      if (robeMeta[nome].blockHysteresisUntil && robeMeta[nome].blockHysteresisUntil > now2) continue;

      if (det && det.blocked && det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      let anyFbBlocked = false;
      try {
        if (robeMeta[nome] && robeMeta[nome].emExecucao === true && ctrl && ctrl.browser) {
          anyFbBlocked = await detectFbLimitInAnyPage(ctrl);
        }
      } catch {}
      if (anyFbBlocked) {
        try { await issues.append(nome, 'block_detected', 'domain=facebook multi-page=true'); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      const hs2 = getHealth && getHealth(nome);
      if (hs2 && (hs2.stage === 'recover1' || hs2.stage === 'recover2' || hs2.stage === 'recover3')) {
        continue;
      }

      let healthy = await pageReadyBasic(p0);
      if (!healthy) {
        if (robeMeta[nome].recoveryHysteresisUntil && robeMeta[nome].recoveryHysteresisUntil > Date.now()) {
          await appendIssueNurseDebounced(nome, 'hysteresis_skip', 'Aguardando histerese pós-recover', 'hysteresis_skip_after_recover');
          continue;
        }

        robeMeta[nome] = robeMeta[nome] || {};
        const nowReload = Date.now();
        if (!robeMeta[nome].reloadAttemptsWindow) robeMeta[nome].reloadAttemptsWindow = [];
        robeMeta[nome].reloadAttemptsWindow = robeMeta[nome].reloadAttemptsWindow.filter(ts => nowReload - ts < 60000);

        robeMeta[nome].reloadAttemptsWindow.push(nowReload);
        while (robeMeta[nome].reloadAttemptsWindow.length > 8) robeMeta[nome].reloadAttemptsWindow.shift();

        if (robeMeta[nome].reloadAttemptsWindow.length > 3) {
          robeMeta[nome].reloadBlockedUntil = nowReload+60000;
          await reportAction(nome, 'mil_action', 
            `nurse_reload_blocked: Excesso de reloads (${robeMeta[nome].reloadAttemptsWindow.length}) em 60s, url=${((p0.url&&p0.url())||'')}`
          );
          continue;
        }
        if (robeMeta[nome].reloadBlockedUntil && robeMeta[nome].reloadBlockedUntil > nowReload) {
          continue;
        }

        healthy = await tryReloadShort(p0, nome, 1);
        if (!healthy) {
          healthy = await tryReloadShort(p0, nome, 2);
        }
        if (healthy) {
          await reportAction(nome, 'mil_action', 'nurse_recover_success(reload)');
          robeMeta[nome].recoveryHysteresisUntil = Date.now() + 90000;
        } else {
          robeMeta[nome].zombieStrikes = robeMeta[nome].zombieStrikes || 0;
          robeMeta[nome].zombieStrikes += 1;
          await appendIssueNurseDebounced(nome, `suspect_page_zombie`, `strike=${robeMeta[nome].zombieStrikes}`, 'suspect_page_zombie');
          if (robeMeta[nome].zombieStrikes >= 2) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until', 'guard_skip_page_zombie');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_page_zombie`, `Strike=${robeMeta[nome].zombieStrikes}`, 'action_nurse_kill_page_zombie');
            try { registerFailure(nome, 'zombie', 'external'); } catch {}
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].zombieStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].zombieStrikes = 0;
      }

      try {
        const url = p0.url ? p0.url() : '';
        if (/messenger\.com\/.*marketplace/i.test(url) && !ctrl.configurando && !(robeMeta[nome] && robeMeta[nome].emExecucao)) {
          const ph = getPhantomState(nome);
          const snap = await evaluateChatsState(p0);
          if (isOkFromSnapshot(snap)) {
            ph.lastOkAt = Date.now(); ph.firstSeenAt = 0;
          } else {
            const now = Date.now();
            if (isPhantomFromSnapshot(snap)) {
              if (!ph.firstSeenAt) ph.firstSeenAt = now;
              const elapsed = now - ph.firstSeenAt;
              const sinceOk = ph.lastOkAt ? (now - ph.lastOkAt) : Infinity;
              if (elapsed > PHANTOM_CFG.PERSIST_MS && sinceOk > PHANTOM_CFG.INITIAL_GRACE_MS) {
                await issues.append(nome, 'mil_action',
                  `phantom_detected rows=${snap.rows} anchors=${snap.anchors} sk=${snap.skeletons} elapsed=${elapsed}ms`);
                await tryFixPhantom(nome, p0);
              }
            } else if (snap.skeletons === 0) {
              ph.firstSeenAt = 0;
            }
          }
        }
      } catch {}

      if (ctrl && ctrl.configurando) {
        logger.info('[NURSE][SKIP PRUNE] Perfil em configuração, prune ignorado', { nome });
        continue;
      }
      if (!(robeMeta[nome] && robeMeta[nome].emExecucao)) {
        try { await closeExtraPages(ctrl.browser, p0, nome).catch(()=>{}); } catch {}
      }
      if (want.virtus === 'on' && automationAllowed(ctrl)) {
        // Se o governor mudou de modo, reinicia o runner do Virtus para aplicar slowMode sem derrubar browser/sessão.
        try {
          const curMode = (autoMode && autoMode.mode) ? autoMode.mode : 'full';
          const prevMode = ctrl._virtusGovernorMode || null;
          if (ctrl.virtus && prevMode && prevMode !== curMode) {
            await appendIssueNurseDebounced(nome, 'mil_action', `virtus_restart_due_governor prev=${prevMode} cur=${curMode}`, 'virtus_restart_due_governor');
            try { await stopVirtus(nome); } catch {}
          }
        } catch {}
        try { 
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' }); 
          ctrl._virtusGovernorMode = (autoMode && autoMode.mode) ? autoMode.mode : 'full';
          ctrl.trabalhando = true; 
        } catch {}
      }
    }
  } finally {
    _nurseTickRunning = false;
  }
}

async function trySwapOpen(target) {
  // Ultra enterprise: nunca executar swap agressivo durante provisionamento.
  // O provisionamento tem seu próprio fluxo de liberação mínima de RAM (dashboard hardRecoverRam)
  // e o supervisor já bloqueia aberturas de terceiros via maintenance_provision.
  try { if (provisionLock.isActive()) return false; } catch {}

  const aliveNames = Array.from(controllers.keys());
  if (aliveNames.length <= 1) return false;

  const free0 = getAvailableMB();
  const minNeed = getOpenMinFreeMB(''); // operação normal (sem owner do lock)
  const deficit = Math.max(0, (Number(minNeed || 0) || 0) - (Number(free0 || 0) || 0));
  // Se não há déficit de RAM, não fazer swap. (Evita fechar dezenas por erro de slots/transiente)
  if (deficit <= 0) return false;

  // Cap militar: nunca fechar muitos perfis numa única tentativa.
  const MAX_SWAP_KILLS = Math.max(0, parseInt(process.env.SWAP_OPEN_MAX_KILLS || '2', 10) || 2);
  let closed = 0;
  let freedEstimate = 0;

  const candidates = aliveNames
    .filter(n => n !== target)
    .map(n => ({
      n,
      mb: (typeof robeMeta[n]?.ramMB === 'number') ? robeMeta[n].ramMB : -1,
      emExecucao: robeMeta[n]?.emExecucao,
      configurando: controllers.get(n)?.configurando,
      humanControl: controllers.get(n)?.humanControl
    }))
    .filter(c => !c.configurando && !c.emExecucao && !c.humanControl && c.mb >= (process.platform==='win32' ? 900 : 700))
    .sort((a, b) => b.mb - a.mb);

  for (const cand of candidates) {
    if (closed >= MAX_SWAP_KILLS) break;
    if (freedEstimate >= (deficit + 128)) break; // margem pequena p/ evitar “apertado”
    if (killGuardActive(cand.n)) continue;
    await issues.append(cand.n, 'mil_action', `swap_kill fechamento para abrir ${target} RAM=${cand.mb}MB`);
    logger.info('[SWAP] swap_kill', { fechar: cand.n, abrir: target, ramMB: cand.mb });
    await handlers.deactivate({ nome: cand.n, reason: 'swap_for_open', policy: 'preserveDesired' });
    setKillGuard(cand.n, 45000);
    await new Promise(r=>setTimeout(r, 2000));
    closed++;
    freedEstimate += Math.max(0, Number(cand.mb || 0) || 0);
  }

  if (closed <= 0) return false;

  // Tenta abrir uma única vez após liberar o mínimo necessário.
  const r = await activateOnce(target, 'nurse_swap');
  if (r && r.ok) {
    await issues.append(target, 'mil_action', `swap_open_success closed=${closed} deficit=${deficit}MB`);
    robeMeta[target] = robeMeta[target] || {};
    robeMeta[target].lastSwapAt = Date.now();
    logger.info('[SWAP] swap_open_success', { target, closed, deficitMB: deficit });
    return true;
  }
  await issues.append(target, 'mil_action', `swap_open_failed closed=${closed} deficit=${deficit}MB err=${(r && r.error) || ''}`);
  logger.warn('[SWAP] swap_open_failed', { target, closed, deficitMB: deficit, err: (r && r.error) || '' });
  return false;
}

setInterval(() => { nurseTick().catch(()=>{}); }, NURSE_CFG.INTERVAL_MS);
setTimeout(() => { nurseTick().catch(()=>{}); }, 2000);
// Autopilot login_remediate: roda em paralelo ao nurseTick, mas com guardrails (1 por vez + skip se provision_lock ativo)
setInterval(() => { autoLoginRemediateTick().catch(()=>{}); }, AUTO_LR_CFG.tickMs);
setTimeout(() => { autoLoginRemediateTick().catch(()=>{}); }, 3500);

// Inicializa reloadManager após todos os sistemas estarem prontos
reloadManager.startReloadManager(controllers, robeMeta);

async function wirePageObservers(nome, page) {
  const st = getHealth(nome);
  try {
    page.removeAllListeners && page.removeAllListeners('domcontentloaded');
    page.removeAllListeners && page.removeAllListeners('framenavigated');
    page.removeAllListeners && page.removeAllListeners('requestfinished');
    page.removeAllListeners && page.removeAllListeners('requestfailed');
    page.removeAllListeners && page.removeAllListeners('console');
    page.removeAllListeners && page.removeAllListeners('pageerror');
  } catch {}
  page.on('domcontentloaded', async () => {
    const st = getHealth(nome);
    st.lastDomEventAt = Date.now();
    try { st.lastTitle = await page.title().catch(()=>st.lastTitle); } catch {}
    try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
  });
  page.on('framenavigated', (frame) => {
    const st = getHealth(nome);
    if (frame === page.mainFrame()) {
      st.lastDomEventAt = Date.now();
      try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
    }
  });
  page.on('requestfinished', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('requestfailed', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('console', (msg) => { if (msg && msg.type && msg.type() === 'error') getHealth(nome).lastConsoleErrorAt = Date.now(); });
  page.on('pageerror', () => { getHealth(nome).lastConsoleErrorAt = Date.now(); });
}

async function isPageLikelyAlive(page, nome) {
  const st = getHealth(nome);
  const now = Date.now();
  const noDom = (now - st.lastDomEventAt) > HEALTH_CFG.DEAD_NO_DOM_MS;
  const noNet = (now - st.lastNetEventAt) > HEALTH_CFG.DEAD_NO_NET_MS;
  let readyOk = false, url = '';
  try {
    const rs = await Promise.race([
      page.evaluate(()=>document.readyState).catch(()=> 'err'),
      new Promise(res=>setTimeout(()=>res('timeout'), 1200))
    ]);
    readyOk = (rs === 'interactive' || rs === 'complete');
    url = page.url ? page.url() : '';
  } catch {}
  const aboutBlankStuck = (url === 'about:blank') && ((now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS);
  const urlIsFb = /facebook\.com|messenger\.com/i.test(url);
  const aliveBySignals = (!noDom || !noNet);
  const aliveByReady = (readyOk && urlIsFb && !aboutBlankStuck);
  return aliveBySignals || aliveByReady;
}

async function recoveryStep(nome, page, step) {
  const st = getHealth(nome);
  const now = Date.now();
  if (st.nextTryAt && st.nextTryAt > now) return false;
  if (step === 'reload') {
    st.counters.softReloads10m = _pruneWindow(st.counters.softReloads10m, 10*60*1000);
    if (st.counters.softReloads10m.length >= HEALTH_CFG.MAX_SOFT_RELOADS_10MIN) return false;
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); } catch {}
    st.counters.softReloads10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.reload;
    try { await issues.append(nome, 'mil_action', 'health_recover:reload'); } catch {}
    return true;
  }
  if (step === 'navHome') {
    st.counters.navHomes10m = _pruneWindow(st.counters.navHomes10m, 10*60*1000);
    if (st.counters.navHomes10m.length >= HEALTH_CFG.MAX_NAVHOME_10MIN) return false;
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); } catch {}
    st.counters.navHomes10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.navHome;
    try { await issues.append(nome, 'mil_action', 'health_recover:navHome'); } catch {}
    return true;
  }
  if (step === 'newPage') {
    if (st.newPageInFlight) return false;
    if (st.lastNewPageAt && (now - st.lastNewPageAt) < 90000) return false;
    st.counters.newPages30m = _pruneWindow(st.counters.newPages30m, 30*60*1000);
    if (st.counters.newPages30m.length >= HEALTH_CFG.MAX_NEWPAGE_30MIN) return false;
    st.newPageInFlight = true;
    try {
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser) return false;
      const np = await ctrl.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(() => null);
        await browserHelper.patchPage(nome, np, utils.getCoords((man && man.cidade) || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl.mainPage = np;
      await wirePageObservers(nome, np);
      st.counters.newPages30m.push(Date.now());
      st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.newPage;
      st.lastNewPageAt = now;
      try { await issues.append(nome, 'mil_action', 'health_recover:newPage'); } catch {}
      return true;
    } finally {
      st.newPageInFlight = false;
    }
  }
  return false;
}
async function escalateToReopen(nome, reason='health_reopen') {
  const ctrl = controllers.get(nome);
  try { await issues.append(nome, 'mil_action', `health_escalate:${reason}`); } catch {}
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return;
  }
  await handlers.deactivate({ nome, reason, policy: 'preserveDesired' });
  setKillGuard(nome);
  const st = getHealth(nome);
  st.stage = 'reopen';
  st.nextTryAt = Date.now() + 60000;
}

async function healthTick() {
  if (controllers.size === 0) { return; }
  for (const [nome, ctrl] of controllers) {
    if (robeMeta[nome] && robeMeta[nome].emExecucao === true) continue;
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) continue;

    if (!ctrl || !ctrl.browser) continue;
    if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
      continue;
    }
    const st = getHealth(nome);
    const now = Date.now();
    let pages = [];
    try { pages = await ctrl.browser.pages(); } catch {}
    if (!pages || !pages[0]) continue;
    const page = pages[0];
    if (page && ctrl.mainPage !== page) {
      ctrl.mainPage = page;
      await wirePageObservers(nome, page);
    }

    let det = { blocked:false };
    try {
      const urlNow = (typeof page.url === 'function') ? (page.url() || '') : '';
      const isMessenger = /messenger.com/i.test(urlNow);
      const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
      const isCreateOrSellerRoute =
        /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

      if (isMessenger) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = 'messenger';
      } else if (robeRunning || isCreateOrSellerRoute) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = det.domain || 'facebook';
      }
    } catch {}
    if (det && det.blocked) {
      if (det.domain === 'messenger') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        try { await stopVirtus(nome); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        const jitterMs = (5 + Math.floor(Math.random() * 21)) * 60 * 1000;
        if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > Date.now())) {
          robeMeta[nome].reopenAt = Date.now() + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + jitterMs;
          robeMeta[nome].closingReason = 'virtus_block';
        }
        try { registerFailure(nome, 'messenger_temp_block', 'external'); } catch {}
        if (killGuardActive(nome)) {
          await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)');
          continue;
        }
        await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
        setKillGuard(nome);
        await snapshotStatusAndWrite();
        continue;
      }
      if (det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const now = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man0 = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man0 && man0.robeCooldownUntil ? (man0.robeCooldownUntil - now) : 0;
          if (!man0 || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = now + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'health_detect_facebook_block_preserve_reason=limit_posting');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }
    }

    if (isFrozenNow(nome)) continue;
    const alive = await isPageLikelyAlive(page, nome);
    if (alive) {
      st.lastOkAt = now;
      st.stage = 'ok';
      st.counters.cyclesWithoutLife = 0;
      continue;
    }
    const noEventsFor = Math.max(now - st.lastDomEventAt, now - st.lastNetEventAt);
    if (noEventsFor > HEALTH_CFG.DEAD_NO_EVENT_MS) {
      st.counters.cyclesWithoutLife++;
      if (st.stage === 'ok') st.stage = 'suspect';
    }
    try {
      const url = page.url ? page.url() : '';
      if (url === 'about:blank' && (now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS) {
        if (await recoveryStep(nome, page, 'navHome')) continue;
      }
    } catch {}
    if (st.stage === 'suspect') {
      if (await recoveryStep(nome, page, 'reload')) { st.stage = 'recover1'; continue; }
      st.stage = 'recover1';
    } else if (st.stage === 'recover1') {
      if (await recoveryStep(nome, page, 'navHome')) { st.stage = 'recover2'; continue; }
      st.stage = 'recover2';
    } else if (st.stage === 'recover2') {
      if (await recoveryStep(nome, page, 'newPage')) { st.stage = 'recover3'; continue; }
      st.stage = 'recover3';
    } else if (st.stage === 'recover3') {
      if (st.counters.cyclesWithoutLife >= HEALTH_CFG.ESCALATE_TO_REOPEN_AFTER) {
        await escalateToReopen(nome, 'health_no_progress');
      }
    }
  }
}
setInterval(() => { healthTick().catch(()=>{}); }, HEALTH_CFG.TICK_MS);
setTimeout(() => { healthTick().catch(()=>{}); }, 2500);

// ====== LIMPEZA PERIÓDICA DE ABAS ABOUT:BLANK ÓRFÃS ======
// Varre todos os navegadores ativos e fecha abas about:blank que estão órfãs
// (criadas mas abandonadas quando Robe aborta/abandona postagem)
// Roda a cada 3 minutos - não agressivo, apenas limpa o que ficou esquecido
async function periodicAboutBlankCleanup() {
  try {
    const issues = require('./issues.js');
    let totalClosed = 0;

    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) continue;

        // Proteções: não limpa se Robe está ativo, configurando, ou em modo humano
        const inRobe = (ctrl.browser._robeActiveFor === nome) || (robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const sendLockActive = ctrl.browser._sendLock && ctrl.browser._sendLock.active;
        const inConfig = ctrl.configurando === true;
        const inHuman = ctrl.humanControl === true;

        if (inRobe || sendLockActive || inConfig || inHuman) continue;

        // Varre todas as páginas procurando about:blank órfãs
        const pages = await ctrl.browser.pages().catch(() => []);
        if (!Array.isArray(pages) || pages.length <= 1) continue;

        const mainPage = ctrl.mainPage || pages[0];
        
        // Proteção extra: verifica se há create item aberto (só verifica uma vez)
        const hasCreateItem = pages.some(pg => {
          try {
            const u = pg.url ? pg.url() : '';
            return /facebook\.com\/marketplace\/create\/item/i.test(u);
          } catch { return false; }
        });
        
        // Se há create item, não limpa (pode ser que o Robe esteja prestes a usar)
        if (hasCreateItem) continue;

        let closed = 0;

        for (const p of pages) {
          try {
            // Nunca fecha a página principal
            if (p === mainPage) continue;
            if (!mainPage && p === pages[0]) continue;

            // Verifica se é about:blank
            let url = '';
            try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
            if (!url || url !== 'about:blank') continue;

            // Fecha a aba about:blank órfã
            // (já verificamos que não há Robe ativo e não há create item)
            await p.close({ runBeforeUnload: false }).catch(() => {});
            closed++;
          } catch {}
        }

        if (closed > 0) {
          totalClosed += closed;
          try {
            await issues.append(nome, 'mil_action', `periodic_cleanup_aboutblank n=${closed}`);
          } catch {}
        }
      } catch (e) {
        if (process.env.PRUNE_DEBUG === '1') {
          logger.warn('[PERIODIC_CLEANUP] Erro em perfil', { nome, error: e && e.message || e });
        }
      }
    }

    if (totalClosed > 0) {
      logger.info('[PERIODIC_CLEANUP] Fechou abas about:blank órfãs', { total: totalClosed });
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PERIODIC_CLEANUP] Erro geral', { error: e && e.message || e });
    }
  }
}

// Roda a cada 3 minutos (180000ms) - não agressivo, apenas limpa o que ficou esquecido
setInterval(() => { periodicAboutBlankCleanup().catch(() => {}); }, 3 * 60 * 1000);
// Primeira execução após 30 segundos (dá tempo para sistema inicializar)
setTimeout(() => { periodicAboutBlankCleanup().catch(() => {}); }, 30000);

setInterval(() => {
  const now = Date.now();
  for (const nome of Object.keys(robeMeta)) {
    if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > now && (robeMeta[nome].frozenUntil - now > 6 * 3600 * 1000)) {
      issues.append(nome, 'frozen_watchdog', 'Perfil congelado > 6h');
    }
    const desired = readJsonFile(desiredPath, { perfis: {} });
    if (desired.perfis?.[nome]?.active === true && !controllers.has(nome)) {
      issues.append(nome, 'stuck_activation', 'Desired ativo sem browser por >10min');
    }
  }
}, 10 * 60 * 1000);

let _shuttingDown = false;
async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    logger.info('[WORKER] gracefulShutdown start', { reason });
    try { robeQueue.clear(); } catch {}
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          await ctrl.virtus.stop().catch(()=>{});
        }
      } catch {}
    }
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
          await ctrl.browser.close().catch(()=>{});
        }
      } catch {}
    }
    for (const nome of _pruners.keys()) stopPruneLoop(nome);
    if (ramMonitorInterval) try { clearTimeout(ramMonitorInterval); } catch{}
  } catch (e) {
    try { logger.error('[WORKER] gracefulShutdown exception', { reason, error: e && e.message || e }, e); } catch {}
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('disconnect', () => gracefulShutdown('disconnect'));

process.on('message', async (msg) => {
  if (!msg || !msg.type || !msg.msgId) return;
  const fn = handlers[msg.type];
  if (typeof fn !== 'function') {
    logger.warn('Comando desconhecido recebido', { type: msg.type, hasMsgId: !!msg.msgId });
    sendReply(msg.msgId, { ok: false, error: 'Comando desconhecido' });
    return;
  }
  try {
    const resp = await fn(msg.payload || {});
    sendReply(msg.msgId, resp);
  } catch (e) {
    logger.error('[WORKER][MESSAGE] handler error', { type: msg.type, error: e && e.message || e }, e);
    sendReply(msg.msgId, { ok: false, error: e && e.message || String(e) });
  }
});

process.on('uncaughtException', (e) => {
  try { logger.error('uncaught', { error: e && e.message || e }, e); } catch {}
}
);
process.on('unhandledRejection', (e) => {
  try { logger.error('unhandled', { error: (e && e.message) || e }, e); } catch {}
});