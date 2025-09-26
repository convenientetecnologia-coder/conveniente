// index.js (main do projeto, pasta principal)
const express = require('express');
const path = require('path');
const cors = require('cors');
// const bodyParser = require('body-parser'); // Não é necessário, pois estamos usando express.json/express.urlencoded
const open = require('open'); // <-- adicione/mova isso aqui!

// Helpers/pontes
const workerClient = require('./scripts/workerClient.js');
const fileStore = require('./scripts/fileStore.js');

// ======= INÍCIO DAS ALTERAÇÕES PARA INTEGRAÇÃO DO JOB MANAGER GLOBAL =======
const jobManager = require('./scripts/jobManager.js');
// ======= FIM DA IMPORTAÇÃO DO JOB MANAGER =======

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
  if (
    !origin || // Electron/localfile (origin undefined)
    allowedOrigins.includes(origin)
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

// ===================== (REMOVIDO) Middleware de autenticação =====================
/*
 * [REMOVIDO POR INSTRUÇÃO DO USUÁRIO]
 * Middleware de autenticação obrigatória para rotas /api/
 * - ADMIN_TOKEN DEVE estar presente como variável de ambiente.
 * - Nunca deixe vazio em produção!
 * - Exceções: /api/health e arquivos estáticos de /public/
 */
// ---> Recomenda-se export ADMIN_TOKEN no ambiente ou .env (NÃO use vazio em produção).

// const isDevEnv = (process.env.NODE_ENV === 'development');
// const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// // Panic/exit se token não estiver presente em produção
// if (!ADMIN_TOKEN && !isDevEnv) {
//   console.error('[FATAL] ADMIN_TOKEN não definido. Defina como export/env/.env e reinicie.');
//   process.exit(1);
// }

// function apiAuthMiddleware(req, res, next) {
//   // Libera health check sem auth
//   if (
//     req.path === '/api/health' || 
//     req.path === '/health' || 
//     // Libera acesso a arquivos estáticos em /public/
//     req.path.startsWith('/public/') ||
//     req.path.startsWith('/static/') ||
//     req.path.startsWith('/favicon.ico')
//   ) {
//     return next();
//   }
//   // Exige bearer token nas rotas /api/*
//   if (req.path.startsWith('/api/')) {
//     const authHeader = req.headers.authorization || '';
//     const token = authHeader.split(' ')[1];
//     if (authHeader.startsWith('Bearer ') && token === ADMIN_TOKEN) {
//       return next();
//     }
//     // Token inválido, responde 401
//     return res.status(401).json({ error: 'Unauthorized: token inválido ou ausente' });
//   }
//   // Fora de /api, libera normalmente
//   return next();
// }
// app.use(apiAuthMiddleware);
// ===================== Fim do middleware de autenticação =====================

// Militar: Apenas arquivos públicos (UI) expostos. Backend nunca via HTTP!
// SERVIÇO ESTÁTICO EXCLUSIVO DA PASTA /public/
app.use('/', express.static(path.join(__dirname, 'public')));
// NUNCA PERMITIDO: exposição de scripts ou backend!
// app.use('/', express.static(path.join(__dirname, 'scripts')));
// app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

// ======= INÍCIO INICIALIZAÇÃO DO JOB MANAGER (após requires e helpers, antes das rotas) =======
console.log('[BOOT] Garantindo arquivos base...');
fileStore.ensureDesired();
fileStore.ensurePerfisJson();

// Política de reset: (descomente se desejar sempre “start fresh”)
// fileStore.resetDesiredAllOffOnBoot();

console.log('[BOOT] Spawning worker (automação)...');
workerClient.fork();

// Inicializa o Job Manager após o workerClient.fork()
console.log('[BOOT] Inicializando Job Manager...');
jobManager.init(workerClient);
// ======= FIM INICIALIZAÇÃO DO JOB MANAGER =======

// API endpoints (militar por arquivo de rota, modular, fácil de achar)
require('./scripts/api_status.js')(app, workerClient, fileStore);
require('./scripts/api_perfis.js')(app, workerClient, fileStore);
require('./scripts/api_robes.js')(app, workerClient, fileStore);
require('./scripts/api_cidades.js')(app, workerClient, fileStore);
require('./scripts/api_sys.js')(app, workerClient, fileStore);
require('./scripts/api_issues.js')(app, workerClient, fileStore);
// Se usar api_static.js/adicional, inclua aqui: require('./scripts/api_static.js')(app);

// ======= INÍCIO DA INCLUSÃO DA NOVA ROTA DE JOBS PARA A API =======
require('./scripts/api_jobs.js')(app, workerClient, fileStore, jobManager);
// ======= FIM DA INCLUSÃO DA NOVA ROTA DE JOBS PARA A API =======

// Health check endpoint (opcional)
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Start server
app.listen(PORT, () => {
  console.log(`[START] Painel admin disponível em http://localhost:${PORT}/index.html`);
  console.log('[SECURE] Servindo apenas arquivos de public/, backend protegido.');
});

// Tenta abrir sempre o painel no Chromium azul
setTimeout(() => {
  // const open = require('open'); // <-- NÃO mais necessário aqui, pois subiu para o topo conforme instrução!
  // Defina o caminho certo para o Chromium azul instalado
  // Exemplos comuns:
  // - Windows: 'C:\\Program Files\\Chromium\\Application\\chrome.exe'
  // - Linux:   '/usr/bin/chromium-browser' ou '/usr/bin/chromium'
  // - Mac:     '/Applications/Chromium.app/Contents/MacOS/Chromium'
  const chromiumPaths = [
    'C:\\Users\\PC\\AppData\\Local\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ];
  const painelUrl = `http://localhost:${PORT}/index.html`;

  // Tenta com todos os caminhos possíveis até abrir
  (async () => {
    let opened = false;
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
      console.log('[WARN] Não foi possível abrir automaticamente no Chromium. Abra manualmente:', painelUrl);
    }
  })();
}, 1200); // Delay de 1.2s para garantir o servidor up antes do browser abrir

// Graceful shutdown — encerra worker e faz cleanup
process.on('SIGINT', async () => {
  console.log('[STOP] SIGINT recebido. Encerrando...');
  try {
    // Descomente se quiser resetar contas ao sair
    // fileStore.resetDesiredAllOffOnBoot();
    await workerClient.kill();
  } catch(e) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[STOP] SIGTERM recebido. Encerrando...');
  try {
    // Descomente se quiser resetar contas ao sair
    // fileStore.resetDesiredAllOffOnBoot();
    await workerClient.kill();
  } catch(e) {}
  process.exit(0);
});