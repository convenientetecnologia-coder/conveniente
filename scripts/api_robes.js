// scripts/api_robes.js
module.exports = (app, workerClient, fileStore) => {
  const manifestStore = require('./manifestStore.js');

  // Robe 24h (TODOS os perfis) — pausa por 24h cada um
  app.post('/api/robes/pause-24h-all', async (req, res) => {
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0, failed = 0, fails = [];
      const plus24 = 24 * 60 * 60 * 1000;
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        try {
          await manifestStore.update(p.nome, man => {
            const now = Date.now();
            man = man || {};
            man.robeCooldownUntil = now + plus24;
            man.robeCooldownRemainingMs = 0;
            return man;
          });
          total++;
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_pause_24h', perfil: p.nome, ok: true, ts: Date.now() });
          }
        } catch(e) {
          failed++; fails.push(p.nome);
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_pause_24h', perfil: p.nome, ok: false, error: e && e.message || String(e), ts: Date.now() });
          }
        }
      }
      if (failed > 0) {
        res.json({ ok: false, error: `Failure in ${failed} perfil(s)`, fails });
      } else {
        res.json({ ok: true, total });
      }
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Robe Release/Play global — libera todos Robe
  app.post('/api/robes/release-all', async (req, res) => {
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0, failed = 0, fails = [];
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        try {
          await manifestStore.update(p.nome, man => {
            man = man || {};
            man.robeCooldownUntil = Date.now();
            man.robeCooldownRemainingMs = 0;
            return man;
          });
          total++;
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_release_all', perfil: p.nome, ok: true, ts: Date.now() });
          }
        } catch(e) {
          failed++; fails.push(p.nome);
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_release_all', perfil: p.nome, ok: false, error: e && e.message || String(e), ts: Date.now() });
          }
        }
      }
      if (failed > 0) {
        res.json({ ok: false, error: `Failure in ${failed} perfil(s)`, fails });
      } else {
        res.json({ ok: true, total });
      }
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};