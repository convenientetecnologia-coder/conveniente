// scripts/supervisor.js
/*
 * SUPERVISOR UNIVERSAL — GOVERNADOR DE ORÇAMENTO
 * Controla ritmo de aberturas de navegador, slots disponíveis, auto-tune baseado em latência real/headroom,
 * bloqueia se RAM apertada, aprende capacidade ótima do host. Mantém event stream para painel.
 */

"use strict";

const express = require("express");
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

const app = express();
app.use(express.json());

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

/** Painel pede para abrir um novo navegador (requestOpen) */
app.post("/requestOpen", (req, res) => {
  // body {perfil: string}
  const resp = podeAbrirNovoSlot();
  if (!resp.ok && resp.reason === 'slots' && canProbe()) {
    // Permite um probe extra de slot (slot de teste)
    state.maxSlots = Math.max(1, state.maxSlots);
    state.slotsAbertos++;
    state.nextProbeAt = Date.now() + 8 * 60 * 1000; // 8 min
    ativos.set(req.body && req.body.perfil, { openAt: Date.now(), probe: true });
    pushEvent({type:"open_granted_probe", perfil:req.body && req.body.perfil});
    saveState();
    return res.json({ ok:true, probe:true, nextSlot: state.slotsAbertos });
  }
  if (!resp.ok) return res.status(429).json(resp);

  state.slotsAbertos++;
  state.tempoUltAbertura = Date.now();
  ativos.set(req.body && req.body.perfil, {openAt: Date.now()});
  pushEvent({type:"open_granted", perfil:req.body && req.body.perfil});
  saveState();
  res.json({ok:true, nextSlot: state.slotsAbertos});
});

/** Notifica término de abertura do navegador (ok ou erro) */
app.post("/notifyOpened", (req, res) => {
  // body: {perfil, resultado}
  const nome = req.body.perfil;
  const result = req.body.resultado || "ok";
  let openAt = null; if (ativos.has(nome)) { openAt = ativos.get(nome).openAt; }
  const dur = openAt ? Date.now() - openAt : null;
  state.slotsAbertos = Math.max(0, state.slotsAbertos-1);
  state.slotHistory.push({perfil: nome, result, dur, ramFree: getFreeMB(), ts: Date.now()});
  if (state.slotHistory.length > 600) state.slotHistory.shift();

  // Auto-tune: se abriu ok e dur < 12seg, pode tentar subir mais
  if (result === "ok") {
    if (!state.maxSlots || state.slotsAbertos > state.maxSlots) state.maxSlots = state.slotsAbertos;
    if (state.maxSlots > state.maxEver) state.maxEver = state.maxSlots;
  } else {
    // Se erro: backoff/cooldown
    state.openBlockedUntil = Date.now() + 15000;
    state.maxSlots = Math.max(1, (state.maxSlots||1) -1);
    pushEvent({type:"abrir_err", perfil:nome, maxSlots:state.maxSlots});
  }
  if (nome) ativos.delete(nome);

  // bloco inserido conforme instrução para probe dinâmico ao notificar abertura
  const info = ativos.get(nome);
  if (info && info.probe) {
    if (result === 'ok') {
      state.maxSlots = (state.maxSlots||0) + 1;
      pushEvent({type:"probe_succeeded", maxSlots: state.maxSlots});
    } else {
      state.openBlockedUntil = Date.now() + 20000;
      pushEvent({type:"probe_failed", maxSlots: state.maxSlots});
    }
  }

  pushEvent({type: "opened_result", perfil: nome, result, dur});
  saveState();
  res.json({ok:true});
});

/** PUT: Woker/painel pode enviar telemetria fina */
app.post("/telemetria", (req, res) => {
  // body: {perfil, evento, ...}
  pushEvent({...req.body, type:"telemetria"});
  res.json({ok:true});
});

/** Consulta estado e eventos do supervisor */
app.get("/status", (req, res) => {
  res.json({
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
  });
});

/** Limpar histórico de eventos */
app.post('/reset', (req, res) => {
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
  res.json({ok:true});
});

/** Consulta de RAM livre */
app.get("/ram", (req, res) => {
  res.json({livre: getFreeMB(), min: MIN_FREE_RAM_MB});
});

app.listen(PORT, () =>{
  console.log(`[SUPERVISOR] Supervisor universal rodando em http://localhost:${PORT}/ (minFreeRAM=${MIN_FREE_RAM_MB}MB, ciclo auto-tune ${CYCLE_MS}ms)`);
});