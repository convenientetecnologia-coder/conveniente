'use strict';

/**
 * Trava humana (human_boot_hold.json) — só impede Abrir Tudo automático do porteiro.
 *
 * TRAVA (só este caso):
 * - Humano encerrou os workers (botão Encerrar workers, ou Iniciar reciclando célula velha no git pull)
 *
 * NÃO TRAVA:
 * - Ctrl+C no index
 * - Fechar Todos
 * - Iniciar / porteiro depois de uma queda, sem o humano ter encerrado workers
 * - Queda real (crash)
 *
 * DESTRAVA:
 * - Abrir Tudo (clique, agenda 5-7h, ou porteiro no ciclo de trabalho)
 * - Index adotou workers vivos (sistema já está aberto; trava velha morre)
 */

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
    const j = JSON.parse(String(fs.readFileSync(HOLD_PATH, 'utf8') || ''));
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

function setHumanHold({ reason = 'human', by = 'unknown' } = {}) {
  const row = {
    version: 1,
    active: true,
    reason: String(reason || 'human').slice(0, 80),
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
  nextCloseAt
} = {}) {
  const now = Number(ts) || Date.now();
  const openAt = Number(lastOpenAt) || 0;
  const closeAt = Number(lastCloseAt) || 0;
  const nextClose = Number(nextCloseAt) || 0;
  const m = String(mode || '').trim().toLowerCase();

  if (enabled !== true) return { inWorkCycle: false, reason: 'daily_window_disabled' };
  if (m === 'always_on_24h') return { inWorkCycle: true, reason: 'always_on_24h' };
  if (m !== 'window_close_open') return { inWorkCycle: false, reason: 'daily_window_mode_off' };
  if (!(openAt > 0)) return { inWorkCycle: false, reason: 'never_opened' };
  if (closeAt > openAt) return { inWorkCycle: false, reason: 'closed_after_last_open' };
  if (!(nextClose > 0)) return { inWorkCycle: false, reason: 'no_next_close' };
  if (nextClose > openAt && now >= nextClose) return { inWorkCycle: false, reason: 'past_next_close' };
  if (now < openAt) return { inWorkCycle: false, reason: 'before_last_open' };
  return { inWorkCycle: true, reason: 'between_last_open_and_next_close' };
}

function decideAutoOpenAll({
  bootSource,
  allCellsDead,
  humanHoldActive,
  workCycle
} = {}) {
  if (allCellsDead !== true) return { yes: false, reason: 'cells_alive_adopt' };
  if (String(bootSource || '') !== 'porteiro') return { yes: false, reason: 'boot_source_not_porteiro' };
  if (humanHoldActive === true) return { yes: false, reason: 'human_hold' };
  if (!workCycle || workCycle.inWorkCycle !== true) {
    return { yes: false, reason: (workCycle && workCycle.reason) ? String(workCycle.reason) : 'not_work_cycle' };
  }
  return { yes: true, reason: 'porteiro_all_dead_work_cycle' };
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
  const serverConfig = require('./serverConfig.js');
  const cfg = serverConfig.readServerConfigEffective({});
  const dw = (cfg && cfg.dailyWindow) ? cfg.dailyWindow : {};
  const statePath = path.join(__dirname, '..', 'dados', 'daily_window_scheduler_state.json');
  let st = {};
  try { st = JSON.parse(String(fs.readFileSync(statePath, 'utf8') || '')) || {}; } catch { st = {}; }
  const lastOpenAt = Number(st.lastOpenAt || 0) || 0;
  const lastCloseAt = Number(st.lastCloseAt || 0) || 0;
  const nextCloseAt = Number(st.nextCloseAt || 0) || 0;
  const nextOpenAt = Number(st.nextOpenAt || 0) || 0;
  const core = decideWorkCycle({
    nowTs: ts,
    enabled: dw && dw.enabled === true,
    mode: dw && dw.executionMode,
    lastOpenAt,
    lastCloseAt,
    nextCloseAt
  });
  return {
    inWorkCycle: core.inWorkCycle === true,
    reason: core.reason,
    lastOpenAt,
    lastCloseAt,
    nextCloseAt,
    nextOpenAt
  };
}

async function maybePorterOpenAllOnBoot({ allCellsDead, port } = {}) {
  const work = getWorkCycleDecision(nowTs());
  const hold = readHumanHold();
  const bootSource = getBootSource();
  const decision = decideAutoOpenAll({
    bootSource,
    allCellsDead: allCellsDead === true,
    humanHoldActive: !!(hold && hold.active),
    workCycle: work
  });
  const snap = {
    bootSource: bootSource || null,
    allCellsDead: allCellsDead === true,
    humanHold: !!(hold && hold.active),
    holdReason: hold && hold.reason ? hold.reason : null,
    workReason: work && work.reason ? work.reason : null,
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
  getBootSource,
  readHumanHold,
  setHumanHold,
  clearHumanHold,
  isScheduledDailyWindowActor,
  decideWorkCycle,
  decideAutoOpenAll,
  getWorkCycleDecision,
  maybePorterOpenAllOnBoot
};
