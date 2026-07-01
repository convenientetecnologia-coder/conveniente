// index.js (main do projeto, pasta principal)
const express = require('express');
const path = require('path');
const cors = require('cors');
// const bodyParser = require('body-parser'); // Não é necessário, pois estamos usando express.json/express.urlencoded
const open = require('open'); // <-- adicione/mova isso aqui!
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Inclua o logger imediatamente após os requires principais
const logger = require('./scripts/logger.js');
const {
  forensicLog,
  rotateForensicLogs24h,
  getActiveForensicLogPath,
} = require('./scripts/forensicLogger.js');

/**
 * =========================
 * BACKUP AUTO (enterprise)
 * =========================
 * Snapshot local e leve para rollback rápido (sem depender só de Git/Timeline).
 * - Default: habilitado
 * - Intervalo: CONVENIENTE_AUTO_BACKUP_INTERVAL_MIN (default 30)
 * - Retenção:  CONVENIENTE_AUTO_BACKUP_KEEP (default 96)
 */
function startAutoBackupConveniente() {
  try {
    if (String(process.env.CONVENIENTE_AUTO_BACKUP_DISABLE || '').trim() === '1') return;
    const intervalMin = Math.max(5, Math.min(720, Number(process.env.CONVENIENTE_AUTO_BACKUP_INTERVAL_MIN || 30) || 30));
    const keep = Math.max(10, Math.min(500, Number(process.env.CONVENIENTE_AUTO_BACKUP_KEEP || 96) || 96));

    const ROOT = __dirname;
    // P1 guardrail: não travar o processo principal com IO síncrono pesado.
    // O snapshot roda em processo separado (subprocess) e sai ao terminar.
    const { spawn } = require('child_process');
    const workerPath = path.join(ROOT, 'scripts', 'autoBackupWorker.js');

    const spawnSnapshot = () => {
      try {
        const child = spawn(process.execPath, [workerPath, '--root', ROOT, '--keep', String(keep)], {
          stdio: 'ignore',
          windowsHide: true,
          detached: true
        });
        try { child.unref(); } catch {}
      } catch {}
    };

    setTimeout(() => { try { spawnSnapshot(); } catch {} }, 2500);
    setInterval(() => { try { spawnSnapshot(); } catch {} }, intervalMin * 60 * 1000).unref?.();
  } catch {}
}

// Bootstrap opcional: instalar task/serviço no Windows
// IMPORTANTE: se estiver em modo bootstrap e CT_BOOTSTRAP_EXIT=1, o bootstrap pode encerrar o processo.
// Para não iniciar cluster/HTTP “à toa”, aguardamos o bootstrap antes do resto do boot.
async function maybeBootstrapService() {
  try {
    const bs = require('./scripts/bootstrapService.js');
    if (bs && typeof bs.boot === 'function') {
      await bs.boot();
    }
  } catch {}
}

// Bootstrap Gate B (token) — modo HTTP stateless (prepara push direto por subdomínios dinâmicos).
// Política operacional atual:
// - NÃO bloquear subida do cluster por falha de bootstrap.
// - Tentar em background de forma resiliente (retry ~1min) até obter bundle completo.
let __gateBRetryTimer = null;
let __gateBInFlight = false;
let __gateBCloudflaredStarted = false;
let __gateBCloudflaredChild = null;
let __gateBCloudflaredRestartTimer = null;
let __gateBCloudflaredLastExit = null;
let __gateBProvisioningPendingUntil = 0;
let __gateBLastForceRefreshAt = 0;
let __gateBLastForceRefreshReason = null;
let __gateBCredentialRefreshNeeded = false;
let __gateBCredentialRefreshReason = null;
let __gateBEdgeProbeTimer = null;
let __gateBEdgeProbeState = {
  consecutiveFailures: 0,
  lastStatus: null,
  lastError: null,
  lastOkAt: null,
  lastForceRefreshAt: null,
  outageSince: null,
  localRecoveryAttempts: 0,
  lastLocalRecoveryAt: null
};
let __gateBRuntime = {
  updatedAt: 0,
  hostId: null,
  bundle: null, // { present, hostFqdn, hasTunnelToken, hasInfraSecret, source, updatedAt }
  bootstrap: null, // { lastAttemptAt, lastOkAt, lastStatus, lastError, lastUrl }
  cloudflared: null // { started, startAt, exePath, spawnError, lastExit }
};

function __gateBRuntimePath() {
  return path.join(__dirname, 'dados', 'gate_b_runtime.json');
}

function __gateBCloudflaredLogPath() {
  return path.join(__dirname, 'dados', 'gate_b_cloudflared.log');
}

function __gateBWriteRuntimeAtomic(nextState) {
  try {
    const p = __gateBRuntimePath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(nextState || {}, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

function __gateBUpdateRuntime(patch) {
  try {
    const now = Date.now();
    const base = (__gateBRuntime && typeof __gateBRuntime === 'object') ? __gateBRuntime : {};
    const merged = { ...base, ...(patch && typeof patch === 'object' ? patch : {}) };
    merged.updatedAt = now;
    __gateBRuntime = merged;
    __gateBWriteRuntimeAtomic(merged);
  } catch {}
}

async function maybeBootstrapGateBToken() {
  const DATA_DIR = path.join(__dirname, 'dados');
  const HOSTID_PATH = path.join(DATA_DIR, '.telemetry_hostid');
  const BUNDLE_PATH = path.join(DATA_DIR, 'gate_b_bundle.json');
  // URL de bootstrap (pode ser sobrescrita por env).
  // Importante:
  // - NÃO depender de redirects 302 (POST pode virar GET automaticamente).
  // - Preferir subdomínio "api." pois não intercepta 503 em HTML ("Reconectando").
  const BOOTSTRAP_URL = String(
    process.env.CONVENIENTE_CT_BOOTSTRAP_URL ||
    process.env.CT_BOOTSTRAP_URL ||
    'https://api.convenientetecnologia.com/api/edge/bootstrap'
  ).trim();
  const BOOTSTRAP_SECRET = String(process.env.CONVENIENTE_BOOTSTRAP_SECRET || '').trim();
  const EDGE_PROBE_ENABLED = String(process.env.GATE_B_EDGE_PROBE_ENABLED || '1').trim() !== '0';
  const EDGE_PROBE_INTERVAL_MS = Math.max(15000, Number(process.env.GATE_B_EDGE_PROBE_INTERVAL_MS || 45000) || 45000);
  const EDGE_PROBE_FAIL_THRESHOLD = Math.max(2, Number(process.env.GATE_B_EDGE_PROBE_FAIL_THRESHOLD || 3) || 3);
  const EDGE_FORCE_REFRESH_COOLDOWN_MS = Math.max(60000, Number(process.env.GATE_B_FORCE_REFRESH_COOLDOWN_MS || 600000) || 600000);
  const EDGE_LOCAL_RECOVERY_COOLDOWN_MS = Math.max(15000, Number(process.env.GATE_B_EDGE_LOCAL_RECOVERY_COOLDOWN_MS || 120000) || 120000);
  const EDGE_LOCAL_RECOVERY_MAX_ATTEMPTS = Math.max(1, Number(process.env.GATE_B_EDGE_LOCAL_RECOVERY_MAX_ATTEMPTS || 3) || 3);
  const EDGE_FORCE_ON_PROLONGED_OUTAGE_MS = Math.max(120000, Number(process.env.GATE_B_EDGE_FORCE_ON_PROLONGED_OUTAGE_MS || 600000) || 600000);
  const FORCE_REFRESH_MIN_INTERVAL_MS = Math.max(120000, Number(process.env.GATE_B_FORCE_REFRESH_MIN_INTERVAL_MS || 1800000) || 1800000);
  const FORCE_REFRESH_BOOT_GRACE_MS = Math.max(0, Number(process.env.GATE_B_FORCE_REFRESH_BOOT_GRACE_MS || 30000) || 30000);
  const gateBBootAt = Date.now();

  const isTruthy = (v) => {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    return v === true || s === '1' || s === 'true' || s === 'yes';
  };

  const readHostId = () => {
    try {
      if (!fs.existsSync(HOSTID_PATH)) return '';
      return String(fs.readFileSync(HOSTID_PATH, 'utf8') || '').trim();
    } catch {
      return '';
    }
  };
  const getOrCreateHostId = () => {
    try {
      const existing = readHostId();
      if (existing) return existing;
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
      const id = (crypto && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(HOSTID_PATH, String(id) + '\n', 'utf8');
      return String(id);
    } catch {
      try { return crypto.randomBytes(16).toString('hex'); } catch { return String(Date.now()); }
    }
  };

  const readBundle = () => {
    try {
      if (!fs.existsSync(BUNDLE_PATH)) return null;
      const raw = String(fs.readFileSync(BUNDLE_PATH, 'utf8') || '').trim();
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const sanitizeBundleForCurrentHost = (bundle, currentHostId) => {
    try {
      const b = bundle && typeof bundle === 'object' ? bundle : null;
      if (!b) return null;
      const hostId = String(currentHostId || '').trim().toLowerCase();
      if (!hostId) return b;
      const hf = String(b.hostFqdn || '').trim().toLowerCase();
      if (!hf) return b;
      const expectedPrefix = `${hostId}.`;
      if (hf.startsWith(expectedPrefix)) return b;
      try {
        logger.warn('[GATE_B][BOOTSTRAP] bundle legado incompatível com host atual; descartando cache local', {
          hostId: currentHostId,
          bundleHostFqdn: b.hostFqdn
        });
      } catch {}
      return null;
    } catch {
      return null;
    }
  };

  const writeBundleAtomic = (bundle) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {}
    const tmp = `${BUNDLE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, BUNDLE_PATH);
  };

  const stopCloudflaredChild = () => {
    try {
      const child = __gateBCloudflaredChild;
      if (!child || child.exitCode != null) return false;
      try { child.kill('SIGTERM'); } catch {}
      __gateBCloudflaredChild = null;
      __gateBCloudflaredStarted = false;
      return true;
    } catch {
      return false;
    }
  };

  const readCloudflaredTail = (maxLines = 6) => {
    try {
      const p = __gateBCloudflaredLogPath();
      if (!fs.existsSync(p)) return [];
      const raw = String(fs.readFileSync(p, 'utf8') || '');
      const lines = raw.split(/\r?\n/).map((s) => String(s || '').trim()).filter(Boolean);
      return lines.slice(-Math.max(1, Number(maxLines || 6) || 6));
    } catch {
      return [];
    }
  };

  const __canAttemptForceRefresh = (reason) => {
    const now = Date.now();
    if (now - gateBBootAt < FORCE_REFRESH_BOOT_GRACE_MS) {
      return { ok: false, blockedBy: 'boot_grace', waitMs: Math.max(0, FORCE_REFRESH_BOOT_GRACE_MS - (now - gateBBootAt)) };
    }
    if (__gateBLastForceRefreshAt && (now - __gateBLastForceRefreshAt < FORCE_REFRESH_MIN_INTERVAL_MS)) {
      return { ok: false, blockedBy: 'force_refresh_interval', waitMs: Math.max(0, FORCE_REFRESH_MIN_INTERVAL_MS - (now - __gateBLastForceRefreshAt)) };
    }
    return { ok: true, blockedBy: null, waitMs: 0, reason: String(reason || '').trim() || null };
  };

  const __markForceRefresh = (reason) => {
    __gateBLastForceRefreshAt = Date.now();
    __gateBLastForceRefreshReason = String(reason || '').trim() || null;
    __gateBUpdateRuntime({
      bootstrap: {
        ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
        lastForceRefreshAt: __gateBLastForceRefreshAt,
        lastForceRefreshReason: __gateBLastForceRefreshReason
      }
    });
  };

  const __isCredentialInvalidSignal = (line) => {
    const s = String(line || '').toLowerCase();
    if (!s) return false;
    return (
      s.includes('invalid token')
      || s.includes('token is invalid')
      || s.includes('unauthorized')
      || s.includes('authentication failed')
      || s.includes('failed to get tunnel')
      || s.includes('tunnel not found')
      || s.includes('credential') && s.includes('invalid')
    );
  };

  const ensureCloudflaredExe = async () => {
    const preferred = String(process.env.CLOUDFLARED_EXE || '').trim();
    if (preferred) {
      try {
        if (fs.existsSync(preferred)) return preferred;
      } catch {}
    }

    const bundled = 'C:/portas/bin/cloudflared.exe';
    try {
      if (fs.existsSync(bundled)) return bundled;
    } catch {}

    const localDir = path.join(DATA_DIR, 'bin');
    const localExe = path.join(localDir, 'cloudflared.exe');
    try {
      if (fs.existsSync(localExe)) return localExe;
    } catch {}

    // Auto-provisiona o binário (Windows x64). Não depende de npm.
    const url = String(
      process.env.CLOUDFLARED_DOWNLOAD_URL ||
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    ).trim();
    try {
      const https = require('https');
      fs.mkdirSync(localDir, { recursive: true });
      const tmp = `${localExe}.tmp`;

      const download = (u, depth = 0) => new Promise((resolve, reject) => {
        if (depth > 5) return reject(new Error('cloudflared_download_redirect_loop'));
        const req = https.get(u, { timeout: 15000 }, (res) => {
          const sc = Number(res.statusCode || 0) || 0;
          const loc = String(res.headers && res.headers.location || '').trim();
          if ([301, 302, 303, 307, 308].includes(sc) && loc) {
            try { res.resume(); } catch {}
            const next = /^https?:\/\//i.test(loc) ? loc : new URL(loc, u).toString();
            return resolve(download(next, depth + 1));
          }
          if (sc < 200 || sc >= 300) {
            try { res.resume(); } catch {}
            return reject(new Error(`cloudflared_download_http_${sc}`));
          }
          const out = fs.createWriteStream(tmp);
          res.pipe(out);
          out.on('finish', () => {
            try { out.close(() => resolve(true)); } catch { resolve(true); }
          });
          out.on('error', reject);
        });
        req.on('timeout', () => {
          try { req.destroy(new Error('cloudflared_download_timeout')); } catch {}
        });
        req.on('error', reject);
      });

      logger.warn('[GATE_B][BOOTSTRAP] baixando cloudflared.exe (auto)', { url });
      await download(url);
      fs.renameSync(tmp, localExe);
      logger.info('[GATE_B][BOOTSTRAP] cloudflared.exe pronto', { path: localExe });
      return localExe;
    } catch (e) {
      try { fs.unlinkSync(`${localExe}.tmp`); } catch {}
      logger.warn('[GATE_B][BOOTSTRAP] falha ao baixar cloudflared.exe (best-effort)', { error: (e && e.message) || String(e) });
      return '';
    }
  };

  const spawnCloudflaredToken = async (token) => {
    try {
      const { spawn } = require('child_process');
      // Não usar "cloudflared" no PATH: queremos caminho determinístico para evitar ENOENT.
      try {
        if (__gateBCloudflaredChild && __gateBCloudflaredChild.exitCode == null) return true;
      } catch {}
      const candidate = await ensureCloudflaredExe();
      if (!candidate) return false;
      let outFd = null;
      try {
        const logPath = __gateBCloudflaredLogPath();
        try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch {}
        outFd = fs.openSync(logPath, 'a');
      } catch {}
      __gateBUpdateRuntime({
        cloudflared: {
          ...( (__gateBRuntime && __gateBRuntime.cloudflared) ? __gateBRuntime.cloudflared : {} ),
          exePath: String(candidate),
          spawnError: null,
          logPath: __gateBCloudflaredLogPath()
        }
      });
      const args = ['tunnel', 'run', '--token', String(token)];
      const child = spawn(candidate, args, {
        stdio: ['ignore', outFd != null ? outFd : 'ignore', outFd != null ? outFd : 'ignore'],
        windowsHide: true,
        detached: true
      });
      try { if (outFd != null) fs.closeSync(outFd); } catch {}
      __gateBCloudflaredChild = child;
      __gateBUpdateRuntime({
        cloudflared: {
          ...( (__gateBRuntime && __gateBRuntime.cloudflared) ? __gateBRuntime.cloudflared : {} ),
          started: true,
          startAt: Date.now(),
          exePath: String(candidate)
        }
      });
      child.once('error', (err) => {
        // CRÍTICO: sem isso, ENOENT vira uncaughtException e mata o master.
        try { logger.warn('[GATE_B][BOOTSTRAP] cloudflared spawn falhou', { error: (err && err.message) || String(err) }); } catch {}
        __gateBUpdateRuntime({
          cloudflared: {
            ...( (__gateBRuntime && __gateBRuntime.cloudflared) ? __gateBRuntime.cloudflared : {} ),
            started: false,
            spawnError: (err && err.message) ? String(err.message) : String(err)
          }
        });
      });
      child.once('exit', (code, signal) => {
        try {
          __gateBCloudflaredLastExit = { at: Date.now(), code: code == null ? null : Number(code), signal: signal == null ? null : String(signal) };
        } catch {}
        __gateBCloudflaredChild = null;
        __gateBCloudflaredStarted = false;
        const tail = readCloudflaredTail(8);
        const credentialInvalid = tail.some((l) => __isCredentialInvalidSignal(l));
        if (credentialInvalid) {
          __gateBCredentialRefreshNeeded = true;
          __gateBCredentialRefreshReason = 'cloudflared_credential_invalid';
        }
        __gateBUpdateRuntime({
          cloudflared: {
            ...( (__gateBRuntime && __gateBRuntime.cloudflared) ? __gateBRuntime.cloudflared : {} ),
            started: false,
            lastExit: __gateBCloudflaredLastExit || null,
            tail
          },
          bootstrap: {
            ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
            credentialRefreshNeeded: __gateBCredentialRefreshNeeded,
            credentialRefreshReason: __gateBCredentialRefreshReason
          }
        });
        try {
          logger.warn('[GATE_B][BOOTSTRAP] cloudflared encerrou; agendando auto-restart', { code: code == null ? null : Number(code), signal: signal == null ? null : String(signal) });
        } catch {}
        try {
          if (__gateBCloudflaredRestartTimer) return;
          const baseWaitMs = Math.max(3000, Number(process.env.GATE_B_CLOUDFLARED_RESTART_MS || 5000) || 5000);
          const inProvisioningWindow = Number(__gateBProvisioningPendingUntil || 0) > Date.now();
          let shouldForceRefreshOnExit = !inProvisioningWindow && __gateBCredentialRefreshNeeded;
          if (shouldForceRefreshOnExit) {
            const gate = __canAttemptForceRefresh(__gateBCredentialRefreshReason || 'cloudflared_credential_invalid');
            if (!gate.ok) {
              shouldForceRefreshOnExit = false;
              try {
                logger.info('[GATE_B][BOOTSTRAP] force_refresh_suprimido', { reason: __gateBCredentialRefreshReason || 'cloudflared_credential_invalid', blockedBy: gate.blockedBy, waitMs: gate.waitMs });
              } catch {}
            }
          }
          const waitMs = inProvisioningWindow
            ? Math.max(baseWaitMs, (Number(__gateBProvisioningPendingUntil || 0) - Date.now()) + 1000)
            : baseWaitMs;
          __gateBCloudflaredRestartTimer = setTimeout(() => {
            __gateBCloudflaredRestartTimer = null;
            try {
              const p = (typeof tryBootstrapOnce === 'function')
                ? tryBootstrapOnce({
                    forceRefresh: shouldForceRefreshOnExit,
                    reason: shouldForceRefreshOnExit ? (__gateBCredentialRefreshReason || 'cloudflared_credential_invalid') : 'cloudflared_exit'
                  })
                : maybeBootstrapGateBToken();
              p.catch((e) => {
                try { logger.warn('[GATE_B][BOOTSTRAP] auto-restart falhou', { error: (e && e.message) || String(e) }); } catch {}
              });
            } catch {}
          }, waitMs);
          try { __gateBCloudflaredRestartTimer.unref?.(); } catch {}
        } catch {}
      });
      try { child.unref(); } catch {}
      return true;
    } catch {
      return false;
    }
  };

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
  const pickRetryDelayMs = () => {
    const base = Math.max(60000, Number(process.env.GATE_B_BOOTSTRAP_RETRY_MS || 60000) || 60000);
    const jitter = Math.max(0, Number(process.env.GATE_B_BOOTSTRAP_RETRY_JITTER_MS || 5000) || 5000);
    return base + Math.floor(Math.random() * jitter);
  };

  const resolveBootstrapUrls = () => {
    const u = String(BOOTSTRAP_URL || '').trim().replace(/\/+$/, '');
    if (!u) return [];
    const arr = [];
    if (/\/api\/edge\/bootstrap$/i.test(u)) {
      arr.push(u);
    } else {
      // 1) tenta base (caso proxy faça rewrite)
      arr.push(u);
      // 2) tenta path canônico direto
      arr.push(`${u}/api/edge/bootstrap`);
    }
    return Array.from(new Set(arr.filter(Boolean)));
  };

  const scheduleRetry = () => {
    try {
      if (__gateBRetryTimer) return;
      const waitMs = pickRetryDelayMs();
      __gateBRetryTimer = setTimeout(async () => {
        __gateBRetryTimer = null;
        try { await tryBootstrapOnce(); } catch {}
      }, waitMs);
      try { __gateBRetryTimer.unref?.(); } catch {}
      logger.warn(`⚠️ [GATE_B][RETRY] Falha no provisionamento central. Aguardando ${Math.round(waitMs / 1000)} segundos para re-tentativa automática...`);
    } catch {}
  };

  const tryBootstrapOnce = async (opts = {}) => {
    const requestedForceRefresh = isTruthy(opts && opts.forceRefresh);
    const requestedForceReason = String((opts && opts.reason) || '').trim() || null;
    const forceGate = requestedForceRefresh ? __canAttemptForceRefresh(requestedForceReason || 'force_refresh') : { ok: false };
    const provisioningPending = Number(__gateBProvisioningPendingUntil || 0) > Date.now();
    // Importante: durante janela de provisioning pendente, fazemos "poll" normal (sem force),
    // mas sem reaproveitar token velho localmente.
    const forceRefresh = requestedForceRefresh && !!forceGate.ok;
    const forceReason = requestedForceReason || (requestedForceRefresh ? 'manual_force_refresh' : null);
    if (requestedForceRefresh && !forceRefresh) {
      try {
        logger.info('[GATE_B][BOOTSTRAP] force_refresh_suprimido', { reason: forceReason, blockedBy: forceGate.blockedBy, waitMs: forceGate.waitMs });
      } catch {}
    }
    if (forceRefresh) {
      __markForceRefresh(forceReason);
    }
    if (__gateBInFlight) return false;
    __gateBInFlight = true;
    try {
      const hostIdLocal = (readHostId() || getOrCreateHostId()) || null;
      __gateBUpdateRuntime({
        hostId: hostIdLocal,
        bootstrap: {
          ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
          lastUrl: null,
          lastStatus: null,
          lastError: null
        }
      });
      try {
        if (__gateBCloudflaredStarted && __gateBCloudflaredChild && __gateBCloudflaredChild.exitCode != null) {
          __gateBCloudflaredStarted = false;
          __gateBCloudflaredChild = null;
        }
      } catch {}
      const existing = sanitizeBundleForCurrentHost(readBundle(), hostIdLocal);
      try {
        const ex = existing && typeof existing === 'object' ? existing : null;
        __gateBUpdateRuntime({
          bundle: {
            present: !!ex,
            hostFqdn: ex && ex.hostFqdn ? String(ex.hostFqdn) : null,
            hasTunnelToken: !!(ex && ex.tunnelToken),
            hasInfraSecret: !!(ex && ex.infraSecret),
            source: ex && ex.source ? String(ex.source) : null,
            updatedAt: ex && typeof ex.updatedAt === 'number' ? ex.updatedAt : null
          }
        });
      } catch {}
      if (existing && existing.tunnelToken) {
        const shouldReuseExistingToken = !forceRefresh && !provisioningPending;
        if (shouldReuseExistingToken && !__gateBCloudflaredStarted) {
          const ok = await spawnCloudflaredToken(existing.tunnelToken);
          __gateBCloudflaredStarted = !!ok;
          logger.info('[GATE_B][BOOTSTRAP] bundle_presente: cloudflared_token_start=' + (ok ? 'ok' : 'fail'));
        }
        if (shouldReuseExistingToken) return true;
      }

      const tokenEnv = String(process.env.CONVENIENTE_GATE_B_TUNNEL_TOKEN || '').trim();
      if (tokenEnv) {
        writeBundleAtomic({
          hostFqdn: existing && existing.hostFqdn ? existing.hostFqdn : null,
          tunnelToken: tokenEnv,
          infraSecret: (existing && existing.infraSecret) ? existing.infraSecret : null,
          updatedAt: Date.now(),
          source: 'env'
        });
        __gateBUpdateRuntime({
          bundle: {
            present: true,
            hostFqdn: existing && existing.hostFqdn ? String(existing.hostFqdn) : null,
            hasTunnelToken: true,
            hasInfraSecret: !!(existing && existing.infraSecret),
            source: 'env',
            updatedAt: Date.now()
          }
        });
        if (!__gateBCloudflaredStarted) {
          const ok = await spawnCloudflaredToken(tokenEnv);
          __gateBCloudflaredStarted = !!ok;
          logger.info('[GATE_B][BOOTSTRAP] token_env: cloudflared_token_start=' + (ok ? 'ok' : 'fail'));
        }
        return true;
      }

      if (typeof fetch !== 'function') {
        logger.warn('[GATE_B][RETRY] fetch_unavailable');
        __gateBUpdateRuntime({
          bootstrap: {
            ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
            lastAttemptAt: Date.now(),
            lastError: 'fetch_unavailable'
          }
        });
        scheduleRetry();
        return false;
      }

      const urls = resolveBootstrapUrls();
      if (!urls.length) {
        logger.warn('[GATE_B][RETRY] bootstrap_url_empty');
        __gateBUpdateRuntime({
          bootstrap: {
            ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
            lastAttemptAt: Date.now(),
            lastError: 'bootstrap_url_empty'
          }
        });
        scheduleRetry();
        return false;
      }

      const hostId = hostIdLocal;
      const body = {
        hostId,
        hostname: os.hostname(),
        ts: Date.now(),
        want: 'gate_b_token_v1'
      };
      if (forceRefresh) {
        body.forceRefresh = true;
        if (forceReason) body.reason = forceReason;
      }
      const headers = { 'content-type': 'application/json' };
      if (BOOTSTRAP_SECRET) headers['x-bootstrap-secret'] = BOOTSTRAP_SECRET;

      let lastStatus = 0;
      let lastError = '';
      __gateBUpdateRuntime({
        bootstrap: {
          ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
          lastAttemptAt: Date.now(),
          lastUrl: urls[0] ? String(urls[0]) : null,
          lastStatus: null,
          lastError: null,
          forceRefresh: !!forceRefresh,
          forceReason,
          provisioningPending
        }
      });

      for (const url of urls) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 6500);
        try {
          __gateBUpdateRuntime({
            bootstrap: {
              ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
              lastUrl: String(url)
            }
          });
          const res = await fetch(url, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal: controller.signal });
          lastStatus = Number(res.status || 0) || 0;
          __gateBUpdateRuntime({
            bootstrap: {
              ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
              lastStatus
            }
          });
          const contentType = String(res.headers.get('content-type') || '');
          const location = String(res.headers.get('location') || '');
          if (lastStatus >= 300 && lastStatus < 400) {
            lastError = 'bootstrap_redirect';
            logger.warn('[GATE_B][RETRY] redirect_detectado', { status: lastStatus, url, location });
            continue;
          }
          const raw = await res.text().catch(() => '');
          if (lastStatus === 202) {
            const parsed202 = (() => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })();
            const retryAfterSec = Number(parsed202 && parsed202.retryAfterSec || 0) || 0;
            if (retryAfterSec > 0 && retryAfterSec < 600) {
              // “primeiro mundo”: CT está provisionando; retenta rápido sem esperar 60s
              const ms = Math.max(3000, Math.floor(retryAfterSec * 1000));
              logger.warn('[GATE_B][RETRY] ct_provisioning', { retryAfterSec, url });
              __gateBProvisioningPendingUntil = Date.now() + ms + 2000;
              __gateBUpdateRuntime({
                bootstrap: {
                  ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
                  provisioningPending: true,
                  provisioningPendingUntil: __gateBProvisioningPendingUntil
                }
              });
              if (requestedForceRefresh) {
                stopCloudflaredChild();
              }
              try {
                if (__gateBRetryTimer) { clearTimeout(__gateBRetryTimer); __gateBRetryTimer = null; }
                __gateBRetryTimer = setTimeout(async () => {
                  __gateBRetryTimer = null;
                  try { await tryBootstrapOnce({ forceRefresh: false, reason: 'ct_provisioning_poll' }); } catch {}
                }, ms);
                try { __gateBRetryTimer.unref?.(); } catch {}
              } catch {}
              return false;
            }
            lastError = 'ct_provisioning';
            continue;
          }
          if (!res.ok) {
            lastError = `status_${lastStatus}`;
            try { if (raw) logger.warn('[GATE_B][RETRY] corpo_resposta', { status: lastStatus, ct: contentType, raw: String(raw).slice(0, 220), url }); } catch {}
            continue;
          }
          const parsed = (() => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })();
          if (!parsed || typeof parsed !== 'object') {
            lastError = 'ct_bootstrap_not_json';
            logger.warn('[GATE_B][RETRY] resposta_ok_mas_invalida', { status: lastStatus, ct: contentType, url, raw: String(raw || '').slice(0, 220) });
            continue;
          }
          const tunnelToken = parsed && parsed.tunnelToken ? String(parsed.tunnelToken).trim() : '';
          const hostFqdn = parsed && parsed.hostFqdn ? String(parsed.hostFqdn).trim() : '';
          const infraSecret = parsed && parsed.infraSecret ? String(parsed.infraSecret).trim() : '';
          const previousToken = String((existing && existing.tunnelToken) ? existing.tunnelToken : '').trim();

          // Sempre cacheia host/secret quando vier (mesmo sem tunnel token), para reduzir acoplamento.
          if (hostFqdn || infraSecret) {
            writeBundleAtomic({
              hostFqdn: hostFqdn || (existing && existing.hostFqdn) || null,
              tunnelToken: tunnelToken || (existing && existing.tunnelToken) || null,
              infraSecret: infraSecret || (existing && existing.infraSecret) || null,
              updatedAt: Date.now(),
              source: 'ct_bootstrap_partial'
            });
            __gateBUpdateRuntime({
              bundle: {
                present: true,
                hostFqdn: hostFqdn ? String(hostFqdn) : ((existing && existing.hostFqdn) ? String(existing.hostFqdn) : null),
                hasTunnelToken: !!(tunnelToken || (existing && existing.tunnelToken)),
                hasInfraSecret: !!(infraSecret || (existing && existing.infraSecret)),
                source: 'ct_bootstrap_partial',
                updatedAt: Date.now()
              }
            });
          }

          if (!tunnelToken) {
            lastError = 'ct_bootstrap_missing_token';
            continue;
          }
          // Cache local de bundle (autonomia pós-configuração)
          writeBundleAtomic({
            hostFqdn: hostFqdn || null,
            tunnelToken,
            infraSecret: infraSecret || null,
            updatedAt: Date.now(),
            source: 'ct_bootstrap'
          });
          __gateBUpdateRuntime({
            bundle: {
              present: true,
              hostFqdn: hostFqdn ? String(hostFqdn) : null,
              hasTunnelToken: true,
              hasInfraSecret: !!infraSecret,
              source: 'ct_bootstrap',
              updatedAt: Date.now()
            },
            bootstrap: {
              ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
              lastOkAt: Date.now(),
              lastStatus,
              forceRefresh: !!forceRefresh,
              forceReason,
              credentialRefreshNeeded: false,
              credentialRefreshReason: null,
              provisioningPending: false,
              provisioningPendingUntil: null
            }
          });
          __gateBProvisioningPendingUntil = 0;
          __gateBCredentialRefreshNeeded = false;
          __gateBCredentialRefreshReason = null;
          const tokenRotated = !!previousToken && previousToken !== tunnelToken;
          if ((__gateBCloudflaredStarted && tokenRotated) || forceRefresh) {
            stopCloudflaredChild();
          }
          if (!__gateBCloudflaredStarted) {
            const ok = await spawnCloudflaredToken(tunnelToken);
            __gateBCloudflaredStarted = !!ok;
            logger.info('[GATE_B][BOOTSTRAP] ct_bootstrap_ok: cloudflared_token_start=' + (ok ? 'ok' : 'fail'), { forceRefresh, tokenRotated });
          } else {
            logger.info('[GATE_B][BOOTSTRAP] ct_bootstrap_ok: bundle atualizado (cloudflared já ativo)', { forceRefresh, tokenRotated });
          }
          return;
        } finally {
          clearTimeout(to);
        }
      }

      logger.warn(`⚠️ [GATE_B][RETRY] Falha no provisionamento central (Status: ${lastStatus || 'ERR'}). Aguardando 60 segundos para re-tentativa automática...`);
      if (lastError) logger.warn('[GATE_B][RETRY] motivo', { error: lastError });
      __gateBUpdateRuntime({
        bootstrap: {
          ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
          lastStatus: lastStatus || null,
          lastError: lastError || null
        }
      });
      scheduleRetry();
      return false;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      logger.warn(`⚠️ [GATE_B][RETRY] Falha no provisionamento central (Status: ERR). Aguardando 60 segundos para re-tentativa automática...`);
      logger.warn('[GATE_B][RETRY] excecao', { error: msg });
      __gateBUpdateRuntime({
        bootstrap: {
          ...( (__gateBRuntime && __gateBRuntime.bootstrap) ? __gateBRuntime.bootstrap : {} ),
          lastStatus: null,
          lastError: msg
        }
      });
      scheduleRetry();
      return false;
    } finally {
      __gateBInFlight = false;
    }
  };

  const isEdgeFailureStatus = (status) => {
    const s = Number(status || 0) || 0;
    return [502, 503, 520, 521, 522, 523, 524, 525, 526].includes(s);
  };

  const probePublicEdgeHealth = async () => {
    try {
      if (typeof fetch !== 'function') return;
      const bundle = readBundle();
      const hostFqdn = String((bundle && bundle.hostFqdn) ? bundle.hostFqdn : '').trim();
      if (!hostFqdn) return;
      const base = /^https?:\/\//i.test(hostFqdn) ? hostFqdn.replace(/\/+$/, '') : `https://${hostFqdn}`.replace(/\/+$/, '');
      const probeUrl = `${base}/api/status`;
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 5500);
      let status = 0;
      let errMsg = '';
      try {
        const res = await fetch(probeUrl, { method: 'GET', redirect: 'manual', signal: controller.signal });
        status = Number(res.status || 0) || 0;
      } catch (e) {
        errMsg = (e && e.message) ? String(e.message) : String(e);
      } finally {
        clearTimeout(to);
      }

      const ok = !errMsg && status >= 200 && status < 500 && !isEdgeFailureStatus(status);
      if (ok) {
        __gateBEdgeProbeState = {
          ...__gateBEdgeProbeState,
          consecutiveFailures: 0,
          lastStatus: status || null,
          lastError: null,
          lastOkAt: Date.now(),
          outageSince: null,
          localRecoveryAttempts: 0,
          lastLocalRecoveryAt: null
        };
      } else {
        const nextFails = Number(__gateBEdgeProbeState.consecutiveFailures || 0) + 1;
        const now = Date.now();
        const outageSince = Number(__gateBEdgeProbeState.outageSince || 0) || now;
        __gateBEdgeProbeState = {
          ...__gateBEdgeProbeState,
          consecutiveFailures: nextFails,
          lastStatus: status || null,
          lastError: errMsg || (status ? `status_${status}` : 'edge_probe_failed'),
          outageSince
        };
        const lastForce = Number(__gateBEdgeProbeState.lastForceRefreshAt || 0) || 0;
        const inCooldown = now - lastForce < EDGE_FORCE_REFRESH_COOLDOWN_MS;
        if (nextFails >= EDGE_PROBE_FAIL_THRESHOLD) {
          const lastLocalRecoveryAt = Number(__gateBEdgeProbeState.lastLocalRecoveryAt || 0) || 0;
          const localRecoveryAttempts = Number(__gateBEdgeProbeState.localRecoveryAttempts || 0) || 0;
          const localRecoveryCooldownOk = !lastLocalRecoveryAt || (now - lastLocalRecoveryAt >= EDGE_LOCAL_RECOVERY_COOLDOWN_MS);
          const canAttemptLocalRecovery = localRecoveryCooldownOk && (localRecoveryAttempts < EDGE_LOCAL_RECOVERY_MAX_ATTEMPTS);
          const prolongedOutage = now - outageSince >= EDGE_FORCE_ON_PROLONGED_OUTAGE_MS;

          if (__gateBCredentialRefreshNeeded && !inCooldown) {
            __gateBEdgeProbeState.lastForceRefreshAt = now;
            logger.warn('[GATE_B][EDGE_PROBE] falha persistente + credencial invalida; solicitando reprovisionamento no CT', {
              hostFqdn,
              status: status || null,
              error: errMsg || null,
              consecutiveFailures: nextFails,
              reason: __gateBCredentialRefreshReason
            });
            await tryBootstrapOnce({ forceRefresh: true, reason: __gateBCredentialRefreshReason || `edge_probe_${status || 'err'}` });
          } else if (canAttemptLocalRecovery) {
            __gateBEdgeProbeState.localRecoveryAttempts = localRecoveryAttempts + 1;
            __gateBEdgeProbeState.lastLocalRecoveryAt = now;
            logger.warn('[GATE_B][EDGE_PROBE] falha persistente; tentando autocura local sem CT', {
              hostFqdn,
              consecutiveFailures: nextFails,
              localRecoveryAttempt: __gateBEdgeProbeState.localRecoveryAttempts,
              maxAttempts: EDGE_LOCAL_RECOVERY_MAX_ATTEMPTS
            });
            stopCloudflaredChild();
            await tryBootstrapOnce({ forceRefresh: false, reason: 'edge_probe_local_recover' });
          } else if (!inCooldown && prolongedOutage) {
            __gateBEdgeProbeState.lastForceRefreshAt = now;
            logger.warn('[GATE_B][EDGE_PROBE] indisponibilidade prolongada; escalando para CT', {
              hostFqdn,
              consecutiveFailures: nextFails,
              outageMs: now - outageSince,
              reason: 'edge_probe_prolonged_outage'
            });
            await tryBootstrapOnce({ forceRefresh: true, reason: 'edge_probe_prolonged_outage' });
          }
        }
      }

      __gateBUpdateRuntime({
        edgeProbe: {
          hostFqdn,
          enabled: EDGE_PROBE_ENABLED,
          intervalMs: EDGE_PROBE_INTERVAL_MS,
          failThreshold: EDGE_PROBE_FAIL_THRESHOLD,
          cooldownMs: EDGE_FORCE_REFRESH_COOLDOWN_MS,
          localRecoveryCooldownMs: EDGE_LOCAL_RECOVERY_COOLDOWN_MS,
          localRecoveryMaxAttempts: EDGE_LOCAL_RECOVERY_MAX_ATTEMPTS,
          forceOnProlongedOutageMs: EDGE_FORCE_ON_PROLONGED_OUTAGE_MS,
          forceRefreshMinIntervalMs: FORCE_REFRESH_MIN_INTERVAL_MS,
          forceRefreshBootGraceMs: FORCE_REFRESH_BOOT_GRACE_MS,
          lastForceRefreshAt: __gateBLastForceRefreshAt || null,
          lastForceRefreshReason: __gateBLastForceRefreshReason || null,
          credentialRefreshNeeded: __gateBCredentialRefreshNeeded,
          credentialRefreshReason: __gateBCredentialRefreshReason,
          ...__gateBEdgeProbeState
        }
      });
    } catch {}
  };

  // Primeira tentativa no boot (não bloqueante).
  await tryBootstrapOnce();
  if (EDGE_PROBE_ENABLED) {
    if (!__gateBEdgeProbeTimer) {
      __gateBEdgeProbeTimer = setInterval(() => {
        probePublicEdgeHealth().catch(() => {});
      }, EDGE_PROBE_INTERVAL_MS);
      try { __gateBEdgeProbeTimer.unref?.(); } catch {}
    }
    probePublicEdgeHealth().catch(() => {});
  }
}

// Helpers/pontes
const fileStore = require('./scripts/fileStore.js');

// supervisor interno unificado (importação obrigatória — side effect: inicializa timers ttl/probe)
const supervisor = require('./scripts/supervisor.js');
const networkRotation = require('./scripts/networkRotation.js');
const dailyWindowScheduler = require('./scripts/dailyWindowScheduler.js');

// Dashboard monitor
const { applyCommands: applyInfraCommands } = require('./scripts/dashboard.js');
const { readCtConfig } = require('./scripts/ctConfig.js');

// Inicialização
const app = express();
const PORT = 8088;

// Inicia backup automático (rollback rápido do conveniente)
startAutoBackupConveniente();

// ===================== CORS restrito =====================
/**
 * CORS Middleware restritivo:
 * - Permite apenas origens localhost:<PORT> e 127.0.0.1:<PORT>
 * - Permite origin indefinido (Electron/localfile).
 * - Bloqueia o resto com erro CORS explícito.
 */
const allowedOrigins = [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Express pode reportar IPv6/IPv4-mapped (ex.: ::ffff:127.0.0.1). Trate como local.
  const ip = String(req.ip || '').toLowerCase();
  const host = String(req.hostname || '').toLowerCase();
  const isLocalIp =
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('::ffff:127.0.0.1');
  const isLocalHost =
    host === 'localhost' ||
    host === '127.0.0.1';
  const isLocalReq = isLocalIp || isLocalHost;
  // Electron/file:// costuma enviar Origin: null. Trate como “sem origin” se for local.
  const originIsNull = (String(origin || '').trim().toLowerCase() === 'null');
  if (
    allowedOrigins.includes(origin) ||
    ((!origin || originIsNull) && isLocalReq)
  ) {
    // Libera CORS somente para as origens válidas e undefined
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Infra-Secret');
    if (req.method === 'OPTIONS') {
      // Pré-flight para CORS
      return res.sendStatus(204);
    }
    return next();
  } else {
    // Bloqueia tudo que não é de painel local
    res.status(403).json({
      error: 'CORS Restrito: apenas painel local pode acessar este serviço.'
    });
  }
});
// ===================== Fim CORS restrito =====================

// ===================== Body Parsers =====================
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// ===================== Fim Body Parsers =====================

// ===================== Infra Auth (Gate B) =====================
function __readJsonFileSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = String(fs.readFileSync(p, 'utf8') || '').trim();
    if (!raw) return null;
    const j = JSON.parse(raw);
    return (j && typeof j === 'object') ? j : null;
  } catch {
    return null;
  }
}

function __resolveInfraSecret() {
  const env = String(process.env.VIRTUS_DELTA_INFRA_SECRET || process.env.INFRA_SECRET || '').trim();
  if (env) return env;
  try {
    const bundlePath = path.join(__dirname, 'dados', 'gate_b_bundle.json');
    const b = __readJsonFileSafe(bundlePath);
    const fromBundle =
      (b && (b.infraSecret || b.infra_secret || b.infraSECRET)) ? String(b.infraSecret || b.infra_secret || b.infraSECRET).trim() : '';
    if (fromBundle) return fromBundle;
  } catch {}
  return '';
}

function __infraAuth(req, res, next) {
  const expected = __resolveInfraSecret();
  if (!expected) return res.status(500).json({ ok: false, error: 'infra_secret_not_configured' });
  const got = String(req.headers['x-infra-secret'] || '').trim();
  if (!got || got !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return next();
}

// Protege todos os endpoints de infra (consumidos externamente via Gate B)
app.use('/api/infra', __infraAuth);

// Barramento Universal de Comandos (Tacada 1): execução síncrona + resposta 200 (sem ACK separado)
app.post('/api/infra/command-bus', async (req, res) => {
  try {
    const payload = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const commands = Array.isArray(payload.commands) ? payload.commands : null;
    if (!commands) return res.status(400).json({ ok: false, error: 'missing_commands_array' });

    // =============================
    // FUSÃO OPERACIONAL (FASE 2):
    // Intercepta comandos Delta de resposta (Messenger) e entrega por IPC ao worker dono da conta.
    // =============================
    const incoming = commands.filter(Boolean);
    const results = new Array(incoming.length);
    const normal = [];
    const normalIdx = [];

    for (let i = 0; i < incoming.length; i++) {
      const cmd = incoming[i] && typeof incoming[i] === 'object' ? incoming[i] : {};
      const t = String(cmd.type || '').trim();
      if (t === 'delta_reply') {
        const nome = String(cmd.nome || '').trim();
        const thread_key = String(cmd.thread_key || '').trim();
        const texto_resposta = String(cmd.texto_resposta || '').replace(/\r/g, '');
        if (!nome || !thread_key || !texto_resposta) {
          results[i] = { id: cmd && cmd.id ? String(cmd.id) : null, type: 'delta_reply', ok: false, error: 'missing_nome_or_thread_key_or_texto_resposta' };
          continue;
        }
        if (!clusterClient || typeof clusterClient.sendWorkerCommand !== 'function') {
          results[i] = { id: cmd && cmd.id ? String(cmd.id) : null, type: 'delta_reply', ok: false, error: 'cluster_not_ready' };
          continue;
        }
        try {
          const r = await clusterClient.sendWorkerCommand(
            'delta-reply-task',
            { nome, thread_key, texto_resposta },
            { timeoutMs: 60000 }
          );
          results[i] = { id: cmd && cmd.id ? String(cmd.id) : null, type: 'delta_reply', ok: !!(r && r.ok !== false), details: r || null };
        } catch (e) {
          results[i] = { id: cmd && cmd.id ? String(cmd.id) : null, type: 'delta_reply', ok: false, error: (e && e.message) ? String(e.message) : String(e) };
        }
        continue;
      }

      if (t === 'fetch_forensic_logs') {
        try {
          const p = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
          const linhasDesejadas = Math.min(Math.max(Number(p.linhas || 200) || 200, 20), 2000);
          const tipo = String(p.tipo || 'all').trim().toLowerCase();
          const maxBytes = Math.max(8 * 1024, Math.min(2 * 1024 * 1024, Number(p.maxBytes || 512 * 1024) || (512 * 1024)));
          const logPath = getActiveForensicLogPath();

          const tail = __tailTextFileLines(logPath, { maxLines: linhasDesejadas, maxBytes });
          if (!tail || tail.ok !== true) {
            results[i] = {
              id: cmd && cmd.id ? String(cmd.id) : null,
              type: 'fetch_forensic_logs',
              ok: false,
              error: tail && tail.error ? String(tail.error) : 'tail_failed',
              meta: { path: logPath }
            };
            continue;
          }

          const linhasTexto = Array.isArray(tail.lines) ? tail.lines : [];
          const linhasFiltradas = (tipo === 'delta_only')
            ? linhasTexto.filter((l) => /\[DELTA\]/i.test(String(l || '')) || /"tag"\s*:\s*"DELTA/i.test(String(l || '')))
            : linhasTexto;

          results[i] = {
            id: cmd && cmd.id ? String(cmd.id) : null,
            type: 'fetch_forensic_logs',
            ok: true,
            lines: linhasFiltradas,
            meta: {
              path: logPath,
              linhas: linhasFiltradas.length,
              fileSize: tail.fileSize || null,
              bytesRead: tail.bytesRead || null,
              tipo
            }
          };
        } catch (e) {
          results[i] = {
            id: cmd && cmd.id ? String(cmd.id) : null,
            type: 'fetch_forensic_logs',
            ok: false,
            error: (e && e.message) ? String(e.message) : String(e)
          };
        }
        continue;
      }

      if (t === 'execute_deep_cleanup') {
        let bytesLiberados = 0;
        const alvosLixo = [
          'dados/server_event_bridge.log',
          'dados/logger.log',
          'dados/issues_fallback.log',
          'dados/gate_b_cloudflared.log'
        ];
        let arquivosZerados = 0;
        let stepLogsDeletados = 0;
        let erros = 0;
        const deletedStepLogs = [];

        // 1) Zera logs globais (sem deletar arquivo)
        for (const relativo of alvosLixo) {
          const p = path.join(__dirname, relativo);
          if (!fs.existsSync(p)) continue;
          try {
            const st = fs.statSync(p);
            bytesLiberados += Number(st && st.size || 0) || 0;
            fs.writeFileSync(p, '', 'utf8');
            arquivosZerados++;
          } catch {
            erros++;
          }
        }

        // 2) Remove apenas *-step.log >24h em dados/perfis/*/
        try {
          const perfisDir = path.join(__dirname, 'dados', 'perfis');
          if (fs.existsSync(perfisDir)) {
            const cutoff = Date.now() - (24 * 60 * 60 * 1000);
            const perfis = fs.readdirSync(perfisDir, { withFileTypes: true });
            for (const ent of perfis) {
              try {
                if (!ent || !ent.isDirectory || !ent.isDirectory()) continue;
                const sub = path.join(perfisDir, ent.name);
                const files = fs.readdirSync(sub, { withFileTypes: true });
                for (const f of files) {
                  try {
                    if (!f || !f.isFile || !f.isFile()) continue;
                    const name = String(f.name || '');
                    if (!name.toLowerCase().endsWith('-step.log')) continue;
                    const fp = path.join(sub, name);
                    const st = fs.statSync(fp);
                    const m = Number(st && st.mtimeMs || 0) || 0;
                    if (m > 0 && m < cutoff) {
                      bytesLiberados += Number(st && st.size || 0) || 0;
                      fs.unlinkSync(fp);
                      stepLogsDeletados++;
                      if (deletedStepLogs.length < 30) deletedStepLogs.push(path.join('dados', 'perfis', ent.name, name));
                    }
                  } catch {
                    erros++;
                  }
                }
              } catch {
                erros++;
              }
            }
          }
        } catch {
          erros++;
        }

        try {
          forensicLog('INFRA_CLEANUP', 'execute_deep_cleanup', {
            mb_liberados: (bytesLiberados / (1024 * 1024)),
            arquivosZerados,
            stepLogsDeletados,
            erros
          });
        } catch {}

        results[i] = {
          id: cmd && cmd.id ? String(cmd.id) : null,
          type: 'execute_deep_cleanup',
          ok: true,
          meta: {
            mb_liberados: (bytesLiberados / (1024 * 1024)).toFixed(2),
            bytesLiberados,
            arquivosZerados,
            stepLogsDeletados,
            deletedStepLogs,
            erros
          }
        };
        if (typeof global.gc === 'function') global.gc();
        continue;
      }

      normal.push(cmd);
      normalIdx.push(i);
    }

    const out = normal.length ? await applyInfraCommands(normal) : { ok: true, results: [] };
    const outResults = (out && Array.isArray(out.results)) ? out.results : [];
    for (let j = 0; j < normalIdx.length; j++) {
      results[normalIdx[j]] = outResults[j] || { ok: false, error: 'missing_result' };
    }

    const okAll = results.every((r) => r && r.ok === true);
    return res.status(200).json({
      ok: okAll,
      executedAt: Date.now(),
      results
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? String(e.message) : String(e) });
  }
});

// ===================== Infra Debug Bundle (forense via endpoint) =====================
// Objetivo: permitir coleta remota pós-teste SEM operador executar comandos.
// Protegido por x-infra-secret (app.use('/api/infra', __infraAuth)).

function __asPosInt(v, def, { min = 0, max = 10_000 } = {}) {
  try {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    const i = Math.floor(n);
    if (i < min) return min;
    if (i > max) return max;
    return i;
  } catch {
    return def;
  }
}

function __redactText(s) {
  try {
    let out = String(s == null ? '' : s);
    // tokens/secrets genéricos
    out = out.replace(/(x-infra-secret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
    out = out.replace(/(infraSecret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
    out = out.replace(/(logIngestSecret"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
    // cookies comuns
    out = out.replace(/c_user=\d+/gi, 'c_user=[REDACTED]');
    out = out.replace(/xs=[^;\\s]+/gi, 'xs=[REDACTED]');
    // senha em JSON (best-effort)
    out = out.replace(/("password"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2');
    return out;
  } catch {
    return '';
  }
}

function __tailTextFileLines(p, { maxLines = 200, maxBytes = 256 * 1024 } = {}) {
  const lines = [];
  try {
    if (!p || !fs.existsSync(p)) return { ok: true, missing: true, path: String(p || ''), lines: [] };
    const stat = fs.statSync(p);
    const size = Number(stat.size || 0) || 0;
    if (size <= 0) return { ok: true, empty: true, path: String(p), lines: [] };
    const toRead = Math.max(1, Math.min(size, Math.max(8 * 1024, Number(maxBytes || 0) || 0)));
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(toRead);
      const start = Math.max(0, size - toRead);
      fs.readSync(fd, buf, 0, toRead, start);
      const txt = buf.toString('utf8');
      const parts = txt.split(/\r?\n/).filter(Boolean);
      const tail = parts.slice(Math.max(0, parts.length - Math.max(1, Number(maxLines || 0) || 1)));
      for (const l of tail) lines.push(__redactText(l));
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    return { ok: true, path: String(p), bytesRead: toRead, fileSize: size, lines };
  } catch (e) {
    return { ok: false, path: String(p || ''), error: (e && e.message) ? String(e.message) : String(e), lines };
  }
}

function __readDesiredSummary() {
  try {
    const desiredPath = path.join(__dirname, 'dados', 'desired.json');
    const d = __readJsonFileSafe(desiredPath) || {};
    const eng =
      (d && d._autoMode && d._autoMode.engine) ||
      (d && d.autoMode && d.autoMode.engine) ||
      (d && d.engine) || '';
    return {
      ok: true,
      engine: String(eng || '').trim().toLowerCase() || null,
      openAll: d && d._openAll ? d._openAll : null,
      autoOpen: d && d._autoOpen ? d._autoOpen : null,
      perfisCount: d && d.perfis ? Object.keys(d.perfis || {}).length : 0,
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

function __readIssuesTailForProfile(nome, { maxItems = 50 } = {}) {
  try {
    const n = String(nome || '').trim();
    if (!n) return { ok: true, skipped: true, reason: 'missing_nome', items: [] };
    const p = path.join(__dirname, 'dados', 'perfis', n, 'issues.json');
    const j = __readJsonFileSafe(p);
    if (!j) return { ok: true, missing: true, path: p, items: [] };
    const arr = Array.isArray(j) ? j : (Array.isArray(j.issues) ? j.issues : []);
    const tail = arr.slice(Math.max(0, arr.length - Math.max(1, Number(maxItems || 0) || 1)));
    const items = tail.map((it) => {
      try {
        const o = (it && typeof it === 'object') ? it : { value: it };
        const msg = o.message ? __redactText(o.message) : (o.msg ? __redactText(o.msg) : null);
        return {
          ts: o.ts || null,
          type: o.type || null,
          message: msg,
        };
      } catch {
        return { value: __redactText(String(it || '')) };
      }
    });
    return { ok: true, path: p, total: arr.length, items };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e), items: [] };
  }
}

app.post('/api/infra/debug-bundle', async (req, res) => {
  try {
    const payload = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const requestedHostId = payload.hostId ? String(payload.hostId || '').trim() : '';
    const hostId = __readOrCreateServerEventHostId();
    if (requestedHostId && requestedHostId !== hostId) {
      return res.status(404).json({ ok: false, error: 'hostid_mismatch', hostId });
    }

    const nome = payload.nome ? String(payload.nome || '').trim() : '';
    const lines = __asPosInt(payload.tailLines, 220, { min: 50, max: 2000 });
    const issuesN = __asPosInt(payload.issuesItems, 60, { min: 10, max: 400 });

    const out = {
      ok: true,
      collectedAt: Date.now(),
      hostId,
      pid: process.pid,
      cwd: process.cwd(),
      node: process.version,
      nome: nome || null,
      desired: __readDesiredSummary(),
      status: __readJsonFileSafe(path.join(__dirname, 'dados', 'status.json')),
      provisionAuditTail: __tailTextFileLines(path.join(__dirname, 'dados', 'provision_audit.jsonl'), { maxLines: lines, maxBytes: 512 * 1024 }),
      workerStdHints: {
        expect: [
          '[DELTA_BYPASS]',
          '[DELTA_HEALTH_BYPASS]',
          '[DELTA][NETWORK]',
          '[DELTA][QUEUE]',
          '[DELTA][CITY]',
          '[DELTA][TYPING]',
          '[DELTA][INGEST]',
          '[DELTA][SUCCESS]'
        ]
      },
      issuesTail: __readIssuesTailForProfile(nome, { maxItems: issuesN }),
    };

    // Sanitize top-level status if present
    try {
      if (out.status) {
        const raw = __redactText(JSON.stringify(out.status));
        out.statusRedactedPreview = raw.slice(0, 2000);
      }
    } catch {}

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? String(e.message) : String(e) });
  }
});

app.post('/api/infra/server-event-log', (req, res) => {
  try {
    const payload = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const lines = __asPosInt(payload.tailLines, 220, { min: 20, max: 4000 });
    const tail = __tailTextFileLines(__serverEventLogPath(), { maxLines: lines, maxBytes: 512 * 1024 });
    return res.status(200).json({
      ok: true,
      collectedAt: Date.now(),
      hostId: __readOrCreateServerEventHostId(),
      bridgeState: {
        lastHash: __serverEventLastHash || null,
        lastSentAt: __serverEventLastSentAt || null,
        lastDeltaSentAt: __serverEventLastDeltaSentAt || null,
        pendingHash: __serverEventPendingHash || null,
        pendingTicks: Number(__serverEventPendingTicks || 0) || 0,
        checkIntervalMs: SERVER_EVENT_CHECK_INTERVAL_MS,
        heartbeatMs: SERVER_EVENT_HEARTBEAT_MS,
        deltaMinIntervalMs: SERVER_EVENT_DELTA_MIN_INTERVAL_MS,
        changeConfirmTicks: SERVER_EVENT_CHANGE_CONFIRM_TICKS
      },
      tail
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? String(e.message) : String(e) });
  }
});
// ===================== Fim Infra Debug Bundle =====================
// ===================== Fim Infra Auth =====================

// ===================== Server Event Bridge (delta + heartbeat) =====================
const SERVER_EVENT_CHECK_INTERVAL_MS = Math.max(2000, Number(process.env.SERVER_EVENT_CHECK_INTERVAL_MS || 5000) || 5000);
const SERVER_EVENT_HEARTBEAT_MS = Math.max(60000, Number(process.env.SERVER_EVENT_HEARTBEAT_MS || 600000) || 600000); // 10 min
const SERVER_EVENT_DELTA_MIN_INTERVAL_MS = Math.max(5000, Number(process.env.SERVER_EVENT_DELTA_MIN_INTERVAL_MS || 30000) || 30000);
const SERVER_EVENT_CHANGE_CONFIRM_TICKS = Math.max(1, Number(process.env.SERVER_EVENT_CHANGE_CONFIRM_TICKS || 2) || 2);
// PATCH OBSERVABILIDADE (2026-07): por padrão, DESATIVADO em produção para matar tráfego zumbi (push/heartbeat).
// Para reativar explicitamente (homologação), setar: SERVER_EVENT_BRIDGE_ENABLED=1
const SERVER_EVENT_BRIDGE_ENABLED = String(process.env.SERVER_EVENT_BRIDGE_ENABLED || '').trim() === '1';
let __serverEventBridgeTimer = null;
let __serverEventBridgeInFlight = false;
let __serverEventLastHash = '';
let __serverEventLastSentAt = 0;
let __serverEventLastDeltaSentAt = 0;
let __serverEventPendingHash = '';
let __serverEventPendingTicks = 0;

function __serverEventHostIdPath() {
  return path.join(__dirname, 'dados', '.telemetry_hostid');
}

function __serverEventLogPath() {
  return path.join(__dirname, 'dados', 'server_event_bridge.log');
}

function __appendServerEventBridgeLog(event, extra = {}) {
  try {
    const p = __serverEventLogPath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
    fs.appendFileSync(p, JSON.stringify({
      ts: Date.now(),
      event: String(event || '').trim() || 'bridge_event',
      ...((extra && typeof extra === 'object') ? extra : {})
    }) + '\n', 'utf8');
  } catch {}
}

function __readOrCreateServerEventHostId() {
  const p = __serverEventHostIdPath();
  try {
    if (fs.existsSync(p)) {
      const v = String(fs.readFileSync(p, 'utf8') || '').trim();
      if (v) return v;
    }
  } catch {}
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const id = (crypto && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(p, String(id) + '\n', 'utf8');
    return String(id);
  } catch {
    try { return crypto.randomBytes(16).toString('hex'); } catch { return String(Date.now()); }
  }
}

function __classifyAccountState(perfil, robeRec) {
  const p = perfil || {};
  const banned = p.banned === true;
  const loginRequired = p.loginRequired === true;
  const reason = String(p.loginReason || '').trim().toLowerCase();
  if (banned) return 'banned';
  if (loginRequired) {
    if (reason.includes('captcha') || reason.includes('checkpoint')) return 'captcha';
    if (reason === 'login_form') return 'login';
    if (reason.includes('session')) return 'session';
    if (reason.includes('2fa') || reason.includes('two_factor')) return 'two_factor';
    if (reason.includes('identity')) return 'identity';
    if (reason.includes('consent')) return 'consent';
    return 'login_other';
  }
  const isLimit = !!(
    robeRec &&
    (String(robeRec.estado || '').toLowerCase() === 'paused_limit' ||
      String(robeRec.pauseReason || '').toLowerCase() === 'limit_posting') &&
    Number(robeRec.cooldownSec || 0) > 0
  );
  return isLimit ? 'limit_exceeded' : 'ok';
}

function __buildServerEventTelemetry(status) {
  const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
  const robes = (status && status.robes && typeof status.robes === 'object') ? status.robes : {};
  const sys = (status && status.sys && typeof status.sys === 'object') ? status.sys : {};

  const accountsAgg = { total: 0 };
  const flagsAgg = {
    totalPerfis: 0,
    human_invoked: 0,
    messenger_pin: 0,
    problem: 0,
    virtus_offline: 0,
    login_required: 0,
    login_cookies_failed: 0,
    appeal_submitted: 0
  };

  for (const p of perfis) {
    if (!p) continue;
    const nome = String(p.nome || '').trim();
    const kind = __classifyAccountState(p, nome ? robes[nome] : null);
    accountsAgg[kind] = (Number(accountsAgg[kind] || 0) || 0) + 1;
    accountsAgg.total++;

    flagsAgg.totalPerfis++;
    if (p.humanControl === true || p.humanHold === true) flagsAgg.human_invoked++;
    if (p.messengerPin === true) flagsAgg.messenger_pin++;
    if (p.problem === true) flagsAgg.problem++;
    if (p.virtusOnline === false) flagsAgg.virtus_offline++;
    if (p.loginRequired === true) flagsAgg.login_required++;
    if (p.loginRemediateFailed === true) flagsAgg.login_cookies_failed++;
    if (p.appealSubmitted === true) flagsAgg.appeal_submitted++;
  }
  accountsAgg.lr_total = ['captcha', 'login', 'session', 'two_factor', 'identity', 'consent', 'login_other']
    .reduce((acc, k) => acc + (Number(accountsAgg[k] || 0) || 0), 0);

  const quick = {
    perfisCount: perfis.length,
    activeCount: perfis.filter((p) => p && p.active).length,
    workingCount: perfis.filter((p) => p && p.trabalhando).length,
    sys: {
      freeMB: Number(sys.freeMB || 0) || 0,
      totalMB: Number(sys.totalMB || 0) || 0,
      cpuApprox: Number(sys.cpuApprox || 0) || 0
    }
  };

  // Assinatura estável: não inclui métricas voláteis (cpu/ram) para evitar ruído.
  const perfisStable = perfis.map((p) => {
    const nome = String(p && p.nome || '').trim();
    const stateKind = __classifyAccountState(p, nome ? robes[nome] : null);
    return {
      n: nome,
      st: stateKind,
      a: !!(p && p.active),
      w: !!(p && p.trabalhando),
      b: !!(p && p.banned),
      hc: !!(p && p.humanControl),
      hh: !!(p && p.humanHold),
      mp: !!(p && p.messengerPin),
      pb: !!(p && p.problem),
      vo: (p && p.virtusOnline === false) ? 0 : 1
    };
  }).sort((x, y) => String(x.n || '').localeCompare(String(y.n || '')));

  const signature = {
    perfis: perfisStable,
    accountsAgg,
    flagsAgg
  };

  const stateHash = crypto.createHash('sha1').update(JSON.stringify(signature)).digest('hex');
  return { accountsAgg, flagsAgg, quick, stateHash };
}

async function __readLocalStatusForEventBridge() {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, { method: 'GET', signal: controller.signal });
    if (!res.ok) throw new Error(`status_http_${res.status}`);
    const json = await res.json();
    if (!json || typeof json !== 'object') throw new Error('status_invalid_json');
    return json;
  } finally {
    clearTimeout(to);
  }
}

function __resolveCtServerEventConfig() {
  try {
    const cfg = readCtConfig();
    const fromCfg = String((cfg && cfg.ctBaseUrl) || '').trim();
    const isLegacyNgrokUrl = (raw) => {
      const s = String(raw || '').trim().toLowerCase();
      return !!s && (s.includes('.ngrok.io') || s.includes('.ngrok-free.app') || s.includes('.ngrok.app'));
    };
    const allowNgrok = String(process.env.CT_ALLOW_NGROK_URL || '').trim() === '1';
    const cfgCtBaseUrl = (fromCfg && !(isLegacyNgrokUrl(fromCfg) && !allowNgrok)) ? fromCfg : '';
    const ctBaseUrlRaw = String(
      cfgCtBaseUrl ||
      process.env.CT_BASE_URL ||
      process.env.CT_URL ||
      'https://api.convenientetecnologia.com'
    ).trim();
    const ctBaseUrl = ctBaseUrlRaw.replace(/\/+$/, '');
    const explicitEventUrl = String(
      process.env.CT_SERVER_EVENT_URL ||
      process.env.CONVENIENTE_CT_SERVER_EVENT_URL ||
      ''
    ).trim();
    const eventUrl = explicitEventUrl
      ? explicitEventUrl.replace(/\/+$/, '')
      : `${ctBaseUrl}/api/servers/event_secret`;
    const logSecret = String((cfg && cfg.logIngestSecret) || process.env.LOG_INGEST_SECRET || '').trim();
    if (!eventUrl || !logSecret) return null;
    return { ctBaseUrl, eventUrl, logSecret };
  } catch {
    return null;
  }
}

async function __postServerEventToCt(payload) {
  const cfg = __resolveCtServerEventConfig();
  if (!cfg) return { ok: false, skipped: true, error: 'ct_config_incomplete' };
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(cfg.eventUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-log-secret': cfg.logSecret
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const errPreview = String(body || '').slice(0, 180);
      return { ok: false, status: res.status, ctBaseUrl: cfg.ctBaseUrl, eventUrl: cfg.eventUrl, error: `event_post_http_${res.status}:${errPreview}` };
    }
    return { ok: true, status: res.status, ctBaseUrl: cfg.ctBaseUrl, eventUrl: cfg.eventUrl };
  } catch (e) {
    return { ok: false, ctBaseUrl: cfg.ctBaseUrl, eventUrl: cfg.eventUrl, error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(to);
  }
}

async function __serverEventBridgeTick(reason) {
  if (__serverEventBridgeInFlight) return;
  __serverEventBridgeInFlight = true;
  try {
    const status = await __readLocalStatusForEventBridge();
    const hostId = __readOrCreateServerEventHostId();
    const telemetry = __buildServerEventTelemetry(status);
    const now = Date.now();
    const changed = telemetry.stateHash !== __serverEventLastHash;
    const heartbeatDue = !__serverEventLastSentAt || ((now - __serverEventLastSentAt) >= SERVER_EVENT_HEARTBEAT_MS);
    if (changed) {
      if (__serverEventPendingHash === telemetry.stateHash) {
        __serverEventPendingTicks = (Number(__serverEventPendingTicks || 0) || 0) + 1;
      } else {
        __serverEventPendingHash = telemetry.stateHash;
        __serverEventPendingTicks = 1;
      }
    } else {
      __serverEventPendingHash = '';
      __serverEventPendingTicks = 0;
    }
    const deltaConfirmed = changed && (reason === 'boot' || __serverEventPendingTicks >= SERVER_EVENT_CHANGE_CONFIRM_TICKS);
    const deltaRateOk = !__serverEventLastDeltaSentAt || ((now - __serverEventLastDeltaSentAt) >= SERVER_EVENT_DELTA_MIN_INTERVAL_MS);
    const shouldSendDelta = deltaConfirmed && deltaRateOk;
    if (!shouldSendDelta && !heartbeatDue && reason !== 'boot') {
      __appendServerEventBridgeLog('bridge_skip_noop', {
        hostId,
        changed,
        pendingTicks: __serverEventPendingTicks,
        heartbeatDue: false
      });
      return;
    }

    const payload = {
      hostId,
      hostname: String(os.hostname() || ''),
      sentAt: now,
      eventType: shouldSendDelta ? 'server_delta' : 'heartbeat',
      stateHash: telemetry.stateHash,
      quick: telemetry.quick,
      accountsAgg: telemetry.accountsAgg,
      flagsAgg: telemetry.flagsAgg,
      ...(shouldSendDelta ? { status } : {})
    };
    const out = await __postServerEventToCt(payload);
    if (out && out.ok) {
      if (shouldSendDelta) {
        __serverEventLastHash = telemetry.stateHash;
        __serverEventLastDeltaSentAt = now;
        __serverEventPendingHash = '';
        __serverEventPendingTicks = 0;
      }
      __serverEventLastSentAt = now;
      __appendServerEventBridgeLog('bridge_sent', {
        hostId,
        eventType: payload.eventType,
        stateHash: telemetry.stateHash,
        pendingTicks: __serverEventPendingTicks,
        status: out.status || null,
        ctBaseUrl: out.ctBaseUrl || null,
        eventUrl: out.eventUrl || null
      });
    } else if (out && !out.skipped) {
      __appendServerEventBridgeLog('bridge_send_failed', {
        hostId,
        eventType: payload.eventType,
        stateHash: telemetry.stateHash,
        pendingTicks: __serverEventPendingTicks,
        error: out.error || 'unknown',
        status: out.status || null,
        ctBaseUrl: out.ctBaseUrl || null,
        eventUrl: out.eventUrl || null
      });
      logger.warn('[SERVER_EVENT_BRIDGE] falha ao postar evento no CT', {
        error: out.error || 'unknown',
        status: out.status || null,
        ctBaseUrl: out.ctBaseUrl || null,
        eventUrl: out.eventUrl || null
      });
    } else {
      __appendServerEventBridgeLog('bridge_send_skipped', {
        hostId,
        eventType: payload.eventType,
        reason: out && out.error ? String(out.error) : 'skipped'
      });
    }
  } catch (e) {
    __appendServerEventBridgeLog('bridge_tick_exception', { error: (e && e.message) || String(e) });
    logger.warn('[SERVER_EVENT_BRIDGE] tick falhou', { error: (e && e.message) || String(e) });
  } finally {
    __serverEventBridgeInFlight = false;
  }
}

function startServerEventBridge() {
  try {
    if (!SERVER_EVENT_BRIDGE_ENABLED) {
      try { logger.info('[SERVER_EVENT_BRIDGE] desativado (SERVER_EVENT_BRIDGE_ENABLED!=1)'); } catch {}
      try { forensicLog('OBS', 'server_event_bridge_disabled', { enabled: false }); } catch {}
      return;
    }
    if (__serverEventBridgeTimer) return;
    __serverEventBridgeTick('boot').catch(() => {});
    __serverEventBridgeTimer = setInterval(() => {
      __serverEventBridgeTick('interval').catch(() => {});
    }, SERVER_EVENT_CHECK_INTERVAL_MS);
    try { __serverEventBridgeTimer.unref?.(); } catch {}
  } catch {}
}
// ===================== Fim Server Event Bridge =====================

// ===================== Middleware de autenticação (REMOVIDO) =====================

// Militar: Apenas arquivos públicos (UI) expostos. Backend nunca via HTTP!
// SERVIÇO ESTÁTICO EXCLUSIVO DA PASTA /public/
// Ultra-enterprise: desativa cache do painel para updates aparecerem imediatamente após self_update.
app.use((req, res, next) => {
  try {
    const p = String(req.path || '');
    if (p === '/' || p.endsWith('/index.html') || p.endsWith('.html') || p.endsWith('.js') || p.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  } catch {}
  next();
});
app.use('/', express.static(path.join(__dirname, 'public')));
// NUNCA PERMITIDO: exposição de scripts ou backend!
// app.use('/', express.static(path.join(__dirname, 'scripts')));
// app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

// ===================== CLUSTER MULTI-NODE =====================
let clusterClient = null;
async function bootCluster() {
  try { rotateForensicLogs24h(); } catch {}
  const { createCluster } = require('./scripts/clusterMaster.js');
  logger.info('[BOOT] Construindo cluster multi-node (auto)...');
  clusterClient = createCluster(); // { plan, children, sendWorkerCommand, kill }
  logger.info('[BOOT] Cluster OK: nodes=' + clusterClient.plan.nodes + ' perNodeMax=' + clusterClient.plan.perNode.maxChromes);
}
// ===================== FIM CLUSTER MULTI-NODE =====================

// API endpoints (militar por arquivo de rota, modular, fácil de achar)
const apiClient = { sendWorkerCommand: (...args) => clusterClient.sendWorkerCommand(...args) };
require('./scripts/api_status.js')(app, apiClient, fileStore);
require('./scripts/api_perfis.js')(app, apiClient, fileStore);
require('./scripts/api_robes.js')(app, apiClient, fileStore);
require('./scripts/api_cidades.js')(app, apiClient, fileStore);
require('./scripts/api_sys.js')(app, apiClient, fileStore);
require('./scripts/api_issues.js')(app, apiClient, fileStore);
require('./scripts/api_stock.js')(app);
// Se usar api_static.js/adicional, inclua aqui: require('./scripts/api_static.js')(app);

// Troque todos os console.log por logger.info conforme checklist
logger.info('[BOOT] Garantindo arquivos base...');
fileStore.ensureDesired();
fileStore.ensurePerfisJson();

// Pausa automática de 24h em todos os perfis no boot, se ativado por env
(async () => {
  if (process.env.ROBE_PAUSE_24H_ON_BOOT === '1') {
    const manifestStore = require('./scripts/manifestStore.js');
    const perfis = fileStore.loadPerfisJson();
    const plus24 = 24 * 60 * 60 * 1000;
    let count = 0;
    for (const p of perfis) {
      try {
        await manifestStore.update(p.nome, m => {
          m = m || {};
          m.robeCooldownUntil = Date.now() + plus24;
          m.robeCooldownRemainingMs = 0;
          m.robePauseReason = 'boot_hold';
          return m;
        });
        count++;
      } catch (e) {
        logger.warn('[BOOT][PAUSE24H] Falha ao pausar perfil: ' + p.nome + ' ' + (e && e.message || e));
      }
    }
    try {
      require('./scripts/issues.js').append('system', 'mil_action', `robe_pause_24h_on_boot applied to ${count}/${perfis.length} perfis`);
    } catch {}
    logger.info('[BOOT] ROBE_PAUSE_24H_ON_BOOT aplicado em ' + count + ' perfis');
  }
})();

// Health check endpoint (opcional)
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Boot sequencial: bootstrap de serviço -> cluster -> listen
(async () => {
  await maybeBootstrapService();
  // Gate B bootstrap roda em background para nunca travar subida do sistema.
  maybeBootstrapGateBToken().catch((e) => {
    logger.warn('[GATE_B][BOOTSTRAP] falha no disparo em background', { error: (e && e.message) || String(e) });
  });
  // Política definida (triagem inbox): após restart, começar fechado.
  // Para abrir, operador deve clicar “Abrir Todos” (ou abrir perfil manualmente).
  // Escape hatch: set CONVENIENTE_START_CLOSED_ON_BOOT=0 para desativar.
  try {
    const startClosedOnBoot = String(process.env.CONVENIENTE_START_CLOSED_ON_BOOT || '1').trim() !== '0';
    if (startClosedOnBoot) {
      logger.info('[BOOT] Política start-closed ATIVA: resetando desired.active=false para todos (aguardando clique).');
      const r = await fileStore.resetDesiredAllOffOnBoot({ reason: 'triagem_inbox_policy_manual_start' });
      if (r && r.ok === true) logger.info('[BOOT] start-closed aplicado', { changed: r.changed });
      else logger.warn('[BOOT] start-closed falhou (best-effort)', { error: r && r.error ? r.error : 'unknown' });
    } else {
      logger.warn('[BOOT] Política start-closed DESATIVADA (CONVENIENTE_START_CLOSED_ON_BOOT=0).');
    }
  } catch (e) {
    logger.warn('[BOOT] start-closed exceção (best-effort)', { error: (e && e.message) || String(e) });
  }
  await bootCluster();

  // Start server — faça o binding em 127.0.0.1
  app.listen(PORT, '127.0.0.1', () => {
    logger.info(`[START] Painel admin disponível em http://localhost:${PORT}/index.html`);
    logger.info('[SECURE] Servindo apenas arquivos de public/, backend protegido.');
    // Logging claro: status da proteção e do modo de abertura do painel

    if (process.env.OPEN_CHROMIUM_ON_START == '1') {
      logger.info('[INFO] Abertura automática do Chromium: ATIVA (OPEN_CHROMIUM_ON_START=1)');
    } else {
      logger.info('[INFO] Abrir painel Chromium automaticamente está desativado (defina OPEN_CHROMIUM_ON_START=1 para ativar, se desejar).');
    }

    // Monitor legacy (polling) foi extinto (Tacada 1). Infra agora é event-driven via /api/infra/command-bus.
    startServerEventBridge();
    networkRotation.startNetworkRotationScheduler({ port: PORT });
    dailyWindowScheduler.startDailyWindowScheduler({ port: PORT });
  });
})();

// Tenta abrir sempre o painel no Chromium azul (agora OPT-IN)
if (process.env.OPEN_CHROMIUM_ON_START == '1') {
  setTimeout(() => {
    // Usar CHROME_PATH (variável de ambiente) como prioridade
    const defaultChromiumPaths = [
      'C:\\Users\\PC\\AppData\\Local\\Chromium\\Application\\chrome.exe',
      'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    const painelUrl = `http://localhost:${PORT}/index.html`;

    (async () => {
      let opened = false;

      let chromiumPaths = defaultChromiumPaths;
      // Se CHROME_PATH estiver definido, tenta PRIMEIRO
      if (process.env.CHROME_PATH && process.env.CHROME_PATH.trim() !== '') {
        chromiumPaths = [process.env.CHROME_PATH.trim(), ...defaultChromiumPaths];
      }

      for (const chromium of chromiumPaths) {
        try {
          await open(painelUrl, {app: {name: chromium}});
          opened = true;
          break;
        } catch {}
      }
      // Se não achou Chromium, tenta abrir no 'chromium' da variável de ambiente ou path
      if (!opened) {
        try {
          await open(painelUrl, {app: {name: 'chromium'}});
          opened = true;
        } catch {}
      }
      // IMPORTANTE: não abrir no Chrome e nem no browser padrão.
      if (!opened) {
        logger.warn('[WARN] Não foi possível abrir automaticamente no Chromium. Abra manualmente: ' + painelUrl);
      }
    })();
  }, 1200); // Delay de 1.2s para garantir o servidor up antes do browser abrir
}

// Graceful shutdown — encerra worker e faz cleanup
process.on('SIGINT', async () => {
  logger.info('[STOP] SIGINT recebido. Encerrando...');
  try { await (clusterClient && clusterClient.kill && clusterClient.kill()); } catch(e){}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('[STOP] SIGTERM recebido. Encerrando...');
  try { await (clusterClient && clusterClient.kill && clusterClient.kill()); } catch(e){}
  process.exit(0);
});

// P1: política consistente de erros globais (master).
// - Por padrão NÃO mata o processo (sem auto-restart neste ambiente).
// - Se o operador habilitar CONVENIENTE_FATAL_EXIT=1, sai com code=1 para evitar estado corrompido.
function fatalMaster(kind, e) {
  try { logger.error(`[FATAL][MASTER] ${kind}`, { error: (e && e.message) ? e.message : e }, e); } catch {}
  try {
    if (String(process.env.CONVENIENTE_FATAL_EXIT || '').trim() === '1') {
      setTimeout(() => { try { process.exit(1); } catch {} }, 800);
    } else {
      try { logger.warn('[FATAL][MASTER] processo continua (CONVENIENTE_FATAL_EXIT!=1). Humano deve reiniciar: node index.js'); } catch {}
    }
  } catch {}
}
process.on('uncaughtException', (e) => fatalMaster('uncaughtException', e));
process.on('unhandledRejection', (e) => fatalMaster('unhandledRejection', e));