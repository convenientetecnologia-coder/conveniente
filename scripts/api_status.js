// Militar: responde autoMode/sys originais do worker/status.json. Nunca remova, nunca altere shape.

module.exports = (app, workerClient, fileStore) => {
  // GET /api/status — sempre tenta worker primeiro, fallback em arquivo
  app.get('/api/status', async (req, res) => {
    try {
      let status = null;
      let warning = undefined;
      let erroMsg = undefined;

      // workerId pronto para multiworker futuro
      const workerId = req.query.workerId;

      // Função para construir payload ULTRA COMPLETO (documentação nos comentários)
      function montarPayloadCompleto(rawStatus, erroMsg, warning) {
        const ts = Date.now();

        // Modularidade: status pode ser null
        if (!rawStatus || !Array.isArray(rawStatus.perfis)) {
          return {
            perfis: [],
            robes: {},
            robeQueue: [],
            ts,
            warning: warning || "status temporarily unavailable",
            ...(erroMsg ? { error: erroMsg } : {}),
            // autoMode/sys sempre presentes (null explícito), shape militar
            autoMode: (typeof rawStatus?.autoMode !== 'undefined') ? rawStatus.autoMode : null,
            sys: (typeof rawStatus?.sys !== 'undefined') ? rawStatus.sys : null
          };
        }

        // Perfis "incompletos"/skip no painel serão marcados no payload
        const perfis = rawStatus.perfis.map(perfil => {
          // health militar:
          // ramMB           => RAM atual do Chrome desse perfil (MB, float)
          // cpuPercent      => uso de CPU desse perfil (%) (opcional)
          // numPages        => sanity check de páginas abertas
          // robeEstado      => estado atual do Robe (ex: ok, idle, erro, frozen, skip_no_manifest, etc.)
          // robeCooldownSec => cooldown real time (float ou int, segundos)
          // robeFrozenUntil => se existir, timestamp UNIX (ms) do congelamento por ausência de manifest
          // (quaisquer outros campos military/robeMeta/virtus health pertinentes mantidos)
          const {
            nome,
            label,
            cidade,
            uaPresetId,
            active,
            trabalhando,
            configurando,
            humanControl,
            issuesCount,
            robeMeta = {},
            virtusHealth = {},
            ramMB,
            cpuPercent,
            numPages,
            robeEstado,
            robeCooldownSec,
            robeFrozenUntil,
            ...rest
          } = perfil;

          // Militar: sempre null para valores health não disponíveis
          // Snapshots completos, sem racing/array vazia

          // Pega campos militares do robeMeta/virtusHealth
          // Se existirem e ainda não presentes explicitamente acima, mantidos via spread (sem sobrescrever os explicitados)
          // No caso de conflito, dar prioridade a explicitados

          // Indica se perfil está "congelado" (para cinzar ou mostrar warning no painel)
          const isFrozen = robeFrozenUntil && robeFrozenUntil > Date.now();

          return {
            nome,
            label,
            cidade,
            uaPresetId,
            active,
            trabalhando,
            configurando,
            humanControl,
            issuesCount,
            // ---- HEALTH MILITAR ----
            ramMB: (typeof ramMB === 'number') ? ramMB : (typeof robeMeta.ramMB === 'number' ? robeMeta.ramMB : null), // Militar: sempre null para valores health não disponíveis
            cpuPercent: (typeof cpuPercent === 'number') ? cpuPercent : (typeof robeMeta.cpuPercent === 'number' ? robeMeta.cpuPercent : null), // Militar: sempre null para valores health não disponíveis
            numPages: (typeof numPages === 'number') ? numPages : (typeof robeMeta.numPages === 'number' ? robeMeta.numPages : null), // Militar: sempre null para valores health não disponíveis
            robeEstado: (typeof robeEstado === 'string') ? robeEstado : (typeof robeMeta.robeEstado === 'string' ? robeMeta.robeEstado : null),
            robeCooldownSec: (typeof robeCooldownSec === 'number') ? robeCooldownSec : (typeof robeMeta.robeCooldownSec === 'number' ? robeMeta.robeCooldownSec : null),
            robeFrozenUntil: robeFrozenUntil || robeMeta.robeFrozenUntil || null,
            // Campos solicitados: activationHeldUntil e reopenAt
            activationHeldUntil: (typeof perfil.activationHeldUntil === 'number' && perfil.activationHeldUntil > 0)
              ? perfil.activationHeldUntil
              : (rest && typeof rest.activationHeldUntil === 'number' && rest.activationHeldUntil > 0
                  ? rest.activationHeldUntil
                  : (robeMeta.activationHeldUntil || null)),
            reopenAt: (typeof perfil.reopenAt === 'number' && perfil.reopenAt > 0)
              ? perfil.reopenAt
              : (rest && typeof rest.reopenAt === 'number' && rest.reopenAt > 0
                  ? rest.reopenAt
                  : (robeMeta.reopenAt || null)),
            // Inclui todos os campos militares úteis do robeMeta e Virtus se não conflitam
            ...Object.fromEntries(
              Object.entries(robeMeta).filter(([k]) =>
                [
                  // Todos os possíveis campos militares relevantes podem ser ampliados aqui:
                  'virtusId', 'manifestStatus', 'pendingManifestRetries', 'robeStatusDetail',
                  'lastVirtusPing', 'lastVirtusError', 'discordWebhook', 'extraDebug'
                ].includes(k)
              )
            ),
            ...Object.fromEntries(
              Object.entries(virtusHealth).filter(([k]) =>
                [
                  'virtusPid', 'virtusOnline', 'lastHealthCheck', 'lastVirtusCrash', 'virtusFlags', 'extraVirtusDebug'
                ].includes(k)
              )
            ),
            // Outros campos legados
            ...rest,
            // Marcação explícita de "frozen" ou problema
            isFrozen,
          };
        });

        // Health: inconsistência RAM/status
        let snapshotInRamLen = perfis.length;
        let snapshotFileLen =
          rawStatus.perfis && Array.isArray(rawStatus.perfis)
            ? rawStatus.perfis.length
            : 0;

        // Warning se mismatch entre snapshot e status.json (configurável)
        if (
          typeof rawStatus.expectedPerfisLen === 'number' &&
          rawStatus.expectedPerfisLen !== snapshotInRamLen
        ) {
          warning = warning || "status temporarily unavailable";
        }
        // Detecção de pane/mismatch potencial por RAM/arquivo
        if (snapshotInRamLen !== snapshotFileLen) {
          warning = warning || "status temporarily unavailable";
        }

        // AGREGADO GLOBAL NO HEADER
        // let cpuGlobalPercent = null;
        // let ramTotalMB = null;
        // let ramFreeMB = null;
        // const sysMetrics = fileStore.getSysMetricsSnapshot && fileStore.getSysMetricsSnapshot();
        // if (sysMetrics) {
        //   ramTotalMB = typeof sysMetrics.ramTotalMB === 'number' ? sysMetrics.ramTotalMB : null;
        //   ramFreeMB = typeof sysMetrics.ramFreeMB === 'number' ? sysMetrics.ramFreeMB : null;
        //   cpuGlobalPercent = (typeof sysMetrics.cpuPercent === 'number')
        //     ? sysMetrics.cpuPercent
        //     : (
        //       sysMetrics.cpu && typeof sysMetrics.cpu.percent === 'number'
        //         ? sysMetrics.cpu.percent : null
        //     );
        // }

        // Retornar todos campos mínimos exigidos pelo painel, nunca omitir
        // ATENÇÃO: Preserva SEMPRE autoMode e sys no shape original, nunca sobrescrevendo nem removendo ambos se existirem.
        // Se ausentes, inclui explicitamente como null (para shape previsível).
        return {
          ...rawStatus, // Vai herdar autoMode e sys se vierem do worker
          perfis,
          ts,
          ...(warning ? { warning } : {}),
          ...(erroMsg ? { error: erroMsg } : {}),
          // ramTotalMB,
          // ramFreeMB,
          // cpuGlobalPercent,
          // Garante presença dos campos se não vierem do status.json
          autoMode: (typeof rawStatus.autoMode !== 'undefined') ? rawStatus.autoMode : null,
          sys: (typeof rawStatus.sys !== 'undefined') ? rawStatus.sys : null,
        };
      }

      if (workerClient && typeof workerClient.sendWorkerCommand === 'function') {
        let workerStatus;
        try {
          workerStatus = await workerClient.sendWorkerCommand('get-status', workerId, { timeoutMs: 5000 }).catch(() => null);
          if (!workerStatus || !workerStatus.perfis) {
            // Se worker respondeu mas vazio, aguarde 200ms e tente de novo (janela atômica de swap de status.json)
            await new Promise(r => setTimeout(r, 200));
            workerStatus = await workerClient.sendWorkerCommand('get-status', workerId, { timeoutMs: 5000 }).catch(() => null);
          }
        } catch (err) {
          erroMsg = String((err && err.message) || err);
        }
        // Always validate workerStatus, fallback if invalid
        // Garante SEMPRE autoMode/sys presentes (mesmo que null)
        if (
          workerStatus &&
          Array.isArray(workerStatus.perfis) &&
          workerStatus.perfis.length > 0
        ) {
          if (!('autoMode' in workerStatus)) workerStatus.autoMode = null;
          if (!('sys' in workerStatus)) workerStatus.sys = null;
          const payload = montarPayloadCompleto(workerStatus, erroMsg, warning);
          return res.json(payload);
        } else {
          warning = "status temporarily unavailable";
        }
      }

      // Fallback — OBRIGATÓRIO: snapshot do arquivo (jamais retorna todos inativos)
      let fallbackStatus = fileStore.getStatusSnapshot();
      // Garante SEMPRE autoMode/sys presentes (mesmo que null)
      if (fallbackStatus && typeof fallbackStatus === 'object') {
        if (!('autoMode' in fallbackStatus)) fallbackStatus.autoMode = null;
        if (!('sys' in fallbackStatus)) fallbackStatus.sys = null;
      }
      // Nunca devolva array vazia: se não tem campo, null; nunca “perfil sumido”.
      if (
        !fallbackStatus ||
        !Array.isArray(fallbackStatus.perfis) ||
        fallbackStatus.perfis.length === 0
      ) {
        // CRÍTICO: nunca omitir perfis, todos os campos null (não sumir nenhum perfil)
        // (Aqui, como não tem perfis disponíveis, seguir lógica anterior, mas será sempre vazio)
        return res.json({
          perfis: [],
          robes: {},
          robeQueue: [],
          ts: Date.now(),
          warning: "status temporarily unavailable",
          autoMode: (typeof fallbackStatus?.autoMode !== 'undefined') ? fallbackStatus.autoMode : null,
          sys: (typeof fallbackStatus?.sys !== 'undefined') ? fallbackStatus.sys : null
        });
      }
      // No fallback, alertar warning caso haja pane Worker
      const payload = montarPayloadCompleto(fallbackStatus, erroMsg, warning);
      res.json(payload);

    } catch (e) {
      // Anti-spam: não log, só payload!
      res.json({
        perfis: [],
        robes: {},
        robeQueue: [],
        ts: Date.now(),
        error: String(e && e.message || e),
        autoMode: null,
        sys: null
      });
    }
  });

  // Militar: retorna shape exato esperado pelo painel — { mem: {...}, cpu: {...} }
  // Mantenha extras apenas como extensão, mas NUNCA altere/remova mem/cpu.
  app.get('/api/sys', (req, res) => {
    try {
      const snap = fileStore.getSysMetricsSnapshot();
      // snap: { mem: {...}, cpu: {...} } já no formato esperado
      const os = require('os');
      const extra = {
        osCpu: {
          percent: Math.round((os.loadavg()[0] / os.cpus().length) * 100),
          load1m: os.loadavg()[0],
          load5m: os.loadavg()[1],
          load15m: os.loadavg()[2],
          cores: os.cpus().length
        }
      };
      res.json({ ...snap, ...extra }); // Nunca remove/reescreve mem/cpu da raiz
    } catch (e) {
      res.json({ ok: false, error: e && e.message || String(e) });
    }
  });
};