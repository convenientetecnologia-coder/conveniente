'use strict';

const fs = require('fs');
const path = require('path');

const REG_DIR = path.join(__dirname, '..', 'dados', 'cells');
const REG_PATH = path.join(REG_DIR, 'registry.json');
const BASE_PORT = Math.max(
  18701,
  Math.min(19000, parseInt(process.env.CELL_CMD_BASE_PORT || '18701', 10) || 18701)
);

function empty() {
  return {
    version: 1,
    updatedAt: Date.now(),
    maestroPid: null,
    basePort: BASE_PORT,
    codeStamp: '',
    topology: null,
    cells: []
  };
}

function ensureDir() {
  try { fs.mkdirSync(REG_DIR, { recursive: true }); } catch {}
}

function read() {
  try {
    const raw = fs.readFileSync(REG_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return empty();
    if (!Array.isArray(j.cells)) j.cells = [];
    return j;
  } catch {
    return empty();
  }
}

function write(reg) {
  ensureDir();
  const out = Object.assign(empty(), reg || {});
  if (!Array.isArray(out.cells)) out.cells = [];
  out.codeStamp = String(out.codeStamp || '');
  out.updatedAt = Date.now();
  out.basePort = BASE_PORT;
  const tmp = REG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  fs.renameSync(tmp, REG_PATH);
  return out;
}

function pidAlive(pid) {
  const n = Math.floor(Number(pid) || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    // Windows: processo existe mas o signal 0 vem EPERM/EACCES. Tratar como morto
    // faz o watchdog reap Chrome e readotar a mesma célula a cada 2.5s.
    const code = e && e.code ? String(e.code) : '';
    if (code === 'EPERM' || code === 'EACCES') return true;
    return false;
  }
}

// Um netstat para todas as portas. Chamadas em loop (watch / spawn / Encerrar)
// que faziam 4–8 netstat.exe viravam tempestade de 10–40s.
const LISTEN_CACHE_MS = 250;
let listenCacheAt = 0;
let listenByPort = new Map();

function invalidateListenCache() {
  listenCacheAt = 0;
  listenByPort = new Map();
}

function parseListenMap(force) {
  const now = Date.now();
  if (!force && listenCacheAt && (now - listenCacheAt) < LISTEN_CACHE_MS) {
    return listenByPort;
  }
  const map = new Map();
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    });
    const text = String((r && r.stdout) || '');
    for (const line of text.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const state = String(parts[3] || '');
      if (!/^(LISTENING|OUVINDO|ESCUTA)$/i.test(state)) continue;
      const local = String(parts[1] || '');
      const colon = local.lastIndexOf(':');
      if (colon < 0) continue;
      const localPort = Math.floor(Number(String(local.slice(colon + 1)).replace(/\]/g, '')) || 0);
      if (!(localPort > 0)) continue;
      const pid = Math.floor(Number(parts[parts.length - 1]) || 0);
      if (pid > 0) map.set(localPort, pid);
    }
  } catch {}
  listenCacheAt = Date.now();
  listenByPort = map;
  return map;
}

// Dono do LISTEN em 127.0.0.1:port. TCP connect sozinho mente: outra célula
// na mesma porta também aceita o socket.
function tcpListenPid(port, opts) {
  const p = Math.floor(Number(port) || 0);
  if (!(p > 0)) return 0;
  return parseListenMap(!!(opts && opts.force)).get(p) || 0;
}

function collectListenPids(maxSlots, opts) {
  const n = Math.max(1, Math.min(32, Math.floor(Number(maxSlots) || 8)));
  const map = parseListenMap(!!(opts && opts.force));
  const out = [];
  for (let i = 0; i < n; i++) {
    const port = portForIdx(i);
    const pid = map.get(port) || 0;
    if (pid > 0) out.push({ idx: i, port, pid });
  }
  return out;
}

function portForIdx(idx) {
  return BASE_PORT + Math.max(0, Math.floor(Number(idx) || 0));
}

function findFreePort({ exclude, maxSlots } = {}) {
  const skip = new Set();
  for (const p of (Array.isArray(exclude) ? exclude : [])) {
    const n = Math.floor(Number(p) || 0);
    if (n > 0) skip.add(n);
  }
  const n = Math.max(8, Math.min(32, Math.floor(Number(maxSlots) || 16)));
  const map = parseListenMap(true);
  for (let i = 0; i < n; i++) {
    const port = portForIdx(i);
    if (skip.has(port)) continue;
    if (!(map.get(port) > 0)) return port;
  }
  return 0;
}

function listAlive() {
  const reg = read();
  return (reg.cells || []).filter((c) => c && pidAlive(c.pid));
}

function hasAliveCells() {
  return listAlive().length > 0;
}

function upsertCell(patch) {
  const reg = read();
  const idx = Math.max(0, Math.floor(Number(patch && patch.idx) || 0));
  const row = {
    id: idx + 1,
    idx,
    pid: Number(patch && patch.pid) || null,
    port: Number(patch && patch.port) || portForIdx(idx),
    shard: Array.isArray(patch && patch.shard) ? patch.shard.slice() : [],
    statusFile: String((patch && patch.statusFile) || ('status_node_' + (idx + 1) + '.json')),
    updatedAt: Date.now()
  };
  const i = reg.cells.findIndex((c) => Number(c && c.idx) === idx);
  if (i >= 0) reg.cells[i] = Object.assign({}, reg.cells[i], row);
  else reg.cells.push(row);
  reg.cells.sort((a, b) => Number(a.idx) - Number(b.idx));
  write(reg);
  return row;
}

function setMaestroPid(pid) {
  const reg = read();
  reg.maestroPid = Number(pid) || null;
  write(reg);
}

function clearDead() {
  const reg = read();
  reg.cells = (reg.cells || []).filter((c) => pidAlive(c && c.pid));
  write(reg);
  return reg;
}

module.exports = {
  REG_PATH,
  BASE_PORT,
  read,
  write,
  pidAlive,
  invalidateListenCache,
  tcpListenPid,
  collectListenPids,
  portForIdx,
  findFreePort,
  listAlive,
  hasAliveCells,
  upsertCell,
  setMaestroPid,
  clearDead
};
