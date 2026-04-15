// scripts/memoryPlan.js

const os = require('os');

/**
 * Converte bytes em MB.
 * @param {number} x
 * @returns {number}
 */
function mb(x) { return Math.floor(x / (1024 * 1024)); }

/**
 * Calcula plano automático de memória/sharding para multi-node, multinacional.
 * - NODES = ceil(RAM FÍSICA / 8GB) (NUNCA por RAM livre!)
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
  const NODE_SEG_MB = 8192; // 8GB por Node
  const NODE_OVERHEAD_MB = 2048; // 2GB por Node
  const CHROME_AVG_MB = 600;
  // Política fixa: 10 contas por 8GB.
  const totalGB = Math.max(1, totalMB / 1024);
  const configuredGlobalCap = Math.max(1, Math.floor(totalGB * (10 / 8)));

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