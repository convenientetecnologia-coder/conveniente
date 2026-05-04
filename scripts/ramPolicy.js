// scripts/ramPolicy.js
// Política única de RAM (ultra enterprise)
//
// Regras:
// - Operação normal: manter livre (hostBaseMb + reservePer8GbMb × nós), nós = ceil(GB/8)
// - Provisão (pico cookies): manter livre (hostBaseMb + provisionSpikeMb)
//   Valores default e limites: server_runtime_config.json → memory (dashboard Config Servidor).

const os = require('os');
const serverConfig = require('./serverConfig.js');

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

function getConfigMemory() {
  try {
    const cfg = serverConfig.readServerConfigEffective();
    if (cfg && cfg.memory && typeof cfg.memory === 'object') return cfg.memory;
  } catch {}
  return null;
}

function getHostBaseMB() {
  const m = getConfigMemory();
  const v = m && m.hostBaseMb;
  if (Number.isFinite(Number(v)) && Number(v) > 0) return mb(Number(v));
  return mb(process.env.HOST_BASE_MB || 2048);
}

function getReservePer8GbMB() {
  const m = getConfigMemory();
  const v = m && m.reservePer8GbMb;
  if (Number.isFinite(Number(v)) && Number(v) >= 0) return mb(Number(v));
  return 1024;
}

function getProvisionSpikeMB() {
  const m = getConfigMemory();
  const v = m && m.provisionSpikeMb;
  if (Number.isFinite(Number(v)) && Number(v) > 0) return mb(Number(v));
  return mb(process.env.PROVISION_SPIKE_MB || 1536);
}

function calcReserveNormalMB(totalMB) {
  const base = getHostBaseMB();
  const nodes = calcNodesByTotalMemMB(totalMB);
  const per = getReservePer8GbMB();
  return base + (nodes * per);
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
  const per = getReservePer8GbMB();
  return {
    totalMB,
    nodes,
    hostBaseMB: base,
    provisionSpikeMB: spike,
    reservePer8GbMB: per,
    reserveNormalMB: base + (nodes * per),
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

