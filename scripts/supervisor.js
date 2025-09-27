// scripts/supervisor.js
/*
 * SUPERVISOR UNIVERSAL — GOVERNADOR DE ORÇAMENTO
 * Controla ritmo de aberturas de navegador, slots disponíveis, auto-tune baseado em latência real/headroom,
 * bloqueia se RAM apertada, aprende capacidade ótima do host. Mantém event stream para painel.
 */

"use strict";

// EXPRESS REMOVIDO
// const express = require("express");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { getAvailableMB } = require('./utils.js'); // ADICIONADO CONFORME INSTRUÇÃO

// Configs
const PORT = parseInt(process.env.SUPERVISOR_PORT || '9800', 10);
// Quantidade reserva de RAM a manter livre (em MB, padrão: 3072)
const MIN_FREE_RAM_MB = parseInt(process.env.SUP_MIN_FREE_RAM_MB || '3072', 10);
// Ciclo de auto-tune em ms
const CYCLE_MS = parseInt(process.env.SUP_CYCLE_MS || '1600', 10);

// EXPRESS REMOVIDO
// const app = express();
// app.use(express.json());

/** Estado do Supervisor */
let state = {
  maxSlots: null,            // Último slot testado OK (inicialmente null)
  maxEver: 0,
  slotHistory: [],           // {opened: N, result: ok/erro, ramFree, ts}
  tempoAbertura: [],         // ms das aberturas recentes (moving avg)
  lastTestStart: null,
  slotsAbertos: 0,
  tempoUltAbertura: null,
  openBlockedUntil: 0,
  cooldownDynamic: 0,
  erroJaRetornado: false
};

/** Estado dos perfis ativos atualmente */
let ativos = new Map(); // nomePerfil => {openAt, status, ramAntes, ...}

// TTL reclaim de slots abertos que não chamaram notifyOpened
setInterval(() => {
  const now = Date.now();
  for (const [perfil, info] of ativos) {
    if (now - info.openAt > 60000) { // TTL 60s
      state.slotsAbertos = Math.max(0, state.slotsAbertos - 1);
      ativos.delete(perfil);
      pushEvent({type:'slot_reclaimed_ttl', perfil, age: now-info.openAt});
      saveState();
    }
  }
}, 5000);

/** Histórico de eventos para telemetria */
const eventStream = [];
function pushEvent(evt) {
  // Limita a, por exemplo, 5000 eventos (pode ajustar)
  if (eventStream.length > 5000) eventStream.shift();
  eventStream.push({...evt, ts: Date.now()});
}

// Atualiza e salva state local
function saveState() {
  try {
    fs.writeFileSync(path.join(__dirname, '..', 'dados', 'supervisor_state.json'), JSON.stringify(state, null, 2));
  } catch (e) {}
}
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dados', 'supervisor_state.json')));
    Object.assign(state, j || {});
  } catch {}
}
loadState();

// Probe dinâmico de slots
state.nextProbeAt = state.nextProbeAt || 0;
function getFreeMB() {
  return getAvailableMB();
}
function canProbe() {
  const now = Date.now();
  return state.maxSlots && state.slotsAbertos >= state.maxSlots &&
    getFreeMB() >= (MIN_FREE_RAM_MB + 1024) &&
    now >= state.nextProbeAt;
}

/** Decide se pode abrir um novo slot agora */
function podeAbrirNovoSlot() {
  const now = Date.now();
  const freeMB = getFreeMB();
  if (freeMB <= MIN_FREE_RAM_MB) {
    pushEvent({type: "denied", reason: "ram_low", freeMB});
    return {ok: false, reason: "ram_low", freeMB};
  }
  if (state.openBlockedUntil > now) {
    pushEvent({type: "denied", reason: "cooldown", until: state.openBlockedUntil});
    return {ok: false, reason: "cooldown", waitMs: state.openBlockedUntil-now};
  }
  // Limitador por slots
  if (state.maxSlots && state.slotsAbertos >= state.maxSlots) {
    pushEvent({type:"denied", reason:"slots", maxSlots:state.maxSlots, slotsAbertos: state.slotsAbertos});
    return {ok: false, reason: "slots", maxSlots: state.maxSlots};
  }
  return {ok: true, freeMB};
}

// ---------------------- INICIO DAS FUNÇÕES SINGLETON ---------------------------

/** Painel pede para abrir um novo navegador (requestOpen) */
// Era /requestOpen: POST body {perfil}
// AGORA: function requestOpen(perfil)
function requestOpen(perfil) {
  const resp = podeAbrirNovoSlot();
  // Logic for probe (como antes)
  if (!resp.ok && resp.reason === 'slots' && canProbe()) {
    state.maxSlots = Math.max(1, state.maxSlots);
    state.slotsAbertos++;
    state.nextProbeAt = Date.now() + 8 * 60 * 1000; // 8 min
    ativos.set(perfil, { openAt: Date.now(), probe: true });
    pushEvent({type:"open_granted_probe", perfil});
    saveState();
    return { ok:true, probe:true, nextSlot: state.slotsAbertos };
  }
  if (!resp.ok) return { ...resp, ok: false };

  state.slotsAbertos++;
  state.tempoUltAbertura = Date.now();
  ativos.set(perfil, { openAt: Date.now() });
  pushEvent({type:"open_granted", perfil});
  saveState();
  return { ok:true, nextSlot: state.slotsAbertos };
}

/** Notifica término de abertura do navegador (ok ou erro) */
// Era POST /notifyOpened {perfil, resultado}
// AGORA: function notifyOpened(perfil, resultado = "ok")
function notifyOpened(perfil, resultado = "ok") {
  let openAt = null; if (ativos.has(perfil)) { openAt = ativos.get(perfil).openAt; }
  const dur = openAt ? Date.now() - openAt : null;
  state.slotsAbertos = Math.max(0, state.slotsAbertos-1);
  state.slotHistory.push({perfil, result: resultado, dur, ramFree: getFreeMB(), ts: Date.now()});
  if (state.slotHistory.length > 600) state.slotHistory.shift();

  if (resultado === "ok") {
    if (!state.maxSlots || state.slotsAbertos > state.maxSlots) state.maxSlots = state.slotsAbertos;
    if (state.maxSlots > state.maxEver) state.maxEver = state.maxSlots;
  } else {
    state.openBlockedUntil = Date.now() + 15000;
    state.maxSlots = Math.max(1, (state.maxSlots||1) -1);
    pushEvent({type:"abrir_err", perfil, maxSlots:state.maxSlots});
  }
  if (perfil) ativos.delete(perfil);

  // Probe
  const info = ativos.get(perfil);
  if (info && info.probe) {
    if (resultado === 'ok') {
      state.maxSlots = (state.maxSlots||0) + 1;
      pushEvent({type:"probe_succeeded", maxSlots: state.maxSlots});
    } else {
      state.openBlockedUntil = Date.now() + 20000;
      pushEvent({type:"probe_failed", maxSlots: state.maxSlots});
    }
  }

  pushEvent({type: "opened_result", perfil, result: resultado, dur});
  saveState();
  return { ok:true };
}

/** PUT: telemetria fina */
// Era POST /telemetria {body: evt}
// AGORA: function sendTelemetria(evt)
function sendTelemetria(evt) {
  pushEvent({ ...evt, type: "telemetria" });
  return { ok:true };
}

/** Consulta estado e eventos do supervisor */
// Era GET /status
function getStatus() {
  return {
    ok: true,
    supervisor: {
      slotsAbertos: state.slotsAbertos,
      maxSlots: state.maxSlots,
      maxEver: state.maxEver,
      ramLivre: getFreeMB(),
      ramMin: MIN_FREE_RAM_MB,
      ativosSize: ativos.size,
      tempoAbertura: state.tempoAbertura.slice(-20),
      openBlockedUntil: state.openBlockedUntil,
      slotHistory: state.slotHistory.slice(-20),
      nextProbeAt: state.nextProbeAt,
      reclaimedSlots: eventStream.filter(evt => evt.type === 'slot_reclaimed_ttl').length,
      probeSuccess: eventStream.filter(evt => evt.type === 'probe_succeeded').length,
      probeFail: eventStream.filter(evt => evt.type === 'probe_failed').length
    },
    eventos: eventStream.slice(-100)
  };
}

/** Consulta de RAM livre */
// Era GET /ram
function getRam() {
  return { livre: getFreeMB(), min: MIN_FREE_RAM_MB };
}

/** Limpar histórico de eventos */
// Era POST /reset
function resetSupervisor() {
  Object.assign(state, {
    slotsAbertos: 0,
    maxSlots: null,
    slotHistory: [],
    tempoAbertura: [],
    tempoUltAbertura: null,
    openBlockedUntil: 0,
    cooldownDynamic: 0,
    erroJaRetornado: false
  });
  eventStream.length = 0;
  saveState();
  return { ok:true };
}

// ---------------------- FIM DAS FUNÇÕES SINGLETON ---------------------------

// EXPRESS REMOVIDO: 
// Todas as rotas e app.listen foram removidas conforme instrução

// Exporta o singleton com os métodos
module.exports = {
  requestOpen,
  notifyOpened,
  sendTelemetria,
  getStatus,
  getRam,
  resetSupervisor
};