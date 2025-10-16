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
 * - 10% colchão (min 2GB)
 * - Cada Node: 16GB bloco
 * - Overhead de 2GB por Node.
 * - Limite de ~30 perfis por Node, nunca mais.
 * - Nunca ENV/manual; tudo autodetect.
 *
 * @param {object} opts
 * @param {number} opts.totalProfiles — perfis.json total
 * @returns {object} — plano de ram/sharding
 */
function planMemoryAndShards({ totalProfiles }) {
  const totalMB = mb(os.totalmem());
  const cushionMB = Math.max(Math.floor(totalMB * 0.10), 2048); // 10% colchão, min 2GB
  const usableMB = Math.max(0, totalMB - cushionMB);

  const NODE_SEG_MB = 16384; // 16GB/node
  const NODE_OVERHEAD_MB = 2048; // 2GB por node
  const MAX_PER_NODE = 30;
  const CHROME_AVG_MB = 600; // uso inicial robusto/Chrome com bots ativos

  // Quantos nodes possíveis pelo critério RAM (não>MAX_PER_NODE/profiles)
  let nodes = Math.floor(usableMB / NODE_SEG_MB);
  if (nodes < 1) nodes = 1;

  // Limite também pelo número de perfis (não ter node ocioso)
  const nodesByProfiles = Math.max(1, Math.ceil(totalProfiles / MAX_PER_NODE));
  nodes = Math.min(nodes, nodesByProfiles);

  // Overhead total pro Node processes
  const reservedForOverheadMB = nodes * NODE_OVERHEAD_MB;
  const remainingForChromesMB = Math.max(0, usableMB - reservedForOverheadMB);

  // Limite final de quantos Chrome (bots) o host aguenta
  const maxChromesPossibleGlobal = Math.min(
    totalProfiles,
    Math.floor(remainingForChromesMB / CHROME_AVG_MB)
  );

  // Limite per Node (MAX_PER_NODE, global cap, nunca <1)
  const targetPerNode = Math.min(
    MAX_PER_NODE,
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
      reservedForOverheadMB,
      remainingForChromesMB,
      chromeAvgMB: CHROME_AVG_MB
    }
  };
}

module.exports = { planMemoryAndShards };