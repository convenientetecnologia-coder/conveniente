// index.js (main do projeto, pasta principal)
const express = require('express');
const path = require('path');
const cors = require('cors');
// const bodyParser = require('body-parser'); // Não é necessário, pois estamos usando express.json/express.urlencoded
const open = require('open'); // <-- adicione/mova isso aqui!

// Helpers/pontes
const workerClient = require('./scripts/workerClient.js');
const fileStore = require('./scripts/fileStore.js');

// Inicialização
const app = express();
const PORT = parseInt(process.env.PORT || '8088', 10);

// Middlewares padrão
app.use(cors()); // Se quiser restringir depois, ajuste!
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Militar: Apenas arquivos públicos (UI) expostos. Backend nunca via HTTP!
// SERVIÇO ESTÁTICO EXCLUSIVO DA PASTA /public/
app.use('/', express.static(path.join(__dirname, 'public')));
// NUNCA PERMITIDO: exposição de scripts ou backend!
// app.use('/', express.static(path.join(__dirname, 'scripts')));
// app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

// API endpoints (militar por arquivo de rota, modular, fácil de achar)
require('./scripts/api_status.js')(app, workerClient, fileStore);
require('./scripts/api_perfis.js')(app, workerClient, fileStore);
require('./scripts/api_robes.js')(app, workerClient, fileStore);
require('./scripts/api_cidades.js')(app, workerClient, fileStore);
require('./scripts/api_sys.js')(app, workerClient, fileStore);
require('./scripts/api_issues.js')(app, workerClient, fileStore);
// Se usar api_static.js/adicional, inclua aqui: require('./scripts/api_static.js')(app);

console.log('[BOOT] Garantindo arquivos base...');
fileStore.ensureDesired();
fileStore.ensurePerfisJson();

// Política de reset: (descomente se desejar sempre “start fresh”)
// fileStore.resetDesiredAllOffOnBoot();

console.log('[BOOT] Spawning worker (automação)...');
workerClient.fork();

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