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
          try { require('./issues.js').append(p.nome, 'robe_pause_24h', 'Pause 24h via API'); } catch{}
        } catch(e) {
          failed++; fails.push(p.nome);
          try { require('./issues.js').append(p.nome, 'robe_pause_24h', (e && e.message) || String(e)); } catch{}
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

        // Checagem militar: não permite liberar se estiver em penalidade limit_posting ativa
        let manCur = null;
        try {
          manCur = await manifestStore.read(p.nome).catch(() => null);
        } catch {}
        if (manCur && manCur.robePauseReason === 'limit_posting' && (manCur.robeCooldownUntil || 0) > Date.now()) {
          fails.push(p.nome);
          try { require('./issues.js').append(p.nome, 'release_all_skip_limit_posting_active', 'Skipping release due to limit_posting active'); } catch{}
          continue; // profile NÃO é liberado, nem alterado
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
          try { require('./issues.js').append(p.nome, 'robe_release_all', 'Release all via API'); } catch{}
        } catch(e) {
          failed++; fails.push(p.nome);
          try { require('./issues.js').append(p.nome, 'robe_release_all', (e && e.message) || String(e)); } catch{}
        }
      }
      // *** NOVO: chama o comando workerClient para limpar robeMeta.pauseReason e lastRobeBlockAt do lado do worker ***
      try { 
        await workerClient.sendWorkerCommand('robes-release-all', {}, { timeoutMs: 20000 }); 
      } catch(e) {
        // log, mas não bloqueia o fluxo
        try { require('./issues.js').append('global', 'robes_release_all_worker_sync_error', (e && e.message) || String(e)); } catch{}
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