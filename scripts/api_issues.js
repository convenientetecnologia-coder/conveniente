// scripts/api_issues.js
module.exports = (app, workerClient, fileStore) => {
  // GET /api/perfis/:nome/issues — lista as issues/logs desse perfil
  app.get('/api/perfis/:nome/issues', (req, res) => {
    try {
      const nome = req.params.nome;
      if (!nome) return res.json({ ok: false, error: 'nome ausente' });
      const file = require('path').join(fileStore.perfisDir, nome, 'issues.json');
      const arr = fileStore.readJsonSafe(file, []);
      res.json({ ok: true, issues: Array.isArray(arr) ? arr : [], file });
    } catch (e) {
      res.json({ ok: false, issues: [], error: e && e.message || String(e) });
    }
  });

  // DELETE /api/perfis/:nome/issues — limpa o arquivo de issues desse perfil
  app.delete('/api/perfis/:nome/issues', (req, res) => {
    try {
      const nome = req.params.nome;
      if (!nome) return res.json({ ok: false, error: 'nome ausente' });
      const file = require('path').join(fileStore.perfisDir, nome, 'issues.json');
      fileStore.writeJsonAtomic(file, []);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};