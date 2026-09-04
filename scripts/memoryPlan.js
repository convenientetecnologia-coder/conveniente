// scripts/memoryPlan.js

const os = require('os');
const serverConfig = require('./serverConfig.js');

/**
 * Converte bytes em MB.
 * @param {number} x
 * @returns {number}
 */
function mb(x) { return Math.floor(x / (1024 * 1024)); }

function clampWorkerRamDivisorGb(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 16;
  return Math.max(4, Math.min(32, n));
}

/**
 * Quantos processos Worker nascem no boot.
 * - hardware = ceil(RAM física MB / (divisorGB × 1024)), mínimo 1
 * - contas só cortam processo vazio: min(hardware, totalProfiles)
 * - 0 conta → 1 Worker (o cluster precisa existir)
 * - capacidade de contas NÃO entra nesta conta
 *
 * @param {object} opts
 * @param {number} opts.totalMB
 * @param {number} opts.divisorGb
 * @param {number} opts.totalProfiles
 * @returns {number}
 */
function calcWorkerNodes({ totalMB, divisorGb, totalProfiles } = {}) {
  const divisor = clampWorkerRamDivisorGb(divisorGb);
  const mem = Math.max(0, Math.floor(Number(totalMB) || 0));
  const hardwareNodes = Math.max(1, Math.ceil(mem / (divisor * 1024)));
  const profiles = Math.max(0, Math.floor(Number(totalProfiles) || 0));
  if (profiles < 1) return 1;
  return Math.min(hardwareNodes, profiles);
}

/**
 * Teto de grow ao vivo: divisor SALVO agora × RAM física.
 * Salvar 16→8 já autoriza Worker extra na próxima conta.
 * Encolher processo só no próximo boot (planStickyGrow nunca reduz shard count).
 */
function calcLiveDesiredWorkerNodes({ totalMB, divisorGb, totalProfiles } = {}) {
  return calcWorkerNodes({ totalMB, divisorGb, totalProfiles });
}

/**
 * Grow ao vivo: contas novas, sem mover quem já tem dono, sem encolher processo.
 * desiredNodes = calcWorkerNodes(...). Sobra de contas vai ao menor shard.
 *
 * @param {object} opts
 * @param {string[][]} opts.currentShards
 * @param {string[]} opts.namesNow
 * @param {number} opts.desiredNodes
 */
function planStickyGrow({ currentShards, namesNow, desiredNodes } = {}) {
  const shardsIn = Array.isArray(currentShards) ? currentShards : [];
  const now = (Array.isArray(namesNow) ? namesNow : [])
    .map((n) => String(n || '').trim())
    .filter(Boolean);
  const nowSet = new Set(now);
  const nextShards = shardsIn.map((shard) => (
    (Array.isArray(shard) ? shard : [])
      .map((n) => String(n || '').trim())
      .filter((n) => nowSet.has(n))
  ));
  const assigned = new Set();
  for (const shard of nextShards) {
    for (const n of shard) assigned.add(n);
  }
  const desired = Math.max(1, Math.floor(Number(desiredNodes) || 1));
  const growFrom = nextShards.length;
  while (nextShards.length < desired) nextShards.push([]);
  const added = now
    .filter((n) => !assigned.has(n))
    .slice()
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  for (const n of added) {
    let bestIdx = 0;
    let bestSize = Infinity;
    for (let i = 0; i < nextShards.length; i++) {
      const sz = nextShards[i].length;
      if (sz < bestSize) {
        bestSize = sz;
        bestIdx = i;
      }
    }
    nextShards[bestIdx].push(n);
    assigned.add(n);
  }
  return {
    nextShards,
    added,
    growFrom,
    growTo: nextShards.length,
    grew: nextShards.length > growFrom,
    newWorkerIndexes: Array.from({ length: Math.max(0, nextShards.length - growFrom) }, (_, i) => growFrom + i)
  };
}

/**
 * Redistribuição igual (boot / abrir-tudo com Chrome fechado).
 * Diferença máxima 1 entre Workers. Não nasce nem mata processo.
 */
function planFairReshuffle({ names, nodes } = {}) {
  const list = (Array.isArray(names) ? names : [])
    .map((n) => String(n || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  const count = Math.max(1, Math.floor(Number(nodes) || 1));
  const nextShards = Array.from({ length: count }, () => []);
  list.forEach((name, idx) => {
    nextShards[idx % count].push(name);
  });
  return { nextShards, accounts: list.length, nodes: count };
}

/**
 * Plano de boot: quantos Workers e o orçamento de RAM em volta deles.
 * Spawn inicial em createCluster; grow ao vivo quando nasce conta e ainda cabe no divisor.
 *
 * @param {object} opts
 * @param {number} opts.totalProfiles — perfis.json total
 * @returns {object}
 */
function planMemoryAndShards({ totalProfiles }) {
  const totalMB = mb(os.totalmem());
  const runtimeCfg = (() => {
    try { return serverConfig.readServerConfigEffective({ totalMemMB: totalMB }); } catch { return null; }
  })();
  const divisorGb = clampWorkerRamDivisorGb(
    runtimeCfg && runtimeCfg.memory && runtimeCfg.memory.workerRamDivisorGb
  );
  const NODE_SEG_MB = divisorGb * 1024;
  const NODE_OVERHEAD_MB = 2048;
  const CHROME_AVG_MB = 600;
  const configuredGlobalCap = Math.max(1, Number(runtimeCfg && runtimeCfg.capacity && runtimeCfg.capacity.maxAccountsEffective || 0) || 1);
  const hardwareNodes = Math.max(1, Math.ceil(totalMB / NODE_SEG_MB));
  const nodes = calcWorkerNodes({
    totalMB,
    divisorGb,
    totalProfiles
  });

  const cushionMB = Math.max(Math.floor(totalMB * 0.10), 2048);
  const reservedForOverheadMB = nodes * NODE_OVERHEAD_MB;
  const usableMB = Math.max(0, totalMB - cushionMB);
  const remainingForChromesMB = Math.max(0, usableMB - reservedForOverheadMB);

  const maxChromesPossibleGlobal = Math.min(
    totalProfiles,
    configuredGlobalCap,
    Math.floor(remainingForChromesMB / CHROME_AVG_MB)
  );

  const maxPerNodeByConfig = Math.max(1, Math.ceil(configuredGlobalCap / Math.max(1, nodes)));
  const targetPerNode = Math.min(
    maxPerNodeByConfig,
    Math.max(1, Math.ceil(maxChromesPossibleGlobal / nodes))
  );

  return {
    totalMB,
    cushionMB,
    usableMB,
    nodes,
    perNode: {
      maxChromes: targetPerNode
    },
    budgets: {
      nodeSegmentMB: NODE_SEG_MB,
      reservedForOverheadMB,
      remainingForChromesMB,
      chromeAvgMB: CHROME_AVG_MB
    },
    serverConfig: {
      workerRamDivisorGb: divisorGb,
      hardwareNodes,
      capacityMode: runtimeCfg && runtimeCfg.capacity ? runtimeCfg.capacity.mode : 'unknown',
      maxAccountsEffective: configuredGlobalCap
    }
  };
}

module.exports = {
  planMemoryAndShards,
  calcWorkerNodes,
  calcLiveDesiredWorkerNodes,
  clampWorkerRamDivisorGb,
  planStickyGrow,
  planFairReshuffle
};
