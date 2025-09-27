// scripts/supervisorClient.js
/*
 * CLIENTE PARA O SUPERVISOR UNIVERSAL EXTERNO
 * Fornece API fácil para o painel ou worker requisitar autorização para abrir navegador, 
 * enviar notificações de sucesso/erro/done, telemetria, consultar RAM e status.
 *
 * Este client é tolerante a erro (never throw uncaught) — retorna {ok:false, ...} sempre que supervisor está off/inacessível.
 * Métodos aceitam url alternativo opcional, para test cluster/DEV.
 */

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const SUPERVISOR_URL = process.env.SUPERVISOR_URL || 'http://localhost:9800';

// Solicita abertura de um perfil. Retorna {ok:true, nextSlot}, ou erro/bloqueio
// Caso retorne {ok:false, reason:'cooldown' ou similar}, o caller (worker) deve respeitar e aplicar delay/backoff antes de nova chamada.
async function requestOpen(perfil, url) {
  const _url = url || SUPERVISOR_URL;
  try {
    const resp = await fetch(`${_url}/requestOpen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ perfil })
    });
    let js;
    try {
      js = await resp.json();
    } catch(e) {
      return { ok: false, error: "supervisor_invalid_json", detail: e && e.message || e };
    }
    if (resp.status === 429 || (js && (js.reason === 'cooldown' || js.reason === 'flood' || js.reason === 'throttle'))) {
      // Reforço: Devolve ok:false sempre que 429 e sugere que o caller respeite backoff sugerido pela doc
      return { ...js, ok: false, error: js.reason || "cooldown" };
    }
    return js;
  } catch (e) {
    return { ok: false, error: 'supervisor_unreachable', detail: e && e.message || e };
  }
}

// Notifica Supervisor sobre término da abertura (sucesso/erro)
async function notifyOpened(perfil, resultado = "ok", url) {
  const _url = url || SUPERVISOR_URL;
  try {
    const resp = await fetch(`${_url}/notifyOpened`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ perfil, resultado })
    });
    try {
      return await resp.json();
    } catch(e) {
      return { ok: false, error: "supervisor_invalid_json", detail: e && e.message || e };
    }
  } catch (e) {
    return { ok: false, error: 'supervisor_unreachable', detail: e && e.message || e };
  }
}

// Envia evento/telemetria arbitrária:
async function sendTelemetria(evt, url) {
  const _url = url || SUPERVISOR_URL;
  try {
    const resp = await fetch(`${_url}/telemetria`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt)
    });
    try {
      return await resp.json();
    } catch(e) {
      return { ok: false, error: "supervisor_invalid_json", detail: e && e.message || e };
    }
  } catch (e) {
    return { ok: false, error: 'supervisor_unreachable', detail: e && e.message || e };
  }
}

// Consulta status consolidado do supervisor
async function getStatus(url) {
  const _url = url || SUPERVISOR_URL;
  try {
    const resp = await fetch(`${_url}/status`);
    try {
      return await resp.json();
    } catch(e) {
      return { ok: false, error: "supervisor_invalid_json", detail: e && e.message || e };
    }
  } catch (e) {
    return { ok: false, error: 'supervisor_unreachable', detail: e && e.message || e };
  }
}

// Consulta RAM livre/limiar
async function getRam(url) {
  const _url = url || SUPERVISOR_URL;
  try {
    const resp = await fetch(`${_url}/ram`);
    try {
      return await resp.json();
    } catch(e) {
      return { ok: false, error: "supervisor_invalid_json", detail: e && e.message || e };
    }
  } catch (e) {
    return { ok: false, error: 'supervisor_unreachable', detail: e && e.message || e };
  }
}

// Limpa histórico de slots/eventos (opcional/admin)
async function resetSupervisor(url) {
  const _url = url || SUPERVISOR_URL;
  const resp = await fetch(`${_url}/reset`, { method: "POST" });
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