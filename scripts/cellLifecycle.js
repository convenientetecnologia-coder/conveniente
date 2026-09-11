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

let __cellEntryAt = 0;
let __cellEntryPids = [];
let __nodeCmdAt = 0;
let __nodeCmds = [];

function forceKillPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!n || n === process.pid || n <= 4) return;
  try {
    spawnSync('taskkill.exe', ['/F', '/PID', String(n)], {
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {}
  try { process.kill(n, 9); } catch {}
  __cellEntryAt = 0;
  __nodeCmdAt = 0;
  try { cellRegistry.invalidateListenCache(); } catch {}
}

function silentExec(file, args, timeoutMs) {
  try {
    return require('child_process').execFileSync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: Math.max(800, Number(timeoutMs) || 2500),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    return String((e && e.stdout) || '');
  }
}

function parseWmicPidCmd(raw) {
  const rows = [];
  let cmd = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      cmd = '';
      continue;
    }
    if (/^CommandLine=/i.test(t)) {
      cmd = t.slice(t.indexOf('=') + 1);
      continue;
    }
    if (/^ProcessId=/i.test(t)) {
      const pid = Math.floor(Number(t.slice(t.indexOf('=') + 1)) || 0);
      if (pid > 0) rows.push({ pid, cmd: cmd || '' });
      cmd = '';
    }
  }
  return rows;
}

function listNodePidCmds() {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (__nodeCmdAt && (now - __nodeCmdAt) < 600) return __nodeCmds.slice();
  const rows = parseWmicPidCmd(silentExec('wmic.exe', [
    'process',
    'where',
    "name='node.exe'",
    'get',
    'ProcessId,CommandLine',
    '/FORMAT:LIST'
  ], 3000));
  __nodeCmdAt = Date.now();
  __nodeCmds = rows;
  return rows.slice();
}

function isCellEntryCmd(cmd) {
  return String(cmd || '').toLowerCase().indexOf('cellentry.js') >= 0;
}

function isIndexCmd(cmd) {
  const low = String(cmd || '').toLowerCase();
  return low.indexOf('index.js') >= 0 && low.indexOf('cellentry.js') < 0;
}

function listCellEntryPids() {
  const now = Date.now();
  if (__cellEntryAt && (now - __cellEntryAt) < 600) return __cellEntryPids.slice();
  const out = [];
  for (const row of listNodePidCmds()) {
    if (row.pid > 4 && row.pid !== process.pid && isCellEntryCmd(row.cmd)) out.push(row.pid);
  }
  __cellEntryAt = Date.now();
  __cellEntryPids = out;
  return out.slice();
}

function pidCommandLine(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 0)) return '';
  for (const row of listNodePidCmds()) {
    if (row.pid === n) return row.cmd || '';
  }
  return '';
}

function isSkippableListenPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 0) || n === process.pid || n <= 4) return true;
  const cmd = pidCommandLine(n);
  if (cmd && isIndexCmd(cmd)) return true;
  if (cmd && !isCellEntryCmd(cmd)) return true;
  return false;
}

function terminateCellEntriesByCmd() {
  if (process.platform !== 'win32') return;
  silentExec('wmic.exe', [
    'process',
    'where',
    "Name='node.exe' and CommandLine like '%cellEntry.js%'",
    'call',
    'terminate'
  ], 5000);
  __cellEntryAt = 0;
  const left = listCellEntryPids();
  if (!left.length) return;
  silentExec(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like '*cellEntry.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ], 8000);
  __cellEntryAt = 0;
}

function needRestart() {
  if (!cellRegistry.hasAliveCells()) return true;
  return isStampStale() || isTopologyStale();
}

function realCellListenRows() {
  const rows = [];
  for (const row of cellRegistry.collectListenPids(8, { force: true })) {
    if (isSkippableListenPid(row.pid)) continue;
    rows.push(row);
  }
  return rows;
}

function killListenUntilFree(timeoutMs) {
  const started = Date.now();
  const limit = Math.max(500, Number(timeoutMs) || 10000);
  while ((Date.now() - started) < limit) {
    const rows = realCellListenRows();
    const entry = listCellEntryPids();
    if (!rows.length && !entry.length) return { ok: true, left: [] };
    for (const row of rows) forceKillPid(row.pid);
    for (const pid of entry) forceKillPid(pid);
    sleepMs(80);
  }
  const left = realCellListenRows();
  return { ok: left.length === 0 && listCellEntryPids().length === 0, left };
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

let bootRecycled = false;

function consumeBootRecycle() {
  const v = !!bootRecycled;
  bootRecycled = false;
  return v;
}

function stopAllCells({ reason = 'manual' } = {}) {
  const why = String(reason || 'manual');
  const mustDie = /api_cells_stop|stop_workers|code_stamp|boot_hold|topology/.test(why);
  const bootFast = !mustDie && /boot_|index_ctrl_c|maestro_kill/.test(why);
  if (mustDie || /boot_|code_stamp|topology/.test(why)) bootRecycled = true;
  const listen1 = mustDie ? 8000 : (bootFast ? 2000 : 8000);
  const listen2 = mustDie ? 4000 : (bootFast ? 800 : 3000);
  const alive = cellRegistry.listAlive();
  const pids = [];
  const seen = new Set();
  function addPid(pid) {
    const n = Math.floor(Number(pid) || 0);
    if (!(n > 0) || n === process.pid || n <= 4 || seen.has(n)) return;
    if (isSkippableListenPid(n)) return;
    seen.add(n);
    pids.push(n);
  }
  for (const c of alive) addPid(c && c.pid);
  for (const row of realCellListenRows()) addPid(row && row.pid);
  for (const pid of listCellEntryPids()) addPid(pid);
  const owners = [];
  try {
    for (const row of cellRegistry.collectListenPids(8, { force: true })) {
      owners.push({
        port: row.port,
        pid: row.pid,
        skip: isSkippableListenPid(row.pid),
        cmd: String(pidCommandLine(row.pid) || '').slice(0, 160)
      });
    }
  } catch {}
  try {
    cellForensic.append('cell_stop_all', {
      reason: why.slice(0, 80),
      count: pids.length,
      pids,
      listen1,
      owners
    });
  } catch {}
  for (const pid of pids) forceKillPid(pid);
  terminateCellEntriesByCmd();
  let chrome = { killed: 0, matched: 0 };
  try {
    chrome = require('./orphanReaper.js').reapAllConvenienteChrome(why || 'stop_all_cells');
  } catch {}
  let freed = killListenUntilFree(listen1);
  if (!freed.ok) {
    terminateCellEntriesByCmd();
    try {
      const again = require('./orphanReaper.js').reapAllConvenienteChrome(why || 'stop_all_cells_retry');
      if (again && again.killed != null) chrome.killed = (chrome.killed || 0) + again.killed;
    } catch {}
    freed = killListenUntilFree(listen2);
  }
  const stillListen = Array.isArray(freed.left) ? freed.left : realCellListenRows();
  const entryLeft = listCellEntryPids();
  const ok = stillListen.length === 0 && entryLeft.length === 0;
  const reg = cellRegistry.read();
  reg.cells = [];
  cellRegistry.write(reg);
  return {
    ok,
    error: ok
      ? null
      : (stillListen.length
        ? ('celula_ainda_na_porta:' + stillListen.map((r) => r.port).join(','))
        : (entryLeft.length ? 'celula_ainda_viva' : 'nao_encerrou')),
    reason: String(reason || ''),
    requested: pids.length,
    forced: pids.length,
    alive: 0,
    listenLeft: stillListen.length,
    chromeKilled: chrome && chrome.killed != null ? chrome.killed : 0,
    pids,
    owners
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
  consumeBootRecycle,
  listCellEntryPids,
  countDesiredActive,
  browsersWorking
};
