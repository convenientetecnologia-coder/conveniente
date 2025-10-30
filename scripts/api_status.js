// api_status
// Militar: responde autoMode/sys originais do worker/status.json. Nunca remova, nunca altere shape.

module.exports = (app, workerClient, fileStore) => {
// FUTURO: endpoint /api/status será servido/encaminhado pelo Supervisor externo (será preferencialmente o status do Supervisor, não do Worker direto)
// GET /api/status — sempre tenta worker primeiro, fallback em arquivo
app.get('/api/status', async (req, res) => {
  try {

    // ======= INÍCIO DA INSTRUÇÃO/ALTERAÇÃO PEDIDA =======
    // GET /api/status — FAST-LANE sempre por arquivo local (baixa latência garantida)
    const fs = require('fs');
    const path = require('path');
    const statusPath = path.join(__dirname, '..', 'dados', 'status.json');
    const nodesDir = path.join(__dirname, '..', 'dados');

    // 1) status.json agregado (primeira linha)
    try {
      if (fs.existsSync(statusPath)) {
        const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        if (st && typeof st === 'object') return res.json(st);
      }
    } catch {}

    // 2) Fallback: merge dos status_node_*.json (todos nodes)
    try {
      const files = fs.readdirSync(nodesDir).filter(n => /^status_node_\d+.json$/i.test(n));
      const basePerfisArr = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(nodesDir, 'perfis.json'), 'utf8')) || []; }
        catch { return []; }
      })();
      const baseMap = new Map(basePerfisArr.map(p => [p.nome, {
        nome: p.nome,
        label: p.label || null,
        cidade: p.cidade,
        uaPresetId: p.uaPresetId,
        active: false, trabalhando: false, configurando: false, humanControl: false, issuesCount: 0,
        ramMB: null, cpuPercent: null, numPages: null, robeEstado: null, robeCooldownSec: null,
        robeFrozenUntil: null, frozenReason: null, frozenAt: null, frozenSetBy: null,
        activationHeldUntil: null, reopenAt: null, openBackoffMs: null, lastSwapAt: null, lastSwapPeer: null,
        swapCooldown: null, whyNotOpen: null, manifestStatus: null, closingReason: null, isFrozen: false
      }]));
      let combinedRobes = {};
      let combinedQueue = [];
      let sysPick = null;
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(nodesDir, f), 'utf8'));
          if (!j || typeof j !== 'object') continue;
          const perf = Array.isArray(j.perfis) ? j.perfis : [];
          for (const o of perf) {
            const dst = baseMap.get(o && o.nome);
            if (dst) Object.assign(dst, o);
          }
          if (j.robes && typeof j.robes === 'object') {
            combinedRobes = Object.assign(combinedRobes, j.robes);
          }
          if (Array.isArray(j.robeQueue)) {
            combinedQueue.push(...j.robeQueue);
          }
          if (!sysPick && j.sys) sysPick = j.sys;
        } catch {}
      }
      if (combinedQueue.length) {
        const seen = new Set();
        combinedQueue = combinedQueue.filter(n => {
          if (!n || seen.has(n)) return false;
          seen.add(n); return true;
        });
      }
      const out = {
        perfis: Array.from(baseMap.values()),
        robes: combinedRobes,
        robeQueue: combinedQueue,
        sys: sysPick || {
          freeMB: Math.round(require('os').freemem()/(1024*1024)),
          totalMB: Math.round(require('os').totalmem()/(1024*1024)),
          cores: (require('os').cpus()||[]).length
        },
        ts: Date.now()
      };
      return res.json(out);
    } catch (e) {}

    // 3) Fallback duro: só baseline
    const perfisArr = fileStore.loadPerfisJson() || [];
    res.json({
      perfis: perfisArr,
      robes: {},
      robeQueue: [],
      ts: Date.now(),
      warning: "sem status local nos arquivos"
    });

    // ======= FIM DA INSTRUÇÃO/ALTERAÇÃO PEDIDA =======

  } catch (e) {
    res.json({
      perfis: [],
      robes: {},
      robeQueue: [],
      ts: Date.now(),
      error: String(e && e.message || e)
    });
  }
});

// ATENÇÃO: nunca altere o shape de resposta deste endpoint, nem remova campos esperados pelo painel! Fallbacks SEMPRE devem garantir compatibilidade retroativa.

// Militar: retorna shape exato esperado pelo painel — { mem: {...}, cpu: {...} }
// Mantenha extras apenas como extensão, mas NUNCA altere/remova mem/cpu.
app.get('/api/sys', async (req, res) => {
  try {
    const os = require('os');
    // 1) Tenta overlay agregado do cluster (get-status)
    let overlay = null;
    try {
      overlay = await workerClient.sendWorkerCommand('get-status', {}, { timeoutMs: 8000 });
    } catch {}

    // 2) Se overlay OK, compute CPU a partir de overlay.robes[*].cpuPercent
    if (overlay && overlay.robes && typeof overlay.robes === 'object') {
      let somaCpu = 0;
      let count = 0;
      for (const nome in overlay.robes) {
        const v = overlay.robes[nome] && overlay.robes[nome].cpuPercent;
        if (typeof v === 'number') { somaCpu += v; count++; }
      }
      const cores = (os.cpus() || []).length || 1;
      const cpuPercent = (count > 0) ? Math.min(100, Math.round(somaCpu / cores)) : null;

      const totalBytes = os.totalmem();
      const freeBytes  = os.freemem();
      const usedBytes  = totalBytes - freeBytes;
      const toMB = (b) => Math.round(b / (1024*1024));
      const toGB = (b) => Math.round(b / (1024*1024*10)) / 100; // duas casas

      const mem = {
        totalBytes,
        freeBytes,
        usedBytes,
        totalMB: toMB(totalBytes),
        freeMB:  toMB(freeBytes),
        usedMB:  toMB(usedBytes),
        totalGB: toGB(totalBytes),
        freeGB:  toGB(freeBytes),
        usedGB:  toGB(usedBytes),
        minFreeRequiredMB: parseInt(process.env.MIN_FREE_RAM_MB || '1536', 10)
      };
      return res.json({ ok: true, mem, cpu: { percent: cpuPercent }, ts: Date.now() });
    }

    // 3) Fallback: fileStore.getSysMetricsSnapshot() (mantém retrocompatibilidade)
    const snap = fileStore.getSysMetricsSnapshot();
    return res.json(snap);

  } catch (e) {
    res.json({ ok: false, error: e && e.message || String(e) });
  }
});
};