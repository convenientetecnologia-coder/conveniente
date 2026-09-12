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
      const cellLifecycle = require('./cellLifecycle.js');
      const livePids = cellLifecycle.listLiveCellPids();
      const liveSet = new Set(livePids.map((n) => Number(n)));
      const want = cellLifecycle.wantedCellCount();
      const reg = cellRegistry.read();
      const cells = (reg.cells || []).filter((c) => liveSet.has(Number(c && c.pid))).map((c) => ({
        id: c.id,
        idx: c.idx,
        pid: c.pid,
        port: c.port,
        shard: Array.isArray(c.shard) ? c.shard.length : 0,
        alive: true,
        statusFile: c.statusFile || null,
        updatedAt: c.updatedAt || null
      }));
      for (const pid of livePids) {
        if (cells.some((c) => Number(c.pid) === Number(pid))) continue;
        cells.push({
          id: cells.length + 1,
          idx: cells.length,
          pid,
          port: null,
          shard: 0,
          alive: true,
          statusFile: null,
          updatedAt: null
        });
      }
      res.json({
        ok: true,
        maestroPid: reg.maestroPid || null,
        maestroAlive: cellRegistry.pidAlive(reg.maestroPid),
        basePort: reg.basePort,
        codeStamp: reg.codeStamp || null,
        topology: reg.topology || null,
        cells,
        alive: livePids.length,
        want,
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
      const cellLifecycle = require('./cellLifecycle.js');
      try { require('./bootIntent.js').setHumanHold({ reason: 'stop_workers', by: 'api_cells_stop' }); } catch {}
      try { cellLifecycle.setCellsStopped(true); } catch {}
      try {
        await fileStore.resetDesiredAllOffOnBoot({ reason: 'api_cells_stop' });
      } catch {}
      try { require('./provisionLock.js').release({ force: true }); } catch {}
      try {
        if (workerClient && typeof workerClient.haltRespawn === 'function') workerClient.haltRespawn();
        else if (workerClient && typeof workerClient.beginStop === 'function') workerClient.beginStop();
      } catch {}
      let r = cellLifecycle.stopAllCells({ reason: 'api_cells_stop' });
      try {
        await fileStore.resetDesiredAllOffOnBoot({ reason: 'api_cells_stop' });
      } catch {}
      try { cellLifecycle.setCellsStopped(true); } catch {}
      try {
        if (workerClient && typeof workerClient.haltRespawn === 'function') workerClient.haltRespawn();
        else if (workerClient && typeof workerClient.beginStop === 'function') workerClient.beginStop();
      } catch {}
      const r2 = cellLifecycle.stopAllCells({ reason: 'api_cells_stop_reap' });
      const chromeKilled = (Number(r && r.chromeKilled) || 0) + (Number(r2 && r2.chromeKilled) || 0);
      try {
        require('./cellForensic.js').append('cell_encerrar_done', {
          firstOk: !!(r && r.ok),
          ok: !!(r2 && r2.ok),
          alive: r2 && r2.alive,
          want: r2 && r2.want,
          chromeKilled
        });
      } catch {}
      return res.json(Object.assign({ maestroStays: true, cancelledOpenAll: true }, r2 || r || {}, {
        requested: Math.max(Number(r && r.requested) || 0, Number(r2 && r2.requested) || 0),
        chromeKilled,
        firstPassOk: !!(r && r.ok),
        ok: !!(r2 && r2.ok)
      }));
    } catch (e) {
      return res.json({ ok: false, error: e && e.message || String(e), maestroStays: true });
    }
  });
};