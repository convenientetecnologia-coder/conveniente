// scripts/api_robes.js
module.exports = (app, workerClient, fileStore) => {
  const manifestStore = require('./manifestStore.js');
  const logger = require('./logger.js');
  const issues = require('./issues.js');
  const fs = require('fs');
  const path = require('path');
  const serverConfig = require('./serverConfig.js');

  function readJsonSafe(fp, fallback) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
  }

  // Robe 24h (TODOS os perfis) — pausa por 24h cada um
  app.post('/api/robes/pause-24h-all', async (req, res) => {
    logger.info('[ROTA POST /api/robes/pause-24h-all] chamada');
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
            man.robePauseReason = 'manual';
            return man;
          });
          total++;
          if (issues && typeof issues.append === "function") {
            issues.append('system', 'robe_pause_24h', `perfil=${p.nome} ok=true`);
          }
        } catch(e) {
          failed++; fails.push(p.nome);
          if (issues && typeof issues.append === "function") {
            issues.append('system', 'robe_pause_24h', `perfil=${p.nome} ok=false error=${e && e.message || String(e)}`);
          }
        }
      }
      if (failed > 0) {
        logger.warn('Falha em /api/robes/pause-24h-all', { failed, fails });
        res.json({ ok: false, error: `Failure in ${failed} perfil(s)`, fails });
      } else {
        logger.info('Robe 24h todos aplicados', { total });
        res.json({ ok: true, total });
      }
    } catch (e) {
      logger.error('Erro em /api/robes/pause-24h-all', {}, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Robe Release/Play global — libera todos Robe
  app.post('/api/robes/release-all', async (req, res) => {
    logger.info('[ROTA POST /api/robes/release-all] chamada');
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0, failed = 0, fails = [];
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;

        // --- Patch cirúrgico: REMOVE checagem e bloqueio "limit_posting" ---
        // O bloco que limitava a liberação global de perfis em penalidade limit_posting foi removido aqui.

        try {
          await manifestStore.update(p.nome, man => {
            man = man || {};
            man.robeCooldownUntil = Date.now();
            man.robeCooldownRemainingMs = 0;
            if (man.robePauseReason) delete man.robePauseReason;
            return man;
          });
          total++;
          if (issues && typeof issues.append === "function") {
            issues.append('system', 'robe_release_all', `perfil=${p.nome} ok=true`);
          }
        } catch(e) {
          failed++; fails.push(p.nome);
          if (issues && typeof issues.append === "function") {
            issues.append('system', 'robe_release_all', `perfil=${p.nome} ok=false error=${e && e.message || String(e)}`);
          }
        }
      }
      // *** NOVO: chama o comando workerClient para limpar robeMeta.pauseReason e lastRobeBlockAt do lado do worker ***
      try { 
        await workerClient.sendWorkerCommand('robes-release-all', {}, { timeoutMs: 20000 }); 
      } catch(e) {
        // log, mas não bloqueia o fluxo
        if (issues && typeof issues.append === "function") {
          issues.append('system', 'robes_release_all_worker_sync_error', `error=${e && e.message || String(e)}`);
        }
      }
      if (failed > 0 || (fails && fails.length)) {
        logger.warn('Falha em /api/robes/release-all', { failed, fails });
        res.json({ ok: false, error: `Failure in ${failed} perfil(s) or skipped limit_posting: ${fails && fails.length ? fails.join(', ') : ''}`, fails });
      } else {
        logger.info('Robe release all executado', { total });
        res.json({ ok: true, total });
      }
    } catch (e) {
      logger.error('Erro em /api/robes/release-all', {}, e);
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // ===== Robe V2: estado de postagens (último bloco + fila atual) =====
  // UI: dashboard local (public/index.html)
  app.get('/api/robes/v2/postings_state', (req, res) => {
    try {
      const cfg = serverConfig.readServerConfigEffective();
      const workMode = String(cfg && cfg.robe && cfg.robe.workMode || 'v1');
      const DADOS_DIR = path.join(__dirname, '..', 'dados');
      const fp = path.join(DADOS_DIR, 'robe_v2_queue.json');
      const st = readJsonSafe(fp, null);
      const queue = (st && Array.isArray(st.queue)) ? st.queue.map(x => String(x || '').trim()).filter(Boolean) : [];
      const offset = Math.max(0, Math.floor(Number(req.query?.offset || 0) || 0));
      const limit = Math.max(50, Math.min(5000, Math.floor(Number(req.query?.limit || 800) || 800)));
      const slice = queue.slice(offset, offset + limit);
      const consumedTotal = st ? (Math.max(0, Number(st.consumedTotal || 0) || 0)) : 0;
      const lastBlockStartAt = st ? (Math.max(0, Number(st.lastBlockStartAtConsumedTotal || 0) || 0)) : 0;
      const lastBlockLen = st ? (Math.max(0, Number(st.lastBlockQueueLen || 0) || 0)) : 0;
      const lastBlock = (st && st.lastBlock && typeof st.lastBlock === 'object') ? st.lastBlock : null;
      const consumedInLastBlock = Math.max(0, Math.min(lastBlockLen, consumedTotal - lastBlockStartAt));
      const remainingInLastBlock = Math.max(0, lastBlockLen - consumedInLastBlock);

      return res.json({
        ok: true,
        ts: Date.now(),
        workMode,
        hasStateFile: !!st,
        statePath: fp,
        regenPending: !!(st && st.regenPending),
        failures: (st && st.failures) ? st.failures : null,
        meta: (st && st.meta && typeof st.meta === 'object') ? st.meta : null,
        queueTotal: queue.length,
        queuePage: { offset, limit, returned: slice.length },
        queue: slice,
        consumedTotal,
        lastBlock: lastBlock ? {
          ...lastBlock,
          queueLen: lastBlockLen,
          startAtConsumedTotal: lastBlockStartAt,
          consumed: consumedInLastBlock,
          remaining: remainingInLastBlock
        } : null
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });

  // Robe V2: forçar recálculo do plano/fila (dashboard local)
  app.post('/api/robes/v2/recalc', async (req, res) => {
    try {
      if (!workerClient || typeof workerClient.sendWorkerCommand !== 'function') {
        return res.json({ ok: false, error: 'worker_client_unavailable' });
      }
      const operator = String(req.headers['x-operator'] || 'dashboard').slice(0, 180);
      const r = await workerClient.sendWorkerCommand('robe-v2-warmup', {
        reason: `dashboard_recalc:${operator}`,
        force: true
      }, { timeoutMs: 60000 });
      if (!r || r.ok !== true) {
        return res.json({ ok: false, error: (r && r.error) ? String(r.error) : 'robe_v2_recalc_failed', result: r || null });
      }
      return res.json({ ok: true, result: r || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
    }
  });
};