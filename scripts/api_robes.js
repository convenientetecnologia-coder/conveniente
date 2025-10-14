// scripts/api_robes.js
module.exports = (app, workerClient, fileStore) => {
  const manifestStore = require('./manifestStore.js');
  const logger = require('./logger.js');
  const issues = require('./issues.js');

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
};