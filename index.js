// index.js (main do projeto, pasta principal)
const express = require('express');
const path = require('path');
const cors = require('cors');
// const bodyParser = require('body-parser'); // Não é necessário, pois estamos usando express.json/express.urlencoded
const open = require('open'); // <-- adicione/mova isso aqui!

// Inclua o logger imediatamente após os requires principais
const logger = require('./scripts/logger.js');

// Helpers/pontes
const fileStore = require('./scripts/fileStore.js');

// supervisor interno unificado (importação obrigatória — side effect: inicializa timers ttl/probe)
const supervisor = require('./scripts/supervisor.js');

// Dashboard monitor
const { startDashboardMonitor } = require('./scripts/dashboard.js');

// Inicialização
const app = express();
const PORT = parseInt(process.env.PORT || '8088', 10);

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
  const isLocalReq = (req.ip === '127.0.0.1' || req.hostname === 'localhost');
  if (
    allowedOrigins.includes(origin) ||
    (!origin && isLocalReq)
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
app.use('/', express.static(path.join(__dirname, 'public')));
// NUNCA PERMITIDO: exposição de scripts ou backend!
// app.use('/', express.static(path.join(__dirname, 'scripts')));
// app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

// ===================== CLUSTER MULTI-NODE =====================
let clusterClient = null;
(async () => {
  const { createCluster } = require('./scripts/clusterMaster.js');
  logger.info('[BOOT] Construindo cluster multi-node (auto)...');
  clusterClient = createCluster(); // { plan, children, sendWorkerCommand, kill }
  logger.info('[BOOT] Cluster OK: nodes=' + clusterClient.plan.nodes + ' perNodeMax=' + clusterClient.plan.perNode.maxChromes);
})();
// ===================== FIM CLUSTER MULTI-NODE =====================

// API endpoints (militar por arquivo de rota, modular, fácil de achar)
const apiClient = { sendWorkerCommand: (...args) => clusterClient.sendWorkerCommand(...args) };
require('./scripts/api_status.js')(app, apiClient, fileStore);
require('./scripts/api_perfis.js')(app, apiClient, fileStore);
require('./scripts/api_robes.js')(app, apiClient, fileStore);
require('./scripts/api_cidades.js')(app, apiClient, fileStore);
require('./scripts/api_sys.js')(app, apiClient, fileStore);
require('./scripts/api_issues.js')(app, apiClient, fileStore);
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