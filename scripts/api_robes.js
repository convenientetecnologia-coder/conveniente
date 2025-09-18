// scripts/api_robes.js
module.exports = (app, workerClient, fileStore) => {
  // Robe 24h (TODOS os perfis) — pausa por 24h cada um
  app.post('/api/robes/pause-24h-all', async (req, res) => {
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0;
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        fileStore.patchDesired(p.nome, { robePause24h: true });
        total++;
      }
      res.json({ ok: true, total });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Robe Release/Play global — libera todos Robe
  app.post('/api/robes/release-all', async (req, res) => {
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0;
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        fileStore.patchDesired(p.nome, { robePlay: true });
        total++;
      }
      res.json({ ok: true, total });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};