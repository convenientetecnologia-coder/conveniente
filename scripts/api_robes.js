// scripts/api_robes.js
module.exports = (app, workerClient, fileStore) => {
  const manifestStore = require('./manifestStore.js');

  // Robe 24h (TODOS os perfis) — pausa por 24h cada um
  app.post('/api/robes/pause-24h-all', async (req, res) => {
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
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_pause_24h', perfil: p.nome, ok: true, ts: Date.now() });
          }
        } catch(e) {
          failed++; fails.push(p.nome);
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_pause_24h', perfil: p.nome, ok: false, error: e && e.message || String(e), ts: Date.now() });
          }
        }
      }
      if (failed > 0) {
        res.json({ ok: false, error: `Failure in ${failed} perfil(s)`, fails });
      } else {
        res.json({ ok: true, total });
      }
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });

  // Robe Release/Play global — libera todos Robe
  app.post('/api/robes/release-all', async (req, res) => {
    try {
      const perfisArr = fileStore.loadPerfisJson();
      let total = 0, failed = 0, fails = [];
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;

        // Verifica se está sob penalidade limit_posting ativa (não pode liberar)
        let manCur = null;
        try {
          manCur = await manifestStore.read(p.nome).catch(()=>null);
        } catch {}
        if (manCur && manCur.robePauseReason === 'limit_posting' && (manCur.robeCooldownUntil||0) > Date.now()) {
          // NÃO liberar, NÃO alterar, pular este perfil
          if (!fails) fails = [];
          fails.push(p.nome);
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'release_all_skip_limit_posting_active', perfil: p.nome, ts: Date.now() });
          }
          continue;
        }

        try {
          await manifestStore.update(p.nome, man => {
            man = man || {};
            man.robeCooldownUntil = Date.now();
            man.robeCooldownRemainingMs = 0;
            if (man.robePauseReason) delete man.robePauseReason;
            return man;
          });
          total++;
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_release_all', perfil: p.nome, ok: true, ts: Date.now() });
          }
        } catch(e) {
          failed++; fails.push(p.nome);
          if (fileStore.issues && typeof fileStore.issues.append === "function") {
            fileStore.issues.append({ type: 'robe_release_all', perfil: p.nome, ok: false, error: e && e.message || String(e), ts: Date.now() });
          }
        }
      }
      // *** NOVO: chama o comando workerClient para limpar robeMeta.pauseReason e lastRobeBlockAt do lado do worker ***
      try { 
        await workerClient.sendWorkerCommand('robes-release-all', {}, { timeoutMs: 20000 }); 
      } catch(e) {
        // log, mas não bloqueia o fluxo
        if (fileStore.issues && typeof fileStore.issues.append === "function") {
          fileStore.issues.append({ type: 'robes_release_all_worker_sync_error', error: e && e.message || String(e), ts: Date.now() });
        }
      }
      if (failed > 0 || (fails && fails.length)) {
        res.json({ ok: false, error: `Failure in ${failed} perfil(s) or skipped limit_posting: ${fails && fails.length ? fails.join(', ') : ''}`, fails });
      } else {
        res.json({ ok: true, total });
      }
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};