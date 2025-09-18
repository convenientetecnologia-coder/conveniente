// scripts/api_cidades.js
const fs = require('fs');
const path = require('path');

module.exports = (app, workerClient, fileStore) => {
  // Listar cidades (GET /api/cidades) — retorna sempre array de nomes (strings)
  app.get('/api/cidades', (req, res) => {
    try {
      const cidadesPath = path.join(fileStore.dadosDir, 'cidades.json');
      if (fs.existsSync(cidadesPath)) {
        const raw = JSON.parse(fs.readFileSync(cidadesPath, 'utf8'));
        // Transforma em array de strings, seja string, objeto, etc
        const arr = Array.isArray(raw)
          ? raw.map(c =>
              typeof c === 'string'
                ? c
                : (c && typeof c === 'object')
                  ? (c.nome || c.label || c.id || '').toString()
                  : ''
            ).filter(Boolean)
          : [];
        res.json({ ok: true, cidades: arr });
        return;
      }
      res.json({ ok: true, cidades: [] });
    } catch (e) {
      res.json({ ok: false, cidades: [], error: e && e.message || String(e) });
    }
  });

  // Contagem de cidades (GET /api/cidades/contagem) — sem alteração, mantém robustez
  app.get('/api/cidades/contagem', (req, res) => {
    try {
      const perfisArr = fileStore.loadPerfisJson();
      const counts = {};
      for (const p of perfisArr) {
        const cid = (p && p.cidade) ? String(p.cidade).trim() : '';
        const key = cid || '—';
        counts[key] = (counts[key] || 0) + 1;
      }
      // Carrega cidades conhecidas do arquivo
      const cidadesPath = path.join(fileStore.dadosDir, 'cidades.json');
      let known = [];
      try {
        if (fs.existsSync(cidadesPath)) {
          const raw = JSON.parse(fs.readFileSync(cidadesPath, 'utf8'));
          if (Array.isArray(raw)) {
            known = raw.map(x => (
              typeof x === 'string'
                ? x
                : (x && typeof x === 'object')
                  ? (x.nome || x.label || x.id || '').toString()
                  : ''
            )).filter(Boolean);
          }
        }
      } catch {}
      const cidadesSet = new Set([...Object.keys(counts), ...known].filter(Boolean));
      const contagens = Array.from(cidadesSet).map(cidade => ({
        cidade,
        count: counts[cidade] || 0
      })).sort((a, b) =>
        a.cidade.localeCompare(b.cidade, 'pt-BR', { sensitivity: 'base' })
      );
      res.json({
        ok: true,
        contagens,
        totalPerfis: perfisArr.length,
        totalCidadesComPerfil: Object.keys(counts).length
      });
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};