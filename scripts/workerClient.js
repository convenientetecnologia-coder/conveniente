// scripts/workerClient.js
const { fork } = require('child_process');
const path = require('path');

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
}

// ---- Comunica com o worker via msgId e reply ----
function sendWorkerCommand(type, payload = {}) {
  return new Promise((resolve) => {
    if (!workerChild) {
      // Garantia extra: tenta startar o worker on demand
      forkWorker();
      setTimeout(() => resolve({ ok: false, error: 'worker off (tente de novo em 2s)' }), 500);
      return;
    }
    const msgId = Math.random().toString(36).slice(2);
    const childAtSend = workerChild; // Captura referência local do worker no momento do envio

    // Handler da resposta do worker
    const handler = (msg) => {
      try {
        if (msg && msg.replyTo && msg.replyTo === msgId) {
          // GUARD: protege admin de crashar por worker morto
          // Remover listener apenas do objeto child capturado, não do global
          try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
          resolve(msg.data);
        }
      } catch (err) {
        // Nunca crashar admin/master por erro de worker morto
        console.error('[WORKER][SEND][handler] erro ao processar resposta:', err);
        try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
        resolve({ ok: false, error: 'Erro ao processar resposta do worker.' });
      }
    };

    // Sempre validar o objeto antes de usar .on, .send, etc.
    try { childAtSend && childAtSend.on && childAtSend.on('message', handler); } catch {}

    try {
      childAtSend && childAtSend.send && childAtSend.send({ type, payload, msgId });
    } catch (err) {
      // Nunca crashar admin/master por worker morto/desconectado
      console.error('[WORKER][SEND] erro ao enviar msg para o worker:', err);
      try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
      resolve({ ok: false, error: 'worker morreu ou está indisponível ao enviar a mensagem.' });
      return;
    }

    // Guard timeout contra leak de listeners + "off em null"
    setTimeout(() => {
      // GUARD: protege admin de crashar por worker morto
      // Remover listener apenas do objeto child capturado, não do global
      try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
      // Logging especial
      console.warn(`[WORKER][TIMEOUT] Timeout aguardando resposta do worker para msgId=${msgId} (PID=${childAtSend && childAtSend.pid})`);
      resolve({ ok: false, error: 'Timeout aguardando resposta do worker.' });
    }, 15000);
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