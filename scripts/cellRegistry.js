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
  } catch {
    return false;
  }
}

function portForIdx(idx) {
  return BASE_PORT + Math.max(0, Math.floor(Number(idx) || 0));
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
  portForIdx,
  listAlive,
  hasAliveCells,
  upsertCell,
  setMaestroPid,
  clearDead
};
