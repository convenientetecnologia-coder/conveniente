// scripts/api_sys.js
const fs = require('fs');
const path = require('path');

// Militar: nenhuma rota duplicada. Só fotos aqui. /api/sys fica em api_status.js.

module.exports = (app, workerClient, fileStore) => {
  // GET /api/fotos/count — contagem de fotos disponíveis
  app.get('/api/fotos/count', (req, res) => {
    try {
      const fotosMod = require('./fotos.js');
      const dir = fotosMod.resolveFotosDir();
      let count = 0;
      let list = [];
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
        count = list.filter(ent => ent.isFile() && /.(jpe?g|png)$/i.test(ent.name)).length;
      } catch {}
      res.json({ ok: true, dir, count });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // === ROTAS DE BOOT (militar ultra robusto) ===

  // POST /api/boot/start — inicia boot sequencial e suspende watchdog
  app.post('/api/boot/start', async (req, res) => {
    try {
      // Suspende o watchdog por 10 minutos (ajuste conforme regra)
      workerClient.suspendWatchdogFor(10*60*1000);
      // Envia comando boot-start ao worker
      const resp = await workerClient.sendWorkerCommand('boot-start', req.body || {}, { timeoutMs: 60000 });
      res.json(resp);
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // GET /api/boot/state — retorna o estado do boot do worker
  app.get('/api/boot/state', async (req, res) => {
    try {
      const resp = await workerClient.sendWorkerCommand('boot-state', {}, { timeoutMs: 4000 });
      res.json(resp);
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // POST /api/boot/cancel — cancela o boot e libera watchdog
  app.post('/api/boot/cancel', async (req, res) => {
    try {
      workerClient.clearWatchdogSuspension();
      const resp = await workerClient.sendWorkerCommand('boot-cancel', {}, { timeoutMs: 8000 });
      res.json(resp);
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

};