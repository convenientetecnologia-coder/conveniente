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

  const writeBundleAtomic = (bundle) => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch {}
    const tmp = `${BUNDLE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, BUNDLE_PATH);
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
      const candidate = await ensureCloudflaredExe();
      if (!candidate) return false;
      const args = ['tunnel', 'run', '--token', String(token)];
      const child = spawn(candidate, args, { stdio: 'ignore', windowsHide: true, detached: true });
      child.once('error', (err) => {
        // CRÍTICO: sem isso, ENOENT vira uncaughtException e mata o master.
        try { logger.warn('[GATE_B][BOOTSTRAP] cloudflared spawn falhou', { error: (err && err.message) || String(err) }); } catch {}
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

  const tryBootstrapOnce = async () => {
    if (__gateBInFlight) return false;
    __gateBInFlight = true;
    try {
      const existing = readBundle();
      if (existing && existing.tunnelToken) {
        if (!__gateBCloudflaredStarted) {
          const ok = await spawnCloudflaredToken(existing.tunnelToken);
          __gateBCloudflaredStarted = !!ok;
          logger.info('[GATE_B][BOOTSTRAP] bundle_presente: cloudflared_token_start=' + (ok ? 'ok' : 'fail'));
        }
        return true;
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
        if (!__gateBCloudflaredStarted) {
          const ok = await spawnCloudflaredToken(tokenEnv);
          __gateBCloudflaredStarted = !!ok;
          logger.info('[GATE_B][BOOTSTRAP] token_env: cloudflared_token_start=' + (ok ? 'ok' : 'fail'));
        }
        return true;
      }

      if (typeof fetch !== 'function') {
        logger.warn('[GATE_B][RETRY] fetch_unavailable');
        scheduleRetry();
        return false;
      }

      const urls = resolveBootstrapUrls();
      if (!urls.length) {
        logger.warn('[GATE_B][RETRY] bootstrap_url_empty');
        scheduleRetry();
        return false;
      }

      const hostId = (readHostId() || getOrCreateHostId()) || null;
      const body = {
        hostId,
        hostname: os.hostname(),
        ts: Date.now(),
        want: 'gate_b_token_v1'
      };
      const headers = { 'content-type': 'application/json' };
      if (BOOTSTRAP_SECRET) headers['x-bootstrap-secret'] = BOOTSTRAP_SECRET;

      let lastStatus = 0;
      let lastError = '';

      for (const url of urls) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 6500);
        try {
          const res = await fetch(url, { method: 'POST', redirect: 'manual', headers, body: JSON.stringify(body), signal: controller.signal });
          lastStatus = Number(res.status || 0) || 0;
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
              try {
                if (__gateBRetryTimer) { clearTimeout(__gateBRetryTimer); __gateBRetryTimer = null; }
                __gateBRetryTimer = setTimeout(async () => {
                  __gateBRetryTimer = null;
                  try { await tryBootstrapOnce(); } catch {}
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

          // Sempre cacheia host/secret quando vier (mesmo sem tunnel token), para reduzir acoplamento.
          if (hostFqdn || infraSecret) {
            writeBundleAtomic({
              hostFqdn: hostFqdn || (existing && existing.hostFqdn) || null,
              tunnelToken: tunnelToken || (existing && existing.tunnelToken) || null,
              infraSecret: infraSecret || (existing && existing.infraSecret) || null,
              updatedAt: Date.now(),
              source: 'ct_bootstrap_partial'
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
          if (!__gateBCloudflaredStarted) {
            const ok = await spawnCloudflaredToken(tunnelToken);
            __gateBCloudflaredStarted = !!ok;
            logger.info('[GATE_B][BOOTSTRAP] ct_bootstrap_ok: cloudflared_token_start=' + (ok ? 'ok' : 'fail'));
          } else {
            logger.info('[GATE_B][BOOTSTRAP] ct_bootstrap_ok: bundle atualizado (cloudflared já ativo)');
          }
          return;
        } finally {
          clearTimeout(to);
        }
      }

      logger.warn(`⚠️ [GATE_B][RETRY] Falha no provisionamento central (Status: ${lastStatus || 'ERR'}). Aguardando 60 segundos para re-tentativa automática...`);
      if (lastError) logger.warn('[GATE_B][RETRY] motivo', { error: lastError });
      scheduleRetry();
      return false;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      logger.warn(`⚠️ [GATE_B][RETRY] Falha no provisionamento central (Status: ERR). Aguardando 60 segundos para re-tentativa automática...`);
      logger.warn('[GATE_B][RETRY] excecao', { error: msg });
      scheduleRetry();
      return false;
    } finally {
      __gateBInFlight = false;
    }
  };

  // Primeira tentativa no boot (não bloqueante).
  await tryBootstrapOnce();
}

// Helpers/pontes
const fileStore = require('./scripts/fileStore.js');

// supervisor interno unificado (importação obrigatória — side effect: inicializa timers ttl/probe)
const supervisor = require('./scripts/supervisor.js');
const networkRotation = require('./scripts/networkRotation.js');
const dailyWindowScheduler = require('./scripts/dailyWindowScheduler.js');

// Dashboard monitor
const { applyCommands: applyInfraCommands } = require('./scripts/dashboard.js');

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
    const out = await applyInfraCommands(commands);
    return res.status(200).json({
      ok: true,
      executedAt: Date.now(),
      ...(out && typeof out === 'object' ? out : { ok: true, results: [] })
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: (e && e.message) ? String(e.message) : String(e) });
  }
});
// ===================== Fim Infra Auth =====================

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