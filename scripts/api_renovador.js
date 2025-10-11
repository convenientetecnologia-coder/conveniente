\\ api_renovador.js

'use strict';

const issues = require('./issues.js');

module.exports = (app, workerClient, fileStore) => {
// POST /api/renovador/global — dispara renovação global
app.post('/api/renovador/global', async (req, res) => {
try {
try { await issues.append('system', 'admin_renovador_global_request', 'api'); } catch {}
const r = await workerClient
.sendWorkerCommand('renovador_global', {}, { timeoutMs: 5400000 }) // 90 minutos (watchdog global)
.catch(() => null);
if (!r) return res.json({ ok: false, error: 'worker_timeout' });
return res.json(r);
} catch (e) {
return res.json({ ok: false, error: (e && e.message) || String(e) });
}
});

// GET /api/renovador/status — retorna somente o objeto "renovador" do status global
app.get('/api/renovador/status', async (req, res) => {
try {
const s = await workerClient
.sendWorkerCommand('get-status', {}, { timeoutMs: 10000 })
.catch(() => null);
return res.json({ ok: true, renovador: (s && s.renovador) || null });
} catch (e) {
return res.json({ ok: false, error: (e && e.message) || String(e) });
}
});
};