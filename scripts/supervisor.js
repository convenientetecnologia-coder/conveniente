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
const provisionLock = require('./provisionLock.js');
const ramPolicy = require('./ramPolicy.js');
const serverConfig = require('./serverConfig.js');
const { planMemoryAndShards } = require('./memoryPlan.js');

const pathStatusJson = path.join(__dirname, '..', 'dados', 'status.json');
const perfisPath = path.join(__dirname, '..', 'dados', 'perfis.json');

/**
 * Checa se kill_guard_until está ativo no status para o perfil solicitado.
 * Se ativo e timestamp > now, retorna true (bloqueará a abertura do slot).
 */
function killGuardActiveForPerfil(perfil) {
  try {
    if (!fs.existsSync(pathStatusJson)) return false;
    const statusJson = JSON.parse(fs.readFileSync(pathStatusJson, 'utf8'));
    if (!statusJson || !statusJson.perfis || !Array.isArray(statusJson.perfis)) return false;
    const ent = statusJson.perfis.find(x => x && x.nome === perfil);
    if (!ent) return false;
    if (ent.killGuardUntil && typeof ent.killGuardUntil === 'number' && ent.killGuardUntil > Date.now()) {
      return true;
    }
  } catch {}
  return false;
}

// Configs
const PORT = parseInt(process.env.SUPERVISOR_PORT || '9800', 10);
// Quantidade reserva de RAM a manter livre (em MB).
// Regra ultra enterprise:
// - Operação normal: 2GB + 1GB por node
// - Durante provision (somente dono do lock): 2GB + pico de cookies (~1.5GB)
const MIN_FREE_RAM_MB_STATIC = parseInt(process.env.SUP_MIN_FREE_RAM_MB || '0', 10);
// Ciclo de auto-tune em ms
const CYCLE_MS = parseInt(process.env.SUP_CYCLE_MS || '1600', 10);

function getMinFreeRamMBFor({ operator } = {}) {
  const snap = ramPolicy.snapshotPolicy();
  const op = String(operator || '').trim();

  // Override explícito por env (compatibilidade / emergência)
  if (Number.isFinite(MIN_FREE_RAM_MB_STATIC) && MIN_FREE_RAM_MB_STATIC > 0) return MIN_FREE_RAM_MB_STATIC;

  // Durante provisionamento: se o operador é o dono do lock, empresta 1GB/node.
  try {
    const lk = provisionLock.get();
    if (lk && lk.active && provisionLock.ownerMatchesOperator(lk.lock, op)) {
      return snap.reserveProvisionMB;
    }
  } catch {}

  // Operação normal: 2GB + 1GB por node
  return snap.reserveNormalMB;
}

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

/** Cooldowns individuais por perfil */
let cooldownPerAcc = new Map(); // perfil => timestamp until

/** Estado dos perfis ativos atualmente */
let ativos = new Map(); // nomePerfil => {openAt, status, ramAntes, ...}

// ===== Governança enterprise por tipo de fluxo (permits) =====
// Objetivo: impedir explosão de concorrência em flows pesados (login_remediate/identity_flow)
// SEM travar o sistema: se não houver permit, responde busy e o caller decide retry/backoff.
const GOV_CFG = {
  max: {
    login_remediate: Math.max(0, parseInt(process.env.GOV_MAX_LOGIN_REMEDIATE || '1', 10) || 1),
    identity_flow: Math.max(0, parseInt(process.env.GOV_MAX_IDENTITY_FLOW || '1', 10) || 1)
  },
  // TTL anti-leak: se um worker morrer e não liberar, o supervisor recupera.
  leaseTtlMs: Math.max(30_000, parseInt(process.env.GOV_PERMIT_LEASE_TTL_MS || String(15 * 60 * 1000), 10) || (15 * 60 * 1000)),
  // Backoff sugerido para caller (não é imposto)
  defaultRetryAfterMs: Math.max(1000, parseInt(process.env.GOV_PERMIT_RETRY_AFTER_MS || '5000', 10) || 5000)
};

// token -> { token, kind, perfil, operator, sinceMs, ttlMs }
const permitLeases = new Map();

function _permitInUseCount(kind) {
  let n = 0;
  for (const it of permitLeases.values()) if (it && it.kind === kind) n++;
  return n;
}

function _permitSnapshot() {
  const byKind = {};
  const leases = [];
  for (const it of permitLeases.values()) {
    if (!it || !it.kind) continue;
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    leases.push({
      kind: it.kind,
      perfil: it.perfil || null,
      operator: it.operator || null,
      sinceMs: it.sinceMs || 0,
      ttlMs: it.ttlMs || 0,
      token: it.token
    });
  }
  return { byKind, leases };
}

function requestPermit({ kind, perfil, operator, ttlMs } = {}) {
  try {
    const k = String(kind || '').trim();
    if (!k) return { ok: false, error: 'invalid_kind' };
    const max = (GOV_CFG.max && Number.isFinite(GOV_CFG.max[k])) ? GOV_CFG.max[k] : 0;
    if (max <= 0) return { ok: false, error: 'disabled', kind: k };

    const inUse = _permitInUseCount(k);
    if (inUse >= max) {
      pushEvent({ type: 'permit_denied', kind: k, perfil: String(perfil || '').slice(0, 120), operator: String(operator || '').slice(0, 120), inUse, max });
      return { ok: false, error: 'busy', kind: k, inUse, max, retryAfterMs: GOV_CFG.defaultRetryAfterMs };
    }

    const token = `permit:${k}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const lease = {
      token,
      kind: k,
      perfil: perfil ? String(perfil).slice(0, 120) : '',
      operator: operator ? String(operator).slice(0, 180) : '',
      sinceMs: Date.now(),
      ttlMs: Math.max(10_000, Math.min(Number(ttlMs || 0) || GOV_CFG.leaseTtlMs, GOV_CFG.leaseTtlMs))
    };
    permitLeases.set(token, lease);
    pushEvent({ type: 'permit_granted', kind: k, perfil: lease.perfil, operator: lease.operator, token });
    return { ok: true, kind: k, token, inUse: inUse + 1, max, ttlMs: lease.ttlMs };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function releasePermit({ token, kind, perfil, result } = {}) {
  try {
    const tok = String(token || '').trim();
    if (tok) {
      const it = permitLeases.get(tok);
      if (it) {
        permitLeases.delete(tok);
        pushEvent({ type: 'permit_released', kind: it.kind, perfil: it.perfil || null, operator: it.operator || null, token: tok, result: result || null });
        return { ok: true };
      }
      return { ok: false, error: 'not_found' };
    }
    // Fallback: libera por (kind+perfil) se token não foi preservado no caller.
    const k = String(kind || '').trim();
    const p = String(perfil || '').trim();
    if (!k || !p) return { ok: false, error: 'invalid_args' };
    for (const [t, it] of permitLeases.entries()) {
      if (it && it.kind === k && String(it.perfil || '') === p) {
        permitLeases.delete(t);
        pushEvent({ type: 'permit_released', kind: k, perfil: p, operator: it.operator || null, token: t, result: result || null });
        return { ok: true };
      }
    }
    return { ok: false, error: 'not_found' };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// TTL reclaim anti-leak
setInterval(() => {
  try {
    const now = Date.now();
    for (const [t, it] of permitLeases.entries()) {
      if (!it) { permitLeases.delete(t); continue; }
      const age = now - (Number(it.sinceMs || 0) || 0);
      const ttl = Number(it.ttlMs || 0) || GOV_CFG.leaseTtlMs;
      if (age > ttl) {
        permitLeases.delete(t);
        pushEvent({ type: 'permit_reclaimed_ttl', kind: it.kind, perfil: it.perfil || null, operator: it.operator || null, token: t, ageMs: age, ttlMs: ttl });
      }
    }
  } catch {}
}, 5000);

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

/** Opcional/Robustez: limpar cooldowns antigos */
setInterval(() => {
  const now = Date.now();
  for (const [perfil, until] of cooldownPerAcc) {
    if (until < now - 60000) cooldownPerAcc.delete(perfil);
  }
}, 30000);

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

// INSTRUÇÃO 1: SANEAMENTO IMEDIATO NO BOOT
function sanitizeOnBoot() {
  if (state.slotsAbertos > 0) {
    pushEvent({type:'boot_autofix_slots', prev:state.slotsAbertos});
    state.slotsAbertos = 0;
  }
  state.openBlockedUntil = 0;
  state.nextProbeAt = 0;
  saveState();
}
sanitizeOnBoot();

// Probe dinâmico de slots
state.nextProbeAt = state.nextProbeAt || 0;
function getFreeMB() {
  return getAvailableMB();
}
function canProbe() {
  const now = Date.now();
  const minFree = getMinFreeRamMBFor({});
  const cap = getEffectiveSlotsCap().cap;
  const atHardCap = Number.isFinite(cap) && cap > 0 && state.slotsAbertos >= cap;
  return state.maxSlots && state.slotsAbertos >= state.maxSlots &&
    !atHardCap &&
    getFreeMB() >= (minFree + 1024) &&
    now >= state.nextProbeAt;
}

function loadTotalProfilesCount() {
  try {
    if (!fs.existsSync(perfisPath)) return 0;
    const arr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
    return Array.isArray(arr) ? arr.filter(Boolean).length : 0;
  } catch {
    return 0;
  }
}

function getEffectiveSlotsCap() {
  try {
    const totalProfiles = loadTotalProfilesCount();
    const totalMemMB = Math.round(os.totalmem() / (1024 * 1024));
    const cfg = serverConfig.readServerConfigEffective({ totalMemMB });
    const cfgCapRaw = Number(cfg && cfg.capacity && cfg.capacity.maxAccountsEffective);
    const cfgCap = Number.isFinite(cfgCapRaw) && cfgCapRaw > 0 ? Math.floor(cfgCapRaw) : null;
    const plan = planMemoryAndShards({ totalProfiles: Math.max(1, totalProfiles) });
    const planGlobalRaw = Number(plan && plan.maxChromesPossibleGlobal);
    const planGlobal = Number.isFinite(planGlobalRaw) && planGlobalRaw > 0 ? Math.floor(planGlobalRaw) : null;
    const planByNodeRaw = Number(plan && plan.nodes) * Number(plan && plan.perNode && plan.perNode.maxChromes);
    const planByNode = Number.isFinite(planByNodeRaw) && planByNodeRaw > 0 ? Math.floor(planByNodeRaw) : null;
    const hardList = [cfgCap, planGlobal, planByNode].filter((n) => Number.isFinite(n) && n > 0);
    const hardCap = hardList.length ? Math.min(...hardList) : Math.max(1, totalProfiles || 1);
    const cap = Math.max(1, Math.floor(hardCap));
    return {
      cap,
      totalProfiles,
      cfgCap,
      planGlobal,
      planByNode,
      capacityMode: cfg && cfg.capacity ? cfg.capacity.mode : null
    };
  } catch {
    return { cap: 1, totalProfiles: 0, cfgCap: null, planGlobal: null, planByNode: null, capacityMode: null };
  }
}

function syncStateMaxSlotsWithCap() {
  const info = getEffectiveSlotsCap();
  const cap = Math.max(1, Number(info && info.cap) || 1);
  state.maxSlots = cap;
  state.maxEver = Math.max(Number(state.maxEver || 0), cap);
  return info;
}

/** Decide se pode abrir um novo slot agora */
function podeAbrirNovoSlot(perfil, opts = {}) {
  const now = Date.now();
  const freeMB = getFreeMB();
  const capInfo = syncStateMaxSlotsWithCap();
  const hardCap = Math.max(1, Number(capInfo && capInfo.cap) || 1);
  // Hardening: durante locks que realmente precisam "congelar abertura", NÃO permitir novas aberturas.
  // Importante (2026-01-30): `open_all_map` NÃO pode bloquear aberturas — ele existe justamente para abrir.
  // Ele só deve pausar Virtus/Robe (governança) e bloquear fluxos pesados, mas não impedir abrir navegador.
  try {
    const operator = String(opts && opts.operator || '').trim();
    const lk = provisionLock.get();
    if (lk && lk.active && lk.lock) {
      const owner = lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
      const kind = (lk.lock && lk.lock.meta && lk.lock.meta.kind) ? String(lk.lock.meta.kind) : '';
      const isOpenAll =
        kind === 'open_all_map' ||
        (owner && /^open_all_map:/i.test(owner));
      const shouldBlockOpen =
        // Bloqueios que devem impedir abertura:
        kind === 'stock_provision' ||
        kind === 'close_all' ||
        (owner && /^stock_provision:/i.test(owner)) ||
        (owner && /^close_all:/i.test(owner)) ||
        // Compat: admin_configure também isola abertura para evitar corrida durante injeção
        (owner && /^admin_configure:/i.test(owner));

      if (shouldBlockOpen && !provisionLock.ownerMatchesOperator(lk.lock, operator)) {
        pushEvent({ type: "denied", reason: "maintenance_provision", perfil, owner, operator, untilMs: lk.lock && lk.lock.untilMs, kind: kind || null });
        return { ok: false, reason: "maintenance_provision", msg: "Abertura bloqueada: manutenção/provisionamento em andamento" };
      }

      // open_all_map não bloqueia abertura (mesmo com operator diferente).
      if (isOpenAll) {
        // noop
      }
    }
  } catch {}
  // Checagem de RAM
  const operator = String(opts && opts.operator || '').trim();
  const minFree = getMinFreeRamMBFor({ operator });
  if (freeMB <= minFree) {
    pushEvent({type: "denied", reason: "ram_low", freeMB, minFree, perfil});
    return {ok: false, reason: "ram_low", freeMB};
  }
  // Cooldown PER-PERFIL (novo)
  const cooldownUntil = cooldownPerAcc.get(perfil) || 0;
  if (cooldownUntil > now) {
    pushEvent({type: "denied", reason: "cooldown_account", perfil, until: cooldownUntil});
    return {ok: false, reason: "cooldown", waitMs: cooldownUntil-now, perfil};
  }
  // (ANTIGO global - pode remover ou restringir para edge-cases de hard fault, mas por now deixamos sem efeito)
  // if (state.openBlockedUntil > now) { ... }

  // Limitador hard por slots (cap efetivo runtime)
  if (state.slotsAbertos >= hardCap) {
    pushEvent({
      type: "denied",
      reason: "slots_cap_runtime",
      maxSlots: hardCap,
      slotsAbertos: state.slotsAbertos,
      perfil,
      cfgCap: capInfo && capInfo.cfgCap,
      planGlobal: capInfo && capInfo.planGlobal,
      planByNode: capInfo && capInfo.planByNode
    });
    return { ok: false, reason: "slots", maxSlots: hardCap, hardCap: true };
  }
  return {ok: true, freeMB};
}

// ---------------------- INICIO DAS FUNÇÕES SINGLETON ---------------------------

/** Painel pede para abrir um novo navegador (requestOpen) */
// Era /requestOpen: POST body {perfil}
// AGORA: function requestOpen(perfil)
function requestOpen(perfil) {
  if (killGuardActiveForPerfil && killGuardActiveForPerfil(perfil)) {
    pushEvent({type:"denied", reason:"kill_guard_until", perfil});
    return { ok: false, reason: "kill_guard_until", msg: "Slot bloqueado por kill_guard_until (bloqueio anti-flapback)" };
  }
  const opts = arguments && arguments.length > 1 ? arguments[1] : {};
  syncStateMaxSlotsWithCap();
  const resp = podeAbrirNovoSlot(perfil, opts);
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

  state.slotsAbertos = Math.min(state.maxSlots || 1, state.slotsAbertos + 1);
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
  const capInfo = syncStateMaxSlotsWithCap();
  let openAt = null; if (ativos.has(perfil)) { openAt = ativos.get(perfil).openAt; }
  const dur = openAt ? Date.now() - openAt : null;
  state.slotsAbertos = Math.max(0, state.slotsAbertos-1);
  state.slotHistory.push({perfil, result: resultado, dur, ramFree: getFreeMB(), ts: Date.now()});
  if (state.slotHistory.length > 600) state.slotHistory.shift();

  if (resultado === "ok") {
    cooldownPerAcc.delete(perfil); // Limpa cooldown ativo (robustez extra)
  } else {
    // NOVO: Reduzido de 15s para 5s (reabertura quase imediata, mas ainda controlada)
    const until = Date.now() + 5000;
    cooldownPerAcc.set(perfil, until); // SÓ aplica cooldown para este perfil
    pushEvent({
      type: "abrir_err",
      perfil,
      maxSlots: state.maxSlots,
      cooldownUntil: until,
      cfgCap: capInfo && capInfo.cfgCap,
      planGlobal: capInfo && capInfo.planGlobal
    });
  }

  // INSTRUÇÃO 2: BUGFIX DE PROBE EM notifyOpened
  const info = ativos.get(perfil);

  if (info && info.probe) {
    if (resultado === 'ok') {
      pushEvent({type:"probe_succeeded", maxSlots: state.maxSlots});
    } else {
      state.openBlockedUntil = Date.now() + 20000;
      pushEvent({type:"probe_failed", maxSlots: state.maxSlots});
    }
  }
  if (perfil) ativos.delete(perfil);

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
  const capInfo = syncStateMaxSlotsWithCap();
  const permits = _permitSnapshot();
  return {
    ok: true,
    supervisor: {
      slotsAbertos: state.slotsAbertos,
      maxSlots: state.maxSlots,
      maxEver: state.maxEver,
      hardCap: capInfo,
      ramLivre: getFreeMB(),
      ramMin: getMinFreeRamMBFor({}),
      ativosSize: ativos.size,
      tempoAbertura: state.tempoAbertura.slice(-20),
      openBlockedUntil: state.openBlockedUntil,
      slotHistory: state.slotHistory.slice(-20),
      nextProbeAt: state.nextProbeAt,
      reclaimedSlots: eventStream.filter(evt => evt.type === 'slot_reclaimed_ttl').length,
      probeSuccess: eventStream.filter(evt => evt.type === 'probe_succeeded').length,
      probeFail: eventStream.filter(evt => evt.type === 'probe_failed').length,
      permits: {
        inUseByKind: permits.byKind,
        maxByKind: GOV_CFG.max,
        leases: permits.leases.slice(0, 60)
      }
    },
    eventos: eventStream.slice(-100)
  };
}

/** Consulta de RAM livre */
// Era GET /ram
function getRam() {
  return { livre: getFreeMB(), min: getMinFreeRamMBFor({}) };
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

// INSTRUÇÃO 3: RECONCILIADOR PERIÓDICO DE SLOTS
function reconcileSlots() {
  try {
    const stPath = path.join(__dirname, '..', 'dados', 'status.json');
    if (!fs.existsSync(stPath)) return;
    const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
    const tsStatus = st.ts || Date.now();
    const age = (Date.now() - tsStatus)/1000;
    const aliveBrowsers = (st.perfis||[]).filter(x=>x && x.active).length;
    if (age > 120) {
      pushEvent({type:'auto_reset_slots', reason:'status_stale', age});
      state.slotsAbertos = 0; state.openBlockedUntil = 0; saveState();
      return;
    }
    if (aliveBrowsers === 0 && state.slotsAbertos > 0) {
      pushEvent({type:'auto_reset_slots', reason:'zero_active_long'});
      state.slotsAbertos = 0; state.openBlockedUntil = 0; saveState();
    }
  } catch {}
}
setInterval(reconcileSlots, 2000);

// EXPRESS REMOVIDO: 
// Todas as rotas e app.listen foram removidas conforme instrução

// Exporta o singleton com os métodos
module.exports = {
  requestOpen,
  notifyOpened,
  requestPermit,
  releasePermit,
  sendTelemetria,
  getStatus,
  getRam,
  resetSupervisor
};