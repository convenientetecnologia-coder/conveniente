// scripts/ramPolicy.js
// Política única de RAM (ultra enterprise)
//
// Regras:
// - Operação normal: manter livre (base fixa 2GB + reserva configurável por 8GB)
// - Provisão (pico cookies): manter livre (HOST_BASE_MB + PROVISION_SPIKE_MB)
//   (a reserva por 8GB é emprestável durante provisão, pois Robe/Virtus ficam controlados)

const os = require('os');
const FIXED_HOST_BASE_MB = 2048;
const DEFAULT_RESERVE_PER_8GB_MB = 512;

function mb(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function getTotalMemMB() {
  try { return mb(os.totalmem() / (1024 * 1024)); } catch { return 0; }
}

// Heurística atual do projeto: 1 node a cada 8GB (ceil)
function calcNodesByTotalMemMB(totalMB) {
  const total = mb(totalMB);
  const gb = total / 1024;
  const nodes = Math.max(1, Math.ceil(gb / 8));
  return nodes;
}

function getHostBaseMB() {
  return FIXED_HOST_BASE_MB;
}

function getProvisionSpikeMB() {
  return mb(process.env.PROVISION_SPIKE_MB || 1536);
}

function getReservePer8GbMB(totalMB = 0) {
  // Reserva fixa por 8GB: não depende mais do dashboard.
  return DEFAULT_RESERVE_PER_8GB_MB;
}

function calcReserveNormalMB(totalMB) {
  const base = getHostBaseMB();
  const nodes = calcNodesByTotalMemMB(totalMB);
  const reservePer8 = getReservePer8GbMB(totalMB);
  return base + (nodes * reservePer8);
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
  const reservePer8GbMB = getReservePer8GbMB(totalMB);
  return {
    totalMB,
    nodes,
    hostBaseMB: base,
    reservePer8GbMB,
    provisionSpikeMB: spike,
    reserveNormalMB: base + (nodes * reservePer8GbMB),
    reserveProvisionMB: base + spike
  };
}

module.exports = {
  getTotalMemMB,
  calcNodesByTotalMemMB,
  getHostBaseMB,
  getReservePer8GbMB,
  getProvisionSpikeMB,
  calcReserveNormalMB,
  calcReserveProvisionMB,
  snapshotPolicy
};

