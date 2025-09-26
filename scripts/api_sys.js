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
};