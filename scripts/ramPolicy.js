// scripts/ramPolicy.js
// Política única de RAM (ultra enterprise)
//
// Regras:
// - Operação normal: manter livre (hostBaseMb + reservePer8GbMb × nós),
//   nós = ceil(GB / workerRamDivisorGb).
//   Obs.: "reservePer8GbMb" é nome legado; o bloco real vem de workerRamDivisorGb.
// - Provisão (pico cookies): manter livre (hostBaseMb + provisionSpikeMb)
//   Valores default e limites: server_runtime_config.json → memory (dashboard Config Servidor).

const os = require('os');
const serverConfig = require('./serverConfig.js');

function mb(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function getTotalMemMB() {
  try { return Math.max(0, Math.floor(os.totalmem() / (1024 * 1024))); } catch { return 0; }
}

function getWorkerRamDivisorGB(memoryConfig) {
  const m = (memoryConfig && typeof memoryConfig === 'object')
    ? memoryConfig
    : getConfigMemory();
  const n = Math.floor(Number(m && m.workerRamDivisorGb));
  if (!Number.isFinite(n)) return 16;
  return Math.max(4, Math.min(32, n));
}

// Reserva de RAM livre: slots pelo hardware (ceil(GB / divisor)).
// Não corta por quantidade de contas — isso só vale no spawn de Workers (memoryPlan).
function calcNodesByTotalMemMB(totalMB, memoryConfig) {
  const total = mb(totalMB);
  const gb = total / 1024;
  const divisorGb = getWorkerRamDivisorGB(memoryConfig);
  const nodes = Math.max(1, Math.ceil(gb / divisorGb));
  return nodes;
}

function getConfigMemory() {
  try {
    const cfg = serverConfig.readServerConfigEffective();
    if (cfg && cfg.memory && typeof cfg.memory === 'object') return cfg.memory;
  } catch {}
  return null;
}

function getHostBaseMB(memoryConfig) {
  const m = (memoryConfig && typeof memoryConfig === 'object')
    ? memoryConfig
    : getConfigMemory();
  const v = m && m.hostBaseMb;
  if (Number.isFinite(Number(v)) && Number(v) > 0) return mb(Number(v));
  return mb(process.env.HOST_BASE_MB || 2048);
}

function getReservePer8GbMB(memoryConfig) {
  const m = (memoryConfig && typeof memoryConfig === 'object')
    ? memoryConfig
    : getConfigMemory();
  const v = m && m.reservePer8GbMb;
  if (Number.isFinite(Number(v)) && Number(v) >= 0) return mb(Number(v));
  return 768;
}

function getProvisionSpikeMB(memoryConfig) {
  const m = (memoryConfig && typeof memoryConfig === 'object')
    ? memoryConfig
    : getConfigMemory();
  const v = m && m.provisionSpikeMb;
  if (Number.isFinite(Number(v)) && Number(v) > 0) return mb(Number(v));
  return mb(process.env.PROVISION_SPIKE_MB || 1536);
}

function calcReserveNormalMB(totalMB) {
  const m = getConfigMemory();
  const base = getHostBaseMB(m);
  const nodes = calcNodesByTotalMemMB(totalMB, m);
  const per = getReservePer8GbMB(m);
  return base + (nodes * per);
}

function calcReserveProvisionMB(totalMB) {
  const m = getConfigMemory();
  const base = getHostBaseMB(m);
  const spike = getProvisionSpikeMB(m);
  return base + spike;
}

function snapshotPolicy() {
  const totalMB = getTotalMemMB();
  const m = getConfigMemory();
  const workerRamDivisorGB = getWorkerRamDivisorGB(m);
  const nodes = calcNodesByTotalMemMB(totalMB, m);
  const base = getHostBaseMB(m);
  const spike = getProvisionSpikeMB(m);
  const per = getReservePer8GbMB(m);
  return {
    totalMB,
    workerRamDivisorGB,
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
  getWorkerRamDivisorGB,
  calcNodesByTotalMemMB,
  getHostBaseMB,
  getProvisionSpikeMB,
  calcReserveNormalMB,
  calcReserveProvisionMB,
  snapshotPolicy
};

