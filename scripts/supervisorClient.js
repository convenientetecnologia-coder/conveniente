// scripts/supervisorClient.js
/*
 * CLIENTE PARA O SUPERVISOR UNIVERSAL IN-PROCESS (UNIFICADO)
 * Todas as chamadas são diretas ao módulo supervisor.js.
 * Tolerante a erro, nunca lança uncaught.
 */

const supervisor = require('./supervisor.js');

async function requestOpen(perfil, url) {
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