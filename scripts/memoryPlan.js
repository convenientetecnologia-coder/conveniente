// scripts/memoryPlan.js

const os = require('os');

/**
 * Converte bytes em MB.
 * @param {number} x
 * @returns {number}
 */
function mb(x) { return Math.floor(x / (1024 * 1024)); }

function calcNominal8GbBlocks(totalMB) {
  // Capacidade por faixa nominal de hardware:
  // 8GB => 1 bloco; 16GB => 2 blocos; etc.
  // Usa tolerância de 1GB para evitar penalizar hosts que reportam levemente
  // abaixo do nominal, sem "promover" 9GB para 16GB.
  // Regra de baseline operacional: qualquer host < 8GB é tratado como 8GB.
  const mbTotalRaw = Math.max(1, Number(totalMB) || 0);
  const mbTotal = Math.max(8192, mbTotalRaw);
  return Math.max(1, Math.floor((mbTotal + 1024) / 8192));
}

/**
 * Calcula plano automático de memória/sharding para multi-node, multinacional.
 * - NODES = ceil(RAM FÍSICA / 16GB) (NUNCA por RAM livre!)
 * - 10% colchão (min 2GB)
 * - Overhead de 2GB por Node.
 * - Limite de ~10 perfis por Node, nunca mais.
 * - Nunca ENV/manual; tudo autodetect.
 *
 * @param {object} opts
 * @param {number} opts.totalProfiles — perfis.json total
 * @returns {object} — plano de ram/sharding
 */
function planMemoryAndShards({ totalProfiles }) {
  const totalMB = mb(os.totalmem());
  const cushionMB = Math.max(Math.floor(totalMB * 0.10), 2048); // 10% colchão, min 2GB
  const NODE_SEG_MB = 16384; // 16GB por Node
  const NODE_OVERHEAD_MB = 2048; // 2GB por Node
  const CHROME_AVG_MB = 600;
  // Política fixa por faixa nominal: 10 contas por 8GB (8=>10, 16=>20, ...).
  const blocks8gb = calcNominal8GbBlocks(totalMB);
  const configuredGlobalCap = Math.max(1, blocks8gb * 10);

  // 1) Nodes exatos PELO HARDWARE, independente de RAM livre
  let nodes = Math.ceil(totalMB / NODE_SEG_MB);
  if (nodes < 1) nodes = 1;

  // 2) Limite para não rodar mais nodes do que perfis disponíveis
  // (mas nunca limita nodes por RAM SOBRANTE/livre, só por máximo necessário para os perfis)
  const nodesByProfiles = Math.max(1, Math.ceil(totalProfiles / Math.max(1, Math.ceil(configuredGlobalCap / Math.max(1, nodes)))));
  nodes = Math.min(nodes, nodesByProfiles);

  // 3) RAM útil para Chrome: colchão e overhead só para calcular máximo de Chromes globais
  const reservedForOverheadMB = nodes * NODE_OVERHEAD_MB;
  const usableMB = Math.max(0, totalMB - cushionMB);
  const remainingForChromesMB = Math.max(0, usableMB - reservedForOverheadMB);

  // 4) Limite global de quantos Chrome (bots) o host aguenta (cap global por RAM sobra/dentro do hardware)
  const maxChromesPossibleGlobal = Math.min(
    totalProfiles,
    configuredGlobalCap,
    Math.floor(remainingForChromesMB / CHROME_AVG_MB)
  );

  // 5) Limite por Node
  const maxPerNodeByConfig = Math.max(1, Math.ceil(configuredGlobalCap / Math.max(1, nodes)));
  const targetPerNode = Math.min(
    maxPerNodeByConfig,
    Math.max(1, Math.ceil(maxChromesPossibleGlobal / nodes))
  );

  return {
    totalMB,
    cushionMB,
    usableMB,
    maxChromesPossibleGlobal,
    nodes,
    perNode: {
      maxChromes: targetPerNode
    },
    budgets: {
      reservedForOverheadMB,
      remainingForChromesMB,
      chromeAvgMB: CHROME_AVG_MB
    },
    serverConfig: {
      capacityMode: 'fixed_per_8gb',
      maxAccountsEffective: configuredGlobalCap
    }
  };
}

module.exports = { planMemoryAndShards };