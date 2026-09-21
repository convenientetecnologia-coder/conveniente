// scripts/api_cidades.js
const countryGeo = require('./countryGeo.js');

module.exports = (app, workerClient, fileStore) => {
  // Listar cidades (GET /api/cidades) — catálogo do país salvo no servidor
  app.get('/api/cidades', (req, res) => {
    try {
      const pack = countryGeo.describeDataPack();
      const arr = countryGeo.listCities();
      res.json({
        ok: true,
        cidades: arr,
        country: pack.id,
        files: {
          cities: pack.citiesFile,
          coords: pack.coordsFile,
          locations: pack.locationsFile
        }
      });
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
      let known = [];
      try { known = countryGeo.listCities(); } catch { known = []; }
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