// scripts/ramPolicy.js
// Política única de RAM (ultra enterprise)
//
// Regras:
// - Operação normal: manter livre (base fixa 2GB + reserva por porte do servidor)
//   * Servidor de até 8GB: reserva extra = 0MB
//   * Acima de 8GB até 16GB: reserva extra = 1GB
//   * Acima de 16GB: soma +1GB por cada faixa adicional de 16GB
// - Provisão (pico cookies): manter livre (HOST_BASE_MB + PROVISION_SPIKE_MB)
//   (a reserva extra por porte é emprestável durante provisão, pois Robe/Virtus ficam controlados)

const os = require('os');
const FIXED_HOST_BASE_MB = 2048;
const RESERVE_STEP_TOTAL_MB = 16 * 1024;
const RESERVE_STEP_MB = 1024;

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
  return FIXED_HOST_BASE_MB;
}

function getProvisionSpikeMB() {
  return mb(process.env.PROVISION_SPIKE_MB || 1536);
}

function getReserveByHostSizeMB(totalMB = 0) {
  const total = mb(totalMB);
  // Regra operacional: até 8GB não adiciona reserva extra.
  if (total <= 8 * 1024) return 0;
  // Acima de 8GB, aplica ao menos 1GB e cresce por faixas de 16GB.
  const chunks16 = Math.max(1, Math.ceil(total / RESERVE_STEP_TOTAL_MB));
  return chunks16 * RESERVE_STEP_MB;
}

function calcReserveNormalMB(totalMB) {
  const base = getHostBaseMB();
  const reserveByHost = getReserveByHostSizeMB(totalMB);
  return base + reserveByHost;
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
  const reserveByHostSizeMB = getReserveByHostSizeMB(totalMB);
  return {
    totalMB,
    nodes,
    hostBaseMB: base,
    reserveByHostSizeMB,
    provisionSpikeMB: spike,
    reserveNormalMB: base + reserveByHostSizeMB,
    reserveProvisionMB: base + spike
  };
}

module.exports = {
  getTotalMemMB,
  calcNodesByTotalMemMB,
  getHostBaseMB,
  getReserveByHostSizeMB,
  getProvisionSpikeMB,
  calcReserveNormalMB,
  calcReserveProvisionMB,
  snapshotPolicy
};

