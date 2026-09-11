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
      timeout: 15000,
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {}
  try { cellRegistry.invalidateListenCache(); } catch {}
}

function needRestart() {
  if (!cellRegistry.hasAliveCells()) return true;
  return isStampStale() || isTopologyStale();
}

function killListenUntilFree(timeoutMs) {
  const started = Date.now();
  const limit = Math.max(500, Number(timeoutMs) || 10000);
  while ((Date.now() - started) < limit) {
    const rows = cellRegistry.collectListenPids(8);
    if (!rows.length) return { ok: true, left: [] };
    for (const row of rows) forceKillPid(row.pid);
    sleepMs(250);
  }
  const left = cellRegistry.collectListenPids(8);
  return { ok: left.length === 0, left };
}

function countDesiredActive() {
  try {
    const fileStore = require('./fileStore.js');
    const d = fileStore.readJsonSafe(fileStore.desiredPath, { perfis: {} }) || {};
    const perf = (d && d.perfis && typeof d.perfis === 'object') ? d.perfis : {};
    let n = 0;
    for (const k of Object.keys(perf)) {
      if (perf[k] && perf[k].active === true) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

function browsersWorking() {
  let chrome = 0;
  try { chrome = require('./orphanReaper.js').countConvenienteChrome(); } catch { chrome = -1; }
  const desired = countDesiredActive();
  const yes = (Number(chrome) > 0) || (desired > 0);
  return { yes, chrome: Number(chrome) || 0, desired };
}

function stopAllCells({ reason = 'manual' } = {}) {
  const why = String(reason || 'manual');
  const bootFast = /boot_|code_stamp|topology|index_ctrl_c|maestro_kill/.test(why) && !/api_cells_stop|stop_workers/.test(why);
  const listen1 = bootFast ? 2000 : 10000;
  const listen2 = bootFast ? 800 : 5000;
  const alive = cellRegistry.listAlive();
  const pids = [];
  const seen = new Set();
  function addPid(pid) {
    const n = Math.floor(Number(pid) || 0);
    if (!(n > 0) || seen.has(n)) return;
    seen.add(n);
    pids.push(n);
  }
  for (const c of alive) addPid(c && c.pid);
  for (const row of cellRegistry.collectListenPids(8)) addPid(row && row.pid);
  try {
    cellForensic.append('cell_stop_all', { reason: why.slice(0, 80), count: pids.length, pids, listen1 });
  } catch {}
  for (const pid of pids) forceKillPid(pid);
  let chrome = { killed: 0, matched: 0 };
  try {
    chrome = require('./orphanReaper.js').reapAllConvenienteChrome(why || 'stop_all_cells');
  } catch {}
  let freed = killListenUntilFree(listen1);
  if (!freed.ok) {
    try {
      const again = require('./orphanReaper.js').reapAllConvenienteChrome(why || 'stop_all_cells_retry');
      if (again && again.killed != null) chrome.killed = (chrome.killed || 0) + again.killed;
    } catch {}
    freed = killListenUntilFree(listen2);
  }
  const stillListen = freed.left || cellRegistry.collectListenPids(8);
  const still = cellRegistry.listAlive();
  const ok = stillListen.length === 0 && still.length === 0;
  const reg = cellRegistry.read();
  if (ok) {
    reg.cells = [];
    cellRegistry.write(reg);
  } else {
    for (const row of stillListen) {
      try {
        cellRegistry.upsertCell({
          idx: row.idx,
          pid: row.pid,
          port: row.port
        });
      } catch {}
    }
  }
  return {
    ok,
    error: ok
      ? null
      : (stillListen.length
        ? ('celula_ainda_na_porta:' + stillListen.map((r) => r.port).join(','))
        : 'celula_ainda_viva'),
    reason: String(reason || ''),
    requested: pids.length,
    forced: pids.length,
    alive: still.length,
    listenLeft: stillListen.length,
    chromeKilled: chrome && chrome.killed != null ? chrome.killed : 0,
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
  if (arg === 'need-restart') {
    process.stdout.write(needRestart() ? '1' : '0');
    process.exit(0);
  }
  if (arg === 'stop') {
    const r = stopAllCells({ reason: String(process.argv[3] || 'cli') });
    process.stdout.write(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
  process.stderr.write('usage: cellLifecycle.js stamp|stale|topo-stale|need-restart|stop\n');
  process.exit(2);
}

module.exports = {
  currentStamp,
  savedStamp,
  isStampStale,
  isTopologyStale,
  needRestart,
  setStamp,
  setTopology,
  forceKillPid,
  killListenUntilFree,
  stopAllCells,
  countDesiredActive,
  browsersWorking
};
