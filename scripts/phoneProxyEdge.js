'use strict';

const net = require('net');
const WebSocket = require('ws');
const mode = require('./phoneProxyMode');

// Escuta 127.0.0.1 nas portas do celular e leva os bytes ao painel.
// Não sobe se o modo estiver desligado. Não abre porta para a rede.

let ws = null;
let helloOk = false;
let stopping = false;
let reconnectTimer = null;
let streamSeq = 1;
const locals = new Map();
const servers = [];
const readyPorts = new Set();
let expectedPorts = 0;

function isUp() {
  return helloOk === true && ws && ws.readyState === 1 && expectedPorts > 0
    && readyPorts.size === expectedPorts;
}

function publish(up) {
  try { mode.writeEdgeState(up === true, Array.from(readyPorts)); } catch {}
}

function send(type, id, body) {
  if (!ws || ws.readyState !== 1) return;
  const src = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  const buf = Buffer.allocUnsafe(5 + src.length);
  buf.writeUInt8(type & 0xff, 0);
  buf.writeUInt32BE(id >>> 0, 1);
  src.copy(buf, 5);
  try { ws.send(buf); } catch {}
}

function unpack(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (buf.length < 5) return null;
  return { type: buf.readUInt8(0), id: buf.readUInt32BE(1), body: buf.subarray(5) };
}

function closeLocal(id) {
  const sock = locals.get(id);
  if (!sock) return;
  locals.delete(id);
  try { sock.destroy(); } catch {}
}

function closeAllLocals() {
  for (const id of Array.from(locals.keys())) closeLocal(id);
}

function onFrame(frame) {
  if (!frame) return;
  if (frame.type === 1 && frame.id === 0) {
    let hello = null;
    try { hello = JSON.parse(frame.body.toString('utf8')); } catch {}
    const was = helloOk;
    helloOk = !!(hello && hello.ok === true && hello.role === 'edge');
    if (helloOk && !was) {
      publish(true);
      try { mode.note('phone_proxy_edge', { up: true, ports: Array.from(readyPorts) }); } catch {}
    }
    return;
  }
  if (frame.type === 6) return;
  const sock = locals.get(frame.id);
  if (frame.type === 3 && sock) {
    try { sock.write(frame.body); } catch {}
    return;
  }
  if (frame.type === 4) closeLocal(frame.id);
}

function attachSocket(sock, port) {
  if (!isUp()) {
    try { sock.destroy(); } catch {}
    return;
  }
  const id = (streamSeq = (streamSeq + 1) >>> 0) || 1;
  locals.set(id, sock);
  send(2, id, JSON.stringify({ port }));
  sock.on('data', (buf) => send(3, id, buf));
  sock.on('close', () => {
    if (locals.get(id) === sock) locals.delete(id);
    send(4, id, '');
  });
  sock.on('error', () => { try { sock.destroy(); } catch {} });
}

function listenPort(port) {
  const server = net.createServer((sock) => attachSocket(sock, port));
  server.on('error', () => {
    readyPorts.delete(port);
    helloOk = false;
    publish(false);
    try { mode.note('phone_proxy_edge', { up: false, error: 'bind_fail', port }); } catch {}
  });
  server.listen(port, '127.0.0.1', () => { readyPorts.add(port); });
  servers.push(server);
}

function scheduleReconnect(cfg) {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(cfg);
  }, 3000);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

function connect(cfg) {
  if (stopping) return;
  helloOk = false;
  let socket;
  try {
    socket = new WebSocket(cfg.wsUrl, { headers: { 'x-phone-proxy-secret': cfg.secret } });
  } catch {
    scheduleReconnect(cfg);
    return;
  }
  ws = socket;
  socket.on('open', () => {
    send(1, 0, JSON.stringify({ role: 'edge', hostId: 'mae' }));
  });
  socket.on('message', (data) => onFrame(unpack(data)));
  socket.on('close', () => {
    const was = helloOk;
    helloOk = false;
    if (was) {
      publish(false);
      try { mode.note('phone_proxy_edge', { up: false }); } catch {}
    }
    closeAllLocals();
    if (ws === socket) ws = null;
    scheduleReconnect(cfg);
  });
  socket.on('error', () => {});
}

function startWith(cfg) {
  if (!cfg || !cfg.wsUrl || !cfg.secret || !Array.isArray(cfg.phones) || !cfg.phones.length) {
    return { ok: false, reason: 'bad_config' };
  }
  if (servers.length) return { ok: true, already: true };
  stopping = false;
  expectedPorts = cfg.phones.length;
  publish(false);
  for (const phone of cfg.phones) listenPort(phone.port);
  connect(cfg);
  const ping = setInterval(() => {
    if (ws && ws.readyState === 1) send(5, 0, '');
    if (isUp()) publish(true);
  }, 20000);
  if (ping.unref) ping.unref();
  return { ok: true };
}

function start() {
  const cfg = mode.readConfig();
  if (!cfg) return { ok: false, reason: 'disabled' };
  return startWith(cfg);
}

module.exports = { start, startWith, isUp };
