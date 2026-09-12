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

function pidExistsOnSystem(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 4)) return false;
  const listed = silentExec('tasklist.exe', ['/FI', 'PID eq ' + n, '/FO', 'CSV', '/NH'], 2500);
  const t = String(listed || '').trim();
  if (!t) return false;
  if (/nenhuma tarefa|no tasks are running/i.test(t)) return false;
  return t.indexOf('"' + n + '"') >= 0;
}

function invalidatePidCaches() {
  __cellEntryAt = 0;
  __nodeCmdAt = 0;
  try { cellRegistry.invalidateListenCache(); } catch {}
}

function taskkillPids(pids, { tree = true, timeoutMs = 8000 } = {}) {
  const list = [];
  const seen = new Set();
  for (const raw of (Array.isArray(pids) ? pids : [pids])) {
    const n = Math.floor(Number(raw) || 0);
    if (!(n > 4) || n === process.pid || seen.has(n)) continue;
    seen.add(n);
    list.push(n);
  }
  if (!list.length) return true;
  const args = ['/F'];
  if (tree) args.push('/T');
  for (const n of list) {
    args.push('/PID', String(n));
  }
  try {
    spawnSync('taskkill.exe', args, {
      windowsHide: true,
      timeout: Math.max(2000, Number(timeoutMs) || 8000),
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {}
  invalidatePidCaches();
  return list.every((n) => !pidExistsOnSystem(n));
}

function forceKillPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!n || n === process.pid || n <= 4) return false;
  taskkillPids([n], { tree: true, timeoutMs: 5000 });
  if (!pidExistsOnSystem(n)) return true;
  try {
    spawnSync('taskkill.exe', ['/F', '/PID', String(n)], {
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {}
  if (!pidExistsOnSystem(n)) {
    invalidatePidCaches();
    return true;
  }
  silentExec('wmic.exe', ['process', 'where', 'ProcessId=' + n, 'call', 'terminate'], 4000);
  if (!pidExistsOnSystem(n)) {
    invalidatePidCaches();
    return true;
  }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  silentExec(ps, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "Stop-Process -Id " + n + " -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter \"ProcessId=" + n + "\" -ErrorAction SilentlyContinue | Invoke-CimMethod -Name Terminate -ErrorAction SilentlyContinue | Out-Null"
  ], 6000);
  if (!pidExistsOnSystem(n)) {
    invalidatePidCaches();
    return true;
  }
  try {
    spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(n)], {
      windowsHide: true,
      timeout: 6000,
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch {}
  try { process.kill(n, 9); } catch {}
  invalidatePidCaches();
  return !pidExistsOnSystem(n);
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
  let rec = { pid: 0, cmd: '', name: '' };
  function flush() {
    if (rec.pid > 0) rows.push({ pid: rec.pid, cmd: rec.cmd || '', name: rec.name || '' });
    rec = { pid: 0, cmd: '', name: '' };
  }
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq);
    const val = t.slice(eq + 1);
    if (/^CommandLine$/i.test(key)) rec.cmd = val;
    else if (/^ProcessId$/i.test(key)) rec.pid = Math.floor(Number(val) || 0);
    else if (/^Name$/i.test(key)) rec.name = val;
  }
  flush();
  return rows;
}

function parseCimJson(raw) {
  const out = String(raw || '').trim();
  if (!out) return [];
  try {
    const json = JSON.parse(out);
    const arr = Array.isArray(json) ? json : (json ? [json] : []);
    return arr.map((p) => ({
      pid: Math.floor(Number(p && (p.ProcessId || p.pid)) || 0),
      cmd: String((p && (p.CommandLine || p.cmd)) || ''),
      name: String((p && (p.Name || p.name)) || '')
    })).filter((p) => p.pid > 0);
  } catch {
    return [];
  }
}

function listCimPidCmds(imageName) {
  if (process.platform !== 'win32') return [];
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const name = String(imageName || '').replace(/'/g, '');
  const cmd = name
    ? `Get-CimInstance Win32_Process -Filter "Name='${name}'" -ErrorAction SilentlyContinue | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
    : 'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
  const raw = silentExec(ps, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    cmd
  ], 8000);
  return parseCimJson(raw);
}

function listNodePidCmds() {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (__nodeCmdAt && (now - __nodeCmdAt) < 600) return __nodeCmds.slice();
  let rows = parseWmicPidCmd(silentExec('wmic.exe', [
    'process',
    'where',
    "name='node.exe'",
    'get',
    'ProcessId,Name,CommandLine',
    '/FORMAT:LIST'
  ], 3000));
  const missingCmd = !rows.length || rows.every((r) => !r.cmd);
  if (missingCmd) {
    const cim = listCimPidCmds('node.exe');
    if (cim.length) rows = cim;
  }
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

function listLiveCellPids() {
  const seen = new Set();
  const out = [];
  function add(pid) {
    const n = Math.floor(Number(pid) || 0);
    if (!(n > 4) || n === process.pid || seen.has(n)) return;
    if (isIndexCmd(pidCommandLine(n))) return;
    seen.add(n);
    out.push(n);
  }
  for (const pid of listCellEntryPids()) add(pid);
  for (const row of realCellListenRows()) add(row.pid);
  return out.filter((pid) => pidExistsOnSystem(pid));
}

function wantedCellCount() {
  try {
    const reg = cellRegistry.read();
    const n = Math.floor(Number(reg && reg.topology && reg.topology.nodes) || 0);
    if (n > 0) return Math.max(1, Math.min(16, n));
  } catch {}
  try {
    const fileStore = require('./fileStore.js');
    const { planMemoryAndShards } = require('./memoryPlan.js');
    const names = (fileStore.loadPerfisJson() || []).map((p) => p && p.nome).filter(Boolean);
    const plan = planMemoryAndShards({ totalProfiles: names.length });
    return Math.max(1, Math.min(16, Number(plan.nodes) || 1));
  } catch {
    return 1;
  }
}

function pidCommandLine(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 0)) return '';
  for (const row of listNodePidCmds()) {
    if (row.pid === n) return row.cmd || '';
  }
  return '';
}

function isProvenCellEntryPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 4) || n === process.pid) return false;
  return isCellEntryCmd(pidCommandLine(n));
}

function isNodePid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 4)) return false;
  return listNodePidCmds().some((row) => row.pid === n);
}

function isLikelyCellListenPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 4) || n === process.pid) return false;
  if (isProvenCellEntryPid(n)) return true;
  const cmd = pidCommandLine(n);
  if (cmd && isIndexCmd(cmd)) return false;
  if (cmd && !isCellEntryCmd(cmd)) return false;
  return !cmd && isNodePid(n);
}

function isSkippableListenPid(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!(n > 0) || n === process.pid || n <= 4) return true;
  return !isLikelyCellListenPid(n);
}

function listListenOwners(maxSlots) {
  const owners = [];
  try {
    for (const row of cellRegistry.collectListenPids(maxSlots || 32, { force: true })) {
      const cmd = pidCommandLine(row.pid);
      const node = listNodePidCmds().find((r) => r.pid === row.pid);
      owners.push({
        port: row.port,
        pid: row.pid,
        name: node && node.name ? String(node.name) : (isNodePid(row.pid) ? 'node.exe' : ''),
        cmd: String(cmd || '').slice(0, 200),
        cell: isProvenCellEntryPid(row.pid),
        likely: isLikelyCellListenPid(row.pid),
        skip: isSkippableListenPid(row.pid)
      });
    }
  } catch {}
  return owners;
}

function neutralizeWorkerStatusJournals(reason) {
  const dir = path.join(ROOT, 'dados');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^status_node_\d+\.json$/i.test(n));
  } catch {}
  names.push('status.json');
  const why = String(reason || 'encerrar').slice(0, 80);
  const ts = Date.now();
  for (const name of names) {
    const fp = path.join(dir, name);
    try {
      if (!fs.existsSync(fp)) continue;
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.perfis)) continue;
      for (const p of j.perfis) {
        if (!p || typeof p !== 'object') continue;
        p.active = false;
        p.trabalhando = false;
        p.configurando = false;
      }
      j.ts = ts;
      j.encerradoAt = ts;
      j.encerradoReason = why;
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(j));
      fs.renameSync(tmp, fp);
    } catch {}
  }
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
  for (const row of cellRegistry.collectListenPids(32, { force: true })) {
    if (!isLikelyCellListenPid(row.pid)) continue;
    rows.push(row);
  }
  return rows;
}

function reapForeignCellEntries(keepPids) {
  const keep = new Set();
  for (const p of (Array.isArray(keepPids) ? keepPids : [])) {
    const n = Math.floor(Number(p) || 0);
    if (n > 4) keep.add(n);
  }
  const victims = [];
  for (const pid of listLiveCellPids()) {
    if (keep.has(pid)) continue;
    victims.push(pid);
    forceKillPid(pid);
  }
  if (victims.length) {
    try {
      cellForensic.append('cell_reap_foreign', {
        keep: Array.from(keep),
        killed: victims
      });
    } catch {}
  }
  return { killed: victims.length, pids: victims };
}

function killListenUntilFree(timeoutMs) {
  const started = Date.now();
  const limit = Math.max(400, Number(timeoutMs) || 10000);
  while ((Date.now() - started) < limit) {
    const left = listLiveCellPids();
    if (!left.length) return { ok: true, left: [] };
    taskkillPids(left, { tree: true, timeoutMs: 4000 });
    sleepMs(80);
  }
  const left = listLiveCellPids();
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

let bootRecycled = false;
let cellsStopped = false;

function setCellsStopped(v) {
  cellsStopped = v === true;
  return cellsStopped;
}

// Só memória deste index. Hold de Encerrar NÃO entra aqui:
// Iniciar precisa nascer 4/4 fechadas mesmo com hold (hold só barra porteiro/agenda).
function isCellsStopped() {
  return cellsStopped === true;
}

function consumeBootRecycle() {
  const v = !!bootRecycled;
  bootRecycled = false;
  return v;
}

function stopAllCells({ reason = 'manual' } = {}) {
  const why = String(reason || 'manual');
  const mustDie = /api_cells_stop|stop_workers|code_stamp|boot_hold|topology|iniciar_stamp/.test(why);
  const bootFast = !mustDie && /boot_|index_ctrl_c|maestro_kill/.test(why);
  if (mustDie || /boot_|code_stamp|topology/.test(why)) bootRecycled = true;
  const listen1 = mustDie ? 1500 : (bootFast ? 800 : 2000);
  const listen2 = mustDie ? 800 : (bootFast ? 400 : 800);
  const t0 = Date.now();
  const alive = cellRegistry.listAlive();
  const pids = [];
  const seen = new Set();
  function addPid(pid, force) {
    const n = Math.floor(Number(pid) || 0);
    if (!(n > 0) || n === process.pid || n <= 4 || seen.has(n)) return;
    if (!force && isSkippableListenPid(n)) return;
    seen.add(n);
    pids.push(n);
  }
  for (const c of alive) addPid(c && c.pid, true);
  for (const pid of listCellEntryPids()) addPid(pid, true);
  for (const row of realCellListenRows()) addPid(row && row.pid);
  const owners = listListenOwners(32);
  try {
    cellForensic.append('cell_stop_all', {
      reason: why.slice(0, 80),
      count: pids.length,
      pids,
      listen1,
      owners
    });
  } catch {}
  taskkillPids(pids, { tree: true, timeoutMs: 8000 });
  terminateCellEntriesByCmd();
  let chrome = { killed: 0, matched: 0 };
  try {
    chrome = require('./orphanReaper.js').reapAllConvenienteChrome(why || 'stop_all_cells');
  } catch {}
  let freed = killListenUntilFree(listen1);
  if (!freed.ok) {
    terminateCellEntriesByCmd();
    taskkillPids(listLiveCellPids(), { tree: true, timeoutMs: 5000 });
    try {
      const again = require('./orphanReaper.js').reapAllConvenienteChrome(why || 'stop_all_cells_retry');
      if (again && again.killed != null) chrome.killed = (chrome.killed || 0) + again.killed;
    } catch {}
    freed = killListenUntilFree(listen2);
  }
  const stillListen = Array.isArray(freed.left) ? freed.left : realCellListenRows();
  const entryLeft = listLiveCellPids();
  const ok = entryLeft.length === 0;
  const ownersAfter = listListenOwners(32).filter((o) => o && pidExistsOnSystem(o.pid));
  try { neutralizeWorkerStatusJournals(why); } catch {}
  const reg = cellRegistry.read();
  reg.cells = [];
  cellRegistry.write(reg);
  const want = wantedCellCount();
  return {
    ok,
    error: ok
      ? null
      : (entryLeft.length
        ? ('celula_ainda_viva:' + entryLeft.join(','))
        : (stillListen.length
          ? ('celula_ainda_na_porta:' + stillListen.map((r) => r.port).join(','))
          : 'nao_encerrou')),
    reason: String(reason || ''),
    requested: pids.length,
    forced: pids.length,
    alive: entryLeft.length,
    want,
    listenLeft: stillListen.length,
    chromeKilled: chrome && chrome.killed != null ? chrome.killed : 0,
    pids,
    owners: ownersAfter.length ? ownersAfter : owners,
    ms: Date.now() - t0
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
  taskkillPids,
  killListenUntilFree,
  stopAllCells,
  consumeBootRecycle,
  setCellsStopped,
  isCellsStopped,
  listCellEntryPids,
  listLiveCellPids,
  wantedCellCount,
  reapForeignCellEntries,
  listListenOwners,
  isProvenCellEntryPid,
  isLikelyCellListenPid,
  isSkippableListenPid,
  neutralizeWorkerStatusJournals,
  countDesiredActive,
  browsersWorking
};
