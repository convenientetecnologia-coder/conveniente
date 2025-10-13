// scripts/worker.js

'use strict';

const log = require('./logger.js');
const handlers = require('./workerHandlers.js');
const core = require('./workerCore.js');

// Blindagem de exceções globais (conforme instrução)
process.on('unhandledRejection', (reason) => {
  try {
    log.error('[WORKER][unhandledRejection]', (reason && reason.stack) || reason);
  } catch {}
});

process.on('uncaughtException', (err) => {
  try {
    log.error('[WORKER][uncaughtException]', (err && err.stack) || err);
  } catch {}
});

function sendReply(msgId, data) {
  if (process && process.send) process.send({ replyTo: msgId, data });
}

async function boot() {
  log.info('[WORKER] booting orchestrator...');
  await core.initTimers();
  log.info('[WORKER] timers started.');
}

process.on('message', async (msg) => {
  if (!msg || !msg.type || !msg.msgId) return;
  const fn = handlers[msg.type];
  if (typeof fn !== 'function') {
    sendReply(msg.msgId, { ok: false, error: 'Comando desconhecido' });
    return;
  }
  try {
    const resp = await fn(msg.payload || {});
    sendReply(msg.msgId, resp);
  } catch (e) {
    sendReply(msg.msgId, { ok: false, error: e && e.message || String(e) });
  }
});

// Graceful shutdown (nunca deve deixar browser/vms abertos)
let _shuttingDown = false;
async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    log.warn('[WORKER] gracefulShutdown start:', reason);
    // Core já fecha browsers/virtus em suas rotinas de deactivate; aqui podemos apenas sair.
  } catch (e) {
    log.warn('[WORKER] gracefulShutdown exception', e && e.message || e);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('disconnect', () => gracefulShutdown('disconnect'));

boot().catch(err => {
  log.error('[WORKER] boot error:', err && err.message || err);
  process.exit(1);
});