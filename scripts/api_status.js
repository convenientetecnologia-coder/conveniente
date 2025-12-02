// api_status
// Militar: responde autoMode/sys originais do worker/status.json. Nunca remova, nunca altere shape.

module.exports = (app, workerClient, fileStore) => {
// FUTURO: endpoint /api/status será servido/encaminhado pelo Supervisor externo (será preferencialmente o status do Supervisor, não do Worker direto)
// GET /api/status — sempre tenta worker primeiro, fallback em arquivo
app.get('/api/status', async (req, res) => {
try {
// ======= INÍCIO DA INSTRUÇÃO/ALTERAÇÃO PEDIDA =======
  // Implementação SOLICITADA — substitua toda a estrutura da rota por este bloco DO INÍCIO AO FIM!

  // 1) Baseline do perfis.json SEMPRE — nunca array vazia
  const perfisArr = fileStore.loadPerfisJson() || [];
  const baseMap = new Map(perfisArr.map(p => [p.nome, {
    nome: p.nome,
    label: p.label || null,
    cidade: p.cidade,
    uaPresetId: p.uaPresetId,
    active: false, trabalhando: false, configurando: false, humanControl: false, issuesCount: 0,
    ramMB: null, cpuPercent: null, numPages: null, robeEstado: null, robeCooldownSec: null,
    robeFrozenUntil: null, frozenReason: null, frozenAt: null, frozenSetBy: null,
    activationHeldUntil: null, reopenAt: null, openBackoffMs: null, lastSwapAt: null, lastSwapPeer: null,
    swapCooldown: null, whyNotOpen: null, manifestStatus: null, closingReason: null, isFrozen: false,
    // === CAMPOS ADICIONADOS PARA BLINDAGEM DE SHAPE:
    loginRequired: false,
    loginReason: null,
    banned: false,
    bannedAt: null,
    bannedText: null,
    problem: false // <<< ALTERAÇÃO AQUI (INSTRUÇÃO 1)
    // outros campos militares do shape retrocompatível
  }]));
  let warningINST = undefined;
  let erroMsgINST = undefined;

  // 2) Tente overlay do workerClient (cluster), mas nunca trunque a lista do baseline!
  // NOVO: Timeout aumentado para 15s (multi-node precisa de mais tempo)
  let overlayINST = null;
  try {
    overlayINST = await workerClient.sendWorkerCommand('get-status', {}, { timeoutMs: 15000 });
  } catch (e) {
    warningINST = 'status temporarily unavailable';
  }
  if (overlayINST && Array.isArray(overlayINST.perfis) && overlayINST.perfis.length > 0) {
    // Overlay de status/metrics apenas nos que existem no baseline
    for (const o of overlayINST.perfis) {
      const b = baseMap.get(o.nome);
      if (!b) continue;
      const prevActive = !!b.active;
      const prevRam = b.ramMB;
      const prevCpu = b.cpuPercent;
      Object.assign(b, o);
      // Blindagem: nunca deixe "active" voltar a false se alguma fonte já marcou como true
      b.active = !!o.active || prevActive;
      // Se overlay trouxe null/undefined para RAM/CPU, preserva valores numéricos anteriores
      if (typeof o.ramMB !== 'number' && typeof prevRam === 'number') {
        b.ramMB = prevRam;
      }
      if (typeof o.cpuPercent !== 'number' && typeof prevCpu === 'number') {
        b.cpuPercent = prevCpu;
      }
      // Se overlay do perfil não trouxe RAM/CPU, usa o dado de robes[nome]
      if (typeof b.ramMB !== 'number' && overlayINST.robes && overlayINST.robes[o.nome] && typeof overlayINST.robes[o.nome].ramMB === 'number') {
        b.ramMB = overlayINST.robes[o.nome].ramMB;
      }
      if (typeof b.cpuPercent !== 'number' && overlayINST.robes && overlayINST.robes[o.nome] && typeof overlayINST.robes[o.nome].cpuPercent === 'number') {
        b.cpuPercent = overlayINST.robes[o.nome].cpuPercent;
      }
    }
  } else if (overlayINST && overlayINST.warning) {
    warningINST = overlayINST.warning;
  }

  // 3) Monte array final de perfis SEMPRE do baseline (com overlay) e retorne shape original
  const perfisFinalINST = Array.from(baseMap.values());
  res.json({
    perfis: perfisFinalINST,
    robes: overlayINST && overlayINST.robes ? overlayINST.robes : {},
    robeQueue: overlayINST && overlayINST.robeQueue ? overlayINST.robeQueue : [],
    autoMode: overlayINST && typeof overlayINST.autoMode !== 'undefined' ? overlayINST.autoMode : null,
    sys: overlayINST && typeof overlayINST.sys !== 'undefined'
      ? overlayINST.sys
      : (fileStore.getSysMetricsSnapshot ? fileStore.getSysMetricsSnapshot() : null),
    warning: warningINST || undefined,
    error: erroMsgINST || undefined,
    ts: Date.now()
  });
  return;

  // ======= FIM DA INSTRUÇÃO/ALTERAÇÃO PEDIDA =======

} catch (e) {
  // Anti-spam: não log, só payload!
  // CRÍTICO: sempre baseline de perfis.json
  let perfisSkeleton = [];
  try {
    let listaPerfis = fileStore.loadPerfisJsonSync
      ? fileStore.loadPerfisJsonSync()
      : fileStore.perfisJson
      ? fileStore.perfisJson
      : require('fs').readFileSync(fileStore.perfisJsonPath, 'utf8') && JSON.parse(require('fs').readFileSync(fileStore.perfisJsonPath, 'utf8'));
    perfisSkeleton = (listaPerfis || []).map(perfil => ({
      nome: perfil.nome,
      label: perfil.label,
      cidade: perfil.cidade,
      uaPresetId: perfil.uaPresetId,
      active: false,
      trabalhando: false,
      configurando: false,
      humanControl: false,
      issuesCount: 0,
      ramMB: null,
      cpuPercent: null,
      numPages: null,
      robeEstado: null,
      robeCooldownSec: null,
      robeFrozenUntil: null,
      frozenReason: null,
      frozenAt: null,
      frozenSetBy: null,
      activationHeldUntil: null,
      reopenAt: null,
      openBackoffMs: null,
      lastSwapAt: null,
      lastSwapPeer: null,
      swapCooldown: null,
      whyNotOpen: null,
      virtusId: null,
      manifestStatus: null,
      pendingManifestRetries: null,
      robeStatusDetail: null,
      lastVirtusPing: null,
      lastVirtusError: null,
      discordWebhook: null,
      extraDebug: null,
      virtusPid: null,
      virtusOnline: null,
      lastHealthCheck: null,
      lastVirtusCrash: null,
      virtusFlags: null,
      extraVirtusDebug: null,
      isFrozen: false,
      // === CAMPOS ADICIONADOS PARA BLINDAGEM DE SHAPE:
      loginRequired: false,
      loginReason: null,
      banned: false,
      bannedAt: null,
      bannedText: null,
      problem: false // <<< ALTERAÇÃO AQUI (INSTRUÇÃO 2)
    }));
  } catch(e2) {
    perfisSkeleton = [];
  }
  res.json({
    perfis: perfisSkeleton,
    robes: {},
    robeQueue: [],
    autoMode: null,
    sys: null,
    warning: undefined,
    error: String(e && e.message || e),
    ts: Date.now()
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
    // NOVO: Timeout aumentado para 15s (multi-node precisa de mais tempo)
    let overlay = null;
    try {
      overlay = await workerClient.sendWorkerCommand('get-status', {}, { timeoutMs: 15000 });
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