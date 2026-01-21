// api_status
// Militar: responde autoMode/sys originais do worker/status.json. Nunca remova, nunca altere shape.

module.exports = (app, workerClient, fileStore) => {
const opsState = require('./opsState.js');
// FUTURO: endpoint /api/status será servido/encaminhado pelo Supervisor externo (será preferencialmente o status do Supervisor, não do Worker direto)
// GET /api/status — sempre tenta worker primeiro, fallback em arquivo
app.get('/api/status', async (req, res) => {
try {
let status = null;
let warning = undefined;
let erroMsg = undefined;

// workerId pronto para multiworker futuro
const workerId = req.query.workerId;

// Função para misturar dois objetos por campo, dando prioridade ao overlay
function overlayFields(base, overlay) {
  const result = { ...base };
  for (const key in overlay) {
    if (overlay[key] !== undefined) {
      result[key] = overlay[key];
    }
  }
  return result;
}

// NOVA FUNÇÃO: Montar baseline de perfis (todos os campos necessários, shape militar completo e neutro)
async function montarPerfisBaseline() {
  let lista;
  try {
    lista = await fileStore.loadPerfisJson();
  } catch (e) {
    // Não pode falhar: fallback hard
    lista = [];
  }
  return (lista || []).map(perfil => ({
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
    // outros campos militares possíveis para shape retroativo (virtus etc)
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
    messengerPin: false,
    messengerPinReason: null,
    problem: false // <<< ALTERAÇÃO AQUI
  }));
}

// Função para montar payload ULTRA COMPLETO (documentação nos comentários)
function montarPayloadCompleto(rawStatus, erroMsg, warning) {
  const ts = Date.now();

  // --- NOVO: baseline via perfis.json; overlay worker; shape militar total --- //
  let basePerfis = [];
  // Carregar baseline do perfis.json SEMPRE
  let perfisJsonRaw = [];
  try {
    perfisJsonRaw = fileStore.loadPerfisJsonSync
      ? fileStore.loadPerfisJsonSync()
      : fileStore.perfisJson // pode ser cache
      ? fileStore.perfisJson
      : require('fs').readFileSync(fileStore.perfisJsonPath, 'utf8') && JSON.parse(require('fs').readFileSync(fileStore.perfisJsonPath, 'utf8'));
  } catch(e) {
    perfisJsonRaw = [];
  }
  basePerfis = (perfisJsonRaw || []).map(perfil => ({
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
    messengerPin: false,
    messengerPinReason: null,
    problem: false // <<< ALTERAÇÃO AQUI
  }));

  // Overlay dos perfis atuais vindos do status (worker ou fallback)
  let overlayPerfisArr = Array.isArray(rawStatus?.perfis) ? rawStatus.perfis : [];
  // Constroi lookup pelo nome original
  let overlayByNome = {};
  for (const overlayPerfil of overlayPerfisArr) {
    if (overlayPerfil && overlayPerfil.nome) {
      overlayByNome[overlayPerfil.nome] = overlayPerfil;
    }
  }

  // Para cada baseline, aplica overlay dos dados, se houver.
  const perfis = basePerfis.map(b => {
    const overlay = overlayByNome[b.nome];
    if (overlay) {
      // Clone: passa por camada de processamento militar original
      // (aproveita shape militar completo)
      return (() => {
        // Trecho do shape militar original:
        // health militar:
        // ramMB           => RAM atual do Chrome desse perfil (MB, float)
        // cpuPercent      => uso de CPU desse perfil (%) (opcional)
        // numPages        => sanity check de páginas abertas
        // robeEstado      => estado atual do Robe (ex: ok, idle, erro, frozen, skip_no_manifest, etc.)
        // robeCooldownSec => cooldown real time (float ou int, segundos)
        // robeFrozenUntil => se existir, timestamp UNIX (ms) do congelamento por ausência de manifest
        // Marcação explícita de "frozen" ou problema
        const robeMeta = overlay.robeMeta || {};
        const virtusHealth = overlay.virtusHealth || {};
        const rest = overlay;
        const isFrozen = (overlay.robeFrozenUntil && overlay.robeFrozenUntil > Date.now()) || false;
        // Campos swap/backoff
        const openBackoffMs =
          typeof overlay.openBackoffMs === 'number'
            ? overlay.openBackoffMs
            : typeof robeMeta.openBackoffMs === 'number'
            ? robeMeta.openBackoffMs
            : null;
        const lastSwapAt =
          typeof overlay.lastSwapAt === 'number'
            ? overlay.lastSwapAt
            : typeof robeMeta.lastSwapAt === 'number'
            ? robeMeta.lastSwapAt
            : null;
        const lastSwapPeer =
          typeof overlay.lastSwapPeer === 'string'
            ? overlay.lastSwapPeer
            : typeof robeMeta.lastSwapPeer === 'string'
            ? robeMeta.lastSwapPeer
            : null;
        const swapCooldown =
          typeof overlay.swapCooldown === 'number'
            ? overlay.swapCooldown
            : typeof robeMeta.swapCooldown === 'number'
            ? robeMeta.swapCooldown
            : null;
        const whyNotOpen =
          typeof overlay.whyNotOpen === 'string'
            ? overlay.whyNotOpen
            : typeof robeMeta.whyNotOpen === 'string'
            ? robeMeta.whyNotOpen
            : null;

        // Complete shape, overlay por prioridade, depois fields herdados
        const merged = {
          ...b,
          ...overlay,
          ...robeMeta,
          ...virtusHealth,
          isFrozen,
          ramMB: typeof overlay.ramMB === 'number'
            ? overlay.ramMB
            : typeof robeMeta.ramMB === 'number'
            ? robeMeta.ramMB
            : null,
          cpuPercent: typeof overlay.cpuPercent === 'number'
            ? overlay.cpuPercent
            : typeof robeMeta.cpuPercent === 'number'
            ? robeMeta.cpuPercent
            : null,
          numPages: typeof overlay.numPages === 'number'
            ? overlay.numPages
            : typeof robeMeta.numPages === 'number'
            ? robeMeta.numPages
            : null,
          robeEstado: typeof overlay.robeEstado === 'string'
            ? overlay.robeEstado
            : typeof robeMeta.robeEstado === 'string'
            ? robeMeta.robeEstado
            : null,
          robeCooldownSec: typeof overlay.robeCooldownSec === 'number'
            ? overlay.robeCooldownSec
            : typeof robeMeta.robeCooldownSec === 'number'
            ? robeMeta.robeCooldownSec
            : null,
          robeFrozenUntil: overlay.robeFrozenUntil || robeMeta.robeFrozenUntil || null,
          frozenReason: overlay.frozenReason ?? robeMeta.frozenReason ?? null,
          frozenAt: overlay.frozenAt ?? robeMeta.frozenAt ?? null,
          frozenSetBy: overlay.frozenSetBy ?? robeMeta.frozenSetBy ?? null,
          activationHeldUntil:
            typeof overlay.activationHeldUntil === 'number' && overlay.activationHeldUntil > 0
              ? overlay.activationHeldUntil
              : rest && typeof rest.activationHeldUntil === 'number' && rest.activationHeldUntil > 0
              ? rest.activationHeldUntil
              : robeMeta.activationHeldUntil || null,
          reopenAt:
            typeof overlay.reopenAt === 'number' && overlay.reopenAt > 0
              ? overlay.reopenAt
              : rest && typeof rest.reopenAt === 'number' && rest.reopenAt > 0
              ? rest.reopenAt
              : robeMeta.reopenAt || null,
          openBackoffMs,
          lastSwapAt,
          lastSwapPeer,
          swapCooldown,
          whyNotOpen,
        };
        // NUNCA permita que active:true vire false por sobreposição
        merged.active = !!(overlay && overlay.active) || !!b.active;
        return merged;
      })();
    }
    // Sem overlay: volta skeleton (só baseline, shape correto)
    return { ...b };
  });

  let robes = (typeof rawStatus?.robes !== "undefined" && rawStatus.robes !== null) ? rawStatus.robes : {};
  let robeQueue = (typeof rawStatus?.robeQueue !== "undefined" && rawStatus.robeQueue !== null) ? rawStatus.robeQueue : [];
  let autoMode = (typeof rawStatus?.autoMode !== 'undefined') ? rawStatus.autoMode : null;
  let sys = (typeof rawStatus?.sys !== 'undefined') ? rawStatus.sys : null;

  // WARNING: verifica se overlay incompleto/faltante (node ausentes ou timeout)
  let missing = perfis.filter((p, idx) => {
    // overlay está ausente se active do baseline=false e overlay não existe
    return !((overlayByNome[p.nome]) && typeof overlayByNome[p.nome] === 'object');
  }).map(p => p.nome);
  let warningFinal = warning;
  if (missing.length > 0) {
    warningFinal = (warningFinal ? warningFinal + "; " : "") +
      `sem resposta dos perfis: ${missing.join(', ')}`;
  }
  if (!warningFinal && warning) warningFinal = warning;

  // Retornar todos campos mínimos exigidos pelo painel, nunca omitir
  // ATENÇÃO: perfis.lenght === perfis.json.length sempre
  return {
    ...rawStatus, // herda campos potencialmente extra
    perfis,
    ts,
    ...(robes ? { robes } : {}),
    ...(robeQueue ? { robeQueue } : {}),
    autoMode,
    sys,
    ...(warningFinal ? { warning: warningFinal } : {}),
    ...(erroMsg ? { error: erroMsg } : {})
  };
}


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
    messengerPin: false,
    messengerPinReason: null,
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
    ops: opsState.getOps(),
    warning: warningINST,
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
      messengerPin: false,
      messengerPinReason: null,
      problem: false // <<< ALTERAÇÃO AQUI (INSTRUÇÃO 2)
    }));
  } catch(e2) {
    perfisSkeleton = [];
  }
  res.json({
    perfis: perfisSkeleton,
    robes: {},
    robeQueue: [],
    ts: Date.now(),
    error: String(e && e.message || e),
    autoMode: null,
    sys: null
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