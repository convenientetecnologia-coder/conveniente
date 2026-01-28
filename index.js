// index.js (main do projeto, pasta principal)
const express = require('express');
const path = require('path');
const cors = require('cors');
// const bodyParser = require('body-parser'); // Não é necessário, pois estamos usando express.json/express.urlencoded
const open = require('open'); // <-- adicione/mova isso aqui!
const fs = require('fs');

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
    const baseDir = path.join(ROOT, '_backup_auto');
    const pad2 = (n) => String(n).padStart(2, '0');
    const tsTag = () => {
      const d = new Date();
      return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    };
    const ensureDir = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch {} };
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
    const safeStat = (p) => { try { return fs.statSync(p); } catch { return null; } };
    const copyFileRetry = (src, dst) => {
      try {
        ensureDir(path.dirname(dst));
        for (let i = 0; i < 8; i++) {
          try { fs.copyFileSync(src, dst); return true; } catch (e) {
            const code = String(e && e.code || '');
            if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') { sleepSync(30 + i * 50); continue; }
            return false;
          }
        }
        return false;
      } catch { return false; }
    };

    const copyDirFlat = (relDir, { exts = ['.js'], maxFiles = 400 } = {}) => {
      try {
        const srcDir = path.join(ROOT, relDir);
        const st = safeStat(srcDir);
        if (!st || !st.isDirectory()) return 0;
        const files = fs.readdirSync(srcDir).slice(0, maxFiles);
        let c = 0;
        for (const name of files) {
          const low = String(name).toLowerCase();
          if (exts && exts.length) {
            const ok = exts.some(e => low.endsWith(String(e).toLowerCase()));
            if (!ok) continue;
          }
          const fp = path.join(srcDir, name);
          const fst = safeStat(fp);
          if (!fst || !fst.isFile()) continue;
          const dst = path.join(curOutDir, relDir, name);
          if (copyFileRetry(fp, dst)) c++;
        }
        return c;
      } catch { return 0; }
    };

    let curOutDir = null;
    const doSnapshot = () => {
      const tag = tsTag();
      curOutDir = path.join(baseDir, tag);
      ensureDir(curOutDir);

      // Arquivos raiz importantes
      const files = [
        'index.js',
        'package.json',
        'package-lock.json',
        'instalar_conveniente.ps1',
        'PainelConta.bat'
      ];
      let copied = 0;
      for (const rel of files) {
        const src = path.join(ROOT, rel);
        if (!safeStat(src)) continue;
        if (copyFileRetry(src, path.join(curOutDir, rel))) copied++;
      }

      // Código (sem node_modules)
      copied += copyDirFlat('scripts', { exts: ['.js'], maxFiles: 600 });
      copied += copyDirFlat('public', { exts: ['.html', '.js', '.css'], maxFiles: 120 });

      // Config/estado crítico (pequeno)
      const dadosFiles = [
        path.join('dados', 'desired.json'),
        path.join('dados', 'perfis.json'),
        path.join('dados', 'status.json'),
        path.join('dados', 'supervisor_state.json'),
        path.join('dados', 'ct_config.json'),
        path.join('dados', 'cidades.json'),
        path.join('dados', 'cidades_coords.json'),
        path.join('dados', 'ua_presets.json'),
        path.join('dados', 'localizacoes.json'),
        path.join('dados', 'atendimento.json')
      ];
      for (const rel of dadosFiles) {
        const src = path.join(ROOT, rel);
        if (!safeStat(src)) continue;
        if (copyFileRetry(src, path.join(curOutDir, rel))) copied++;
      }

      // Issues do sistema (se existir)
      try {
        const iss = path.join(ROOT, 'dados', 'perfis', 'system', 'issues.json');
        if (safeStat(iss) && copyFileRetry(iss, path.join(curOutDir, 'dados', 'perfis', 'system', 'issues.json'))) copied++;
      } catch {}

      // Retenção (mantém os mais recentes)
      try {
        ensureDir(baseDir);
        const dirs = fs.readdirSync(baseDir)
          .map(n => ({ n, p: path.join(baseDir, n) }))
          .filter(x => safeStat(x.p) && safeStat(x.p).isDirectory())
          .sort((a, b) => String(b.n).localeCompare(String(a.n)));
        for (const d of dirs.slice(keep)) {
          try { fs.rmSync(d.p, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch {}
        }
      } catch {}

      try {
        fs.appendFileSync(path.join(baseDir, '_snapshots.log'),
          JSON.stringify({ ts: Date.now(), tag, copied }) + '\n');
      } catch {}
    };

    setTimeout(() => { try { doSnapshot(); } catch {} }, 2500);
    setInterval(() => { try { doSnapshot(); } catch {} }, intervalMin * 60 * 1000).unref?.();
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

// Helpers/pontes
const fileStore = require('./scripts/fileStore.js');

// supervisor interno unificado (importação obrigatória — side effect: inicializa timers ttl/probe)
const supervisor = require('./scripts/supervisor.js');

// Dashboard monitor
const { startDashboardMonitor } = require('./scripts/dashboard.js');

// Inicialização
const app = express();
const PORT = parseInt(process.env.PORT || '8088', 10);

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
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
// Militar: não retomar "Abrir Todos" automaticamente após restart.
// Se existia uma sessão open-all pendurada em desired.json, limpa no boot.
try { fileStore.clearOpenAllOnBoot && fileStore.clearOpenAllOnBoot(); } catch {}
// Militar: se perfis.json sumiu/zerou (crash/lock durante escrita), tente recuperar de _backup_auto antes de criar vazio.
try {
  const r = fileStore.recoverPerfisJsonIfMissingOrEmpty && fileStore.recoverPerfisJsonIfMissingOrEmpty();
  try {
    if (r && r.recovered) logger.warn('[BOOT][RECOVER] perfis.json recovered from backup', r);
  } catch {}
} catch {}
// Militar: purge definitivo no boot — perfis tombstoned (ban/2FA/desativada/excluída) nunca podem reaparecer
// mesmo após recovery/rebuild.
try { fileStore.sweepTombstonesOnBoot && fileStore.sweepTombstonesOnBoot(); } catch {}
// Militar: compat — se existiam flags terminais antigas no manifest (banned/2FA) sem tombstone, purgar também.
try { fileStore.sweepTerminalFlagsOnBoot && fileStore.sweepTerminalFlagsOnBoot(); } catch {}
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

// Boot sequencial: bootstrap -> cluster -> listen
(async () => {
  await maybeBootstrapService();
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

    // <<< INICIA O MONITOR DE TELEMETRIA, EXATAMENTE AQUI >>>
    startDashboardMonitor();
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