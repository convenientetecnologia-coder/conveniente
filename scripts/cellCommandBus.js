'use strict';

const { writeJsonLine, attachLineParser } = require('./cellNet.js');

const isCellMode = String(process.env.CONVENIENTE_CELL || '').trim() === '1';

let maestroSocket = null;
let commandHandler = null;
const inboundQueue = [];
const replyWait = new Map();
const MAX_QUEUE = 48;

function attachMaestroSocket(socket) {
  try { if (maestroSocket && maestroSocket !== socket) maestroSocket.destroy(); } catch {}
  maestroSocket = socket;
  attachLineParser(socket, (msg) => {
    if (msg && msg.replyTo) {
      const fn = replyWait.get(msg.replyTo);
      if (fn) {
        replyWait.delete(msg.replyTo);
        try { fn(msg.data); } catch {}
      }
      return;
    }
    if (typeof commandHandler === 'function') {
      Promise.resolve()
        .then(() => commandHandler(msg))
        .catch(() => {});
      return;
    }
    if (inboundQueue.length >= MAX_QUEUE) inboundQueue.shift();
    inboundQueue.push(msg);
  });
  socket.on('close', () => {
    if (maestroSocket === socket) maestroSocket = null;
  });
  socket.on('error', () => {});
}

function setCommandHandler(fn) {
  commandHandler = typeof fn === 'function' ? fn : null;
  if (!commandHandler) return;
  const queued = inboundQueue.splice(0, inboundQueue.length);
  for (const msg of queued) {
    Promise.resolve()
      .then(() => commandHandler(msg))
      .catch(() => {});
  }
}

function sendToMaestro(obj) {
  return writeJsonLine(maestroSocket, obj);
}

function reply(msgId, data) {
  return sendToMaestro({ replyTo: msgId, data });
}

function onceReply(msgId, fn) {
  replyWait.set(msgId, fn);
}

function hasMaestro() {
  return !!(maestroSocket && !maestroSocket.destroyed);
}

module.exports = {
  isCellMode: () => isCellMode,
  attachMaestroSocket,
  setCommandHandler,
  sendToMaestro,
  reply,
  onceReply,
  hasMaestro
};
