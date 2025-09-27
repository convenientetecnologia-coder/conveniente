// scripts/api_issues.js
const path = require('path');
const issues = require('./issues'); // Adicionado para uso do método issues.clear

const isValidSlug = s => typeof s === 'string' && /^[a-z0-9_-]+$/.test(s);

function assertSafePerfilDir(fileStore, nome) {
  if (!isValidSlug(nome)) throw new Error('nome invalido');
  const perfis = fileStore.loadPerfisJson();
  if (!perfis.find(p => p && p.nome === nome)) throw new Error('perfil inexistente');
  const dir = path.resolve(path.join(fileStore.perfisDir, nome));
  const root = path.resolve(fileStore.perfisDir);
  if (!dir.startsWith(root + path.sep)) throw new Error('path invalido');
  return dir;
}

module.exports = (app, workerClient, fileStore) => {
  // GET /api/perfis/:nome/issues — lista as issues/logs desse perfil
  app.get('/api/perfis/:nome/issues', (req, res) => {
    try {
      const nome = req.params.nome;
      if (!nome) return res.json({ ok: false, error: 'nome ausente' });
      assertSafePerfilDir(fileStore, nome);
      const file = path.join(fileStore.perfisDir, nome, 'issues.json');
      const arr = fileStore.readJsonSafe(file, []);
      res.json({ ok: true, issues: Array.isArray(arr) ? arr : [], file });
    } catch (e) {
      res.json({ ok: false, issues: [], error: e && e.message || String(e) });
    }
  });

  // Limpar issues deve SEMPRE usar await issues.clear(nome) para garantir atomicidade/lock.
  // DELETE /api/perfis/:nome/issues — limpa o arquivo de issues desse perfil
  app.delete('/api/perfis/:nome/issues', async (req, res) => {
    try {
      const nome = req.params.nome;
      if (!nome) return res.json({ ok: false, error: 'nome ausente' });
      assertSafePerfilDir(fileStore, nome);
      await issues.clear(nome);
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};