'use strict';

const bus = require('./cellCommandBus.js');

function isChild() {
  return String(process.env.IS_WORKER_CHILD || '') === '1';
}

function newMsgId() {
  return Math.random().toString(36).slice(2);
}

function send(msg) {
  if (bus.isCellMode()) return bus.sendToMaestro(msg);
  if (typeof process.send === 'function') {
    try {
      process.send(msg);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function request(msg, timeoutMs) {
  const payload = Object.assign({}, msg || {});
  const msgId = payload.msgId || newMsgId();
  payload.msgId = msgId;
  const waitMs = Math.max(2000, Number(timeoutMs || 0) || 12000);
  return new Promise((resolve) => {
    let done = false;
    const finish = (data) => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), waitMs);
    if (bus.isCellMode()) {
      bus.onceReply(msgId, (data) => {
        try { clearTimeout(t); } catch {}
        finish(data);
      });
      if (!send(payload)) {
        try { clearTimeout(t); } catch {}
        finish({ ok: false, error: 'ipc_send_failed' });
      }
      return;
    }
    const onMsg = (m) => {
      if (m && m.replyTo === msgId) {
        try { process.off('message', onMsg); } catch {}
        try { clearTimeout(t); } catch {}
        finish(m.data);
      }
    };
    try { process.on('message', onMsg); } catch {}
    if (!send(payload)) {
      try { process.off('message', onMsg); } catch {}
      try { clearTimeout(t); } catch {}
      finish({ ok: false, error: 'ipc_send_failed' });
    }
  });
}

module.exports = { isChild, newMsgId, send, request };
