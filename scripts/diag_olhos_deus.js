/**
 * Olhos de Deus — relatório forense estruturado (Fase 6).
 *
 * CLI (opcional):
 *   node scripts/diag_olhos_deus.js [windowMin]
 *
 * HTTP (preferido):
 *   Edge: GET  /api/infra/forensic/olhos-deus?windowMin=60&nome=
 *   Edge: command-bus type=olhos_deus
 *   CT:   POST /api/forensic/olhos-deus_secret { hostId, windowMin, nome }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DADOS = path.join(ROOT, 'dados');
const OUT = path.join(DADOS, 'DIAG_OLHOS_DEUS_latest.txt');
const AUDIT = path.join(DADOS, 'provision_audit.jsonl');
const GOV = path.join(DADOS, 'governor_snapshots.jsonl');
const DESIRED = path.join(DADOS, 'desired.json');
const STATUS = path.join(DADOS, 'status.json');
const BOOT_LOCK = path.join(DADOS, '_delta_host_boot.leader.lock');
const PUMP_LOCK = path.join(DADOS, 'mensagens_pendentes.pump.lock');
const PUMP_KICK = path.join(DADOS, 'mensagens_pendentes.pump.kick');
const NURSE_KICK = path.join(DADOS, 'desired.nurse.kick');
const QUEUE = path.join(DADOS, 'mensagens_pendentes.jsonl');
const CURSOR = path.join(DADOS, 'mensagens_pendentes.cursor.json');
const HOSTID_PATH = path.join(DADOS, '.telemetry_hostid');

const WATCH_EVENTS = [
  'nurse_wake_tick', 'nurse_open_attempt', 'nurse_open_denied',
  'dom_health_idle_skip', 'phantom_probe_skip_delta', 'block_detect_skip_delta',
  'wire_health_listeners_skip_delta', 'delta_ear_skip_non_main',
  'robe_global_tick_skip_delta', 'robe_global_tick_allow_delta',
  'robe_arm_scheduled', 'robe_arm_fire', 'robe_auto_enqueued', 'robe_fallback_light_tick',
  'dbg_worker_robe_play_handler_entry', 'dbg_worker_robe_play_enqueued',
  'dbg_worker_robe_play_startrobe_call', 'dbg_startRobeDynamic_entry',
  'dbg_startRobeDynamic_module_return', 'dbg_startRobeDynamic_catch',
  'invoke_human_set', 'invoke_human_overlay_ok', 'invoke_human_overlay_err',
  'lazy_load_delta_hands', 'lazy_load_legacy_virtus', 'lazy_load_reload_manager',
  'health_tick_unscheduled_delta', 'delta_health_bypass_healthTick',
  'delta_robe_block', 'robe_login_required_detected',
  'delta_queue_boot_pruned', 'ingest_pump_leader_acquired'
];

function readJsonSafe(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return String(fs.readFileSync(p, 'utf8') || '').trim();
  } catch {
    return '';
  }
}

function fileInfo(p) {
  try {
    if (!fs.existsSync(p)) return { exists: false };
    const st = fs.statSync(p);
    return { exists: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  } catch (e) {
    return { exists: false, error: String(e && e.message || e) };
  }
}

function tailJsonl(p, maxLines = 8000) {
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try {
    const st = fs.statSync(p);
    const maxBytes = 8 * 1024 * 1024;
    if (st.size <= maxBytes) {
      raw = fs.readFileSync(p, 'utf8');
    } else {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, Math.max(0, st.size - maxBytes));
      fs.closeSync(fd);
      raw = buf.toString('utf8');
      const cut = raw.indexOf('\n');
      if (cut >= 0) raw = raw.slice(cut + 1);
    }
  } catch {
    return [];
  }
  const lines = String(raw || '').split(/\r?\n/).filter(Boolean);
  const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function countBy(events, keyFn) {
  const m = Object.create(null);
  for (const e of events) {
    const k = keyFn(e);
    if (!k) continue;
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function pickRecent(events, names, limit = 20) {
  const set = new Set(names);
  const hit = [];
  for (let i = events.length - 1; i >= 0 && hit.length < limit; i--) {
    const e = events[i];
    const ev = String(e && e.event || '');
    if (set.has(ev)) hit.push(e);
  }
  return hit.reverse();
}

function filterNome(events, nome) {
  const n = String(nome || '').trim();
  if (!n) return events;
  return events.filter((e) => {
    const a = String(e && (e.nome || e.account || e.account_login || '') || '');
    return !a || a === n;
  });
}

function fmtTs(ts) {
  const n = Number(ts || 0) || 0;
  if (!n) return null;
  try { return new Date(n).toISOString(); } catch { return String(n); }
}

/**
 * @param {{ windowMin?: number, nome?: string, writeTxt?: boolean }} opts
 */
function buildOlhosDeusReport(opts = {}) {
  const windowMin = Math.max(5, Math.min(24 * 60, Number(opts.windowMin || 60) || 60));
  const nome = String(opts.nome || '').trim();
  const since = Date.now() - windowMin * 60 * 1000;
  const hostId = readTextSafe(HOSTID_PATH) || null;

  const desired = readJsonSafe(DESIRED, {}) || {};
  const engine =
    (desired._autoMode && desired._autoMode.engine) ||
    (desired.autoMode && desired.autoMode.engine) ||
    desired.engine ||
    '(default→delta)';
  const perfis = (desired.perfis && typeof desired.perfis === 'object') ? desired.perfis : {};
  const activeNames = Object.keys(perfis).filter((n) => perfis[n] && perfis[n].active === true);

  const locks = {};
  for (const [label, p] of [
    ['boot_leader', BOOT_LOCK],
    ['pump_leader', PUMP_LOCK],
    ['pump_kick', PUMP_KICK],
    ['nurse_kick', NURSE_KICK]
  ]) {
    const info = fileInfo(p);
    const j = info.exists ? readJsonSafe(p, null) : null;
    locks[label] = {
      ...info,
      json: j && typeof j === 'object' ? {
        phase: j.phase || null,
        pid: j.pid || null,
        ts: j.ts || null,
        reason: j.reason || null,
        leader: j.leader || null,
        shard: j.shard || null
      } : null
    };
  }

  const queueInfo = fileInfo(QUEUE);
  const cursor = readJsonSafe(CURSOR, {});
  const auditAll = tailJsonl(AUDIT);
  let audit = auditAll.filter((e) => Number(e && e.ts || 0) >= since);
  if (nome) audit = filterNome(audit, nome);
  const countsAll = countBy(audit, (e) => String(e && e.event || ''));
  const countsWatch = {};
  for (const ev of WATCH_EVENTS) {
    if (countsAll[ev]) countsWatch[ev] = countsAll[ev];
  }
  const recent = pickRecent(audit, WATCH_EVENTS, 25).map((e) => ({
    ts: fmtTs(e.ts),
    event: e.event,
    nome: e.nome || e.account || e.account_login || null,
    reason: e.reason || null,
    source: e.source || null,
    ok: (e.ok !== undefined) ? e.ok : null,
    error: e.error || null
  }));

  const gov = tailJsonl(GOV, 80).filter((e) => Number(e && e.ts || 0) >= since);
  const govLast = gov.length ? gov[gov.length - 1] : null;

  const verdicts = [];
  const push = (level, msg) => verdicts.push({ level, msg });
  const engNorm = String(engine || '').toLowerCase();
  if (engNorm.includes('delta') || engNorm.includes('default')) push('OK', `engine delta (${engine})`);
  else push('WARN', `engine não-delta: ${engine}`);

  if (countsWatch.robe_global_tick_skip_delta) push('OK', 'robe tick skip Delta (4a)');
  if (countsWatch.robe_global_tick_allow_delta) push('WARN', 'robe tick ALLOW (poll ligado?)');
  if (!countsWatch.robe_global_tick_skip_delta && !countsWatch.robe_global_tick_allow_delta) {
    push('WARN', 'sem robe_global_tick_* na janela');
  }

  if (countsWatch.robe_auto_enqueued && !countsWatch.dbg_worker_robe_play_handler_entry && !countsWatch.robe_arm_fire) {
    push('WARN', `robe_auto_enqueued=${countsWatch.robe_auto_enqueued} sem play/arm`);
  }
  if (countsWatch.dbg_worker_robe_play_handler_entry || countsWatch.dbg_startRobeDynamic_entry) {
    push('OK', 'robe-play / startRobe na janela');
  }
  if (countsWatch.dbg_startRobeDynamic_catch) push('FAIL', 'startRobeDynamic catch na janela');
  if (countsWatch.invoke_human_set || countsWatch.invoke_human_overlay_ok) push('OK', 'invoke_human na janela');
  if (countsWatch.invoke_human_overlay_err) push('FAIL', `invoke_human overlay err x${countsWatch.invoke_human_overlay_err}`);
  if (countsWatch.lazy_load_delta_hands || countsWatch.lazy_load_legacy_virtus) {
    push('OK', 'lazy-load na janela (esperado pós activate/play)');
  }

  const boot = locks.boot_leader && locks.boot_leader.json;
  if (boot && String(boot.phase || '') === 'done') push('OK', `boot leader phase=done pid=${boot.pid}`);
  else if (boot && String(boot.phase || '') === 'running') push('FAIL', 'boot leader phase=running');
  else push('WARN', 'boot lock ausente/ilegível');

  const pump = locks.pump_leader && locks.pump_leader.json;
  if (pump && pump.pid) push('OK', `pump leader pid=${pump.pid}`);
  else push('WARN', 'pump lock ausente');

  if (countsWatch.nurse_wake_tick) push('OK', `nurse_wake_tick x${countsWatch.nurse_wake_tick}`);
  if (countsWatch.nurse_open_attempt) push('OK', `nurse_open_attempt x${countsWatch.nurse_open_attempt}`);
  if (countsWatch.nurse_open_denied) push('WARN', `nurse_open_denied x${countsWatch.nurse_open_denied}`);
  if (countsWatch.wire_health_listeners_skip_delta) push('OK', 'wire health skip Delta');
  if (countsWatch.dom_health_idle_skip) push('OK', 'dom idle skip');

  const failN = verdicts.filter((v) => v.level === 'FAIL').length;
  const warnN = verdicts.filter((v) => v.level === 'WARN').length;
  const summary = failN ? 'FAIL' : (warnN ? 'WARN' : 'OK');

  const report = {
    ok: true,
    kind: 'olhos_deus',
    summary,
    collectedAt: Date.now(),
    collectedAtIso: new Date().toISOString(),
    hostId,
    hostname: os.hostname(),
    pid: process.pid,
    windowMin,
    nomeFilter: nome || null,
    desired: {
      engine,
      activeCount: activeNames.length,
      activeNames: activeNames.slice(0, 40),
      openAll: !!(desired._openAll && desired._openAll.active),
      autoOpen: !!(desired._autoOpen && desired._autoOpen.enabled)
    },
    locks,
    ingest: {
      queue: queueInfo,
      cursor
    },
    audit: {
      path: AUDIT,
      tailLinesRead: auditAll.length,
      inWindow: audit.length,
      countsWatch,
      topOther: Object.keys(countsAll)
        .filter((k) => !WATCH_EVENTS.includes(k))
        .sort((a, b) => countsAll[b] - countsAll[a])
        .slice(0, 12)
        .map((k) => ({ event: k, n: countsAll[k] })),
      recent
    },
    governorLast: govLast ? {
      ts: fmtTs(govLast.ts),
      rssMB: govLast.rssMB,
      heapUsedMB: govLast.heapUsedMB,
      freeMB: govLast.freeMB,
      lagMeanMs: govLast.lagMeanMs,
      lagMaxMs: govLast.lagMaxMs,
      controllers: govLast.controllers,
      mode: govLast.mode
    } : null,
    statusExists: fs.existsSync(STATUS),
    verdicts
  };

  if (opts.writeTxt !== false) {
    try {
      if (!fs.existsSync(DADOS)) fs.mkdirSync(DADOS, { recursive: true });
      const txt = [
        `=== OLHOS DE DEUS ===`,
        `summary=${summary} hostId=${hostId || '-'} windowMin=${windowMin} nome=${nome || '-'}`,
        `collectedAt=${report.collectedAtIso}`,
        '',
        ...verdicts.map((v) => `${v.level.padEnd(4)}| ${v.msg}`),
        '',
        `engine=${engine} active=${activeNames.length}`,
        `counts=${JSON.stringify(countsWatch)}`,
        `recent=${JSON.stringify(recent.slice(-8))}`,
        `governor=${JSON.stringify(report.governorLast)}`,
        ''
      ].join('\n');
      fs.writeFileSync(OUT, txt, 'utf8');
      report.txtPath = OUT;
    } catch (e) {
      report.txtError = String(e && e.message || e);
    }
  }

  return report;
}

function renderText(report) {
  const lines = [];
  lines.push('=== OLHOS DE DEUS — DIAG FASE 6 ===');
  lines.push(`summary: ${report.summary}`);
  lines.push(`gerado: ${report.collectedAtIso}`);
  lines.push(`hostId: ${report.hostId || '-'}`);
  lines.push(`hostname: ${report.hostname}`);
  lines.push(`janela: ${report.windowMin} min`);
  if (report.nomeFilter) lines.push(`nome: ${report.nomeFilter}`);
  lines.push('');
  lines.push('## VEREDITO');
  for (const v of (report.verdicts || [])) lines.push(`${v.level.padEnd(4)}| ${v.msg}`);
  lines.push('');
  lines.push(`## DESIRED engine=${report.desired.engine} active=${report.desired.activeCount}`);
  lines.push(`## AUDIT counts ${JSON.stringify(report.audit.countsWatch)}`);
  lines.push(`## GOVERNOR ${JSON.stringify(report.governorLast)}`);
  return lines.join('\n');
}

module.exports = {
  buildOlhosDeusReport,
  renderText,
  WATCH_EVENTS,
  OUT
};

if (require.main === module) {
  const windowMin = Number(process.argv[2] || 60) || 60;
  const report = buildOlhosDeusReport({ windowMin, writeTxt: true });
  console.log(renderText(report));
  console.log(`\n[salvo] ${OUT}`);
  console.log(`[summary] ${report.summary}`);
}
