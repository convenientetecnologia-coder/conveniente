'use strict';

function writeJsonLine(socket, obj) {
  if (!socket || socket.destroyed) return false;
  try {
    socket.write(JSON.stringify(obj) + '\n');
    return true;
  } catch {
    return false;
  }
}

function attachLineParser(socket, onMsg) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += String(chunk || '');
    if (buf.length > 8 * 1024 * 1024) buf = buf.slice(-1024 * 1024);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg && typeof msg === 'object') onMsg(msg);
      } catch {}
    }
  });
}

function waitPortOpen(port, { timeoutMs = 60000, intervalMs = 120 } = {}) {
  const net = require('net');
  const started = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
      const fail = () => {
        try { sock.destroy(); } catch {}
        if ((Date.now() - started) >= timeoutMs) return resolve(false);
        setTimeout(tryOnce, intervalMs);
      };
      sock.once('connect', () => {
        try { sock.end(); } catch {}
        resolve(true);
      });
      sock.once('error', fail);
      sock.setTimeout(800, fail);
    };
    tryOnce();
  });
}

function waitPortFree(port, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const net = require('net');
  const started = Date.now();
  const n = Number(port) || 0;
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const tryOnce = () => {
      const srv = net.createServer();
      srv.once('error', (err) => {
        try { srv.close(); } catch {}
        const busy = err && String(err.code || '') === 'EADDRINUSE';
        if (!busy) return resolve(true);
        if ((Date.now() - started) >= timeoutMs) return resolve(false);
        setTimeout(tryOnce, intervalMs);
      });
      srv.listen({ port: n, host: '127.0.0.1', exclusive: true }, () => {
        srv.close(() => resolve(true));
      });
    };
    tryOnce();
  });
}

module.exports = { writeJsonLine, attachLineParser, waitPortOpen, waitPortFree };
