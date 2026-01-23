// scripts/supervisorClient.js
/*
 * CLIENTE PARA O SUPERVISOR UNIVERSAL IN-PROCESS (UNIFICADO)
 * Todas as chamadas são diretas ao módulo supervisor.js ou roteadas via IPC.
 * Tolerante a erro, nunca lança uncaught.
 */

const logger = require('./logger.js'); // <- Adicionado conforme instrução

// Worker child — usa IPC com master
const isChild = (process && process.env && process.env.IS_WORKER_CHILD === '1');

// Patch kill_guard_until: bloqueio proativo
const fs = require('fs');
const path = require('path');
const statusJsonPath = path.join(__dirname, '..', 'dados', 'status.json');

// Função para checar kill_guard_until antes de pedir slot ao supervisor
function localKillGuardActive(perfil) {
    try {
        if (!fs.existsSync(statusJsonPath)) return false;
        const st = JSON.parse(fs.readFileSync(statusJsonPath, 'utf8'));
        if (st && Array.isArray(st.perfis)) {
            const ent = st.perfis.find(x => x && x.nome === perfil);
            if (ent && typeof ent.killGuardUntil === 'number' && ent.killGuardUntil > Date.now()) {
                return true;
            }
        }
    } catch {}
    return false;
}
// --- FIM PATCH local function

function newMsgId(){ return Math.random().toString(36).slice(2); }

async function requestOpen(perfil, url, opts = {}) {
  if (localKillGuardActive(perfil)) {
    return { ok: false, error: 'kill_guard_until', msg: 'Abertura de slot negada por kill_guard_until' };
  }
  if (!isChild) {
    try {
      const supervisor = require('./supervisor.js');
      return supervisor.requestOpen(perfil, opts);
    } catch (e) {
      logger.warn('[supervisorClient] requestOpen erro:', { error: e && e.message || e });
      return { ok: false, error: e && e.message || e };
    }
  }
  // child: IPC
  return new Promise((resolve) => {
    const msgId = newMsgId();
    const onMsg = (m) => {
      if (m && m.replyTo === msgId) {
        try { process.off('message', onMsg); } catch {}
        resolve(m.data);
      }
    };
    try { process.on('message', onMsg); } catch {}
    try { process.send({ type: 'sup:reqOpen', perfil, msgId, opts }); } catch(e) {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok:false, error:'ipc_send_failed' });
    }
    setTimeout(() => {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok:false, error:'timeout' });
    }, 15000);
  });
}

async function notifyOpened(perfil, resultado = "ok", url) {
  if (!isChild) {
    try {
      const supervisor = require('./supervisor.js');
      return supervisor.notifyOpened(perfil, resultado);
    } catch (e) {
      logger.warn('[supervisorClient] notifyOpened erro:', { error: e && e.message || e });
      return { ok: false, error: e && e.message || e };
    }
  }
  return new Promise((resolve) => {
    const msgId = newMsgId();
    const onMsg = (m) => {
      if (m && m.replyTo === msgId) {
        try { process.off('message', onMsg); } catch {}
        resolve(m.data);
      }
    };
    try { process.on('message', onMsg); } catch {}
    try { process.send({ type: 'sup:notifyOpened', perfil, result: resultado, msgId }); } catch(e) {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok:false, error:'ipc_send_failed' });
    }
    setTimeout(() => {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok:false, error:'timeout' });
    }, 15000);
  });
}

async function sendTelemetria(evt, url) {
  try {
    const supervisor = require('./supervisor.js');
    return supervisor.sendTelemetria(evt);
  } catch (e) {
    logger.warn('[supervisorClient] sendTelemetria erro:', { error: e && e.message || e });
    return { ok: false, error: e && e.message || e };
  }
}

async function getStatus(url) {
  if (!isChild) {
    try {
      const supervisor = require('./supervisor.js');
      return supervisor.getStatus();
    } catch (e) {
      logger.warn('[supervisorClient] getStatus erro:', { error: e && e.message || e });
      return { ok: false, error: e && e.message || e };
    }
  }
  return new Promise((resolve) => {
    const msgId = newMsgId();
    const onMsg = (m) => {
      if (m && m.replyTo === msgId) {
        try { process.off('message', onMsg); } catch {}
        resolve(m.data);
      }
    };
    try { process.on('message', onMsg); } catch {}
    try { process.send({ type: 'sup:getStatus', msgId }); } catch(e) {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok:false, error:'ipc_send_failed' });
    }
    setTimeout(() => {
      try { process.off('message', onMsg); } catch {}
      resolve({ ok:false, error:'timeout' });
    }, 8000);
  });
}

async function getRam(url) {
  try {
    const supervisor = require('./supervisor.js');
    return supervisor.getRam();
  } catch (e) {
    logger.warn('[supervisorClient] getRam erro:', { error: e && e.message || e });
    return { ok: false, error: e && e.message || e };
  }
}

async function resetSupervisor(url) {
  try {
    const supervisor = require('./supervisor.js');
    return supervisor.resetSupervisor();
  } catch (e) {
    logger.warn('[supervisorClient] resetSupervisor erro:', { error: e && e.message || e });
    return { ok: false, error: e && e.message || e };
  }
}

module.exports = {
  requestOpen,
  notifyOpened,
  sendTelemetria,
  getStatus,
  getRam,
  resetSupervisor
};