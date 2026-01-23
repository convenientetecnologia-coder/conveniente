// scripts/ramPolicy.js
// Política única de RAM (ultra enterprise)
//
// Regras:
// - Operação normal: manter livre (HOST_BASE_MB + 1GB por node)
// - Provisão (pico cookies): manter livre (HOST_BASE_MB + PROVISION_SPIKE_MB)
//   (o "1GB por node" é emprestável durante provisão, pois Robe/Virtus ficam controlados)

const os = require('os');

function mb(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function getTotalMemMB() {
  try { return mb(os.totalmem() / (1024 * 1024)); } catch { return 0; }
}

// Heurística atual do projeto: 1 node a cada 16GB (ceil)
function calcNodesByTotalMemMB(totalMB) {
  const total = mb(totalMB);
  const gb = total / 1024;
  const nodes = Math.max(1, Math.ceil(gb / 16));
  return nodes;
}

function getHostBaseMB() {
  return mb(process.env.HOST_BASE_MB || 2048);
}

function getProvisionSpikeMB() {
  return mb(process.env.PROVISION_SPIKE_MB || 1536);
}

function calcReserveNormalMB(totalMB) {
  const base = getHostBaseMB();
  const nodes = calcNodesByTotalMemMB(totalMB);
  return base + (nodes * 1024);
}

function calcReserveProvisionMB(totalMB) {
  const base = getHostBaseMB();
  const spike = getProvisionSpikeMB();
  return base + spike;
}

function snapshotPolicy() {
  const totalMB = getTotalMemMB();
  const nodes = calcNodesByTotalMemMB(totalMB);
  const base = getHostBaseMB();
  const spike = getProvisionSpikeMB();
  return {
    totalMB,
    nodes,
    hostBaseMB: base,
    provisionSpikeMB: spike,
    reserveNormalMB: base + (nodes * 1024),
    reserveProvisionMB: base + spike
  };
}

module.exports = {
  getTotalMemMB,
  calcNodesByTotalMemMB,
  getHostBaseMB,
  getProvisionSpikeMB,
  calcReserveNormalMB,
  calcReserveProvisionMB,
  snapshotPolicy
};

