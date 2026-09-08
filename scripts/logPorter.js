'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'dados', 'log_porter');
const JOBS = path.join(DIR, 'jobs');
const LOCK = path.join(DIR, 'porter.lock');
const SCRIPT = path.join(__dirname, 'logPorter.js');
const IDLE_MS = Math.max(80, Math.min(2000, parseInt(process.env.LOG_PORTER_IDLE_MS || '300', 10) || 300));
const MAX_JOB_ATTEMPTS = Math.max(1, Math.min(8, parseInt(process.env.LOG_PORTER_MAX_ATTEMPTS || '3', 10) || 3));

function isPidAlive(pid) {
  const n = Number(pid) || 0;
  if (n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  try {
    const raw = String(fs.readFileSync(LOCK, 'utf8') || '').trim();
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function writeLockExclusive(pid) {
  fs.mkdirSync(DIR, { recursive: true });
  const body = JSON.stringify({ pid: Number(pid) || 0, startedAt: Date.now(), role: 'guard' });
  fs.writeFileSync(LOCK, body, { flag: 'wx', encoding: 'utf8' });
}

function unlinkLockIfOurs(pid) {
  try {
    const cur = readLock();
    if (cur && Number(cur.pid) === Number(pid)) fs.unlinkSync(LOCK);
  } catch {}
}

function listJobs() {
  try {
    fs.mkdirSync(JOBS, { recursive: true });
    return fs.readdirSync(JOBS)
      .filter((n) => String(n || '').toLowerCase().endsWith('.json'))
      .map((name) => {
        const full = path.join(JOBS, name);
        let mtime = 0;
        try { mtime = Number(fs.statSync(full).mtimeMs || 0) || 0; } catch {}
        return { name, full, mtime };
      })
      .sort((a, b) => (a.mtime - b.mtime) || String(a.name).localeCompare(String(b.name)));
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function crashBackoffMs(failStreak) {
  const n = Math.max(1, Number(failStreak) || 1);
  return Math.min(15000, 250 * Math.pow(2, Math.min(6, n - 1)));
}

function childFailed(ev) {
  if (!ev) return true;
  if (ev.error) return true;
  if (ev.signal) return true;
  return Number(ev.code) !== 0;
}

function spawnDrainAndWait() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ev) => {
      if (settled) return;
      settled = true;
      resolve(ev);
    };
    let child;
    try {
      child = spawn(process.execPath, [SCRIPT, '--drain'], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          CONVENIENTE_SILENT_CONSOLE: '1',
          LOG_PORTER_ROLE: 'drain'
        })
      });
    } catch (error) {
      done({ code: -1, error });
      return;
    }
    child.once('error', (error) => done({ code: -1, error }));
    child.once('exit', (code, signal) => done({ code, signal }));
  });
}

function ensurePorter() {
  const lock = readLock();
  if (lock && isPidAlive(lock.pid)) {
    return { pid: Number(lock.pid) || 0, spawned: false };
  }
  if (lock && !isPidAlive(lock.pid)) {
    try { fs.unlinkSync(LOCK); } catch {}
  }
  const env = Object.assign({}, process.env, { CONVENIENTE_SILENT_CONSOLE: '1' });
  const child = spawn(process.execPath, [SCRIPT, '--guard'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: ROOT,
    env
  });
  try { child.unref(); } catch {}
  return { pid: Number(child.pid) || 0, spawned: true };
}

function enqueueLogJob(type, cmd) {
  const t = String(type || (cmd && cmd.type) || '').trim();
  if (t !== 'fetch_logs' && t !== 'fetch_logs_query') {
    return { ok: false, error: 'unsupported_type' };
  }
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object')
    ? cmd.payload
    : ((cmd && cmd.data && typeof cmd.data === 'object') ? cmd.data : {});
  const requestId = String(payload.requestId || '').trim();
  if (!requestId) return { ok: false, error: 'missing_requestId' };

  fs.mkdirSync(JOBS, { recursive: true });
  const id = String((cmd && cmd.id) || '').trim() || requestId;
  const stamp = Date.now();
  const seq = String(process.hrtime.bigint());
  const safe = String(id).replace(/[^\w.-]+/g, '_').slice(0, 80);
  const file = path.join(JOBS, `${stamp}_${seq}_${safe}.json`);
  const job = {
    type: t,
    id,
    requestId,
    payload,
    enqueuedAt: stamp,
    attempts: 0
  };
  fs.writeFileSync(file, JSON.stringify(job), 'utf8');
  const porter = ensurePorter();
  return {
    ok: true,
    accepted: true,
    queued: true,
    requestId,
    porterPid: porter.pid || null,
    spawned: !!porter.spawned
  };
}

function bumpJobAttempt(jobFile, job) {
  const next = Object.assign({}, job || {}, {
    attempts: (Number(job && job.attempts || 0) || 0) + 1,
    lastAttemptAt: Date.now()
  });
  try { fs.writeFileSync(jobFile.full, JSON.stringify(next), 'utf8'); } catch {}
  return next;
}

async function drainJobs() {
  fs.mkdirSync(JOBS, { recursive: true });
  const logFetchExec = require('./logFetchExec.js');
  for (;;) {
    const jobs = listJobs();
    if (!jobs.length) return;
    const jobFile = jobs[0];
    let job = null;
    try {
      job = JSON.parse(fs.readFileSync(jobFile.full, 'utf8'));
    } catch {
      try { fs.unlinkSync(jobFile.full); } catch {}
      continue;
    }
    job = bumpJobAttempt(jobFile, job);
    if ((Number(job.attempts) || 0) > MAX_JOB_ATTEMPTS) {
      try {
        await logFetchExec.postFailureIngest(job.requestId, 'porter_max_attempts');
      } catch {}
      try { fs.unlinkSync(jobFile.full); } catch {}
      continue;
    }
    const cmd = { id: job && job.id, type: job && job.type, payload: (job && job.payload) || {} };
    try {
      if (cmd.type === 'fetch_logs_query') await logFetchExec.execFetchLogsQuerySafe(cmd);
      else await logFetchExec.execFetchLogsSafe(cmd);
    } catch {}
    try { fs.unlinkSync(jobFile.full); } catch {}
  }
}

async function guardLoop() {
  fs.mkdirSync(JOBS, { recursive: true });
  try {
    writeLockExclusive(process.pid);
  } catch {
    process.exit(0);
    return;
  }
  let failStreak = 0;
  try {
    for (;;) {
      let jobs = listJobs();
      if (!jobs.length) {
        await sleep(IDLE_MS);
        jobs = listJobs();
        if (!jobs.length) {
          unlinkLockIfOurs(process.pid);
          jobs = listJobs();
          if (!jobs.length) break;
          try { writeLockExclusive(process.pid); } catch { break; }
          continue;
        }
      }
      const ev = await spawnDrainAndWait();
      const failed = childFailed(ev);
      const stillQueued = listJobs().length > 0;
      if (failed) {
        failStreak += 1;
        await sleep(crashBackoffMs(failStreak));
        continue;
      }
      failStreak = 0;
      if (stillQueued) continue;
    }
  } finally {
    unlinkLockIfOurs(process.pid);
  }
}

if (require.main === module) {
  const isDrain = process.argv.includes('--drain') || String(process.env.LOG_PORTER_ROLE || '').trim() === 'drain';
  const run = isDrain ? drainJobs() : guardLoop();
  run
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { enqueueLogJob, ensurePorter, isPidAlive };
