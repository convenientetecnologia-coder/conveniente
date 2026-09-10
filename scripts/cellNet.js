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
  // Nao faz bind nem connect. Bind deixa TIME_WAIT e o cellEntry perde o listen.
  // Connect o ocupante trata como maestro e derruba o socket real.
  void port;
  void timeoutMs;
  void intervalMs;
  return Promise.resolve(true);
}

module.exports = { writeJsonLine, attachLineParser, waitPortOpen, waitPortFree };
