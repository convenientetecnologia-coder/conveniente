const fs = require('fs');
const path = require('path');

const JOBS_PATH     = path.join(__dirname, '..', 'dados', 'jobs.json');
const BACKLOG_PATH  = path.join(__dirname, '..', 'dados', 'backlog.json');
const MAX_JOBS      = 10000; // Retenção de histórico

// States: pending, running, succeeded, failed, canceled, timeout
const VALID_STATUS = new Set(['pending','running','succeeded','failed','timeout','canceled']);

let jobs = [];
let backlog = [];
let initialized = false;
let workers = [];

function _readJson(file, fb){ try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }
function _writeJson(file, obj){ try {
  const dir = path.dirname(file); if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const tmp = file+'.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj,null,2), 'utf8');
  try{ fs.unlinkSync(file);}catch{}
  try{ fs.renameSync(tmp,file);} catch{ fs.copyFileSync(tmp,file); try{fs.unlinkSync(tmp);}catch{}}
  return true;
} catch { return false; }}

function _persistJobs() {
  const toSave = jobs.slice(-MAX_JOBS);
  _writeJson(JOBS_PATH, toSave);
}

function _persistBacklog() {
  const bl = backlog.filter(j=>j.status === 'pending' || j.status === 'running');
  _writeJson(BACKLOG_PATH, bl);
}

function _newId(){
  return 'jm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);
}

function init(workerClient) {
  if (initialized) return;
  jobs = _readJson(JOBS_PATH, []);
  backlog = _readJson(BACKLOG_PATH, []);
  initialized = true;

  // Recebe job events diretos se for plugado depois
  if (workerClient && typeof workerClient.setJobManager === 'function')
    workerClient.setJobManager(module.exports);
}

function createJob({ type, perfil, source, payload={} }) {
  const job = {
    id: _newId(),
    type, perfil, source: source || 'unknown',
    status: 'pending',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    reason: null,
    wait: null,
    outcome: {},
    history: [],
    payload
  };
  jobs.push(job);
  backlog.push(job);
  _persistJobs(); _persistBacklog();
  return job;
}

// Receber evento do worker (emitJobEvent)
function onWorkerEvent(ev) {
  if (!ev || !ev.kind) return;
  // Tenta matear job por jobId (se possuir);
  let job = null;
  if (ev.job) job = jobs.find(j=>j.id===ev.job);
  // Fallback: tente last job por perfil/tipo/status pendente
  if (!job && ev.perfil && ev.kind && String(ev.kind).endsWith('.start')) {
    const keyType = String(ev.kind).replace('.start','');
    job = jobs.filter(j=>j.perfil===ev.perfil && j.type && (j.type.indexOf(keyType)!==-1) && j.status==='pending').slice(-1)[0];
  }
  if (!job) return;

  // Histórico e atualização por tipo de evento
  const now = Date.now();
  job.history.push({ ts: now, ...ev });
  if (ev.kind.endsWith('.start')) {
    job.status = 'running';
    job.startedAt = now;
  } else if (ev.kind.endsWith('.end')) {
    job.status = ev.ok ? 'succeeded' : (ev.error ? 'failed' : 'failed');
    job.finishedAt = now;
    job.reason = ev.error || ev.reason || null;
    job.outcome = { ...ev };
    if (ev.durMs) job.durMs = ev.durMs;
  } else if (ev.kind==='report') {
    job.history.push({ ts:now, type:'report', message:ev.message });
    // Não muda status.
  } else if (ev.kind==='kill.end'||ev.kind==='freeze.end'||ev.kind==='unfreeze.end'||ev.kind==='health.escalate.end') {
    job.status = 'succeeded';
    job.finishedAt = now;
  }

  // Atualiza backlog
  if (job.status==='succeeded'||job.status==='failed'||job.status==='timeout'||job.status==='canceled'){
    backlog = backlog.filter(j=>j.id!==job.id);
  }

  _persistJobs(); _persistBacklog();
}

function getJobs(filter={}) {
  let out = jobs.slice(-MAX_JOBS);
  if (filter.status) out = out.filter(j=>j.status===filter.status);
  if (filter.perfil) out = out.filter(j=>j.perfil===filter.perfil);
  if (filter.type) out = out.filter(j=>j.type===filter.type);
  if (filter.limit) out = out.slice(-filter.limit);
  return out.reverse();
}

function getJob(id) {
  return jobs.find(j=>j.id===id) || null;
}

function getBacklog() {
  return backlog;
}

function cancelJob(id, reason='manual_cancel') {
  const job = getJob(id);
  if (!job) return false;
  if (job.status==='pending'||job.status==='running') {
    job.status = 'canceled'; job.reason = reason; job.finishedAt = Date.now();
    job.history.push({ ts: Date.now(), kind: 'cancel', reason });
    // Opcional: emitir evento de cancelamento para worker se aplicável
    _persistJobs(); _persistBacklog();
    return true;
  }
  return false;
}

module.exports = {
  init,
  createJob,
  onWorkerEvent,
  getJobs,
  getJob,
  getBacklog,
  cancelJob
};