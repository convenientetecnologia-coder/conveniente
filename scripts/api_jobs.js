// scripts/api_jobs.js
module.exports = (app, workerClient, fileStore, jobManager) => {

  // GET /api/jobs — lista (padrão último 100) com filtros status, perfil, type, limit
  app.get('/api/jobs', (req, res) => {
    try {
      const { status, perfil, type, limit } = req.query || {};
      const jobs = jobManager.getJobs({ status, perfil, type, limit: limit ? parseInt(limit,10) : 100 });
      res.json({ ok:true, jobs });
    } catch (e) {
      res.json({ ok:false, error: e && e.message || String(e) });
    }
  });

  // GET /api/jobs/queue — backlog: jobs pendentes/running (não finalizados)
  app.get('/api/jobs/queue', (req, res) => {
    try {
      const queue = jobManager.getBacklog();
      res.json({ ok:true, queue });
    } catch (e) {
      res.json({ ok:false, error: e && e.message || String(e) });
    }
  });

  // GET /api/jobs/:id — detalhes de um job específico
  app.get('/api/jobs/:id', (req, res) => {
    try {
      const job = jobManager.getJob(req.params.id);
      if (!job) return res.json({ ok:false, error:'job_not_found'});
      res.json({ ok:true, job });
    } catch (e) {
      res.json({ ok:false, error: e && e.message || String(e) });
    }
  });

  // POST /api/jobs/:id/cancel — cancelar job pendente/running (se suportado)
  app.post('/api/jobs/:id/cancel', (req, res) => {
    try {
      const ok = jobManager.cancelJob(req.params.id, 'cancel_api');
      res.json({ ok });
    } catch (e) {
      res.json({ ok:false, error: e && e.message || String(e) });
    }
  });

};