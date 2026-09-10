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

function forceKillPids(pids) {
  const ids = Array.from(new Set((pids || []).map((p) => Math.floor(Number(p) || 0)).filter((n) => n > 4)));
  if (!ids.length) return;
  const args = ['/F', '/T'];
  for (const n of ids) {
    args.push('/PID', String(n));
  }
  try {
    spawnSync('taskkill.exe', args, { windowsHide: true, timeout: 8000 });
  } catch {}
}

function decodeWmicStdout(buf) {
  if (!buf) return '';
  if (Buffer.isBuffer(buf) && buf.length >= 2 && buf[1] === 0) return buf.toString('utf16le');
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
}

function listCellEntryPids() {
  if (process.platform !== 'win32') return [];
  try {
    const wmic = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wbem', 'WMIC.exe');
    const r = spawnSync(wmic, [
      'process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:list'
    ], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024
    });
    const seen = new Set();
    const out = [];
    let cmd = '';
    let pid = 0;
    const flush = () => {
      if (pid > 4 && pid !== process.pid && /cellEntry\.js/i.test(cmd) && !seen.has(pid)) {
        seen.add(pid);
        out.push(pid);
      }
      cmd = '';
      pid = 0;
    };
    for (const line of decodeWmicStdout(r && r.stdout).split(/\r?\n/)) {
      const s = String(line || '').replace(/\u0000/g, '').trim();
      if (!s) {
        flush();
        continue;
      }
      if (/^CommandLine=/i.test(s)) cmd = s.replace(/^CommandLine=/i, '');
      else if (/^ProcessId=/i.test(s)) pid = Math.floor(Number(s.replace(/^ProcessId=/i, '')) || 0);
    }
    flush();
    return out;
  } catch {
    return [];
  }
}

function clearCellStatusFiles() {
  const now = Date.now();
  for (let i = 1; i <= 8; i++) {
    const p = path.join(ROOT, 'dados', 'status_node_' + i + '.json');
    try {
      fs.writeFileSync(p, JSON.stringify({ ok: true, perfis: [], ts: now, cellsStopped: true }));
    } catch {}
  }
  const stPath = path.join(ROOT, 'dados', 'status.json');
  try {
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    if (st && Array.isArray(st.perfis)) {
      for (const p of st.perfis) {
        if (!p) continue;
        p.active = false;
        p.trabalhando = false;
        p.numPages = 0;
      }
      st.ts = now;
      fs.writeFileSync(stPath, JSON.stringify(st));
    }
  } catch {}
}

function stopAllCells({ reason = 'manual' } = {}) {
  const alive = cellRegistry.listAlive();
  const pids = alive.map((c) => Number(c.pid)).filter((n) => n > 0);
  try {
    cellForensic.append('cell_stop_all', { reason: String(reason).slice(0, 80), count: pids.length, pids });
  } catch {}
  forceKillPids(pids);
  const ports = new Set();
  for (const c of alive) {
    const p = Number(c && c.port) || cellRegistry.portForIdx(c && c.idx);
    if (p) ports.add(p);
  }
  for (let i = 0; i < 8; i++) ports.add(cellRegistry.portForIdx(i));
  try { cellRegistry.reapPorts(Array.from(ports), { keepPids: [process.pid] }); } catch {}
  const ghosts = listCellEntryPids();
  forceKillPids(ghosts);
  if (ghosts.length) {
    try { cellRegistry.reapPorts(Array.from(ports), { keepPids: [process.pid] }); } catch {}
  }
  const reg = cellRegistry.read();
  reg.cells = [];
  cellRegistry.write(reg);
  try { clearCellStatusFiles(); } catch {}
  const still = cellRegistry.listAlive();
  return {
    ok: still.length === 0,
    reason: String(reason || ''),
    requested: pids.length,
    forced: pids.length,
    ghosts: ghosts.length,
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
