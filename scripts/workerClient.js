// scripts/workerClient.js
const { fork } = require('child_process');
const path = require('path');
const logger = require('./logger.js');

// ========== FLOOD/REENTRADA/FILA PROTECTION ADDED ==========
// Proteção: Evita flood de comandos “open”/“activate”/“startWork”. Garantido que só 1 em andamento por perfil ou globalmente.
const inflightOp = new Map(); // Key: type+name ou type (se global)
const pLimitImport = require('p-limit');
const pLimit = pLimitImport.default || pLimitImport;
const limitCount = 6; // 6 comandos simultâneos permitidos globais (ajuste conforme desejado)
const globalCommandPool = pLimit(limitCount);
// DEBUG
function debugLogCommand(type, payload, poolStatus, extra = '') {
  if (
    type === 'open' ||
    type === 'activate' ||
    type === 'startWork'
  ) {
    let perfilNome = payload && (payload.nome || payload.name || payload.perfil || payload.profile || '');
    let now = (new Date()).toISOString();
    try {
      logger.debug(`[WORKER][CMD-DEBUG] [${now}] type=${type}, perfil="${perfilNome}", pool=${poolStatus} ${extra}`);
    } catch {}
  }
}
// ============================================================

// === MILITARY WATCHDOG (restart worker if nonresponsive) ===
let _wd = { timer: null, failCount: 0, lastOkAt: 0 };
function startWatchdog() {
  if (_wd.timer) return;
  _wd.timer = setInterval(async () => {
    try {
      if (!workerChild) return; // sem child no momento (respawn já cuida)

      // FLOOD PROTECTION: Só 1 get-status simultâneo
      const key = 'get-status';
      if (inflightOp.has(key)) { 
        debugLogCommand('get-status', {}, inflightOp.size, '[WD] BLOQUEADO: já pendente.'); 
        return; 
      }

      const r = await module.exports.sendWorkerCommand('get-status', {}, { timeoutMs: 12000 }).catch(() => null);
      if (r && r.perfis) {
        _wd.failCount = 0;
        _wd.lastOkAt = Date.now();
        return;
      }
    } catch {}
    _wd.failCount++;
    if (_wd.failCount >= 8 && (Date.now() - _wd.lastOkAt) > 30000) {
      try { logger.warn('[WATCHDOG] worker nonresponsive — restarting'); } catch {}
      try { workerChild && workerChild.kill && workerChild.kill('SIGKILL'); } catch {}
      _wd.failCount = 0;
      _wd.lastOkAt = 0;
    }
  }, 7000); // Troque 5000 por 7000 ms aqui!
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
  logger.info(`[WORKER][FORK] execPath="${nodeExecPath}"`);
  workerChild = fork(workerPath, [], forkOpts);

  workerChild.on('error', (err) => {
    logger.error('[WORKER] erro no fork', { error: err && err.message || err }, err);
  });

  workerChild.on('exit', (code, signal) => {
    logger.warn(`[WORKER] morto, respawn em 2s (code=${code}, signal=${signal}), PID=${workerChild && workerChild.pid}`);
    workerChild = null;
    if (isQuitting) return;
    setTimeout(forkWorker, 2000);
  });

  startWatchdog();
}

// ---- Comunica com o worker via msgId e reply ----
// Proteção: Evita flood e múltiplos comandos “open”/“activate”/“startWork” simultâneos do mesmo tipo/nome (por perfil)
function sendWorkerCommand(type, payload = {}, opts = {}) {
  // 1. Gera chave de serialização/lock FORTALECIDA/UNIFORMIZADA por tipo + perfil (conforme instrução)
  let opKey = null;
  let perfilNome = payload && (payload.nome || payload.name || payload.perfil || payload.profile || '');
  if (perfilNome) perfilNome = String(perfilNome);

  if (
    ['open','activate','startWork'].includes(type)
  ) {
    // *** TODOS os comandos que envolvem ativação do mesmo perfil compartilham lock ***
    opKey = `@@PROFILE_OP_LOCK@@::${perfilNome}`;
  } else if (type === 'get-status') {
    opKey = 'get-status';
  } else {
    opKey = `${type}`;
  }

  // 2. Lock por opKey — se já existe, retorna a mesma promise (não reenvia)
  if (inflightOp.has(opKey)) {
    debugLogCommand(type, payload, inflightOp.size, '[LOCKED flood]');
    return inflightOp.get(opKey);
  }

  // Fila e limitação máxima global
  let holderPromise; // essa promise será retornada

  // ==== PATCH: timeout enquanto espera na fila global ====
  // se for get-status, timeout baixo, demais, timeout já definido
  const queueWaitMs = (type === 'get-status') ? 3000 : (opts.timeoutMs || 15000);
  function withQueueTimeout(p, ms) {
    let id;
    const to = new Promise(r => { id = setTimeout(() => r({ ok:false, error:'queue_timeout' }), ms); });
    return Promise.race([ p.finally(() => clearTimeout(id)), to ]);
  }

  holderPromise = globalCommandPool(async () => {
    debugLogCommand(type, payload, globalCommandPool.activeCount, '[START]');
    const timeoutMs = Number((opts && opts.timeoutMs) || 15000);
    return await new Promise((resolve) => {
      if (!workerChild) {
        forkWorker();
        setTimeout(() => {
          debugLogCommand(type, payload, globalCommandPool.activeCount, '[NO-WORKER]');
          resolve({ ok: false, error: 'worker off (tente de novo em 2s)' });
        }, 500);
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
            // Remover o lock/fila/controle agora!
            inflightOp.delete(opKey);

            // Supervisor 429 — retry público
            if (
              msg &&
              msg.data &&
              msg.data.supervisorDenied === true &&
              (msg.data.code === 429 || msg.data.status === 429)
            ) {
              debugLogCommand(type, payload, globalCommandPool.activeCount, '[DENIED 429 RETRY]');
              // Delay requeue, rejogar na fila
              setTimeout(() => { sendWorkerCommand(type, payload, opts); }, 1500);
              return resolve({ ok: false, error: 'supervisorClient 429 REQUEUED' });
            }

            resolve(msg.data);
          }
        } catch (err) {
          if (done) return;
          done = true;
          try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
          clearTimeout(timerId);
          inflightOp.delete(opKey);
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
        inflightOp.delete(opKey);
        resolve({ ok: false, error: 'worker morreu ou está indisponível ao enviar a mensagem.' });
        return;
      }

      const timerId = setTimeout(() => {
        if (done) return;
        done = true;
        try { childAtSend && childAtSend.off && childAtSend.off('message', handler); } catch {}
        inflightOp.delete(opKey);
        logger.warn(`[WORKER][TIMEOUT] Timeout aguardando resposta do worker`, { msgId, pid: childAtSend && childAtSend.pid });
        resolve({ ok: false, error: 'Timeout aguardando resposta do worker.' });
      }, timeoutMs);
    });
  });

  // PATCH aplicado: aplicando timeout na espera de slot da fila global
  const raced = withQueueTimeout(holderPromise, queueWaitMs);
  inflightOp.set(opKey, raced);

  // DEBUG LOG comando enviado
  debugLogCommand(type, payload, globalCommandPool.activeCount, '[ENQUED]');
  raced.finally(() => { if (inflightOp.has(opKey)) inflightOp.delete(opKey); });
  return raced;
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