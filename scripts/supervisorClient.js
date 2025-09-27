// scripts/supervisorClient.js
/*
 * CLIENTE PARA O SUPERVISOR UNIVERSAL EXTERNO
 * Fornece API fácil para o painel ou worker requisitar autorização para abrir navegador, 
 * enviar notificações de sucesso/erro/done, telemetria, consultar RAM e status.
 */

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const SUPERVISOR_URL = process.env.SUPERVISOR_URL || 'http://localhost:9800';

// Solicita abertura de um perfil. Retorna {ok:true, nextSlot}, ou erro/bloqueio
async function requestOpen(perfil) {
  const resp = await fetch(`${SUPERVISOR_URL}/requestOpen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ perfil })
  });
  return resp.json();
}

// Notifica Supervisor sobre término da abertura (sucesso/erro)
async function notifyOpened(perfil, resultado = "ok") {
  const resp = await fetch(`${SUPERVISOR_URL}/notifyOpened`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ perfil, resultado })
  });
  return resp.json();
}

// Envia evento/telemetria arbitrária:
async function sendTelemetria(evt) {
  try {
    const resp = await fetch(`${SUPERVISOR_URL}/telemetria`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt)
    });
    return resp.json();
  } catch (e) { return { ok: false, error: e && e.message || e }; }
}

// Consulta status consolidado do supervisor
async function getStatus() {
  const resp = await fetch(`${SUPERVISOR_URL}/status`);
  return resp.json();
}

// Consulta RAM livre/limiar
async function getRam() {
  const resp = await fetch(`${SUPERVISOR_URL}/ram`);
  return resp.json();
}

// Limpa histórico de slots/eventos (opcional/admin)
async function resetSupervisor() {
  const resp = await fetch(`${SUPERVISOR_URL}/reset`, { method: "POST" });
  return resp.json();
}

module.exports = {
  requestOpen,
  notifyOpened,
  sendTelemetria,
  getStatus,
  getRam,
  resetSupervisor
};