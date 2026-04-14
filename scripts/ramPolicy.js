// scripts/ramPolicy.js
// Política única de RAM (ultra enterprise)
//
// Regras:
// - Operação normal: manter livre (base fixa 2GB + reserva configurável por 8GB)
// - Provisão (pico cookies): manter livre (HOST_BASE_MB + PROVISION_SPIKE_MB)
//   (a reserva por 8GB é emprestável durante provisão, pois Robe/Virtus ficam controlados)

const os = require('os');
const serverConfig = require('./serverConfig.js');
const FIXED_HOST_BASE_MB = 2048;
const DEFAULT_RESERVE_PER_8GB_MB = 1024;
const ALLOWED_RESERVE_PER_8GB_MB = new Set([0, 256, 512, 1024, 2048, 4096, 8192, 16384]);

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

let _runtimeReservePer8Cache = { at: 0, value: DEFAULT_RESERVE_PER_8GB_MB, totalMB: 0 };
function getReservePer8GbMB(totalMB = 0) {
  const now = Date.now();
  const tmb = Math.max(0, Number(totalMB || 0) || getTotalMemMB());
  const stale = (now - Number(_runtimeReservePer8Cache.at || 0)) > 10_000;
  const memDrift = Math.abs(Number(_runtimeReservePer8Cache.totalMB || 0) - tmb) > 256;
  if (!stale && !memDrift) return _runtimeReservePer8Cache.value;
  let reservePer8 = DEFAULT_RESERVE_PER_8GB_MB;
  try {
    const cfg = serverConfig.readServerConfigEffective({ totalMemMB: tmb });
    const raw = Math.floor(Number(cfg && cfg.capacity && cfg.capacity.reservePer8GbMB));
    if (ALLOWED_RESERVE_PER_8GB_MB.has(raw)) reservePer8 = raw;
  } catch {}
  _runtimeReservePer8Cache = { at: now, totalMB: tmb, value: reservePer8 };
  return reservePer8;
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

