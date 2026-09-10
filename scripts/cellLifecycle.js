'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const cellRegistry = require('./cellRegistry.js');
const cellForensic = require('./cellForensic.js');

const ROOT = path.join(__dirname, '..');
const STAMP_FILES = [
  'index.js',
  'scripts/cellEntry.js',
  'scripts/cellCommandBus.js',
  'scripts/cellNet.js',
  'scripts/cellRegistry.js',
  'scripts/cellLifecycle.js',
  'scripts/clusterMaster.js',
  'scripts/worker.js',
  'scripts/workerIpc.js',
  'scripts/browser.js',
  'scripts/chromeMotores.js'
];

function currentStamp() {
  const h = crypto.createHash('sha256');
  try {
    const headPath = path.join(ROOT, '.git', 'HEAD');
    const head = fs.readFileSync(headPath, 'utf8').trim();
    h.update(head);
    if (head.indexOf('ref:') === 0) {
      const ref = head.slice(4).trim();
      try { h.update(fs.readFileSync(path.join(ROOT, '.git', ref))); } catch {}
    }
  } catch {}
  for (const rel of STAMP_FILES) {
    try {
      const st = fs.statSync(path.join(ROOT, rel));
      h.update(rel);
      h.update(String(st.size));
      h.update(String(Math.floor(st.mtimeMs)));
    } catch {
      h.update(rel + ':missing');
    }
  }
  return h.digest('hex').slice(0, 16);
}

function savedStamp() {
  try {
    const reg = cellRegistry.read();
    return String((reg && reg.codeStamp) || '').trim();
  } catch {
    return '';
  }
}

function isStampStale() {
  const disk = currentStamp();
  const saved = savedStamp();
  if (!disk) return false;
  if (!saved) return cellRegistry.hasAliveCells();
  return saved !== disk;
}

function isTopologyStale() {
  const alive = cellRegistry.listAlive();
  if (!alive.length) return false;
  try {
    const fileStore = require('./fileStore.js');
    const { planMemoryAndShards } = require('./memoryPlan.js');
    const names = (fileStore.loadPerfisJson() || []).map((p) => p && p.nome).filter(Boolean);
    const plan = planMemoryAndShards({ totalProfiles: names.length });
    const want = Math.max(1, Number(plan.nodes) || 1);
    if (alive.length !== want) return true;
    const saved = cellRegistry.read().topology;
    if (saved && saved.divisorGb) {
      const wantDiv = Math.max(4, Number(plan.serverConfig && plan.serverConfig.workerRamDivisorGb) || 16);
      if (Number(saved.divisorGb) !== wantDiv) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function setStamp(stamp) {
  const reg = cellRegistry.read();
  reg.codeStamp = String(stamp || currentStamp());
  cellRegistry.write(reg);
  return reg.codeStamp;
}

function setTopology({ divisorGb, hardwareNodes, nodes } = {}) {
  const reg = cellRegistry.read();
  reg.topology = {
    divisorGb: Math.max(4, Number(divisorGb) || 16),
    hardwareNodes: Math.max(1, Number(hardwareNodes) || 1),
    nodes: Math.max(1, Number(nodes) || 1)
  };
  cellRegistry.write(reg);
  return reg.topology;
}

function sleepMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  } catch {
    const end = Date.now() + n;
    while (Date.now() < end) { /* wait */ }
  }
}

function forceKillPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!n) return;
  try {
    spawnSync('taskkill.exe', ['/F', '/PID', String(n), '/T'], {
      windowsHide: true,
      timeout: 15000
    });
  } catch {}
}

function stopAllCells({ reason = 'manual' } = {}) {
  const alive = cellRegistry.listAlive();
  const pids = alive.map((c) => Number(c.pid)).filter((n) => n > 0);
  try {
    cellForensic.append('cell_stop_all', { reason: String(reason).slice(0, 80), count: pids.length, pids });
  } catch {}
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (cellRegistry.listAlive().length === 0) break;
    sleepMs(400);
  }
  const leftover = cellRegistry.listAlive();
  for (const c of leftover) forceKillPid(c.pid);
  const ports = new Set();
  for (const c of alive.concat(leftover)) {
    const p = Number(c && c.port) || cellRegistry.portForIdx(c && c.idx);
    if (p) ports.add(p);
  }
  for (let i = 0; i < 8; i++) ports.add(cellRegistry.portForIdx(i));
  for (const port of ports) {
    try { cellRegistry.reapPort(port, { keepPids: [process.pid] }); } catch {}
  }
  const reg = cellRegistry.read();
  reg.cells = [];
  cellRegistry.write(reg);
  const still = cellRegistry.listAlive();
  return {
    ok: still.length === 0,
    reason: String(reason || ''),
    requested: pids.length,
    forced: leftover.length,
    alive: still.length,
    pids
  };
}

if (require.main === module) {
  const arg = String(process.argv[2] || '').trim();
  if (arg === 'stamp') {
    process.stdout.write(currentStamp());
    process.exit(0);
  }
  if (arg === 'stale') {
    process.stdout.write(isStampStale() ? '1' : '0');
    process.exit(0);
  }
  if (arg === 'topo-stale') {
    process.stdout.write(isTopologyStale() ? '1' : '0');
    process.exit(0);
  }
  if (arg === 'stop') {
    const r = stopAllCells({ reason: String(process.argv[3] || 'cli') });
    process.stdout.write(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  process.stderr.write('usage: cellLifecycle.js stamp|stale|topo-stale|stop\n');
  process.exit(2);
}

module.exports = {
  currentStamp,
  savedStamp,
  isStampStale,
  isTopologyStale,
  setStamp,
  setTopology,
  stopAllCells
};
