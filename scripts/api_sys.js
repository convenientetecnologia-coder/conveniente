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

  app.get('/api/cells', (req, res) => {
    try {
      const cellRegistry = require('./cellRegistry.js');
      const reg = cellRegistry.read();
      const cells = (reg.cells || []).map((c) => ({
        id: c.id,
        idx: c.idx,
        pid: c.pid,
        port: c.port,
        shard: Array.isArray(c.shard) ? c.shard.length : 0,
        alive: cellRegistry.pidAlive(c.pid),
        statusFile: c.statusFile || null,
        updatedAt: c.updatedAt || null
      }));
      res.json({
        ok: true,
        maestroPid: reg.maestroPid || null,
        maestroAlive: cellRegistry.pidAlive(reg.maestroPid),
        basePort: reg.basePort,
        codeStamp: reg.codeStamp || null,
        topology: reg.topology || null,
        cells,
        alive: cells.filter((c) => c.alive).length,
        updatedAt: reg.updatedAt || null
      });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  app.post('/api/cells/stop', async (req, res) => {
    const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
    if (body.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirm_required' });
    }
    try {
      if (workerClient && typeof workerClient.kill === 'function') {
        await workerClient.kill();
      }
    } catch {}
    try {
      try { require('./bootIntent.js').setHumanHold({ reason: 'stop_workers', by: 'api_cells_stop' }); } catch {}
      const cellLifecycle = require('./cellLifecycle.js');
      const r = cellLifecycle.stopAllCells({ reason: 'api_cells_stop' });
      return res.json(Object.assign({ maestroStays: true }, r));
    } catch (e) {
      return res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};