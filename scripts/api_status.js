// api_status
// Militar: responde autoMode/sys originais do worker/status.json. Nunca remova, nunca altere shape.

module.exports = (app, workerClient, fileStore) => {
const opsState = require('./opsState.js');
const gatewayProxy = require('./gatewayProxy.js');
const serverConfig = require('./serverConfig.js');
const path = require('path');
const fs = require('fs');

function __readJsonSafeFallback(p, defVal) {
  try {
    if (fileStore && typeof fileStore.readJsonSafe === 'function') {
      return fileStore.readJsonSafe(p, defVal);
    }
  } catch {}
  try {
    if (!fs.existsSync(p)) return defVal;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return defVal;
  }
}

function __readGateBStateSafe() {
  try {
    const bundlePath = path.join(__dirname, '..', 'dados', 'gate_b_bundle.json');
    const runtimePath = path.join(__dirname, '..', 'dados', 'gate_b_runtime.json');
    const b = __readJsonSafeFallback(bundlePath, null);
    const r = __readJsonSafeFallback(runtimePath, null);
    const hasToken = !!(b && (b.tunnelToken || b.tunnel_token));
    const hasInfra = !!(b && (b.infraSecret || b.infra_secret || b.infraSECRET));
    const hostFqdn = (b && (b.hostFqdn || b.host_fqdn)) ? String(b.hostFqdn || b.host_fqdn).trim() : null;
    const source = (b && b.source) ? String(b.source) : null;
    const updatedAt = (b && typeof b.updatedAt === 'number') ? b.updatedAt : null;
    return {
      bundle: {
        present: !!b,
        hostFqdn,
        hasTunnelToken: hasToken,
        hasInfraSecret: hasInfra,
        source,
        updatedAt
      },
      runtime: (r && typeof r === 'object') ? {
        updatedAt: (typeof r.updatedAt === 'number') ? r.updatedAt : null,
        hostId: r.hostId ? String(r.hostId) : null,
        bootstrap: r.bootstrap || null,
        cloudflared: r.cloudflared || null
      } : null
    };
  } catch {
    return { bundle: { present: false, hostFqdn: null, hasTunnelToken: false, hasInfraSecret: false, source: null, updatedAt: null }, runtime: null };
  }
}
// Cache militar: nunca devolver lista vazia por falha transitória de IO/lock.
// Protege o dashboard contra "piscar" (some e volta) quando /api/perfis ou /api/status falham 1 ciclo.
let _lastBaselinePerfis = null; // array de perfis (perfis.json) da última leitura boa
let _lastBaselineAt = 0;
let __virtusMetricsCache = { at: 0, key: '', value: null };

function __buildUtcMinus3DayWindow(dayDelta) {
  const nowMs = Date.now();
  const shifted = new Date(nowMs - (3 * 60 * 60 * 1000));
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate() + (Number(dayDelta || 0) || 0);
  const startMs = Date.UTC(y, m, d, 3, 0, 0, 0);
  const endMs = startMs + (24 * 60 * 60 * 1000);
  return {
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000)
  };
}

function __collectVirtusProfileNames(statusLike) {
  const set = new Set();
  try {
    const perfis = Array.isArray(statusLike && statusLike.perfis) ? statusLike.perfis : [];
    for (const p of perfis) {
      const nome = String(p && p.nome || '').trim();
      if (nome) set.add(nome);
    }
  } catch {}
  try {
    const desiredPath = (fileStore && fileStore.desiredPath)
      ? String(fileStore.desiredPath)
      : path.join(__dirname, '..', 'dados', 'desired.json');
    if (desiredPath && fs.existsSync(desiredPath)) {
      const desired = JSON.parse(fs.readFileSync(desiredPath, 'utf8'));
      const perfisObj = (desired && typeof desired === 'object' && desired.perfis && typeof desired.perfis === 'object')
        ? desired.perfis
        : null;
      if (perfisObj) {
        for (const nome of Object.keys(perfisObj)) {
          const n = String(nome || '').trim();
          if (n) set.add(n);
        }
      }
    }
  } catch {}
  return Array.from(set);
}

function __computeVirtusMetricsFromNames(profileNames) {
  const names = Array.isArray(profileNames) ? profileNames : [];
  const base = path.join(__dirname, '..', 'dados', 'perfis');
  const today = __buildUtcMinus3DayWindow(0);
  const yesterday = __buildUtcMinus3DayWindow(-1);

  let profilesWithFile = 0;
  let profilesMissingFile = 0;
  let parseErrors = 0;
  let todayCount = 0;
  let yesterdayCount = 0;

  for (const nome of names) {
    try {
      const safeNome = String(nome || '').trim();
      if (!safeNome) continue;
      const fp = path.join(base, safeNome, 'chats_respondidos.json');
      if (!fs.existsSync(fp)) {
        profilesMissingFile += 1;
        continue;
      }
      profilesWithFile += 1;
      let obj = null;
      try {
        obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch {
        parseErrors += 1;
        continue;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const v of Object.values(obj)) {
        const t = Number(v || 0) || 0;
        if (!t) continue;
        if (t >= today.startSec && t < today.endSec) todayCount += 1;
        if (t >= yesterday.startSec && t < yesterday.endSec) yesterdayCount += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }

  return {
    source: 'chats_respondidos',
    generatedAt: Date.now(),
    timezone: 'UTC-3',
    profiles: {
      expected: names.length,
      withFile: profilesWithFile,
      missingFile: profilesMissingFile,
      parseErrors
    },
    windows: {
      yesterday: {
        startSec: yesterday.startSec,
        endSec: yesterday.endSec,
        chatsRespondidos: yesterdayCount
      },
      today: {
        startSec: today.startSec,
        endSec: today.endSec,
        chatsRespondidos: todayCount
      }
    }
  };
}

function __getVirtusMetricsCached(statusLike) {
  try {
    const names = __collectVirtusProfileNames(statusLike).sort();
    const key = names.join('|');
    const nowMs = Date.now();
    if (__virtusMetricsCache.value && __virtusMetricsCache.key === key && (nowMs - Number(__virtusMetricsCache.at || 0)) < 25000) {
      return __virtusMetricsCache.value;
    }
    const value = __computeVirtusMetricsFromNames(names);
    __virtusMetricsCache = { at: nowMs, key, value };
    return value;
  } catch {
    return null;
  }
}
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
    loginRemediateFailed: false,
    loginRemediateFailedAt: null,
    loginRemediateFailedReason: null,
    banned: false,
    bannedAt: null,
    bannedText: null,
    marketplaceDisabled: false,
    marketplaceDisabledAt: null,
    marketplaceDisabledReason: null,
    marketplaceDisabledText: null,
    marketplaceRenewEnabled: false,
    marketplaceRenewDueLabel: null,
    marketplaceRenewDueMinute: null,
    marketplaceRenewDueReached: false,
    marketplaceRenewScrollDays: null,
    marketplaceRenewPlanDate: null,
    marketplaceRenewDoneDay: null,
    marketplaceRenewDoneAt: null,
    marketplaceRenewDoneToday: false,
    marketplaceRenewLastCount: 0,
    renovadosLastCount: 0,
    robeIdDocDoneToday: false,
    captchaCheckpoint: false,
    captchaCheckpointReason: null,
    twoFactor: false,
    twoFactorAt: null,
    twoFactorReason: null,
    twoFactorText: null,
    messengerPin: false,
    messengerPinReason: null,
    problem: false, // <<< ALTERAÇÃO AQUI
    robeDailyPlanSummary: null,
    robeSessionSummary: null
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
    perfisJsonRaw = fileStore.loadPerfisJson ? fileStore.loadPerfisJson() : [];
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
    loginRemediateFailed: false,
    loginRemediateFailedAt: null,
    loginRemediateFailedReason: null,
    banned: false,
    bannedAt: null,
    bannedText: null,
    marketplaceDisabled: false,
    marketplaceDisabledAt: null,
    marketplaceDisabledReason: null,
    marketplaceDisabledText: null,
    marketplaceRenewEnabled: false,
    marketplaceRenewDueLabel: null,
    marketplaceRenewDueMinute: null,
    marketplaceRenewDueReached: false,
    marketplaceRenewScrollDays: null,
    marketplaceRenewPlanDate: null,
    marketplaceRenewDoneDay: null,
    marketplaceRenewDoneAt: null,
    marketplaceRenewDoneToday: false,
    marketplaceRenewLastCount: 0,
    renovadosLastCount: 0,
    robeIdDocDoneToday: false,
    captchaCheckpoint: false,
    captchaCheckpointReason: null,
    twoFactor: false,
    twoFactorAt: null,
    twoFactorReason: null,
    twoFactorText: null,
    messengerPin: false,
    messengerPinReason: null,
    problem: false, // <<< ALTERAÇÃO AQUI
    robeDailyPlanSummary: null,
    robeSessionSummary: null
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
  let autoOpen = null;
  try {
    const d = fileStore.readJsonSafe(fileStore.desiredPath, null) || {};
    const ao = d && d._autoOpen && typeof d._autoOpen === 'object' ? d._autoOpen : null;
    autoOpen = {
      enabled: !!(ao && ao.enabled === true),
      changedAt: (ao && typeof ao.changedAt === 'number') ? ao.changedAt : 0,
      changedBy: (ao && ao.changedBy) ? String(ao.changedBy) : null
    };
  } catch {
    autoOpen = { enabled: false, changedAt: 0, changedBy: null };
  }

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
    autoOpen,
    sys,
    ...(warningFinal ? { warning: warningFinal } : {}),
    ...(erroMsg ? { error: erroMsg } : {})
  };
}


// ======= INÍCIO DA INSTRUÇÃO/ALTERAÇÃO PEDIDA =======
  // Implementação SOLICITADA — substitua toda a estrutura da rota por este bloco DO INÍCIO AO FIM!

  // 1) Baseline do perfis.json SEMPRE — nunca array vazia (usa cache se falhar)
  let perfisArr = [];
  try { perfisArr = fileStore.loadPerfisJson() || []; } catch { perfisArr = []; }
  // Se veio vazio mas já tivemos baseline recente, assume falha transitória (produção não fica realmente "0 perfis").
  if ((!Array.isArray(perfisArr) || perfisArr.length === 0) && Array.isArray(_lastBaselinePerfis) && _lastBaselinePerfis.length > 0) {
    warningINST = (warningINST ? warningINST + '; ' : '') + 'baseline_fallback_cache';
    perfisArr = _lastBaselinePerfis;
  } else {
    if (Array.isArray(perfisArr) && perfisArr.length > 0) {
      _lastBaselinePerfis = perfisArr;
      _lastBaselineAt = Date.now();
    }
  }
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
    marketplaceDisabled: false,
    marketplaceDisabledAt: null,
    marketplaceDisabledReason: null,
    marketplaceDisabledText: null,
    marketplaceRenewEnabled: false,
    marketplaceRenewDueLabel: null,
    marketplaceRenewDueMinute: null,
    marketplaceRenewDueReached: false,
    marketplaceRenewScrollDays: null,
    marketplaceRenewPlanDate: null,
    marketplaceRenewDoneDay: null,
    marketplaceRenewDoneAt: null,
    marketplaceRenewDoneToday: false,
    marketplaceRenewLastCount: 0,
    renovadosLastCount: 0,
    robeIdDocDoneToday: false,
    captchaCheckpoint: false,
    captchaCheckpointReason: null,
    twoFactor: false,
    twoFactorAt: null,
    twoFactorReason: null,
    twoFactorText: null,
    messengerPin: false,
    messengerPinReason: null,
    problem: false, // <<< ALTERAÇÃO AQUI (INSTRUÇÃO 1)
    robeDailyPlanSummary: null,
    robeSessionSummary: null
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
  const gatewayRuntime = (() => {
    try { return gatewayProxy.readState(); } catch { return null; }
  })();
  const gatewaySlotsById = new Map(
    Array.isArray(gatewayRuntime && gatewayRuntime.slots)
      ? gatewayRuntime.slots.map((s) => [String(s && s.slotId || '').trim(), s])
      : []
  );
  const gatewayEnabled = !!(gatewayRuntime && gatewayRuntime.globalEnabled === true && gatewayRuntime.hostEnabled === true);
  const gatewayInv = String(gatewayRuntime && gatewayRuntime.inventoryVersion || '').trim();
  const gatewayProvider = String(gatewayRuntime && gatewayRuntime.provider || 'proxycheap').trim().toLowerCase() || 'proxycheap';
  const perfisFinalINST = Array.from(baseMap.values()).map((p) => {
    const nome = String(p && p.nome || '').trim();
    const rec = (gatewayRuntime && gatewayRuntime.assignments && nome) ? gatewayRuntime.assignments[nome] : null;
    const recInv = String(rec && rec.inventoryVersion || '').trim();
    const slotId = String(rec && rec.slotId || '').trim();
    const slot = (slotId && recInv === gatewayInv) ? gatewaySlotsById.get(slotId) : null;
    const gatewayProxyInfo = {
      required: gatewayEnabled,
      enabled: !!(gatewayEnabled && slot),
      reason: gatewayEnabled ? (slot ? 'ok' : 'missing_slot_assignment') : 'gateway_disabled',
      provider: gatewayProvider,
      slotId: slot ? String(slot.slotId || '') : '',
      zone: slot ? String(slot.zone || '') : '',
      ipCurrent: slot ? String(slot.ipCurrent || '') : '',
      inventoryVersion: gatewayInv
    };
    return Object.assign({}, p, { gatewayProxy: gatewayProxyInfo });
  });
  // Progresso do "Abrir Todos" (sequenciador do desired.json) — para o dashboard acompanhar inFlight/idx/total.
  let openAll = null;
  let autoOpen = null;
  try {
    const d = (fileStore && typeof fileStore.readJsonSafe === 'function')
      ? fileStore.readJsonSafe(fileStore.desiredPath, null)
      : null;
    openAll = d && d._openAll ? d._openAll : null;
    const ao = d && d._autoOpen && typeof d._autoOpen === 'object' ? d._autoOpen : null;
    autoOpen = {
      enabled: !!(ao && ao.enabled === true),
      changedAt: (ao && typeof ao.changedAt === 'number') ? ao.changedAt : 0,
      changedBy: (ao && ao.changedBy) ? String(ao.changedBy) : null
    };
  } catch { openAll = null; }
  const serverConfigEffective = (() => {
    try {
      const totalMemMB = (overlayINST && overlayINST.sys && typeof overlayINST.sys.totalMB === 'number')
        ? Number(overlayINST.sys.totalMB)
        : serverConfig.getTotalMemMB();
      return serverConfig.readServerConfigEffective({ totalMemMB });
    } catch {
      return serverConfig.readServerConfigEffective({});
    }
  })();
  const gateB = __readGateBStateSafe();
  const virtusMetrics = __getVirtusMetricsCached({ perfis: perfisFinalINST });
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
    openAll,
    autoOpen,
    serverConfig: serverConfigEffective,
    gateB,
    virtusMetrics,
    ts: Date.now()
  });
  return;

  // ======= FIM DA INSTRUÇÃO/ALTERAÇÃO PEDIDA =======

} catch (e) {
  // Anti-spam: não log, só payload!
  // CRÍTICO: sempre baseline de perfis.json
  let perfisSkeleton = [];
  try {
    const listaPerfis = (fileStore && typeof fileStore.loadPerfisJson === 'function')
      ? (fileStore.loadPerfisJson() || [])
      : [];
    const base = (Array.isArray(listaPerfis) && listaPerfis.length > 0)
      ? listaPerfis
      : (Array.isArray(_lastBaselinePerfis) ? _lastBaselinePerfis : []);
    perfisSkeleton = (base || []).map(perfil => ({
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
      marketplaceDisabled: false,
      marketplaceDisabledAt: null,
      marketplaceDisabledReason: null,
      marketplaceDisabledText: null,
      marketplaceRenewEnabled: false,
      marketplaceRenewDueLabel: null,
      marketplaceRenewDueMinute: null,
      marketplaceRenewDueReached: false,
      marketplaceRenewScrollDays: null,
      marketplaceRenewPlanDate: null,
      marketplaceRenewDoneDay: null,
      marketplaceRenewDoneAt: null,
      marketplaceRenewDoneToday: false,
      marketplaceRenewLastCount: 0,
      renovadosLastCount: 0,
      robeIdDocDoneToday: false,
      captchaCheckpoint: false,
      captchaCheckpointReason: null,
      twoFactor: false,
      twoFactorAt: null,
      twoFactorReason: null,
      twoFactorText: null,
      messengerPin: false,
      messengerPinReason: null,
      problem: false, // <<< ALTERAÇÃO AQUI (INSTRUÇÃO 2)
      robeDailyPlanSummary: null,
      robeSessionSummary: null
    }));
  } catch(e2) {
    perfisSkeleton = Array.isArray(_lastBaselinePerfis) ? _lastBaselinePerfis : [];
  }
  const serverConfigEffective = (() => {
    try { return serverConfig.readServerConfigEffective({}); } catch { return null; }
  })();
  const gateB = __readGateBStateSafe();
  const virtusMetrics = __getVirtusMetricsCached({ perfis: perfisSkeleton });
  res.json({
    perfis: perfisSkeleton,
    robes: {},
    robeQueue: [],
    ts: Date.now(),
    error: String(e && e.message || e),
    autoMode: null,
    sys: null,
    warning: 'status_failed',
    openAll: (() => {
      try {
        const d = (fileStore && typeof fileStore.readJsonSafe === 'function')
          ? fileStore.readJsonSafe(fileStore.desiredPath, null)
          : null;
        return d && d._openAll ? d._openAll : null;
      } catch { return null; }
    })(),
    autoOpen: (() => {
      try {
        const d = (fileStore && typeof fileStore.readJsonSafe === 'function')
          ? fileStore.readJsonSafe(fileStore.desiredPath, null)
          : null;
        const ao = d && d._autoOpen && typeof d._autoOpen === 'object' ? d._autoOpen : null;
        return {
          enabled: !!(ao && ao.enabled === true),
          changedAt: (ao && typeof ao.changedAt === 'number') ? ao.changedAt : 0,
          changedBy: (ao && ao.changedBy) ? String(ao.changedBy) : null
        };
      } catch { return { enabled: false, changedAt: 0, changedBy: null }; }
    })(),
    serverConfig: serverConfigEffective,
    gateB,
    virtusMetrics
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