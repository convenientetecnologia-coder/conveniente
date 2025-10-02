// scripts/supervisorClient.js
/*
 * CLIENTE PARA O SUPERVISOR UNIVERSAL IN-PROCESS (UNIFICADO)
 * Todas as chamadas são diretas ao módulo supervisor.js.
 * Tolerante a erro, nunca lança uncaught.
 */

const supervisor = require('./supervisor.js');

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

async function requestOpen(perfil, url) {
  if (localKillGuardActive(perfil)) {
    return { ok: false, error: 'kill_guard_until', msg: 'Abertura de slot negada por kill_guard_until' };
  }
  try {
    return supervisor.requestOpen(perfil);
  } catch (e) {
    console.warn('[supervisorClient] requestOpen erro:', e && e.message || e);
    return { ok: false, error: e && e.message || e };
  }
}

async function notifyOpened(perfil, resultado = "ok", url) {
  try {
    return supervisor.notifyOpened(perfil, resultado);
  } catch (e) {
    console.warn('[supervisorClient] notifyOpened erro:', e && e.message || e);
    return { ok: false, error: e && e.message || e };
  }
}

async function sendTelemetria(evt, url) {
  try {
    return supervisor.sendTelemetria(evt);
  } catch (e) {
    console.warn('[supervisorClient] sendTelemetria erro:', e && e.message || e);
    return { ok: false, error: e && e.message || e };
  }
}

async function getStatus(url) {
  try {
    return supervisor.getStatus();
  } catch (e) {
    console.warn('[supervisorClient] getStatus erro:', e && e.message || e);
    return { ok: false, error: e && e.message || e };
  }
}

async function getRam(url) {
  try {
    return supervisor.getRam();
  } catch (e) {
    console.warn('[supervisorClient] getRam erro:', e && e.message || e);
    return { ok: false, error: e && e.message || e };
  }
}

async function resetSupervisor(url) {
  try {
    return supervisor.resetSupervisor();
  } catch (e) {
    console.warn('[supervisorClient] resetSupervisor erro:', e && e.message || e);
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