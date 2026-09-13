'use strict';

/**
 * Trava humana (human_boot_hold.json) — só impede Abrir Tudo automático do porteiro.
 *
 * TRAVA:
 * - Encerrar workers (reason=stop_workers) — vale até Abrir Tudo / adotar célula viva
 * - Clique Iniciar Sistema (human_iniciar / iniciar_*) — vale 15 min
 *   (cobre wait_index 180s + boot + corrida com AUTO_BOOT do porteiro)
 *
 * NÃO TRAVA:
 * - Ctrl+C no index (células vivas ficam; sem navegador o index leva as células)
 * - Fechar Todos
 * - Queda real depois que a trava de Iniciar já expirou
 *
 * DESTRAVA:
 * - Abrir Tudo (clique ou agenda 5-7h)
 * - Index adotou workers vivos (sistema já está aberto; trava velha morre)
 * - human_iniciar: TTL 15 min (crash tarde ainda religa no ciclo)
 *
 * Expediente (workHours.js): relógio 05:00–01:00. lastOpenAt NÃO manda.
 * De dia o boot do porteiro não zera desired. Abrir Tudo só se o pedido estiver zerado.
 */

const HUMAN_INICIAR_HOLD_MS = 15 * 60 * 1000;

const fs = require('fs');
const path = require('path');

const HOLD_PATH = path.join(__dirname, '..', 'dados', 'human_boot_hold.json');

function nowTs() {
  return Date.now();
}

function getBootSource() {
  return String(process.env.CONVENIENTE_BOOT_SOURCE || '').trim().toLowerCase();
}

function writeJsonAtomic(fp, obj) {
  const dir = path.dirname(fp);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

function readHumanHold() {
  if (!fs.existsSync(HOLD_PATH)) return { active: false, missing: true };
  try {
    const raw = String(fs.readFileSync(HOLD_PATH, 'utf8') || '').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return { active: true, reason: 'hold_unreadable' };
    return {
      active: j.active === true,
      reason: j.reason ? String(j.reason).slice(0, 80) : null,
      by: j.by ? String(j.by).slice(0, 120) : null,
      at: Number(j.at || 0) || 0
    };
  } catch {
    return { active: true, reason: 'hold_unreadable' };
  }
}

function isStopWorkersHold(reason) {
  const r = String(reason || '');
  return r === 'stop_workers' || r.startsWith('stop_workers:') || r === 'hold_unreadable';
}

function isHumanIniciarHold(reason) {
  const r = String(reason || '');
  return r === 'human_iniciar' || r === 'iniciar_recycle' || r === 'iniciar_stamp_stale' || /^iniciar_/.test(r);
}

function isHumanHoldBlockingOpenAll({ active, reason, at, nowTs: ts } = {}) {
  if (active !== true) return false;
  if (isStopWorkersHold(reason)) return true;
  if (isHumanIniciarHold(reason)) {
    const now = Number(ts) || Date.now();
    const when = Number(at || 0) || 0;
    if (!when) return true;
    return (now - when) <= HUMAN_INICIAR_HOLD_MS;
  }
  return false;
}

function setHumanHold({ reason = 'human', by = 'unknown' } = {}) {
  const prev = readHumanHold();
  const nextReason = String(reason || 'human').slice(0, 80);
  if (prev && prev.active === true && isStopWorkersHold(prev.reason) && !isStopWorkersHold(nextReason)) {
    return prev;
  }
  const row = {
    version: 1,
    active: true,
    reason: nextReason,
    by: String(by || 'unknown').slice(0, 120),
    at: nowTs()
  };
  writeJsonAtomic(HOLD_PATH, row);
  return row;
}

function clearHumanHold({ by = 'unknown' } = {}) {
  const prev = readHumanHold();
  const row = {
    version: 1,
    active: false,
    clearedAt: nowTs(),
    clearedBy: String(by || 'unknown').slice(0, 120),
    prevReason: prev && prev.reason ? prev.reason : null
  };
  writeJsonAtomic(HOLD_PATH, row);
  return row;
}

function isScheduledDailyWindowActor(by, origin) {
  const a = String(by || '');
  const b = String(origin || '');
  return /daily_window/i.test(a) || /daily_window/i.test(b);
}

function decideWorkCycle({
  nowTs: ts,
  enabled,
  mode,
  lastOpenAt,
  lastCloseAt,
  nextCloseAt,
  nowMin,
  day,
  closeStartMin,
  openStartMin,
  openEndMin,
  lastOpenDay
} = {}) {
  const workHours = require('./workHours.js');
  const now = Number(ts) || Date.now();
  const hours = workHours.decideWorkHours({
    nowMin: nowMin != null ? nowMin : workHours.saoPauloMinutesSinceMidnight(now),
    day: day || workHours.todayKeySaoPaulo(now),
    enabled,
    mode,
    closeStartMin: closeStartMin != null ? closeStartMin : 60,
    openStartMin: openStartMin != null ? openStartMin : 300,
    openEndMin: openEndMin != null ? openEndMin : 420,
    lastOpenDay
  });
  return {
    inWorkCycle: hours.inWorkHours === true && hours.waitScheduledOpen !== true,
    waitScheduledOpen: hours.waitScheduledOpen === true,
    inWorkHours: hours.inWorkHours === true,
    reason: hours.reason,
    lastOpenAt: Number(lastOpenAt) || 0,
    lastCloseAt: Number(lastCloseAt) || 0,
    nextCloseAt: Number(nextCloseAt) || 0
  };
}

function decideAutoOpenAll({
  bootSource,
  allCellsDead,
  humanHoldActive,
  holdReason,
  holdAt,
  nowTs: ts,
  workCycle,
  desiredAllOff
} = {}) {
  const workHours = require('./workHours.js');
  if (String(bootSource || '') !== 'porteiro') return { yes: false, reason: 'boot_source_not_porteiro' };
  if (isHumanHoldBlockingOpenAll({
    active: humanHoldActive === true,
    reason: holdReason,
    at: holdAt,
    nowTs: ts
  })) {
    return { yes: false, reason: 'human_hold' };
  }
  const hoursYes = !!(workCycle && (workCycle.inWorkCycle === true || (
    workCycle.inWorkHours === true && workCycle.waitScheduledOpen !== true
  )));
  const decided = workHours.shouldAutoOpenAll({
    bootSource,
    humanHoldActive,
    holdReason,
    holdAt,
    nowTs: ts,
    inWorkHours: hoursYes,
    waitScheduledOpen: !!(workCycle && workCycle.waitScheduledOpen === true),
    desiredAllOff,
    isHumanHoldBlockingOpenAll
  });
  if (decided.yes !== true) return decided;
  return {
    yes: true,
    reason: allCellsDead === true ? 'porteiro_all_dead_work_hours' : 'porteiro_work_hours_desired_off'
  };
}

function audit(event, patch) {
  try {
    require('./provisionAudit.js').append(Object.assign({ ts: nowTs(), event }, patch || {}));
  } catch {}
  try {
    require('./indexLifecycle.js').append(event, patch || {});
  } catch {}
}

function getWorkCycleDecision(ts = Date.now()) {
  const workHours = require('./workHours.js');
  const hours = workHours.getWorkHoursDecision(ts);
  return {
    inWorkCycle: hours.inWorkHours === true && hours.waitScheduledOpen !== true,
    inWorkHours: hours.inWorkHours === true,
    waitScheduledOpen: hours.waitScheduledOpen === true,
    reason: hours.reason,
    lastOpenAt: hours.lastOpenAt,
    lastCloseAt: hours.lastCloseAt,
    nextCloseAt: hours.nextCloseAt,
    nextOpenAt: hours.nextOpenAt,
    lastOpenDay: hours.lastOpenDay,
    lastCloseDay: hours.lastCloseDay
  };
}

async function maybePorterOpenAllOnBoot({ allCellsDead, port } = {}) {
  const workHours = require('./workHours.js');
  const work = getWorkCycleDecision(nowTs());
  const hold = readHumanHold();
  const bootSource = getBootSource();
  let desiredSnap = { perfis: {} };
  try {
    const fileStore = require('./fileStore.js');
    desiredSnap = fileStore.readJsonSafe(fileStore.desiredPath, { perfis: {} }) || { perfis: {} };
  } catch {}
  const allOff = workHours.desiredAllOff(desiredSnap);
  const decision = decideAutoOpenAll({
    bootSource,
    allCellsDead: allCellsDead === true,
    humanHoldActive: !!(hold && hold.active),
    holdReason: hold && hold.reason ? String(hold.reason) : null,
    holdAt: hold && hold.at ? hold.at : 0,
    nowTs: nowTs(),
    workCycle: work,
    desiredAllOff: allOff
  });
  const snap = {
    bootSource: bootSource || null,
    allCellsDead: allCellsDead === true,
    humanHold: !!(hold && hold.active),
    holdReason: hold && hold.reason ? hold.reason : null,
    workReason: work && work.reason ? work.reason : null,
    waitScheduledOpen: !!(work && work.waitScheduledOpen),
    desiredActive: workHours.countDesiredActive(desiredSnap),
    lastOpenAt: work && work.lastOpenAt ? work.lastOpenAt : 0,
    lastCloseAt: work && work.lastCloseAt ? work.lastCloseAt : 0,
    nextCloseAt: work && work.nextCloseAt ? work.nextCloseAt : 0,
    decision: decision.reason,
    yes: decision.yes === true
  };
  try {
    require('./logger.js').info('[BOOT][OPEN_ALL_DECISION]', snap);
  } catch {}
  audit('boot_open_all_decision', snap);
  if (decision.yes !== true) return Object.assign({ ok: true, fired: false }, snap);

  const p = Math.max(1, Number(port || process.env.PORT || 8088) || 8088);
  let body = null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => { try { ac.abort(); } catch {} }, 5 * 60 * 1000);
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/perfis/open-all-24h`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-operator': 'porteiro_work_cycle' },
        body: '{}',
        signal: ac.signal
      });
      body = await r.json().catch(() => null);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    const err = (e && e.message) ? String(e.message) : String(e);
    audit('boot_open_all_failed', { error: err.slice(0, 180) });
    try { require('./logger.js').warn('[BOOT] porteiro Abrir Tudo falhou', { error: err }); } catch {}
    return Object.assign({ ok: false, fired: false, error: err }, snap);
  }
  const ok = !!(body && body.ok === true);
  audit('boot_open_all_fired', {
    ok,
    total: body && body.total != null ? body.total : null,
    alreadyRunning: !!(body && body.alreadyRunning),
    error: body && body.error ? String(body.error).slice(0, 160) : null
  });
  try {
    require('./logger.js').info('[BOOT] porteiro Abrir Tudo', {
      ok,
      total: body && body.total != null ? body.total : null
    });
  } catch {}
  return Object.assign({ ok, fired: true, result: body }, snap);
}

module.exports = {
  HOLD_PATH,
  HUMAN_INICIAR_HOLD_MS,
  getBootSource,
  readHumanHold,
  isStopWorkersHold,
  isHumanIniciarHold,
  isHumanHoldBlockingOpenAll,
  setHumanHold,
  clearHumanHold,
  isScheduledDailyWindowActor,
  decideWorkCycle,
  decideAutoOpenAll,
  getWorkCycleDecision,
  maybePorterOpenAllOnBoot
};
