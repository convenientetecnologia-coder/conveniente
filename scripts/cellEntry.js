'use strict';

// Entrada da célula: abre a porta de comando ANTES de carregar o worker.js.
// O maestro reconecta aqui se o index cair. Chrome e contas seguem neste processo.

process.env.CONVENIENTE_CELL = '1';
process.env.IS_WORKER_CHILD = '1';

const net = require('net');
const bus = require('./cellCommandBus.js');
const registry = require('./cellRegistry.js');
const forensic = require('./cellForensic.js');

const idx = Math.max(0, parseInt(process.env.WORKER_SHARD_INDEX || '0', 10) || 0);
const port = Math.max(
  1,
  parseInt(process.env.CELL_CMD_PORT || String(registry.portForIdx(idx)), 10) || registry.portForIdx(idx)
);
process.env.CELL_CMD_PORT = String(port);

const server = net.createServer((socket) => {
  try { socket.setNoDelay(true); } catch {}
  bus.attachMaestroSocket(socket);
  setImmediate(() => {
    try { bus.sendToMaestro({ type: 'cell_hello', pid: process.pid, idx, port }); } catch {}
  });
  try {
    forensic.append('cell_maestro_connected', {
      idx: idx + 1,
      port,
      pid: process.pid,
      remote: socket.remoteAddress || null
    });
  } catch {}
});

server.on('error', (err) => {
  try {
    forensic.append('cell_listen_fail', {
      idx: idx + 1,
      port,
      error: err && err.message ? String(err.message).slice(0, 180) : String(err)
    });
  } catch {}
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  try {
    registry.upsertCell({
      idx,
      pid: process.pid,
      port,
      shard: (() => {
        try { return JSON.parse(process.env.SHARD_PROFILES || '[]'); } catch { return []; }
      })(),
      statusFile: process.env.STATUS_FILE_NAME || ('status_node_' + (idx + 1) + '.json')
    });
  } catch {}
  try {
    forensic.append('cell_listen', { idx: idx + 1, port, pid: process.pid });
  } catch {}
  require('./worker.js');
});
