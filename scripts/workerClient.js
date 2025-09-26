// scripts/workerClient.js
const { fork } = require('child_process');
const path = require('path');

// === MILITARY WATCHDOG (restart worker if nonresponsive) ===
let _wd = { timer: null, failCount: 0, lastOkAt: 0 };
function startWatchdog() {
  if (_wd.timer) return;
  _wd.timer = setInterval(async () => {
    try {
      if (!workerChild) return; // sem child no momento (respawn já cuida)
      const r = await sendWorkerCommand('get-status', {}, { timeoutMs: 7000 }).catch(() => null);
      if (r && r.perfis) {
        _wd.failCount = 0;
        _wd.lastOkAt = Date.now();
        return;
      }
    } catch {}
    _wd.failCount++;
    if (_wd.failCount >= 8 && (Date.now() - _wd.lastOkAt) > 30000) {
      try { console.warn('[WATCHDOG] worker nonresponsive — restarting'); } catch {}
      try { workerChild && workerChild.kill && workerChild.kill('SIGKILL'); } catch {}
      _wd.failCount = 0;
      _wd.lastOkAt = 0;
    }
  }, 5000);
}
// === END WATCHDOG ===

let workerChild = null;
let isQuitting = false;

// ---- Função para spawnar o worker ----
function forkWorker() {
  if (workerChild) return;
  const workerPath = path.join(__dirname, 'worker.js');
  const nodeExecPath = process.env.npm_node_execpath || process.env.NODE || 'node';
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const forkOpts = { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], execPath: nodeExecPath, env };
  console.log(`[WORKER][FORK] execPath="${nodeExecPath}"`);
  workerChild = fork(workerPath, [], forkOpts);

  workerChild.on('error', (err) => {
    console.error('[WORKER] erro no fork:', err && err.message || err);
  });

  workerChild.on('exit', (code, signal) => {
    console.warn(`[WORKER] morto, respawn em 2s (code=${code}, signal=${signal}), PID=${workerChild && workerChild.pid}`);
    workerChild = null;
    if (isQuitting) return;
    setTimeout(forkWorker, 2000);
  });

  startWatchdog();
}

// ---- Comunica com o worker via msgId e reply ----
function sendWorkerCommand(type, payload = {}, opts = {}) {
  const timeoutMs = Number((opts && opts.timeoutMs) || 15000);

  return new Promise((resolve) => {
    if (!workerChild) {
      forkWorker();
      setTimeout(() => resolve({ ok: false, error: 'worker off (tente de novo em 2s)' }), 500);
      return;
    }

    const msgId = Math.random().toString(36).slice(2);
    const childAtSend = workerChild;
    let done = false;

    const handler = (msg) => {
      try {
        if (done) return;
        if (msg && msg.replyTo === msgId) {
          done = true;
          try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
          clearTimeout(timerId);
          resolve(msg.data);
        }
      } catch (err) {
        if (done) return;
        done = true;
        try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
        clearTimeout(timerId);
        resolve({ ok: false, error: 'Erro ao processar resposta do worker.' });
      }
    };

    try { childAtSend && childAtSend.on && childAtSend.on('message', handler); } catch {}

    try {
      childAtSend && childAtSend.send && childAtSend.send({ type, payload, msgId });
    } catch (err) {
      if (done) return;
      done = true;
      try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
      resolve({ ok: false, error: 'worker morreu ou está indisponível ao enviar a mensagem.' });
      return;
    }

    const timerId = setTimeout(() => {
      if (done) return;
      done = true;
      try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
      console.warn(`[WORKER][TIMEOUT] Timeout aguardando resposta do worker para msgId=${msgId} (PID=${childAtSend && childAtSend.pid})`);
      resolve({ ok: false, error: 'Timeout aguardando resposta do worker.' });
    }, timeoutMs);
  });
}

// ---- Encerrar o worker manualmente ----
function killWorker() {
  isQuitting = true;
  if (workerChild) workerChild.kill('SIGTERM');
  workerChild = null;
}

module.exports = {
  fork: forkWorker,
  sendWorkerCommand,
  kill: killWorker
};