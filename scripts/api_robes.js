// scripts/api_robes.js
module.exports = (app, workerClient, fileStore) => {
  const manifestStore = require('./manifestStore.js');
  const logger = require('./logger.js');
  const issues = require('./issues.js');
  const fs = require('fs');
  const path = require('path');
  const serverConfig = require('./serverConfig.js');
  const { releaseRobeCooldownForOperator } = require('./robeManualRelease.js');

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
            if (man.robeAwaitingEnqueue) delete man.robeAwaitingEnqueue;
            if (man.robeAwaitingEnqueueAt) delete man.robeAwaitingEnqueueAt;
            if (man.robeAwaitingEnqueueReason) delete man.robeAwaitingEnqueueReason;
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

  // Robe Release/Play global — libera cooldown E enfileira elegíveis (fila Robe).
  // Contas fechadas ficam robeAwaitingEnqueue=true → entram na fila no próximo start_work.
  // Nota: com Delta + DELTA_ALLOW_ROBE_GLOBAL_TICK=0, só zerar cooldown deixava "Robe: Pronto"
  // sem nunca entrar na fila — o worker precisa enfileirar explicitamente.
  app.post('/api/robes/release-all', async (req, res) => {
    logger.info('[ROTA POST /api/robes/release-all] chamada');
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0, failed = 0, fails = [];
      const blockedLimitPosting = [];
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;

        try {
          let release = null;
          await manifestStore.update(p.nome, man => {
            release = releaseRobeCooldownForOperator(man, {
              nome: p.nome,
              now: Date.now(),
              via: 'release_all',
              awaitingEnqueue: true
            });
            return release.manifest;
          });
          if (!release) throw new Error('release_result_missing');
          if (!release.released) {
            if (release.blockedReason === 'limit_posting') blockedLimitPosting.push(p.nome);
            if (issues && typeof issues.append === "function") {
              issues.append(
                'system',
                'robe_release_all',
                `perfil=${p.nome} ok=false blocked=${release.blockedReason || 'unknown'}`
              );
            }
            continue;
          }
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
      let workerResult = null;
      try {
        workerResult = await workerClient.sendWorkerCommand('robes-release-all', {}, { timeoutMs: 120000 });
      } catch(e) {
        if (issues && typeof issues.append === "function") {
          issues.append('system', 'robes_release_all_worker_sync_error', `error=${e && e.message || String(e)}`);
        }
        workerResult = { ok: false, error: (e && e.message) || String(e) };
      }
      const enqueued = Number(workerResult && workerResult.enqueued || 0) || 0;
      const awaitingKept = Number(workerResult && workerResult.awaitingKept || 0) || 0;
      const stillPronto = Array.isArray(workerResult && workerResult.stillPronto)
        ? workerResult.stillPronto
        : [];
      const workerFailed = !workerResult || workerResult.ok !== true;
      if (failed > 0 || (fails && fails.length) || workerFailed) {
        logger.warn('Falha em /api/robes/release-all', {
          failed,
          fails,
          workerError: workerResult && workerResult.error,
          enqueued,
          awaitingKept,
          stillPronto: stillPronto.length,
          blockedLimitPosting: blockedLimitPosting.length
        });
        res.json({
          ok: false,
          error: workerFailed
            ? String((workerResult && workerResult.error) || 'robes_release_all_worker_sync_failed')
            : `Failure in ${failed} perfil(s)`,
          fails,
          total,
          enqueued,
          awaitingKept,
          stillPronto,
          blockedLimitPosting,
          worker: workerResult
        });
      } else {
        logger.info('Robe release all executado', {
          total,
          enqueued,
          awaitingKept,
          stillPronto: stillPronto.length,
          stillSample: stillPronto.slice(0, 12),
          blockedLimitPosting: blockedLimitPosting.length,
          blockedLimitPostingSample: blockedLimitPosting.slice(0, 12),
          workerOk: !!(workerResult && workerResult.ok),
          nodes: workerResult && workerResult.results
            ? workerResult.results.map((r, i) => ({
              node: i + 1,
              enqueued: Number(r && r.enqueued || 0) || 0,
              working: Number(r && r.working || 0) || 0,
              still: Array.isArray(r && r.stillPronto) ? r.stillPronto.length : null
            }))
            : null
        });
        res.json({
          ok: true,
          total,
          enqueued,
          awaitingKept,
          stillPronto,
          blockedLimitPosting,
          worker: workerResult
        });
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
      const formatItem = (x) => {
        if (typeof x === 'string') return String(x || '').trim();
        if (x && typeof x === 'object') {
          const city = String(x.city || x.cidade || '').trim();
          const size = String(x.size || x.tamanho || '').trim().toUpperCase();
          if (!city) return '';
          return (size === 'P' || size === 'M' || size === 'G') ? `${city} [${size}]` : city;
        }
        return '';
      };
      const queueRaw = (st && Array.isArray(st.queue)) ? st.queue : [];
      const queue = queueRaw.map(formatItem).filter(Boolean);
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