// scripts/worker.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { monitorEventLoopDelay } = require('perf_hooks');
const logger = require('./logger.js');
const { detectLimitOverlayDeep, detectLimitOverlayEverywhere } = require('./browser.js');

const browserHelper = require('./browser.js');
const virtusHelper = require('./virtus.js');
const robeHelper   = require('./robe.js');
const robeQueue    = require('./robeQueue.js');
const utils        = require('./utils.js');
const fotos        = require('./fotos.js');
const reloadManager = require('./reloadManager.js');

const issues = require('./issues.js');
const manifestStore = require('./manifestStore.js');
const fileStore = require('./fileStore.js');
const gatewayProxy = require('./gatewayProxy.js');
const gptFallback = require('./gptFallback.js');
const provisionAudit = require('./provisionAudit.js');
const { readCtConfig } = require('./ctConfig.js');
const serverConfig = require('./serverConfig.js');

// =========================
// BUILD/BOOT EVIDENCE (ultra enterprise)
// =========================
// Objetivo: prova irrefutável de que o worker carregou o código novo (e com quais envs).
const WORKER_BUILD_TAG = '2026-01-27_provision_3tabs_v1';
try {
  provisionAudit.append({
    ts: Date.now(),
    event: 'worker_boot',
    buildTag: WORKER_BUILD_TAG,
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    humanOverlayEnv: String(process.env.HUMAN_OVERLAY || '').trim(),
    portEnv: String(process.env.PORT || '').trim(),
    shardEnv: String(process.env.SHARD || process.env.SHARDS || '').trim(),
    ctBaseUrlConfigured: (() => { try { const c = readCtConfig(); return !!(c && c.ctBaseUrl); } catch { return false; } })(),
    logIngestSecretConfigured: (() => { try { const c = readCtConfig(); return !!(c && c.logIngestSecret); } catch { return false; } })()
  });
} catch {}

// ===== AUTO-OPEN BOOT RESET (sempre OFF no boot) =====
// Regra operacional: ao iniciar o worker, "Tudo aberto" deve ficar desligado
// para evitar auto-abertura após restart.
try {
  fileStore.withDesiredFileLockUpdate((d) => {
    d = d || {};
    d._autoOpen = d._autoOpen || {};
    d._autoOpen.enabled = false;
    d._autoOpen.changedAt = Date.now();
    d._autoOpen.changedBy = 'boot_reset';
    return d;
  });
  try { provisionAudit.append({ ts: Date.now(), event: 'auto_open_boot_reset', enabled: false }); } catch {}
} catch {}

const DATA_DIR = path.join(__dirname, '..', 'dados');
const DIAG_DIR = path.join(DATA_DIR, 'diag');
const LR_EVENTS_JSONL = path.join(DATA_DIR, 'login_required_events.jsonl');
const LR_EVIDENCE_JSONL = path.join(DATA_DIR, 'login_remediate_evidence.jsonl');
const HOSTID_PATH = path.join(DATA_DIR, '.telemetry_hostid');
const CT_ARCHIVE_QUEUE_DIR = path.join(DATA_DIR, 'ct_archive_queue');
const CT_ARCHIVE_QUEUE_PENDING_DIR = path.join(CT_ARCHIVE_QUEUE_DIR, 'pending');
const CT_ARCHIVE_QUEUE_DONE_DIR = path.join(CT_ARCHIVE_QUEUE_DIR, 'done');
const CT_ARCHIVE_EVID_DIR = path.join(CT_ARCHIVE_QUEUE_DIR, 'evidence');
const GOV_SNAP_JSONL = path.join(DATA_DIR, 'governor_snapshots.jsonl');
const GOV_SNAP_LEADER_LOCK = path.join(DATA_DIR, '_governor_snapshot_leader.lock');
// P0 hardening (INC-20260207-1403-01):
// Garantia "volta a trabalhar" pós stock_provision em ambiente com shards.
// A causa observada foi "volta parcial" quando alguns workers/shards não retomam.
// Estratégia enterprise:
// - Detectar transição de provision_lock (stock_provision) ativo -> inativo
// - Persistir marcador global (no disco) do fim do provisionamento
// - Cada worker/shard executa um resume sweep para seus perfis, respeitando guardrails (flags/login/humano/config)
const STOCK_PROVISION_LAST_END_MARKER = path.join(DATA_DIR, 'stock_provision_last_end.json');

function ensureDirSync(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function safeFilePart(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 60) || 'x';
}
function appendJsonl(fp, obj) {
  try {
    ensureDirSync(path.dirname(fp));
    fs.appendFileSync(fp, JSON.stringify(obj) + '\n', 'utf8');
  } catch {}
}

function _readJsonSafe(fp, fallback = null) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fallback; }
}

function _tryBecomeGovSnapshotLeader() {
  const now = Date.now();
  const ttlMs = Math.max(30_000, parseInt(process.env.CT_GOV_SNAPSHOT_LEADER_TTL_MS || String(2 * 60 * 1000), 10) || (2 * 60 * 1000));
  try {
    ensureDirSync(path.dirname(GOV_SNAP_LEADER_LOCK));
    if (fs.existsSync(GOV_SNAP_LEADER_LOCK)) {
      try {
        const st = fs.statSync(GOV_SNAP_LEADER_LOCK);
        const ageMs = now - Number(st.mtimeMs || 0);
        if (ageMs > ttlMs) {
          // stale leader: tentar tomar posse
          try { fs.unlinkSync(GOV_SNAP_LEADER_LOCK); } catch {}
        } else {
          return false;
        }
      } catch {
        // se não der pra stat, tenta tomar posse
        try { fs.unlinkSync(GOV_SNAP_LEADER_LOCK); } catch {}
      }
    }
    const fd = fs.openSync(GOV_SNAP_LEADER_LOCK, 'wx');
    try {
      const hostId = readHostIdSync();
      const obj = { ts: now, hostId: hostId || null, pid: process.pid, leader: true };
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

function _isGovSnapshotLeader() {
  try {
    if (!fs.existsSync(GOV_SNAP_LEADER_LOCK)) return false;
    const st = fs.statSync(GOV_SNAP_LEADER_LOCK);
    const ttlMs = Math.max(30_000, parseInt(process.env.CT_GOV_SNAPSHOT_LEADER_TTL_MS || String(2 * 60 * 1000), 10) || (2 * 60 * 1000));
    const ageMs = Date.now() - Number(st.mtimeMs || 0);
    if (ageMs > ttlMs) return false;
    const j = _readJsonSafe(GOV_SNAP_LEADER_LOCK, null);
    if (!j || j.pid !== process.pid) return false;
    return true;
  } catch {
    return false;
  }
}

function _touchGovSnapshotLeader() {
  try {
    if (!_isGovSnapshotLeader()) return false;
    const now = Date.now();
    const hostId = readHostIdSync();
    const obj = { ts: now, hostId: hostId || null, pid: process.pid, leader: true };
    fs.writeFileSync(GOV_SNAP_LEADER_LOCK, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function writeStockProvisionEndMarker({ owner = null, kind = null, untilMs = 0 } = {}) {
  try {
    ensureDirSync(path.dirname(STOCK_PROVISION_LAST_END_MARKER));
    const obj = {
      ts: Date.now(),
      owner: owner ? String(owner).slice(0, 220) : null,
      kind: kind ? String(kind).slice(0, 60) : null,
      untilMs: Number(untilMs || 0) || 0,
      pid: process.pid
    };
    fs.writeFileSync(STOCK_PROVISION_LAST_END_MARKER, JSON.stringify(obj, null, 2), 'utf8');
    return { ok: true, marker: obj };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function newFlowId(prefix = 'flow') {
  try { return `${String(prefix)}_${Date.now()}_${crypto.randomUUID()}`; } catch {}
  try { return `${String(prefix)}_${Date.now()}_${crypto.randomBytes(12).toString('hex')}`; } catch {}
  return `${String(prefix)}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function writeJsonAtomicSimple(fp, obj) {
  try {
    ensureDirSync(path.dirname(fp));
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.renameSync(tmp, fp); } catch { fs.copyFileSync(tmp, fp); try { fs.unlinkSync(tmp); } catch {} }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function saveCtEvidenceJpeg({ stockAccountId = null, profileName = '', flowId = '', jpegBuf = null, url = '', reason = '' } = {}) {
  try {
    const sid = Number(stockAccountId || 0) || 0;
    const key = sid ? `id_${sid}` : `profile_${safeFilePart(profileName)}`;
    const dir = path.join(CT_ARCHIVE_EVID_DIR, key);
    ensureDirSync(dir);
    const fn = `${safeFilePart(flowId || newFlowId('ban'))}.jpg`;
    const abs = path.join(dir, fn);
    if (jpegBuf && jpegBuf.length) fs.writeFileSync(abs, jpegBuf);
    const meta = { ts: Date.now(), stockAccountId: sid || null, profileName: String(profileName||''), flowId: String(flowId||''), url: String(url||'').slice(0, 600), reason: String(reason||'').slice(0, 160), bytes: jpegBuf ? jpegBuf.length : 0 };
    try { fs.writeFileSync(abs + '.meta.json', JSON.stringify(meta, null, 2), 'utf8'); } catch {}
    return { ok: true, path: abs, meta };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function queueCtArchive({ stockAccountId = null, profileName = '', reason = '', evidencePath = '', evidenceUrl = '', flowId = '' } = {}) {
  try {
    ensureDirSync(CT_ARCHIVE_QUEUE_PENDING_DIR);
    ensureDirSync(CT_ARCHIVE_QUEUE_DONE_DIR);
    const sid = Number(stockAccountId || 0) || 0;
    const idPart = sid ? `id_${sid}` : `profile_${safeFilePart(profileName)}`;
    const fn = `${Date.now()}_${safeFilePart(flowId || newFlowId('ctq'))}_${idPart}.json`;
    const fp = path.join(CT_ARCHIVE_QUEUE_PENDING_DIR, fn);
    const obj = {
      createdAt: Date.now(),
      nextAttemptAt: 0,
      attempts: 0,
      stockAccountId: sid || null,
      profileName: String(profileName || ''),
      reason: String(reason || '').slice(0, 160),
      evidencePath: String(evidencePath || ''),
      evidenceUrl: String(evidenceUrl || '').slice(0, 800),
      flowId: String(flowId || '')
    };
    const w = writeJsonAtomicSimple(fp, obj);
    return { ok: !!w.ok, file: fp, queued: true, error: w.ok ? null : w.error };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function processCtArchiveQueue({ limit = 3 } = {}) {
  const now = Date.now();
  try { ensureDirSync(CT_ARCHIVE_QUEUE_PENDING_DIR); ensureDirSync(CT_ARCHIVE_QUEUE_DONE_DIR); } catch {}
  let files = [];
  try { files = fs.readdirSync(CT_ARCHIVE_QUEUE_PENDING_DIR).filter(f => f && f.endsWith('.json')).slice(0, 1000); } catch { files = []; }
  let processed = 0;
  for (const f of files) {
    if (processed >= limit) break;
    const fp = path.join(CT_ARCHIVE_QUEUE_PENDING_DIR, f);
    let job = null;
    try { job = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { job = null; }
    if (!job || typeof job !== 'object') continue;
    const nextAt = Number(job.nextAttemptAt || 0) || 0;
    if (nextAt && nextAt > now) continue;
    const sid = Number(job.stockAccountId || 0) || 0;
    const profileName = String(job.profileName || '').trim();
    const reason = String(job.reason || 'banned_detected').trim();
    const evidPath = String(job.evidencePath || '').trim();
    const evidUrl = String(job.evidenceUrl || '').trim();
    const flowId = String(job.flowId || '').trim();

    let b64 = '';
    if (evidPath && fs.existsSync(evidPath)) {
      try { b64 = fs.readFileSync(evidPath).toString('base64'); } catch { b64 = ''; }
    }
    try {
      provisionAudit.append({ ts: Date.now(), event: 'ct_archive_retry_begin', flowId: flowId || null, profileName, stockAccountId: sid || null, attempts: Number(job.attempts || 0) || 0 });
    } catch {}

    const rr = await archiveBanWithEvidenceToCT({ profileName, stockAccountId: sid || null, reason, evidenceB64: b64, evidenceUrl: evidUrl }).catch(e => ({ ok:false, error: (e && e.message) || String(e) }));
    const ok = !!(rr && rr.ok);
    const errStr = ok ? '' : String(rr && rr.error || 'error');
    try {
      provisionAudit.append({ ts: Date.now(), event: 'ct_archive_retry_done', flowId: flowId || null, profileName, stockAccountId: sid || null, ok, error: ok ? null : String(rr && rr.error || 'error').slice(0, 220) });
    } catch {}
    if (ok) {
      processed++;
      try {
        const doneFp = path.join(CT_ARCHIVE_QUEUE_DONE_DIR, f);
        try { fs.renameSync(fp, doneFp); } catch { try { fs.copyFileSync(fp, doneFp); } catch {} try { fs.unlinkSync(fp); } catch {} }
      } catch {}
      // Limpeza best-effort de evidence
      try { if (evidPath && fs.existsSync(evidPath)) fs.unlinkSync(evidPath); } catch {}
      try { if (evidPath && fs.existsSync(evidPath + '.meta.json')) fs.unlinkSync(evidPath + '.meta.json'); } catch {}
      continue;
    }

    // Enterprise: se o CT responder "not_found_assigned", não podemos ficar em loop infinito
    // segurando um perfil desabilitado/2FA dentro do servidor (risco de duplicidade em múltiplos hosts).
    // Regra pedida: se não há controller e desired.active==false, remover o perfil local imediatamente.
    try {
      if (String(errStr || '').includes('not_found_assigned')) {
        const nome = profileName;
        const hasCtrl = controllers.has(nome);
        const isActive = (() => { try { return fileStore.isPerfilAtivo(nome); } catch { return false; } })();
        if (!hasCtrl && !isActive && nome) {
          try {
            provisionAudit.append({ ts: Date.now(), event: 'ct_archive_not_found_proceed_delete_local', flowId: flowId || null, profileName: String(nome||''), stockAccountId: sid || null });
          } catch {}
          // Remoção local best-effort (mesma lógica do banflow)
          try {
            // CRÍTICO (cluster): NÃO usar loadPerfisJson()/savePerfisJson do worker (shard) para gravar perfis.json,
            // senão um shard pode sobrescrever o arquivo global com um subconjunto (ou []) e "sumir tudo".
            let udir = '';
            try {
              const man = await manifestStore.read(nome).catch(() => null);
              if (man && man.userDataDir) udir = String(man.userDataDir);
            } catch {}
            if (!udir) {
              try {
                const all = fileStore.loadPerfisJson() || [];
                const perfil = Array.isArray(all) ? all.find(p => p && p.nome === nome) : null;
                if (perfil && perfil.userDataDir) udir = String(perfil.userDataDir);
              } catch {}
            }
            if (udir && fs.existsSync(udir)) { try { fileStore.rimrafSync(udir); } catch {} }
            try {
              fileStore.withPerfisFileLockUpdate(
                (arr) => (Array.isArray(arr) ? arr : []).filter(p => p && p.nome !== nome),
                { caller: 'ct_archive_not_found_delete_local', nome }
              );
            } catch {}
          } catch {}
          try { await fileStore.removeDesired(nome); } catch {}
          try { fileStore.rimrafSync(path.join(fileStore.perfisDir, nome)); } catch {}
          try {
            const st = fileStore.readJsonSafe(fileStore.statusPath, null);
            if (st && Array.isArray(st.perfis)) {
              st.perfis = st.perfis.filter(p => p && p.nome !== nome);
              fileStore.writeJsonAtomic(fileStore.statusPath, st);
            }
          } catch {}
          try { await snapshotStatusAndWrite(); } catch {}
          try {
            provisionAudit.append({ ts: Date.now(), event: 'ct_archive_not_found_deleted_local', flowId: flowId || null, profileName: String(nome||''), ok: true });
          } catch {}
        }
      }
    } catch {}

    // Reagendar com backoff
    try {
      const attempts = (Number(job.attempts || 0) || 0) + 1;
      const backoffMs = Math.min(30 * 60 * 1000, Math.max(60_000, attempts * 60_000)); // 1m, 2m, 3m..., max 30m
      job.attempts = attempts;
      job.lastError = String(rr && rr.error || 'error').slice(0, 220);
      job.lastAttemptAt = Date.now();
      job.nextAttemptAt = Date.now() + backoffMs;
      writeJsonAtomicSimple(fp, job);
      processed++;
    } catch {}
  }
  return { ok: true, processed };
}

async function appendLoginRemediateEvidence({ nome, operator, step, page, note } = {}) {
  try {
    if (!nome || !page) return;
    const url = (() => { try { return page.url ? String(page.url() || '') : ''; } catch { return ''; } })();
    const title = await page.title().catch(()=> '');
    const lr = await browserHelper.detectLoginRequired(page).catch(()=>({ loginRequired:false }));
    const html = await page.content().catch(()=> '');
    const htmlSnippet = String(html || '').slice(0, 4000);
    const screenshotBase64 = await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false, encoding: 'base64' }).catch(()=> '');
    appendJsonl(LR_EVIDENCE_JSONL, {
      ts: Date.now(),
      perfil: String(nome),
      operator: String(operator || ''),
      step: String(step || ''),
      note: note ? String(note).slice(0, 300) : null,
      url,
      title,
      lr,
      htmlSnippet,
      screenshotBase64: screenshotBase64 ? String(screenshotBase64).slice(0, 220000) : '' // hard cap
    });
  } catch {}
}
async function captureLoginRequiredEvidence(nome, page, lr) {
  try {
    if (!nome || !page) return;
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    const last = Number(robeMeta[nome].lastLREvidenceAt || 0) || 0;
    // Rate limit: no máximo 1 evidência a cada 30 minutos por perfil
    if (last > 0 && (now - last) < (30 * 60 * 1000)) return;
    robeMeta[nome].lastLREvidenceAt = now;

    const dir = path.join(DIAG_DIR, 'login_required', safeFilePart(nome));
    ensureDirSync(dir);
    const reason = safeFilePart(lr && lr.reason);
    const ts = now;
    const base = `${ts}_${reason}`;
    const png = path.join(dir, base + '.png');
    const html = path.join(dir, base + '.html');

    try { await page.screenshot({ path: png, fullPage: false }).catch(()=>{}); } catch {}
    try {
      const content = await page.content().catch(()=>null);
      if (content) fs.writeFileSync(html, String(content), 'utf8');
    } catch {}
    return true;
  } catch {}
  return false;
}

const { AsyncLocalStorage } = require('async_hooks');
const _profileLockAls = new AsyncLocalStorage();
const _profileOpLocks = new Map();
async function lockProfileAction(nome, fn) {
  if (!nome) return fn();
  // Reentrância enterprise: se já estamos executando uma ação bloqueada para este mesmo perfil
  // (ex.: login_remediate -> detecta ban -> setBannedFlag), não pode deadlockar.
  try {
    const st = _profileLockAls.getStore();
    if (st && st.nome === nome) return await fn();
  } catch {}

  const hadPrev = _profileOpLocks.has(nome);
  const prev = _profileOpLocks.get(nome) || Promise.resolve();
  let resolveNext;
  const next = new Promise(res => resolveNext = res);
  _profileOpLocks.set(nome, prev.then(() => next));
  // #region agent log
  __agentLog(
    'H6',
    'worker.js:lockProfileAction',
    'profile_lock_enqueued',
    {
      nome: String(nome || ''),
      lockMapSize: _profileOpLocks.size,
      hadPrev
    },
    `profileLock.enqueue.${String(nome || '')}`,
    15000
  );
  // #endregion
  try {
    await prev;
    return await _profileLockAls.run({ nome }, fn);
  } finally {
    resolveNext();
    if (_profileOpLocks.get(nome) === next) _profileOpLocks.delete(nome);
    // #region agent log
    __agentLog(
      'H6',
      'worker.js:lockProfileAction',
      'profile_lock_release',
      {
        nome: String(nome || ''),
        lockMapSize: _profileOpLocks.size,
        lockStillPresent: _profileOpLocks.has(nome)
      },
      `profileLock.release.${String(nome || '')}`,
      15000
    );
    // #endregion
  }
}

async function readAccountFlags(nome) {
  try {
    const m = await manifestStore.read(nome).catch(()=>null);
    return (m && m.accountFlags) ? m.accountFlags : {};
  } catch { return {}; }
}

function readHostIdSync() {
  try {
    if (fs.existsSync(HOSTID_PATH)) {
      const v = fs.readFileSync(HOSTID_PATH, 'utf8').trim();
      return v || '';
    }
  } catch {}
  return '';
}

async function fetchCredentialsFromCT({ profileName } = {}) {
  const cfg = readCtConfig();
  // Fallback enterprise: se ct_config.json não tiver dados, usar env/notifierEndpoints
  // (evita “funciona tudo, mas não arquiva no CT” quando só LOG_INGEST_SECRET está setado via env).
  let base = String(cfg && cfg.ctBaseUrl || '').trim();
  if (!base) base = String(process.env.CT_BASE_URL || process.env.CT_URL || '').trim();
  if (!base) {
    try {
      const { notifierBaseFromEndpoints } = require('./notifierEndpoints');
      base = String(notifierBaseFromEndpoints() || '').trim();
    } catch {}
  }
  base = base.replace(/\/+$/, '');
  const secret = String((cfg && cfg.logIngestSecret) ? cfg.logIngestSecret : (process.env.LOG_INGEST_SECRET || '')).trim();
  const hostId = readHostIdSync();
  const p = String(profileName || '').trim();
  if (!base || !secret || !hostId || !p) return { ok: false, error: 'ct_config_missing' };
  try {
    const Aborter = global.AbortController || require('node-abort-controller');
    const ac = new Aborter();
    const t = setTimeout(() => { try { ac.abort(); } catch {} }, 8000);
    const resp = await fetch(`${base}/api/stock/profile_credentials_secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Log-Secret': secret },
      body: JSON.stringify({ hostId, profileName: p }),
      signal: ac.signal
    });
    clearTimeout(t);
    const j = await resp.json().catch(()=>null);
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) ? String(j.error) : `http_${resp.status}` };
    const login = String(j.login || '').trim();
    const password = String(j.password || '').trim();
    if (!login || !password) return { ok: false, error: 'missing_credentials' };
    return { ok: true, login, password, stockAccountId: j.stockAccountId || null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function archiveBanWithEvidenceToCT({ profileName, stockAccountId = null, reason = 'banned_detected', evidenceB64 = '', evidenceUrl = '' } = {}) {
  const cfg = readCtConfig();
  let base = String(cfg && cfg.ctBaseUrl || '').trim();
  if (!base) base = String(process.env.CT_BASE_URL || process.env.CT_URL || '').trim();
  if (!base) {
    try {
      const { notifierBaseFromEndpoints } = require('./notifierEndpoints');
      base = String(notifierBaseFromEndpoints() || '').trim();
    } catch {}
  }
  base = base.replace(/\/+$/, '');
  const secret = String((cfg && cfg.logIngestSecret) ? cfg.logIngestSecret : (process.env.LOG_INGEST_SECRET || '')).trim();
  const hostId = readHostIdSync();
  const p = String(profileName || '').trim();
  if (!base || !secret || !hostId || !p) return { ok: false, error: 'ct_config_missing' };
  try {
    let sid = Number(stockAccountId || 0) || 0;
    if (!sid) {
      try {
        const man = await manifestStore.read(p).catch(()=>null);
        if (man && (man.stockAccountId || man.stock_account_id)) sid = Number(man.stockAccountId || man.stock_account_id) || 0;
      } catch {}
    }
    if (!sid) {
      try {
        const cached = robeMeta[p] && robeMeta[p].overlayCredCache;
        if (cached && cached.stockAccountId) sid = Number(cached.stockAccountId) || 0;
      } catch {}
    }
    const Aborter = global.AbortController || require('node-abort-controller');
    const ac = new Aborter();
    const t = setTimeout(() => { try { ac.abort(); } catch {} }, 12000);
    const resp = await fetch(`${base}/api/stock/assigned/archive_with_evidence_secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Log-Secret': secret },
      body: JSON.stringify({
        hostId,
        profileName: p,
        stockAccountId: sid || null,
        reason: String(reason || 'banned_detected').slice(0, 120),
        by: 'auto',
        evidenceB64: String(evidenceB64 || '').trim(),
        evidenceUrl: String(evidenceUrl || '').trim()
      }),
      signal: ac.signal
    });
    clearTimeout(t);
    const txt = await resp.text().catch(()=> '');
    let j = null;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!j || j.ok !== true) {
      const bodySnippet = String(txt || '').slice(0, 220);
      const err = (j && j.error) ? String(j.error) : `http_${resp.status}`;
      return { ok: false, error: err, details: { httpStatus: resp.status, base, bodySnippet, stockAccountId: sid || null } };
    }
    return { ok: true, archived: true, stockAccountId: Number(j.id || sid || 0) || null };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// =========================
// UA+FP telemetry -> CT (anti falso-positivo)
// =========================
function _shouldEmitUaFp(nome, kind, windowMs) {
  try {
    if (!nome) return false;
    const k = String(kind || '').trim().toLowerCase();
    if (!k) return false;
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome]._uafpEmit = robeMeta[nome]._uafpEmit || {};
    const now = Date.now();
    const last = Number(robeMeta[nome]._uafpEmit[k] || 0) || 0;
    const w = Number(windowMs || 0) || 0;
    if (last > 0 && w > 0 && (now - last) < w) return false;
    robeMeta[nome]._uafpEmit[k] = now;
    return true;
  } catch {
    return false;
  }
}

async function emitUaFpEventToCT(nome, { eventKind = '', url = '', title = '' } = {}) {
  const cfg = readCtConfig();
  let base = String(cfg && cfg.ctBaseUrl || '').trim();
  if (!base) base = String(process.env.CT_BASE_URL || process.env.CT_URL || '').trim();
  if (!base) {
    try {
      const { notifierBaseFromEndpoints } = require('./notifierEndpoints');
      base = String(notifierBaseFromEndpoints() || '').trim();
    } catch {}
  }
  base = base.replace(/\/+$/, '');
  const secret = String((cfg && cfg.logIngestSecret) ? cfg.logIngestSecret : (process.env.LOG_INGEST_SECRET || '')).trim();
  const hostId = readHostIdSync();
  if (!base || !secret || !hostId || !nome) return { ok: false, error: 'ct_config_missing' };

  // Throttle enterprise: evita spam de eventos repetidos do mesmo perfil
  const kind = String(eventKind || '').trim().toLowerCase();
  const windowMs =
    kind.includes('banned') ? (24 * 60 * 60 * 1000) :
    kind.includes('two') ? (24 * 60 * 60 * 1000) :
    kind.includes('identity') ? (6 * 60 * 60 * 1000) :
    kind.includes('captcha') ? (6 * 60 * 60 * 1000) :
    (6 * 60 * 60 * 1000);
  if (!_shouldEmitUaFp(nome, kind, windowMs)) return { ok: true, skipped: true, reason: 'throttled' };

  let stockAccountId = null;
  let uaPresetId = '';
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (man && (man.stockAccountId || man.stock_account_id)) stockAccountId = Number(man.stockAccountId || man.stock_account_id) || null;
    if (man && man.uaPresetId) uaPresetId = String(man.uaPresetId || '').trim();
  } catch {}
  // Fallback: overlay cache (quando ainda não persistiu no manifest)
  try {
    if (!stockAccountId) {
      const cached = robeMeta[nome] && robeMeta[nome].overlayCredCache;
      if (cached && cached.stockAccountId) stockAccountId = Number(cached.stockAccountId) || null;
    }
  } catch {}

  try {
    const Aborter = global.AbortController || require('node-abort-controller');
    const ac = new Aborter();
    const t = setTimeout(() => { try { ac.abort(); } catch {} }, 12000);
    const resp = await fetch(`${base}/api/stock/uafp_event_secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Log-Secret': secret },
      body: JSON.stringify({
        hostId,
        profileName: String(nome || '').trim(),
        stockAccountId: stockAccountId || null,
        uaPresetId: uaPresetId || null,
        eventKind: String(eventKind || '').trim(),
        url: String(url || '').trim(),
        title: String(title || '').trim()
      }),
      signal: ac.signal
    });
    clearTimeout(t);
    const txt = await resp.text().catch(()=> '');
    let j = null;
    try { j = JSON.parse(txt); } catch { j = null; }
    if (!j || j.ok !== true) {
      const bodySnippet = String(txt || '').slice(0, 220);
      const err = (j && j.error) ? String(j.error) : `http_${resp.status}`;
      return { ok: false, error: err, details: { httpStatus: resp.status, base, bodySnippet } };
    }
    return { ok: true, sent: true, eventKey: j.eventKey || null, created: j.created, updated: j.updated };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

async function setLoginRequiredFlag(nome, { reason = '', source = '' } = {}) {
  // Guardrail enterprise: identidade (selfie/vídeo) não deve virar "loginRequired" genérico.
  // Ela tem semântica própria (humano + monitor 1h quando submetido).
  try {
    const rr = String(reason || '').toLowerCase();
    // Regra ultra enterprise: "probe_failed" é falha de medição, não evidência de login.
    // Não pode persistir LR/derrubar Virtus por si só.
    if (rr === 'probe_failed' || rr.startsWith('probe_failed')) {
      try {
        await issues.append(
          nome,
          'probe_unavailable',
          `reason=${String(reason||'')} source=${String(source||'')} at=${new Date().toISOString()}`
        );
      } catch {}
      return;
    }
    if (rr.includes('identity_submitted')) {
      await setIdentitySubmittedFlag(nome, { source: source || '', url: '', title: '' });
      return;
    }
    if (rr.includes('identity_confirm') || rr === 'identity' || rr.startsWith('identity_')) {
      await setIdentityRequiredFlag(nome, { source: source || '', url: '', title: '' });
      return;
    }
  } catch {}
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.loginRequired === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      // Regra enterprise: estado atual manda. Se agora é login_required, limpar flags antigas que mascaram a verdade.
      // Ex.: estava "recurso em análise", mas voltou para login_form -> precisamos remediar login.
      delete man.accountFlags.appealSubmitted;
      delete man.accountFlags.appealSubmittedAt;
      delete man.accountFlags.appealSource;
      delete man.accountFlags.appealUrl;
      delete man.accountFlags.appealTitle;
      delete man.accountFlags.appealNextCheckAt;
      delete man.accountFlags.appealLastReason;

      man.accountFlags.loginRequired = true;
      man.accountFlags.loginReason = String(reason||'');
      man.accountFlags.loginSource = String(source||'');
      man.accountFlags.lastLoginRequiredAt = Date.now();
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'login_required_detected',
        `reason=${reason||''} source=${source||''} at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].loginRequired = true;
    robeMeta[nome].loginReason = reason || '';
    robeMeta[nome].loginSource = source || '';

    // Regra 110%: ao marcar login_required, garantir desired.virtus='off'
    // (evita o nurse religar Virtus automaticamente e ficar “brigando” com telas de login).
    try {
      await fileStore.withDesiredFileLockUpdate((d) => {
        d = d || {}; d.perfis = d.perfis || {};
        d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
        return d;
      });
    } catch {}

    // Blindagem enterprise: se loginRequired foi detectado, Virtus NÃO pode ficar "Online".
    // Isso evita telemetria falsa (trabalhando=true) e evita loops de automação em tela de login.
    try {
      const ctrl = controllers.get(nome);
      if (ctrl) {
        ctrl.trabalhando = false;
        try { await stopVirtus(nome); } catch {}
      }
    } catch {}

    try { await snapshotStatusAndWrite(); } catch {}
  } catch {}
}

// Quando o fluxo automático tentou (cookies + login/senha) e falhou, marca persistente.
// Regra enterprise: NÃO re-tentar automaticamente em loop; só "Retomar trabalho" libera nova tentativa.
async function setLoginRemediateFailedFlag(nome, { reason = '', source = '', stage = '' } = {}) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.loginRemediateFailed = true;
      man.accountFlags.loginRemediateFailedAt = Date.now();
      man.accountFlags.loginRemediateFailedReason = String(reason || '').slice(0, 220);
      man.accountFlags.loginRemediateFailedSource = String(source || '').slice(0, 120);
      if (stage) man.accountFlags.loginRemediateFailedStage = String(stage || '').slice(0, 80);
      man.accountFlags.loginRemediateFailedCount = Number(man.accountFlags.loginRemediateFailedCount || 0) + 1;
      return man;
    });
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].loginRemediateFailed = true;
    robeMeta[nome].loginRemediateFailedReason = String(reason || '').slice(0, 220);
    robeMeta[nome].whyNotOpen = 'login_remediate_failed';
  } catch {}
}

// ===== Human Overlay (HUD) =====
// Objetivo: quando entrar em modo humano, mostrar painel fixo no navegador com nome/motivo/login/senha e botões (copiar/retomar).
const HUMAN_OVERLAY_CFG = {
  enabled: String(process.env.HUMAN_OVERLAY || '').trim() !== '0',
  maxPagesScan: 8
};

function _overlayReasonFromFlags(flags) {
  try {
    flags = (flags && typeof flags === 'object') ? flags : {};
    if (flags.banned === true) return `banned:${flags.bannedReason || ''}`.trim();
    if (flags.twoFactor === true) return `two_factor:${flags.twoFactorReason || ''}`.trim();
    if (flags.captchaCheckpoint === true) return `captcha_checkpoint:${flags.captchaCheckpointReason || ''}`.trim();
    if (flags.identitySubmitted === true) return 'identity_submitted';
    if (flags.identityRequired === true) return 'identity_required';
    if (flags.appealSubmitted === true) return 'appeal_submitted';
    if (flags.messengerPin === true) return `messenger_pin:${flags.messengerPinReason || ''}`.trim();
    if (flags.loginRemediateFailed === true) return `login_remediate_failed:${flags.loginRemediateFailedReason || ''}`.trim();
    if (flags.loginRequired === true) return String(flags.loginReason || 'login_required');
    return 'human_mode';
  } catch { return 'human_mode'; }
}

// IMPORTANT (debug-mode / ultra enterprise):
// setCaptchaCheckpointFlag NÃO deve invocar humano automaticamente.
// Ela só registra flags persistentes (evidência do estado). A decisão de entrar em modo humano
// deve ser do "flow" (ex.: após N tentativas) para evitar "paranoia".
async function setCaptchaCheckpointFlag(nome, { reason = '', source = '', url = '', title = '' } = {}) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.captchaCheckpoint = true;
      man.accountFlags.captchaCheckpointAt = Number(man.accountFlags.captchaCheckpointAt || 0) || Date.now();
      man.accountFlags.captchaCheckpointReason = String(reason || '').slice(0, 220);
      man.accountFlags.captchaCheckpointSource = String(source || '').slice(0, 80);
      man.accountFlags.captchaCheckpointUrl = String(url || '').slice(0, 300);
      man.accountFlags.captchaCheckpointTitle = String(title || '').slice(0, 200);
      // Blindagem: captcha/checkpoint NÃO pode ficar mascarado por "login/cookies falhou".
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      return man;
    });
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].whyNotOpen = 'captcha_checkpoint';
    delete robeMeta[nome].loginRemediateFailed;
    delete robeMeta[nome].loginRemediateFailedReason;
  } catch {}

  // UA+FP telemetry (captcha/checkpoint)
  try { await emitUaFpEventToCT(nome, { eventKind: 'captcha', url, title }); } catch {}
}

async function enterHumanMode(nome, ctrl, { reason = 'human_mode' } = {}) {
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d = d || {}; d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
      return d;
    });
  } catch {}
  try {
    if (ctrl) {
      ctrl.trabalhando = false;
      ctrl.humanControl = true;
      try { await stopVirtus(nome); } catch {}
      try { await ensureHumanOverlay(nome, ctrl, { reason }); } catch {}
      // Bring-to-front/human prompt (best-effort)
      try { await browserHelper.invocarHumano(ctrl.browser, nome); } catch {}
    }
  } catch {}
  try { provisionAudit.append({ ts: Date.now(), event: 'enter_human_mode', nome: String(nome||''), reason: String(reason||'').slice(0, 140) }); } catch {}
}

// ===== Captcha flow (OCR + retries) =====
const CAPTCHA_FLOW_CFG = {
  maxTries: Math.max(1, Number(process.env.CAPTCHA_MAX_TRIES || 5) || 5)
};
// Kill-switch enterprise:
// 1 = pausa automações de captcha/identidade/recurso_em_analise.
// login_required continua habilitado (autoLoginRemediate).
const PAUSE_NON_LR_AUTOMATION = String(process.env.PAUSE_NON_LR_AUTOMATION || '1').trim() === '1';
const CAPTCHA_PACING_CFG = {
  minStableMs: Math.max(200, Number(process.env.CAPTCHA_MIN_STABLE_MS || 1500) || 1500)
};

// Mutex in-process: 1 captcha flow por host (fallback quando supervisor permits não estão habilitados).
let _captchaFlowRunning = false;
let _captchaFlowRunningNome = null;

function isNonLrAutomationPaused() {
  return PAUSE_NON_LR_AUTOMATION === true;
}

async function enforcePausedNonLrState(nome, { kind = '', source = '' } = {}) {
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d = d || {};
      d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
      return d;
    });
  } catch {}
  try {
    const c = controllers.get(nome);
    if (c) {
      c.trabalhando = false;
      try { await stopVirtus(nome); } catch {}
    }
  } catch {}
  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'non_lr_automation_paused_state_enforced',
      nome: String(nome || ''),
      kind: String(kind || '').slice(0, 80),
      source: String(source || '').slice(0, 80)
    });
  } catch {}
}

async function runCaptchaFlow(nome, ctrl, pg, { source = 'unknown', flowId = '', force = false } = {}) {
  const startedAt = Date.now();
  const id = String(flowId || newFlowId('captcha'));
  let _locked = false;
  let lastImgSrc = '';
  try {
    if (!nome || !ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'no_browser' };
    if (!pg) return { ok: false, error: 'no_page' };
    // Se humano está no controle, não operar.
    if (ctrl && ctrl.humanControl === true) {
      try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_skipped_human_control', nome: String(nome||''), flowId: id, source: String(source||'').slice(0, 80) }); } catch {}
      return { ok: false, skipped: true, reason: 'human_control' };
    }
    if (isNonLrAutomationPaused()) {
      try { await setCaptchaCheckpointFlag(nome, { reason: 'non_lr_automation_paused', source: String(source || '').slice(0, 80) }); } catch {}
      await enforcePausedNonLrState(nome, { kind: 'captcha_checkpoint', source });
      try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_paused_by_policy', nome: String(nome||''), flowId: id, source: String(source||'').slice(0, 80) }); } catch {}
      return { ok: false, pausedByPolicy: true, error: 'non_lr_automation_paused' };
    }

    // Fallback enterprise: mutex interno (1 captcha por host).
    // Importante: não depende do supervisor, então evita o "stall" quando permits estão disabled.
    if (_captchaFlowRunning) {
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'captcha_flow_inproc_denied',
          nome: String(nome||''),
          flowId: id,
          source: String(source||'').slice(0, 80),
          runningNome: String(_captchaFlowRunningNome || '')
        });
      } catch {}
      return { ok: false, denied: true, error: 'inproc_busy' };
    }
    _captchaFlowRunning = true;
    _captchaFlowRunningNome = String(nome || '');
    _locked = true;

    // Governança por tipo: 1 captcha por host (mas não bloqueia identity/login).
    let _govToken = null;
    try {
      const pr = await supervisorClient.requestPermit('captcha_flow', nome, {
        operator: `captcha_flow:${String(nome||'').trim()}:${id}`,
        ttlMs: Math.min((6 * 60 * 1000), (15 * 60 * 1000))
      }).catch(()=>null);
      if (!pr || pr.ok !== true || !pr.token) {
        const why = pr && pr.error ? String(pr.error) : 'unknown';
        // Alguns hosts podem ter permits desabilitados para esse tipo (retorna "disabled").
        // Nesses casos seguimos apenas com o mutex interno (sem travar o fluxo).
        if (String(why || '').toLowerCase() === 'disabled') {
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'captcha_flow_governor_disabled_fallback',
              nome: String(nome||''),
              flowId: id,
              source: String(source||'').slice(0,80)
            });
          } catch {}
        } else {
          try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_governor_denied', nome: String(nome||''), flowId: id, source: String(source||'').slice(0,80), reason: why, retryAfterMs: pr && pr.retryAfterMs ? pr.retryAfterMs : null }); } catch {}
          return { ok: false, denied: true, error: 'governor_busy' };
        }
      }
      _govToken = pr.token;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_governor_exception', nome: String(nome||''), flowId: id, error: msg.slice(0, 200) }); } catch {}
      return { ok: false, error: `governor_exception:${msg}` };
    }

    try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_begin', nome: String(nome||''), flowId: id, source: String(source||'').slice(0,80), maxTries: CAPTCHA_FLOW_CFG.maxTries }); } catch {}

    // Estado seguro imediato (não pode ficar Virtus/Robe rodando)
    try {
      await fileStore.withDesiredFileLockUpdate((d) => {
        d = d || {}; d.perfis = d.perfis || {};
        const prev = d.perfis[nome] || {};
        d.perfis[nome] = { ...prev, active: true, virtus: 'off', humanHold: false };
        return d;
      });
    } catch {}
    try { ctrl.trabalhando = false; } catch {}
    try { await stopVirtus(nome); } catch {}

    let lastReason = '';
    for (let attempt = 1; attempt <= CAPTCHA_FLOW_CFG.maxTries; attempt++) {
      const lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
      if (!lr || lr.loginRequired !== true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_cleared', nome: String(nome||''), flowId: id, attempt }); } catch {}
        // liberou => retoma
        setTimeout(() => { try { handlers.start_work({ nome, operator: `captcha_flow_resolved:${id}` }).catch(()=>{}); } catch {} }, 0);
        try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'cleared' }).catch(()=>{}); } catch {}
        return { ok: true, result: 'cleared', flowId: id };
      }

      lastReason = String(lr.reason || '').toLowerCase();
      try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_attempt', nome: String(nome||''), flowId: id, source: String(source||'').slice(0,80), attempt, reason: lastReason.slice(0,120) }); } catch {}

      // Handoff enterprise:
      // se saímos do captcha e entramos em outro estado (identidade/login/appeal), NÃO invocar humano pelo captcha flow.
      // Encaminhamos para o fluxo correto e encerramos o captcha flow.
      if (lastReason.includes('identity')) {
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_handoff_identity', nome: String(nome||''), flowId: id, attempt, reason: lastReason.slice(0,160) }); } catch {}
        try { await setIdentityRequiredFlag(nome, { source: 'captcha_flow', url: lr.url || '', title: lr.title || '' }).catch(()=>{}); } catch {}
        try {
          const c = controllers.get(nome) || ctrl;
          const p = (c && c.mainPage) ? c.mainPage : pg;
          if (c && p) runIdentityFlow(nome, c, p, { source: `captcha_flow_handoff:${String(source||'').slice(0,60)}`, force: true }).catch(()=>{});
        } catch {}
        try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'handoff_identity' }).catch(()=>{}); } catch {}
        return { ok: true, result: 'handoff_identity', flowId: id };
      }
      if (lastReason.includes('appeal')) {
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_handoff_appeal', nome: String(nome||''), flowId: id, attempt, reason: lastReason.slice(0,160) }); } catch {}
        try { await setAppealSubmittedFlag(nome, { source: 'captcha_flow', url: lr.url || '', title: lr.title || '' }).catch(()=>{}); } catch {}
        try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }).catch(()=>{}); } catch {}
        try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'handoff_appeal' }).catch(()=>{}); } catch {}
        return { ok: true, result: 'handoff_appeal', flowId: id };
      }
      if (lastReason.includes('login_form')) {
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_handoff_login_form', nome: String(nome||''), flowId: id, attempt }); } catch {}
        // Blindagem P0: nunca enfileirar remediação sem persistir flag LR.
        // Sem isso, o autoLoginRemediateTick ignora o perfil (depende de loginRequired=true).
        try { await setLoginRequiredFlag(nome, { reason: lr.reason || 'login_form', source: lr.domain || 'captcha_flow' }); } catch {}
        try { queueAutoLoginRemediate(nome, { reason: lr.reason || '', source: lr.domain || '', immediate: true }); } catch {}
        try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'handoff_login_form' }).catch(()=>{}); } catch {}
        return { ok: true, result: 'handoff_login_form', flowId: id };
      }

      if (lastReason.includes('captcha_persona_pre_screen')) {
        const wait = await browserHelper.waitForContinueEnabled(pg, { timeoutMs: 20_000 }).catch(()=>({ ok:false, error:'wait_failed' }));
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_pre_screen_wait', nome: String(nome||''), flowId: id, attempt, ok: !!(wait && wait.ok), error: wait && wait.error ? String(wait.error).slice(0,120) : null }); } catch {}
        if (!(wait && wait.ok)) {
          // Não invocar humano aqui: pre-screen pode ficar "cinza" por alguns segundos.
          // Deixa o nurse re-agendar com debounce.
          try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'pre_screen_disabled' }).catch(()=>{}); } catch {}
          return { ok: false, error: 'pre_screen_disabled', flowId: id };
        }
        const clk = await browserHelper.clickContinueByLabel(pg, { maxWaitMs: 9000 }).catch(()=>({ ok:false, error:'click_failed' }));
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_pre_screen_click', nome: String(nome||''), flowId: id, attempt, ok: !!(clk && clk.ok), error: clk && clk.error ? String(clk.error).slice(0,120) : null }); } catch {}
        continue;
      }

      if (lastReason.includes('captcha_persona') || lastReason.includes('checkpoint_captcha')) {
        const cap = await browserHelper.detectCaptchaChallenge(pg).catch(()=>({ ok:false, present:false }));
        try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_captcha_probe', nome: String(nome||''), flowId: id, attempt, present: !!cap.present, continueDisabled: cap.continueDisabled }); } catch {}
        const curImgSrc = (cap && cap.imgSrc) ? String(cap.imgSrc || '').slice(0, 220) : '';
        const ocr = await browserHelper.solveCaptchaWithGroq(pg, { nome, operator: `captcha_flow:${id}`, attempt, previousImgSrc: lastImgSrc }).catch(()=>({ ok:false, error:'ocr_exception' }));
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'captcha_flow_ocr_attempt',
            nome: String(nome||''),
            flowId: id,
            attempt,
            ok: !!ocr.ok,
            error: ocr && ocr.error ? String(ocr.error).slice(0,120) : null,
            hasText: !!(ocr && ocr.text),
            textLength: ocr && ocr.text ? String(ocr.text).length : 0,
            rawLength: (ocr && ocr.meta && typeof ocr.meta.rawLength === 'number') ? ocr.meta.rawLength : null,
            rawHadWhitespace: (ocr && ocr.meta && typeof ocr.meta.rawHadWhitespace === 'boolean') ? ocr.meta.rawHadWhitespace : null,
            cleanedLength: (ocr && ocr.meta && typeof ocr.meta.cleanedLength === 'number') ? ocr.meta.cleanedLength : null,
            imgSrcKnown: !!curImgSrc
          });
        } catch {}
        // Se a causa é falta de config Groq no host, isso é auto-corrigível via handshake CT.
        // Não devemos invocar humano nem consumir as 5 tentativas "em loop" aqui.
        if (!ocr || ocr.ok !== true) {
          const oerr = ocr && ocr.error ? String(ocr.error) : '';
          if (String(oerr).toLowerCase() === 'groq_config_missing') {
            try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_abort_groq_config_missing', nome: String(nome||''), flowId: id, attempt }); } catch {}
            try { await setLoginRequiredFlag(nome, { reason: 'groq_config_missing', source: 'captcha_flow' }).catch(()=>{}); } catch {}
            try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'abort_groq_config_missing' }).catch(()=>{}); } catch {}
            return { ok: false, error: 'groq_config_missing', flowId: id };
          }
        }
        if (ocr && ocr.ok && ocr.text) {
          const fill = await browserHelper.fillCaptchaAndContinue(pg, { text: ocr.text, maxWaitMs: 12000 }).catch(()=>({ ok:false, error:'fill_failed' }));
          try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_fill_attempt', nome: String(nome||''), flowId: id, attempt, ok: !!fill.ok, error: fill && fill.error ? String(fill.error).slice(0,120) : null }); } catch {}
          // Aguarda transição REAL (imagem trocar ou sair do captcha) antes da próxima tentativa.
          try {
            const w = await browserHelper.waitForCaptchaTurnover(pg, { previousImgSrc: curImgSrc || lastImgSrc, timeoutMs: 15_000, minStableMs: CAPTCHA_PACING_CFG.minStableMs }).catch(()=>null);
            provisionAudit.append({
              ts: Date.now(),
              event: 'captcha_flow_wait_turnover',
              nome: String(nome||''),
              flowId: id,
              attempt,
              ok: !!(w && w.ok),
              present: w ? !!w.present : null,
              finalImgChanged: w && w.finalImgSrc ? (String(w.finalImgSrc||'') !== String(curImgSrc||'')) : null,
              minStableMs: w && typeof w.minStableMs === 'number' ? w.minStableMs : CAPTCHA_PACING_CFG.minStableMs
            });
          } catch {}
          // Usa o src final (se disponível) como base para a próxima tentativa
          try {
            const w2 = await browserHelper.detectCaptchaChallenge(pg).catch(()=>null);
            if (w2 && w2.imgSrc) lastImgSrc = String(w2.imgSrc || '');
            else lastImgSrc = curImgSrc || lastImgSrc;
          } catch { lastImgSrc = curImgSrc || lastImgSrc; }
          continue;
        }
        // Se OCR não deu texto, apenas segue para próxima tentativa (reload/reprobe já acontece pelo próprio FB / ou próximos loops).
        lastImgSrc = curImgSrc || lastImgSrc;
        continue;
      }
    }

    // Falhou após N tentativas => entrar em humano (agora sim).
    // EXCEÇÃO: pre-screen não deve cair em humano; retorna para o nurse re-tentar.
    if (lastReason && lastReason.includes('captcha_persona_pre_screen')) {
      try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_pre_screen_no_human', nome: String(nome||''), flowId: id }); } catch {}
      try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'pre_screen_no_human' }).catch(()=>{}); } catch {}
      return { ok: false, error: 'pre_screen_disabled', flowId: id };
    }
    try { await setCaptchaCheckpointFlag(nome, { reason: lastReason || 'captcha_checkpoint', source: String(source||'').slice(0,80), url: '', title: '' }); } catch {}
    try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_invoke_human', nome: String(nome||''), flowId: id, tries: CAPTCHA_FLOW_CFG.maxTries, reason: String(lastReason||'').slice(0,120) }); } catch {}
    await enterHumanMode(nome, controllers.get(nome) || ctrl, { reason: `captcha_after_${CAPTCHA_FLOW_CFG.maxTries}_tries:${String(lastReason||'captcha').slice(0,80)}` });
    try { if (_govToken) supervisorClient.releasePermit(_govToken, { result: 'invoke_human' }).catch(()=>{}); } catch {}
    return { ok: false, error: 'captcha_requires_human', flowId: id };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try { provisionAudit.append({ ts: Date.now(), event: 'captcha_flow_exception', nome: String(nome||''), flowId: id, error: msg.slice(0, 200) }); } catch {}
    return { ok: false, error: `captcha_flow_exception:${msg}` };
  } finally {
    if (_locked) {
      _captchaFlowRunning = false;
      _captchaFlowRunningNome = null;
    }
  }
}

async function _buildHumanOverlayData(nome) {
  try {
    const perfisArr = loadPerfisJson();
    const p = Array.isArray(perfisArr) ? perfisArr.find(x => x && x.nome === nome) : null;
    const man = await manifestStore.read(nome).catch(()=>null);
    const flags = (man && man.accountFlags) ? man.accountFlags : (await readAccountFlags(nome).catch(()=>({})));

    const desired = readJsonFile(desiredPath, { perfis: {} });
    const want = (desired && desired.perfis && desired.perfis[nome]) ? desired.perfis[nome] : {};

    let login = man && (man.login || man.email || man.user || man.username) ? String(man.login || man.email || man.user || man.username) : '';
    let password = man && (man.password || man.pass) ? String(man.password || man.pass) : '';

    // Enterprise: se manifest não tem credenciais, tenta buscar do CT (assigned->stock).
    // Cache curto em memória para não spammar CT.
    try {
      if (!String(login || '').trim() || !String(password || '').trim()) {
        robeMeta[nome] = robeMeta[nome] || {};
        const cache = robeMeta[nome].overlayCredCache || null;
        const now = Date.now();
        if (cache && cache.ts && (now - Number(cache.ts || 0)) < 5 * 60 * 1000 && cache.login && cache.password) {
          login = String(cache.login || '');
          password = String(cache.password || '');
        } else {
          const rr = await fetchCredentialsFromCT({ profileName: nome }).catch(()=>null);
          if (rr && rr.ok) {
            login = String(rr.login || '');
            password = String(rr.password || '');
            robeMeta[nome].overlayCredCache = { ts: now, login, password, stockAccountId: rr.stockAccountId || null };
          }
        }
      }
    } catch {}

    const data = {
      enabled: true,
      nome: String(nome || ''),
      label: p && p.label ? String(p.label) : '',
      cidade: p && p.cidade ? String(p.cidade) : '',
      uaPresetId: p && p.uaPresetId ? String(p.uaPresetId) : '',
      stockAccountId: (robeMeta[nome] && robeMeta[nome].overlayCredCache && robeMeta[nome].overlayCredCache.stockAccountId) ? robeMeta[nome].overlayCredCache.stockAccountId : null,
      login,
      password,
      reason: _overlayReasonFromFlags(flags),
      flags: {
        loginRequired: flags && flags.loginRequired === true,
        loginReason: flags ? (flags.loginReason || '') : '',
        banned: flags && flags.banned === true,
        captchaCheckpoint: flags && flags.captchaCheckpoint === true,
        identityRequired: flags && flags.identityRequired === true,
        identitySubmitted: flags && flags.identitySubmitted === true,
        identityNextCheckAt: flags ? (flags.identityNextCheckAt || null) : null,
        appealSubmitted: flags && flags.appealSubmitted === true,
        messengerPin: flags && flags.messengerPin === true,
        loginRemediateFailed: flags && flags.loginRemediateFailed === true
      },
      desired: {
        active: want && want.active === true,
        virtus: want && want.virtus ? String(want.virtus) : '',
        humanHold: want && want.humanHold === true
      },
      ts: Date.now()
    };
    return data;
  } catch {
    return { enabled: true, nome: String(nome || ''), label: '', cidade: '', login: '', password: '', reason: 'human_mode', ts: Date.now() };
  }
}

async function _setOverlayDataOnPage(page, data) {
  try {
    await page.evaluate((d) => {
      try {
        window.__ctHumanOverlaySetData && window.__ctHumanOverlaySetData(d);
      } catch {}
    }, data).catch(()=>{});
  } catch {}
}

async function _installOverlayOnPage(nome, page) {
  if (!page) return;
  try {
    // Expor callback de "Retomar trabalho" (executa no Node, sem depender de HTTP/CORS).
    try {
      await page.exposeFunction('__ctHumanOverlayResume', async () => {
        try {
          // Evidência enterprise (sem credenciais)
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_resume_clicked', nome: String(nome || '') }); } catch {}
        } catch {}
        try { await handlers['human-resume']({ nome }); } catch {}
        try { await syncHumanOverlay(nome); } catch {}
        return true;
      });
    } catch (e) {
      // Se já existe, ok. Se falhar por outro motivo, registrar para diagnóstico.
      const msg = (e && e.message) ? String(e.message) : String(e);
      if (!/already exists|has been already registered|binding/i.test(msg)) {
        try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_expose_resume_failed', nome: String(nome||''), error: msg.slice(0, 220) }); } catch {}
      }
    }

    // Ações do HUD (enterprise): fechar navegador / pause robe 24h / excluir conta.
    // Importante: o HUD roda no browser, mas as ações rodam no Node via exposeFunction (sem CORS).
    try {
      await page.exposeFunction('__ctHumanOverlayCloseBrowser', async () => {
        const startedAt = Date.now();
        try { provisionAudit.append({ ts: startedAt, event: 'human_overlay_action_begin', nome: String(nome || ''), action: 'close_browser' }); } catch {}
        try {
          // Política alinhada: não forçar desired.active=false (permite reabrir depois conforme desired atual).
          // Manter preserveDesired evita efeitos colaterais agressivos; o sistema decide reabrir conforme desired/nurse.
          const r = await handlers.deactivate({ nome, reason: 'human_overlay_close', policy: 'preserveDesired' }).catch(e => ({ ok:false, error: (e && e.message) || String(e) }));
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'close_browser', ok: !!(r && r.ok), error: r && r.error ? String(r.error).slice(0, 180) : null, durationMs: Date.now() - startedAt }); } catch {}
          return r && typeof r === 'object' ? r : { ok: false, error: 'close_browser_failed' };
        } catch (e) {
          const msg = (e && e.message) ? String(e.message) : String(e);
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'close_browser', ok: false, error: msg.slice(0, 180), durationMs: Date.now() - startedAt }); } catch {}
          return { ok: false, error: msg };
        }
      });
    } catch {}

    try {
      await page.exposeFunction('__ctHumanOverlayRobe24h', async () => {
        const startedAt = Date.now();
        try { provisionAudit.append({ ts: startedAt, event: 'human_overlay_action_begin', nome: String(nome || ''), action: 'robe_24h' }); } catch {}
        try {
          const manifestStore = require('./manifestStore.js');
          const plus24 = 24 * 60 * 60 * 1000;
          await manifestStore.update(nome, man => {
            const now = Date.now();
            man = man || {};
            man.robeCooldownUntil = now + plus24;
            man.robeCooldownRemainingMs = 0;
            man.robePauseReason = 'manual';
            return man;
          });
          try { issues.append(nome, 'admin_robe24h_request', 'by=human_overlay'); } catch {}
          try { await syncHumanOverlay(nome); } catch {}
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'robe_24h', ok: true, error: null, durationMs: Date.now() - startedAt }); } catch {}
          return { ok: true };
        } catch (e) {
          const msg = (e && e.message) ? String(e.message) : String(e);
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'robe_24h', ok: false, error: msg.slice(0, 180), durationMs: Date.now() - startedAt }); } catch {}
          return { ok: false, error: msg };
        }
      });
    } catch {}

    try {
      await page.exposeFunction('__ctHumanOverlayDeleteAccount', async () => {
        const startedAt = Date.now();
        try { provisionAudit.append({ ts: startedAt, event: 'human_overlay_action_begin', nome: String(nome || ''), action: 'delete_account' }); } catch {}
        try {
          // Reutiliza o endpoint canônico de delete (inclui: fechar se ativo + CT estoque excluídas + purge local).
          const base = `http://127.0.0.1:${parseInt(process.env.PORT || '8088', 10) || 8088}`;
          const url = `${base}/api/perfis/${encodeURIComponent(String(nome || '').trim())}`;
          const Aborter = global.AbortController || require('node-abort-controller');
          const ac = new Aborter();
          const t = setTimeout(() => { try { ac.abort(); } catch {} }, 180000);
          const resp = await fetch(url, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'x-operator': 'human_overlay' },
            signal: ac.signal
          }).catch(e => ({ ok:false, _err: e }));
          clearTimeout(t);
          if (resp && resp.ok) {
            const j = await resp.json().catch(()=>null);
            const ok = !!(j && j.ok === true);
            try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'delete_account', ok, error: ok ? null : String((j && j.error) ? j.error : 'delete_failed').slice(0, 180), durationMs: Date.now() - startedAt }); } catch {}
            return j || { ok: false, error: 'delete_failed' };
          }
          const emsg = (resp && resp._err && resp._err.message) ? String(resp._err.message) : `http_${resp && resp.status ? resp.status : 0}`;
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'delete_account', ok: false, error: emsg.slice(0, 180), durationMs: Date.now() - startedAt }); } catch {}
          return { ok: false, error: emsg };
        } catch (e) {
          const msg = (e && e.message) ? String(e.message) : String(e);
          try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_action_done', nome: String(nome || ''), action: 'delete_account', ok: false, error: msg.slice(0, 180), durationMs: Date.now() - startedAt }); } catch {}
          return { ok: false, error: msg };
        }
      });
    } catch {}

    // Canal de log do overlay (provas de clique em Copiar/Retomar/Mover/Minimizar).
    try {
      await page.exposeFunction('__ctHumanOverlayLog', async (evt) => {
        try {
          const e = (evt && typeof evt === 'object') ? evt : { event: String(evt||'') };
          provisionAudit.append({
            ts: Date.now(),
            event: 'human_overlay_ui_event',
            nome: String(nome || ''),
            uiEvent: String(e.event || '').slice(0, 60),
            uiData: e && typeof e === 'object' ? e : null
          });
        } catch {}
        return true;
      });
    } catch {}

    // Injeção persistente (recria em toda navegação) + injeção imediata no documento atual.
    try {
      const overlayInstall = () => {
        try {
          // Não retornar cedo: em SPAs o DOM pode ser recriado; precisamos garantir handlers/drag/dock sempre.
          window.__ctHumanOverlayInstalled = true;

          const HOST_ID = 'ct-human-overlay-host';
          const nowIso = () => { try { return new Date().toISOString(); } catch { return ''; } };

          function ensureHost() {
            let host = document.getElementById(HOST_ID);
            if (host) return host;
            host = document.createElement('div');
            host.id = HOST_ID;
            host.style.position = 'fixed';
            host.style.top = '12px';
            host.style.right = '12px';
            host.style.left = 'auto';
            host.style.bottom = 'auto';
            host.style.zIndex = '2147483647';
            host.style.pointerEvents = 'auto';
            host.style.userSelect = 'none';
            host.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
            document.documentElement.appendChild(host);

            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
              <style>
                .wrap{ width: 360px; background:#0b1220; color:#e6e9ef; border:1px solid rgba(255,255,255,.18); border-radius:12px; box-shadow:0 12px 30px rgba(0,0,0,.45); overflow:hidden; pointer-events:auto; }
                .hdr{ display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:rgba(255,255,255,.06); cursor:move; }
                .ttl{ font-weight:700; font-size:13px; letter-spacing:.2px; }
                .moveHint{ font-size:11px; opacity:.78; margin-top:2px; }
                .tag{ font-size:11px; opacity:.9; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.14); }
                .body{ padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
                .row{ display:flex; gap:8px; align-items:flex-start; }
                .k{ width:90px; font-size:11px; opacity:.8; padding-top:2px; }
                .v{ flex:1; font-size:12px; word-break:break-word; }
                .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
                .btns{ display:flex; gap:8px; flex-wrap:wrap; }
                button{ cursor:pointer; border-radius:10px; border:1px solid rgba(255,255,255,.16); background:rgba(255,255,255,.08); color:#e6e9ef; padding:8px 10px; font-size:12px; }
                button:hover{ background:rgba(255,255,255,.12); }
                button.primary{ background:#2563eb; border-color:rgba(255,255,255,.18); }
                button.primary:hover{ background:#1d4ed8; }
                button.danger{ background:rgba(239,68,68,.18); border-color:rgba(239,68,68,.35); }
                button.mini{ padding:6px 8px; font-size:11px; border-radius:9px; }
                .hdrBtns{ display:flex; gap:6px; align-items:center; }
                .hint{ font-size:11px; opacity:.75; line-height:1.25; }
                .ok{ color:#86efac; }
                .bad{ color:#fca5a5; }
                .warn{ color:#fde68a; }
              </style>
              <div class="wrap" id="wrap">
                <div class="hdr" title="Dica: arraste esta barra para mover o painel">
                  <div>
                    <div class="ttl">Modo Humano — Conveniente</div>
                    <div class="hint" id="sub"></div>
                    <div class="moveHint">Arraste o topo para mover • Use “Mover” para trocar de canto</div>
                  </div>
                  <div class="hdrBtns">
                    <button class="mini" id="dock" title="Mover painel (cantos)">Mover</button>
                    <button class="mini" id="min" title="Minimizar/maximizar">—</button>
                    <div class="tag" id="tag">HUMANO</div>
                  </div>
                </div>
                <div class="body" id="body">
                  <div class="row"><div class="k">Conta</div><div class="v" id="nome"></div></div>
                  <div class="row"><div class="k">Motivo</div><div class="v mono" id="reason"></div></div>
                  <div class="row"><div class="k">Login</div><div class="v mono" id="login"></div></div>
                  <div class="row"><div class="k">Senha</div><div class="v mono" id="pass"></div></div>
                  <div class="btns">
                    <button id="copyLogin">Copiar login</button>
                    <button id="copyPass">Copiar senha</button>
                    <button class="primary" id="resume">Retomar trabalho</button>
                    <button id="robe24h" title="Pausar Robe por 24h (não retoma automação)">Robe 24h</button>
                    <button id="closeBrowser" title="Fecha este navegador (não altera desired.active)">Fechar navegador</button>
                    <button class="danger" id="deleteAcc" title="Excluir conta (fecha + purge local + CT estoque excluídas)">Excluir conta</button>
                    <button class="danger" id="hide" title="Ocultar o painel">Ocultar painel</button>
                  </div>
                  <div class="hint" id="hint"></div>
                </div>
              </div>
            `;

            const $ = (id) => shadow.getElementById(id);
            const body = $('body');

            // Persistência leve da posição (sem dependências)
            const POS_KEY = 'ctHumanOverlayPosV1';
            const readPos = () => { try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { return null; } };
            const savePos = (p) => { try { localStorage.setItem(POS_KEY, JSON.stringify(p || {})); } catch {} };
            const applyDock = (dock) => {
              try {
                host.style.left = 'auto'; host.style.right = 'auto'; host.style.top = 'auto'; host.style.bottom = 'auto';
                if (dock === 'tl') { host.style.top = '12px'; host.style.left = '12px'; }
                else if (dock === 'br') { host.style.bottom = '12px'; host.style.right = '12px'; }
                else if (dock === 'bl') { host.style.bottom = '12px'; host.style.left = '12px'; }
                else { host.style.top = '12px'; host.style.right = '12px'; } // tr default
              } catch {}
            };
            const applyFree = (x, y) => {
              try {
                host.style.right = 'auto';
                host.style.bottom = 'auto';
                host.style.left = `${Math.max(6, Math.min(window.innerWidth - 60, x))}px`;
                host.style.top  = `${Math.max(6, Math.min(window.innerHeight - 60, y))}px`;
              } catch {}
            };
            // Restaura posição
            try {
              const p = readPos();
              if (p && p.mode === 'free' && typeof p.x === 'number' && typeof p.y === 'number') applyFree(p.x, p.y);
              else if (p && p.mode && typeof p.mode === 'string') applyDock(p.mode);
            } catch {}

            // Botão Mover (dock cycle)
            $('dock')?.addEventListener('click', () => {
              const seq = ['tr','tl','br','bl'];
              const cur = (() => { try { const p = readPos(); return (p && p.mode) ? String(p.mode) : 'tr'; } catch { return 'tr'; } })();
              const next = seq[(seq.indexOf(cur) + 1) % seq.length];
              applyDock(next);
              savePos({ mode: next });
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'dock', mode: next }); } catch {}
            });

            // Minimizar
            let minimized = false;
            $('min')?.addEventListener('click', () => {
              minimized = !minimized;
              try { if (body) body.style.display = minimized ? 'none' : 'block'; } catch {}
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'minimize', minimized: !!minimized }); } catch {}
            });

            // Drag (pela header)
            try {
              let dragging = false;
              let dx = 0, dy = 0;
              const hdr = shadow.querySelector('.hdr');
              const onMove = (ev) => {
                if (!dragging) return;
                const x = (ev && typeof ev.clientX === 'number') ? ev.clientX - dx : 12;
                const y = (ev && typeof ev.clientY === 'number') ? ev.clientY - dy : 12;
                applyFree(x, y);
                savePos({ mode:'free', x, y });
              };
              const onUp = () => { dragging = false; };
              hdr && hdr.addEventListener('mousedown', (ev) => {
                try {
                  dragging = true;
                  const r = host.getBoundingClientRect();
                  dx = ev.clientX - r.left;
                  dy = ev.clientY - r.top;
                  savePos({ mode:'free', x: r.left, y: r.top });
                  try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'drag_begin' }); } catch {}
                } catch {}
              });
              window.addEventListener('mousemove', onMove);
              window.addEventListener('mouseup', onUp);
            } catch {}

            const copyText = async (txt) => {
              const s = String(txt || '');
              if (!s) return false;
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(s);
                  return true;
                }
              } catch {}
              try {
                const ta = document.createElement('textarea');
                ta.value = s;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(ta);
                return !!ok;
              } catch {}
              return false;
            };

            $('copyLogin')?.addEventListener('click', async () => {
              const d = window.__ctHumanOverlayData || {};
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'copy_login' }); } catch {}
              const ok = await copyText(d.login || '');
              try { $('hint').textContent = ok ? 'Login copiado.' : 'Falha ao copiar login.'; } catch {}
            });
            $('copyPass')?.addEventListener('click', async () => {
              const d = window.__ctHumanOverlayData || {};
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'copy_pass' }); } catch {}
              const ok = await copyText(d.password || '');
              try { $('hint').textContent = ok ? 'Senha copiada.' : 'Falha ao copiar senha.'; } catch {}
            });
            $('hide')?.addEventListener('click', () => {
              try { host.style.display = 'none'; } catch {}
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'hide' }); } catch {}
            });
            $('robe24h')?.addEventListener('click', async () => {
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'robe_24h_click' }); } catch {}
              try { $('hint').textContent = 'Aplicando Robe 24h...'; } catch {}
              try { $('robe24h').disabled = true; } catch {}
              try {
                if (typeof window.__ctHumanOverlayRobe24h === 'function') {
                  const r = await window.__ctHumanOverlayRobe24h();
                  try { $('hint').textContent = (r && r.ok) ? 'Robe 24h aplicado.' : ('Falha ao aplicar Robe 24h: ' + String((r && r.error) ? r.error : 'unknown')); } catch {}
                } else {
                  try { $('hint').textContent = 'Falha: binding Robe 24h indisponível. Aguarde resincronização.'; } catch {}
                }
              } catch (e) {
                try { $('hint').textContent = 'Falha ao aplicar Robe 24h.'; } catch {}
              }
              try { $('robe24h').disabled = false; } catch {}
            });
            $('closeBrowser')?.addEventListener('click', async () => {
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'close_browser_click' }); } catch {}
              try { $('hint').textContent = 'Fechando navegador...'; } catch {}
              try { $('closeBrowser').disabled = true; } catch {}
              try {
                if (typeof window.__ctHumanOverlayCloseBrowser === 'function') {
                  const r = await window.__ctHumanOverlayCloseBrowser();
                  try { $('hint').textContent = (r && r.ok) ? 'Navegador fechado.' : ('Falha ao fechar navegador: ' + String((r && r.error) ? r.error : 'unknown')); } catch {}
                } else {
                  try { $('hint').textContent = 'Falha: binding fechar navegador indisponível. Aguarde resincronização.'; } catch {}
                }
              } catch {
                try { $('hint').textContent = 'Falha ao fechar navegador.'; } catch {}
              }
              try { $('closeBrowser').disabled = false; } catch {}
            });
            $('deleteAcc')?.addEventListener('click', async () => {
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'delete_account_click' }); } catch {}
              // Dupla confirmação (ultra enterprise): exige digitar EXCLUIR.
              try {
                const ok1 = confirm('Excluir conta: isso vai fechar o navegador, remover do servidor e enviar pro CT (estoque excluídas). Continuar?');
                if (!ok1) return;
                const typed = prompt('Digite EXCLUIR para confirmar:');
                if (String(typed || '').trim().toUpperCase() !== 'EXCLUIR') {
                  try { $('hint').textContent = 'Exclusão cancelada (confirmação inválida).'; } catch {}
                  return;
                }
              } catch {}
              try { $('hint').textContent = 'Excluindo conta...'; } catch {}
              try { $('deleteAcc').disabled = true; } catch {}
              try {
                if (typeof window.__ctHumanOverlayDeleteAccount === 'function') {
                  const r = await window.__ctHumanOverlayDeleteAccount();
                  try { $('hint').textContent = (r && r.ok) ? 'Conta excluída com sucesso.' : ('Falha ao excluir conta: ' + String((r && r.error) ? r.error : 'unknown')); } catch {}
                } else {
                  try { $('hint').textContent = 'Falha: binding excluir conta indisponível. Aguarde resincronização.'; } catch {}
                }
              } catch {
                try { $('hint').textContent = 'Falha ao excluir conta.'; } catch {}
              }
              try { $('deleteAcc').disabled = false; } catch {}
            });
            $('resume')?.addEventListener('click', async () => {
              try { window.__ctHumanOverlayLog && window.__ctHumanOverlayLog({ event:'resume_click' }); } catch {}
              try { $('hint').textContent = 'Retomando...'; } catch {}
              try { $('resume').disabled = true; } catch {}
              try {
                if (typeof window.__ctHumanOverlayResume === 'function') {
                  await window.__ctHumanOverlayResume();
                  try { $('hint').textContent = 'Retomada solicitada. Aguarde...'; } catch {}
                } else {
                  try { $('hint').textContent = 'Falha: binding de retomar indisponível. Aguarde resincronização.'; } catch {}
                }
              } catch {}
              try { $('resume').disabled = false; } catch {}
            });

            return host;
          }

          function render() {
            const d = window.__ctHumanOverlayData || null;
            const enabled = !!(d && d.enabled === true);
            const host = document.getElementById(HOST_ID);
            if (!enabled) {
              if (host) host.style.display = 'none';
              return;
            }
            const h = ensureHost();
            try { h.style.display = 'block'; } catch {}
            const shadow = h.shadowRoot;
            if (!shadow) return;
            const $ = (id) => shadow.getElementById(id);
            const nome = [d.nome, d.label ? `— ${d.label}` : '', d.cidade ? `(${d.cidade})` : ''].filter(Boolean).join(' ');
            $('nome').textContent = nome;
            $('reason').textContent = String(d.reason || '');
            $('login').textContent = String(d.login || '');
            $('pass').textContent = String(d.password || '');
            $('sub').textContent = `Atualizado: ${nowIso()}`;

            const f = d.flags || {};
            let statusTxt = '';
            if (f.banned) statusTxt = 'Conta suspensa/banida';
            else if (f.twoFactor) statusTxt = '2FA requerido (Humano)';
            else if (f.captchaCheckpoint) statusTxt = 'Captcha/Checkpoint (humano)';
            else if (f.identitySubmitted) statusTxt = 'Identidade em análise (monitor 1h)';
            else if (f.identityRequired) statusTxt = 'Confirmação de identidade (selfie/vídeo)';
            else if (f.appealSubmitted) statusTxt = 'Recurso em análise (monitor 1h)';
            else if (f.loginRemediateFailed) statusTxt = 'Login/Cookies falhou (humano)';
            else if (f.loginRequired) statusTxt = 'Login requerido';
            else statusTxt = 'Modo humano ativo';
            $('hint').textContent = statusTxt;
          }

          window.__ctHumanOverlaySetData = (d) => {
            try { window.__ctHumanOverlayData = d || {}; } catch {}
            try { render(); } catch {}
          };
          window.__ctHumanOverlayHide = () => {
            try {
              const h = document.getElementById(HOST_ID);
              if (h) h.style.display = 'none';
            } catch {}
          };

          window.addEventListener('DOMContentLoaded', () => { try { render(); } catch {} }, { once: true });
          // Resiliência: se SPA mexer no DOM e remover, recria.
          setInterval(() => { try { render(); } catch {} }, 5000);
        } catch {}
      };
      // 1) Para futuras navegações
      await page.evaluateOnNewDocument(overlayInstall);
      // 2) Para a página atual (senão o overlay só aparece após navegar/recarregar)
      await page.evaluate(overlayInstall).catch(()=>{});
    } catch {}
  } catch {}
}

async function syncHumanOverlay(nome) {
  try {
    // Enterprise: permitir "force overlay" mesmo se HUMAN_OVERLAY=0 (útil para captcha/checkpoint).
    // Isso evita ficar sem painel (login/senha/botões) quando o humano é realmente necessário.
    const now0 = Date.now();
    const forceUntil = Number(robeMeta?.[nome]?.forceOverlayUntil || 0) || 0;
    const forced = (forceUntil && forceUntil > now0);
    if (!HUMAN_OVERLAY_CFG.enabled && !forced) {
      try { provisionAudit.append({ ts: now0, event: 'human_overlay_disabled', nome: String(nome || ''), env: String(process.env.HUMAN_OVERLAY || '').trim() }); } catch {}
      return;
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return;

    const desired = readJsonFile(desiredPath, { perfis: {} });
    const wantHold = !!(desired && desired.perfis && desired.perfis[nome] && desired.perfis[nome].humanHold === true);
    const want = forced || wantHold || (ctrl.humanControl === true);

    const pages = await ctrl.browser.pages().catch(()=>[]);
    const data = want ? await _buildHumanOverlayData(nome) : { enabled: false, nome: String(nome || ''), ts: Date.now() };

    const diag = [];
    const scanned = (pages || []).slice(0, HUMAN_OVERLAY_CFG.maxPagesScan);
    for (const pg of scanned) {
      if (!pg) continue;
      if (want) {
        await _installOverlayOnPage(nome, pg);
      }
      await _setOverlayDataOnPage(pg, data);
      // Diagnóstico enterprise: prova irrefutável de que o overlay foi instalado/atualizado nesta aba.
      try {
        const d = await pg.evaluate(() => {
          try {
            const hostId = 'ct-human-overlay-host';
            return {
              url: (typeof location !== 'undefined' && location && location.href) ? String(location.href) : '',
              installed: !!window.__ctHumanOverlayInstalled,
              hasSetData: typeof window.__ctHumanOverlaySetData === 'function',
              hasResume: typeof window.__ctHumanOverlayResume === 'function',
              hasHost: !!document.getElementById(hostId),
              hostVisible: (() => {
                try {
                  const h = document.getElementById(hostId);
                  if (!h) return false;
                  const ds = String((h.style && h.style.display) || '');
                  return ds !== 'none';
                } catch { return false; }
              })()
            };
          } catch (e) {
            return { url: '', installed: false, hasSetData: false, hasResume: false, hasHost: false, hostVisible: false, error: String(e && e.message || e) };
          }
        }).catch((e) => ({ url: '', installed: false, hasSetData: false, hasResume: false, hasHost: false, hostVisible: false, error: String(e && e.message || e) }));
        diag.push(d);
      } catch (e) {
        diag.push({ url: '', installed: false, hasSetData: false, hasResume: false, hasHost: false, hostVisible: false, error: String(e && e.message || e) });
      }
    }
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'human_overlay_sync',
        nome: String(nome || ''),
        wantHold: !!wantHold,
        want: !!want,
        forced: !!forced,
        pagesCount: Array.isArray(pages) ? pages.length : 0,
        scanned: scanned.length,
        diag: diag.slice(0, 4) // evita log gigante
      });
    } catch {}
  } catch {}
}

async function ensureHumanOverlay(nome, ctrl, { reason = '' } = {}) {
  try {
    const force = /captcha|checkpoint|invoke_human|captcha_checkpoint/i.test(String(reason || '').toLowerCase());
    if (!HUMAN_OVERLAY_CFG.enabled && !force) {
      try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_ensure_skipped_disabled', nome: String(nome || ''), reason: String(reason || '').slice(0, 120) }); } catch {}
      return;
    }
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return;
    // Evidência enterprise (sem credenciais)
    try { provisionAudit.append({ ts: Date.now(), event: 'human_overlay_installed', nome: String(nome || ''), reason: String(reason || '').slice(0, 120) }); } catch {}

    // Instala nos pages atuais + sincroniza data.
    if (force) {
      // janela curta onde o sync deve acontecer mesmo se HUMAN_OVERLAY=0
      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].forceOverlayUntil = Date.now() + 60_000;
      } catch {}
    }
    await syncHumanOverlay(nome);

    // Hook para novas abas (1x por perfil).
    robeMeta[nome] = robeMeta[nome] || {};
    if (robeMeta[nome].humanOverlayHooked === true) return;
    robeMeta[nome].humanOverlayHooked = true;
    try {
      ctrl.browser.on('targetcreated', async (t) => {
        try {
          if (!t || typeof t.type !== 'function') return;
          if (t.type() !== 'page') return;
          const pg = await t.page().catch(()=>null);
          if (!pg) return;
          await syncHumanOverlay(nome);
        } catch {}
      });
    } catch {}
  } catch {}
}

// ===== Recurso/Apelação (monitoramento) =====
const APPEAL_CFG = {
  intervalMs: 60 * 60 * 1000,      // 1h
  firstDelayMs: 60 * 60 * 1000,    // 1h (timer inicial após "Retomar trabalho")
  maxPagesScan: 8
};

// Reload enterprise (anti-loop infinito):
// - não engole falhas silenciosamente
// - fallback: goto(url atual) e, se necessário, goto('https://www.facebook.com/')
// - logs explícitos para auditoria (prova 110% do que aconteceu)
function isProxyTunnelLikeError(msg) {
  const m = String(msg || '');
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|Navigation timeout|timed out|proxy/i.test(m);
}

async function reportWorkerProxyIssueByName(nome, reason, context = {}) {
  try {
    if (!nome) return;
    const manifest = await manifestStore.read(nome).catch(() => null);
    const resolved = gatewayProxy.resolveProxyForProfile({ profileName: nome, manifest });
    if (!resolved || resolved.enabled !== true) return;
    await gatewayProxy.reportProxyIssue({
      resolved,
      reason: String(reason || 'worker_proxy_issue').slice(0, 120),
      context
    });
  } catch {}
}

async function reloadPageEnterprise(pg, { nome = '', tag = 'monitor', timeoutMs = 45_000 } = {}) {
  const t0 = Date.now();
  const safeUrl = () => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
  const u0 = safeUrl();
  let ok = false;
  let method = '';
  let error = null;
  try { await pg.bringToFront?.().catch(()=>{}); } catch {}
  // Desabilitar cache só durante o reload (evita “tela antiga” em SPAs)
  try { if (pg && typeof pg.setCacheEnabled === 'function') await pg.setCacheEnabled(false).catch(()=>{}); } catch {}
  try {
    await pg.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    ok = true;
    method = 'reload';
  } catch (e1) {
    error = (e1 && e1.message) ? String(e1.message).slice(0, 180) : String(e1).slice(0, 180);
  }
  if (!ok) {
    // Fallback 1: goto URL atual (mais forte que reload em alguns casos)
    try {
      const u = safeUrl() || u0;
      if (u && !/^about:/i.test(u)) {
        await pg.goto(u, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 60_000) });
        ok = true;
        method = 'goto_same_url';
        error = null;
      }
    } catch (e2) {
      error = (e2 && e2.message) ? String(e2.message).slice(0, 180) : String(e2).slice(0, 180);
      if (isProxyTunnelLikeError(error)) {
        await reportWorkerProxyIssueByName(nome, 'worker_reload_goto_same_failed', { tag: String(tag || '').slice(0, 60), error: String(error || '').slice(0, 220) });
      }
    }
  }
  if (!ok) {
    // Fallback 2: navegação determinística (estado real do FB)
    try {
      await pg.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 70_000) });
      ok = true;
      method = 'goto_facebook_home';
      error = null;
    } catch (e3) {
      error = (e3 && e3.message) ? String(e3.message).slice(0, 180) : String(e3).slice(0, 180);
      if (isProxyTunnelLikeError(error)) {
        await reportWorkerProxyIssueByName(nome, 'worker_reload_home_failed', { tag: String(tag || '').slice(0, 60), error: String(error || '').slice(0, 220) });
      }
    }
  }
  // Pós-navegação: alguns fluxos do FB abrem modal "Você está de volta ao Facebook".
  // Se não clicar, o sistema pode "achar" login_required/appeal por texto antigo e ficar engessado.
  try {
    const did = await (async () => {
      try {
        return await pg.evaluate(() => {
          function norm(s){ try{ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }catch{return String(s||'').toLowerCase();} }
          const txt = norm(document.body ? (document.body.innerText || document.body.textContent || '') : '');
          const hit =
            txt.includes('voce esta de volta ao facebook') ||
            txt.includes("você está de volta ao facebook") ||
            txt.includes("sua conta nao esta mais suspensa") ||
            txt.includes("sua conta não está mais suspensa") ||
            txt.includes("you're back on facebook") ||
            txt.includes('your account is no longer suspended');
          if (!hit) return { ok: true, did: false };
          const dialog = document.querySelector('div[role="dialog"]') || document;
          // Preferir CTA principal
          const btn = Array.from(dialog.querySelectorAll('[role="button"],button,a[role="button"]')).find(el => {
            const t = norm(el.innerText || el.textContent || '');
            const al = norm(el.getAttribute('aria-label') || '');
            return t.includes('voltar para o facebook') || al.includes('voltar para o facebook') || t.includes('back to facebook') || al.includes('back to facebook');
          });
          if (btn && typeof btn.click === 'function') { btn.click(); return { ok: true, did: true, kind: 'back_to_facebook' }; }
          // Fallback: fechar modal
          const closeBtn = Array.from(dialog.querySelectorAll('[role="button"],button')).find(el => {
            const al = norm(el.getAttribute('aria-label') || '');
            const t = norm(el.innerText || el.textContent || '');
            return al === 'fechar' || al === 'close' || t === 'fechar' || t === 'close';
          });
          if (closeBtn && typeof closeBtn.click === 'function') { closeBtn.click(); return { ok: true, did: true, kind: 'close' }; }
          return { ok: true, did: false, kind: 'not_found' };
        });
      } catch {
        return { ok: false, did: false, kind: 'eval_failed' };
      }
    })();
    if (did && did.did) {
      try { provisionAudit.append({ ts: Date.now(), event: `${String(tag||'monitor')}_back_to_fb_dialog`, nome: String(nome||''), ok: !!did.ok, did: true, kind: did.kind || null }); } catch {}
      await sleep(900);
    }
  } catch {}
  try { if (pg && typeof pg.setCacheEnabled === 'function') await pg.setCacheEnabled(true).catch(()=>{}); } catch {}
  const durMs = Date.now() - t0;
  try {
    provisionAudit.append({
      ts: Date.now(),
      event: `${String(tag||'monitor')}_reload`,
      nome: String(nome || ''),
      ok: !!ok,
      method: method || null,
      durMs,
      urlBefore: String(u0 || '').slice(0, 220),
      urlAfter: String(safeUrl() || '').slice(0, 220),
      error
    });
  } catch {}
  return { ok: !!ok, method, durMs, error, urlBefore: u0, urlAfter: safeUrl() };
}

// Anti-tela-preta (about:blank) ao abrir em modo humano:
// Garante que exista uma aba real navegada ANTES de invocar humano/overlay.
async function ensureHumanNonBlankEntryPage(nome, ctrl, { prefer = 'facebook', reasonBase = 'human_entry' } = {}) {
  try {
    if (!ctrl || !ctrl.browser) return { ok: false, error: 'no_browser' };
    const pages = await ctrl.browser.pages().catch(()=>[]);
    let p0 = pages && pages[0];
    let u0 = '';
    try { u0 = (p0 && typeof p0.url === 'function') ? String(p0.url() || '') : ''; } catch { u0 = ''; }
    // Fluxo enterprise: NÃO criar novas abas só porque a aba 0 está em about:blank.
    // A aba 0 é navegável e deve ser reaproveitada (senão abrimos 2+ abas no bootstrap e o sistema “desgoverna”).
    if (!p0) {
      p0 = await ctrl.browser.newPage().catch(()=>null);
      if (p0) {
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const coords = browserHelper.resolvePatchCoordsForProfile(nome, man || {});
          await browserHelper.patchPage(nome, p0, coords).catch(()=>{});
        } catch {}
      }
    }
    if (!p0) return { ok: false, error: 'no_page' };
    try { await p0.bringToFront?.().catch(()=>{}); } catch {}

    const targetUrl =
      (prefer === 'messenger')
        ? 'https://www.messenger.com/marketplace'
        : 'https://www.facebook.com/';
    try {
      await p0.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (eNav) {
      const em = (eNav && eNav.message) ? String(eNav.message) : String(eNav || '');
      if (isProxyTunnelLikeError(em)) {
        await reportWorkerProxyIssueByName(nome, 'worker_human_entry_nav_failed', {
          stage: 'ensure_human_non_blank_entry',
          targetUrl: String(targetUrl || '').slice(0, 180),
          error: em.slice(0, 220)
        });
      }
      throw eNav;
    }
    await sleep(900);

    // Destravar UI (fecha modais, etc)
    try { await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase, allowGpt: true, maxRounds: 2 }).catch(()=>null); } catch {}
    ctrl.mainPage = p0;

    // Limpa abas about:blank órfãs para não ficar "Abas: 2" e economizar RAM
    try {
      const ps = await ctrl.browser.pages().catch(()=>[]);
      for (const pg of (ps || [])) {
        if (!pg || pg === p0) continue;
        const uu = (() => { try { return pg.url ? String(pg.url()||'') : ''; } catch { return ''; } })();
        if (!uu || uu === 'about:blank') {
          try { await pg.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
        }
      }
    } catch {}
    return { ok: true, url: targetUrl };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

// Anti-tela-preta (about:blank) para aberturas "open/open-all":
// - Não invoca humano.
// - Garante que exista uma aba navegada para que detectores consigam rodar.
async function ensureNonBlankEntryPage(nome, ctrl, { prefer = 'facebook', reasonBase = 'open_entry' } = {}) {
  try {
    const r = await ensureHumanNonBlankEntryPage(nome, ctrl, { prefer, reasonBase }).catch(()=>null);
    return r && r.ok ? r : { ok: false, error: (r && r.error) ? r.error : 'failed' };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

// Probe enterprise pós-abertura (anti-engessamento):
// - garante que as flags reflitam a tela REAL (identity/appeal/captcha/login_form)
// - não deixa "invocar humano" virar estado final por engano
// Retorna { ok, state, reason }
async function probeHumanStateOnOpen(nome, ctrl, { source = 'open_human' } = {}) {
  try {
    // Ultra enterprise: em alguns boots o ctrl.mainPage pode ainda não estar setado (race).
    // Não podemos "ficar cego" e pular o probe — isso causa o sintoma "às vezes clica Continuar, às vezes não".
    let pg = (ctrl && ctrl.mainPage) ? ctrl.mainPage : null;
    if (!pg) {
      try {
        const pages = (ctrl && ctrl.browser) ? await ctrl.browser.pages().catch(()=>[]) : [];
        const safeUrl = (p) => { try { return (p && typeof p.url === 'function') ? String(p.url() || '') : ''; } catch { return ''; } };
        const pick = () => {
          for (const p of (pages || []).slice(0, 8)) {
            const u = safeUrl(p);
            if (/facebook\.com|messenger\.com/i.test(u)) return p;
          }
          return (pages && pages[0]) || null;
        };
        pg = pick();
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'open_human_probe_pick_fallback',
            nome: String(nome||''),
            source: String(source||''),
            pagesCount: Array.isArray(pages) ? pages.length : 0,
            pickedUrl: pg ? safeUrl(pg).slice(0, 240) : null
          });
        } catch {}
      } catch {}
    }
    if (!pg) {
      try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_no_page', nome: String(nome||''), source: String(source||'') }); } catch {}
      return { ok: false, error: 'no_page' };
    }
    const _src = String(source || '');
    const _isOpenAll = /open_all/i.test(_src);

    // 0) Ban/Suspensão
    try {
      const bd = await browserHelper.detectAccountSuspended(pg).catch(()=>({ banned:false }));
      if (bd && bd.banned) {
        try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_banned', nome: String(nome||''), source: String(source||''), reason: String(bd.reason||'banned').slice(0,140) }); } catch {}
        try { await setBannedFlag(nome, { reason: String(bd.reason || 'banned'), snippet: String(bd.snippet || '') }); } catch {}
        return { ok: true, state: 'banned', reason: bd.reason || '' };
      }
    } catch {}

    // 1) LoginRequired/Identity/Appeal/Captcha
    const lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:false }));
    if (!lr || lr.loginRequired !== true) {
      // 1) Messenger OK — antes de liberar trabalho, checar Robe (Facebook create) em uma aba curta e fechar.
      try { provisionAudit.append({ ts: Date.now(), event: 'bootstrap_messenger_ok', nome: String(nome||''), source: String(source||'') }); } catch {}

      // Espera UI real do Messenger Marketplace (anti-atropelo).
      try {
        const tMsg0 = Date.now();
        let okMsg = false;
        let errMsg = '';
        try {
          await virtusHelper.garantirMarketplace(pg, { timeoutMs: 45000 });
          okMsg = true;
        } catch (e) {
          okMsg = false;
          errMsg = (e && e.message) ? String(e.message) : String(e);
        }
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'bootstrap_messenger_ready',
            nome: String(nome||''),
            source: String(source||''),
            ok: !!okMsg,
            durMs: Date.now() - tMsg0,
            error: okMsg ? null : String(errMsg || '').slice(0, 180),
            url: (() => { try { return String(pg.url() || ''); } catch { return ''; } })()
          });
        } catch {}
        if (!okMsg) {
          // Enterprise hardening:
          // Se o Messenger não ficou pronto, pode ser porque estamos em tela de captcha/identity/checkpoint.
          // Antes de "engessar", re-probar loginRequired e encaminhar.
          try {
            const lr2 = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:false }));
            if (lr2 && lr2.loginRequired) {
              const rr2 = String(lr2.reason || '').toLowerCase();
              try { provisionAudit.append({ ts: Date.now(), event: 'bootstrap_messenger_not_ready_lr', nome: String(nome||''), source: String(source||''), reason: rr2.slice(0,160) }); } catch {}
              if (rr2.includes('captcha_persona_pre_screen') || rr2.includes('captcha_persona') || rr2.includes('checkpoint_captcha')) {
                try {
                  const c = controllers.get(nome) || ctrl;
                  const p2 = (c && c.mainPage) ? c.mainPage : pg;
                  if (c && p2) runCaptchaFlow(nome, c, p2, { source: `bootstrap_messenger_not_ready:${String(source||'')}`, force: true }).catch(()=>{});
                } catch {}
                try { await setLoginRequiredFlag(nome, { reason: lr2.reason || rr2, source: lr2.domain || source }); } catch {}
                return { ok: true, state: 'captcha_flow_scheduled', reason: rr2 };
              }
              if (rr2.includes('identity')) {
                try { await setIdentityRequiredFlag(nome, { source: lr2.domain || source, url: lr2.url || '', title: lr2.title || '' }); } catch {}
                try {
                  const c = controllers.get(nome) || ctrl;
                  const p2 = (c && c.mainPage) ? c.mainPage : pg;
                  if (c && p2) runIdentityFlow(nome, c, p2, { source: `bootstrap_messenger_not_ready:${String(source||'')}`, force: true }).catch(()=>{});
                } catch {}
                return { ok: true, state: 'identity_required', reason: rr2 };
              }
              // Outros loginRequired: não libera trabalho; devolve evidência.
              return { ok: false, error: 'messenger_marketplace_not_ready_login_required', reason: rr2 };
            }
          } catch {}
          // Não avança para Robe nem libera trabalho se o Messenger não ficou realmente pronto.
          return { ok: false, error: 'messenger_marketplace_not_ready' };
        }
      } catch {}

      // Política militar: NÃO abrir aba extra de create no bootstrap por padrão.
      // Isso elimina navegação obsoleta de verificação em aba 1 e reduz concorrência.
      let robeProbe = null;
      const enableBootstrapRobeProbe = String(process.env.BOOTSTRAP_ROBE_PROBE_ENABLED || '0') === '1' && !_isOpenAll;
      if (enableBootstrapRobeProbe) {
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const robeMode = (man && man.robeMode) ? String(man.robeMode) : 'itens';
          const targetUrl = (robeMode === 'veiculos')
            ? 'https://www.facebook.com/marketplace/create/vehicle'
            : 'https://www.facebook.com/marketplace/create/item';
          const flowId = newFlowId('robe_probe');
          try { provisionAudit.append({ ts: Date.now(), event: 'bootstrap_robe_probe_begin', nome: String(nome||''), source: String(source||''), flowId, robeMode, targetUrl }); } catch {}

          // Janela curta e segura: abre aba, valida pronto de verdade, fecha.
          const tProbe0 = Date.now();
          const p = await ctrl.browser.newPage().catch(()=>null);
          if (!p) throw new Error('robe_probe_no_newPage');
          try { await wirePageObservers(nome, p); } catch {}
          // SUPRESSOR para o killer de about:blank durante patchPage+goto (20s de guarda) — igual ao Robe.
          try {
            const guard = (ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {});
            guard[nome] = Math.max(Number(guard[nome] || 0) || 0, Date.now() + 20000);
          } catch {}
          // PatchPage na aba 1 para consistência (coords/UA/stealth hooks)
          try {
            const coords = browserHelper.resolvePatchCoordsForProfile(nome, man || {});
            await browserHelper.patchPage(nome, p, coords).catch(()=>{});
          } catch {}
          const tNav0 = Date.now();
          try { await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
          const navDurMs = Date.now() - tNav0;
          // Espera sinais reais de create (anti-atropelo), com timeout curto.
          const tReady0 = Date.now();
          let okReady = false;
          try {
            okReady = await p.waitForFunction((want) => {
              try {
                const href = String(location && location.href ? location.href : '');
                const path = String(location && location.pathname ? location.pathname : '');
                if (!href || href === 'about:blank') return false;
                if (want === 'vehicle') {
                  if (!/\/marketplace\/create\/vehicle\b/i.test(path)) return false;
                } else {
                  if (!/\/marketplace\/create\/item\b/i.test(path)) return false;
                }
                const hasMain = !!document.querySelector('div[role="main"]');
                const hasFile = !!document.querySelector('input[type="file"]');
                const hasAria = !!document.querySelector('[aria-label]');
                return hasMain && (hasFile || hasAria);
              } catch { return false; }
            }, { timeout: 20000 }, (robeMode === 'veiculos') ? 'vehicle' : 'item').catch(()=>false);
          } catch { okReady = false; }
          const readyDurMs = Date.now() - tReady0;
          // Não fechar instantâneo: garantir que houve tempo mínimo de validação (anti-flake visual).
          const minHoldMs = parseInt(process.env.BOOTSTRAP_ROBE_MIN_HOLD_MS || '1800', 10);
          const elapsed = Date.now() - tProbe0;
          if (minHoldMs > elapsed) {
            try { await sleep(minHoldMs - elapsed); } catch {}
          }
          try { await browserHelper.ensureFbUiUnblocked(p, nome, { reasonBase: 'bootstrap_robe_probe', allowGpt: true, maxRounds: 2 }).catch(()=>null); } catch {}
          const lr2 = await browserHelper.detectLoginRequired(p).catch(()=>({ loginRequired:false }));
          robeProbe = { ok: true, robeMode, targetUrl, lr: lr2 };
          let u1 = ''; let t1 = '';
          try { u1 = (typeof p.url === 'function') ? String(p.url() || '') : ''; } catch {}
          try { t1 = (typeof p.title === 'function') ? String(await p.title().catch(()=>'')) : ''; } catch {}
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'bootstrap_robe_probe_end',
              nome: String(nome||''),
              source: String(source||''),
              flowId,
              ok: true,
              robeMode,
              targetUrl,
              navDurMs,
              readyOk: !!okReady,
              readyDurMs,
              finalUrl: String(u1||'').slice(0, 260),
              title: String(t1||'').slice(0, 200),
              loginRequired: !!(lr2 && lr2.loginRequired),
              reason: String((lr2 && lr2.reason) ? lr2.reason : '').slice(0, 160)
            });
          } catch {}
          try { await p.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
        } catch (e) {
          robeProbe = { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
          try { provisionAudit.append({ ts: Date.now(), event: 'bootstrap_robe_probe_end', nome: String(nome||''), source: String(source||''), ok: false, error: String(robeProbe.error||'').slice(0, 180) }); } catch {}
        }
      } else {
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'bootstrap_robe_probe_skipped',
            nome: String(nome||''),
            source: String(source||''),
            reason: _isOpenAll ? 'open_all' : 'disabled_by_default'
          });
        } catch {}
      }

      // 2) Se o Robe probe achou bloqueio (captcha/login/identity/appeal), NÃO liberar “clear”.
      try {
        const lr2 = robeProbe && robeProbe.ok && robeProbe.lr ? robeProbe.lr : null;
        if (lr2 && lr2.loginRequired === true) {
          const rr2 = String(lr2.reason || '').toLowerCase();
          try { provisionAudit.append({ ts: Date.now(), event: 'bootstrap_robe_probe_login_required', nome: String(nome||''), source: String(source||''), reason: String(lr2.reason||'').slice(0,160) }); } catch {}

          if (rr2.includes('identity_submitted')) {
            try { await setIdentitySubmittedFlag(nome, { source: lr2.domain || source, url: lr2.url || '', title: lr2.title || '' }); } catch {}
            return { ok: true, state: 'identity_submitted', reason: rr2 };
          }
          if (rr2.includes('identity')) {
            try { await setIdentityRequiredFlag(nome, { source: lr2.domain || source, url: lr2.url || '', title: lr2.title || '' }); } catch {}
            // iniciar fluxo de identidade (gate+cooldown já protegem)
            setTimeout(() => {
              try {
                const c = controllers.get(nome);
                const p0 = (c && c.mainPage) ? c.mainPage : pg;
                if (c && p0) runIdentityFlow(nome, c, p0, { source: `bootstrap_robe_probe:${String(source||'')}` }).catch(()=>{});
              } catch {}
            }, 0);
            return { ok: true, state: 'identity_required', reason: rr2 };
          }
          if (rr2.includes('appeal_submitted') || rr2.includes('appeal')) {
            try { await setAppealSubmittedFlag(nome, { source: lr2.domain || source, url: lr2.url || '', title: lr2.title || '' }); } catch {}
            try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
            return { ok: true, state: 'appeal_submitted', reason: rr2 };
          }
          // Captcha: NÃO invocar humano aqui. Agenda o captcha flow (governança própria + N tentativas).
          if (rr2.includes('captcha') || rr2.includes('checkpoint')) {
            try { provisionAudit.append({ ts: Date.now(), event: 'bootstrap_robe_probe_captcha_flow_schedule', nome: String(nome||''), source: String(source||''), reason: rr2.slice(0,160) }); } catch {}
            try {
              const c = controllers.get(nome);
              const p0 = (c && c.mainPage) ? c.mainPage : pg;
              if (c && p0) runCaptchaFlow(nome, c, p0, { source: `bootstrap_robe_probe:${String(source||'')}`, force: true }).catch(()=>{});
            } catch {}
            try { await setLoginRequiredFlag(nome, { reason: rr2 || 'captcha', source: lr2.domain || source }); } catch {}
            return { ok: true, state: 'captcha_flow_scheduled', reason: rr2 };
          }
          // login_form / outros: marca loginRequired e deixa pipeline tratar (login_remediate/humano conforme regras já existentes)
          try { await setLoginRequiredFlag(nome, { reason: lr2.reason || rr2, source: lr2.domain || source }); } catch {}
          return { ok: true, state: 'login_required', reason: rr2 };
        }
      } catch {}

      // 3) Se Messenger OK (+ Robe OK quando aplicável) => agora sim “clear”.
      try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_clear', nome: String(nome||''), source: String(source||'') }); } catch {}
      // Se abriu "human-only" por flag velha e já está OK, liberar automação.
      try { await clearAppealSubmittedFlag(nome); } catch {}
      try { await clearIdentityFlags(nome); } catch {}
      try { await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed','messengerPin']); } catch {}
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d = d || {}; d.perfis = d.perfis || {};
          const prev = d.perfis[nome] || {};
          // Em open_all: NÃO ligar Virtus automaticamente (mantém estado do desired/open_all_map).
          const nextVirtus = _isOpenAll ? (prev.virtus || 'off') : 'on';
          d.perfis[nome] = { ...prev, active: true, humanHold: false, virtus: nextVirtus };
          return d;
        });
      } catch {}
      // Em open_all: NÃO disparar start_work automaticamente.
      if (!_isOpenAll) {
        setTimeout(() => {
          try { handlers.start_work({ nome, operator: 'bulk_open_all_auto_probe' }).catch(()=>{}); } catch {}
        }, 0);
      }
      return { ok: true, state: 'not_login_required' };
    }

    const rr = String(lr.reason || '').toLowerCase();
    try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_login_required', nome: String(nome||''), source: String(source||''), reason: String(lr.reason||'').slice(0,160) }); } catch {}

    if (rr.includes('identity_submitted')) {
      try { await setIdentitySubmittedFlag(nome, { source: lr.domain || source, url: lr.url || '', title: lr.title || '' }); } catch {}
      return { ok: true, state: 'identity_submitted', reason: rr };
    }
    if (rr.includes('identity')) {
      try { await setIdentityRequiredFlag(nome, { source: lr.domain || source, url: lr.url || '', title: lr.title || '' }); } catch {}
      // Ultra enterprise: iniciar o fluxo de identidade imediatamente (sem travar activateOnce).
      // Guardrails: gate + debounce dentro de runIdentityFlow.
      setTimeout(() => {
        try {
          const c = controllers.get(nome);
          const p = (c && c.mainPage) ? c.mainPage : pg;
          if (c && p) runIdentityFlow(nome, c, p, { source: `probe:${String(source||'')}` }).catch(()=>{});
        } catch {}
      }, 0);
      return { ok: true, state: 'identity_required', reason: rr };
    }
    if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
      try { await setAppealSubmittedFlag(nome, { source: lr.domain || source, url: lr.url || '', title: lr.title || '' }); } catch {}
      try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
      return { ok: true, state: 'appeal_submitted', reason: rr };
    }
    // Captcha (pré-screen/captcha clássico): NÃO invocar humano imediatamente.
    // Regra do lead (2026-01-31): pre-screen deve auto-clicar "Continuar"; captcha deve tentar o fluxo (3 tentativas)
    // antes de cair em humano.
    if (rr.includes('captcha_persona_pre_screen') || rr.includes('captcha_persona') || rr.includes('checkpoint_captcha')) {
      try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_captcha_flow_begin', nome: String(nome||''), source: String(source||''), reason: rr.slice(0, 160) }); } catch {}
      // Estado seguro imediato (não pode ficar Virtus/Robe rodando)
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d = d || {}; d.perfis = d.perfis || {};
          const prev = d.perfis[nome] || {};
          d.perfis[nome] = { ...prev, active: true, virtus: 'off', humanHold: false };
          return d;
        });
      } catch {}
      try { if (ctrl) ctrl.trabalhando = false; } catch {}
      try { await stopVirtus(nome); } catch {}

      // Se for pre-screen, tentar clicar "Continuar" uma vez e re-probe (sem delay artificial).
      if (rr.includes('captcha_persona_pre_screen')) {
        const clk = await browserHelper.clickContinueByLabel(pg, { maxWaitMs: 9000 }).catch(()=>({ ok:false, error:'click_failed' }));
        try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_pre_screen_click', nome: String(nome||''), source: String(source||''), ok: !!(clk && clk.ok), error: clk && clk.error ? String(clk.error).slice(0,120) : null }); } catch {}
      }

      // Reclassificar e encaminhar para o fluxo que já tem 3 tentativas (inclui OCR no captcha).
      const lr2 = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
      const rr2 = String((lr2 && lr2.reason) ? lr2.reason : rr).toLowerCase();
      try { provisionAudit.append({ ts: Date.now(), event: 'open_human_probe_captcha_flow_schedule', nome: String(nome||''), source: String(source||''), reason: rr2.slice(0,160) }); } catch {}
      try {
        const c = controllers.get(nome) || ctrl;
        const p = (c && c.mainPage) ? c.mainPage : pg;
        if (c && p) {
          runCaptchaFlow(nome, c, p, { source: `probe_captcha:${String(source||'')}`, force: true }).catch(()=>{});
        }
      } catch {}
      // Expor estado sem engessar (humano só será invocado no final do runIdentityFlow se falhar).
      try { await setLoginRequiredFlag(nome, { reason: rr2 || rr || 'captcha', source: lr.domain || source }); } catch {}
      return { ok: true, state: 'captcha_flow_scheduled', reason: rr2 };
    }

    // login_form / outros: se for "login/cookies falhou", aqui é válido invocar humano
    try { await setLoginRequiredFlag(nome, { reason: lr.reason || rr, source: lr.domain || source }); } catch {}
    return { ok: true, state: 'login_required', reason: rr };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function setAppealSubmittedFlag(nome, { source = '', url = '', title = '' } = {}) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.appealSubmitted = true;
      man.accountFlags.appealSubmittedAt = Number(man.accountFlags.appealSubmittedAt || 0) || Date.now();
      man.accountFlags.appealSource = String(source || '').slice(0, 80);
      man.accountFlags.appealUrl = String(url || '').slice(0, 300);
      man.accountFlags.appealTitle = String(title || '').slice(0, 200);
      // Por padrão, não começa a monitorar imediatamente: "Retomar trabalho" arma o monitor.
      if (!man.accountFlags.appealNextCheckAt) man.accountFlags.appealNextCheckAt = 0;
      man.accountFlags.appealLastReason = 'appeal_submitted';
      // Blindagem: ao entrar em recurso em análise, limpar flags antigas que mascaram o estado real.
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      delete man.accountFlags.loginRequired;
      delete man.accountFlags.loginReason;
      delete man.accountFlags.loginSource;
      delete man.accountFlags.lastLoginRequiredAt;
      // Mutual exclusivity (ultra enterprise):
      // Recurso em análise NÃO é "identidade em análise". Se detectamos appeal_submitted,
      // precisamos remover flags de identidade para o painel não ficar engessado em "identitySubmitted".
      delete man.accountFlags.identityRequired;
      delete man.accountFlags.identityRequiredAt;
      delete man.accountFlags.identitySubmitted;
      delete man.accountFlags.identitySubmittedAt;
      delete man.accountFlags.identitySource;
      delete man.accountFlags.identityUrl;
      delete man.accountFlags.identityTitle;
      delete man.accountFlags.identityNextCheckAt;
      delete man.accountFlags.identityLastCheckAt;
      delete man.accountFlags.identityLastReason;
      return man;
    });
    // Evidência enterprise: provision_audit é allowlisted via fetch_logs.
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_detected',
        nome: String(nome || ''),
        source: String(source || '').slice(0, 80),
        url: String(url || '').slice(0, 220),
        title: String(title || '').slice(0, 120)
      });
    } catch {}
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].appealSubmitted = true;
    robeMeta[nome].whyNotOpen = 'appeal_submitted';
    // Mutual exclusivity: não deixar runtime preso em identity_* quando já é appeal_submitted.
    try {
      if (robeMeta[nome].whyNotOpen && String(robeMeta[nome].whyNotOpen).startsWith('identity')) delete robeMeta[nome].whyNotOpen;
    } catch {}
    delete robeMeta[nome].loginRemediateFailed;
    delete robeMeta[nome].loginRemediateFailedReason;
    delete robeMeta[nome].loginRequired;
    delete robeMeta[nome].loginReason;
  } catch {}

  // Regra enterprise: "Recurso em análise" NÃO deve virar humano invocado automaticamente.
  // Mantém automação OFF (Virtus OFF), mas não seta humanHold.
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
      return d;
    });
  } catch {}
  try { const ctrl = controllers.get(nome); if (ctrl) { ctrl.trabalhando = false; try { await stopVirtus(nome); } catch {} } } catch {}
}

async function armAppealMonitor(nome, { delayMs = APPEAL_CFG.firstDelayMs } = {}) {
  if (isNonLrAutomationPaused()) {
    await enforcePausedNonLrState(nome, { kind: 'appeal_submitted', source: 'appeal_monitor' });
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_paused_by_policy',
        nome: String(nome || ''),
        delayMs: Math.max(60_000, Number(delayMs || 0) || 0)
      });
    } catch {}
    return { ok: true, pausedByPolicy: true };
  }
  try {
    const now = Date.now();
    const next = now + Math.max(60_000, Number(delayMs || 0) || 0);
    let skipped = false;
    let existingNext = 0;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      if (man.accountFlags.appealSubmitted !== true) return man;
      // Ultra enterprise: armamento idempotente.
      // Se já existe um "next check" no futuro, NÃO rearmar (isso reinicia o timer no painel e cria loop infinito).
      existingNext = Number(man.accountFlags.appealNextCheckAt || 0) || 0;
      if (existingNext && existingNext > (now + 30_000)) {
        skipped = true;
        return man;
      }
      man.accountFlags.appealLastArmedAt = now;
      man.accountFlags.appealNextCheckAt = next;
      return man;
    });
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: skipped ? 'appeal_monitor_arm_skipped' : 'appeal_monitor_armed',
        nome: String(nome || ''),
        nextAt: skipped ? existingNext : next,
        delayMs: skipped ? Math.max(0, existingNext - Date.now()) : Math.max(0, next - Date.now())
      });
    } catch {}
  } catch {}
}

async function clearAppealSubmittedFlag(nome) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      delete man.accountFlags.appealSubmitted;
      delete man.accountFlags.appealSubmittedAt;
      delete man.accountFlags.appealSource;
      delete man.accountFlags.appealUrl;
      delete man.accountFlags.appealTitle;
      delete man.accountFlags.appealNextCheckAt;
      delete man.accountFlags.appealLastCheckAt;
      delete man.accountFlags.appealLastReason;
      delete man.accountFlags.appealLastArmedAt;
      return man;
    });
    if (robeMeta[nome]) {
      delete robeMeta[nome].appealSubmitted;
      if (robeMeta[nome].whyNotOpen === 'appeal_submitted') delete robeMeta[nome].whyNotOpen;
    }
  } catch {}
}

async function appealMonitorCheckNow(nome, ctrl) {
  const now = Date.now();
  try {
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'no_browser' };
    const pages = await ctrl.browser.pages().catch(()=>[]);
    const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
    const pickFb = () => {
      // Prioridade: checkpoint/appeal (mais provável de refletir o estado)
      for (const pg of (pages || []).slice(0, APPEAL_CFG.maxPagesScan)) {
        const u = safeUrl(pg);
        if (!/facebook\.com/i.test(u)) continue;
        if (/checkpoint|appeal|help\/contact|recover/i.test(u)) return pg;
      }
      // Fallback: primeira aba facebook.com
      for (const pg of (pages || []).slice(0, APPEAL_CFG.maxPagesScan)) {
        const u = safeUrl(pg);
        if (/facebook\.com/i.test(u)) return pg;
      }
      return (pages && pages[0]) || null;
    };
    const pg = pickFb();
    if (!pg) return { ok: false, error: 'no_pages' };

    try {
      provisionAudit.append({
        ts: now,
        event: 'appeal_monitor_check_begin',
        nome: String(nome || ''),
        url: String(safeUrl(pg) || '').slice(0, 220)
      });
    } catch {}

    // Refresh enterprise (com fallback + log explícito)
    await reloadPageEnterprise(pg, { nome, tag: 'appeal_monitor', timeoutMs: 45_000 }).catch(()=>null);
    await sleep(900);
    // Primeiro: suspensão/ban (UI dedicada). Isso evita classificar errado como "appeal".
    try {
      const bd = await browserHelper.detectAccountSuspended(pg).catch(()=>({ banned:false }));
      if (bd && bd.banned) {
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'appeal_monitor_detected_banned',
            nome: String(nome || ''),
            reason: String(bd.reason || 'banned').slice(0, 140),
            snippet: String(bd.snippet || '').slice(0, 240)
          });
        } catch {}
        try { await setBannedFlag(nome, { reason: String(bd.reason || 'banned'), snippet: String(bd.snippet || '') }); } catch {}
        return { ok: true, transitioned: true, reason: 'banned', action: 'auto_delete_banned' };
      }
    } catch {}

    // Detecta estado após refresh. Se estiver em "appeal_submitted", faz uma navegação determinística (home)
    // para evitar falso-positivo por DOM/aba antiga.
    let lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
    try {
      const rr0 = String(lr && lr.reason || '').toLowerCase();
      if (lr && lr.loginRequired === true && rr0.includes('appeal_submitted')) {
        await reloadPageEnterprise(pg, { nome, tag: 'appeal_monitor_home_check', timeoutMs: 60_000 }).catch(()=>null);
        await sleep(900);
        lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
      }
    } catch {}

    // Atualiza telemetria do monitor
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        if (man.accountFlags.appealSubmitted !== true) return man;
        man.accountFlags.appealLastCheckAt = now;
        man.accountFlags.appealLastReason = lr && lr.loginRequired ? String(lr.reason || '') : '';
        man.accountFlags.appealNextCheckAt = now + APPEAL_CFG.intervalMs;
        return man;
      });
    } catch {}

    if (!lr || lr.loginRequired !== true) {
      // Liberou: limpa flags e retoma trabalho normal
      await clearAppealSubmittedFlag(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d.perfis = d.perfis || {};
          d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'on' };
          return d;
        });
      } catch {}
      try {
        ctrl.humanControl = false;
        if (automationAllowed(ctrl)) {
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
          ctrl.trabalhando = true;
        }
        try { unfreezeCooldownIfWorking(nome); } catch {}
      } catch {}
      try { await issues.append(nome, 'mil_action', 'appeal_monitor_resolved_active'); } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'appeal_monitor_resolved_active',
          nome: String(nome || '')
        });
      } catch {}
      return { ok: true, resolved: true };
    }

    // Ainda bloqueado.
    const rr = String(lr.reason || '').toLowerCase();
    if (rr.includes('appeal_submitted')) {
      try { await issues.append(nome, 'mil_action', 'appeal_monitor_still_pending'); } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'appeal_monitor_still_pending',
          nome: String(nome || ''),
          reason: String(lr.reason || '').slice(0, 200),
          nextAt: now + APPEAL_CFG.intervalMs
        });
      } catch {}
      return { ok: true, pending: true };
    }

    // Mudou para outro bloqueio (login/checkpoint/captcha etc).
    // Regra enterprise: SAIR do modo appeal_submitted assim que a tela mudar.
    // Caso contrário, o nurse fica preso no ramo de "appealSubmitted" e o perfil entra em loop infinito de 1h.
    try { await clearAppealSubmittedFlag(nome); } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_exit',
        nome: String(nome || ''),
        toReason: String(lr.reason || '').slice(0, 220),
        toDomain: String(lr.domain || '').slice(0, 80),
        url: String(lr.url || '').slice(0, 220)
      });
    } catch {}

    // 2FA: manter em modo humano (sem exclusão automática)
    if (rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor')) {
      try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(lr.title || '') }); } catch {}
      return { ok: false, transitioned: true, reason: 'two_factor', action: 'human_hold_two_factor' };
    }

    // Identidade: flags próprias (não virar loginRequired genérico).
    if (rr.includes('identity_submitted')) {
      try { await setIdentitySubmittedFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
      return { ok: true, transitioned: true, reason: 'identity_submitted', action: 'monitor_identity_1h' };
    }
    if (rr.includes('identity')) {
      try { await setIdentityRequiredFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
      return { ok: true, transitioned: true, reason: 'identity_required', action: 'human_identity' };
    }

    // Padrão: loginRequired
    try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' }); } catch {}
    try { await issues.append(nome, 'mil_action', `appeal_monitor_transition_exit reason=${rr}`); } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_transition_exit',
        nome: String(nome || ''),
        reason: String(lr.reason || '').slice(0, 220)
      });
    } catch {}

    // Política definida: se virar login_form, disparar pipeline de login_remediate automaticamente.
    if (rr.includes('login_form')) {
      const op = `appeal_monitor_login_form:${String(nome || '')}:${Date.now()}`;
      if (isNonLrAutomationPaused()) {
        try { provisionAudit.append({ ts: Date.now(), event: 'appeal_monitor_login_remediate_suppressed_by_policy', nome: String(nome||''), operator: op }); } catch {}
        return { ok: true, transitioned: true, reason: rr, action: 'login_remediate_suppressed_by_policy' };
      }
      try { provisionAudit.append({ ts: Date.now(), event: 'appeal_monitor_schedule_login_remediate', nome: String(nome||''), operator: op }); } catch {}
      setTimeout(() => {
        try { handlers.login_remediate({ nome, operator: op, options: { overrideHumanHold: true } }).catch(()=>{}); } catch {}
      }, 0);
      return { ok: true, transitioned: true, reason: rr, action: 'login_remediate_scheduled' };
    }

    return { ok: true, transitioned: true, reason: rr };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        if (man.accountFlags.appealSubmitted !== true) return man;
        man.accountFlags.appealLastCheckAt = now;
        man.accountFlags.appealLastReason = `error:${msg}`.slice(0, 120);
        man.accountFlags.appealNextCheckAt = now + APPEAL_CFG.intervalMs;
        return man;
      });
    } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'appeal_monitor_error',
        nome: String(nome || ''),
        error: String(msg || '').slice(0, 220),
        nextAt: now + APPEAL_CFG.intervalMs
      });
    } catch {}
    return { ok: false, error: msg };
  }
}

// ===== Identidade (selfie/vídeo) — monitoramento 1h =====
const IDENTITY_CFG = {
  intervalMs: 60 * 60 * 1000,      // 1h
  firstDelayMs: 60 * 60 * 1000,    // 1h (timer inicial após "identity_submitted")
  maxPagesScan: 8
};

// Identity Gate (ultra enterprise):
// - garante que apenas 1 fluxo de identidade "avance botões" por vez (global no host)
// - após qualquer ação (clique), NÃO aplica cooldown (apenas 1 por vez)
// - o timer de identidadeSubmitted (1h) é independente e "corre solto"
const IDENTITY_GATE = {
  // Requisito operacional (ROBE MÃE 5): evitar câmera "em uso" e travamentos.
  // Identidade deve rodar 1 por vez por host, com cooldown RANDOMIZADO 10–30min entre execuções.
  // Semântica desejada: o timer “corre livre”. Se não houver identidade, nada acontece;
  // quando aparecer uma, só roda se cooldown já expirou.
  cooldownMinMs: 0,
  cooldownMaxMs: 0,
  // O botão "Carregar" pode levar 20–120s para habilitar; manter lease maior evita expirar durante a espera.
  leaseMs: 4 * 60 * 1000 // lease curto o suficiente p/ evitar deadlock, longo o suficiente p/ completar a etapa
};

function _randIdentityCooldownMs() {
  const min = IDENTITY_GATE.cooldownMinMs;
  const max = IDENTITY_GATE.cooldownMaxMs;
  const span = Math.max(0, max - min);
  return min + Math.floor(Math.random() * (span + 1));
}

async function _identityGateTryAcquire({ owner = '', nome = '' } = {}) {
  const now = Date.now();
  const leaseUntil = now + IDENTITY_GATE.leaseMs;
  let denied = null;
  let snap = null;
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d = d || {};
      d._identityGate = d._identityGate || {};
      const g = d._identityGate;
      const curLease = Number(g.leaseUntil || 0) || 0;
      const curCooldown = Number(g.cooldownUntil || 0) || 0;
      if (curLease && curLease > now) {
        // Hardening: lease órfão após restart/crash.
        // Se o owner for "pid:<n>" e o processo não existir mais, limpa o lease imediatamente.
        try {
          const o = String(g.owner || '').trim();
          const m = /^pid:(\d+)$/.exec(o);
          if (m && m[1]) {
            const pid = Number(m[1]) || 0;
            if (pid && pid !== process.pid) {
              let alive = true;
              try { process.kill(pid, 0); alive = true; }
              catch (e) {
                const code = (e && e.code) ? String(e.code) : '';
                // ESRCH => não existe; EPERM => existe mas sem permissão (assume vivo)
                if (code === 'ESRCH') alive = false;
              }
              if (!alive) {
                g.leaseUntil = 0;
                g.leaseAt = 0;
                g.leaseProfile = '';
              }
            }
          }
        } catch {}
        const curLease2 = Number(g.leaseUntil || 0) || 0;
        if (curLease2 && curLease2 > now) {
          denied = { why: 'leased', leaseUntil: curLease2, owner: String(g.owner || '') };
          snap = { ...g };
          return d;
        }
      }
      if (curCooldown && curCooldown > now) {
        denied = { why: 'cooldown', cooldownUntil: curCooldown, lastActionAt: Number(g.lastActionAt || 0) || 0, lastActionProfile: String(g.lastActionProfile || '') };
        snap = { ...g };
        return d;
      }
      g.owner = String(owner || '').slice(0, 80);
      g.leaseUntil = leaseUntil;
      g.leaseAt = now;
      g.leaseProfile = String(nome || '').slice(0, 120);
      snap = { ...g };
      return d;
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
  if (denied) {
    try { provisionAudit.append({ ts: now, event: 'identity_gate_denied', nome: String(nome||''), why: denied.why, leaseUntil: denied.leaseUntil || null, cooldownUntil: denied.cooldownUntil || null, owner: denied.owner || null, lastActionAt: denied.lastActionAt || null, lastActionProfile: denied.lastActionProfile || null }); } catch {}
    return { ok: false, denied: true, ...denied, gate: snap };
  }
  try { provisionAudit.append({ ts: now, event: 'identity_gate_acquired', nome: String(nome||''), owner: String(owner||''), leaseUntil }); } catch {}
  return { ok: true, owner: String(owner||''), leaseUntil, gate: snap };
}

async function _identityGateRelease({ owner = '', nome = '', didAction = false, actionKind = '' } = {}) {
  const now = Date.now();
  const cooldownMs = didAction ? _randIdentityCooldownMs() : 0;
  const cooldownUntil = didAction ? (now + cooldownMs) : 0;
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d = d || {};
      d._identityGate = d._identityGate || {};
      const g = d._identityGate;
      // Só o dono limpa o lease (ou se lease expirou)
      const curOwner = String(g.owner || '');
      const curLease = Number(g.leaseUntil || 0) || 0;
      const leaseExpired = (!curLease || curLease <= now);
      if (curOwner === String(owner || '') || leaseExpired) {
        g.leaseUntil = 0;
        g.leaseAt = 0;
        g.leaseProfile = '';
      }
      if (didAction) {
        g.cooldownUntil = cooldownUntil;
        g.lastActionAt = now;
        g.lastActionProfile = String(nome || '').slice(0, 120);
        g.lastActionKind = String(actionKind || '').slice(0, 40);
        g.lastCooldownMs = cooldownMs;
      }
      return d;
    });
  } catch {}
  if (didAction) {
    try { provisionAudit.append({ ts: now, event: 'identity_gate_cooldown_set', nome: String(nome||''), owner: String(owner||''), actionKind: String(actionKind||''), cooldownMs, cooldownUntil }); } catch {}
  } else {
    try { provisionAudit.append({ ts: now, event: 'identity_gate_released', nome: String(nome||''), owner: String(owner||'') }); } catch {}
  }
  return { ok: true, cooldownMs, cooldownUntil };
}

// ===== Identidade (selfie/vídeo) — executor 24/7 (multi-step) =====
// Objetivo: quando a UI cair em identidade, avançar os botões necessários
// (Continuar/Avançar -> Iniciar selfie -> Carregar -> Confirmar/Concluir -> refresh)
// com guardrails (gate + debounce) e telemetria auditável.
const IDENTITY_FLOW_CFG = {
  maxRunMs: 4 * 60 * 1000,     // budget total por execução (anti-loop)
  maxSteps: 6,                // limite de cliques “sem cérebro”
  stepWaitMs: 150_000,        // botão Carregar pode demorar 10–120s para habilitar
  debounceMs: 15_000          // evita disparos duplos (probe + nurse + scan)
};

async function runIdentityFlow(nome, ctrl, pg, { source = 'unknown', flowId = '', force = false } = {}) {
  const now = Date.now();
  const id = String(flowId || newFlowId('identity'));
  try {
    if (!nome || !ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'no_browser' };
    if (!pg) return { ok: false, error: 'no_page' };
    // Regra do lead: invocou humano => sistema NÃO trabalha.
    if (ctrl && ctrl.humanControl === true) {
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_skipped_human_control', nome: String(nome||''), flowId: id, source: String(source||'').slice(0,80) }); } catch {}
      return { ok: false, skipped: true, reason: 'human_control' };
    }
    if (isNonLrAutomationPaused()) {
      try { await setIdentityRequiredFlag(nome, { source: String(source || '').slice(0, 80) }); } catch {}
      await enforcePausedNonLrState(nome, { kind: 'identity_required', source });
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_paused_by_policy', nome: String(nome||''), flowId: id, source: String(source||'').slice(0,80) }); } catch {}
      return { ok: false, pausedByPolicy: true, error: 'non_lr_automation_paused' };
    }

    // Roteamento: se já estamos em captcha, não consumir governança de identidade.
    // (captcha tem governança própria e pode rodar em paralelo com identity_flow de outros perfis)
    try {
      const lr0 = await browserHelper.detectLoginRequired(pg).catch(()=>null);
      const rr0 = (lr0 && lr0.loginRequired) ? String(lr0.reason || '').toLowerCase() : '';
      if (rr0.includes('captcha_persona_pre_screen') || rr0.includes('captcha_persona') || rr0.includes('checkpoint_captcha')) {
        try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_routed_to_captcha_flow', nome: String(nome||''), flowId: id, source: String(source||'').slice(0,80), reason: rr0.slice(0,160) }); } catch {}
        return await runCaptchaFlow(nome, ctrl, pg, { source: `routed_from_identity:${String(source||'').slice(0,60)}`, force: true }).catch(()=>({ ok:false, error:'captcha_flow_failed' }));
      }
    } catch {}

    robeMeta[nome] = robeMeta[nome] || {};
    const last = Number(robeMeta[nome].identityFlowLastAt || 0) || 0;
    if (!force && last && (now - last) < IDENTITY_FLOW_CFG.debounceMs) {
      return { ok: false, skipped: true, reason: 'debounced', sinceMs: now - last };
    }

    // Governança (cross-process): limita identidade simultânea no host (evita explosão).
    // Importante: NÃO trava — se não houver permit, retorna busy e o nurse/retry tenta mais tarde.
    let _govPermitToken = null;
    try {
      const pr = await supervisorClient.requestPermit('identity_flow', nome, {
        operator: `identity_flow:${String(nome || '').trim()}:${id}`,
        ttlMs: Math.min((IDENTITY_FLOW_CFG.maxRunMs + 60_000), (15 * 60 * 1000))
      }).catch(()=>null);
      if (!pr || pr.ok !== true || !pr.token) {
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'identity_flow_governor_denied',
            flowId: id,
            nome: String(nome||''),
            source: String(source||'').slice(0, 80),
            reason: pr && pr.error ? String(pr.error) : 'unknown',
            inUse: pr && typeof pr.inUse === 'number' ? pr.inUse : null,
            max: pr && typeof pr.max === 'number' ? pr.max : null,
            retryAfterMs: pr && typeof pr.retryAfterMs === 'number' ? pr.retryAfterMs : null
          });
        } catch {}
        return { ok: false, denied: true, flowId: id, error: 'governor_busy' };
      }
      _govPermitToken = pr.token;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_governor_exception', flowId: id, nome: String(nome||''), error: msg.slice(0, 200) }); } catch {}
      return { ok: false, flowId: id, error: `governor_exception:${msg}` };
    }

    // Debounce “consumido” só após conseguir governança (senão vira starvation).
    robeMeta[nome].identityFlowLastAt = now;

    const owner = `pid:${process.pid}`;
    const g = await _identityGateTryAcquire({ owner, nome }).catch(()=>null);
    if (!g || !g.ok) {
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'identity_flow_gate_denied',
          flowId: id,
          nome: String(nome||''),
          source: String(source||'').slice(0, 80),
          why: g && g.why ? String(g.why) : (g && g.denied ? 'denied' : 'unknown'),
          leaseUntil: g && g.leaseUntil ? g.leaseUntil : null,
          cooldownUntil: g && g.cooldownUntil ? g.cooldownUntil : null,
          owner: g && g.owner ? String(g.owner) : null
        });
      } catch {}
      // Se gate negou, devolve permit (não é erro; só concorrência por perfil)
      try { if (_govPermitToken) await supervisorClient.releasePermit(_govPermitToken, { result: 'gate_denied' }).catch(()=>{}); } catch {}
      return { ok: false, denied: true, flowId: id };
    }

    let didAction = false;
    let actionKinds = [];
    const t0 = Date.now();
    try {
      let url0 = '';
      try { url0 = (typeof pg.url === 'function') ? (pg.url() || '') : ''; } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'identity_flow_begin',
          flowId: id,
          nome: String(nome||''),
          source: String(source||'').slice(0, 80),
          url: String(url0||'').slice(0, 220)
        });
      } catch {}

      // Loop multi-step: clica o que estiver disponível e habilitado, respeitando budget.
      let stepIndex = 0;
      while (true) {
        const elapsed = Date.now() - t0;
        if (elapsed >= IDENTITY_FLOW_CFG.maxRunMs) break;
        if (stepIndex >= IDENTITY_FLOW_CFG.maxSteps) break;

        const a = await browserHelper.identityAssistStep(pg, { maxWaitMs: IDENTITY_FLOW_CFG.stepWaitMs, tries: 2 }).catch(()=>null);
        stepIndex += 1;

        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'identity_flow_step',
            flowId: id,
            nome: String(nome||''),
            source: String(source||'').slice(0, 80),
            stepIndex,
            ok: !!(a && a.ok),
            clicked: a && a.clicked ? String(a.clicked) : null,
            error: a && a.error ? String(a.error).slice(0, 160) : null,
            waitedMs: a && typeof a.waitedMs === 'number' ? a.waitedMs : null,
            attempts: a && typeof a.attempts === 'number' ? a.attempts : null,
            scrolled: !!(a && a.meta && a.meta.scrolled),
            scrollReason: (a && a.meta && a.meta.scrollReason) ? String(a.meta.scrollReason).slice(0, 80) : '',
            nudged: !!(a && a.meta && a.meta.nudged)
          });
        } catch {}

        if (a && a.ok) {
          didAction = true;
          actionKinds.push(String(a.clicked || 'clicked'));
          await sleep(1100);
          continue;
        }

        // Falhas transitórias típicas (navegação/iframe): recarrega e tenta mais um step dentro do budget.
        try {
          const emsg = String((a && a.error) ? a.error : '').toLowerCase();
          if (emsg.includes('detached frame') || emsg.includes('execution context was destroyed') || emsg.includes('context was destroyed')) {
            await reloadPageEnterprise(pg, { nome, tag: 'identity_flow_transient', timeoutMs: 45_000 }).catch(()=>null);
            await sleep(700);
            continue;
          }
        } catch {}

        // Se não clicou, não “martelar”: paramos para reclassificar/encaminhar.
        break;
      }

      // Refresh após ações (padrão do fluxo: após concluir passos, atualizar).
      if (didAction) {
        await reloadPageEnterprise(pg, { nome, tag: `identity_flow_${String(source||'').slice(0, 28)}`, timeoutMs: 60_000 }).catch(()=>null);
        await sleep(900);
      }

      // Reclassificar e encaminhar para o pipeline certo.
      const lr2 = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
      if (!lr2 || lr2.loginRequired !== true) {
        // Liberou: limpa flags de identidade e retoma (se desejado).
        try { await clearIdentityFlags(nome); } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d = d || {}; d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'on' };
            return d;
          });
        } catch {}
        // Não travar aqui (activateOnce): agenda start_work.
        setTimeout(() => { try { handlers.start_work({ nome, operator: `identity_flow_resolved:${id}` }).catch(()=>{}); } catch {} }, 0);
        try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_end', flowId: id, nome: String(nome||''), result: 'clear' }); } catch {}
        return { ok: true, flowId: id, result: 'clear', didAction, actions: actionKinds };
      }

      const rr2 = String(lr2.reason || '').toLowerCase();
      if (rr2.includes('captcha_persona_pre_screen') || rr2.includes('captcha_persona') || rr2.includes('checkpoint_captcha')) {
        // Encaminha para o captcha flow (governança própria + 5 tentativas por padrão).
        // Importante: NÃO invocar humano aqui; o captcha flow é o único responsável por invocar humano após N tentativas.
        return await runCaptchaFlow(nome, ctrl, pg, { source: `routed_post_identity:${String(source||'').slice(0,60)}`, force: true }).catch(()=>({ ok:false, error:'captcha_flow_failed' }));
      }
      if (rr2.includes('appeal_submitted') || rr2.includes('appeal')) {
        await setAppealSubmittedFlag(nome, { source: String(lr2.domain||''), url: lr2.url || '', title: lr2.title || '' }).catch(()=>{});
        await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }).catch(()=>{});
        try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_end', flowId: id, nome: String(nome||''), result: 'appeal_submitted' }); } catch {}
        return { ok: true, flowId: id, result: 'appeal_submitted', didAction, actions: actionKinds };
      }
      if (rr2.includes('login_form')) {
        // Blindagem P0: garantir flag persistida antes de agendar auto-remediação.
        await setLoginRequiredFlag(nome, { reason: lr2.reason || 'login_form', source: lr2.domain || 'identity_flow' }).catch(()=>{});
        queueAutoLoginRemediate(nome, { reason: lr2.reason || '', source: lr2.domain || '', immediate: true });
        try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_end', flowId: id, nome: String(nome||''), result: 'login_form' }); } catch {}
        return { ok: true, flowId: id, result: 'login_form', didAction, actions: actionKinds };
      }
      if (rr2.includes('identity_submitted')) {
        await setIdentitySubmittedFlag(nome, { source: String(lr2.domain||''), url: lr2.url || '', title: lr2.title || '' }).catch(()=>{});
        try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_end', flowId: id, nome: String(nome||''), result: 'identity_submitted' }); } catch {}
        return { ok: true, flowId: id, result: 'identity_submitted', didAction, actions: actionKinds };
      }

      // Fallback: mantém LR genérico atualizado (sem mascarar), mas não inventa ação.
      await setLoginRequiredFlag(nome, { reason: lr2.reason || '', source: lr2.domain || '' }).catch(()=>{});
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_end', flowId: id, nome: String(nome||''), result: 'other_login_required', reason: rr2.slice(0,160) }); } catch {}
      return { ok: true, flowId: id, result: 'other_login_required', didAction, actions: actionKinds };
    } finally {
      await _identityGateRelease({ owner, nome, didAction, actionKind: actionKinds.join(',') }).catch(()=>{});
      try { if (_govPermitToken) await supervisorClient.releasePermit(_govPermitToken, { result: didAction ? 'ok' : 'noop' }).catch(()=>{}); } catch {}
    }
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try { provisionAudit.append({ ts: Date.now(), event: 'identity_flow_error', flowId: id, nome: String(nome||''), error: msg.slice(0, 220) }); } catch {}
    return { ok: false, flowId: id, error: msg };
  }
}

async function setIdentityRequiredFlag(nome, { source = '', url = '', title = '' } = {}) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.identityRequired = true;
      man.accountFlags.identityRequiredAt = Number(man.accountFlags.identityRequiredAt || 0) || Date.now();
      man.accountFlags.identitySource = String(source || '').slice(0, 80);
      man.accountFlags.identityUrl = String(url || '').slice(0, 300);
      man.accountFlags.identityTitle = String(title || '').slice(0, 200);
      man.accountFlags.identityLastReason = 'identity_required';
      // Blindagem enterprise: identidade é um estado próprio e não pode ficar mascarada por flags antigas.
      // Se entrou em identidade, remover sinais de "login/cookies falhou" e "loginRequired" genérico.
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      delete man.accountFlags.loginRequired;
      delete man.accountFlags.loginReason;
      delete man.accountFlags.loginSource;
      delete man.accountFlags.lastLoginRequiredAt;
      return man;
    });
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'identity_required_detected',
        nome: String(nome || ''),
        source: String(source || '').slice(0, 80),
        url: String(url || '').slice(0, 220),
        title: String(title || '').slice(0, 120)
      });
    } catch {}
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].whyNotOpen = 'identity_required';
    delete robeMeta[nome].loginRemediateFailed;
    delete robeMeta[nome].loginRemediateFailedReason;
    delete robeMeta[nome].loginRequired;
    delete robeMeta[nome].loginReason;
  } catch {}

  // UA+FP telemetry (identity)
  try { await emitUaFpEventToCT(nome, { eventKind: 'identity', url, title }); } catch {}

  // Regra enterprise: identidade NÃO deve virar "humano invocado" automaticamente.
  // Mantém Virtus OFF para não postar/robe enquanto há identidade, mas deixa o navegador livre.
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
      return d;
    });
  } catch {}
  try {
    const ctrl = controllers.get(nome);
    if (ctrl) {
      ctrl.trabalhando = false;
      try { await stopVirtus(nome); } catch {}
    }
  } catch {}
}

async function setIdentitySubmittedFlag(nome, { source = '', url = '', title = '' } = {}) {
  const now = Date.now();
  try {
    const next = now + IDENTITY_CFG.firstDelayMs;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.identitySubmitted = true;
      man.accountFlags.identitySubmittedAt = Number(man.accountFlags.identitySubmittedAt || 0) || now;
      man.accountFlags.identitySource = String(source || '').slice(0, 80);
      man.accountFlags.identityUrl = String(url || '').slice(0, 300);
      man.accountFlags.identityTitle = String(title || '').slice(0, 200);
      man.accountFlags.identityLastReason = 'identity_submitted';
      man.accountFlags.identityNextCheckAt = next;
      // Se chegou aqui, não faz sentido manter identityRequired “acima” do estado submitted.
      delete man.accountFlags.identityRequired;
      delete man.accountFlags.identityRequiredAt;
      // Blindagem: ao entrar em identity_submitted, limpar flags antigas de login/cookies falhou e loginRequired.
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      delete man.accountFlags.loginRequired;
      delete man.accountFlags.loginReason;
      delete man.accountFlags.loginSource;
      delete man.accountFlags.lastLoginRequiredAt;
      return man;
    });
    try {
      provisionAudit.append({
        ts: now,
        event: 'identity_submitted_detected',
        nome: String(nome || ''),
        nextAt: now + IDENTITY_CFG.firstDelayMs,
        source: String(source || '').slice(0, 80),
        url: String(url || '').slice(0, 220)
      });
    } catch {}
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].whyNotOpen = 'identity_submitted';
    delete robeMeta[nome].loginRemediateFailed;
    delete robeMeta[nome].loginRemediateFailedReason;
    delete robeMeta[nome].loginRequired;
    delete robeMeta[nome].loginReason;
  } catch {}

  // Regra enterprise: identity_submitted também NÃO deve virar humano invocado automaticamente.
  // Mantém Virtus OFF e agenda monitor, mas não seta humanHold.
  try {
    await fileStore.withDesiredFileLockUpdate((d) => {
      d.perfis = d.perfis || {};
      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
      return d;
    });
  } catch {}
  try {
    const ctrl = controllers.get(nome);
    if (ctrl) {
      ctrl.trabalhando = false;
      try { await stopVirtus(nome); } catch {}
    }
  } catch {}
}

async function clearIdentityFlags(nome) {
  try {
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      delete man.accountFlags.identityRequired;
      delete man.accountFlags.identityRequiredAt;
      delete man.accountFlags.identitySubmitted;
      delete man.accountFlags.identitySubmittedAt;
      delete man.accountFlags.identitySource;
      delete man.accountFlags.identityUrl;
      delete man.accountFlags.identityTitle;
      delete man.accountFlags.identityNextCheckAt;
      delete man.accountFlags.identityLastCheckAt;
      delete man.accountFlags.identityLastReason;
      return man;
    });
    if (robeMeta[nome]) {
      if (robeMeta[nome].whyNotOpen && String(robeMeta[nome].whyNotOpen).startsWith('identity')) delete robeMeta[nome].whyNotOpen;
    }
  } catch {}
}

async function identityMonitorCheckNow(nome, ctrl) {
  const now = Date.now();
  try {
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'no_browser' };
    const pages = await ctrl.browser.pages().catch(()=>[]);
    const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
    const pickFb = () => {
      for (const pg of (pages || []).slice(0, IDENTITY_CFG.maxPagesScan)) {
        const u = safeUrl(pg);
        if (!/facebook\.com/i.test(u)) continue;
        if (/checkpoint|identity|help\/contact|recover/i.test(u)) return pg;
      }
      for (const pg of (pages || []).slice(0, IDENTITY_CFG.maxPagesScan)) {
        const u = safeUrl(pg);
        if (/facebook\.com/i.test(u)) return pg;
      }
      return (pages && pages[0]) || null;
    };
    const pg = pickFb();
    if (!pg) return { ok: false, error: 'no_pages' };

    try {
      provisionAudit.append({
        ts: now,
        event: 'identity_monitor_check_begin',
        nome: String(nome || ''),
        url: String(safeUrl(pg) || '').slice(0, 220)
      });
    } catch {}

    // Refresh enterprise (com fallback + log explícito)
    await reloadPageEnterprise(pg, { nome, tag: 'identity_monitor', timeoutMs: 45_000 }).catch(()=>null);
    await sleep(900);

    // Detecta estado após refresh. Se ainda disser "identity_submitted", valida também via navegação determinística
    // para evitar ficar preso em DOM/aba antiga.
    let lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:false }));
    try {
      const rr0 = String(lr && lr.reason || '').toLowerCase();
      if (lr && lr.loginRequired === true && (rr0.includes('identity_submitted') || rr0.includes('identity'))) {
        await reloadPageEnterprise(pg, { nome, tag: 'identity_monitor_home_check', timeoutMs: 60_000 }).catch(()=>null);
        await sleep(900);
        lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:false }));
      }
    } catch {}

    // Atualiza telemetria do monitor
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        if (man.accountFlags.identitySubmitted !== true) return man;
        man.accountFlags.identityLastCheckAt = now;
        man.accountFlags.identityLastReason = lr && lr.loginRequired ? String(lr.reason || '') : '';
        man.accountFlags.identityNextCheckAt = now + IDENTITY_CFG.intervalMs;
        return man;
      });
    } catch {}

    if (!lr || lr.loginRequired !== true) {
      // Liberou: limpa flags e retoma trabalho normal
      await clearIdentityFlags(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d.perfis = d.perfis || {};
          d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'on' };
          return d;
        });
      } catch {}
      try {
        ctrl.humanControl = false;
        if (automationAllowed(ctrl)) {
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
          ctrl.trabalhando = true;
        }
        try { unfreezeCooldownIfWorking(nome); } catch {}
      } catch {}
      try { await issues.append(nome, 'mil_action', 'identity_monitor_resolved_active'); } catch {}
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_monitor_resolved_active', nome: String(nome || '') }); } catch {}
      return { ok: true, resolved: true };
    }

    const rr = String(lr.reason || '').toLowerCase();
    if (rr.includes('identity_submitted') || rr.includes('identity')) {
      try { await issues.append(nome, 'mil_action', 'identity_monitor_still_pending'); } catch {}
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_monitor_still_pending', nome: String(nome||''), reason: String(lr.reason||'').slice(0, 200), nextAt: now + IDENTITY_CFG.intervalMs }); } catch {}
      // Mantém em humano/hold
      return { ok: true, pending: true };
    }

    // Mudou para outro bloqueio:
    // Regra enterprise: SAIR do modo identity_submitted assim que a tela mudar.
    try { await clearIdentityFlags(nome); } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'identity_monitor_exit',
        nome: String(nome || ''),
        toReason: String(lr.reason || '').slice(0, 220),
        toDomain: String(lr.domain || '').slice(0, 80),
        url: String(lr.url || '').slice(0, 220)
      });
    } catch {}

    // 2FA: manter em modo humano (sem exclusão automática)
    if (rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor')) {
      try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(lr.title || '') }); } catch {}
      return { ok: false, transitioned: true, reason: 'two_factor', action: 'human_hold_two_factor' };
    }

    // Se virar appeal_submitted, entra no monitor 1h de recurso
    if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
      try { await setAppealSubmittedFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
      try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
      return { ok: true, transitioned: true, reason: 'appeal_submitted', action: 'monitor_appeal_1h' };
    }

    // Padrão: loginRequired
    try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' }); } catch {}
    try { await issues.append(nome, 'mil_action', `identity_monitor_transition_exit reason=${rr}`); } catch {}
    try { provisionAudit.append({ ts: Date.now(), event: 'identity_monitor_transition_exit', nome: String(nome||''), reason: String(lr.reason||'').slice(0,220) }); } catch {}

    // Se virar login_form, disparar pipeline de login_remediate automaticamente.
    if (rr.includes('login_form')) {
      const op = `identity_monitor_login_form:${String(nome || '')}:${Date.now()}`;
      if (isNonLrAutomationPaused()) {
        try { provisionAudit.append({ ts: Date.now(), event: 'identity_monitor_login_remediate_suppressed_by_policy', nome: String(nome||''), operator: op }); } catch {}
        return { ok: true, transitioned: true, reason: rr, action: 'login_remediate_suppressed_by_policy' };
      }
      try { provisionAudit.append({ ts: Date.now(), event: 'identity_monitor_schedule_login_remediate', nome: String(nome||''), operator: op }); } catch {}
      setTimeout(() => {
        try { handlers.login_remediate({ nome, operator: op, options: { overrideHumanHold: true } }).catch(()=>{}); } catch {}
      }, 0);
      return { ok: true, transitioned: true, reason: rr, action: 'login_remediate_scheduled' };
    }

    return { ok: true, transitioned: true, reason: rr };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try {
      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        if (man.accountFlags.identitySubmitted !== true) return man;
        man.accountFlags.identityLastCheckAt = now;
        man.accountFlags.identityLastReason = `error:${msg}`.slice(0, 120);
        man.accountFlags.identityNextCheckAt = now + IDENTITY_CFG.intervalMs;
        return man;
      });
    } catch {}
    try { provisionAudit.append({ ts: Date.now(), event: 'identity_monitor_error', nome: String(nome||''), error: String(msg||'').slice(0,220), nextAt: now + IDENTITY_CFG.intervalMs }); } catch {}
    return { ok: false, error: msg };
  }
}

async function setBannedFlag(nome, { reason = '', snippet = '' } = {}) {
  return lockProfileAction(nome, async () => {
    try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.banned === true;
    let banResult = { ok: true };
    let closeOk = true;

    // Evidence + auto-delete (ultra enterprise, mas sem “mágica por trás dos panos”):
    // REGRA (ordem determinística):
    // 1) DESLIGA desired imediatamente (impede reabertura)
    // 2) FECHA o navegador usando o MESMO motor do sistema (handlers.deactivate)
    // 3) EXCLUI o perfil usando o MESMO fluxo do DELETE /api/perfis/:nome (sem HTTP, para evitar deadlock)
    // 4) ENVIA pro estoque Excluídas (CT) com evidence (ou enfileira retry)
    //
    // Guardrails:
    // - nunca deletar perfil se o navegador ainda estiver vivo (anti-janela fantasma)
    // - não logar credenciais
    // - best-effort (não pode travar o worker)
    // - se a pré-condição de close falhar, NÃO deletar (marca pendente e sai)
    try {
      const flowId = newFlowId('ban');
      // Captura stockAccountId logo no começo (antes de qualquer delete), para nunca “sumir” no CT.
      let stockAccountId = null;
      try {
        const m0 = await manifestStore.read(nome).catch(()=>null);
        if (m0 && (m0.stockAccountId || m0.stock_account_id)) stockAccountId = Number(m0.stockAccountId || m0.stock_account_id) || null;
      } catch {}

      // 0) Captura evidence (antes de fechar)
      let b64 = '';
      let evBuf = null;
      let url = '';
      try {
        const ctrl = controllers.get(nome);
        const pages = ctrl && ctrl.browser ? await ctrl.browser.pages().catch(()=>[]) : [];
        const p0 = pages && pages[0];
        if (p0) {
          try { url = (typeof p0.url === 'function') ? (p0.url() || '') : ''; } catch {}
          try {
            const buf = await p0.screenshot({ type: 'jpeg', quality: 75, fullPage: true }).catch(()=>null);
            if (buf && buf.length) { evBuf = buf; b64 = Buffer.from(buf).toString('base64'); }
          } catch {}
        }
      } catch {}

      // UA+FP telemetry (banned/disabled)
      try { await emitUaFpEventToCT(nome, { eventKind: 'banned', url, title: String(snippet || '').slice(0, 180) }); } catch {}

      // Evidência local (para retry se CT estiver fora)
      let evidencePath = '';
      try {
        const ev = saveCtEvidenceJpeg({ stockAccountId, profileName: nome, flowId, jpegBuf: evBuf, url, reason: `banned:${String(reason||'').slice(0,80)}` });
        if (ev && ev.ok) evidencePath = String(ev.path || '');
      } catch {}

      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'banflow_begin',
          flowId,
          nome: String(nome||''),
          stockAccountId: stockAccountId || null,
          reason: String(reason||'').slice(0, 180),
          hasEvidence: !!(b64 && b64.length),
          evidencePath: evidencePath ? String(evidencePath).slice(0, 260) : null,
          url: url ? String(url).slice(0, 260) : null,
          controllersHas: controllers.has(nome)
        });
      } catch {}

      // 1) ENTERPRISE: desliga desired imediatamente para impedir reabertura automática
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d = d || {};
          d.perfis = d.perfis || {};
          d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
          return d;
        });
        try { provisionAudit.append({ ts: Date.now(), event: 'auto_banned_desired_disabled', nome: String(nome||'') }); } catch {}
      } catch {}

      // 2) FECHA o navegador via fluxo oficial (deactivate)
      try {
        try { provisionAudit.append({ ts: Date.now(), event: 'auto_banned_close_begin', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null }); } catch {}
        // Usa o mesmo handler (deactivate) que a API usa para fechar navegador.
        // policy=null => fechamento completo (sem preservar desired) e sem reabertura automática.
        const dr = await handlers.deactivate({ nome, reason: 'auto_banned', policy: null }).catch(e => ({ ok:false, error: (e && e.message) || String(e) }));
        try { provisionAudit.append({ ts: Date.now(), event: 'auto_banned_close_done', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null, ok: !!(dr && dr.ok), error: dr && dr.ok ? null : String(dr && dr.error || 'deactivate_failed').slice(0,180) }); } catch {}
        if (!dr || dr.ok !== true) {
          closeOk = false;
          banResult = { ok: false, error: 'banned_close_failed' };
          // Se não fechou, NÃO deletar (evita janela fantasma). Mas ainda assim vamos arquivar no CT.
          try {
            await manifestStore.update(nome, (man) => {
              man = man || {};
              man.accountFlags = man.accountFlags || {};
              man.accountFlags.bannedPendingClose = true;
              man.accountFlags.bannedPendingCloseAt = Date.now();
              man.accountFlags.bannedPendingCloseReason = 'deactivate_failed';
              return man;
            });
          } catch {}
        }
      } catch {}

      // 2.5) ANTES de deletar o perfil local: garantir que a conta foi enviada ao CT (Excluídas).
      // Motivo enterprise: se stockAccountId estiver ausente e o perfil for deletado, o CT pode não conseguir mapear
      // hostId+profileName => conta some (não aparece em Excluídas).
      let ctArchiveOk = false;
      let ctArchiveResp = null;
      let ctArchiveErr = '';
      let ctArchiveProceed = false;
      let ctArchiveProceedReason = '';
      try {
        const rr = await archiveBanWithEvidenceToCT({
          profileName: nome,
          stockAccountId: stockAccountId || null,
          reason: `banned:${String(reason||'banned').slice(0,80)}`,
          evidenceB64: b64,
          evidenceUrl: url
        });
        ctArchiveResp = rr || null;
        ctArchiveOk = !!(rr && rr.ok);
        ctArchiveErr = rr && rr.ok ? '' : String(rr && rr.error || 'error');
        if (rr && rr.stockAccountId && !stockAccountId) stockAccountId = Number(rr.stockAccountId) || stockAccountId;
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'auto_archive_banned_ct_predelete',
            flowId,
            nome: String(nome||''),
            ok: !!(rr && rr.ok),
            error: rr && rr.ok ? null : String(rr && rr.error || 'error').slice(0, 180),
            stockAccountId: rr && rr.stockAccountId || stockAccountId || null,
            details: rr && rr.ok ? null : (rr && rr.details ? rr.details : null)
          });
        } catch {}
        if (!rr || rr.ok !== true) {
          // CT fora/arq falhou: NÃO deletar se não temos stockAccountId, para não perder o vínculo por profileName.
          const q = queueCtArchive({ stockAccountId: stockAccountId || (rr && rr.stockAccountId) || null, profileName: nome, reason: `banned:${String(reason||'banned').slice(0,80)}`, evidencePath, evidenceUrl: url, flowId });
          try { provisionAudit.append({ ts: Date.now(), event: 'ct_archive_queued', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null, ok: !!(q && q.ok), file: q && q.file ? String(q.file).slice(0,260) : null, error: q && q.ok ? null : String(q && q.error || 'queue_failed').slice(0,180) }); } catch {}
          // NOVA REGRA (pedida): mesmo que CT não consiga mapear (ex.: not_found_assigned),
          // nós SEMPRE removemos do servidor para evitar duplicidade em múltiplos hosts.
          // A evidência fica no provision_audit + ct_archive_queue.
          ctArchiveProceed = true;
          ctArchiveProceedReason = ctArchiveErr || 'ct_archive_failed_predelete';
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'banflow_ct_archive_failed_proceed_delete',
              flowId,
              nome: String(nome||''),
              stockAccountId: stockAccountId || null,
              error: String(ctArchiveProceedReason || '').slice(0, 220)
            });
          } catch {}
        }
      } catch {}

      // 3) EXCLUI a conta do servidor usando o mesmo fluxo do DELETE /api/perfis/:nome (sem HTTP).
      // Regras:
      // - deve estar inativo aqui; se ainda estiver ativo, bloqueia (anti-fantasma).
      // - remoção de userDataDir externo é best-effort.
      try {
        if (!closeOk) {
          try { provisionAudit.append({ ts: Date.now(), event: 'auto_banned_delete_skipped_browser_not_closed', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null }); } catch {}
        } else {
        const isActive = (() => { try { return fileStore.isPerfilAtivo(nome); } catch { return false; } })();
        if (isActive) {
          try { provisionAudit.append({ ts: Date.now(), event: 'auto_banned_delete_blocked_still_active', flowId, nome: String(nome||'') }); } catch {}
          return { ok: false, error: 'banned_delete_blocked_still_active' };
        }
        // Remove userDataDir externo, perfis.json, desired e dir do perfil
        try {
          // CRÍTICO (cluster): não sobrescrever perfis.json global usando snapshot shard do worker.
          let udir = '';
          try {
            const man = await manifestStore.read(nome).catch(() => null);
            if (man && man.userDataDir) udir = String(man.userDataDir);
          } catch {}
          if (!udir) {
            try {
              const all = fileStore.loadPerfisJson() || [];
              const perfil = Array.isArray(all) ? all.find(p => p && p.nome === nome) : null;
              if (perfil && perfil.userDataDir) udir = String(perfil.userDataDir);
            } catch {}
          }
          if (udir && fs.existsSync(udir)) {
            // remoção best-effort e pode falhar em Windows (arquivo bloqueado).
            try { fileStore.rimrafSync(udir); } catch {}
          }
          try {
            fileStore.withPerfisFileLockUpdate(
              (arr) => (Array.isArray(arr) ? arr : []).filter(p => p && p.nome !== nome),
              { caller: 'auto_delete_banned_profile', nome }
            );
          } catch {}
        } catch {}
        try { await fileStore.removeDesired(nome); } catch {}
        try { fileStore.rimrafSync(path.join(fileStore.perfisDir, nome)); } catch {}
        try {
          const st = fileStore.readJsonSafe(fileStore.statusPath, null);
          if (st && Array.isArray(st.perfis)) {
            st.perfis = st.perfis.filter(p => p && p.nome !== nome);
            fileStore.writeJsonAtomic(fileStore.statusPath, st);
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        try { provisionAudit.append({ ts: Date.now(), event: 'auto_delete_banned_profile', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null, ok: true }); } catch {}
        }
      } catch (e) {
        try { provisionAudit.append({ ts: Date.now(), event: 'auto_delete_banned_profile', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null, ok: false, error: String(e && e.message || e).slice(0,180) }); } catch {}
      }

      // 4) (compat) Se por algum motivo não conseguimos arquivar antes, tenta depois também.
      if (!ctArchiveOk) {
        try {
          const rr = ctArchiveResp || await archiveBanWithEvidenceToCT({
            profileName: nome,
            stockAccountId: stockAccountId || null,
            reason: `banned:${String(reason||'banned').slice(0,80)}`,
            evidenceB64: b64,
            evidenceUrl: url
          });
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'auto_archive_banned_ct_postdelete',
              flowId,
              nome: String(nome||''),
              ok: !!(rr && rr.ok),
              error: rr && rr.ok ? null : String(rr && rr.error || 'error').slice(0, 180),
              stockAccountId: rr && rr.stockAccountId || stockAccountId || null,
              details: rr && rr.ok ? null : (rr && rr.details ? rr.details : null)
            });
          } catch {}
          if (!rr || rr.ok !== true) {
            const q = queueCtArchive({ stockAccountId: stockAccountId || (rr && rr.stockAccountId) || null, profileName: nome, reason: `banned:${String(reason||'banned').slice(0,80)}`, evidencePath, evidenceUrl: url, flowId });
            try { provisionAudit.append({ ts: Date.now(), event: 'ct_archive_queued', flowId, nome: String(nome||''), stockAccountId: stockAccountId || null, ok: !!(q && q.ok), file: q && q.file ? String(q.file).slice(0,260) : null, error: q && q.ok ? null : String(q && q.error || 'queue_failed').slice(0,180) }); } catch {}
          }
        } catch {}
      }
    } catch {}
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.banned = true;
      man.accountFlags.bannedAt = Date.now();
      man.accountFlags.bannedReason = String(reason||'');
      man.accountFlags.bannedText = String(snippet||'').slice(0, 400);
      // Enterprise: se chegou ao ban, não faz sentido manter "loginRemediateFailed" mascarando o estado.
      delete man.accountFlags.loginRemediateFailed;
      delete man.accountFlags.loginRemediateFailedAt;
      delete man.accountFlags.loginRemediateFailedReason;
      delete man.accountFlags.loginRemediateFailedSource;
      delete man.accountFlags.loginRemediateFailedStage;
      delete man.accountFlags.loginRemediateFailedCount;
      return man;
    });
    if (!already) {
      await issues.append(
        nome,
        'account_banned_detected',
        `reason=${reason||''} snippet="${(snippet||'').slice(0,120)}" at=${new Date().toISOString()}`
      );
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].banned = true;
    // Mantém coerência no runtime store também.
    delete robeMeta[nome].loginRemediateFailed;
    delete robeMeta[nome].loginRemediateFailedReason;
    } catch {}
    // Sempre retorna (não propaga)
    return banResult;
  });
}

// 2FA (two-factor) => manter conta no host (sem exclusão automática).
// Regra atual: bloquear automação, entrar em modo humano e marcar flag persistente.
async function setTwoFactorFlag(nome, { reason = 'two_factor', snippet = '' } = {}) {
  return lockProfileAction(nome, async () => {
    try {
      const prev = await readAccountFlags(nome);
      const already = prev && prev.twoFactor === true;
      const flowId = newFlowId('two_factor');

      await manifestStore.update(nome, (man) => {
        man = man || {};
        man.accountFlags = man.accountFlags || {};
        man.accountFlags.twoFactor = true;
        man.accountFlags.twoFactorAt = Date.now();
        man.accountFlags.twoFactorReason = String(reason || '');
        man.accountFlags.twoFactorText = String(snippet || '').slice(0, 400);
        // 2FA não entra em auto-remediação.
        delete man.accountFlags.loginRemediateFailed;
        delete man.accountFlags.loginRemediateFailedAt;
        delete man.accountFlags.loginRemediateFailedReason;
        delete man.accountFlags.loginRemediateFailedSource;
        delete man.accountFlags.loginRemediateFailedStage;
        delete man.accountFlags.loginRemediateFailedCount;
        // Limpa pendências herdadas do fluxo antigo de fechamento/exclusão.
        delete man.accountFlags.twoFactorPendingClose;
        delete man.accountFlags.twoFactorPendingCloseAt;
        delete man.accountFlags.twoFactorPendingCloseReason;
        delete man.accountFlags.twoFactorPendingClosePids;
        return man;
      });

      try {
        const ctrl = controllers.get(nome);
        if (ctrl) {
          await enterHumanMode(nome, ctrl, { reason: `two_factor:${String(reason || '').slice(0, 120)}` });
        } else {
          // Sem browser ativo agora: persistir hold para não retomar automação no próximo ciclo.
          await fileStore.withDesiredFileLockUpdate((d) => {
            d = d || {};
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: true };
            return d;
          });
        }
      } catch {}

      try { await snapshotStatusAndWrite(); } catch {}
      try { await emitUaFpEventToCT(nome, { eventKind: 'two_factor', title: String(snippet || '').slice(0, 180) }); } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'twofactorflow_human_hold',
          flowId,
          nome: String(nome || ''),
          reason: String(reason || '').slice(0, 180),
          already: !!already
        });
      } catch {}

      if (!already) {
        try {
          await issues.append(
            nome,
            'account_two_factor_detected',
            `reason=${reason||''} snippet="${(snippet||'').slice(0,120)}" at=${new Date().toISOString()}`
          );
        } catch {}
      }

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].twoFactor = true;
      robeMeta[nome].whyNotOpen = 'two_factor_human_hold';
      return { ok: true, action: 'human_hold_two_factor' };
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      try { provisionAudit.append({ ts: Date.now(), event: 'twofactorflow_human_hold_error', nome: String(nome || ''), error: String(msg).slice(0, 220) }); } catch {}
      return { ok: false, error: msg };
    }
  });
}

async function setMessengerPinFlag(nome, { reason = 'messenger_pin_modal', source = 'messenger' } = {}) {
  try {
    const prev = await readAccountFlags(nome);
    const already = prev && prev.messengerPin === true;
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      man.accountFlags.messengerPin = true;
      man.accountFlags.messengerPinReason = String(reason || '');
      man.accountFlags.messengerPinSource = String(source || '');
      man.accountFlags.messengerPinAt = Date.now();
      return man;
    });
    if (!already) {
      await issues.append(nome, 'mil_action', `messenger_pin_detected reason=${reason||''} source=${source||''} at=${new Date().toISOString()}`);
    }
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].messengerPin = true;
    robeMeta[nome].whyNotOpen = 'messenger_pin_modal';
  } catch {}
}

async function clearAccountFlags(nome, which = ['loginRequired','banned']) {
  try {
    const prev = await readAccountFlags(nome);
    await manifestStore.update(nome, (man) => {
      man = man || {};
      man.accountFlags = man.accountFlags || {};
      if (which.includes('loginRequired')) {
        if (man.accountFlags.loginRequired || man.accountFlags.loginReason || man.accountFlags.loginSource) {
          delete man.accountFlags.loginRequired;
          delete man.accountFlags.loginReason;
          delete man.accountFlags.loginSource;
          delete man.accountFlags.lastLoginRequiredAt;
        }
      }
      if (which.includes('loginRemediateFailed')) {
        if (
          man.accountFlags.loginRemediateFailed ||
          man.accountFlags.loginRemediateFailedAt ||
          man.accountFlags.loginRemediateFailedReason ||
          man.accountFlags.loginRemediateFailedSource ||
          man.accountFlags.loginRemediateFailedStage ||
          man.accountFlags.loginRemediateFailedCount
        ) {
          delete man.accountFlags.loginRemediateFailed;
          delete man.accountFlags.loginRemediateFailedAt;
          delete man.accountFlags.loginRemediateFailedReason;
          delete man.accountFlags.loginRemediateFailedSource;
          delete man.accountFlags.loginRemediateFailedStage;
          delete man.accountFlags.loginRemediateFailedCount;
        }
      }
      if (which.includes('banned')) {
        if (man.accountFlags.banned || man.accountFlags.bannedAt || man.accountFlags.bannedReason || man.accountFlags.bannedText) {
          delete man.accountFlags.banned;
          delete man.accountFlags.bannedAt;
          delete man.accountFlags.bannedReason;
          delete man.accountFlags.bannedText;
        }
      }
      if (which.includes('messengerPin')) {
        if (man.accountFlags.messengerPin || man.accountFlags.messengerPinReason || man.accountFlags.messengerPinSource || man.accountFlags.messengerPinAt) {
          delete man.accountFlags.messengerPin;
          delete man.accountFlags.messengerPinReason;
          delete man.accountFlags.messengerPinSource;
          delete man.accountFlags.messengerPinAt;
        }
      }
      if (which.includes('identity')) {
        if (
          man.accountFlags.identityRequired ||
          man.accountFlags.identityRequiredAt ||
          man.accountFlags.identitySubmitted ||
          man.accountFlags.identitySubmittedAt ||
          man.accountFlags.identitySource ||
          man.accountFlags.identityUrl ||
          man.accountFlags.identityTitle ||
          man.accountFlags.identityNextCheckAt ||
          man.accountFlags.identityLastCheckAt ||
          man.accountFlags.identityLastReason
        ) {
          delete man.accountFlags.identityRequired;
          delete man.accountFlags.identityRequiredAt;
          delete man.accountFlags.identitySubmitted;
          delete man.accountFlags.identitySubmittedAt;
          delete man.accountFlags.identitySource;
          delete man.accountFlags.identityUrl;
          delete man.accountFlags.identityTitle;
          delete man.accountFlags.identityNextCheckAt;
          delete man.accountFlags.identityLastCheckAt;
          delete man.accountFlags.identityLastReason;
        }
      }
      if (Object.keys(man.accountFlags).length === 0) delete man.accountFlags;
      return man;
    });
    if (which.includes('loginRequired') && (prev && prev.loginRequired)) {
      await issues.append(nome, 'login_required_cleared', `at=${new Date().toISOString()}`);
    }
    if (which.includes('banned') && (prev && prev.banned)) {
      await issues.append(nome, 'account_banned_cleared', `at=${new Date().toISOString()}`);
    }
    if (which.includes('messengerPin') && (prev && prev.messengerPin)) {
      await issues.append(nome, 'mil_action', `messenger_pin_cleared at=${new Date().toISOString()}`);
    }
    if (which.includes('identity') && (prev && (prev.identityRequired || prev.identitySubmitted))) {
      await issues.append(nome, 'mil_action', `identity_flags_cleared at=${new Date().toISOString()}`);
    }
    robeMeta[nome] = robeMeta[nome] || {};
    if (which.includes('loginRequired')) {
      delete robeMeta[nome].loginRequired;
      delete robeMeta[nome].loginReason;
      delete robeMeta[nome].loginSource;
    }
    if (which.includes('loginRemediateFailed')) {
      delete robeMeta[nome].loginRemediateFailed;
      delete robeMeta[nome].loginRemediateFailedReason;
      // Durante failFast, whyNotOpen pode ser um motivo específico (two_factor, ui_blocked:..., etc).
      // Ao "Retomar trabalho", sempre limpa.
      if (typeof robeMeta[nome].whyNotOpen === 'string') delete robeMeta[nome].whyNotOpen;
    }
    if (which.includes('banned')) delete robeMeta[nome].banned;
    if (which.includes('messengerPin')) {
      delete robeMeta[nome].messengerPin;
      if (robeMeta[nome].whyNotOpen === 'messenger_pin_modal') delete robeMeta[nome].whyNotOpen;
    }
    if (which.includes('identity')) {
      if (typeof robeMeta[nome].whyNotOpen === 'string' && robeMeta[nome].whyNotOpen.startsWith('identity')) delete robeMeta[nome].whyNotOpen;
    }
    await snapshotStatusAndWrite();
  } catch {}
}

const SHARD_PROFILES = (() => { try { return JSON.parse(process.env.SHARD_PROFILES || '[]'); } catch { return []; }})();
let SHARD_SET = new Set(Array.isArray(SHARD_PROFILES) ? SHARD_PROFILES : []);
const STATUS_FILE_NAME = process.env.STATUS_FILE_NAME || 'status.json';

function inShard(nome) { return SHARD_SET.size === 0 ? true : SHARD_SET.has(nome); }

async function isLimitPostingActive(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil || 0) > Date.now());
  } catch { return false; }
}

function isLimitPostingRes(res) {
  return !!(res && (res.limitPosting === true || res.error === 'limit_posting' || res.HALT === true));
}

async function detectFbLimitInAnyPage(ctrl) {
  try {
    if (!ctrl || !ctrl.browser || typeof ctrl.browser.pages !== 'function') return false;
    const pages = await ctrl.browser.pages();
    for (const p of pages) {
      try {
        const url = p.url ? p.url() : '';
        if (/facebook\.com\/marketplace\/(create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(url)) {
          const deep = await detectLimitOverlayDeep(p, { alsoCheckFrames: true });
          if (deep && deep.blocked) return true;
          const det = await require('./browser.js').detectMessengerTempBlock(p);
          if (det && det.blocked && det.domain === 'facebook') return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

// REMOVIDO: pidusage e ps-list usam WMI/PowerShell internamente no Windows
// Placeholders explícitos para garantir que nunca haverá uso em runtime
const pidusage = null;
const psList = null;

const { execFile } = require('child_process');

const supervisorClient = require('./supervisorClient.js');
const provisionLock = require('./provisionLock.js');
const { getAvailableMB } = utils;

const HEALTH_CFG = {
  TICK_MS: 10000,
  DEAD_NO_EVENT_MS: 45000,
  DEAD_NO_DOM_MS: 45000,
  DEAD_NO_NET_MS: 60000,
  RECOVERY_COOLDOWN_MS: {
    reload: 30000,
    navHome: 45000,
    newPage: 60000
  },
  SUCCESS_RESET_MS: 20000,
  MAX_SOFT_RELOADS_10MIN: 2,
  MAX_NAVHOME_10MIN: 2,
  MAX_NEWPAGE_30MIN: 2,
  ESCALATE_TO_REOPEN_AFTER: 2,
  ABOUT_BLANK_GRACE_MS: 7000
};

const PHANTOM_CFG = {
  INITIAL_GRACE_MS: 9000,
  PERSIST_MS: 20000,
  CHECK_INTERVAL_MS: 5000,
  COOLDOWN_BETWEEN_TRIES_MS: 30000,
  MAX_PHTM_RELOADS_10M: 2,
  MAX_PHTM_NAV_10M: 2,
  MAX_PHTM_NEWPAGE_30M: 2,
  ESCALATE_AFTER_STEPS: 2
};
function _prune(arr, ms) {
  const now = Date.now();
  return (arr||[]).filter(ts => (now - ts) < ms);
}
function getPhantomState(nome) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].phantom = robeMeta[nome].phantom || {
    firstSeenAt: 0,
    lastOkAt: 0,
    lastActionAt: 0,
    actions10m: [],
    navs10m: [],
    reloads10m: [],
    newpages30m: [],
    failures: 0
  };
  return robeMeta[nome].phantom;
}
async function evaluateChatsState(page) {
  try {
    const res = await page.evaluate(() => {
      const norm = (s) => (s||'').toLowerCase();
      let grid = Array.from(document.querySelectorAll('div[role="grid"]'))
      .find(g => {
        const al = (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby') || '');
        const t = norm(al);
        return t.includes('conversas') || t.includes('conversations');
      });
      if (!grid) {
        const pagelet = document.querySelector('div[data-pagelet="MWThreadList"]');
        if (pagelet) {
          const g2 = pagelet.querySelector('div[role="grid"]');
          if (g2) grid = g2;
        }
      }
      let rows = 0, anchors = 0, skeletons = 0;
      if (grid) {
        rows = grid.querySelectorAll('div[role="row"]').length;
        anchors = grid.querySelectorAll('a[href^="/marketplace/t/"]').length;
        skeletons = grid.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      } else {
        skeletons = document.querySelectorAll('div[role="status"][data-visualcompletion="loading-state"]').length;
      }
      return { hasGrid: !!grid, rows, anchors, skeletons };
    });
    return res || { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  } catch {
    return { hasGrid:false, rows:0, anchors:0, skeletons:0 };
  }
}
function isPhantomFromSnapshot(snap) {
  const noThreads = (snap.rows === 0 && snap.anchors === 0);
  if (noThreads && snap.skeletons > 0) return true;
  return false;
}
function isOkFromSnapshot(snap) {
  return (snap.rows > 0 || snap.anchors > 0);
}
async function tryFixPhantom(nome, page) {
  const ctrlGuard = controllers.get(nome);
  if (ctrlGuard && (ctrlGuard.humanControl === true || ctrlGuard.configurando === true)) return false;
  const ph = getPhantomState(nome);
  const now = Date.now();
  ph.actions10m = _prune(ph.actions10m, 10601000);
  ph.navs10m = _prune(ph.navs10m, 10601000);
  ph.reloads10m = _prune(ph.reloads10m, 10601000);
  ph.newpages30m = _prune(ph.newpages30m, 30601000);

  if ((now - ph.lastActionAt) < PHANTOM_CFG.COOLDOWN_BETWEEN_TRIES_MS) return false;

  const ctrl = controllers.get(nome);
  if (!ctrl || !ctrl.browser || ctrl.configurando) return false;
  if (robeMeta[nome] && robeMeta[nome].emExecucao) return false;

  if (ph.navs10m.length < PHANTOM_CFG.MAX_PHTM_NAV_10M) {
    try {
      await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 });
      ph.navs10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:navHome');
      return true;
    } catch {}
  }
  if (ph.reloads10m.length < PHANTOM_CFG.MAX_PHTM_RELOADS_10M) {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      ph.reloads10m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:reload');
      return true;
    } catch {}
  }
  if (ph.newpages30m.length < PHANTOM_CFG.MAX_PHTM_NEWPAGE_30M) {
    try {
      const ctrl2 = controllers.get(nome);
      const np = await ctrl2.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        await browserHelper.patchPage(nome, np, utils.getCoords(man && man.cidade || ''));
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl2.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl2.mainPage = np;
      await wirePageObservers(nome, np);
      ph.newpages30m.push(now);
      ph.actions10m.push(now);
      ph.lastActionAt = now;
      await issues.append(nome, 'mil_action', 'phantom_fix:newPage');
      return true;
    } catch {}
  }
  ph.failures = (ph.failures || 0) + 1;
  await issues.append(nome, 'mil_action', `phantom_escalate:reopen failures=${ph.failures}`);
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return true;
  }
  await handlers.deactivate({ nome, reason: 'phantom_reopen', policy: 'preserveDesired' });
  setKillGuard(nome);
  ph.lastActionAt = now;
  return true;
}

const healthState = new Map();
function getHealth(nome) {
  const now = Date.now();
  if (!healthState.has(nome)) {
    healthState.set(nome, {
      lastOkAt: 0, lastDomEventAt: 0, lastNetEventAt: 0, lastConsoleErrorAt: 0,
      lastUrl: '', lastTitle: '', stage: 'ok', nextTryAt: 0,
      counters: { softReloads10m: [], navHomes10m: [], newPages30m: [], cyclesWithoutLife: 0 },
      newPageInFlight: false,
      lastNewPageAt: 0
    });
  }
  return healthState.get(nome);
}
function _pruneWindow(arr, ms) {
  const now = Date.now();
  return arr.filter(ts => (now - ts) < ms);
}

const AUTO_CFG = {
  // Governor (light/full) — configurável por env para tuning em produção:
  // Política (2026-01-30): entrar em light quando < 2GB (reserva do servidor) e sair quando >= 2GB.
  MEM_ENTER_MB: Math.max(256, parseInt(process.env.CT_GOV_MEM_ENTER_MB || '2048', 10) || 2048),
  MEM_EXIT_MB: Math.max(256, parseInt(process.env.CT_GOV_MEM_EXIT_MB || '2048', 10) || 2048),
  CPU_ENTER: 85,
  CPU_EXIT: 70,
  EMA_ALPHA_CPU: 0.30,
  EMA_ALPHA_MEM: 0.20,
  HOT_TICKS: 3,
  COOL_TICKS: 3,
  MIN_HOLD_MS: 45000,
  // Em light, Robe NÃO pode parar, apenas reduzir pressão.
  ROBE_LIGHT_MIN_SPACING_MS: Math.max(10_000, parseInt(process.env.CT_GOV_ROBE_LIGHT_MIN_SPACING_MS || '60000', 10) || 60000),
  // Quantos Robes no máximo enfileirar por tick em light (0 => não enfileira).
  ROBE_LIGHT_MAX_ENQUEUE_PER_TICK: Math.max(0, parseInt(process.env.CT_GOV_ROBE_LIGHT_MAX_ENQUEUE_PER_TICK || '1', 10) || 1),
  // Confirmações por tempo (evita “piscar” e evita entrar em light por flutuação).
  ENTER_CONFIRM_MS: Math.max(10_000, parseInt(process.env.CT_GOV_ENTER_CONFIRM_MS || String(5 * 60 * 1000), 10) || (5 * 60 * 1000)),
  EXIT_CONFIRM_MS: Math.max(10_000, parseInt(process.env.CT_GOV_EXIT_CONFIRM_MS || String(5 * 60 * 1000), 10) || (5 * 60 * 1000))
};

const ramPolicy = require('./ramPolicy.js');

// RAM mínima dinâmica (ultra enterprise):
// - Operação normal: 2GB + 1GB por node (nós = ceil(totalGB/16))
// - Durante provision (somente dono do lock): 2GB + pico cookies (~1.5GB)
function getOpenMinFreeMB(operator = '') {
  const staticOverride = parseInt(process.env.OPEN_MIN_FREE_MB || '0', 10);
  if (Number.isFinite(staticOverride) && staticOverride > 0) return staticOverride;

  const snap = ramPolicy.snapshotPolicy();
  const op = String(operator || '').trim();
  try {
    const lk = provisionLock.get();
    if (lk && lk.active && provisionLock.ownerMatchesOperator(lk.lock, op)) {
      return snap.reserveProvisionMB;
    }
  } catch {}
  return snap.reserveNormalMB;
}
const BROWSER_CLOSE_TIMEOUT_MS = parseInt(process.env.BROWSER_CLOSE_TIMEOUT_MS || '15000', 10);
const HEADROOM_AFTER_OPEN_MB = parseInt(process.env.HEADROOM_AFTER_OPEN_MB || '0', 10);
const TARGET_ALIVE = parseInt(process.env.TARGET_ALIVE || '0', 10);

// Sinal de saturação SEM WMI: event-loop lag (ms)
// - Quando o loop trava, o sistema “se perde” (timers atrasam, navegação falha, about:blank se acumula).
// - Este é o gatilho enterprise para backpressure antes de quebrar.
// Defaults mais conservadores (menos sensível) — ainda configurável por env.
const LOOPLAG_ENTER_MS = parseInt(process.env.CT_LOOPLAG_ENTER_MS || '400', 10);
const LOOPLAG_EXIT_MS  = parseInt(process.env.CT_LOOPLAG_EXIT_MS  || '200', 10);
const LOOPLAG_MAX_ENTER_MS = parseInt(process.env.CT_LOOPLAG_MAX_ENTER_MS || '2000', 10);
const LOOPLAG_MAX_EXIT_MS  = parseInt(process.env.CT_LOOPLAG_MAX_EXIT_MS  || '900', 10);
const GOVERNOR_TICK_MS = parseInt(process.env.CT_GOVERNOR_TICK_MS || '2000', 10);

const autoMode = {
  mode: 'full', since: Date.now(), reason: 'supervisor_controlled',
  cpuEma: null, freeEmaMB: null, hot: 0, cool: 0, lastEval: 0,
  // pressureSince/recoveredSince implementam a janela de confirmação (5min).
  pressureSince: 0,
  recoveredSince: 0,
  light: { activationHeld: 0, robeSkipped: 0, nextRobeEnqueueAt: 0 }
};

function _ema(prev, value, alpha) { return prev == null ? value : (alpha*value + (1-alpha)*prev); }
function _canSwitch() { return (Date.now() - autoMode.since) >= AUTO_CFG.MIN_HOLD_MS; }

// Event loop delay monitor (ultra leve; sem WMI)
const _loopDelay = monitorEventLoopDelay({ resolution: 20 });
try { _loopDelay.enable(); } catch {}
function readLoopLagMs() {
  try {
    const meanMs = Math.round(Number(_loopDelay.mean || 0) / 1e6);
    const maxMs = Math.round(Number(_loopDelay.max || 0) / 1e6);
    try { _loopDelay.reset(); } catch {}
    return { meanMs, maxMs };
  } catch {
    return { meanMs: 0, maxMs: 0 };
  }
}

async function governorTick() {
  try {
    const now = Date.now();
    if (autoMode.lastEval && (now - autoMode.lastEval) < Math.max(500, GOVERNOR_TICK_MS - 200)) return;
    autoMode.lastEval = now;

    const freeMB = getAvailableMB();
    const lag = readLoopLagMs();
    autoMode.eventLoopLagMs = lag.meanMs;
    autoMode.eventLoopLagMaxMs = lag.maxMs;
    autoMode.freeEmaMB = _ema(autoMode.freeEmaMB, freeMB, AUTO_CFG.EMA_ALPHA_MEM);

    const memLow = (freeMB > 0 && freeMB < AUTO_CFG.MEM_ENTER_MB);
    const memHigh = (freeMB > 0 && freeMB >= AUTO_CFG.MEM_EXIT_MB);
    // Política (triagem 2026-01-30): modo leve/full definido por RAM.
    // Lag continua sendo observado (telemetria), mas NÃO deve causar mudança de modo sozinho.
    const pressureNow = memLow;
    const recoveredNow = memHigh;

    // Janela de confirmação (5min) para entrar/sair.
    if (pressureNow) {
      if (!autoMode.pressureSince) autoMode.pressureSince = now;
    } else {
      autoMode.pressureSince = 0;
    }
    if (recoveredNow) {
      if (!autoMode.recoveredSince) autoMode.recoveredSince = now;
    } else {
      autoMode.recoveredSince = 0;
    }

    // Troca normal full/light baseada em janela de confirmação.
    if (autoMode.mode === 'full') {
      if (autoMode.pressureSince && (now - autoMode.pressureSince) >= AUTO_CFG.ENTER_CONFIRM_MS && _canSwitch()) {
        autoMode.mode = 'light';
        autoMode.since = now;
        autoMode.reason = 'mem_low';
        try { await milLog('mil_action', `governor_enter_slow reason=${autoMode.reason} freeMB=${freeMB} lagMeanMs=${lag.meanMs} lagMaxMs=${lag.maxMs}`); } catch {}
      }
    } else {
      if (autoMode.recoveredSince && (now - autoMode.recoveredSince) >= AUTO_CFG.EXIT_CONFIRM_MS && _canSwitch()) {
        autoMode.mode = 'full';
        autoMode.since = now;
        autoMode.reason = 'recovered';
        autoMode.pressureSince = 0;
        autoMode.recoveredSince = 0;
        try { await milLog('mil_action', `governor_exit_slow freeMB=${freeMB} lagMeanMs=${lag.meanMs} lagMaxMs=${lag.maxMs}`); } catch {}
      }
    }
  } catch {}
}

let _statusLock = Promise.resolve();

async function milLog(type, msg) {
  try { await reportAction('system', type || 'mil_action', String(msg || '')); } catch {}
}

let opening = {};

async function killPids(pids = []) {
  for (const pid of (pids || [])) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function killProcessTreeByRootPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      // Versão sem WMI: usa taskkill para matar o processo raiz e toda a árvore.
      await new Promise((res) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }, () => res());
      });
    } else {
      return;
    }
  } catch {}
}

async function closeProcessTreeByRootPid(pid) {
  // Tentativa "graciosa" (sem /F): fecha janela/processo se possível. Se não fechar, o caller decide forçar.
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      await new Promise((res) => {
        execFile('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore' }, () => res());
      });
    } else {
      return;
    }
  } catch {}
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Windows/enterprise hardening:
    // EPERM/EACCES normalmente significa "process exists but we can't signal it".
    // Tratar como vivo evita pular taskkill e deixar Chrome zumbi aberto.
    const code = String(e && e.code || '');
    if (code === 'EPERM' || code === 'EACCES' || code === 'ACCESS_DENIED') return true;
    return false;
  }
}

async function hardCloseController(nome, ctrl, { reason = '', allowKillUserDataDir = true } = {}) {
  const t0 = Date.now();
  const flowId = newFlowId('hard_close');
  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'worker_hard_close_begin',
      nome: String(nome || ''),
      reason: String(reason || ''),
      flowId,
      freeMB: getAvailableMB(),
      allowKillUserDataDir: !!allowKillUserDataDir
    });
  } catch {}
  let rootPid = (robeMeta[nome] && robeMeta[nome].rootPid) || null;
  try {
    if (!rootPid && ctrl && ctrl.browser && typeof ctrl.browser.process === 'function') {
      const proc = ctrl.browser.process();
      if (proc && proc.pid) rootPid = proc.pid;
    }
  } catch {}
  let userDataDir = null;
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (man && man.userDataDir) userDataDir = String(man.userDataDir);
  } catch {}
  // ENTERPRISE: fallback para perfis.json (manifest pode estar incompleto em casos de restart/erro).
  // Sem userDataDir, o kill por userDataDir vira falso-negativo e deixa Chrome vivo.
  if (!userDataDir) {
    try {
      const perfisArr = loadPerfisJson();
      const perfil = Array.isArray(perfisArr) ? perfisArr.find(p => p && p.nome === nome) : null;
      if (perfil && perfil.userDataDir) userDataDir = String(perfil.userDataDir);
    } catch {}
  }
  // Fallback final determinístico (padrão do sistema)
  if (!userDataDir) {
    try {
      userDataDir = path.join(resolveChromeUserDataRoot(), 'Conveniente', String(nome || '').trim());
    } catch {}
  }
  let closeOutcome = { ok: false, timeout: false, err: null };
  const rootPidAliveBefore = rootPid ? isPidAlive(rootPid) : null;
  const closePromise = (async () => {
    try {
      if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
        await ctrl.browser.close().catch(()=>{});
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e };
    }
  })();
  const raced = await Promise.race([
    closePromise,
    sleep(BROWSER_CLOSE_TIMEOUT_MS).then(() => ({ ok: false, timeout: true }))
  ]);
  closeOutcome = raced || closeOutcome;
  // Se fechou ou não, garantimos hard-kill se necessário
  // Regra:
  // - Se timeout OU pid ainda vivo => taskkill
  // - Se allowKillUserDataDir => também kill por userDataDir (remove órfãos)
  if (rootPid && (!closeOutcome.ok || closeOutcome.timeout || isPidAlive(rootPid))) {
    try { await killProcessTreeByRootPid(rootPid); } catch {}
  }
  if (allowKillUserDataDir && userDataDir) {
    try { browserHelper.killChromeProfileProcesses(userDataDir); } catch {}
  }
  const rootPidAliveAfter = rootPid ? isPidAlive(rootPid) : null;
  let udirPidsAfter = null;
  let udirPidsMetaOk = null;
  let udirPidsMetaErr = null;
  try {
    if (userDataDir && browserHelper.getChromeProfilePidsMeta) {
      const chk = browserHelper.getChromeProfilePidsMeta(userDataDir);
      udirPidsMetaOk = chk ? !!chk.ok : null;
      udirPidsMetaErr = chk && chk.error ? String(chk.error).slice(0, 180) : null;
      udirPidsAfter = (chk && chk.pids) ? chk.pids.slice(0, 24) : [];
    }
  } catch {}
  const durMs = Date.now() - t0;
  try {
    await issues.append(
      nome,
      'mil_action',
      `deactivate_hard reason=${reason} closeOk=${!!closeOutcome.ok} timeout=${!!closeOutcome.timeout} durMs=${durMs} rootPid=${rootPid || 0} userDataDir="${userDataDir || ''}"`
    );
  } catch {}
  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'worker_hard_close_done',
      nome: String(nome || ''),
      reason: String(reason || ''),
      flowId,
      freeMB: getAvailableMB(),
      durMs,
      rootPid: rootPid || null,
      userDataDir: userDataDir || null,
      closeOutcome: {
        ok: !!closeOutcome.ok,
        timeout: !!closeOutcome.timeout,
        err: closeOutcome && closeOutcome.err ? String(closeOutcome.err && closeOutcome.err.message || closeOutcome.err).slice(0, 180) : null
      },
      rootPidAliveBefore,
      rootPidAliveAfter,
      udirPidsMetaOk,
      udirPidsMetaErr,
      udirPidsAfter
    });
  } catch {}
  return { ok: true, flowId, durMs, rootPid: rootPid || null, userDataDir: userDataDir || null, closeOutcome, rootPidAliveBefore, rootPidAliveAfter, udirPidsMetaOk, udirPidsMetaErr, udirPidsAfter };
}

async function killStrayChromes() {
  // Intencionalmente no-op: 110% sem WMI/PowerShell e sem ps-list
  return;
}

// ===== BUILD / VERSION TRACE (ultra enterprise) =====
// Objetivo: provar 110% qual build está rodando no host (RM4), sem depender de git.
const BUILD_INFO = (() => {
  const startedAt = Date.now();
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const stWorker = fs.statSync(__filename);
    return {
      name: String(pkg && pkg.name || 'conveniente'),
      version: String(pkg && pkg.version || '0.0.0'),
      buildId: String(process.env.CT_BUILD_ID || `${String(pkg && pkg.version || '0.0.0')}|worker_mtime=${Math.round(stWorker.mtimeMs)}`),
      workerFile: String(__filename),
      workerMtimeMs: Math.round(stWorker.mtimeMs),
      startedAt
    };
  } catch (e) {
    return {
      name: 'conveniente',
      version: '0.0.0',
      buildId: String(process.env.CT_BUILD_ID || 'unknown'),
      workerFile: String(__filename),
      workerMtimeMs: null,
      startedAt,
      error: (e && e.message) ? String(e.message).slice(0, 180) : 'build_info_failed'
    };
  }
})();
function buildStatusSnap() {
  try {
    return Object.assign({}, BUILD_INFO, {
      pid: process.pid,
      cwd: process.cwd(),
      uptimeSec: Math.round((Date.now() - (BUILD_INFO.startedAt || Date.now())) / 1000)
    });
  } catch {
    return Object.assign({}, BUILD_INFO);
  }
}
try {
  const outDir = path.join(__dirname, '..', 'dados');
  try { if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true }); } catch {}
  fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify(buildStatusSnap(), null, 2), 'utf8');
} catch {}

try {
  logger.info('[WORKER][BOOT]', {
    pid: process.pid,
    execPath: process.execPath,
    versions: process.versions,
    buildId: BUILD_INFO && BUILD_INFO.buildId ? String(BUILD_INFO.buildId).slice(0, 220) : null,
    npm_node_execpath: process.env.npm_node_execpath || '',
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '',
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd()
  });
} catch (e) {
  try { logger.warn('[WORKER][BOOT] log error', { error: e && e.message || e }); } catch {}
}
try {
  logger.info(`[WORKER][BOOT][SHARD] pid=${process.pid} shardSize=${SHARD_SET.size}`);
} catch {}

setImmediate(() => { try { snapshotStatusAndWrite().catch(()=>{}); } catch {} });

const perfisPath = path.join(__dirname, '../dados', 'perfis.json');
const presetsPath = path.join(__dirname, '../dados', 'ua_presets.json');
const perfisDir = path.join(__dirname, '../dados', 'perfis');

const desiredPath = path.join(__dirname, '../dados', 'desired.json');
const statusPath  = path.join(__dirname, '../dados', STATUS_FILE_NAME);

function readJsonFile(file, fallback) {
try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
try {
const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const tmp = file + '.tmp';
const fd = fs.openSync(tmp, 'w');
try {
  fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}
try { fs.unlinkSync(file); } catch {}
try { fs.renameSync(tmp, file); }
catch {
fs.copyFileSync(tmp, file);
try { fs.unlinkSync(tmp); } catch {}
}
return true;
} catch {
return false;
}
}
function ensureDesired() {
try {
if (!fs.existsSync(desiredPath)) writeJsonAtomic(desiredPath, { perfis: {} });
} catch {}
}

function manifestPathOf(nome) {
  const perfisArr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (!perfil || !perfil.userDataDir) throw new Error('userDataDir do perfil não encontrado: ' + nome);
  return path.join(perfil.userDataDir, 'manifest.json');
}

async function freezeCooldownIfNotWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (working && !humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if (m.robeCooldownUntil && m.robeCooldownUntil > now) {
        m.robeCooldownRemainingMs = m.robeCooldownUntil - now;
        m.robeCooldownUntil = 0;
      }
      return m;
    });
  } catch {}
}

async function unfreezeCooldownIfWorking(nome) {
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    if (!working || humanControl) return;
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const now = Date.now();
      if ((m.robeCooldownUntil || 0) <= now) {
        const remaining = Number(m.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          m.robeCooldownUntil = now + remaining;
          m.robeCooldownRemainingMs = 0;
        }
      }
      return m;
    });
  } catch {}
}

const ERROR_TYPES = new Set(['robe_error', 'robe_no_photo', 'virtus_blocked', 'virtus_no_composer', 'virtus_send_failed']);

function countErrorsLocal(nome) {
  try {
    const file = path.join(perfisDir, nome, 'issues.json');
    const arr = readJsonFile(file, []);
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const it of arr) {
      const t = (it && it.type) ? String(it.type) : '';
      if (ERROR_TYPES.has(t)) n++;
    }
    return n;
  } catch { return 0; }
}

async function ensureManifestValid(nome) {
  function hasEssentials(man) {
    return man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
  }
  let manifest = await manifestStore.read(nome).catch(()=>null);
  if (manifest && hasEssentials(manifest)) return manifest;
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (perfil && hasEssentials(perfil)) {
      const merged = Object.assign({}, perfil, manifest || {});
      if (merged.userDataDir && !fs.existsSync(merged.userDataDir)) {
        fs.mkdirSync(merged.userDataDir, { recursive: true });
      }
      await manifestStore.update(nome, () => merged);
      return merged;
    }
  } catch {}
  return null;
}

async function computeManifestStatus(nome) {
  try {
    const man = await manifestStore.read(nome);
    if (!man) return 'unknown';
    const ok = man &&
      typeof man.nome === 'string' && man.nome &&
      typeof man.cidade === 'string' && man.cidade &&
      typeof man.uaPresetId !== 'undefined' &&
      typeof man.uaString === 'string' && man.uaString &&
      typeof man.uaCh === 'object' && man.uaCh &&
      typeof man.fp === 'object' && man.fp &&
      Array.isArray(man.cookies) && man.cookies.length &&
      typeof man.userDataDir === 'string' && man.userDataDir;
    return ok ? 'ok' : 'incomplete';
  } catch { return 'unknown'; }
}

async function reportAction(nome, type, message) {
try {
if (!nome) return;
if (!issues || typeof issues.append !== 'function') return;
const msg = String(message == null ? '' : message).slice(0, 400);
await issues.append(nome, type, msg);
} catch {}
}

const controllers = new Map();

const robeMeta = {};

const __AGENT_DEBUG_ENDPOINT = 'http://127.0.0.1:7242/ingest/611be70a-568b-4b8e-87dd-5895ef7bcc36';
const __agentDebugState = { lastByKey: Object.create(null) };
function __agentLog(hypothesisId, location, message, data, key = '', minIntervalMs = 0) {
  try {
    const now = Date.now();
    const k = String(key || `${hypothesisId}:${location}:${message}`);
    const last = Number(__agentDebugState.lastByKey[k] || 0) || 0;
    if (minIntervalMs > 0 && (now - last) < minIntervalMs) return;
    __agentDebugState.lastByKey[k] = now;
    // #region agent log
    fetch(__AGENT_DEBUG_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'stage2-pre-fix', hypothesisId, location, message, data, timestamp: now }) }).catch(() => {});
    // #endregion
    try {
      if (typeof provisionAudit !== 'undefined' && provisionAudit && typeof provisionAudit.append === 'function') {
        provisionAudit.append({
          ts: now,
          event: 'dbg_agent_runtime',
          runId: 'stage2-pre-fix',
          hypothesisId: String(hypothesisId || ''),
          location: String(location || ''),
          message: String(message || ''),
          data: data && typeof data === 'object' ? data : {}
        });
      }
    } catch {}
  } catch {}
}

function memorySweep() {
  try {
    const nomesValidos = new Set(loadPerfisJson().map(p => p.nome));
    const _dbgBefore = {
      healthStateSize: healthState.size,
      profileFailuresSize: profileFailures.size,
      robeMetaKeys: Object.keys(robeMeta).length,
      activationLocksSize: activationLocks.size,
      prunersSize: _pruners.size,
      profileOpLocksSize: _profileOpLocks.size,
      openingKeys: Object.keys(opening || {}).length,
      controllersSize: controllers.size,
      nomesValidosSize: nomesValidos.size
    };
    for (const [n] of healthState) if (!nomesValidos.has(n) && !controllers.has(n)) healthState.delete(n);
    for (const [n] of profileFailures) if (!nomesValidos.has(n) && !controllers.has(n)) profileFailures.delete(n);
    for (const n of Object.keys(robeMeta)) {
      if (!nomesValidos.has(n) && !controllers.has(n)) delete robeMeta[n];
    }
    const _dbgAfter = {
      healthStateSize: healthState.size,
      profileFailuresSize: profileFailures.size,
      robeMetaKeys: Object.keys(robeMeta).length,
      activationLocksSize: activationLocks.size,
      prunersSize: _pruners.size,
      profileOpLocksSize: _profileOpLocks.size,
      openingKeys: Object.keys(opening || {}).length,
      controllersSize: controllers.size
    };
    // #region agent log
    __agentLog('H1', 'worker.js:memorySweep', 'sweep_sizes', { before: _dbgBefore, after: _dbgAfter }, 'memorySweep.sizes', 60000);
    // #endregion
  } catch {}
}
setInterval(memorySweep, 10 * 60 * 1000);
setInterval(() => {
  try {
    __agentLog(
      'H1',
      'worker.js:runtimeHeartbeat',
      'runtime_structure_sizes',
      {
        controllersSize: controllers.size,
        prunersSize: _pruners.size,
        activationLocksSize: activationLocks.size,
        profileOpLocksSize: _profileOpLocks.size,
        openingKeys: Object.keys(opening || {}).length,
        robeMetaKeys: Object.keys(robeMeta || {}).length,
        healthStateSize: healthState.size,
        profileFailuresSize: profileFailures.size
      },
      'runtime.heartbeat.structures',
      55000
    );
  } catch {}
}, 60 * 1000);
// #region agent log
__agentLog(
  'H5',
  'worker.js:boot',
  'debug_instrumentation_loaded',
  {
    pid: process.pid,
    platform: process.platform,
    hostId: (typeof readHostIdSync === 'function' ? (readHostIdSync() || null) : null)
  },
  `debug.boot.${String(process.pid)}`,
  0
);
// #endregion

// Governor (NORMAL/SLOW) — roda sempre, ultra leve (sem WMI)
setInterval(() => { governorTick().catch(()=>{}); }, GOVERNOR_TICK_MS);

function governorSnapshotTick() {
  const enabled = String(process.env.CT_GOV_SNAPSHOT_ENABLED || '1').trim() !== '0';
  if (!enabled) return;

  // Leader election simples (1 writer por host) para evitar duplicar snapshots por shard.
  if (!_isGovSnapshotLeader()) _tryBecomeGovSnapshotLeader();
  if (!_isGovSnapshotLeader()) return;
  _touchGovSnapshotLeader();

  const now = Date.now();
  const hostId = readHostIdSync();
  const freeMB = getAvailableMB();
  const mu = (() => { try { return process.memoryUsage(); } catch { return null; } })();
  const rssMB = mu && mu.rss ? Math.round(mu.rss / (1024 * 1024)) : null;
  const heapUsedMB = mu && mu.heapUsed ? Math.round(mu.heapUsed / (1024 * 1024)) : null;

  let desiredActive = null;
  let desiredTotal = null;
  try {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const perfis = (d && d.perfis) ? d.perfis : {};
    desiredTotal = Object.keys(perfis).length;
    let a = 0;
    for (const n of Object.keys(perfis)) {
      const w = perfis[n] || {};
      if (w && w.active === true) a++;
    }
    desiredActive = a;
  } catch {}

  appendJsonl(GOV_SNAP_JSONL, {
    ts: now,
    hostId: hostId || null,
    pid: process.pid,
    shardSize: (typeof SHARD_SET !== 'undefined' && SHARD_SET && SHARD_SET.size) ? SHARD_SET.size : 0,
    mode: String(autoMode && autoMode.mode || 'unknown'),
    reason: String(autoMode && autoMode.reason || ''),
    since: Number(autoMode && autoMode.since || 0) || 0,
    freeMB,
    lagMeanMs: Number(autoMode && autoMode.eventLoopLagMs || 0) || 0,
    lagMaxMs: Number(autoMode && autoMode.eventLoopLagMaxMs || 0) || 0,
    rssMB,
    heapUsedMB,
    controllers: (typeof controllers !== 'undefined' && controllers && typeof controllers.size === 'number') ? controllers.size : null,
    desiredTotal,
    desiredActive,
    buildId: (typeof BUILD_INFO !== 'undefined' && BUILD_INFO && BUILD_INFO.buildId) ? String(BUILD_INFO.buildId).slice(0, 220) : null
  });
}

// Snapshot 1/min (48h = ~2880 linhas) — leve, append-only.
const GOV_SNAPSHOT_INTERVAL_MS = Math.max(10_000, parseInt(process.env.CT_GOV_SNAPSHOT_INTERVAL_MS || String(60 * 1000), 10) || (60 * 1000));
setInterval(() => { try { governorSnapshotTick(); } catch {} }, GOV_SNAPSHOT_INTERVAL_MS);
setTimeout(() => { try { governorSnapshotTick(); } catch {} }, 5000);

function killGuardActive(nome) {
  return robeMeta[nome]?.killGuardUntil && robeMeta[nome].killGuardUntil > Date.now();
}
function setKillGuard(nome, ms=90000) {
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].killGuardUntil = Date.now() + ms;
}

try {
  const perfisArr = loadPerfisJson();
  for (const p of perfisArr) {
    if (p && p.nome && p.userDataDir) {
      const manifestPath = path.join(p.userDataDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (man.frozenUntil && man.frozenUntil > Date.now()) {
          robeMeta[p.nome] = robeMeta[p.nome] || {};
          robeMeta[p.nome].frozenUntil = man.frozenUntil;
          if (man.frozenReason) robeMeta[p.nome].frozenReason = man.frozenReason;
          if (man.frozenAt) robeMeta[p.nome].frozenAt = man.frozenAt;
          if (man.frozenSetBy) robeMeta[p.nome].frozenSetBy = man.frozenSetBy;
        }
      }
    }
  }
} catch (err) {
  try { logger.warn('[BOOT] Erro ao repopular frozenUntil dos manifests', { error: err && err.message || err }); } catch {}
}

const _issuesAppendOrig = issues && issues.append ? issues.append.bind(issues) : null;
if (_issuesAppendOrig) {
  issues.append = async function(nome, type, msg) {
    try {
      const now = Date.now();
      let url = '', readyState = '', pagesCount = 0;
      let deltaDom = '', deltaNet = '';
      let healthStage = '';
      let killGuardUntil = robeMeta[nome]?.killGuardUntil || 0;
      let recoveryHysteresisUntil = robeMeta[nome]?.recoveryHysteresisUntil || 0;
      let blockHysteresisUntil = robeMeta[nome]?.blockHysteresisUntil || 0;
      let strikes = 0;

      const ctrl = controllers.get(nome);
      let page = null;
      if (ctrl && ctrl.browser) {
        try {
          const pages = await ctrl.browser.pages().catch(()=>[]);
          pagesCount = Array.isArray(pages) ? pages.length : 0;
          if (pages && pages[0]) page = pages[0];
        } catch {}
      }
      if (page) {
        try { url = typeof page.url === 'function' ? (page.url() || '') : ''; } catch {}
        try {
          readyState = await Promise.race([
            (async () => await page.evaluate(() => document.readyState).catch(()=>''))(),
            new Promise(res => setTimeout(()=>res(''), 300))
          ]);
        } catch {}
      }
      const st = getHealth && getHealth(nome);
      if (st) {
        healthStage = st.stage || '';
        if (st.lastDomEventAt) deltaDom = String(now - st.lastDomEventAt);
        if (st.lastNetEventAt) deltaNet = String(now - st.lastNetEventAt);
      }
      const rm = robeMeta[nome] || {};
      strikes = rm.noPagesStrikes || rm.zombieStrikes || (Array.isArray(rm.blockDetectWindow) ? rm.blockDetectWindow.length : 0) || 0;

      const extra = ` url=${url||''} readyState=${readyState||''} deltaDom=${deltaDom} deltaNet=${deltaNet} pagesCount=${pagesCount} strikes=${strikes} killGuardUntil=${killGuardUntil||0} recoveryHysteresisUntil=${recoveryHysteresisUntil||0} blockHysteresisUntil=${blockHysteresisUntil||0} healthStage=${healthStage||''}`;
      const newMsg = (msg == null ? '' : String(msg)) + extra;
      return await _issuesAppendOrig(nome, type, newMsg);
    } catch (e) {
      try { return await _issuesAppendOrig(nome, type, msg); } catch {}
    }
  };
}

function isFrozenNow(nome) {
  const now = Date.now();
  const inMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
  let inDisk = 0;
  try {
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const man = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (man && typeof man.frozenUntil === 'number') inDisk = man.frozenUntil;
    }
  } catch {}
  const until = Math.max(inMem, inDisk || 0);
  return until > now ? until : 0;
}

const activationLocks = new Map();

async function activateOnce(nome, source = '', operator = '') {
  if (opening[nome]) return { ok: false, error: 'already_opening' };

  if (controllers.has(nome)) {
    return { ok: true, already: true };
  }

  const inflight = activationLocks.get(nome);
  if (inflight) {
    try { await inflight.catch(() => {}); } catch {}
    return controllers.has(nome)
      ? { ok: true, already: true }
      : { ok: false, error: 'activation_in_progress' };
  }

  opening[nome] = true;
  let _supervisorSlotGranted = false;
  // Enterprise rule (2026-01): NUNCA abrir já em "humano invocado" só por humanHold.
  // humanHold é apenas um "cache" de estado anterior; ao abrir, sempre revalidamos do zero.
  let _humanHoldAtStart = false;
  const opTrim = String(operator || '').trim();
  // Open-all pode chegar com operator=lockOwner (para bypass do provision_lock). Então:
  // - detecta bulk-open por operator OU por source.
  const srcTrim = String(source || '').trim();
  const _isBulkOpen =
    /(bulk_open_all|open_all_24h|open-all-24h|abrir_tudo|abrir tudo)/i.test(opTrim) ||
    /(bulk_open_all|open_all_24h|open-all-24h|abrir_tudo|abrir tudo)/i.test(srcTrim);
  if (_isBulkOpen && String(nome || '') === 'caxias_do_sul-1769748234162') {
    try { provisionAudit.append({ ts: Date.now(), event: 'open_all_activate_once_enter', nome: String(nome||''), source: String(source||''), operator: String(operator||'') }); } catch {}
  }
  // Ultra enterprise: aberturas via UI podem chegar como operator vazio/unknown.
  // Isso NÃO pode impedir o pós-probe (senão identidade/login ficam “parados”).
  const _isUnknownOpen = (!opTrim || opTrim.toLowerCase() === 'unknown');
  const _isManualOpen = _isUnknownOpen || /(^admin|^ui|manual|user|humano|human)/i.test(opTrim);
  // Regra do usuário: ao abrir (open_all/manual), limpar flags de login para revalidar estado real.
  if (_isBulkOpen || _isManualOpen) {
    try {
      const flagsPrev = await readAccountFlags(nome).catch(()=>({}));
      const had = {
        loginRequired: !!(flagsPrev && flagsPrev.loginRequired),
        loginRemediateFailed: !!(flagsPrev && flagsPrev.loginRemediateFailed),
        messengerPin: !!(flagsPrev && flagsPrev.messengerPin)
      };
      if (had.loginRequired || had.loginRemediateFailed || had.messengerPin) {
        await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed','messengerPin']).catch(()=>{});
        try { provisionAudit.append({ ts: Date.now(), event: 'open_clear_login_flags', nome: String(nome||''), source: String(source||''), had }); } catch {}
      } else {
        try { provisionAudit.append({ ts: Date.now(), event: 'open_clear_login_flags_skip', nome: String(nome||''), source: String(source||''), had }); } catch {}
      }
    } catch {}
  }
  try {
    if (SHARD_SET.size && !inShard(nome)) {
      await reportAction(nome, 'mil_action', 'activate_skip_wrong_shard');
      logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=false size=${SHARD_SET.size}`);
      return { ok: false, error: 'wrong_shard' };
    }
    logger.info(`[WORKER][ACTIVATE][SHARD_CHECK] nome=${nome} has=${inShard(nome)} size=${SHARD_SET.size}`);

    // Ultra enterprise: em fechamentos planejados (ex.: login_remediate pós-sucesso),
    // não bloquear reabertura imediata com kill_guard. Kill guard é anti-flap para falhas.
    const _source = String(source || '');
    const _bypassKillGuard = /login_remediate_post_success/i.test(_source);
    if (killGuardActive(nome) && !_bypassKillGuard) {
      await reportAction(nome, 'guard_skip_open', 'Abertura negada por kill_guard_until');
      return { ok:false, error:"kill_guard_until" };
    }
    if (_bypassKillGuard) {
      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].killGuardUntil = 0;
      } catch {}
      try { await snapshotStatusAndWrite(); } catch {}
    }

    // Hardening: durante locks que realmente precisam "congelar abertura", bloquear novas aberturas.
    // Importante (2026-01-30): `open_all_map` NÃO pode bloquear aberturas — ele existe justamente para abrir.
    // Ele só deve pausar Virtus/Robe (governança) e bloquear fluxos pesados, mas não impedir abrir navegador.
    try {
      const op = String(operator || '').trim();
      const cur = provisionLock.get();
      if (cur && cur.active && cur.lock) {
        const owner = cur.lock && cur.lock.owner ? String(cur.lock.owner) : '';
        const kind = (cur.lock && cur.lock.meta && cur.lock.meta.kind) ? String(cur.lock.meta.kind) : '';
        const isOpenAll =
          kind === 'open_all_map' ||
          (owner && /^open_all_map:/i.test(owner));
        const shouldBlockOpen =
          kind === 'stock_provision' ||
          kind === 'close_all' ||
          (owner && /^stock_provision:/i.test(owner)) ||
          (owner && /^close_all:/i.test(owner)) ||
          (owner && /^admin_configure:/i.test(owner));

        if (shouldBlockOpen && !provisionLock.ownerMatchesOperator(cur.lock, op)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].activationHeldUntil = Date.now() + 5000;
          await reportAction(nome, 'mil_action', 'activation_hold_by_provision_lock');
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'activate_blocked_by_provision_lock',
              nome: String(nome || ''),
              operator: op || null,
              lockOwner: owner || null,
              kind: kind || null
            });
          } catch {}
          return { ok: false, error: 'maintenance_provision' };
        }

        // open_all_map não bloqueia abertura (mesmo com operator diferente).
        if (isOpenAll) {
          // noop
        }
      }
    } catch {}

    // Se vier humanHold marcado, limpamos antes de abrir e fazemos probe real depois.
    // Só voltará a humano invocado se o probe detectar captcha/checkpoint ou falha real de login.
    try {
      const desired = readJsonFile(desiredPath, { perfis: {} });
      _humanHoldAtStart = !!(desired && desired.perfis && desired.perfis[nome] && desired.perfis[nome].humanHold === true);
      if (_humanHoldAtStart) {
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d = d || {};
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), humanHold: false };
            return d;
          });
        } catch {}
        try { provisionAudit.append({ ts: Date.now(), event: 'activate_clear_human_hold_on_open', nome: String(nome||''), operator: String(operator||'') }); } catch {}
      }
    } catch {}

    const slotResp = await supervisorClient.requestOpen(nome, null, { operator: String(operator || '').trim() })
      .catch(()=>({ok:false, error:'supervisor_unreachable'}));
    if (!slotResp || !slotResp.ok) {
      robeMeta[nome] = robeMeta[nome] || {};
      // NOVO: Reduzido de 30s para 5s (supervisor já controla velocidade via cooldowns)
      robeMeta[nome].activationHeldUntil = Date.now() + 5000;
      await reportAction(nome, 'mil_action', `activation_hold_by_supervisor reason=${(slotResp && slotResp.reason) || 'unknown'}`);
      return { ok:false, error: `supervisor_denied:${(slotResp && slotResp.reason) || 'unknown'}` };
    }
    _supervisorSlotGranted = true;

    if (!nome) {
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'Nome ausente' };
    }

    if (isFrozenNow(nome)) {
      await reportAction(nome, 'mil_action', 'block_activate_frozen');
      if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
      return { ok: false, error: 'account_is_frozen' };
    }

    const job = (async () => {
      logger.info('[WORKER][activateOnce] start', { nome, source });
      try {
        logger.info('[WORKER][activateOnce] start nome=' + nome + ' source=' + source);
        const manifest = await ensureManifestValid(nome);
        if (!manifest) {
          await freezeProfileFor(nome, 12*60*60*1000, 'manifest_incomplete', 'system');
          await reportAction(nome, 'robe_error', 'manifest incompleto na ativação; perfil congelado 12h');
          if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
          return { ok:false, error: 'manifest_incomplete' };
        }

        {
          const freeMB = getAvailableMB();
          const minFreeMB = getOpenMinFreeMB(operator); // RAM mínima dinâmica (considera provision lock)
          if (freeMB <= minFreeMB) {
            await reportAction(nome, 'mem_block_activate', `RAM livre=${freeMB}MB <= ${minFreeMB}MB (gate, activeNodes=${robeQueue.activeCount()})`);
            throw new Error('ram_insuficiente_para_ativar');
          }
        }

        const browser = await browserHelper.openBrowser(manifest);
        if (!browser || typeof browser.newPage !== 'function') {
          throw new Error('Objeto browser não retornado corretamente (Puppeteer falhou ao acoplar).');
        }
        try {
          const ws = (typeof browser.wsEndpoint === 'function') ? String(browser.wsEndpoint() || '') : '';
          if (ws) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].wsEndpoint = ws;
          }
        } catch {}
        const proc = browser.process && browser.process();
        if (proc && proc.pid && Number.isFinite(proc.pid)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].rootPid = proc.pid;
          logger.info('[WORKER][activateOnce] rootPid setado', { nome, rootPid: proc.pid });
          // Persistência enterprise: garante kill por PID mesmo se o controller virar órfão depois.
          try {
            await manifestStore.update(nome, (man) => {
              man = man || {};
              man.lastRootPid = proc.pid;
              man.lastRootPidAt = Date.now();
              return man;
            });
          } catch {}
        } else {
          logger.warn('[WORKER][activateOnce] rootPid NÃO setado', {
            nome,
            hasProcessFn: !!(browser.process),
            proc: !!proc,
            pid: proc?.pid
          });
          setTimeout(async () => {
            try {
              const proc2 = browser.process && browser.process();
              if (proc2 && proc2.pid) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].rootPid = proc2.pid;
                logger.info('[WORKER][activateOnce] rootPid recapturado (delayed)', { nome, rootPid: proc2.pid });
                try {
                  await manifestStore.update(nome, (man) => {
                    man = man || {};
                    man.lastRootPid = proc2.pid;
                    man.lastRootPidAt = Date.now();
                    return man;
                  });
                } catch {}
              }
            } catch {}
          }, 2000);
        }
        controllers.set(nome, { browser, virtus: null, robe: null, status: { active: true }, configurando: false, trabalhando: false });

        // Regra enterprise: NÃO abrir já em humano/overlay por "humanHold".
        // Abertura sempre começa normal; o probe decide (captcha/checkpoint => invocar humano).

        // Enterprise: se este perfil está marcado como "loginRemediateFailed",
        // NÃO invocar humano às cegas: primeiro navegar + revalidar (pode ter virado identidade).
        try {
          const flags = await readAccountFlags(nome).catch(()=>({}));
          if (flags && flags.loginRemediateFailed === true) {
            const ctrl = controllers.get(nome);
            if (ctrl) {
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              await reportAction(nome, 'mil_action', 'opened_in_human_mode (loginRemediateFailed=true)');
              try { await issues.append(nome, 'mil_action', 'opened_in_human_mode_login_failed'); } catch {}
              // Anti-engessamento: navegar para Facebook e validar se é login/captcha/identity/appeal de fato.
              // Só invocar humano se for captcha/checkpoint OU login_form real.
              try { await ensureNonBlankEntryPage(nome, ctrl, { prefer: 'facebook', reasonBase: 'open_login_failed_entry' }); } catch {}
              try {
                const pr = await probeHumanStateOnOpen(nome, ctrl, { source: 'open_login_failed' }).catch(()=>null);
                const st = pr && pr.state ? String(pr.state) : '';
                if (st === 'captcha_checkpoint' || st === 'login_required') {
                  // Regra do usuário: NUNCA invocar humano automaticamente (nem em login_failed).
                  // Mantém Virtus OFF e deixa o operador decidir se chama invoke_human.
                  try {
                    await fileStore.withDesiredFileLockUpdate((d) => {
                      d = d || {}; d.perfis = d.perfis || {};
                      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
                      return d;
                    });
                  } catch {}
                } else {
                  // Se virou identidade/appeal/liberou, não manter "loginRemediateFailed" como estado final.
                  try { await clearAccountFlags(nome, ['loginRemediateFailed']); } catch {}
                }
              } catch {}
            }
          }
        } catch {}

        // Regra enterprise: identidade/appeal NÃO devem abrir já em "humano invocado".
        // Quem decide humano invocado é SOMENTE captcha/checkpoint ou login falhou de verdade.

        // AppealSubmitted (recurso em análise) deve ser monitorado, não "humano invocado" na abertura.

        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].activatedAt = Date.now();
        robeMeta[nome].ramHist = [];
        robeMeta[nome].cpuHistory = [];
        robeMeta[nome].lastWarn = null;

        try { healer.lastProgressAt = Date.now(); } catch {}

        try { attachBrowserLifecycle(nome, browser); } catch {}
        try {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            const pages = await browser.pages().catch(()=>[]);
            if (pages && pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
              // Open / Open-all / Open manual: não pode ficar em about:blank (tela preta).
              // Garante navegação e faz probe para refletir estado real (identity/captcha/login/appeal).
              // Pós-abertura: sempre probe (bulk/manual/unknown).
              // Importante: NÃO navegar pra home se já estamos numa tela real (ex.: identidade),
              // senão removemos o contexto e atrasamos/impedimos o fluxo.
              if (_isBulkOpen || _isManualOpen) {
                try {
                  const p0 = pages && pages[0];
                  let u0 = '';
                  try { u0 = (p0 && typeof p0.url === 'function') ? String(p0.url() || '') : ''; } catch { u0 = ''; }
                  const isBlank = (!u0 || u0 === 'about:blank');
                  if (isBlank) {
                    // Fluxo enterprise: primeiro Messenger (Virtus). Só depois validamos Facebook/Robe.
                    await ensureNonBlankEntryPage(nome, ctrl, { prefer: 'messenger', reasonBase: _isBulkOpen ? 'open_all_entry' : 'open_manual_entry' });
                  }
                } catch {}
                try { await probeHumanStateOnOpen(nome, ctrl, { source: _isBulkOpen ? 'open_all' : 'open_manual' }); } catch {}
              }
            maybeStartPruneLoop(nome, ctrl.browser, ctrl.mainPage);
            try {
              // Bootstrap ultra enterprise:
              // Durante a abertura (open-all/activate), o Chrome cria 2 abas about:blank.
              // Se o oneTabGuard/blank-killer agir cedo, vira loop abre/fecha/disconnected.
              const BOOTSTRAP_TABS_MS = parseInt(process.env.BOOTSTRAP_TABS_MS || '60000', 10);
              const ABOUTBLANK_BOOT_MAX_AGE_MS = parseInt(process.env.ABOUTBLANK_BOOT_MAX_AGE_MS || '120000', 10);
              try {
                const now = Date.now();
                ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
                ctrl.browser._aboutBlankMaxAgeMs = ctrl.browser._aboutBlankMaxAgeMs || {};
                ctrl.browser._suppressBlankKillUntil[nome] = Math.max(ctrl.browser._suppressBlankKillUntil[nome] || 0, now + BOOTSTRAP_TABS_MS);
                ctrl.browser._aboutBlankMaxAgeMs[nome] = Math.max(ctrl.browser._aboutBlankMaxAgeMs[nome] || 0, ABOUTBLANK_BOOT_MAX_AGE_MS);
                setTimeout(() => {
                  try {
                    const b = controllers.get(nome)?.browser;
                    if (!b) return;
                    if (b._suppressBlankKillUntil && b._suppressBlankKillUntil[nome]) delete b._suppressBlankKillUntil[nome];
                    if (b._aboutBlankMaxAgeMs && b._aboutBlankMaxAgeMs[nome]) delete b._aboutBlankMaxAgeMs[nome];
                  } catch {}
                }, BOOTSTRAP_TABS_MS + 5000);
              } catch {}

              browserHelper.installOneTabGuard(ctrl.browser, nome, {
                allow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  const actAt = (rm && rm.activatedAt) ? Number(rm.activatedAt) : 0;
                  const isBootstrap = !!(actAt && (Date.now() - actAt) < (Number.isFinite(BOOTSTRAP_TABS_MS) ? BOOTSTRAP_TABS_MS : 60000));
                  const swapUntil = Number((c && c.browser && c.browser._virtusSwapUntil && c.browser._virtusSwapUntil[nome]) || 0) || 0;
                  const isVirtusSwap = swapUntil > Date.now();
                  return !!(c && (c.configurando === true || c.humanControl === true || rm.emExecucao === true || isBootstrap === true || isVirtusSwap === true));
                },
                maxPagesWhenAllow: () => {
                  const c = controllers.get(nome);
                  const rm = robeMeta[nome] || {};
                  const actAt = (rm && rm.activatedAt) ? Number(rm.activatedAt) : 0;
                  const isBootstrap = !!(actAt && (Date.now() - actAt) < (Number.isFinite(BOOTSTRAP_TABS_MS) ? BOOTSTRAP_TABS_MS : 60000));
                  const swapUntil = Number((c && c.browser && c.browser._virtusSwapUntil && c.browser._virtusSwapUntil[nome]) || 0) || 0;
                  const isVirtusSwap = swapUntil > Date.now();
                  // Ultra enterprise: em modo humano/captcha, manter APENAS 1 aba (economia + previsibilidade).
                  if (c && c.humanControl === true) return 1;
                  // Swap controlado do Virtus precisa no máximo 2 abas (nova + antiga) por poucos segundos.
                  if (isVirtusSwap) return 2;
                  // CRÍTICO (provision/injetar cookies): durante configuração precisamos 3 abas estáveis:
                  // 0) FB base  1) FB create (item|vehicle)  2) Messenger
                  // Se bootstrap limitar para 2, ele fecha uma aba e causa exatamente o "atropelo" (Messenger sendo puxado pro create).
                  if (c && c.configurando === true) return 3;
                  // Bootstrap (fora de configure): permitir 2 abas para navegar Messenger+Facebook sem ser podado.
                  if (isBootstrap) return 2;
                  return rm.emExecucao === true ? 3 : 10;
                },
                getReason: () => {
                  try {
                    const c = controllers.get(nome);
                    const rm = robeMeta[nome] || {};
                    const actAt = (rm && rm.activatedAt) ? Number(rm.activatedAt) : 0;
                    const isBootstrap = !!(actAt && (Date.now() - actAt) < (Number.isFinite(BOOTSTRAP_TABS_MS) ? BOOTSTRAP_TABS_MS : 60000));
                    const swapUntil = Number((c && c.browser && c.browser._virtusSwapUntil && c.browser._virtusSwapUntil[nome]) || 0) || 0;
                    const isVirtusSwap = swapUntil > Date.now();
                    if (c && c.humanControl === true) return 'human';
                    if (isVirtusSwap) return 'virtus_swap';
                    if (c && c.configurando === true) return 'config';
                    if (rm && rm.emExecucao === true) return 'robe';
                    if (isBootstrap) return 'bootstrap';
                    return 'default';
                  } catch { return 'default'; }
                },
                onPrune: (info) => {
                  try {
                    provisionAudit.append({
                      ts: Date.now(),
                      event: 'one_tab_guard_prune',
                      nome: String(nome || ''),
                      ...info
                    });
                  } catch {}
                },
                onNumPages: (n) => {
                  robeMeta[nome] = robeMeta[nome] || {};
                  robeMeta[nome].numPages = n;
                  snapshotStatusAndWrite().catch(()=>{});
                }
              });
            } catch {}
            try {
              browserHelper.installAboutBlankKiller(ctrl.browser, nome, { graceMs: 7000 });
            } catch {}
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].closingReason = null;
        logger.info('[WORKER][activateOnce] done nome=' + nome + ' source=' + source);
        logger.info('[WORKER][activateOnce] concluído', { nome, source });
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'ok'); } catch {} }

        return { ok: true };
      } catch (e) {
        try {
          const st = readJsonFile(statusPath, null) || { perfis: [] };
          let found = false;
          if (Array.isArray(st.perfis)) {
            st.perfis = st.perfis.map(p => {
              if (p && p.nome === nome) { found = true; return { ...p, active: false }; }
              return p;
            });
          }
          if (!found) st.perfis.push({ nome, active: false });
          _statusLock = _statusLock.then(async () => {
            const ok = writeJsonAtomic(statusPath, st);
            if (!ok) { try { await issues.append('system','persist_failed', `${nome}|activateOnce_fail_status`); } catch {} }
          });
        } catch {}
        try { await reportAction(nome, 'activate_failed', 'Falha ao abrir navegador: ' + (e && e.message)); } catch {}
        if (e && /ram_insuficiente_para_ativar|headroom_below_min_after_open/.test(String(e && e.message || e))) {
          robeMeta[nome] = robeMeta[nome] || {};
          // NOVO: Reduzido de 15s para 5s (supervisor já controla velocidade)
          robeMeta[nome].activationHeldUntil = Date.now() + 5000;
          try { await reportAction(nome, 'mil_action', 'activation_hold_due_ram 5s (activateOnce)'); } catch {}
        }
        logger.error('[WORKER][activateOnce] fail', { nome, source, err: e && e.message || e }, e);
        if (_supervisorSlotGranted) { try { await supervisorClient.notifyOpened(nome, 'err'); } catch {} }
        return { ok: false, error: e && e.message || String(e) };
      } finally {
        activationLocks.delete(nome);
      }
    })();

    activationLocks.set(nome, job);
    return await job;
  } finally {
    delete opening[nome];
  }
}

function sendReply(msgId, data) {
  if (process && process.send) {
    process.send({ replyTo: msgId, data });
  }
}

function loadPerfisJson() {
  try {
    const arr = JSON.parse(fs.readFileSync(perfisPath, 'utf8'));
    if (!SHARD_SET.size) return arr;
    return arr.filter(p => p && p.nome && inShard(p.nome));
  } catch { return []; }
}
const ROBE_DAILY_PLAN_BASE_CFG = {
  // Runtime atual (V1): gate de janela diária desativado.
  enabled: false,
  windowStartMin: 6 * 60,
  windowEndMin: 23 * 60,
  offdayRatio: 0.25,
  priorityBandMinHour: 6,
  priorityBandMaxHour: 12,
  priorityBandRatio: Math.max(0, Math.min(1, Number(process.env.ROBE_DAILY_PLAN_MAIN_RATIO || 0.60) || 0.60)),
  minGapMin: Math.max(10, Number(process.env.ROBE_DAILY_PLAN_MIN_GAP_MIN || 20) || 20),
  gateLogEveryMs: Math.max(60_000, Number(process.env.ROBE_DAILY_PLAN_GATE_LOG_EVERY_MS || 10 * 60_000) || 10 * 60_000),
  dailyHoursMin: 1,
  dailyHoursMax: 14,
  vtagBase: 'robe_daily_plan_v2'
};
const ROBE_SESSION_V2_BASE_CFG = {
  // Runtime atual (V1): sessão em lote V2 desativada.
  enabled: false,
  minPostsPerHour: 2.2,
  maxPostsPerHour: 3.4,
  jitterMin: 0.85,
  jitterMax: 1.15,
  lotMin: 1,
  lotMax: 5,
  pauseShortMin: 10,
  pauseShortMax: 30,
  pauseMediumMin: 30,
  pauseMediumMax: 90,
  pauseLongMin: 90,
  pauseLongMax: 180,
  longPauseChance: 0.12,
  mediumPauseChance: 0.40,
  techPauseMinMs: 15_000,
  techPauseMaxMs: 90_000,
  vtagBase: 'robe_block_session_v3'
};
let _runtimeServerConfigCache = { at: 0, totalMemMB: 0, value: null };
function getRuntimeServerConfig(totalMemMB = 0) {
  const now = Date.now();
  const tmb = Number(totalMemMB || 0) || Math.round(os.totalmem() / (1024 * 1024));
  const stale = (now - Number(_runtimeServerConfigCache.at || 0)) > 10_000;
  const memDrift = Math.abs((Number(_runtimeServerConfigCache.totalMemMB || 0)) - tmb) > 256;
  if (!stale && !memDrift && _runtimeServerConfigCache.value) return _runtimeServerConfigCache.value;
  let cfg = null;
  try { cfg = serverConfig.readServerConfigEffective({ totalMemMB: tmb }); } catch {}
  _runtimeServerConfigCache = { at: now, totalMemMB: tmb, value: cfg };
  return cfg;
}
function getRobeDailyPlanCfg(totalMemMB = 0) {
  const base = ROBE_DAILY_PLAN_BASE_CFG;
  const eff = getRuntimeServerConfig(totalMemMB);
  const robe = eff && eff.robe ? eff.robe : {};
  const dMin = Math.max(1, Math.min(24, Number(robe.dailyHoursMin || base.dailyHoursMin) || base.dailyHoursMin));
  const dMax = Math.max(dMin, Math.min(24, Number(robe.dailyHoursMax || base.dailyHoursMax) || base.dailyHoursMax));
  const wStart = Math.max(0, Math.min(1439, Number(robe.windowStartMin || base.windowStartMin) || base.windowStartMin));
  const wEnd = Math.max(wStart + 1, Math.min(1440, Number(robe.windowEndMin || base.windowEndMin) || base.windowEndMin));
  const bandMinRaw = Math.max(1, Math.min(24, Number(robe.priorityBandMinHour || base.priorityBandMinHour) || base.priorityBandMinHour));
  const bandMaxRaw = Math.max(1, Math.min(24, Number(robe.priorityBandMaxHour || base.priorityBandMaxHour) || base.priorityBandMaxHour));
  const bandMinSorted = Math.min(bandMinRaw, bandMaxRaw);
  const bandMaxSorted = Math.max(bandMinRaw, bandMaxRaw);
  const bandMin = Math.max(dMin, Math.min(dMax, bandMinSorted));
  const bandMax = Math.max(bandMin, Math.min(dMax, bandMaxSorted));
  const bandRatioRaw = (robe && robe.priorityBandRatio !== undefined && robe.priorityBandRatio !== null)
    ? Number(robe.priorityBandRatio)
    : Number(base.priorityBandRatio);
  const bandRatioBase = Number.isFinite(bandRatioRaw) ? bandRatioRaw : Number(base.priorityBandRatio);
  const bandRatio = Math.max(0, Math.min(1, bandRatioBase));
  const sig = `${wStart}-${wEnd}-${dMin}-${dMax}-${bandMin}-${bandMax}-${bandRatio.toFixed(4)}`;
  return {
    ...base,
    windowStartMin: wStart,
    windowEndMin: wEnd,
    dailyHoursMin: dMin,
    dailyHoursMax: dMax,
    priorityBandMinHour: bandMin,
    priorityBandMaxHour: bandMax,
    priorityBandRatio: bandRatio,
    vtag: `${base.vtagBase}:${sig}`
  };
}
function getRobeSessionV2Cfg(totalMemMB = 0) {
  const base = ROBE_SESSION_V2_BASE_CFG;
  const eff = getRuntimeServerConfig(totalMemMB);
  const robe = eff && eff.robe ? eff.robe : {};
  const pMin = Math.max(0.1, Math.min(12, Number(robe.postsPerHourMin || base.minPostsPerHour) || base.minPostsPerHour));
  const pMax = Math.max(pMin, Math.min(12, Number(robe.postsPerHourMax || base.maxPostsPerHour) || base.maxPostsPerHour));
  const sig = `${pMin.toFixed(3)}-${pMax.toFixed(3)}`;
  return {
    ...base,
    minPostsPerHour: pMin,
    maxPostsPerHour: pMax,
    vtag: `${base.vtagBase}:${sig}`
  };
}
function getRobeCooldownRangeCfg(totalMemMB = 0) {
  const eff = getRuntimeServerConfig(totalMemMB);
  const robe = eff && eff.robe ? eff.robe : {};
  const minRaw = Math.floor(Number(robe.cooldownMinMinutes || 25) || 25);
  const maxRaw = Math.floor(Number(robe.cooldownMaxMinutes || 50) || 50);
  const min = Math.max(1, Math.min(1440, Math.min(minRaw, maxRaw)));
  const max = Math.max(min, Math.min(1440, Math.max(minRaw, maxRaw)));
  return { minMinutes: min, maxMinutes: max };
}
function drawRobeCooldownMs(totalMemMB = 0) {
  const cfg = getRobeCooldownRangeCfg(totalMemMB);
  const winnerMin = cfg.minMinutes + Math.floor(Math.random() * ((cfg.maxMinutes - cfg.minMinutes) + 1));
  return winnerMin * 60 * 1000;
}

function getRobePhotoDeletePolicy(totalMemMB = 0) {
  const eff = getRuntimeServerConfig(totalMemMB);
  const robe = eff && eff.robe ? eff.robe : {};
  const raw = String(robe.photoDeletePolicy || "after_all_working_posted").trim().toLowerCase();
  return (raw === "after_first_confirmed_post")
    ? "after_first_confirmed_post"
    : "after_all_working_posted";
}
const _robeDailyPlanCache = new Map();
const _robeDailyPlanInFlight = new Map();
const _robeDailyGateState = new Map();
function _robeDailyDateYmd(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function _robeDailyNowMin(ts = Date.now()) {
  const d = new Date(ts);
  return (d.getHours() * 60) + d.getMinutes();
}
function _robeDailyHhmm(min) {
  const m = Math.max(0, Math.min(1439, Number(min || 0) || 0));
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
function _robeDateShiftYmd(dateYmd, days) {
  try {
    const d = new Date(`${String(dateYmd || '')}T12:00:00`);
    if (!Number.isFinite(d.getTime())) return '';
    d.setDate(d.getDate() + Number(days || 0));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}
function _robeGetLimitPostingRecoveryDays() {
  const n = Number.parseInt(process.env.ROBE_LIMIT_POSTING_RECOVERY_DAYS || '15', 10);
  if (!Number.isFinite(n)) return 15;
  return Math.max(1, Math.min(60, n));
}
function _robeGetLimitPostingLastAt(man = null, nowMs = Date.now()) {
  try {
    const base = Math.max(
      Number(man && man.robeLimitPostingLastAt || 0) || 0,
      Number(man && man.limitPostingLastAt || 0) || 0
    );
    const pauseReason = String(man && man.robePauseReason || '').toLowerCase();
    const active = pauseReason === 'limit_posting' && (
      (Number(man && man.robeCooldownUntil || 0) > Number(nowMs || 0)) ||
      (Number(man && man.robeCooldownRemainingMs || 0) > 0)
    );
    return active ? Math.max(base, Number(nowMs || 0) || 0) : base;
  } catch {
    return 0;
  }
}
function _robeIsLimitPostingRecoveryMode(man = null, nowMs = Date.now()) {
  const lastAt = _robeGetLimitPostingLastAt(man, nowMs);
  if (!(lastAt > 0)) return false;
  const winMs = _robeGetLimitPostingRecoveryDays() * 24 * 60 * 60 * 1000;
  return (Number(nowMs || 0) - lastAt) <= winMs;
}
function _robeMulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function _robeRandInt(rng, min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}
function _robeRandFloat(rng, min, max) {
  const lo = Math.min(Number(min || 0), Number(max || 0));
  const hi = Math.max(Number(min || 0), Number(max || 0));
  return lo + (rng() * (hi - lo));
}
function _robeClamp(v, lo, hi) {
  const n = Number(v || 0);
  return Math.max(Number(lo || 0), Math.min(Number(hi || 0), n));
}
function _robeSplitMinutes(total, count, minEach, rng) {
  const n = Math.max(1, Number(count || 1) || 1);
  let each = Math.max(1, Number(minEach || 1) || 1);
  if ((each * n) > total) each = Math.max(1, Math.floor(total / n) || 1);
  const out = Array.from({ length: n }, () => each);
  let rem = Math.max(0, total - (each * n));
  while (rem > 0) {
    const i = _robeRandInt(rng, 0, n - 1);
    out[i] += 1;
    rem -= 1;
  }
  return out;
}
function _robeFindCurrentBlockIndex(plan, nowMin) {
  if (!plan || !plan.enabled || !Array.isArray(plan.blocks)) return -1;
  for (let i = 0; i < plan.blocks.length; i++) {
    const b = plan.blocks[i] || {};
    const s = Number(b.startMin || 0) || 0;
    const e = Number(b.endMin || 0) || 0;
    if (nowMin >= s && nowMin < e) return i;
  }
  return -1;
}
function _isValidRobeSessionV2(sess, date, blockIndex) {
  const cfg = getRobeSessionV2Cfg();
  if (!sess || typeof sess !== 'object') return false;
  if (String(sess.version || '') !== String(cfg.vtag)) return false;
  if (String(sess.date || '') !== String(date || '')) return false;
  if (Number(sess.blockIndex) !== Number(blockIndex)) return false;
  if (!Array.isArray(sess.actions) || sess.actions.length < 1) return false;
  if (!Number.isFinite(Number(sess.ptr || 0))) return false;
  return true;
}
function _buildRobeSessionPlanDeterministic(nome, dateYmd, block, blockIndex, hostIdOpt = '', options = null) {
  const cfg = getRobeSessionV2Cfg();
  const sMin = Number(block && block.startMin || 0) || 0;
  const eMin = Number(block && block.endMin || 0) || 0;
  const durationMin = Math.max(1, eMin - sMin);
  const durationHours = durationMin / 60;
  const seedInput = `${cfg.vtag}|${String(nome || '')}|${String(dateYmd || '')}|${String(blockIndex || 0)}|${String(sMin)}|${String(eMin)}|${String(hostIdOpt || '')}`;
  const seedHex = crypto.createHash('sha256').update(seedInput).digest('hex').slice(0, 8);
  const seedInt = (parseInt(seedHex, 16) >>> 0) || 1;
  const rng = _robeMulberry32(seedInt);
  const isLimitPostingRecovery = !!(options && options.limitPostingRecovery);
  const ratePerHour = _robeRandFloat(rng, cfg.minPostsPerHour, cfg.maxPostsPerHour);
  const jitter = _robeRandFloat(rng, cfg.jitterMin, cfg.jitterMax);
  const rawTarget = durationHours * ratePerHour * jitter;
  const hardMax = Math.max(1, Math.round(durationHours * 5.2));
  const targetPosts = isLimitPostingRecovery
    ? 1
    : Math.max(1, Math.min(hardMax, Math.round(rawTarget)));
  let rem = targetPosts;
  const actions = [];
  if (isLimitPostingRecovery) {
    actions.push({ type: 'post', count: 1 });
    rem = 0;
  }
  while (rem > 0) {
    let lot = _robeRandInt(rng, cfg.lotMin, cfg.lotMax);
    if (lot > rem) lot = rem;
    actions.push({ type: 'post', count: lot });
    rem -= lot;
    if (rem <= 0) break;
    const r = rng();
    let pauseMin = 0;
    if (r < cfg.longPauseChance) {
      pauseMin = _robeRandInt(rng, cfg.pauseLongMin, cfg.pauseLongMax);
    } else if (r < (cfg.longPauseChance + cfg.mediumPauseChance)) {
      pauseMin = _robeRandInt(rng, cfg.pauseMediumMin, cfg.pauseMediumMax);
    } else {
      pauseMin = _robeRandInt(rng, cfg.pauseShortMin, cfg.pauseShortMax);
    }
    actions.push({ type: 'pause', min: pauseMin });
  }
  const first = actions[0] || {};
  return {
    version: cfg.vtag,
    date: String(dateYmd || ''),
    blockIndex: Number(blockIndex || 0) || 0,
    blockStartMin: sMin,
    blockEndMin: eMin,
    plannedPosts: targetPosts,
    postedPosts: 0,
    ptr: 0,
    remainingInAction: Number(first.count || 0) || 0,
    pauseUntil: 0,
    actions,
    seed: seedHex,
    ratePerHour: Number(ratePerHour.toFixed(3)),
    mode: isLimitPostingRecovery ? 'limit_posting_recovery' : 'normal',
    lastAdvanceAt: Date.now()
  };
}
function _advanceRobeSessionRuntime(session, nowMs = Date.now()) {
  const out = session && typeof session === 'object' ? session : null;
  if (!out || !Array.isArray(out.actions)) return { state: out, changed: false, allowPost: false, reason: 'invalid' };
  let changed = false;
  let guard = 0;
  while (guard < 24) {
    guard += 1;
    const ptr = Number(out.ptr || 0) || 0;
    const action = out.actions[ptr];
    if (!action) {
      return { state: out, changed, allowPost: false, reason: 'session_done' };
    }
    if (action.type === 'pause') {
      const pMin = Math.max(1, Number(action.min || 0) || 1);
      const pauseUntil = Number(out.pauseUntil || 0) || 0;
      if (pauseUntil <= 0) {
        out.pauseUntil = Number(nowMs) + (pMin * 60_000);
        out.lastAdvanceAt = Number(nowMs) || Date.now();
        changed = true;
      }
      if (Number(out.pauseUntil || 0) > Number(nowMs || 0)) {
        return { state: out, changed, allowPost: false, reason: 'in_pause' };
      }
      out.ptr = ptr + 1;
      out.pauseUntil = 0;
      const next = out.actions[out.ptr];
      if (next && next.type === 'post') out.remainingInAction = Math.max(1, Number(next.count || 0) || 1);
      else out.remainingInAction = 0;
      out.lastAdvanceAt = Number(nowMs) || Date.now();
      changed = true;
      continue;
    }
    if (action.type === 'post') {
      if (!Number.isFinite(Number(out.remainingInAction || 0)) || Number(out.remainingInAction || 0) <= 0) {
        out.remainingInAction = Math.max(1, Number(action.count || 0) || 1);
        changed = true;
      }
      if (Number(out.remainingInAction || 0) > 0) return { state: out, changed, allowPost: true, reason: 'post_window' };
      out.ptr = ptr + 1;
      out.lastAdvanceAt = Number(nowMs) || Date.now();
      changed = true;
      continue;
    }
    out.ptr = ptr + 1;
    changed = true;
  }
  return { state: out, changed, allowPost: false, reason: 'guard_stop' };
}
function _robeSessionTechnicalPauseMs() {
  const cfg = getRobeSessionV2Cfg();
  const span = Math.max(1, cfg.techPauseMaxMs - cfg.techPauseMinMs);
  return cfg.techPauseMinMs + Math.floor(Math.random() * span);
}
function _robeSessionSummary(session, nowMs = Date.now()) {
  if (!session || typeof session !== 'object') {
    return {
      featureEnabled: true,
      enabled: false,
      state: 'none',
      plannedPosts: 0,
      postedPosts: 0,
      remainingInAction: 0,
      pauseUntil: null,
      nextAtLabel: null
    };
  }
  const ptr = Number(session.ptr || 0) || 0;
  const action = Array.isArray(session.actions) ? session.actions[ptr] : null;
  const pauseUntil = Number(session.pauseUntil || 0) || 0;
  const state = !action
    ? 'done'
    : (action.type === 'pause'
      ? ((pauseUntil > Number(nowMs || 0)) ? 'pause' : 'pause_ready')
      : 'posting');
  const nextAtLabel = pauseUntil > 0 ? new Date(pauseUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return {
    featureEnabled: true,
    enabled: true,
    date: String(session.date || ''),
    blockIndex: Number(session.blockIndex || 0) || 0,
    state,
    plannedPosts: Number(session.plannedPosts || 0) || 0,
    postedPosts: Number(session.postedPosts || 0) || 0,
    remainingInAction: Math.max(0, Number(session.remainingInAction || 0) || 0),
    pauseUntil: pauseUntil > 0 ? pauseUntil : null,
    nextAtLabel
  };
}
async function getOrCreateRobeSessionGate(nome, nowMs = Date.now(), planHint = null, manifestHint = null) {
  const cfg = getRobeSessionV2Cfg();
  if (!cfg.enabled) {
    return { featureEnabled: false, allowPost: true, reason: 'disabled', technicalPauseMs: _robeSessionTechnicalPauseMs(), summary: _robeSessionSummary(null, nowMs) };
  }
  const plan = planHint || await getOrCreateRobeDailyPlan(nome, nowMs, manifestHint).catch(() => null);
  const nowMin = _robeDailyNowMin(nowMs);
  const idx = _robeFindCurrentBlockIndex(plan, nowMin);
  if (!plan || !plan.enabled || idx < 0) {
    return {
      featureEnabled: true,
      allowPost: false,
      reason: 'outside_block',
      technicalPauseMs: 0,
      summary: { featureEnabled: true, enabled: true, state: 'out_of_block', plannedPosts: 0, postedPosts: 0, remainingInAction: 0, pauseUntil: null, nextAtLabel: null }
    };
  }
  const block = (plan.blocks && plan.blocks[idx]) || null;
  const date = _robeDailyDateYmd(nowMs);
  const hostId = (readHostIdSync && typeof readHostIdSync === 'function') ? (readHostIdSync() || '') : '';
  let man = manifestHint || await manifestStore.read(nome).catch(() => null);
  let sess = man && man.robeBlockSessionV2 ? man.robeBlockSessionV2 : null;
  if (!_isValidRobeSessionV2(sess, date, idx)) {
    sess = _buildRobeSessionPlanDeterministic(nome, date, block, idx, hostId, {
      limitPostingRecovery: !!(plan && plan.limitPostingRecovery)
    });
    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        m.robeBlockSessionV2 = sess;
        return m;
      });
    } catch {}
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'robe_v2_session_plan_generated',
        nome: String(nome || ''),
        date: String(date || ''),
        blockIndex: Number(idx || 0),
        plannedPosts: Number(sess.plannedPosts || 0) || 0
      });
    } catch {}
  }
  const evalRes = _advanceRobeSessionRuntime(sess, nowMs);
  if (evalRes.changed) {
    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        m.robeBlockSessionV2 = evalRes.state;
        return m;
      });
    } catch {}
  }
  const summary = _robeSessionSummary(evalRes.state, nowMs);
  return {
    featureEnabled: true,
    allowPost: !!evalRes.allowPost,
    reason: String(evalRes.reason || ''),
    technicalPauseMs: evalRes.allowPost ? _robeSessionTechnicalPauseMs() : 0,
    session: evalRes.state,
    summary
  };
}
async function markRobeSessionPostConsumed(nome, nowMs = Date.now()) {
  if (!getRobeSessionV2Cfg().enabled) return;
  try {
    await manifestStore.update(nome, (m) => {
      m = m || {};
      const sess = (m && m.robeBlockSessionV2 && typeof m.robeBlockSessionV2 === 'object') ? m.robeBlockSessionV2 : null;
      if (!sess || !Array.isArray(sess.actions)) return m;
      const ptr = Number(sess.ptr || 0) || 0;
      const action = sess.actions[ptr];
      if (!action || action.type !== 'post') return m;
      const rem = Math.max(0, (Number(sess.remainingInAction || 0) || 0) - 1);
      sess.remainingInAction = rem;
      sess.postedPosts = (Number(sess.postedPosts || 0) || 0) + 1;
      if (rem <= 0) {
        sess.ptr = ptr + 1;
        const next = sess.actions[sess.ptr];
        if (next && next.type === 'pause') {
          const pauseMin = Math.max(1, Number(next.min || 0) || 1);
          sess.pauseUntil = Number(nowMs || Date.now()) + (pauseMin * 60_000);
          sess.remainingInAction = 0;
        } else if (next && next.type === 'post') {
          sess.pauseUntil = 0;
          sess.remainingInAction = Math.max(1, Number(next.count || 0) || 1);
        } else {
          sess.pauseUntil = 0;
          sess.remainingInAction = 0;
        }
      }
      sess.lastAdvanceAt = Number(nowMs) || Date.now();
      m.robeBlockSessionV2 = sess;
      return m;
    });
  } catch {}
}
function _isValidRobeDailyPlan(plan, date) {
  const cfg = getRobeDailyPlanCfg();
  if (!plan || typeof plan !== 'object') return false;
  if (String(plan.version || '') !== String(cfg.vtag)) return false;
  if (String(plan.date || '') !== String(date || '')) return false;
  if (typeof plan.enabled !== 'boolean') return false;
  if (!plan.enabled) return true;
  if (!Array.isArray(plan.blocks) || plan.blocks.length < 1 || plan.blocks.length > 3) return false;
  for (const b of plan.blocks) {
    if (!b || typeof b !== 'object') return false;
    const s = Number(b.startMin || 0);
    const e = Number(b.endMin || 0);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s || e > 24 * 60) return false;
  }
  return true;
}
function _buildRobeDailyPlanDeterministic(nome, dateYmd, hostIdOpt = '', options = null) {
  const cfg = getRobeDailyPlanCfg();
  const seedInput = `${cfg.vtag}|${String(nome || '')}|${String(dateYmd || '')}|${String(hostIdOpt || '')}`;
  const seedHex = crypto.createHash('sha256').update(seedInput).digest('hex').slice(0, 8);
  const seedInt = (parseInt(seedHex, 16) >>> 0) || 1;
  const rng = _robeMulberry32(seedInt);
  const forceOn = !!(options && options.forceOn);
  const forceDailyHours = Number(options && options.forceDailyHours || 0) || 0;
  const offRoll = rng();
  const shouldWork = forceOn ? true : !(offRoll < cfg.offdayRatio);
  if (!shouldWork) {
    return {
      version: cfg.vtag,
      date: String(dateYmd || ''),
      enabled: false,
      dailyHours: 0,
      blocks: [],
      seed: seedHex
    };
  }
  let dailyHours = 0;
  const usePriorityBand = rng() < cfg.priorityBandRatio;
  if (usePriorityBand) {
    dailyHours = _robeRandInt(rng, cfg.priorityBandMinHour, cfg.priorityBandMaxHour);
  } else {
    const complement = [];
    for (let h = cfg.dailyHoursMin; h <= cfg.dailyHoursMax; h++) {
      if (h < cfg.priorityBandMinHour || h > cfg.priorityBandMaxHour) complement.push(h);
    }
    if (complement.length > 0) {
      dailyHours = complement[_robeRandInt(rng, 0, complement.length - 1)];
    } else {
      dailyHours = _robeRandInt(rng, cfg.priorityBandMinHour, cfg.priorityBandMaxHour);
    }
  }
  if (forceDailyHours > 0) {
    dailyHours = Math.max(1, Math.round(forceDailyHours));
  }
  dailyHours = Math.max(cfg.dailyHoursMin, Math.min(cfg.dailyHoursMax, dailyHours));
  let blocksCount = 1;
  if (dailyHours <= 3) blocksCount = 1;
  else if (dailyHours <= 8) blocksCount = (rng() < 0.60 ? 1 : 2);
  else blocksCount = (rng() < 0.50 ? 2 : 3);
  const totalMin = Math.max(60, dailyHours * 60);
  const windowLen = Math.max(1, cfg.windowEndMin - cfg.windowStartMin);
  while (blocksCount > 1 && (totalMin + (cfg.minGapMin * (blocksCount - 1))) > windowLen) {
    blocksCount -= 1;
  }
  blocksCount = Math.max(1, Math.min(3, blocksCount));
  const durations = _robeSplitMinutes(totalMin, blocksCount, 45, rng);
  const required = durations.reduce((a, b) => a + b, 0) + (cfg.minGapMin * (blocksCount - 1));
  const slack = Math.max(0, windowLen - required);
  const slackChunks = _robeSplitMinutes(slack, blocksCount + 1, 0, rng);
  const blocks = [];
  let cursor = cfg.windowStartMin + (slackChunks[0] || 0);
  for (let i = 0; i < blocksCount; i++) {
    const d = durations[i] || 0;
    const s = cursor;
    const e = Math.min(cfg.windowEndMin, s + d);
    blocks.push({ startMin: s, endMin: e });
    if (i < blocksCount - 1) {
      cursor = e + cfg.minGapMin + (slackChunks[i + 1] || 0);
    }
  }
  return {
    version: cfg.vtag,
    date: String(dateYmd || ''),
    enabled: true,
    dailyHours,
    blocks,
    seed: seedHex,
    forceOn: forceOn === true
  };
}
function _applyRobeDailyHardRules(nome, dateYmd, hostId, basePlan, prevPlan, man, nowMs = Date.now()) {
  const prevDate = _robeDateShiftYmd(dateYmd, -1);
  const prevWasOff = !!(prevPlan && String(prevPlan.date || '') === prevDate && prevPlan.enabled === false);
  const limitRecovery = _robeIsLimitPostingRecoveryMode(man, nowMs);
  const shouldForceOn = !!(prevWasOff || limitRecovery);
  let out = basePlan && typeof basePlan === 'object' ? { ...basePlan } : null;
  if (!out) return { plan: out, flags: { prevWasOff, limitRecovery, forcedOn: false }, limitLastAt: _robeGetLimitPostingLastAt(man, nowMs) };
  if (shouldForceOn && out.enabled !== true) {
    const forceHours = limitRecovery ? 1 : 6;
    out = _buildRobeDailyPlanDeterministic(nome, dateYmd, hostId, { forceOn: true, forceDailyHours: forceHours });
  }
  if (out.enabled === true && limitRecovery) {
    out.limitPostingRecovery = true;
  }
  out.decisionReason = limitRecovery
    ? 'forced_on_limit_posting_recovery'
    : (prevWasOff ? 'forced_on_prev_day_off' : 'deterministic_daily_plan');
  return {
    plan: out,
    flags: { prevWasOff, limitRecovery, forcedOn: shouldForceOn && out.enabled === true },
    limitLastAt: _robeGetLimitPostingLastAt(man, nowMs)
  };
}
async function getOrCreateRobeDailyPlan(nome, nowMs = Date.now(), manifestHint = null) {
  const date = _robeDailyDateYmd(nowMs);
  const c = _robeDailyPlanCache.get(nome);
  if (c && c.date === date && c.plan && _isValidRobeDailyPlan(c.plan, date)) return c.plan;
  const inflight = _robeDailyPlanInFlight.get(nome);
  if (inflight) {
    try { await inflight; } catch {}
    const c2 = _robeDailyPlanCache.get(nome);
    if (c2 && c2.date === date && c2.plan && _isValidRobeDailyPlan(c2.plan, date)) return c2.plan;
  }
  const job = (async () => {
    const hostId = (readHostIdSync && typeof readHostIdSync === 'function') ? (readHostIdSync() || '') : '';
    const man = manifestHint || await manifestStore.read(nome).catch(()=>null);
    const prevPlan = man && man.robeDailyPlanV1 ? man.robeDailyPlanV1 : null;
    let plan = prevPlan;
    if (!_isValidRobeDailyPlan(plan, date)) {
      const basePlan = _buildRobeDailyPlanDeterministic(nome, date, hostId);
      const hard = _applyRobeDailyHardRules(nome, date, hostId, basePlan, prevPlan, man, nowMs);
      plan = hard.plan;
      try {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          m.robeDailyPlanV1 = plan;
          if (hard.limitLastAt > 0) m.robeLimitPostingLastAt = hard.limitLastAt;
          return m;
        });
      } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'robe_plan_generated',
          nome: String(nome || ''),
          date: String(date || ''),
          enabled: !!plan.enabled,
          dailyHours: Number(plan.dailyHours || 0) || 0,
          blocksCount: Array.isArray(plan.blocks) ? plan.blocks.length : 0,
          decisionReason: String(plan && plan.decisionReason || 'deterministic_daily_plan'),
          limitPostingRecovery: !!(plan && plan.limitPostingRecovery),
          forcedOn: !!(hard.flags && hard.flags.forcedOn)
        });
      } catch {}
    }
    _robeDailyPlanCache.set(nome, { date, plan });
    return plan;
  })();
  _robeDailyPlanInFlight.set(nome, job);
  try { return await job; }
  finally { _robeDailyPlanInFlight.delete(nome); }
}
function _robeDailyPlanSummary(plan, nowMs = Date.now()) {
  const nowMin = _robeDailyNowMin(nowMs);
  const featureEnabled = !!(getRobeDailyPlanCfg().enabled === true);
  if (!plan) return { featureEnabled, enabled: false, dailyHours: 0, blocksCount: 0, blocks: [], inWindowNow: false, nextWindowStartMin: null, nextWindowLabel: null };
  const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
  const inWindowNow = !!(plan.enabled && blocks.some((b) => nowMin >= Number(b.startMin || 0) && nowMin < Number(b.endMin || 0)));
  let nextWindowStartMin = null;
  if (plan.enabled) {
    for (const b of blocks) {
      const s = Number(b.startMin || 0);
      if (s > nowMin) { nextWindowStartMin = s; break; }
    }
  }
  return {
    featureEnabled,
    date: String(plan.date || ''),
    enabled: !!plan.enabled,
    dailyHours: Number(plan.dailyHours || 0) || 0,
    decisionReason: String(plan.decisionReason || 'deterministic_daily_plan'),
    limitPostingRecovery: !!plan.limitPostingRecovery,
    blocksCount: blocks.length,
    blocks: blocks.map((b) => ({
      startMin: Number(b.startMin || 0) || 0,
      endMin: Number(b.endMin || 0) || 0,
      label: `${_robeDailyHhmm(Number(b.startMin || 0) || 0)}-${_robeDailyHhmm(Number(b.endMin || 0) || 0)}`
    })),
    inWindowNow,
    nextWindowStartMin: nextWindowStartMin == null ? null : nextWindowStartMin,
    nextWindowLabel: nextWindowStartMin == null ? null : _robeDailyHhmm(nextWindowStartMin)
  };
}
async function isRobeWindowOpenNow(nome, nowMs = Date.now()) {
  const plan = await getOrCreateRobeDailyPlan(nome, nowMs).catch(()=>null);
  const s = _robeDailyPlanSummary(plan, nowMs);
  const allow = !!(s && s.enabled === true && s.inWindowNow === true);
  const reason = (!s || s.enabled !== true) ? 'offday' : (s.inWindowNow ? 'in_window' : 'outside_window');
  try {
    const prev = _robeDailyGateState.get(nome) || {};
    const now = Date.now();
    const changed = (prev.allow !== allow);
    const cfg = getRobeDailyPlanCfg();
    const due = !prev.lastLogAt || (now - Number(prev.lastLogAt || 0)) >= cfg.gateLogEveryMs;
    if (changed || due) {
      provisionAudit.append({
        ts: now,
        event: allow ? 'robe_gate_open' : 'robe_gate_closed',
        nome: String(nome || ''),
        reason,
        date: String((s && s.date) || ''),
        dailyHours: Number((s && s.dailyHours) || 0) || 0,
        blocksCount: Number((s && s.blocksCount) || 0) || 0
      });
      _robeDailyGateState.set(nome, { allow, lastLogAt: now });
    }
  } catch {}
  return allow;
}
function savePerfisJson(arr) {
  // CRÍTICO (cluster): nunca permitir que um worker shard sobrescreva o perfis.json global.
  // Manter esta função apenas por compatibilidade com trechos antigos (não deve ser usada para writes shard).
  try {
    if (SHARD_SET && SHARD_SET.size) {
      try { provisionAudit.append({ ts: Date.now(), event: 'perfis_write_blocked_worker_shard', shardSize: SHARD_SET.size }); } catch {}
      return false;
    }
    try { return fileStore.savePerfisJson(arr); } catch { return false; }
  } catch { return false; }
}

function pickUaPreset() {
  try {
    // Fonte única de escolha: fileStore (usa política ponderada/curada).
    return fileStore.pickUaPreset();
  } catch {
    return null;
  }
}

async function normalizeCooldown(nome) {
  try {
    const now = Date.now();
    const ctrl = controllers.get(nome);
    const man = await manifestStore.read(nome).catch(()=>null);
    try {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].pauseReason = man.robePauseReason || null;
    } catch {}
    if (!man) return 0;
    const until = Number(man.robeCooldownUntil || 0);
    const remaining = Number(man.robeCooldownRemainingMs || 0);
    const leftUntil = until > now ? (until - now) : 0;
    const leftRem = remaining > 0 ? remaining : 0;

    if (leftUntil > 0 && leftRem > 0 && Math.abs(leftUntil - leftRem) > 60*1000) {
      const winner = Math.max(leftUntil, leftRem);
      if (ctrl && ctrl.trabalhando && !ctrl.humanControl) {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = now + winner;
          m.robeCooldownRemainingMs = 0;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using until=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      } else {
        await manifestStore.update(nome, m => {
          m = m || {};
          m.robeCooldownUntil = 0;
          m.robeCooldownRemainingMs = winner;
          return m;
        });
        await issues.append(nome, 'mil_action', `cooldown_reconciled: using remaining=${winner}ms (from both)`);
        return Math.floor(winner/1000);
      }
    }
    const finalMs = leftUntil > 0 ? leftUntil : leftRem;
    try {
      if (finalMs === 0) {
        await releaseLimitPostingIfExpired(nome);
      }
    } catch {}
    return Math.max(0, Math.floor(finalMs/1000));
  } catch { return 0; }
}

function _robeBlockedByFromMeta(robeEntry = {}) {
  try {
    const cooldownSec = Number(robeEntry && robeEntry.cooldownSec || 0) || 0;
    const pauseReason = String((robeEntry && robeEntry.pauseReason) || '').trim().toLowerCase();
    if (robeEntry && robeEntry.emExecucao) return 'executing';
    if (robeEntry && robeEntry.emFila) return 'queue_busy';
    if (pauseReason === 'limit_posting') return 'limit_posting';
    if (cooldownSec > 0 && pauseReason) return `pause_${pauseReason}`;
    if (cooldownSec > 0) return 'legacy_cooldown';
    return 'none';
  } catch {
    return 'none';
  }
}

async function releaseLimitPostingIfExpired(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    if (!man) return false;
    const now = Date.now();
    const hasLimitPosting = (man.robePauseReason === 'limit_posting');
    const stillOn = (Number(man.robeCooldownUntil||0) > now) || (Number(man.robeCooldownRemainingMs||0) > 0);
    if (hasLimitPosting && !stillOn) {
      await manifestStore.update(nome, m => {
        m = m || {};
        if (m.robePauseReason === 'limit_posting') delete m.robePauseReason;
        return m;
      });
      robeMeta[nome] = robeMeta[nome] || {};
      delete robeMeta[nome].pauseReason;
      try { await issues.append(nome, 'mil_action', 'limit_posting_release'); } catch {}
      return true;
    }
  } catch {}
  return false;
}

function robeCooldownLeft(nome) {
  let left = 0;
  try {
    const ctrl = controllers.get(nome);
    const working = !!(ctrl && ctrl.browser && ctrl.trabalhando && !ctrl.configurando);
    const humanControl = !!(ctrl && ctrl.humanControl);
    const mPath = manifestPathOf(nome);
    if (fs.existsSync(mPath)) {
      const p = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const now = Date.now();
      if (working && !humanControl) {
        const until = Number(p.robeCooldownUntil || 0);
        if (until > now) {
          left = Math.floor((until - now) / 1000);
        }
      } else {
        const remaining = Number(p.robeCooldownRemainingMs || 0);
        if (remaining > 0) {
          left = Math.floor(remaining > 0 ? remaining / 1000 : 0);
        } else {
          const until = Number(p.robeCooldownUntil || 0);
          if (until > now) {
            left = Math.floor((until - now) / 1000);
          }
        }
      }
      if (left < 0) left = 0;
    }
  } catch {}
  return left;
}

async function robeLastPosted(nome) {
  let ts = 0;
  try {
    const p = await manifestStore.read(nome).catch(()=>null);
    if (p && p.ultimaPostagemRobe) ts = p.ultimaPostagemRobe;
  } catch {}
  return ts;
}

function robeUpdateMeta(nome, patch) {
  robeMeta[nome] = robeMeta[nome] || {};
  Object.assign(robeMeta[nome], patch || {});
}

function getWorkingProfileNames() {
  const nomes = [];
  controllers.forEach((ctrl, nome) => {
    if (ctrl && ctrl.browser && ctrl.trabalhando) nomes.push(nome);
  });
  return nomes;
}

async function closeExtraPages(browser, mainPage, nome) {
  try {
    const issues = require('./issues.js');
    const pages = await browser.pages();
    let closed = 0;

    const ctrl = controllers.get(nome);
    const sendLockActive = ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active;
    const inRobe = (browser && browser._robeActiveFor === nome) || (nome && robeMeta[nome] && robeMeta[nome].emExecucao === true);
    const inConfig = ctrl && ctrl.configurando === true;
    const inHuman = ctrl && ctrl.humanControl === true;
    const inVirtusSwap = !!(browser && browser._virtusSwapUntil && Number(browser._virtusSwapUntil[nome] || 0) > Date.now());

    if (!(sendLockActive || inRobe || inConfig || inHuman || inVirtusSwap)) {
      for (const p of pages) {
        try {
          if (mainPage && p === mainPage) continue;
          if (!mainPage && pages[0] && p === pages[0]) continue;
          let url = ''; try { url = typeof p.url === 'function' ? url = p.url() : ''; } catch {}
          if (!url || url === 'about:blank') {
            await p.close({ runBeforeUnload: false }).catch(()=>{});
            closed++;
          }
        } catch {}
      }
    }

    if (!(sendLockActive || inRobe || inConfig || inHuman || inVirtusSwap)) {
      const again = await browser.pages();
      for (const p of again) {
        if (mainPage && p === mainPage) continue;
        if (!mainPage && again[0] && p === again[0]) continue;
        await p.close({ runBeforeUnload: false }).catch(()=>{});
        closed++;
      }
    }

    if (closed > 0) {
      logger.info('[PRUNER] Fechou abas extras', { nome, closed });
      try { await issues.append(nome, 'mil_action', `pruner_closed_extras n=${closed}`); } catch {}
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
    }
  }
}

const _pruners = new Map();

function maybeStartPruneLoop(nome, browser, mainPage) {
  if (_pruners.has(nome)) return;
  const interval = setInterval(async () => {
    try {
      await closeExtraPages(browser, mainPage, nome);
    } catch (e) {
      if (process.env.PRUNE_DEBUG === '1') {
        logger.warn('[PRUNER] Erro prune', { nome, error: e && e.message || e });
      }
    }
  }, 2*60*1000);
  _pruners.set(nome, interval);
  // #region agent log
  __agentLog('H2', 'worker.js:maybeStartPruneLoop', 'pruner_started', { nome: String(nome || ''), prunersSize: _pruners.size, controllersSize: controllers.size }, `pruner.start.${String(nome || '')}`, 20000);
  // #endregion
}

function stopPruneLoop(nome) {
  const had = _pruners.has(nome);
  if (_pruners.has(nome)) {
    clearInterval(_pruners.get(nome));
    _pruners.delete(nome);
  }
  // #region agent log
  __agentLog('H2', 'worker.js:stopPruneLoop', 'pruner_stopped', { nome: String(nome || ''), had, prunersSize: _pruners.size, controllersSize: controllers.size }, `pruner.stop.${String(nome || '')}`, 20000);
  // #endregion
}

function cleanupProfileTransientLocks(nome, source) {
  try {
    if (!nome) return;
    const hasController = controllers.has(nome);
    if (hasController) return;
    const hadProfileLock = _profileOpLocks.has(nome);
    const hadActivationLock = activationLocks.has(nome);
    const hadOpening = !!(opening && opening[nome]);
    if (hadProfileLock) _profileOpLocks.delete(nome);
    if (hadActivationLock) activationLocks.delete(nome);
    if (hadOpening) delete opening[nome];
    // #region agent log
    __agentLog(
      'H3',
      'worker.js:cleanupProfileTransientLocks',
      'cleanup_transient_locks',
      {
        nome: String(nome || ''),
        source: String(source || ''),
        hasControllerAfter: controllers.has(nome),
        hadProfileLock,
        hadActivationLock,
        hadOpening,
        profileOpLocksSize: _profileOpLocks.size,
        activationLocksSize: activationLocks.size,
        openingKeys: Object.keys(opening || {}).length
      },
      `cleanup.transient.${String(source || 'unknown')}.${String(nome || '')}`,
      5000
    );
    // #endregion
  } catch {}
}

let ramMonitorInterval = null;

// ====== ELEIÇÃO DE LÍDER DE MÉTRICAS (UM POR HOST) ======
// Somente o líder executa o monitor pesado de RAM/CPU (WMI/pidusage).
// Demais workers apenas aguardam e consomem os dados via robeMeta/status.json.
const METRICS_LEADER_FILE = path.join(__dirname, '..', 'dados', 'metrics_leader.lock');
const METRICS_LEADER_STALE_MS = 60 * 1000; // 60s
let isMetricsLeaderFlag = false;

function ensureMetricsLeader() {
  try {
    const now = Date.now();

    // Se já somos líder, apenas atualiza o heartbeat no arquivo
    if (isMetricsLeaderFlag) {
      try {
        fs.writeFileSync(
          METRICS_LEADER_FILE,
          JSON.stringify({ pid: process.pid, ts: now }),
          'utf8'
        );
      } catch {}
      return true;
    }

    // Tenta adquirir lock criando o arquivo em modo exclusivo
    try {
      const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      isMetricsLeaderFlag = true;
      return true;
    } catch {
      // Arquivo já existe — verificar se está STALE
      let data = null;
      try {
        const raw = fs.readFileSync(METRICS_LEADER_FILE, 'utf8');
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
      const ts = data && typeof data.ts === 'number' ? data.ts : 0;
      if (!ts || (now - ts) > METRICS_LEADER_STALE_MS) {
        // Considera líder anterior como morto/stale — tenta assumir
        try { fs.unlinkSync(METRICS_LEADER_FILE); } catch {}
        try {
          const fd = fs.openSync(METRICS_LEADER_FILE, 'wx');
          try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: now }), 'utf8');
          } finally {
            fs.closeSync(fd);
          }
          isMetricsLeaderFlag = true;
          return true;
        } catch {
          // Outro processo venceu a corrida — não somos líder
          return false;
          }
      }
      // Arquivo recente: outro worker é o líder
      return false;
        }
      } catch {
    return false;
      }
    }

// Helpers para coleta de memória por PID — sem WMI/PowerShell
async function getWinTasklistMap() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO','CSV','/NH'], { windowsHide: true, maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const lines = stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        // CSV: "Image Name","PID","Session Name","Session#","Mem Usage"
        let s = line.trim();
        if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
        const cols = s.split('","'); // simples e robusto p/ tasklist
        if (cols.length < 5) continue;
        const pidStr = cols[1].trim();
        const memStr = cols[4].trim(); // ex.: "123.456 K" (com separador)
        const pid = parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) continue;
        const memKB = parseInt(memStr.replace(/[^\d]/g, ''), 10); // remove pontos/virgulas/K
        if (!Number.isFinite(memKB)) continue;
        const memMB = Math.round(memKB / 1024);
        map[pid] = memMB;
      }
      resolve(map);
    });
  });
}

async function getPosixPsMap() {
  // Linux/macOS: ps -o pid=,rss= (rss em KB)
  // macOS usa 'ps -axo pid=,rss=' e Linux também aceita 'ps -o pid=,rss='
  const args = process.platform === 'darwin'
    ? ['-axo','pid=,rss=']
    : ['-o','pid=,rss=','-A'];
  return new Promise((resolve) => {
    execFile('ps', args, { maxBuffer: 10*1024*1024 }, (err, stdout) => {
      if (err || !stdout) return resolve({});
      const map = {};
      const lines = stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pid = parseInt(parts[0], 10);
        const rssKB = parseInt(parts[1], 10);
        if (!Number.isFinite(pid) || !Number.isFinite(rssKB)) continue;
        const memMB = Math.round(rssKB / 1024);
        map[pid] = memMB;
      }
      resolve(map);
    });
  });
}

// === INÍCIO: PID discovery via CDP/Tracing (sem WMI) ===
const PIDS_CACHE_TTL_MS = parseInt(process.env.RAM_PIDS_CACHE_TTL_MS || '180000', 10); // 180s
const PIDS_TRACE_MS     = parseInt(process.env.RAM_PIDS_TRACE_MS || '160', 10);       // amostra curta
const PIDS_REFRESH_PER_TICK = parseInt(process.env.RAM_PIDS_REFRESH_PER_TICK || '1', 10);
const PIDS_TRACE_HARD_TIMEOUT_MS = parseInt(process.env.RAM_PIDS_TRACE_HARD_TIMEOUT_MS || '3000', 10);
const CDP_HEAVY_BUDGET_ENABLED = String(process.env.CDP_HEAVY_BUDGET_ENABLED || '1').trim() !== '0';
const CDP_HEAVY_WINDOW_MS = Math.max(60000, parseInt(process.env.CDP_HEAVY_WINDOW_MS || '900000', 10) || 900000);
const CDP_HEAVY_MAX_PER_WINDOW = Math.max(1, parseInt(process.env.CDP_HEAVY_MAX_PER_WINDOW || '2', 10) || 2);
const CDP_HEAVY_MIN_GAP_MS = Math.max(10000, parseInt(process.env.CDP_HEAVY_MIN_GAP_MS || '180000', 10) || 180000);
const CDP_HEAVY_BACKOFF_BASE_MS = Math.max(10000, parseInt(process.env.CDP_HEAVY_BACKOFF_BASE_MS || '30000', 10) || 30000);
const CDP_HEAVY_BACKOFF_MAX_MS = Math.max(CDP_HEAVY_BACKOFF_BASE_MS, parseInt(process.env.CDP_HEAVY_BACKOFF_MAX_MS || '600000', 10) || 600000);
const CDP_IO_READ_CHUNK_SIZE = Math.max(64 * 1024, parseInt(process.env.CDP_IO_READ_CHUNK_SIZE || String(1 << 20), 10) || (1 << 20));
const CDP_IO_READ_MAX_CHUNKS = Math.max(4, parseInt(process.env.CDP_IO_READ_MAX_CHUNKS || '64', 10) || 64);
const CDP_IO_READ_MAX_BYTES = Math.max(1024 * 1024, parseInt(process.env.CDP_IO_READ_MAX_BYTES || String(32 * 1024 * 1024), 10) || (32 * 1024 * 1024));
const _cdpHeavyBudget = { events: [], lastAt: 0, cooldownUntil: 0, consecutiveFailures: 0 };

function pruneCdpHeavyEvents(nowMs) {
  const now = Number(nowMs || Date.now()) || Date.now();
  while (_cdpHeavyBudget.events.length && (now - Number(_cdpHeavyBudget.events[0] || 0)) > CDP_HEAVY_WINDOW_MS) {
    _cdpHeavyBudget.events.shift();
  }
}

function canRunHeavyCdp(nowMs) {
  const now = Number(nowMs || Date.now()) || Date.now();
  if (!CDP_HEAVY_BUDGET_ENABLED) return { ok: true, reason: 'disabled', count: 0, waitMs: 0 };
  pruneCdpHeavyEvents(now);
  if (Number(_cdpHeavyBudget.cooldownUntil || 0) > now) {
    return { ok: false, reason: 'cooldown', count: _cdpHeavyBudget.events.length, waitMs: Number(_cdpHeavyBudget.cooldownUntil || 0) - now };
  }
  if (Number(_cdpHeavyBudget.lastAt || 0) > 0 && (now - Number(_cdpHeavyBudget.lastAt || 0)) < CDP_HEAVY_MIN_GAP_MS) {
    return { ok: false, reason: 'min_gap', count: _cdpHeavyBudget.events.length, waitMs: CDP_HEAVY_MIN_GAP_MS - (now - Number(_cdpHeavyBudget.lastAt || 0)) };
  }
  if (_cdpHeavyBudget.events.length >= CDP_HEAVY_MAX_PER_WINDOW) {
    const oldest = Number(_cdpHeavyBudget.events[0] || 0) || now;
    return { ok: false, reason: 'window_budget', count: _cdpHeavyBudget.events.length, waitMs: Math.max(0, CDP_HEAVY_WINDOW_MS - (now - oldest)) };
  }
  return { ok: true, reason: 'ok', count: _cdpHeavyBudget.events.length, waitMs: 0 };
}

function markHeavyCdpStart(nowMs) {
  const now = Number(nowMs || Date.now()) || Date.now();
  _cdpHeavyBudget.lastAt = now;
  _cdpHeavyBudget.events.push(now);
  pruneCdpHeavyEvents(now);
}

function markHeavyCdpSuccess() {
  _cdpHeavyBudget.consecutiveFailures = 0;
  _cdpHeavyBudget.cooldownUntil = 0;
}

function markHeavyCdpFailure(nowMs) {
  const now = Number(nowMs || Date.now()) || Date.now();
  _cdpHeavyBudget.consecutiveFailures = Math.min(8, Number(_cdpHeavyBudget.consecutiveFailures || 0) + 1);
  const backoffMs = Math.min(CDP_HEAVY_BACKOFF_MAX_MS, CDP_HEAVY_BACKOFF_BASE_MS * (2 ** Math.max(0, _cdpHeavyBudget.consecutiveFailures - 1)));
  _cdpHeavyBudget.cooldownUntil = now + backoffMs;
}

async function readIOStreamChunks(session, stream) {
  const chunks = [];
  let chunkCount = 0;
  let totalBytes = 0;
  while (true) {
    const chunk = await session.send('IO.read', { handle: stream, size: CDP_IO_READ_CHUNK_SIZE }).catch(()=>null);
    if (!chunk) break;
    chunkCount += 1;
    if (chunk.data) {
      totalBytes += Buffer.byteLength(String(chunk.data), 'utf8');
      chunks.push(chunk.data);
    }
    if (chunkCount >= CDP_IO_READ_MAX_CHUNKS || totalBytes >= CDP_IO_READ_MAX_BYTES) {
      _ramDiagCounters.heavyIoReadTruncated = Number(_ramDiagCounters.heavyIoReadTruncated || 0) + 1;
      break;
    }
    if (chunk.eof) break;
  }
  try { await session.send('IO.close', { handle: stream }).catch(()=>{}); } catch {}
  return chunks.join('');
}

async function collectChromePidsViaTracing(browser, { sampleMs = PIDS_TRACE_MS } = {}) {
  const heavyBudget = canRunHeavyCdp(Date.now());
  _ramDiagCounters.heavyBudgetCalls = Number(_ramDiagCounters.heavyBudgetCalls || 0) + 1;
  if (!heavyBudget.ok) {
    _ramDiagCounters.heavyBudgetSkips = Number(_ramDiagCounters.heavyBudgetSkips || 0) + 1;
    if (heavyBudget.reason === 'cooldown') _ramDiagCounters.heavyBudgetCooldownSkips = Number(_ramDiagCounters.heavyBudgetCooldownSkips || 0) + 1;
    if (heavyBudget.reason === 'min_gap') _ramDiagCounters.heavyBudgetGapSkips = Number(_ramDiagCounters.heavyBudgetGapSkips || 0) + 1;
    if (heavyBudget.reason === 'window_budget') _ramDiagCounters.heavyBudgetWindowSkips = Number(_ramDiagCounters.heavyBudgetWindowSkips || 0) + 1;
    return [];
  }
  markHeavyCdpStart(Date.now());
  _ramDiagCounters.heavyBudgetStarts = Number(_ramDiagCounters.heavyBudgetStarts || 0) + 1;
  try {
    if (!browser || !browser.isConnected || (browser.isConnected && browser.isConnected() === false)) return [];
    const target = browser.target();
    if (!target || !target.createCDPSession) return [];
    const session = await target.createCDPSession();
    const pids = new Set();
    const tracingComplete = new Promise((resolve) => {
      const onComplete = async (ev) => {
        try {
          const stream = ev && ev.stream;
          if (!stream) return resolve([]);
          const data = await readIOStreamChunks(session, stream);
          // data é um JSON com traceEvents
          try {
            const obj = JSON.parse(data);
            const arr = Array.isArray(obj && obj.traceEvents) ? obj.traceEvents : [];
            for (const e of arr) {
              if (e && typeof e.pid === 'number') pids.add(e.pid);
            }
          } catch {} 
        } finally {
          resolve(Array.from(pids));
        }
      };
      session.on('Tracing.tracingComplete', onComplete);
    });
    // Start Tracing com memory-infra (rápido e leve)
    await session.send('Tracing.start', {
      categories: 'disabled-by-default-memory-infra',
      transferMode: 'ReturnAsStream',
      options: 'record-as-much-as-possible'
    }).catch(()=>{});
    // Aguarda um pequeno sampling
    await new Promise(r => setTimeout(r, Math.max(120, sampleMs)));
    // Stop
    try { await session.send('Tracing.end').catch(()=>{}); } catch {}
    const timeoutMs = Math.max(1200, Number(PIDS_TRACE_HARD_TIMEOUT_MS || 3000));
    const timeoutSentinel = Symbol('trace_timeout');
    const res = await Promise.race([
      tracingComplete,
      new Promise((resolve) => setTimeout(() => resolve(timeoutSentinel), timeoutMs))
    ]);
    try { await session.detach && session.detach().catch(()=>{}); } catch {}
    if (res === timeoutSentinel) {
      _ramDiagCounters.heavyTraceTimeouts = Number(_ramDiagCounters.heavyTraceTimeouts || 0) + 1;
      markHeavyCdpFailure(Date.now());
      return [];
    }
    markHeavyCdpSuccess();
    return Array.isArray(res) ? res : [];
  } catch {
    _ramDiagCounters.heavyTraceErrors = Number(_ramDiagCounters.heavyTraceErrors || 0) + 1;
    markHeavyCdpFailure(Date.now());
    return [];
  }
}

async function getControllerPidsCached(nome, ctrl, { forceRefresh = false } = {}) {
  try {
    _ramDiagCounters.calls = Number(_ramDiagCounters.calls || 0) + 1;
    if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) return [];
    robeMeta[nome] = robeMeta[nome] || {};
    const cache = robeMeta[nome]._pidCache || { pids: [], ts: 0 };
    const expired = (Date.now() - cache.ts) > PIDS_CACHE_TTL_MS;
    const hasCache = Array.isArray(cache.pids) && cache.pids.length > 0;
    if (!forceRefresh && hasCache) {
      _ramDiagCounters.cacheHits = Number(_ramDiagCounters.cacheHits || 0) + 1;
      if (expired) _ramDiagCounters.staleHits = Number(_ramDiagCounters.staleHits || 0) + 1;
      return cache.pids.slice(0);
    }
    // Caminho crítico: fora do orçamento de refresh, nunca dispara tracing pesado.
    // Retorna rootPid como fallback leve até o próximo refresh forçado.
    if (!forceRefresh) {
      const root = robeMeta[nome].rootPid || null;
      if (root && Number.isFinite(root)) return [root];
      return [];
    }
    // Força refresh (tranquilo: curto e leve)
    const _refreshStart = Date.now();
    const pids = await collectChromePidsViaTracing(ctrl.browser).catch(()=>[]);
    const _refreshMs = Date.now() - _refreshStart;
    _ramDiagCounters.refreshes = Number(_ramDiagCounters.refreshes || 0) + 1;
    _ramDiagCounters.refreshMsTotal = Number(_ramDiagCounters.refreshMsTotal || 0) + _refreshMs;
    _ramDiagCounters.lastRefreshMs = _refreshMs;
    // Garante incluir o rootPid (fallback)
    const root = robeMeta[nome].rootPid || null;
    const set = new Set(Array.isArray(pids) ? pids : []);
    if (root && Number.isFinite(root)) set.add(root);
    const arr = Array.from(set);
    robeMeta[nome]._pidCache = { pids: arr, ts: Date.now() };
    return arr.slice(0);
  } catch {
    _ramDiagCounters.refreshErrors = Number(_ramDiagCounters.refreshErrors || 0) + 1;
    return [];
  }
}
// === FIM: PID discovery via CDP/Tracing (sem WMI) ===

// Pequeno lock para evitar overlap de ticks
let _ramTickBusy = false;
let _ramDiagLast = null;
const _ramDiagCounters = {
  calls: 0,
  cacheHits: 0,
  staleHits: 0,
  refreshes: 0,
  refreshErrors: 0,
  refreshMsTotal: 0,
  lastRefreshMs: 0,
  heavyBudgetCalls: 0,
  heavyBudgetStarts: 0,
  heavyBudgetSkips: 0,
  heavyBudgetGapSkips: 0,
  heavyBudgetWindowSkips: 0,
  heavyBudgetCooldownSkips: 0,
  heavyTraceTimeouts: 0,
  heavyTraceErrors: 0,
  heavyIoReadTruncated: 0
};

async function ramCpuMonitorTick() {
  const _tickStart = Date.now();
  let _refreshBudgetUsed = 0;
  let _forcedRefreshCount = 0;
  let _forcedRefreshErr = 0;
  let _forcedRefreshMsTotal = 0;
  if (_ramTickBusy) {
    // agenda próximo tick mesmo se estiver ocupada (anti overlap)
    const WIN_INTERVAL_MS = parseInt(process.env.WIN_RAM_TICK_MS || '15000', 10);
    const NIX_INTERVAL_MS = 8000 + Math.floor(Math.random() * 2000);
    const INTERVAL_MS = (process.platform === 'win32') ? WIN_INTERVAL_MS : NIX_INTERVAL_MS;
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
    return;
  }

  _ramTickBusy = true;
  const WIN_INTERVAL_MS = parseInt(process.env.WIN_RAM_TICK_MS || '15000', 10); // 15s padrão Windows
  const NIX_INTERVAL_MS = 9000 + Math.floor(Math.random() * 2000); // ~9–11s POSIX
  const INTERVAL_MS = (process.platform === 'win32') ? WIN_INTERVAL_MS : NIX_INTERVAL_MS;

  try {
    // Se não há nenhum browser ativo neste worker, não gasta CPU
    if (!controllers || controllers.size === 0) {
      _ramDiagLast = {
        ts: Date.now(),
        tickMs: Date.now() - _tickStart,
        idleNoControllers: true,
        controllers: 0,
        refreshBudget: 0,
        forcedRefreshCount: 0,
        forcedRefreshErr: 0,
        forcedRefreshMsTotal: 0,
        pidCacheTtlMs: PIDS_CACHE_TTL_MS,
        pidsRefreshPerTick: PIDS_REFRESH_PER_TICK,
        tickIntervalMs: INTERVAL_MS,
        counters: { ..._ramDiagCounters },
        heavyBudget: {
          enabled: CDP_HEAVY_BUDGET_ENABLED,
          windowMs: CDP_HEAVY_WINDOW_MS,
          maxPerWindow: CDP_HEAVY_MAX_PER_WINDOW,
          minGapMs: CDP_HEAVY_MIN_GAP_MS,
          cooldownUntil: Number(_cdpHeavyBudget.cooldownUntil || 0),
          eventsInWindow: Array.isArray(_cdpHeavyBudget.events) ? _cdpHeavyBudget.events.length : 0,
          consecutiveFailures: Number(_cdpHeavyBudget.consecutiveFailures || 0)
        }
      };
      for (const nome of Object.keys(robeMeta)) {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].ramMB = null;
        robeMeta[nome].cpuPercent = null;
      }
      await snapshotStatusAndWrite();
      return;
    }

    // Tira um snapshot do OS (uma chamada só por tick, leve)
    const pidMemMap = process.platform === 'win32'
      ? await getWinTasklistMap()
      : await getPosixPsMap();

    // Refrescamos no máximo N perfis por tick (demais usam cache)
    const entries = Array.from(controllers.entries());
    const refreshBudget = Math.min(PIDS_REFRESH_PER_TICK, entries.length);
    _refreshBudgetUsed = refreshBudget;
    for (let i = 0; i < refreshBudget; i++) {
      const [n, c] = entries[(i + (ramCpuMonitorTick._rr || 0)) % entries.length];
      const _rfStart = Date.now();
      try {
        await getControllerPidsCached(n, c, { forceRefresh: true });
        _forcedRefreshCount++;
      } catch {
        _forcedRefreshErr++;
      } finally {
        _forcedRefreshMsTotal += (Date.now() - _rfStart);
      }
    }
    ramCpuMonitorTick._rr = ((ramCpuMonitorTick._rr || 0) + refreshBudget) % Math.max(1, entries.length);

    // Atualiza todos os perfis controlados por este worker
    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || (ctrl.browser.isConnected && ctrl.browser.isConnected() === false)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
          continue;
        }

        // Captura rootPid se ainda não existir
        robeMeta[nome] = robeMeta[nome] || {};
        if (!robeMeta[nome].rootPid) {
          try {
            const proc = ctrl.browser.process && ctrl.browser.process();
            if (proc && proc.pid) {
              robeMeta[nome].rootPid = proc.pid;
            }
          } catch {}
        }

        // NOVO: soma de root + filhos (pelo CDP Tracing) + tasklist/ps
        // Aplica fator de correção para aproximar Private Working Set (evita duplicação de memória compartilhada)
        const RAM_CORRECTION_FACTOR = parseFloat(process.env.RAM_CORRECTION_FACTOR || '0.435'); // 0.435 = ~43.5% (ajuste fino)
        const pids = await getControllerPidsCached(nome, ctrl, { forceRefresh: false });
        let totalMB = 0;
        if (Array.isArray(pids) && pids.length) {
          for (const pid of pids) {
            const v = pidMemMap[pid];
            if (typeof v === 'number' && v >= 0) totalMB += v;
          }
          // Aplica fator de correção para aproximar Private Working Set (Windows: Working Set inclui memória compartilhada)
          if (process.platform === 'win32' && RAM_CORRECTION_FACTOR > 0 && RAM_CORRECTION_FACTOR <= 1) {
            totalMB = Math.round(totalMB * RAM_CORRECTION_FACTOR);
          }
        } else {
          // fallback duro (só rootPid) se cache vazio
          const root = robeMeta[nome].rootPid || null;
          if (root && Number.isFinite(root) && typeof pidMemMap[root] === 'number') {
            totalMB = pidMemMap[root];
            // Aplica fator de correção também no fallback
            if (process.platform === 'win32' && RAM_CORRECTION_FACTOR > 0 && RAM_CORRECTION_FACTOR <= 1) {
              totalMB = Math.round(totalMB * RAM_CORRECTION_FACTOR);
            }
          } else {
            totalMB = 0;
          }
        }
        robeMeta[nome].ramMB = totalMB || null;
        // CPU por perfil permanece null (sem WMI/PowerShell). O frontend já é null-aware
        robeMeta[nome].cpuPercent = null;

      } catch {
        try {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].ramMB = null;
          robeMeta[nome].cpuPercent = null;
        } catch {}
      }
    }

    _ramDiagLast = {
      ts: Date.now(),
      tickMs: Date.now() - _tickStart,
      idleNoControllers: false,
      controllers: (controllers && typeof controllers.size === 'number') ? controllers.size : 0,
      refreshBudget: _refreshBudgetUsed,
      forcedRefreshCount: _forcedRefreshCount,
      forcedRefreshErr: _forcedRefreshErr,
      forcedRefreshMsTotal: _forcedRefreshMsTotal,
      pidCacheTtlMs: PIDS_CACHE_TTL_MS,
      pidsRefreshPerTick: PIDS_REFRESH_PER_TICK,
      tickIntervalMs: INTERVAL_MS,
      counters: { ..._ramDiagCounters },
      heavyBudget: {
        enabled: CDP_HEAVY_BUDGET_ENABLED,
        windowMs: CDP_HEAVY_WINDOW_MS,
        maxPerWindow: CDP_HEAVY_MAX_PER_WINDOW,
        minGapMs: CDP_HEAVY_MIN_GAP_MS,
        cooldownUntil: Number(_cdpHeavyBudget.cooldownUntil || 0),
        eventsInWindow: Array.isArray(_cdpHeavyBudget.events) ? _cdpHeavyBudget.events.length : 0,
        consecutiveFailures: Number(_cdpHeavyBudget.consecutiveFailures || 0)
      }
    };
    if (_ramDiagLast && (_ramDiagLast.tickMs >= 12000 || Number(_ramDiagLast.counters && _ramDiagLast.counters.staleHits || 0) > 0)) {
      // #region agent log
      __agentLog(
        'H4',
        'worker.js:ramCpuMonitorTick',
        'ram_tick_diag',
        {
          tickMs: _ramDiagLast.tickMs,
          controllers: _ramDiagLast.controllers,
          refreshBudget: _ramDiagLast.refreshBudget,
          forcedRefreshCount: _ramDiagLast.forcedRefreshCount,
          forcedRefreshMsTotal: _ramDiagLast.forcedRefreshMsTotal,
          heavyBudgetSkips: Number(_ramDiagLast.counters && _ramDiagLast.counters.heavyBudgetSkips || 0),
          heavyTraceTimeouts: Number(_ramDiagLast.counters && _ramDiagLast.counters.heavyTraceTimeouts || 0),
          staleHits: Number(_ramDiagLast.counters && _ramDiagLast.counters.staleHits || 0),
          cacheHits: Number(_ramDiagLast.counters && _ramDiagLast.counters.cacheHits || 0),
          refreshes: Number(_ramDiagLast.counters && _ramDiagLast.counters.refreshes || 0),
          refreshErrors: Number(_ramDiagLast.counters && _ramDiagLast.counters.refreshErrors || 0),
          prunersSize: _pruners.size,
          activationLocksSize: activationLocks.size,
          profileOpLocksSize: _profileOpLocks.size
        },
        'ram.tick.diag',
        30000
      );
      // #endregion
    }
    await snapshotStatusAndWrite();
  } catch (e) {
    try { logger.warn('[RAM-TICK] erro', { error: (e && e.message) || e }); } catch {}
  } finally {
    _ramTickBusy = false;
    ramMonitorInterval = setTimeout(ramCpuMonitorTick, INTERVAL_MS);
  }
}

function normalizePath(x) { return String(x||'').replace(/\\/g,'/'); }

function extractUserDataDir(cmd) {
  if (!cmd) return null;
  const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(cmd);
  return m ? (m[1] || m[2] || m[3]) : null;
}

// Função para obter Private Working Set no Windows (evita duplicação de memória compartilhada)
// 110% sem WMI/PowerShell — não coleta nada (pidusage e ps-list usam WMI internamente)
async function getPidPrivateWSBytes(pids) {
  // 110% sem WMI/PowerShell — não coleta nada
  return {};
}

setTimeout(ramCpuMonitorTick, 5000);

// ====== Robe dinâmico (itens vs veiculos) ======
async function getRobeModuleFor(nome) {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    const mode = (man && man.robeMode) ? String(man.robeMode) : 'itens';
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_module_mode', nome: String(nome || ''), robeMode: String(mode || 'itens') }); } catch {}
    // #endregion
    if (mode === 'veiculos') {
      return require('./robeVeiculos.js');
    }
    return require('./robe.js');
  } catch {
    return require('./robe.js');
  }
}

// Wrapper: startRobeDynamic (substitui hook global robeHelper.startRobe)
async function startRobeDynamic(browser, nome, robePauseMs, workingNow, photoDeletePolicy = "after_all_working_posted") {
  // #region agent log
  try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_entry', nome: String(nome || ''), robePauseMs: Number(robePauseMs || 0), workingNowCount: Array.isArray(workingNow) ? workingNow.length : -1 }); } catch {}
  // #endregion
  let manifest = null;
  try { manifest = await manifestStore.read(nome); } catch{}
  if (!manifest) {
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_abort_manifest_unavailable', nome: String(nome || '') }); } catch {}
    // #endregion
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_unavailable (no freeze)');
    return { ok: false, error: 'manifest_unavailable' };
  }
  if (!manifest.cookies || !manifest.fp) {
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_abort_manifest_incomplete', nome: String(nome || ''), hasCookies: !!manifest.cookies, hasFp: !!manifest.fp }); } catch {}
    // #endregion
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].activationHeldUntil = Date.now() + 15000;
    await reportAction(nome, 'mil_action', 'robe_abort_manifest_incomplete (no freeze)');
    return { ok: false, error: 'manifest_incomplete' };
  }
  const now = Date.now();
  if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > now) {
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_abort_ram_backoff', nome: String(nome || ''), ramKillBackoff: Number(robeMeta[nome].ramKillBackoff || 0), now: Number(now || 0) }); } catch {}
    // #endregion
    return { ok: false, error: 'ram_backoff' };
  }
  try {
    const mod = await getRobeModuleFor(nome);
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_before_module_start', nome: String(nome || ''), hasStartRobe: !!(mod && typeof mod.startRobe === 'function') }); } catch {}
    // #endregion
    const res = await mod.startRobe(browser, nome, robePauseMs, workingNow, photoDeletePolicy);
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_module_return', nome: String(nome || ''), ok: !!(res && res.ok), error: (res && res.error) ? String(res.error) : null }); } catch {}
    // #endregion
    return res;
  } catch (e) {
    // #region agent log
    try { provisionAudit.append({ ts: Date.now(), event: 'dbg_startRobeDynamic_catch', nome: String(nome || ''), error: String((e && e.message) || e || '') }); } catch {}
    // #endregion
    await reportAction(nome, 'robe_error', `Erro técnico no Robe: ${(e&&e.message)||e}. Cooldown padrão configurado no servidor será aplicado pelo módulo.`);
    return { ok: false, error: String(e&&e.message||e) };
  }
}

async function robeTickGlobal() {
  // Hardening: durante provisionamento, pausar Robe/automação para evitar concorrência.
  try {
    if (provisionLock.isActive()) {
      try {
        robeTickGlobal._lastProvisionLockLogAt = robeTickGlobal._lastProvisionLockLogAt || 0;
        const now = Date.now();
        const last = Number(robeTickGlobal._lastProvisionLockLogAt || 0) || 0;
        if (!last || (now - last) > 60000) {
          robeTickGlobal._lastProvisionLockLogAt = now;
          await milLog('mil_action', 'robeTickGlobal_skip_due_provision_lock');
        }
      } catch {}
      return;
    }
  } catch {}
  // Em light: NÃO pode pausar Robe por completo. Apenas reduzir pressão (throttle).
  const isLight = !!(autoMode && autoMode.mode && autoMode.mode !== 'full');
  let lightMaxEnqueue = null;
  if (isLight) {
    try {
      autoMode.light = autoMode.light || {};
      const now = Date.now();
      const nextAt = Number(autoMode.light.nextRobeEnqueueAt || 0) || 0;
      lightMaxEnqueue = Number(AUTO_CFG.ROBE_LIGHT_MAX_ENQUEUE_PER_TICK || 0) || 0;
      if (lightMaxEnqueue <= 0) {
        autoMode.light.robeSkipped = Number(autoMode.light.robeSkipped || 0) + 1;
        const lastLog = Number(autoMode.light._lastRobeSkipLogAt || 0) || 0;
        if (!lastLog || (now - lastLog) > 60000) {
          autoMode.light._lastRobeSkipLogAt = now;
          await milLog('mil_action', `robeTickGlobal_skip_due_slowmode mode=${autoMode.mode} reason=${autoMode.reason || ''} policy=max0`);
        }
        return;
      }
      if (nextAt && now < nextAt) {
        autoMode.light.robeSkipped = Number(autoMode.light.robeSkipped || 0) + 1;
        const lastLog = Number(autoMode.light._lastRobeSkipLogAt || 0) || 0;
        if (!lastLog || (now - lastLog) > 60000) {
          autoMode.light._lastRobeSkipLogAt = now;
          await milLog('mil_action', `robeTickGlobal_throttle_due_slowmode mode=${autoMode.mode} reason=${autoMode.reason || ''} nextAt=${nextAt}`);
        }
        return;
      }
      autoMode.light.nextRobeEnqueueAt = now + AUTO_CFG.ROBE_LIGHT_MIN_SPACING_MS;
    } catch {}
  }

  const perfisArr = loadPerfisJson();
  const nomesAll = perfisArr.map(p => p.nome);
  const prontosArr = await Promise.all(nomesAll.map(async (nome) => {
    if (isFrozenNow(nome)) return null;
    if (robeMeta[nome]?.ramKilledAt && robeMeta[nome].ramKillBackoff && robeMeta[nome].ramKillBackoff > Date.now()) {
      return null;
    }
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.trabalhando || ctrl.configurando || ctrl.humanControl) return null;
    const manGate = await manifestStore.read(nome).catch(()=>null);
    // Self-heal: se cooldown foi "congelado" (robeCooldownRemainingMs) enquanto o perfil voltou a trabalhar,
    // garanta a retomada do countdown. Isso elimina o bug de cooldown travado pós-remediação/pausas.
    try { await unfreezeCooldownIfWorking(nome); } catch {}
    let cooldown = await normalizeCooldown(nome);
    const inFila = robeQueue.inQueue(nome);
    const exec = robeQueue.isActive(nome);
    const nowForGate = Date.now();
    const pauseReason = String((manGate && manGate.robePauseReason) || '').trim().toLowerCase();
    const hasActiveCooldown = (
      (Number(manGate && manGate.robeCooldownUntil || 0) > nowForGate) ||
      (Number(manGate && manGate.robeCooldownRemainingMs || 0) > 0)
    );
    if (manGate && manGate.robePauseReason === 'limit_posting' && (manGate.robeCooldownUntil || 0) > nowForGate) {
      try { await issues.append(nome, 'mil_action', 'skip_robe_enqueue_due_limit_posting_active'); } catch {}
      return null;
    }
    // Modo V1 clássico: respeita apenas bloqueio hard de limit_posting ativo.
    // Outros pauseReason não devem travar o ciclo 24/7.
    if (cooldown > 0 && pauseReason === 'limit_posting' && hasActiveCooldown) {
      return null;
    }
    return (cooldown === 0 && (!inFila) && (!exec)) ? nome : null;
  }));
  const prontos = prontosArr.filter(Boolean);

  let enqCount = 0;
  for (const nome of prontos) {
    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser) continue;

    logger.info('[WORKER][robeTickGlobal] Enfileirando', { nome, cooldown: await normalizeCooldown(nome), inQueue: robeQueue.inQueue(nome), isActive: robeQueue.isActive(nome) });

    robeQueue.enqueue(nome, async () => {

      robeUpdateMeta(nome, { emExecucao: true, emFila: false });

      let virtusWasRunning = false;
      const ctrl = controllers.get(nome);
      const workingNow = getWorkingProfileNames();
      if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        robeUpdateMeta(nome, { estado: 'erro' });
        try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (guard)'); } catch {}
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        return;
      }

      try { logger.info('[WORKER][robeTickGlobal] Robe start', { nome }); } catch {}
      try { await reportAction(nome, 'robe_start', 'Iniciando Robe via fila global'); } catch {}

      let mainPage = null;
      try {
        if (ctrl && ctrl.browser && !ctrl.mainPage) {
          try {
            const pages = await ctrl.browser.pages();
            if (pages[0]) {
              ctrl.mainPage = pages[0];
              try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
            }
          } catch {}
        }
        mainPage = ctrl.mainPage;

        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          virtusWasRunning = true;
          try { await ctrl.virtus.stop(); } catch {}
          ctrl.virtus = null;
        }

        try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

        const robePauseMs = drawRobeCooldownMs();
        const photoDeletePolicy = getRobePhotoDeletePolicy();

        let res;
        try {
          res = await startRobeDynamic(ctrl.browser, nome, robePauseMs, workingNow, photoDeletePolicy);
        } catch (e) {
          if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
            robeMeta[nome] = robeMeta[nome] || {};
            robeMeta[nome].limitPostingThisRun = Date.now();
            robeMeta[nome].pauseReason = 'limit_posting';
            robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
            try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robeTickGlobal)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }
          await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão configurado no servidor será aplicado por robe.js`);
          robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          try { logger.warn('[WORKER][robeTickGlobal] Robe error', { nome, error: e && e.message || e }); } catch {}
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (isLimitPostingRes(res)) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].limitPostingThisRun = Date.now();
          robeMeta[nome].pauseReason = 'limit_posting';
          robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
          await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h');
          try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
          return;
        }

        if (res && res.ok) {
          await markRobeSessionPostConsumed(nome, Date.now());
          try {
            await manifestStore.update(nome, (m) => {
              m = m || {};
              m.ultimaPostagemRobe = Date.now();
              return m;
            });
          } catch {}
          const last = await robeLastPosted(nome);
          robeUpdateMeta(nome, {
            estado: 'ok',
            cooldownSec: await normalizeCooldown(nome),
            proximaPostagem: last + robePauseMs,
            ultimaPostagem: Date.now()
          });
          try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso'); } catch {}
          try { logger.info('[WORKER][robeTickGlobal] Robe success', { nome }); } catch {}
        } else {
          robeUpdateMeta(nome, {
            estado: 'idle',
            cooldownSec: await normalizeCooldown(nome)
          });
        }
      } catch (e) {
        robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
      } finally {
        try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
        if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
          await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
          delete robeMeta[nome].limitPostingThisRun;
          try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
          robeUpdateMeta(nome, { emExecucao: false });
          if (virtusWasRunning && automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              ctrl.trabalhando = true;
              await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
            } catch {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          }
          await snapshotStatusAndWrite();
          return;
        }
        try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

        robeUpdateMeta(nome, { emExecucao: false });

        if (virtusWasRunning) {
          if (automationAllowed(ctrl)) {
            try {
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              ctrl.trabalhando = true;
            } catch (e) {
              ctrl.virtus = null;
              ctrl.trabalhando = false;
            }
          } else {
            ctrl.virtus = null;
            ctrl.trabalhando = false;
          }
          await snapshotStatusAndWrite();
        }

        try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado'); } catch {}
        try { logger.info('[WORKER][robeTickGlobal] Robe end', { nome }); } catch {}
      }
    });

    robeUpdateMeta(nome, { emFila: true });
    enqCount++;
    if (isLight && lightMaxEnqueue != null && enqCount >= lightMaxEnqueue) break;
  }

  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!robeQueue.inQueue(n)) delete m.emFila;
    if (!robeQueue.isActive(n)) delete m.emExecucao;
  }
}

setInterval(robeTickGlobal, 7000);
setTimeout(robeTickGlobal, 3500);

async function fotosGcTick() {
  try {
    const res = await fotos.gcSweep();
    if (res && (res.deletedFiles || res.removedIndex || res.resetGens)) {
      logger.info('[FOTOS][GC] resultado', { deletedFiles: res.deletedFiles, removedIndex: res.removedIndex, resetGens: res.resetGens });
    }
  } catch (e) {
    // index_lock_timeout é esperado quando há contenção (muitas operações simultâneas)
    // Não é crítico, apenas indica que o GC será tentado novamente no próximo ciclo
    const msg = (e && e.message) || String(e);
    if (msg.includes('index_lock_timeout')) {
      // Silencioso: timeout de lock é normal em alta contenção
    } else {
      logger.warn('[FOTOS][GC] erro', { error: msg });
    }
  }
}
setInterval(fotosGcTick, 90_000);
setTimeout(fotosGcTick, 8000);

async function stopVirtus(nome) {
const ctrl = controllers.get(nome);
if (!ctrl) return;
try {
if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
await ctrl.virtus.stop().catch(()=>{});
}
} catch {}
ctrl.virtus = null;
ctrl.trabalhando = false;
ctrl.virtusEpoch = (ctrl.virtusEpoch || 0) + 1;
if (ctrl.browser) {
  ctrl.browser._fenceEpochMap = ctrl.browser._fenceEpochMap || {};
  ctrl.browser._fenceEpochMap[nome] = ctrl.virtusEpoch;
}
try { freezeCooldownIfNotWorking(nome); } catch {}
await snapshotStatusAndWrite();
}

// ===== Ultra enterprise: quiescência determinística para operações críticas (inject cookies / provision) =====
function _quiesceSnapshot({ excludeNome } = {}) {
  const snap = {
    controllers: controllers.size,
    busyNames: [],
    busyDetails: [],
    virtusOnlineNames: [],
    pauseableVirtusNames: [],
    pauseableVirtusDetails: []
  };
  for (const [n, c] of controllers.entries()) {
    if (!c) continue;
    const nome = String(n);
    if (excludeNome && nome === String(excludeNome)) continue;
    const sendLockActive = !!(c.browser && c.browser._sendLock && c.browser._sendLock.active);
    const robeEmExecucao = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
    const inConfig = (c.configurando === true);
    const inHuman = (c.humanControl === true);
    const virtusOnline = !!c.virtus;
    if (virtusOnline) snap.virtusOnlineNames.push(nome);
    if (sendLockActive || robeEmExecucao) {
      snap.busyNames.push(nome);
      snap.busyDetails.push({ nome, sendLockActive, robeEmExecucao, inConfig, inHuman, virtusOnline, trabalhando: !!c.trabalhando });
    }
    // "pausável": virtus online e não está ocupado/humano/config
    if (virtusOnline && !sendLockActive && !robeEmExecucao && !inConfig && !inHuman) {
      snap.pauseableVirtusNames.push(nome);
      snap.pauseableVirtusDetails.push({ nome, virtusOnline, trabalhando: !!c.trabalhando });
    }
  }
  return snap;
}

async function waitGlobalQuiesce({ opKind, operator, targetNome, waitBusyMs, waitPauseMs, require = true } = {}) {
  const op = String(operator || '').trim() || null;
  const kind = String(opKind || 'unknown');
  const target = targetNome ? String(targetNome) : null;
  const busyMax = Math.max(0, Number(waitBusyMs || 0) || 0);
  const pauseMax = Math.max(0, Number(waitPauseMs || 0) || 0);
  const startedAt = Date.now();

  const audit = (obj) => {
    try {
      provisionAudit.append({ ts: Date.now(), event: 'quiesce', kind, operator: op, target, ...obj });
    } catch {}
  };

  audit({ phase: 'begin', busyMax, pauseMax, snap: _quiesceSnapshot({ excludeNome: target }) });

  // (1) Espera busy (send/post) finalizar
  if (busyMax > 0) {
    const t0 = Date.now();
    while ((Date.now() - t0) < busyMax) {
      const s = _quiesceSnapshot({ excludeNome: target });
      if (s.busyNames.length === 0) break;
      await sleep(900);
    }
    const s2 = _quiesceSnapshot({ excludeNome: target });
    const okBusy = (s2.busyNames.length === 0);
    audit({ phase: 'busy_done', ok: okBusy, busyNames: s2.busyNames.slice(0, 50), busyDetails: s2.busyDetails.slice(0, 50) });
    if (require && !okBusy) {
      const err = `busy_timeout count=${s2.busyNames.length}`;
      audit({ phase: 'fail', error: err });
      throw new Error(err);
    }
  }

  // (2) Pausa Virtus para todos que são pausáveis
  const paused = [];
  const s3 = _quiesceSnapshot({ excludeNome: target });
  for (const nome of s3.pauseableVirtusNames) {
    try {
      const wasWorking = !!(controllers.get(nome)?.trabalhando);
      await stopVirtus(nome);
      paused.push({ nome, wasWorking });
    } catch {}
  }
  audit({ phase: 'pause_sent', pausedCount: paused.length, pausedNames: paused.map(x => x.nome).slice(0, 50) });

  // (3) Espera nenhum Virtus "pausável" permanecer online
  if (pauseMax > 0) {
    const t1 = Date.now();
    while ((Date.now() - t1) < pauseMax) {
      const s = _quiesceSnapshot({ excludeNome: target });
      if (s.pauseableVirtusNames.length === 0) break;
      await sleep(600);
    }
    const s4 = _quiesceSnapshot({ excludeNome: target });
    const okPause = (s4.pauseableVirtusNames.length === 0);
    audit({ phase: 'pause_done', ok: okPause, pauseableVirtusNames: s4.pauseableVirtusNames.slice(0, 50), virtusOnlineNames: s4.virtusOnlineNames.slice(0, 50) });
    if (require && !okPause) {
      const err = `pause_timeout count=${s4.pauseableVirtusNames.length}`;
      audit({ phase: 'fail', error: err });
      throw new Error(err);
    }
  }

  audit({ phase: 'done', elapsedMs: Date.now() - startedAt, pausedCount: paused.length });
  return { ok: true, elapsedMs: Date.now() - startedAt, paused };
}

function attachBrowserLifecycle(nome, browser) {
browser.once('disconnected', async () => {
try {
logger.info('[WORKER][BROWSER] disconnected', { nome });
try { robeQueue.skip && robeQueue.skip(nome); } catch {}

const ctrl = controllers.get(nome);
if (ctrl && ctrl.browser === browser) {
  try {
    const rc = await tryReconnectAfterDisconnected(nome, ctrl);
    if (rc && rc.ok) {
      try { issues.append(nome, 'mil_action', `reconnect_success attempt=${Number(rc.attempt || 0)}`).catch(()=>{}); } catch {}
      return;
    }
    try { issues.append(nome, 'mil_action', `restart_fallback reason=${String((rc && rc.reason) || 'unknown')}`).catch(()=>{}); } catch {}
  } catch {}
}
if (ctrl) { ctrl.humanControl = false; ctrl.configurando = false; }
try {
  provisionAudit.append({
    ts: Date.now(),
    event: 'browser_disconnected',
    nome: String(nome || ''),
    working: !!(ctrl && ctrl.trabalhando),
    humanControl: !!(ctrl && ctrl.humanControl),
    configurando: !!(ctrl && ctrl.configurando),
    emExecucao: !!(robeMeta[nome] && robeMeta[nome].emExecucao),
    freeMB: getAvailableMB()
  });
} catch {}
try {
  if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
    await ctrl.virtus.stop().catch(()=>{});
  }
} catch {}

try { freezeCooldownIfNotWorking(nome); } catch {}

controllers.delete(nome);

// LIMPA rootPid para evitar consultas em PIDs órfãos (WMI-free+ps-tree)
try {
  if (robeMeta[nome]) {
    robeMeta[nome].rootPid = null;
  }
} catch {}

try { healthState.delete(nome); } catch {}
try { profileFailures.delete(nome); } catch {}
try {
  if (robeMeta[nome]) {
    delete robeMeta[nome].emExecucao;
    delete robeMeta[nome].emFila;
    delete robeMeta[nome].cpuHistory;
    delete robeMeta[nome].ramHist;
    delete robeMeta[nome].reloadAttemptsWindow;
    delete robeMeta[nome].blockDetectWindow;
  }
} catch {}

try { await reportAction(nome, 'browser_disconnected', 'Janela/navegador fechado (evento disconnected)'); } catch {}

stopPruneLoop(nome);
cleanupProfileTransientLocks(nome, 'disconnected');
// #region agent log
__agentLog(
  'H3',
  'worker.js:attachBrowserLifecycle.disconnected',
  'cleanup_after_disconnected',
  {
    nome: String(nome || ''),
    hasController: controllers.has(nome),
    hasRobeMeta: !!robeMeta[nome],
    hasActivationLock: activationLocks.has(nome),
    hasPruner: _pruners.has(nome),
    hasProfileOpLock: _profileOpLocks.has(nome),
    hasOpening: !!(opening && opening[nome]),
    rootPid: robeMeta[nome] ? (robeMeta[nome].rootPid || null) : null
  },
  `cleanup.disconnected.${String(nome || '')}`,
  15000
);
// #endregion

try { registerFailure(nome, 'disconnected', 'external'); } catch {}
try {
  const d = readJsonFile(desiredPath, { perfis: {} });
  const isDesiredActive = d.perfis?.[nome]?.active === true;
  const isHold = d.perfis?.[nome]?.humanHold === true;
  robeMeta[nome] = robeMeta[nome] || {};
  const now = Date.now();

  if (!isFrozenNow(nome) && isDesiredActive && !isHold) {
    if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
      const reopenDelayMs = getControlledReopenDelayMs('disconnected');
      robeMeta[nome].reopenAt = now + reopenDelayMs;
      robeMeta[nome].closingReason = 'disconnected';
      issues.append(nome, 'mil_action', `nurse_reopen_scheduled(disconnected) in ${Math.round(reopenDelayMs / 1000)}s`).catch(()=>{});
      setKillGuard(nome, 5000);
    } else {
      issues.append(nome, 'mil_action', 'reopen_preserved_existing(disconnected)').catch(()=>{});
    }
  } else {
    robeMeta[nome].reopenAt = null;
    issues.append(nome, 'mil_action', isFrozenNow(nome) ? 
      'reopen_suppressed_frozen' : (isHold ? 'reopen_suppressed_human_hold' : 'reopen_suppressed_desired_off')).catch(()=>{});
  }
} catch {}

try { await snapshotStatusAndWrite(); } catch {}
} catch (e) {
  try { logger.warn('[WORKER][BROWSER] disconnect handler err', { error: e && e.message || e }); } catch {}
}
try {
  browser.removeAllListeners && browser.removeAllListeners('targetcreated');
  browser.removeAllListeners && browser.removeAllListeners('targetchanged');
  browser.removeAllListeners && browser.removeAllListeners('targetdestroyed');
} catch {}
});
}

function resolveChromeUserDataRoot() {
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA;
    if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
    const os = require('os');
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  const os = require('os');
  return path.join(os.homedir(), '.config', 'google-chrome');
}

function automationAllowed(ctrl, { operator } = {}) {
  // Política enterprise:
  // - Locks globais (configure/login_remediate/open_all_map/close_all) podem bloquear automação.
  // - Stock provision NÃO deve bloquear Robe/Virtus do servidor (requisito do lead);
  //   o provisionamento usa headroom/RAM + supervisor slots sem pausar o resto.
  try {
    const op = String(operator || '').trim();
    const cur = provisionLock.get && provisionLock.get();
    if (cur && cur.active && cur.lock) {
      const owner = String(cur.lock.owner || '').trim();
      const kind = String((cur.lock.meta && cur.lock.meta.kind) || '').trim();
      const isStock = (kind === 'stock_provision') || /^stock_provision:/i.test(owner);
      if (!isStock) {
        const lk = provisionLock.shouldBlock(op);
        if (lk && lk.block) return false;
      }
    } else {
      const lk = provisionLock.shouldBlock(op);
      if (lk && lk.block) return false;
    }
  } catch {
    try { if (provisionLock.isActive()) return false; } catch {}
  }
  return !!(ctrl && !ctrl.humanControl && !ctrl.configurando && !ctrl.trabalhando);
}

async function start_work({ nome, operator }) {
  return lockProfileAction(nome, async () => {
    logger.info('[HANDLER] start_work chamada', { nome });

    const ctrl = controllers.get(nome);
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.())
      return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

    if (ctrl.humanControl || ctrl.configurando) {
      await issues.append(nome, 'mil_action', 'start_work_denied (human/config mode)');
      logger.warn('[HANDLER] start_work denied (human/config mode)', { nome });
      return { ok: false, error: 'profile_in_human_or_config' };
    }

    // Guardrail enterprise: se flags persistentes indicam PIL, bloquear automação SEMPRE.
    // Isso garante que "Recurso em análise" (appealSubmitted) e "Conta suspensa" não voltem a ficar Virtus Online após restart/open-all.
    try {
      const flags = await readAccountFlags(nome).catch(()=>({}));
      if (flags && flags.banned === true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'banned', reason: String(flags.bannedReason||flags.reason||'').slice(0,120) }); } catch {}
        try { await setBannedFlag(nome, { reason: String(flags.bannedReason || 'banned'), snippet: String(flags.bannedText || '') }); } catch {}
        return { ok: false, error: 'banned' };
      }
      if (flags && flags.twoFactor === true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'two_factor', reason: String(flags.twoFactorReason||flags.reason||'two_factor').slice(0,120) }); } catch {}
        try { await setTwoFactorFlag(nome, { reason: String(flags.twoFactorReason || 'two_factor'), snippet: String(flags.twoFactorText || '') }); } catch {}
        return { ok: false, error: 'two_factor' };
      }
      if (flags && flags.loginRequired === true) {
        const rr = String(flags.loginReason || 'login_required').slice(0, 120);
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'login_required', reason: rr }); } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
            return d;
          });
        } catch {}
        try { ctrl.trabalhando = false; await stopVirtus(nome).catch(()=>{}); } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        return { ok: false, error: 'login_required' };
      }
      if (flags && (flags.identitySubmitted === true || flags.identityRequired === true)) {
        const kind = flags.identitySubmitted === true ? 'identity_submitted' : 'identity_required';
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind, nextAt: Number(flags.identityNextCheckAt||0)||0 }); } catch {}
        // Ultra enterprise: se start_work foi acionado manualmente e a conta está em identidade,
        // não “falhar seco”: agenda o fluxo de identidade imediatamente (1 por vez + cooldown).
        try {
          const pages = ctrl && ctrl.browser ? await ctrl.browser.pages().catch(()=>[]) : [];
          const p0 = pages && pages[0];
          if (p0) {
            const flowId = newFlowId('identity_start_work_flags');
            try { provisionAudit.append({ ts: Date.now(), event: 'start_work_identity_flow_scheduled', nome: String(nome||''), kind, flowId, source: 'start_work_flags' }); } catch {}
            setTimeout(() => {
              try { runIdentityFlow(nome, ctrl, p0, { source: 'start_work_flags', flowId }).catch(()=>{}); } catch {}
            }, 0);
          }
        } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
            return d;
          });
        } catch {}
        try { ctrl.trabalhando = false; await stopVirtus(nome).catch(()=>{}); } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        return { ok: false, error: kind };
      }
      if (flags && flags.appealSubmitted === true) {
        try { provisionAudit.append({ ts: Date.now(), event: 'start_work_blocked_by_flags', nome: String(nome||''), kind: 'appeal_submitted', nextAt: Number(flags.appealNextCheckAt||0)||0 }); } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
            return d;
          });
        } catch {}
        try { ctrl.trabalhando = false; await stopVirtus(nome).catch(()=>{}); } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        return { ok: false, error: 'appeal_submitted' };
      }
    } catch {}
    if (ctrl.trabalhando && ctrl.virtus) {
      logger.info('[HANDLER] start_work ok (já trabalhando)', { nome });
      return { ok: true };
    }
    // Idempotência enterprise: em corridas pós-reopen pode surgir trabalhando=true
    // com virtus ainda não anexado no ctrl. Nesse caso, tenta anexar e não falha o fluxo.
    if (ctrl.trabalhando && !ctrl.virtus && !ctrl._virtusStarting) {
      try {
        ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);
        ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, {
          restrictTab: 0,
          epoch: ctrl.virtusEpoch,
          slowMode: (autoMode && autoMode.mode !== 'full'),
          governorMode: (autoMode && autoMode.mode) || 'full'
        });
        try { await snapshotStatusAndWrite(); } catch {}
        logger.info('[HANDLER] start_work ok (reconciled trabalhando without virtus)', { nome });
        return { ok: true, reconciled: 'trabalhando_without_virtus' };
      } catch {
        // Se não conseguiu anexar, volta para o fluxo normal abaixo.
        try { ctrl.trabalhando = false; } catch {}
      }
    }
    if (ctrl._virtusStarting) {
      logger.info('[HANDLER] start_work ok (_virtusStarting)', { nome });
      return { ok: true };
    }

    try {
      ctrl._virtusStarting = true;
      // Hardening: respeitar lock de provisionamento (maintenance_provision),
      // mas permitir o fluxo do dono do lock via operator (stock_provision:<batchId>).
      if (!automationAllowed(ctrl, { operator })) {
        await issues.append(nome, 'mil_action', 'automation_not_allowed');
        logger.warn('[HANDLER] automation_not_allowed em start_work', { nome });
        return { ok: false, error: 'automation_not_allowed' };
      }
      ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);

      // Enterprise: preflight rápido ANTES de iniciar Virtus:
      // - se detectou banned/suspended/disabled -> auto arquivar+deletar (libera slot)
      // - se detectou appeal_submitted -> manter humano + armar monitor (1h)
      try {
        const pages = await ctrl.browser.pages().catch(()=>[]);
        const p0 = pages && pages[0];
        if (p0) {
          const bd = await browserHelper.detectBannedUi(p0).catch(()=>null);
          if (bd && bd.banned) {
            try { await setBannedFlag(nome, { reason: bd.reason || 'suspended_ui', snippet: bd.snippet || '' }); } catch {}
            try { await issues.append(nome, 'mil_action', `start_work_preflight_banned reason=${String(bd.reason||'').slice(0,80)}`); } catch {}
            return { ok: false, error: 'banned' };
          }
          const lr = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
          // 2FA => exclusão automática (não é humano, não é automação)
          if (lr && lr.loginRequired) {
            const rr = String(lr.reason || '').toLowerCase();
            if (rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor')) {
              try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String((lr && lr.title) ? lr.title : '') }); } catch {}
              try { await issues.append(nome, 'mil_action', `start_work_preflight_two_factor reason=${rr}`); } catch {}
              return { ok: false, error: 'two_factor' };
            }
            if (rr.includes('identity_submitted')) {
              try { await setIdentitySubmittedFlag(nome, { source: lr.domain || 'facebook', url: lr.url || '', title: lr.title || '' }); } catch {}
              try { await issues.append(nome, 'mil_action', `start_work_preflight_identity_submitted reason=${rr}`); } catch {}
              return { ok: false, error: 'identity_submitted' };
            }
            if (rr.includes('identity_confirm') || rr === 'identity' || rr.startsWith('identity_')) {
              try { await setIdentityRequiredFlag(nome, { source: lr.domain || 'facebook', url: lr.url || '', title: lr.title || '' }); } catch {}
              try { await issues.append(nome, 'mil_action', `start_work_preflight_identity_required reason=${rr}`); } catch {}
              // Ultra enterprise: agenda identity flow imediatamente ao detectar preflight identity.
              try {
                const flowId = newFlowId('identity_start_work_preflight');
                try { provisionAudit.append({ ts: Date.now(), event: 'start_work_identity_flow_scheduled', nome: String(nome||''), kind: 'identity_required', flowId, source: 'start_work_preflight', reason: rr.slice(0,120) }); } catch {}
                setTimeout(() => {
                  try {
                    const pages = ctrl && ctrl.browser ? (ctrl.browser.pages?.().catch(()=>[])) : Promise.resolve([]);
                    Promise.resolve(pages).then(ps => {
                      const p0 = ps && ps[0];
                      if (p0) runIdentityFlow(nome, ctrl, p0, { source: 'start_work_preflight', flowId }).catch(()=>{});
                    }).catch(()=>{});
                  } catch {}
                }, 0);
              } catch {}
              return { ok: false, error: 'identity_required' };
            }
          }
          if (lr && lr.loginRequired && String(lr.reason || '').toLowerCase().includes('appeal')) {
            try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
            ctrl.trabalhando = false;
            try { await stopVirtus(nome); } catch {}
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
                return d;
              });
            } catch {}
            try { await snapshotStatusAndWrite(); } catch {}
            try { await issues.append(nome, 'mil_action', `start_work_preflight_appeal_submitted reason=${String(lr.reason||'').slice(0,80)}`); } catch {}
            return { ok: false, error: 'appeal_submitted' };
          }
        }
      } catch {}

      // Regra operacional atual:
      // não abrir aba extra de Marketplace no pós-cadastro.
      // Isso evita abrir/fechar aba 1 sem necessidade e reduz cutucada.

      ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });

    ctrl.trabalhando = true;
      try {
        await browserHelper.forceCloseExtras(ctrl.browser);
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      if (ctrl.browser && typeof browserHelper.forceCloseExtras === 'function') {
        await browserHelper.forceCloseExtras(ctrl.browser);
      }

      try {
        await unfreezeCooldownIfWorking(nome);
        await normalizeCooldown(nome);
      } catch {}

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] start_work ok', { nome });
      return { ok: true };
    } catch (e) {
      logger.error('[HANDLER] start_work erro', { nome, error: e && e.message }, e);
      return { ok: false, error: e && e.message || String(e) };
    } finally {
      ctrl._virtusStarting = false;
    }
  });
}

const handlers = {
  async ['criar-perfil']({ cidade, cookies }) {
    logger.info('[HANDLER] criar-perfil chamada', { cidadeProvided: !!cidade, cookiesProvided: !!cookies });
    if (!cidade || !cookies) return { ok: false, error: 'Cidade e cookies obrigatórios.' };
    if (!fs.existsSync(perfisDir)) fs.mkdirSync(perfisDir, { recursive: true });

    let nome = utils.slugify(cidade) + '-' + Date.now();
    while (fs.existsSync(path.join(perfisDir, nome))) nome += Math.floor(Math.random() * 100);

    const preset = pickUaPreset();
    if (!preset) return { ok: false, error: 'UA preset esgotado.' };

    const cookiesArr = utils.normalizeCookies(cookies);
    if (!cookiesArr.length || !cookiesArr.find(c => c.name === 'c_user') || !cookiesArr.find(c => c.name === 'xs')) {
      return { ok: false, error: 'Cookies inválidos ou ausentes: precisa de c_user e xs!' };
    }

    const perfilObj = {
      nome,
      cidade,
      uaPresetId: preset.id,
      uaString: preset.uaString,
      uaCh: preset.uaCh,
      fp: {
        viewport: preset.viewport || (preset.fp && preset.fp.viewport) || { width: 1366, height: 768 },
        dpr: preset.dpr || (preset.fp && preset.fp.dpr) || 1,
        hardwareConcurrency: preset.hardwareConcurrency || (preset.fp && preset.fp.hardwareConcurrency) || 4
      },
      cookies: cookiesArr,
      robeCooldownUntil: 0,
      configuredAt: null,
      userDataDir: path.join(resolveChromeUserDataRoot(), 'Conveniente', nome)
    };
    try { fs.mkdirSync(perfilObj.userDataDir, { recursive: true }); } catch {}

    // CRÍTICO (cluster): criar perfil deve atualizar o perfis.json GLOBAL com lock (não shard snapshot).
    try {
      fileStore.withPerfisFileLockUpdate((arr) => {
        arr = Array.isArray(arr) ? arr : [];
        arr.push(perfilObj);
        return arr;
      }, { caller: 'criar-perfil', nome });
    } catch {}

    try {
      await manifestStore.update(nome, (m) => {
        m = m || {};
        return Object.assign({}, m, perfilObj);
      });
    } catch {}

    logger.info('[HANDLER] criar-perfil ok', { nome });
    return { ok: true, perfil: perfilObj };
  },

  async activate({ nome, operator }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] activate chamada', { nome });
      const r = await activateOnce(nome, 'message', operator);
      logger.info('[HANDLER] activate resultado', { nome, ok: !!(r && r.ok), error: r && r.error });
      return r;
    });
  },

  async deactivate({ nome, reason, policy }) {
  return lockProfileAction(nome, async () => {
  logger.info('[HANDLER] deactivate chamada', { nome, reason, policy });
  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'worker_deactivate_handler_called',
      nome: String(nome || ''),
      reason: String(reason || ''),
      policy: policy == null ? null : String(policy),
      freeMB: getAvailableMB(),
      ctrlPresent: !!controllers.get(nome),
      working: !!(controllers.get(nome) && controllers.get(nome).trabalhando),
      humanControl: !!(controllers.get(nome) && controllers.get(nome).humanControl),
      configurando: !!(controllers.get(nome) && controllers.get(nome).configurando),
      emExecucao: !!(robeMeta[nome] && robeMeta[nome].emExecucao),
      closingReason: (robeMeta[nome] && robeMeta[nome].closingReason) ? String(robeMeta[nome].closingReason).slice(0, 120) : null
    });
  } catch {}
  const preserve = (policy === 'preserveDesired');
  const strictCloseRequired =
    !preserve &&
    /^(auto_banned|auto_two_factor|admin_delete|ct_delete_on_server|auto_delete|delete)$/i.test(String(reason || '').trim());
  // Resolver userDataDir cedo (para validação pós-close determinística)
  let udirForCheck = '';
  try {
    const man0 = await manifestStore.read(nome).catch(()=>null);
    if (man0 && man0.userDataDir) udirForCheck = String(man0.userDataDir);
  } catch {}
  if (!udirForCheck) {
    try {
      const perfisArr = loadPerfisJson();
      const perfil = Array.isArray(perfisArr) ? perfisArr.find(p => p && p.nome === nome) : null;
      if (perfil && perfil.userDataDir) udirForCheck = String(perfil.userDataDir);
    } catch {}
  }
  if (!udirForCheck) {
    try { udirForCheck = path.join(resolveChromeUserDataRoot(), 'Conveniente', String(nome || '').trim()); } catch {}
  }
  let reopenDelayMs = 0;
  if (preserve) {
    try { registerFailure(nome, reason || 'deactivate_preserve'); } catch {}
    reopenDelayMs = getControlledReopenDelayMs(reason || 'preserve');
  }
  const ctrl = controllers.get(nome);
  if (!ctrl) {
    // Enterprise HARD: se este deactivate faz parte de um fluxo de delete, não podemos “fingir ok”
    // quando ainda existe Chrome vivo para este perfil (isso gera exatamente o navegador fantasma).
    if (strictCloseRequired) {
      let udir = '';
      try {
        const man0 = await manifestStore.read(nome).catch(()=>null);
        if (man0 && man0.userDataDir) udir = String(man0.userDataDir);
      } catch {}
      if (!udir) {
        try {
          const perfisArr = loadPerfisJson();
          const perfil = Array.isArray(perfisArr) ? perfisArr.find(p => p && p.nome === nome) : null;
          if (perfil && perfil.userDataDir) udir = String(perfil.userDataDir);
        } catch {}
      }
      if (udir) {
        const chk = (browserHelper.getChromeProfilePidsMeta
          ? browserHelper.getChromeProfilePidsMeta(udir)
          : { ok: true, pids: (browserHelper.getChromeProfilePids ? (browserHelper.getChromeProfilePids(udir) || []) : []) });
        const pids = chk && Array.isArray(chk.pids) ? chk.pids : [];
        if (!chk || chk.ok === false || pids.length) {
          try {
            provisionAudit.append({
              event: 'deactivate_blocked_controller_missing_chrome_alive',
              nome: String(nome || ''),
              reason: String(reason || ''),
              userDataDir: String(udir).slice(0, 260),
              pids: pids.slice(0, 24),
              pidCheckOk: chk && chk.ok === false ? false : true,
              pidCheckErr: chk && chk.ok === false ? String(chk.error || 'pid_check_failed').slice(0, 180) : null
            });
          } catch {}
          try {
            await manifestStore.update(nome, (man) => {
              man = man || {};
              man.accountFlags = man.accountFlags || {};
              man.accountFlags.pendingClose = true;
              man.accountFlags.pendingCloseAt = Date.now();
              man.accountFlags.pendingCloseReason = 'controller_missing_chrome_alive';
              man.accountFlags.pendingClosePids = pids.slice(0, 24);
              return man;
            });
          } catch {}
          await snapshotStatusAndWrite();
          return { ok: false, error: 'controller_missing_chrome_alive' };
        }
      } else {
        try {
          provisionAudit.append({
            event: 'deactivate_blocked_controller_missing_no_userDataDir',
            nome: String(nome || ''),
            reason: String(reason || '')
          });
        } catch {}
        await snapshotStatusAndWrite();
        return { ok: false, error: 'controller_missing_no_userDataDir' };
      }
    }
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    if (preserve && !isFrozenNow(nome) && !isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      const now = Date.now();
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else if (preserve && isHold) {
      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] deactivate concluído (controller ausente)', { nome });
    return { ok: true };
  }
  // antes de mexer em browser:
  try {
    if (ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
      await ctrl.virtus.stop();
    }
  } catch {}
  ctrl.virtus = null;
  ctrl.trabalhando = false;
  // HARD CLOSE militar
  let hc = null;
  try {
    hc = await hardCloseController(nome, ctrl, {
      reason: reason || 'deactivate',
      allowKillUserDataDir: !preserve
    });
  } catch (e) {
    hc = { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }

  // ENTERPRISE HARD: em fluxo de delete, NÃO retornar ok:true se ainda existir Chrome vivo.
  // (Isso causa exatamente o cenário: perfil deletado + navegador aberto/bugado.)
  if (strictCloseRequired) {
    const udir = (hc && hc.userDataDir) ? String(hc.userDataDir) : String(udirForCheck || '');
    // 1) Se hardClose deixou rootPid vivo, já é incompleto.
    const rootAliveAfter = (hc && typeof hc.rootPidAliveAfter === 'boolean') ? hc.rootPidAliveAfter : null;

    // 2) Check PIDs por userDataDir (sinal forte do Chrome do perfil ainda vivo)
    let chk = null;
    try {
      if (udir && browserHelper.getChromeProfilePidsMeta) chk = browserHelper.getChromeProfilePidsMeta(udir);
      else if (udir && browserHelper.getChromeProfilePids) chk = { ok: true, pids: browserHelper.getChromeProfilePids(udir) || [] };
      else chk = { ok: false, pids: [], error: 'pid_check_unavailable' };
    } catch (e) {
      chk = { ok: false, pids: [], error: (e && e.message) ? String(e.message).slice(0, 180) : 'pid_check_failed' };
    }
    const pidOk = !!(chk && chk.ok);
    const pids = (chk && Array.isArray(chk.pids)) ? chk.pids : [];

    if (!pidOk || pids.length || rootAliveAfter === true) {
      // Tentativa extra (graciosa) antes de bloquear: fechar por userDataDir sem /F.
      try {
        if (udir && browserHelper.closeChromeProfileProcessesGraceful) {
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'deactivate_extra_graceful_close_begin',
              nome: String(nome || ''),
              reason: String(reason || ''),
              userDataDir: String(udir).slice(0, 260),
              pids: pids.slice(0, 24),
              pidCheckOk: pidOk,
              pidCheckErr: pidOk ? null : (chk && chk.error ? String(chk.error).slice(0, 180) : 'pid_check_failed')
            });
          } catch {}
          browserHelper.closeChromeProfileProcessesGraceful(udir);
          await sleep(900);
        }
      } catch {}

      // Re-check após tentativa graciosa
      let chk2 = null;
      try {
        if (udir && browserHelper.getChromeProfilePidsMeta) chk2 = browserHelper.getChromeProfilePidsMeta(udir);
        else if (udir && browserHelper.getChromeProfilePids) chk2 = { ok: true, pids: browserHelper.getChromeProfilePids(udir) || [] };
        else chk2 = { ok: false, pids: [], error: 'pid_check_unavailable' };
      } catch (e) {
        chk2 = { ok: false, pids: [], error: (e && e.message) ? String(e.message).slice(0, 180) : 'pid_check_failed' };
      }
      const pid2Ok = !!(chk2 && chk2.ok);
      const pids2 = (chk2 && Array.isArray(chk2.pids)) ? chk2.pids : [];

      if (!pid2Ok || pids2.length || rootAliveAfter === true) {
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'deactivate_close_incomplete_block_delete',
            nome: String(nome || ''),
            reason: String(reason || ''),
            policy: policy == null ? null : String(policy),
            userDataDir: udir ? String(udir).slice(0, 260) : null,
            pidCheckOk: pid2Ok,
            pidCheckErr: pid2Ok ? null : (chk2 && chk2.error ? String(chk2.error).slice(0, 180) : 'pid_check_failed'),
            pids: pids2.slice(0, 24),
            hardClose: (hc && hc.flowId) ? {
              flowId: hc.flowId,
              durMs: hc.durMs || null,
              rootPid: hc.rootPid || null,
              rootPidAliveAfter: rootAliveAfter,
              udirPidsMetaOk: hc.udirPidsMetaOk,
              udirPidsMetaErr: hc.udirPidsMetaErr,
              udirPidsAfter: hc.udirPidsAfter || null
            } : null
          });
        } catch {}
        try {
          await manifestStore.update(nome, (man) => {
            man = man || {};
            man.accountFlags = man.accountFlags || {};
            man.accountFlags.pendingClose = true;
            man.accountFlags.pendingCloseAt = Date.now();
            man.accountFlags.pendingCloseReason = 'deactivate_close_incomplete';
            man.accountFlags.pendingClosePids = pids2.slice(0, 24);
            man.accountFlags.pendingCloseUserDataDir = udir ? String(udir).slice(0, 260) : null;
            return man;
          });
        } catch {}
        await snapshotStatusAndWrite();
        return { ok: false, error: 'chrome_alive_after_deactivate' };
      }
    }
  }
  // cleanup pós-fechamento
  try {
    const root = robeMeta[nome]?.rootPid;
    if (root) robeMeta[nome].rootPid = null;
  } catch {}
  try { freezeCooldownIfNotWorking(nome); } catch {}
  controllers.delete(nome);

  try {
    if (robeMeta[nome]) {
      delete robeMeta[nome].emExecucao;
      delete robeMeta[nome].emFila;
      delete robeMeta[nome].cpuHistory;
      delete robeMeta[nome].ramHist;
      delete robeMeta[nome].reloadAttemptsWindow;
      delete robeMeta[nome].blockDetectWindow;
    }
  } catch {}

  stopPruneLoop(nome);
  cleanupProfileTransientLocks(nome, 'deactivate');
  // #region agent log
  __agentLog(
    'H3',
    'worker.js:deactivate.cleanup',
    'cleanup_after_deactivate',
    {
      nome: String(nome || ''),
      preserve: !!preserve,
      hasController: controllers.has(nome),
      hasRobeMeta: !!robeMeta[nome],
      hasActivationLock: activationLocks.has(nome),
      hasPruner: _pruners.has(nome),
      hasProfileOpLock: _profileOpLocks.has(nome),
      hasOpening: !!(opening && opening[nome]),
      rootPid: robeMeta[nome] ? (robeMeta[nome].rootPid || null) : null
    },
    `cleanup.deactivate.${String(nome || '')}`,
    15000
  );
  // #endregion
  if (!preserve) {
    try {
      await fileStore.withDesiredFileLockUpdate((d) => {
        d.perfis = d.perfis || {};
        d.perfis[nome] = { ...(d.perfis[nome] || {}), active: false, virtus: 'off' };
        return d;
      });
    } catch (e) {
      try { await issues.append('system','persist_failed', `${nome}|deactivate_desired_write`); } catch {}
    }
  } else {
    const d = readJsonFile(desiredPath, { perfis: {} });
    const isHold = d.perfis?.[nome]?.humanHold === true;
    robeMeta[nome] = robeMeta[nome] || {};
    const now = Date.now();
    if (!isHold) {
      if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now)) {
        robeMeta[nome].reopenAt = now + reopenDelayMs;
        robeMeta[nome].closingReason = reason || '';
        issues.append(nome, 'mil_action', `reopen_scheduled(${reason||'unknown'}) in ${Math.round(reopenDelayMs/1000)}s`).catch(()=>{});
      } else {
        issues.append(nome, 'mil_action', 'reopen_preserved_existing').catch(()=>{});
      }
    } else {
      robeMeta[nome].reopenAt = null;
      issues.append(nome, 'mil_action', 'reopen_suppressed_human_hold').catch(()=>{});
    }
  }
  await snapshotStatusAndWrite();
  logger.info('[HANDLER] deactivate concluído', { nome, reason, policy });
  return { ok: true };
  });
},

  async configure({ nome, operator } = {}) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] configure chamada', { nome });
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 10601000;

      const perfisArr = loadPerfisJson();
      const perfil = perfisArr.find(p => p && p.nome === nome);
      if (!perfil || !perfil.userDataDir) return { ok: false, error: 'Perfil não encontrado!' };
      const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) return { ok: false, error: 'Manifest não existe para este perfil!' };
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.cookies) || !manifest.cookies.length) {
        try { await issues.append(nome, 'cookie_inject_failed', 'Cookies não encontrados no manifest!'); } catch {}
        return { ok: false, error: 'Cookies não encontrados no manifest!' };
      }
      ctrl.configurando = true;

      const op = String(operator || '').trim();
      const isStockProvision = (op && op.toLowerCase().startsWith('stock_provision'));
      const mustHaveProvisionLock = String(process.env.CONFIGURE_REQUIRE_PROVISION_LOCK || '1').trim() === '1';
      if (mustHaveProvisionLock) {
        try {
          if (!provisionLock.isActive()) {
            // Contrato enterprise: configure deve rodar sob provisionLock para bloquear Robe/nurse e evitar flapping.
            // (A rota API já adquire lock; stock_provision e login_remediate também usam lock global próprio.)
            return { ok: false, error: 'configure_requires_provision_lock' };
          }
        } catch {
          return { ok: false, error: 'configure_requires_provision_lock' };
        }
      }
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'configure_begin',
          nome: String(nome || ''),
          operator: op || null,
          isStockProvision: !!isStockProvision,
          mustHaveProvisionLock: !!mustHaveProvisionLock
        });
      } catch {}
      const pausedGlobal = [];
      const closedForRam = [];
      let enteredHuman = false;
      const targetWasWorking = !!ctrl.trabalhando;
      const desiredBefore = readJsonFile(desiredPath, { perfis: {} });
      const targetDesiredBefore = (desiredBefore && desiredBefore.perfis && desiredBefore.perfis[nome]) ? { ...(desiredBefore.perfis[nome] || {}) } : {};

      const invokeHumanForConfigure = async (reason) => {
        const why = String(reason || 'configure_failed');
        // Regra do usuário: NUNCA invocar humano automaticamente.
        // Mantém Virtus OFF e registra erro, mas não seta humanHold/humanControl.
        enteredHuman = false;
        try {
          provisionAudit.append({ ts: Date.now(), event: 'configure_human_hold', nome: String(nome || ''), operator: op || null, reason: why });
        } catch {}
        try { await setLoginRequiredFlag(nome, { reason: why, source: 'configure' }); } catch {}
        try { await setLoginRemediateFailedFlag(nome, { reason: why, source: 'configure', stage: 'configure' }); } catch {}
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
            return d;
          });
        } catch {}
        try { ctrl.trabalhando = false; try { await stopVirtus(nome); } catch {} } catch {}
      };

      const reasonPriority = (r) => {
        const s = String(r || '').toLowerCase();
        if (s.includes('two_factor') || s.includes('2fa')) return 6;
        if (s.includes('identity')) return 5;
        if (s.includes('captcha')) return 4;
        if (s.includes('checkpoint')) return 3;
        if (s.includes('appeal')) return 2;
        if (s.includes('login_form')) return 1;
        return 0;
      };

      try {
        // Ultra enterprise: antes de injetar cookies, garantir quiescência global (Virtus/Robe pausados)
        // Importante: se pausarmos Virtus de outros perfis, precisamos retomar ao final.
        {
          const require = String(process.env.CONFIGURE_REQUIRE_QUIESCE || '1').trim() === '1';
          const waitBusyMs = Math.max(0, Number(process.env.CONFIGURE_WAIT_BUSY_MS || 120000) || 120000);
          const waitPauseMs = Math.max(0, Number(process.env.CONFIGURE_WAIT_PAUSE_MS || 45000) || 45000);
          try { provisionAudit.append({ ts: Date.now(), event: 'configure_quiesce_begin', nome: String(nome||''), operator: op || null, require, waitBusyMs, waitPauseMs }); } catch {}
          const q = await waitGlobalQuiesce({ opKind: 'configure', operator: op, targetNome: nome, waitBusyMs, waitPauseMs, require });
          for (const it of (q && q.paused) ? q.paused : []) pausedGlobal.push(it);
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'configure_quiesce_done',
              nome: String(nome || ''),
              operator: op || null,
              pausedCount: pausedGlobal.length,
              pausedNames: pausedGlobal.map(x => x && x.nome).filter(Boolean).slice(0, 60)
            });
          } catch {}
        }

        // Headroom (enterprise): se necessário, fecha o mínimo possível (preserveDesired) e o nurse reabre depois.
        try {
          const snapPolicy = ramPolicy.snapshotPolicy();
          const minFreeMB = snapPolicy.reserveProvisionMB;
          const maxHardDeactivations = Math.max(0, Number(process.env.CONFIGURE_MAX_HARD_DEACTIVATIONS || 2) || 2);
          let free = getAvailableMB();
          if (free < minFreeMB) {
            try { provisionAudit.append({ ts: Date.now(), event: 'configure_headroom_check', nome, operator: op, freeMB: free, minFreeMB }); } catch {}
          }
          while (free < minFreeMB && closedForRam.length < maxHardDeactivations) {
            const candidates = [];
            controllers.forEach((c, n) => {
              if (!n || String(n) === String(nome)) return;
              if (!c || !c.browser) return;
              if (c.humanControl === true || c.configurando === true) return;
              if (c.browser._sendLock && c.browser._sendLock.active) return;
              if (robeMeta[n] && robeMeta[n].emExecucao === true) return;
              const ramMB = (robeMeta[n] && typeof robeMeta[n].ramMB === 'number') ? robeMeta[n].ramMB : (typeof c.ramMB === 'number' ? c.ramMB : 0);
              candidates.push({ nome: String(n), trabalhando: !!c.trabalhando, ramMB: Number(ramMB || 0) || 0 });
            });
            candidates.sort((a, b) => {
              if (a.trabalhando !== b.trabalhando) return (a.trabalhando ? 1 : -1) - (b.trabalhando ? 1 : -1);
              return (Number(b.ramMB) || 0) - (Number(a.ramMB) || 0);
            });
            const pick = candidates[0];
            if (!pick || !pick.nome) break;
            try {
              await handlers.deactivate({ nome: pick.nome, reason: 'ramKill', policy: 'preserveDesired' });
              closedForRam.push(pick.nome);
              try { provisionAudit.append({ ts: Date.now(), event: 'configure_headroom_closed', nome: String(nome||''), operator: op || null, closedNome: pick.nome, closedSoFar: closedForRam.length }); } catch {}
            } catch {}
            await sleep(1600);
            free = getAvailableMB();
          }
        } catch {}

        // Sempre pausar Virtus do próprio alvo antes de reinjetar cookies
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_stop_virtus', nome: String(nome||''), operator: op || null }); } catch {}
        try { await stopVirtus(nome); } catch {}

        // Operação de configuração é crítica: mantém Virtus OFF enquanto configura
        try {
          await fileStore.withDesiredFileLockUpdate((desired) => {
            desired.perfis = desired.perfis || {};
            desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
            return desired;
          });
        } catch {}

        try { provisionAudit.append({ ts: Date.now(), event: 'configure_inject_cookies_begin', nome: String(nome||''), operator: op || null }); } catch {}
        await browserHelper.configureProfile(ctrl.browser, nome, manifest.cookies);
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_inject_cookies_done', nome: String(nome||''), operator: op || null }); } catch {}

        // Pós-injeção: validar estado real (login_required / appeal_submitted / etc)
        let best = null;
        let bestPage = null;
        try {
          const pages = await ctrl.browser.pages().catch(()=>[]);
          for (const pg of (pages || []).slice(0, 8)) {
            const det = await browserHelper.detectLoginRequired(pg).catch(()=>null);
              if (det && det.loginRequired) {
                if (!best || reasonPriority(det.reason) > reasonPriority(best.reason)) {
                best = det;
                bestPage = pg;
              }
            }
          }
        } catch {}
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'configure_post_inject_login_check',
            nome: String(nome || ''),
            operator: op || null,
            loginRequired: !!(best && best.loginRequired),
            reason: best ? String(best.reason || '') : '',
            domain: best ? String(best.domain || '') : '',
            url: best ? String(best.url || '').slice(0, 220) : '',
            title: best ? String(best.title || '').slice(0, 180) : ''
          });
        } catch {}

        if (best && best.loginRequired) {
          const rr = String(best.reason || '').toLowerCase();
          if (rr.includes('identity_submitted')) {
            await setIdentitySubmittedFlag(nome, { source: best.domain || 'facebook', url: best.url || '', title: best.title || '' });
            try { provisionAudit.append({ ts: Date.now(), event: 'configure_abort_identity_submitted', nome: String(nome||''), operator: op || null, url: String(best.url || '').slice(0, 220) }); } catch {}
            return { ok: false, error: 'identity_submitted' };
          }
          if (rr.includes('identity_confirm') || rr === 'identity' || rr.startsWith('identity_')) {
            await setIdentityRequiredFlag(nome, { source: best.domain || 'facebook', url: best.url || '', title: best.title || '' });
            try { provisionAudit.append({ ts: Date.now(), event: 'configure_abort_identity_required', nome: String(nome||''), operator: op || null, url: String(best.url || '').slice(0, 220) }); } catch {}
            return { ok: false, error: 'identity_required' };
          }
          if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
            await setAppealSubmittedFlag(nome, { source: best.domain || 'facebook', url: best.url || '', title: best.title || '' });
            try { provisionAudit.append({ ts: Date.now(), event: 'configure_abort_appeal_submitted', nome: String(nome||''), operator: op || null, url: String(best.url || '').slice(0, 220) }); } catch {}
            return { ok: false, error: 'appeal_submitted' };
          }

          // Fallback: tentar login/senha (mesmo padrão do login_remediate)
          let login2 = null, password2 = null;
          try {
            const man = await manifestStore.read(nome).catch(()=>null);
            const login = man && (man.login || man.email || man.user || man.username);
            const password = man && (man.password || man.pass);
            if (login && password) { login2 = String(login).trim(); password2 = String(password); }
          } catch {}
          if (!login2 || !password2) {
            const fb = await fetchCredentialsFromCT({ profileName: nome });
            if (fb && fb.ok) { login2 = fb.login; password2 = fb.password; }
          }
          if (!login2 || !password2) {
            await invokeHumanForConfigure('missing_credentials');
            return { ok: false, error: 'missing_credentials' };
          }

          try {
            if (bestPage) {
              try { provisionAudit.append({ ts: Date.now(), event: 'configure_login_fallback_begin', nome: String(nome||''), operator: op || null }); } catch {}
              await browserHelper.ensureFbUiUnblocked(bestPage, nome, { reasonBase: 'configure_login', allowGpt: true, maxRounds: 2 }).catch(()=>null);
              await browserHelper.tryLoginEmailPass(bestPage, { nome, login: login2, password: password2, allowGpt: true }).catch(()=>null);
              await sleep(900);
            }
          } catch {}

          const after = await (bestPage ? browserHelper.detectLoginRequired(bestPage).catch(()=>({ loginRequired:false })) : ({ loginRequired:false }));
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'configure_login_fallback_done',
              nome: String(nome || ''),
              operator: op || null,
              stillLoginRequired: !!(after && after.loginRequired),
              reason: after ? String(after.reason || '') : '',
              url: after ? String(after.url || '').slice(0, 220) : ''
            });
          } catch {}
          if (after && after.loginRequired) {
            // Enterprise: quando o configure falha por "still_login_required", precisamos de evidência real
            // (HTML + screenshot) centralizada no CT, sem pedir logs manuais ao humano.
            try {
              robeMeta[nome] = robeMeta[nome] || {};
              const now = Date.now();
              const last = Number(robeMeta[nome].lastConfigureFbGptResolveAt || 0) || 0;
              if (!last || (now - last) > (10 * 60 * 1000)) {
                const pg = bestPage || (await ctrl.browser.pages().then(ps => ps && ps[0]).catch(() => null));
                const urlNow = pg && typeof pg.url === 'function' ? String(pg.url() || '') : '';
                const titleNow = pg && typeof pg.title === 'function' ? await pg.title().catch(() => '') : '';
                const html = pg ? await pg.content().catch(() => '') : '';
                const screenshotBase64 = pg ? await pg.screenshot({ type: 'jpeg', quality: 60, encoding: 'base64', fullPage: false }).catch(() => '') : '';
                await gptFallback.resolveFbGpt({
                  perfil: nome,
                  url: (after && after.url) ? String(after.url) : urlNow,
                  title: (after && after.title) ? String(after.title) : titleNow,
                  html: html || '',
                  screenshotBase64: screenshotBase64 || '',
                  reason: `configure_still_login_required:${String(after && after.reason || 'login')}`,
                  source: `configure:${String(after && after.domain || 'unknown')}`,
                  history: [
                    {
                      ts: now,
                      stage: 'configure_still_login_required',
                      url: (after && after.url) ? String(after.url) : urlNow,
                      title: (after && after.title) ? String(after.title) : titleNow,
                      note: 'snapshot'
                    }
                  ]
                }).catch(() => {});
                robeMeta[nome].lastConfigureFbGptResolveAt = now;
              }
            } catch {}
            await invokeHumanForConfigure(`still_login_required:${String(after.reason||'login')}`);
            return { ok: false, error: `still_login_required:${String(after.reason||'login')}` };
          }

          // Atualiza cookies frescos (best-effort)
          try {
            const fresh = await browserHelper.collectFreshCookies(bestPage || (await ctrl.browser.pages().then(ps=>ps[0]).catch(()=>null)));
            if (fresh && fresh.ok && Array.isArray(fresh.cookies) && fresh.cookies.length) {
              await manifestStore.update(nome, (m) => {
                m = m || {};
                m.cookies = fresh.cookies;
                m.cookiesUpdatedAt = Date.now();
                return m;
              });
            }
          } catch {}
        }

        // Blindagem cadastro (stock_provision):
        // garante Robe pausado por 24h já no fim do configure.
        // Assim, mesmo que falhe em etapas posteriores (recycle/start_work),
        // conta nova não posta antes da janela mínima.
        if (isStockProvision) {
          try {
            const plus24 = 24 * 60 * 60 * 1000;
            const now = Date.now();
            const desiredUntil = now + plus24;
            await manifestStore.update(nome, (m) => {
              m = m || {};
              const curUntil = Number(m.robeCooldownUntil || 0) || 0;
              m.robeCooldownUntil = Math.max(curUntil, desiredUntil);
              m.robeCooldownRemainingMs = 0;
              const r = String(m.robePauseReason || '');
              if (String(r).toLowerCase() !== 'limit_posting') {
                m.robePauseReason = 'new_account';
              }
              return m;
            });
            try { robeUpdateMeta(nome, { pauseReason: 'new_account' }); } catch {}
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'configure_new_account_robe_pause_applied',
                nome: String(nome || ''),
                operator: op || null,
                untilMs: desiredUntil,
                reason: 'new_account'
              });
            } catch {}
          } catch (e) {
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'configure_new_account_robe_pause_apply_fail',
                nome: String(nome || ''),
                operator: op || null,
                error: (e && e.message) ? String(e.message) : String(e)
              });
            } catch {}
          }
        }

        // Sucesso: limpa flags e segue.
        try { await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed']); } catch {}
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_success', nome: String(nome||''), operator: op || null, closedForRamCount: closedForRam.length }); } catch {}
        logger.info('[HANDLER] configure ok', { nome, closedForRamCount: closedForRam.length });
        return { ok: true, closedForRam };
      } catch (e) {
        try { await issues.append(nome, 'cookie_inject_failed', e && e.message || e); } catch {}
        logger.error('[HANDLER] configure erro', { nome, error: e && e.message || e }, e);
        try { provisionAudit.append({ ts: Date.now(), event: 'configure_exception', nome: String(nome||''), operator: op || null, error: (e && e.message) ? String(e.message) : String(e) }); } catch {}
        // Se falhou tecnicamente, entra em humano (padrão enterprise) para evitar ficar preso sem ação.
        try { await invokeHumanForConfigure((e && e.message) || String(e)); } catch {}
        return { ok: false, error: e && e.message || 'falha_injetar_cookies' };
      } finally {
        ctrl.configurando = false;
        // Regra enterprise:
        // - configure (falha) => entra em modo humano (para inspeção/resolução)
        // - configure (sucesso) => NÃO força modo humano; restaura estado desejado e retoma automação
        // - stock_provision ainda controla "start_work" no pipeline (dashboard.js)
        ctrl.humanControl = enteredHuman ? true : false;
        stopPruneLoop(nome);
        // Retoma Virtus dos perfis que estavam trabalhando e foram pausados para quiescência.
        try {
          const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
          const resumed = [];
          for (const it of pausedGlobal) {
            try {
              if (!it || !it.nome) continue;
              const n = String(it.nome);
              if (n === String(nome)) continue;
              const want = desiredSnap && desiredSnap.perfis ? (desiredSnap.perfis[n] || {}) : {};
              if (!(it.wasWorking === true)) continue;
              if (want && want.virtus === 'off') continue; // respeita desired
              const c = controllers.get(n);
              if (!c || !c.browser || !c.browser.isConnected?.()) continue;
              if (!automationAllowed(c)) continue;
              c.virtusEpoch = (c.virtusEpoch || 0);
              c.virtus = virtusHelper.startVirtus(c.browser, n, { restrictTab: 0, epoch: c.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              c.trabalhando = true;
              try { unfreezeCooldownIfWorking(n); } catch {}
              resumed.push(n);
            } catch {}
          }
          try { provisionAudit.append({ ts: Date.now(), event: 'configure_quiesce_resumed', nome: String(nome||''), operator: op, resumedCount: resumed.length, resumed: resumed.slice(0, 40) }); } catch {}
        } catch {}

        // Restaura desired do alvo (manual) e retoma Virtus do alvo (best-effort) se estava trabalhando.
        try {
          if (!enteredHuman && !isStockProvision) {
            await fileStore.withDesiredFileLockUpdate((d) => {
              d.perfis = d.perfis || {};
              const cur = d.perfis[nome] || {};
              // Mantém active como está (evita desligar por engano), mas restaura virtus ao que era antes.
              const wantVirtus = (targetDesiredBefore && typeof targetDesiredBefore.virtus === 'string') ? targetDesiredBefore.virtus : cur.virtus;
              d.perfis[nome] = { ...cur, virtus: wantVirtus };
              return d;
            });
          }
        } catch {}
        try {
          if (!enteredHuman && !isStockProvision && targetWasWorking) {
            const d2 = readJsonFile(desiredPath, { perfis: {} });
            const want = d2 && d2.perfis ? (d2.perfis[nome] || {}) : {};
            if (want && want.virtus !== 'off' && ctrl && ctrl.browser && ctrl.browser.isConnected?.() && automationAllowed(ctrl)) {
              ctrl.virtusEpoch = (ctrl.virtusEpoch || 0);
              ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
              ctrl.trabalhando = true;
              try { unfreezeCooldownIfWorking(nome); } catch {}
            }
          }
        } catch {}
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'configure_finalize',
            nome: String(nome || ''),
            operator: op || null,
            enteredHuman: !!enteredHuman,
            closedForRamCount: closedForRam.length,
            closedForRam: closedForRam.slice(0, 60)
          });
        } catch {}
        await snapshotStatusAndWrite();
      }
    });
  },

  // ===== NOVO: login_remediate (cookies -> login/senha -> humano) =====
  async login_remediate({ nome, operator, options } = {}) {
    return lockProfileAction(nome, async () => {
      const startedAt = Date.now();
      const op = String(operator || '').trim() || `login_remediate:${String(nome || '').trim()}:${startedAt}`;
      const opts = (options && typeof options === 'object') ? options : {};
      const authModeRaw = String(opts.authMode || process.env.STOCK_PROVISION_AUTH_MODE || 'cookies_first').trim().toLowerCase();
      const authMode = (authModeRaw === 'password_first') ? 'password_first' : 'cookies_first';
      const skipAttempt1InjectCookies = (
        authMode === 'password_first' ||
        opts.skipAttempt1InjectCookies === true ||
        String(opts.skipAttempt1InjectCookies || '').toLowerCase() === 'true'
      );
      const maxHardDeactivations = Math.max(0, Number(opts.maxHardDeactivations || 2) || 2);
      const waitBusyMs = Math.max(0, Number(opts.waitBusyMs || 120000) || 120000);
      const overrideHumanHold = (opts.overrideHumanHold === true || opts.overrideHumanHold === 1 || String(opts.overrideHumanHold || '').toLowerCase() === 'true');
      const totalTimeoutMs = Math.max(60_000, Number(opts.totalTimeoutMs || 0) || (8 * 60 * 1000));
      const stageTimeoutMs = {
        activate: Math.max(20_000, Number(opts.activateTimeoutMs || 0) || 90_000),
        injectCookies: Math.max(30_000, Number(opts.injectCookiesTimeoutMs || 0) || (4 * 60 * 1000)),
        loginFb: Math.max(20_000, Number(opts.loginFbTimeoutMs || 0) || 120_000),
        loginMsg: Math.max(20_000, Number(opts.loginMsgTimeoutMs || 0) || 120_000),
        collectCookies: Math.max(20_000, Number(opts.collectCookiesTimeoutMs || 0) || 90_000)
      };

      // Governança (cross-process): impede múltiplos login_remediate em paralelo no host.
      // Importante: NÃO trava — se não houver permit, devolve busy e o caller faz retry/backoff.
      let _govPermitToken = null;
      try {
        const pr = await supervisorClient.requestPermit('login_remediate', nome, {
          operator: op,
          ttlMs: Math.min((totalTimeoutMs + 60_000), (15 * 60 * 1000))
        }).catch(()=>null);
        if (!pr || pr.ok !== true || !pr.token) {
          try {
            provisionAudit.append({
              ts: Date.now(),
              event: 'login_remediate_governor_denied',
              nome: String(nome || ''),
              operator: op,
              reason: pr && pr.error ? String(pr.error) : 'unknown',
              inUse: pr && typeof pr.inUse === 'number' ? pr.inUse : null,
              max: pr && typeof pr.max === 'number' ? pr.max : null,
              retryAfterMs: pr && typeof pr.retryAfterMs === 'number' ? pr.retryAfterMs : null
            });
          } catch {}
          // P0: Se o governor negar por busy, o fluxo pode ficar "engessado" por conta do
          // min_interval do human_reconcile. Então enfileiramos retry no autoLoginRemediateTick.
          try {
            const r = String((pr && pr.error) || '').toLowerCase();
            if (r === 'busy' || r.includes('busy') || r.includes('governor_busy')) {
              const queued = queueAutoLoginRemediate(nome, {
                reason: 'governor_busy',
                source: 'login_remediate',
                immediate: true,
                force: true
              });
              try { provisionAudit.append({ ts: Date.now(), event: 'login_remediate_governor_retry_queued', nome: String(nome || ''), operator: op, queued: !!queued }); } catch {}
            }
          } catch {}
          return { ok: false, error: 'governor_busy', governor: pr || null };
        }
        _govPermitToken = pr.token;
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : String(e);
        try { provisionAudit.append({ ts: Date.now(), event: 'login_remediate_governor_exception', nome: String(nome || ''), operator: op, error: msg.slice(0, 200) }); } catch {}
        return { ok: false, error: `governor_exception:${msg}` };
      }

      const snapPolicy = ramPolicy.snapshotPolicy();
      const minFreeMB = snapPolicy.reserveProvisionMB;

      const deadlineAt = startedAt + totalTimeoutMs;
      const timeLeftMs = () => Math.max(0, deadlineAt - Date.now());
      const withTimeout = async (label, p, ms) => {
        const t = Math.max(1000, Math.min(ms, timeLeftMs()));
        let id;
        const to = new Promise((_, rej) => { id = setTimeout(() => rej(new Error(`timeout:${label}`)), t); });
        try { return await Promise.race([p, to]); }
        finally { try { clearTimeout(id); } catch {} }
      };
      const failFastToHuman = async (reason) => {
        const why = String(reason || 'login_remediate_failed');
        try {
          await setLoginRequiredFlag(nome, { reason: why, source: 'login_remediate' });
        } catch {}
        try {
          await setLoginRemediateFailedFlag(nome, { reason: why, source: 'login_remediate', stage: 'failFast' });
        } catch {}
        const shouldInvoke = /missing_credentials|login_requires_human|captcha|checkpoint|identity/.test(String(why || '').toLowerCase());
        // Regra do usuário: invocar humano quando falha for certeira (ex.: missing_credentials/captcha).
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: shouldInvoke ? true : false };
            return d;
          });
        } catch {}

        try {
          const ctrl = controllers.get(nome);
          if (ctrl) {
            ctrl.trabalhando = false;
            if (shouldInvoke) ctrl.humanControl = true;
            try { await stopVirtus(nome); } catch {}
          }
        } catch {}

        if (shouldInvoke) {
          try { await ensureHumanOverlay(nome, controllers.get(nome), { reason: `fail_fast:${why.slice(0,80)}` }); } catch {}
          try { provisionAudit.append({ ts: Date.now(), event: 'fail_fast_invoke_human', nome: String(nome||''), reason: why.slice(0, 160) }); } catch {}
        }

        // UX/telemetria: expõe o motivo como whyNotOpen (mesmo com browser aberto, ajuda a UI/diagnóstico)
        try {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].whyNotOpen = why;
        } catch {}

        try { await snapshotStatusAndWrite(); } catch {}
      };

      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'login_remediate_begin',
          nome: String(nome || ''),
          operator: op,
          minFreeMB,
          maxHardDeactivations,
          waitBusyMs,
          totalTimeoutMs,
          stageTimeoutMs,
          overrideHumanHold,
          authMode,
          skipAttempt1InjectCookies
        });
      } catch {}

      // 0) lock global (isola e pausa automações)
      const lk = provisionLock.tryAcquire({
        owner: op,
        ttlMs: Math.max(9 * 60 * 1000, waitBusyMs + 7 * 60 * 1000),
        meta: { nome: String(nome || ''), kind: 'login_remediate', startedAt }
      });
      if (!lk || !lk.ok) {
        const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
        return { ok: false, error: `provision_lock_busy${curOwner ? ` owner=${curOwner}` : ''}`, lock: lk && lk.lock ? lk.lock : null };
      }

      const steps = [];
      const pushStep = (s) => {
        try {
          const ev = Object.assign({ ts: Date.now() }, s || {});
          steps.push(ev);
          // Log incremental: mesmo se travar, fica evidência no provision_audit.jsonl
          try {
            provisionAudit.append({ ts: ev.ts, event: 'login_remediate_step', nome: String(nome || ''), operator: op, step: ev.step || null, data: ev });
          } catch {}
        } catch {}
      };
      // Importante: `pausedVirtus` precisa estar acessível no `finally` global para garantir resume
      // mesmo em returns antecipados (evita queda massiva de working após quiesce).
      let pausedVirtus = []; // [{ nome, wasWorking }]
      try {
      // 0.5) se este login_remediate foi explicitamente disparado (operador), pode limpar humanHold para permitir execução.
      if (overrideHumanHold) {
        try {
          await fileStore.withDesiredFileLockUpdate((d) => {
            d.perfis = d.perfis || {};
            d.perfis[nome] = { ...(d.perfis[nome] || {}), humanHold: false };
            return d;
          });
          pushStep({ step: 'human_hold_cleared' });
        } catch (e) {
          pushStep({ step: 'human_hold_clear_failed', error: (e && e.message) || String(e) });
        }
      }

      // 1) garantir browser aberto
      let ctrl = controllers.get(nome);
      const targetWasActive = !!(ctrl && ctrl.browser && ctrl.browser.isConnected?.());
      const targetWasWorking = !!(ctrl && ctrl.trabalhando);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        pushStep({ step: 'activate_needed' });
        const a = await withTimeout('activate', activateOnce(nome, 'message', op), stageTimeoutMs.activate);
        if (!a || a.ok === false) {
          try { provisionLock.release({ owner: op }); } catch {}
          return { ok: false, error: (a && a.error) ? String(a.error) : 'activate_failed', steps };
        }
        ctrl = controllers.get(nome);
      }
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        try { provisionLock.release({ owner: op }); } catch {}
        return { ok: false, error: 'browser_not_connected', steps };
      }

      // IMPORTANTE (anti-pânico): durante TODO o login_remediate nós mantemos "configurando=true"
      // para impedir oneTabGuard/pruners de fechar abas do provision (3 abas) no meio da validação.
      // (Antes: configurando virava false logo após configureProfile e o bootstrap capava para 2 abas.)
      const prevConfigurando = !!ctrl.configurando;
      ctrl.configurando = true;

      // 2) Ultra enterprise: quiescência determinística antes de injetar cookies
      // - espera envios/postagens ativos terminarem (busy)
      // - pausa Virtus de todos os perfis "pausáveis"
      // Se não conseguir quiescer dentro do timeout: aborta (sem falso positivo).
      pausedVirtus = []; // [{ nome, wasWorking }]
      try {
        const require = true;
        const waitPauseMs = Math.max(0, Number(opts.waitPauseMs || 45_000) || 45_000);
        const q = await waitGlobalQuiesce({ opKind: 'login_remediate', operator: op, targetNome: nome, waitBusyMs, waitPauseMs, require });
        for (const it of (q && q.paused) ? q.paused : []) pausedVirtus.push(it);
        pushStep({ step: 'virtus_paused', count: pausedVirtus.length, names: pausedVirtus.map(x => x.nome).slice(0, 30) });
      } catch (e) {
        const msg = (e && e.message) ? String(e.message) : String(e);
        pushStep({ step: 'quiesce_failed', error: msg });
        try { provisionLock.release({ owner: op }); } catch {}
        // Fail fast: não injeta cookies se não conseguiu pausar/esperar busy.
        await failFastToHuman(msg);
        return { ok: false, error: `quiesce_failed:${msg}`, steps, pausedVirtus };
      }

      // 3) garantir headroom (fechar o mínimo necessário)
      const closedForRam = [];
      try {
        let free = getAvailableMB();
        pushStep({ step: 'headroom_check', freeMB: free, minFreeMB });
        while (free < minFreeMB && closedForRam.length < maxHardDeactivations) {
          // pick: não-human, não-config, não-robe ativo; preferir não trabalhando, maior RAM
          const candidates = [];
          controllers.forEach((c, n) => {
            if (!n || String(n) === String(nome)) return;
            if (!c || !c.browser) return;
            if (c.humanControl === true || c.configurando === true) return;
            if (c.browser._sendLock && c.browser._sendLock.active) return;
            if (robeMeta[n] && robeMeta[n].emExecucao === true) return;
            const ramMB = (robeMeta[n] && typeof robeMeta[n].ramMB === 'number') ? robeMeta[n].ramMB : (typeof c.ramMB === 'number' ? c.ramMB : 0);
            candidates.push({ nome: String(n), trabalhando: !!c.trabalhando, ramMB: Number(ramMB || 0) || 0 });
          });
          candidates.sort((a, b) => {
            if (a.trabalhando !== b.trabalhando) return (a.trabalhando ? 1 : -1) - (b.trabalhando ? 1 : -1);
            return (Number(b.ramMB) || 0) - (Number(a.ramMB) || 0);
          });
          const pick = candidates[0];
          if (!pick || !pick.nome) break;
          pushStep({ step: 'deactivate_for_ram', pick: pick.nome, freeMB_before: free });
          try {
            await handlers.deactivate({ nome: pick.nome, reason: 'ramKill', policy: 'preserveDesired' });
            closedForRam.push(pick.nome);
          } catch {}
          await new Promise(r => setTimeout(r, 1800));
          free = getAvailableMB();
          pushStep({ step: 'headroom_after_deactivate', freeMB: free, minFreeMB });
        }
      } catch {
        pushStep({ step: 'headroom_recover_failed' });
      }

      // 4) tentativa 1: reinjetar cookies (configureProfile)
      if (!skipAttempt1InjectCookies) {
        try {
          const man0 = await manifestStore.read(nome).catch(()=>null);
          const cookies = (man0 && Array.isArray(man0.cookies)) ? man0.cookies : [];
          if (!cookies.length) {
            pushStep({ step: 'missing_cookies_in_manifest' });
            await failFastToHuman('missing_cookies_in_manifest');
            return { ok: false, error: 'missing_cookies_in_manifest', steps };
          }
          // Blindagem: durante configureProfile (abre várias abas), não deixar aboutBlankKiller matar as abas ainda em load.
          try {
            const guard = (ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {});
            guard[nome] = Date.now() + (6 * 60 * 1000);
          } catch {}
          pushStep({ step: 'attempt1_inject_cookies_begin' });
          await withTimeout('injectCookies', browserHelper.configureProfile(ctrl.browser, nome, cookies), stageTimeoutMs.injectCookies);
          pushStep({ step: 'attempt1_inject_cookies_done' });
        } catch (e) {
          pushStep({ step: 'attempt1_inject_cookies_fail', error: (e && e.message) || String(e) });
        } finally {
          // Não desativar configurando aqui: a validação pós-injeção ainda precisa das 3 abas vivas.
          // O reset acontece no finally global do login_remediate (abaixo).
          // Também não remove suppress imediatamente: popups/redirects podem abrir abas e ficar blank por alguns segundos após configure.
        }
      } else {
        // Modo password_first: pula injeção e vai direto para login/senha.
        pushStep({ step: 'attempt1_inject_cookies_skipped', authMode, reason: 'password_first' });
      }

      // 5) validar loginRequired em TODAS as abas reais (sem “puxar” tudo para /marketplace)
      let lrMessenger = null;
      let lrFacebook = null;
      let uiMessenger = null;
      let uiFacebook = null;
      try {
        const pages = await ctrl.browser.pages().catch(()=>[]);
        const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
        const pick = (pred) => {
          for (const pg of (pages || [])) {
            const u = safeUrl(pg);
            if (!u) continue;
            try { if (pred(u, pg)) return pg; } catch {}
          }
          return null;
        };

        // Seleção robusta por URL (evita falso positivo por ordem de abas variar)
        const pMsg = pick((u) => /messenger\.com/i.test(u)); // Messenger (Virtus)
        const pCreate = pick((u) => /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u)); // Robe create (FB)
        const pFb = pick((u) => /facebook\.com\/marketplace/i.test(u)); // Marketplace (FB) fallback
        const pLang = pick((u) => /facebook\.com\/settings\/language/i.test(u)); // sanity
        const pAny = (pages && pages[0]) || pMsg || pCreate || pFb || null;

        const checkOne = async (page, label) => {
          if (!page) return null;
          // Blindagem: garanta que estamos checando o domínio correto
          try {
            const u0 = safeUrl(page);
            if (label === 'msg' && !/messenger\.com/i.test(u0)) {
              await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
              await new Promise(r => setTimeout(r, 2200));
            }
            if (label.startsWith('fb') && !/facebook\.com/i.test(u0)) {
              // Regra 110% enterprise: para validar Facebook/Marketplace para Robe, usar a rota REAL create/(item|vehicle)
              // conforme robeMode do manifest (evita fechar/prunar a aba "errada" e evita navegação do Messenger para FB).
              let robeMode = 'itens';
              try {
                const manx = await manifestStore.read(nome).catch(()=>null);
                if (manx && manx.robeMode) robeMode = String(manx.robeMode);
              } catch {}
              const targetUrl = (String(robeMode || '').toLowerCase() === 'veiculos')
                ? 'https://www.facebook.com/marketplace/create/vehicle'
                : 'https://www.facebook.com/marketplace/create/item';
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
              await new Promise(r => setTimeout(r, 2200));
            }
          } catch {}
          await appendLoginRemediateEvidence({ nome, operator: op, step: `pre_check_${label}`, page, note: `before check ${label}` });
          // “olhos”: resolve popups/consent antes de validar login
          const ui = await browserHelper.ensureFbUiUnblocked(page, nome, { reasonBase: `login_remediate_${label}`, allowGpt: true, maxRounds: 3 }).catch(()=>null);
          pushStep({ step: `ui_unblock_${label}`, ui });
          const lr = await browserHelper.detectLoginRequired(page).catch(()=>({ loginRequired:false }));
          if (lr && lr.loginRequired) {
            try { await captureLoginRequiredEvidence(nome, page, lr); } catch {}
          }
          await appendLoginRemediateEvidence({ nome, operator: op, step: `post_check_${label}`, page, note: lr && lr.loginRequired ? 'loginRequired=true' : 'loginRequired=false' });
          return { ui, lr };
        };

        // A ordem importa: primeiro Messenger (Virtus), depois Facebook create/feed.
        // Importante: para declarar sucesso, é obrigatório ter validado Messenger + Facebook.
        const rMsg = await checkOne(pMsg || pAny, 'msg');
        uiMessenger = rMsg && rMsg.ui;
        lrMessenger = rMsg && rMsg.lr;

        const rCreate = await checkOne(pCreate || pFb || pAny, 'fb_create');
        uiFacebook = rCreate && rCreate.ui;
        lrFacebook = rCreate && rCreate.lr;

        // sanity checks (não afetam decisão principal, mas deixam evidência)
        await checkOne(pFb || pAny, 'fb_main');
        await checkOne(pLang, 'fb_lang');
      } catch {}
      pushStep({ step: 'post_inject_login_check', lrMessenger, lrFacebook, uiMessenger, uiFacebook });

      // Blindagem: se não conseguimos validar os 2 lados (Messenger + Facebook), NÃO pode dar sucesso.
      // Exceção: no modo password_first essa validação inicial pode vir incompleta por não abrir 3 abas via configureProfile.
      if (!lrMessenger || !lrFacebook) {
        pushStep({ step: 'missing_required_tabs_for_validation', hasMsg: !!lrMessenger, hasFb: !!lrFacebook, authMode });
        if (!skipAttempt1InjectCookies) {
          await failFastToHuman('validation_incomplete_missing_tabs');
          return { ok: false, error: 'validation_incomplete_missing_tabs', steps, closedForRam, pausedVirtus };
        }
      }

      const needsLogin =
        skipAttempt1InjectCookies ||
        (lrMessenger && lrMessenger.loginRequired) ||
        (lrFacebook && lrFacebook.loginRequired);

      const hardBlockReason = (lr) => {
        const r = String(lr && lr.reason || '').toLowerCase();
        return (r.includes('captcha') || r.includes('checkpoint') || r.includes('identity') || r.includes('two_factor') || r.includes('2fa') || r.includes('two factor'));
      };

      // 5.5) Blindagem enterprise: se a conta estiver desabilitada/banida em qualquer ponto,
      // marca ban e aborta imediatamente (sem "falso positivo" de login/cookies falhou).
      const checkAndAbortIfBanned = async (page, stage) => {
        try {
          const bd = await browserHelper.detectAccountSuspended(page).catch(()=>({ banned:false }));
          if (bd && bd.banned) {
            pushStep({ step: 'banned_detected', stage: String(stage||''), reason: bd.reason || '', snippet: (bd.snippet || '').slice(0, 420) });
            try { await setBannedFlag(nome, { reason: bd.reason || 'banned', snippet: bd.snippet || '' }); } catch {}
            // IMPORTANTE (enterprise): ban/disabled NÃO é “login/cookies falhou”.
            // Aqui a ação correta é setBannedFlag() (que fecha + remove do servidor).
            // Não deve marcar loginRemediateFailed/loginRequired depois disso.
            return true;
          }
        } catch {}
        return false;
      };

      // 6) tentativa 2: login+senha (apenas se for login_form; caso contrário invoca humano)
      if (needsLogin) {
        const bad = (hardBlockReason(lrMessenger) || hardBlockReason(lrFacebook));
        if (bad) {
          pushStep({ step: 'non_automatable_login_state', lrMessenger, lrFacebook });
          const why = String((lrMessenger && lrMessenger.reason) || (lrFacebook && lrFacebook.reason) || 'login_requires_human');

          // Novo fluxo (pedido do usuário): se for captcha/pre-screen, NÃO invocar humano imediatamente.
          // Tentamos 3 vezes (sem OCR implementado aqui) e só então invoca humano.
          const whyNorm = String(why || '').toLowerCase();
          if (whyNorm.includes('captcha_persona_pre_screen') || whyNorm.includes('captcha_persona') || whyNorm.includes('checkpoint_captcha')) {
            pushStep({ step: 'captcha_flow_begin', reason: why });
            let page = null;
            try {
              const pages = await ctrl.browser.pages().catch(()=>[]);
              page = (pages && pages[0]) ? pages[0] : null;
            } catch {}
            if (page) {
              for (let attempt = 1; attempt <= 3; attempt++) {
                pushStep({ step: 'captcha_flow_attempt', attempt });
                const lrNow = await browserHelper.detectLoginRequired(page).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
                if (!lrNow || lrNow.loginRequired !== true) { pushStep({ step: 'captcha_flow_cleared' }); break; }
                const r = String(lrNow.reason || '').toLowerCase();
                if (r.includes('captcha_persona_pre_screen')) {
                  const clk = await browserHelper.clickContinueByLabel(page, { maxWaitMs: 8000 }).catch(()=>({ ok:false, error:'click_failed' }));
                  pushStep({ step: 'captcha_pre_screen_click', attempt, ok: !!(clk && clk.ok), error: clk && clk.error ? String(clk.error) : null });
                  await sleep(1100);
                  continue;
                }
                if (r.includes('captcha_persona') || r.includes('checkpoint_captcha')) {
                  const cap = await browserHelper.detectCaptchaChallenge(page).catch(()=>({ ok:false, present:false }));
                  pushStep({ step: 'captcha_screen_probe', attempt, present: !!cap.present, continueDisabled: cap.continueDisabled });
                  await browserHelper.focusCaptchaInput(page).catch(()=>null);

                  // === OCR placeholder (não implementar aqui) ===
                  // const ocrText = await yourGroqOcrFunction(cap.imgSrc, { nome, operator: op, attempt });
                  // if (ocrText) await browserHelper.fillCaptchaAndContinue(page, { text: ocrText });

                  if (cap && cap.present && cap.continueDisabled === false) {
                    const clk2 = await browserHelper.clickContinueByLabel(page, { maxWaitMs: 6000 }).catch(()=>({ ok:false }));
                    pushStep({ step: 'captcha_click_continue_enabled', attempt, ok: !!(clk2 && clk2.ok) });
                    await sleep(1200);
                    continue;
                  }
                  await reloadPageEnterprise(page, { nome, tag: 'captcha_flow_reload', timeoutMs: 45_000 }).catch(()=>null);
                  await sleep(900);
                  continue;
                }
                break;
              }
              const lrAfter = await browserHelper.detectLoginRequired(page).catch(()=>({ loginRequired:true, reason:'probe_failed' }));
              if (!lrAfter || lrAfter.loginRequired !== true) {
                // liberou — segue
              } else {
                const still = String(lrAfter.reason || why).toLowerCase();
                pushStep({ step: 'captcha_flow_invoke_human_after_3_tries', reason: still });
                await failFastToHuman(`captcha_requires_human_after_3_tries:${still.slice(0,80)}`);
                return { ok: false, error: still, steps, closedForRam, pausedVirtus };
              }
            } else {
              // sem page => fallback para humano (não dá para tentar)
              await failFastToHuman(why);
              return { ok: false, error: why, steps, closedForRam, pausedVirtus };
            }
          } else {
            await failFastToHuman(why);
            return { ok: false, error: why, steps, closedForRam, pausedVirtus };
          }
        }

        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const login = man && (man.login || man.email || man.user || man.username);
          const password = man && (man.password || man.pass);
          if (!login || !password) {
            pushStep({ step: 'missing_credentials_in_manifest' });
            // Fallback enterprise: tenta buscar do CT/Estoque (hostId+profileName) e persistir no manifest.
            const fb = await fetchCredentialsFromCT({ profileName: nome });
            pushStep({ step: 'ct_credentials_fetch', ok: !!fb.ok, error: fb && fb.error, stockAccountId: fb && fb.stockAccountId || null });
            if (fb && fb.ok) {
              try {
                await manifestStore.update(nome, (m) => {
                  m = m || {};
                  m.login = String(fb.login);
                  m.password = String(fb.password);
                  m.credentialsUpdatedAt = Date.now();
                  return m;
                });
                pushStep({ step: 'manifest_credentials_updated' });
              } catch {}
              // Recarrega credenciais e segue pro login+senha
            } else {
              await failFastToHuman('missing_credentials');
              return { ok: false, error: 'missing_credentials', steps, closedForRam, pausedVirtus };
            }
          }

          const pages = await ctrl.browser.pages().catch(()=>[]);
          const p0 = pages && pages[0];
          if (!p0) throw new Error('no_page0');

          // UX HARDCORE: antes de login+senha, fechar todas as abas extras (fica só na aba 0)
          try { if (ctrl.browser && typeof browserHelper.forceCloseExtrasHard === 'function') await browserHelper.forceCloseExtrasHard(ctrl.browser); } catch {}

          const man2 = await manifestStore.read(nome).catch(()=>null);
          const login2 = man2 && (man2.login || man2.email || man2.user || man2.username);
          const password2 = man2 && (man2.password || man2.pass);
          if (!login2 || !password2) {
            pushStep({ step: 'missing_credentials_after_ct_fetch' });
            await failFastToHuman('missing_credentials');
            return { ok: false, error: 'missing_credentials', steps, closedForRam, pausedVirtus };
          }

          // Facebook primeiro (tende a refletir no Messenger)
          pushStep({ step: 'attempt2_login_fb_begin' });
          // Regra enterprise: validar/login sempre na rota real do Robe (create/item), não no feed.
          await p0.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
          await new Promise(r => setTimeout(r, 2600));
          await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: 'login_remediate_before_login_fb', allowGpt: true, maxRounds: 2 }).catch(()=>null);
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'before_login_fb', page: p0, note: 'fb before submit' });
          if (await checkAndAbortIfBanned(p0, 'before_login_fb')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };
          const rfb = await withTimeout('loginFb', browserHelper.tryLoginEmailPass(p0, { nome, login: login2, password: password2, allowGpt: true }), stageTimeoutMs.loginFb);
          pushStep({ step: 'attempt2_login_fb_done', result: rfb });
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'after_login_fb', page: p0, note: `fb result ok=${!!(rfb&&rfb.ok)} err=${rfb&&rfb.error||''}` });
          if (await checkAndAbortIfBanned(p0, 'after_login_fb')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };

          // Regra ultra enterprise: se FB cair em 2FA/captcha/checkpoint/identity, não adianta seguir para Messenger.
          try {
            const lrAfterFb = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
            if (lrAfterFb && lrAfterFb.loginRequired && hardBlockReason(lrAfterFb)) {
              pushStep({ step: 'non_automatable_after_login_fb', lr: lrAfterFb });
              await failFastToHuman(String(lrAfterFb.reason || 'login_requires_human'));
              return { ok: false, error: String(lrAfterFb.reason || 'login_requires_human'), steps, closedForRam, pausedVirtus };
            }
          } catch {}

          // Messenger depois (se necessário)
          pushStep({ step: 'attempt2_login_msg_begin' });
          await p0.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
          await new Promise(r => setTimeout(r, 2600));
          await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: 'login_remediate_before_login_msg', allowGpt: true, maxRounds: 2 }).catch(()=>null);
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'before_login_msg', page: p0, note: 'msg before submit' });
          if (await checkAndAbortIfBanned(p0, 'before_login_msg')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };
          const rmsg = await withTimeout('loginMsg', browserHelper.tryLoginEmailPass(p0, { nome, login: login2, password: password2, allowGpt: true }), stageTimeoutMs.loginMsg);
          pushStep({ step: 'attempt2_login_msg_done', result: rmsg });
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'after_login_msg', page: p0, note: `msg result ok=${!!(rmsg&&rmsg.ok)} err=${rmsg&&rmsg.error||''}` });
          if (await checkAndAbortIfBanned(p0, 'after_login_msg')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };

          // Se Messenger cair em estado não automatizável, também fail-fast.
          try {
            const lrAfterMsg = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
            if (lrAfterMsg && lrAfterMsg.loginRequired && hardBlockReason(lrAfterMsg)) {
              pushStep({ step: 'non_automatable_after_login_msg', lr: lrAfterMsg });
              await failFastToHuman(String(lrAfterMsg.reason || 'login_requires_human'));
              return { ok: false, error: String(lrAfterMsg.reason || 'login_requires_human'), steps, closedForRam, pausedVirtus };
            }
          } catch {}

          // revalidar
          await new Promise(r => setTimeout(r, 1400));
          lrMessenger = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));

          // Facebook: validar create/item (Robe real) — sem navegar para o feed.
          const uiRetryUnblock = async (label, rounds = 4) => {
            // Espera extra para evitar "unknown" por race de navegação/contexto
            await new Promise(r => setTimeout(r, 1600));
            let ui = await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: `login_remediate_${label}`, allowGpt: true, maxRounds: rounds }).catch(()=>null);
            if (ui && ui.ok === false && ui.kind === 'unknown') {
              // Retry com reload: muitos "unknown" são contexto destruído durante redirect
              try { await p0.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
              await new Promise(r => setTimeout(r, 1800));
              ui = await browserHelper.ensureFbUiUnblocked(p0, nome, { reasonBase: `login_remediate_${label}_retry`, allowGpt: true, maxRounds: rounds }).catch(()=>null);
            }
            return ui;
          };

          // Create item (Robe real)
          let uiCreate = null;
          let lrCreate = null;
          await p0.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
          uiCreate = await uiRetryUnblock('post_login_create_item', 4);
          if (await checkAndAbortIfBanned(p0, 'post_login_create_item')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };
          lrCreate = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
          pushStep({ step: 'post_login_check_create_item', lrCreate, uiCreate });
          await appendLoginRemediateEvidence({ nome, operator: op, step: 'final_check', page: p0, note: `final lrMsg=${!!(lrMessenger&&lrMessenger.loginRequired)} lrFb=${!!(lrFacebook&&lrFacebook.loginRequired)} lrCreate=${!!(lrCreate&&lrCreate.loginRequired)} uiFbOk=${!!(uiFacebook&&uiFacebook.ok)} uiCreateOk=${!!(uiCreate&&uiCreate.ok)}` });
          if (await checkAndAbortIfBanned(p0, 'final_check')) return { ok: false, error: 'banned', steps, closedForRam, pausedVirtus };

          // Se create item está bloqueado, reflita em uiFacebook para decisão abaixo
          if (uiCreate && uiCreate.ok === false) uiFacebook = uiCreate;
          if (lrCreate && lrCreate.loginRequired) lrFacebook = lrCreate;
          // Caso comum (conta nova): "probe_failed" no fb_main não pode derrubar o provision
          // se o create/item (Robe real) já validou ok.
          try {
            const fbReason = String((lrFacebook && lrFacebook.reason) || '');
            if (
              lrFacebook &&
              lrFacebook.loginRequired === true &&
              fbReason === 'probe_failed' &&
              lrCreate &&
              lrCreate.loginRequired === false
            ) {
              pushStep({ step: 'fb_probe_failed_overridden_by_create', fbReason, lrCreate });
              lrFacebook = lrCreate;
            }
          } catch {}

        } catch (e) {
          pushStep({ step: 'attempt2_login_fail', error: (e && e.message) || String(e) });
        }
      }

      let uiOk =
        (!uiMessenger || uiMessenger.ok === true) &&
        (!uiFacebook || uiFacebook.ok === true);

      let success =
        !(lrMessenger && lrMessenger.loginRequired) &&
        !(lrFacebook && lrFacebook.loginRequired) &&
        !!uiOk;

      // Hard rule: se cair em captcha/checkpoint/identity, NÃO é sucesso e deve invocar humano.
      const nonAutomatableReason = (lr) => {
        const r = String(lr && lr.reason || '').toLowerCase();
        if (!r) return '';
        if (r.includes('captcha')) return r;
        if (r.includes('checkpoint')) return r;
        if (r.includes('identity')) return r;
        if (r.includes('two_factor') || r.includes('2fa') || r.includes('two factor')) return 'two_factor';
        return '';
      };
      const na = nonAutomatableReason(lrMessenger) || nonAutomatableReason(lrFacebook);
      if (na) {
        pushStep({ step: 'non_automatable_after_login', reason: na, lrMessenger, lrFacebook });
        // 2FA => exclusão automática (não vira humano)
        if (String(na) === 'two_factor') {
          try { await setTwoFactorFlag(nome, { reason: 'two_factor', snippet: '' }); } catch {}
          return { ok: false, error: 'two_factor', steps, closedForRam, pausedVirtus };
        }
        try { await setLoginRequiredFlag(nome, { reason: na, source: 'login_remediate' }); } catch {}
        await failFastToHuman(na);
        return { ok: false, error: na, steps, closedForRam, pausedVirtus };
      }

      // Se não é loginRequired, mas a UI está bloqueada (consent/popup não resolvido), NÃO marque sucesso.
      if (!uiOk) {
        // Stock provision: tente mais uma rodada determinística (reload + unblock) antes de declarar "UI bloqueada (Humano)".
        // Motivação: conta nova costuma cair em consent/dialog temporário; dá para resolver sem humano em muitos casos.
        const isStockProvision = String(op || '').toLowerCase().startsWith('stock_provision');
        if (isStockProvision) {
          try {
            pushStep({ step: 'ui_blocked_retry_begin', uiMessenger, uiFacebook });
            const pages = await ctrl.browser.pages().catch(()=>[]);
            const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
            const pick = (pred) => {
              for (const pg of (pages || [])) {
                const u = safeUrl(pg);
                if (!u) continue;
                try { if (pred(u, pg)) return pg; } catch {}
              }
              return null;
            };
            const pMsg = pick((u) => /messenger\.com/i.test(u));
            const pCreate = pick((u) => /facebook\.com\/marketplace\/create\/(item|vehicle)/i.test(u));
            const pAny = (pages && pages[0]) || pMsg || pCreate || null;

            async function retryOn(page, label) {
              if (!page) return null;
              try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{}); } catch {}
              await sleep(1400);
              const ui = await browserHelper.ensureFbUiUnblocked(page, nome, { reasonBase: `login_remediate_ui_retry_${label}`, allowGpt: true, maxRounds: 5 }).catch(()=>null);
              return ui;
            }

            // Retry messenger
            const uiM2 = await retryOn(pMsg || pAny, 'msg');
            if (uiM2) uiMessenger = uiM2;
            // Retry facebook create
            const uiF2 = await retryOn(pCreate || pAny, 'fb');
            if (uiF2) uiFacebook = uiF2;

            uiOk =
              (!uiMessenger || uiMessenger.ok === true) &&
              (!uiFacebook || uiFacebook.ok === true);
            success =
              !(lrMessenger && lrMessenger.loginRequired) &&
              !(lrFacebook && lrFacebook.loginRequired) &&
              !!uiOk;
            pushStep({ step: 'ui_blocked_retry_done', uiOk, uiMessenger, uiFacebook });
          } catch {}
        }
      }

      // Se não é loginRequired, mas a UI está bloqueada (consent/popup não resolvido), NÃO marque sucesso.
      if (!uiOk) {
        const kind = (uiFacebook && uiFacebook.kind) || (uiMessenger && uiMessenger.kind) || 'ui_blocked';
        pushStep({ step: 'ui_blocked_after_login', kind, uiMessenger, uiFacebook });
        try { await setLoginRequiredFlag(nome, { reason: `ui_blocked:${kind}`, source: 'login_remediate' }); } catch {}
        await failFastToHuman(`ui_blocked:${kind}`);
        return { ok: false, error: `ui_blocked:${kind}`, steps, closedForRam, pausedVirtus };
      }

      if (success) {
        pushStep({ step: 'login_remediate_success' });
        // Conta nova (stock_provision): garantir Robe pausado 24h SEMPRE (110%).
        // Regra do lead: conta nova inicia trabalho com Virtus ON, mas Robe pausado 24h antes de postar.
        try {
          const isStockProvision = String(op || '').toLowerCase().startsWith('stock_provision');
          if (isStockProvision) {
            const plus24 = 24 * 60 * 60 * 1000;
            const now = Date.now();
            const desiredUntil = now + plus24;
            await manifestStore.update(nome, (m) => {
              m = m || {};
              const curUntil = Number(m.robeCooldownUntil || 0) || 0;
              // Garantia: pelo menos 24h a partir de agora.
              m.robeCooldownUntil = Math.max(curUntil, desiredUntil);
              m.robeCooldownRemainingMs = 0;
              // Não sobrescrever "limit_posting" (estado mais forte), mas em conta nova queremos new_account.
              const r = String(m.robePauseReason || '');
              if (String(r).toLowerCase() !== 'limit_posting') {
                m.robePauseReason = 'new_account';
              }
              return m;
            });
            pushStep({ step: 'new_account_robe_pause_applied', untilMs: desiredUntil, reason: 'new_account' });
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'new_account_robe_pause_applied',
                nome: String(nome || ''),
                operator: op,
                untilMs: desiredUntil,
                reason: 'new_account'
              });
            } catch {}
            try { robeUpdateMeta(nome, { pauseReason: 'new_account' }); } catch {}
          }
        } catch (e) {
          pushStep({ step: 'new_account_robe_pause_apply_fail', error: (e && e.message) || String(e) });
        }
        // Atualiza cookies frescos no manifest (pipeline imediato)
        try {
          const fresh = await withTimeout('collectCookies', browserHelper.collectFreshCookies(ctrl.browser), stageTimeoutMs.collectCookies);
          pushStep({ step: 'collect_fresh_cookies', ok: !!fresh.ok, count: fresh && fresh.cookies ? fresh.cookies.length : 0, error: fresh && fresh.error });
          if (fresh && fresh.ok && Array.isArray(fresh.cookies) && fresh.cookies.length) {
            await manifestStore.update(nome, (m) => {
              m = m || {};
              m.cookies = fresh.cookies;
              m.cookiesUpdatedAt = Date.now();
              return m;
            });
            pushStep({ step: 'manifest_cookies_updated' });
          }
        } catch {}
        try { await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed']); } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
      } else {
        pushStep({ step: 'login_remediate_failed', lrMessenger, lrFacebook });
        try { await setLoginRequiredFlag(nome, { reason: (lrMessenger && lrMessenger.reason) || (lrFacebook && lrFacebook.reason) || 'login_required', source: 'login_remediate' }); } catch {}
        await failFastToHuman('login_remediate_failed');
      }

      const out = {
        ok: !!success,
        nome: String(nome || ''),
        success: !!success,
        durationMs: Date.now() - startedAt,
        steps,
        closedForRam,
        pausedVirtus
      };

      // 7) restaurar estado (mínimo impacto):
      // - perfis que estavam trabalhando antes: retomar Virtus
      // - perfil alvo: só retomar se ele estava trabalhando antes E a remediação deu sucesso
      try {
        const resumed = [];
        const tryResume = (n) => {
          try {
            const ctrlR = controllers.get(n);
            if (!ctrlR || !ctrlR.browser || !ctrlR.browser.isConnected?.()) return false;
            if (ctrlR.humanControl === true || ctrlR.configurando === true) return false;
            if (!automationAllowed(ctrlR)) return false;
            ctrlR.virtus = virtusHelper.startVirtus(ctrlR.browser, n, {
              restrictTab: 0,
              epoch: ctrlR.virtusEpoch || 0,
              slowMode: (autoMode && autoMode.mode !== 'full'),
              governorMode: (autoMode && autoMode.mode) || 'full'
            });
            ctrlR.trabalhando = true;
            resumed.push(n);
            return true;
          } catch { return false; }
        };

        for (const it of pausedVirtus) {
          if (!it || !it.nome) continue;
          if (it.wasWorking === true) tryResume(it.nome);
        }
        if (success && targetWasWorking === true) {
          tryResume(String(nome));
        }
        pushStep({ step: 'virtus_resumed', count: resumed.length, names: resumed.slice(0, 30), targetWasActive, targetWasWorking });
        try { await snapshotStatusAndWrite(); } catch {}
      } catch {}

      // 8) Pós-sucesso enterprise:
      // - fechar o navegador do perfil (remove aba create/item, libera RAM)
      // - reabrir perfis fechados por RAM (mínimo impacto, gradual)
      // - reabrir e iniciar trabalho do perfil alvo (se solicitado)
      try {
        const opts2 = (options && typeof options === 'object') ? options : {};
        const closeAfterSuccess = shouldCloseAfterLoginRemediateSuccess(opts2);
        const startAfterSuccess = !(opts2.startAfterSuccess === false || opts2.startAfterSuccess === 0 || String(opts2.startAfterSuccess||'').toLowerCase()==='false');
        const reopenClosedForRam = !(opts2.reopenClosedForRam === false || opts2.reopenClosedForRam === 0 || String(opts2.reopenClosedForRam||'').toLowerCase()==='false');

        if (success && closeAfterSuccess) {
          pushStep({ step: 'post_success_close_target_begin' });
          // NÃO usar handlers.deactivate aqui (ele reentra em lockProfileAction e pode deadlockar).
          try {
            const ctrlClose = controllers.get(nome);
            if (ctrlClose && ctrlClose.browser && ctrlClose.browser.isConnected?.()) {
              try { if (ctrlClose.virtus && typeof ctrlClose.virtus.stop === 'function') await ctrlClose.virtus.stop(); } catch {}
              ctrlClose.virtus = null;
              ctrlClose.trabalhando = false;
              await withTimeout('post_success_hard_close', hardCloseController(nome, ctrlClose, { reason: 'login_remediate_post_success', allowKillUserDataDir: false }), 60_000).catch(()=>null);
              try { controllers.delete(nome); } catch {}
              try { stopPruneLoop(nome); } catch {}
              try { freezeCooldownIfNotWorking(nome); } catch {}
              try { await snapshotStatusAndWrite(); } catch {}
            }
          } catch {}
          pushStep({ step: 'post_success_close_target_done' });
        }

        if (success && reopenClosedForRam && Array.isArray(closedForRam) && closedForRam.length) {
          // Já foram fechados com policy=preserveDesired; o worker agenda reopenAt.
          // Aqui apenas “dá um empurrão” para reabrir mais cedo de forma gradual, sem reentrar em locks.
          const nudged = [];
          const now = Date.now();
          for (let i = 0; i < closedForRam.length; i++) {
            const n = String(closedForRam[i] || '').trim();
            if (!n) continue;
            try {
              robeMeta[n] = robeMeta[n] || {};
              const when = now + 1500 + (i * 1200);
              if (!robeMeta[n].reopenAt || robeMeta[n].reopenAt > when) robeMeta[n].reopenAt = when;
              nudged.push(n);
            } catch {}
          }
          pushStep({ step: 'reopen_closed_for_ram_nudged', count: nudged.length, names: nudged.slice(0, 30) });
        }

        if (success && startAfterSuccess) {
          // NÃO usar handlers.activate/start_work aqui (reentrância de lockProfileAction).
          // Estratégia enterprise determinística:
          // 1) patch desired (fonte de verdade) -> active=true, virtus=on, humanHold=false
          // 2) fechar browser temporário (já feito acima, se closeAfterSuccess)
          // 3) tentar ativar + iniciar Virtus com retries curtos
          //    - se falhar, NÃO travar/loop infinito: deixa nurse/desired completar.
          try {
            await fileStore.withDesiredFileLockUpdate((d) => {
              d.perfis = d.perfis || {};
              d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'on', humanHold: false };
              return d;
            });
            pushStep({ step: 'post_success_desired_updated', active: true, virtus: 'on' });
          } catch (e) {
            pushStep({ step: 'post_success_desired_update_fail', error: (e && e.message) || String(e) });
          }

          // Nudge: se estiver fechado agora, acelera nurse para reabrir.
          try {
            robeMeta[nome] = robeMeta[nome] || {};
            const when = Date.now() + 900;
            if (!robeMeta[nome].reopenAt || robeMeta[nome].reopenAt > when) robeMeta[nome].reopenAt = when;
          } catch {}

          // Tentativas curtas de ativação; se falhar, nurse/desired completa sem bloquear o fluxo.
          pushStep({ step: 'post_success_activate_once_begin' });
          let actOk = false;
          let lastActErr = null;
          const maxActAttempts = Math.max(1, Math.min(4, Number(opts2.maxPostSuccessActivateAttempts || 3) || 3));
          for (let attempt = 1; attempt <= maxActAttempts; attempt++) {
            pushStep({ step: 'post_success_activate_once_attempt', attempt });
            let act = null;
            try {
              act = await withTimeout('post_success_activate_once', activateOnce(nome, 'login_remediate_post_success', op), Math.min(90_000, stageTimeoutMs.activate || 90_000));
            } catch (e) {
              lastActErr = (e && e.message) || String(e);
              pushStep({ step: 'post_success_activate_once_attempt_fail', attempt, error: lastActErr });
            }
            if (act && act.ok) {
              actOk = true;
              break;
            }
            if (act && act.error) lastActErr = String(act.error);
            await sleep(900 + (attempt * 600));
          }
          pushStep({ step: 'post_success_activate_once_done', ok: actOk, error: lastActErr });

          // Só inicia Virtus se tiver controller+browser (evita "no_browser" enganoso).
          pushStep({ step: 'post_success_start_virtus_begin' });
          try {
            const ctrlNow = controllers.get(nome);
            if (ctrlNow && ctrlNow.browser && ctrlNow.browser.isConnected?.()) {
              if (!automationAllowed(ctrlNow, { operator: op })) {
                pushStep({ step: 'post_success_start_virtus_denied', error: 'automation_not_allowed' });
              } else {
                ctrlNow.virtusEpoch = (ctrlNow.virtusEpoch || 0);
                ctrlNow.virtus = virtusHelper.startVirtus(ctrlNow.browser, nome, {
                  restrictTab: 0,
                  epoch: ctrlNow.virtusEpoch,
                  slowMode: (autoMode && autoMode.mode !== 'full'),
                  governorMode: (autoMode && autoMode.mode) || 'full'
                });
                ctrlNow.trabalhando = true;
                try { await browserHelper.forceCloseExtras(ctrlNow.browser); } catch {}
                try { await snapshotStatusAndWrite(); } catch {}
                pushStep({ step: 'post_success_start_virtus_ok' });
              }
            } else {
              pushStep({ step: 'post_success_deferred_to_nurse', reason: 'no_controller_or_browser' });
            }
          } catch (e) {
            pushStep({ step: 'post_success_start_virtus_fail', error: (e && e.message) || String(e) });
          }
          pushStep({ step: 'post_success_start_virtus_done' });
        }
      } catch {}

      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'login_remediate_done',
          nome: String(nome || ''),
          operator: op,
          ok: !!success,
          durationMs: out.durationMs
        });
      } catch {}

      return out;
      } finally {
        // Reset flags de config SEMPRE (evita ficar "travado" em modo configurando).
        try {
          const c2 = controllers.get(nome);
          if (c2) c2.configurando = prevConfigurando ? true : false;
        } catch {}
        // 7) libera lock global sempre (mesmo com returns/erros)
        // IMPORTANTE: liberar ANTES do resume para `automationAllowed()` não bloquear re-start do Virtus.
        try { provisionLock.release({ owner: op }); } catch {}
        // Governança: libera permit sempre (anti-leak)
        try { if (_govPermitToken) await supervisorClient.releasePermit(_govPermitToken, { result: 'done' }).catch(()=>{}); } catch {}

        // P0 fix (forense): sempre tentar retomar Virtus dos perfis pausados pela quiescência.
        // Sem isso, um único auto_login_remediate pode derrubar "working" em massa (active=ok, virtusOffline).
        try {
          if (Array.isArray(pausedVirtus) && pausedVirtus.length > 0) {
            const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
            const resumed = [];
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'login_remediate_quiesce_resume_begin',
                nome: String(nome || ''),
                operator: op,
                pausedCount: pausedVirtus.length,
                pausedNames: pausedVirtus.map(x => x && x.nome).filter(Boolean).slice(0, 40)
              });
            } catch {}
            for (const it of pausedVirtus) {
              try {
                if (!it || it.wasWorking !== true) continue;
                const n = String(it.nome || '').trim();
                if (!n) continue;
                const want = desiredSnap && desiredSnap.perfis ? (desiredSnap.perfis[n] || {}) : {};
                if (want && want.virtus === 'off') continue; // respeita desired
                const c = controllers.get(n);
                if (!c || !c.browser || !c.browser.isConnected?.()) continue;
                if (!automationAllowed(c)) continue;
                c.virtusEpoch = (c.virtusEpoch || 0);
                c.virtus = virtusHelper.startVirtus(c.browser, n, { restrictTab: 0, epoch: c.virtusEpoch, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
                c.trabalhando = true;
                try { unfreezeCooldownIfWorking(n); } catch {}
                resumed.push(n);
              } catch {}
            }
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'login_remediate_quiesce_resumed',
                nome: String(nome || ''),
                operator: op,
                resumedCount: resumed.length,
                resumed: resumed.slice(0, 60)
              });
            } catch {}
          }
        } catch {}
      }
    });
  },

  start_work,

  async invoke_human({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] invoke_human chamada', { nome });

      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        try { await issues.append(nome, 'invoke_human_failed', 'browser_not_connected'); } catch {}
        return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
      }

      const robes = robeMeta[nome] || {};
      if (robes.emExecucao) {
        const waitTimeout = 180 * 1000;
        const started = Date.now();
        while ((robeMeta[nome] && robeMeta[nome].emExecucao) && (Date.now() - started < waitTimeout)) {
          await new Promise(r => setTimeout(r, 600));
        }
      }

      ctrl.humanControl = true;
      try { await issues.append(nome, 'invoke_human_set', 'humanControl=true'); } catch {}
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'invoke_human_set',
          nome: String(nome || ''),
          humanControl: true
        });
      } catch {}

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), humanHold: true };
          return desired;
        });
      } catch {}

      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].reopenAt = null;
        robeMeta[nome].closingReason = null;
      } catch {}

      ctrl.configurando = false;
      stopPruneLoop(nome);
      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = { ...(desired.perfis[nome] || {}), virtus: 'off' };
          return desired;
        });
      } catch {}
      await snapshotStatusAndWrite();

      const guard = ctrl.browser._suppressBlankKillUntil = ctrl.browser._suppressBlankKillUntil || {};
      guard[nome] = Date.now() + 246060*1000;

      try { await stopVirtus(nome); } catch {}

      await browserHelper.invocarHumano(ctrl.browser, nome);

      try { freezeCooldownIfNotWorking(nome); } catch {}
      try {
        await ensureHumanOverlay(nome, ctrl, { reason: 'invoke_human' });
        try { await issues.append(nome, 'invoke_human_overlay_ok', 'ok'); } catch {}
        try { provisionAudit.append({ ts: Date.now(), event: 'invoke_human_overlay_ok', nome: String(nome || '') }); } catch {}
      } catch (e) {
        try { await issues.append(nome, 'invoke_human_overlay_err', String((e && e.message) || e).slice(0, 120)); } catch {}
        try { provisionAudit.append({ ts: Date.now(), event: 'invoke_human_overlay_err', nome: String(nome || ''), error: String((e && e.message) || e).slice(0, 160) }); } catch {}
      }

      await snapshotStatusAndWrite();

      logger.info('[HANDLER] invoke_human ok', { nome });
      return { ok: true };
    });
  },

  async ['human-resume']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] human-resume chamada', { nome });

      const ctrl = controllers.get(nome);
      try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_entry', nome: String(nome||''), ctrlExists: !!ctrl, browserConnected: !!(ctrl && ctrl.browser && ctrl.browser.isConnected?.()) }); } catch {}
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_no_browser', nome: String(nome||'') }); } catch {}
        // Hardening: quando não há browser vivo, tente auto-reconciliação segura para evitar conta "presa".
        let desiredActive = false;
        try {
          const desiredSnap = fileStore.loadDesiredJson();
          desiredActive = !!(desiredSnap && desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].active === true);
        } catch {}
        try {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].numPages = 0;
          delete robeMeta[nome].whyNotOpen;
        } catch {}
        if (desiredActive) {
          try {
            await fileStore.withDesiredFileLockUpdate((d) => {
              d = d || {};
              d.perfis = d.perfis || {};
              d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false };
              return d;
            });
          } catch {}
          try {
            const op = `human_resume_reconcile_no_browser:${String(nome||'')}:${Date.now()}`;
            setTimeout(() => {
              try { handlers.activate({ nome, operator: op }).catch(()=>{}); } catch {}
            }, 0);
            try { await snapshotStatusAndWrite(); } catch {}
            try { await issues.append(nome, 'human_resume_reconcile', 'no_browser_activate_scheduled'); } catch {}
            return { ok: true, reconciled: 'no_browser_activate_scheduled' };
          } catch {}
        }
        try { await issues.append(nome, 'human_resume_failed', 'browser_not_connected'); } catch {}
        return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };
      }

      // IMPORTANTE: não usar flags antigas (appeal/identity) para decidir automação.
      // "Retomar trabalho" é um comando humano para REAVALIAR o estado real do navegador.
      const flagsBefore = await readAccountFlags(nome).catch(()=>({}));
      try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_flags_before', nome: String(nome||''), flags: { loginRequired: !!flagsBefore.loginRequired, loginRemediateFailed: !!flagsBefore.loginRemediateFailed, appealSubmitted: !!flagsBefore.appealSubmitted, identityRequired: !!flagsBefore.identityRequired } }); } catch {}

      ctrl.humanControl = false;
      // UX enterprise: ao retomar (mesmo que depois volte a humano), ocultar overlay imediatamente e ressincronizar no final.
      try { await syncHumanOverlay(nome); } catch {}
      // Enterprise: "Retomar trabalho" deve limpar TODO estado antigo para reavaliar o estado real.
      // - limpa flags de login/falha e também estados de análise (appeal/identity) para não engessar.
      try { await clearAccountFlags(nome, ['loginRequired','banned','loginRemediateFailed','messengerPin']); } catch {}
      try { await clearAppealSubmittedFlag(nome); } catch {}
      try { await clearIdentityFlags(nome); } catch {}
      try { if (ctrl.browser && ctrl.browser._suppressBlankKillUntil) delete ctrl.browser._suppressBlankKillUntil[nome]; } catch {}
      try {
        // Limpa runtime/meta que pode manter status antigo no painel.
        robeMeta[nome] = robeMeta[nome] || {};
        delete robeMeta[nome].whyNotOpen;
        delete robeMeta[nome].loginRemediateFailed;
        delete robeMeta[nome].loginRemediateFailedReason;
        delete robeMeta[nome].loginRequired;
        delete robeMeta[nome].loginReason;
        delete robeMeta[nome].appealSubmitted;
      } catch {}
      // "Retomar" deve remover humanHold antes do preflight (preflight pode reativar humanHold se necessário).
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d = d || {};
          d.perfis = d.perfis || {};
          d.perfis[nome] = { ...(d.perfis[nome] || {}), humanHold: false, virtus: 'off', active: true };
          return d;
        });
      } catch {}

      let pages2 = [];
      try { pages2 = await ctrl.browser.pages(); } catch {}
      if (pages2 && pages2[0]) maybeStartPruneLoop(nome, ctrl.browser, pages2[0]);
      try { await browserHelper.forceCloseExtras(ctrl.browser); } catch {}
      try {
        const ps = await ctrl.browser.pages();
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].numPages = (ps && ps.length) || 0;
        await snapshotStatusAndWrite();
      } catch {}

      let pages;
      try { pages = await ctrl.browser.pages(); } catch {}
      if (pages && pages[0]) {
        try {
          // Refresh + destravar modais do FB ANTES do preflight.
          // NÃO navegar para Messenger aqui, senão o preflight olha a aba errada e não detecta identidade/appeal.
          await require('./browser.js').ensureMinimizedWindowForPage(pages[0]);
          await new Promise(r => setTimeout(r, 350));
          await reloadPageEnterprise(pages[0], { nome, tag: 'human_resume_refresh', timeoutMs: 60_000 }).catch(()=>null);
        } catch {}
      }

      // ===== Enterprise HARDENING: diagnóstico imediato do estado real antes de "voltar a trabalhar" =====
      // Regras (ultra enterprise - usuário mandou):
      // - NUNCA invocar humano automaticamente. Somente via handler explícito invoke_human.
      // - Se estiver suspensa/banida: marca (auto delete/stock) e não tenta automação.
      // - Se estiver em captcha/identity/checkpoint/2FA: marca flags e mantém Virtus OFF.
      // - Se estiver em login/senha (login_form): agenda login_remediate (cookies -> login -> humano) sob provisionLock/quiesce.
      // - Se estiver em appeal_submitted: não retoma automação; arma monitoramento (1h).
      let scheduledLoginRemediate = false;
      let appealDetectedInPreflight = false;
      let preflight = { ok: true, state: 'unknown', reason: '' };
      try {
        // Preferir uma aba do Facebook (onde aparecem identity/appeal modals), não Messenger.
        const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
        const p0 =
          (pages && pages.find(p => /facebook\.com/i.test(safeUrl(p)) )) ||
          ((pages && pages[0]) ? pages[0] : null);
        try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_preflight_page', nome: String(nome||''), url: String(safeUrl(p0)||''), pagesCount: Array.isArray(pages) ? pages.length : 0 }); } catch {}
        if (p0) {
          // 0) Suspensa/banida (UI de suspensão)
          const bd = await browserHelper.detectAccountSuspended(p0).catch(()=>({ banned:false }));
          if (bd && bd.banned) {
        preflight = { ok: true, state: 'banned', reason: String(bd.reason || 'suspended_ui') };
        try { await issues.append(nome, 'human_resume_preflight', `state=banned reason=${preflight.reason}`); } catch {}
            try { await setBannedFlag(nome, { reason: String(bd.reason || 'suspended_ui'), snippet: String(bd.snippet || '') }); } catch {}
            try { ctrl.trabalhando = false; try { await stopVirtus(nome); } catch {} } catch {}
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
                return d;
              });
            } catch {}
            try { await snapshotStatusAndWrite(); } catch {}
            logger.info('[HANDLER] human-resume preflight -> banned', { nome, reason: preflight.reason });
            return { ok: true, preflight };
          }

          // 1) Login required / captcha / identity / appeal_submitted etc.
          const lr = await browserHelper.detectLoginRequired(p0).catch(()=>({ loginRequired:false }));
          try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_preflight_lr', nome: String(nome||''), loginRequired: !!(lr && lr.loginRequired), reason: String(lr && lr.reason || ''), domain: String(lr && lr.domain || ''), url: String(lr && lr.url || safeUrl(p0) || '') }); } catch {}
          if (lr && lr.loginRequired) {
            const rr = String(lr.reason || '').toLowerCase();
            preflight = { ok: true, state: 'login_required', reason: String(lr.reason || '') };
            try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || 'human_resume' }); } catch {}

            // appeal_submitted: não retoma automação; arma monitoramento (1h) e mantém Virtus OFF.
            if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
              preflight.state = 'appeal_submitted';
              try { await issues.append(nome, 'human_resume_preflight', `state=appeal_submitted reason=${String(lr.reason||'')}`); } catch {}
              appealDetectedInPreflight = true;
              try { await setAppealSubmittedFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> appeal_submitted', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }

            // identity_submitted: entra em monitor 1h (não é login/cookies falhou)
            if (rr.includes('identity_submitted')) {
              preflight.state = 'identity_submitted';
              try { await issues.append(nome, 'human_resume_preflight', `state=identity_submitted reason=${String(lr.reason||'')}`); } catch {}
              try { await setIdentitySubmittedFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> identity_submitted', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }
            // identity_required: estado próprio (não é falha de login)
            if (rr.includes('identity')) {
              preflight.state = 'identity_required';
              try { await issues.append(nome, 'human_resume_preflight', `state=identity_required reason=${String(lr.reason||'')}`); } catch {}
              try { await setIdentityRequiredFlag(nome, { source: lr.domain || '', url: lr.url || '', title: lr.title || '' }); } catch {}
              ctrl.trabalhando = false;
              try { await stopVirtus(nome); } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> identity_required', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }

            // Captcha/Checkpoint: temos fluxo automático (N tentativas) e só cai em humano se falhar.
            // 2FA => exclusão automática.
            const isTwoFactor = rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor');
            const isCaptchaCheckpoint = rr.includes('captcha') || rr.includes('checkpoint');
            const needsHuman =
              rr.includes('checkpoint');
            if (isTwoFactor) {
              preflight.state = 'two_factor';
              try { await issues.append(nome, 'human_resume_preflight', `state=two_factor reason=${String(lr.reason||'')}`); } catch {}
              try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(lr && lr.title || '') }); } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> two_factor', { nome, reason: lr.reason || '' });
              return { ok: false, error: 'two_factor', preflight };
            }
            if (isCaptchaCheckpoint) {
              // Captcha/Checkpoint é um estado próprio: NÃO marcar como "login/cookies falhou".
              preflight.state = 'captcha_flow_scheduled';
              try { await issues.append(nome, 'human_resume_preflight', `state=captcha_flow_scheduled reason=${String(lr.reason||'')}`); } catch {}
              try {
                await fileStore.withDesiredFileLockUpdate((d) => {
                  d.perfis = d.perfis || {};
                  d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
                  return d;
                });
              } catch {}
              try { ctrl.trabalhando = false; try { await stopVirtus(nome); } catch {} } catch {}
              try { runCaptchaFlow(nome, ctrl, p0, { source: 'human_resume_preflight', force: true }).catch(()=>{}); } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> captcha_flow_scheduled', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }
            if (needsHuman) {
              preflight.state = 'needs_human';
              try { await issues.append(nome, 'human_resume_preflight', `state=needs_human reason=${String(lr.reason||'')}`); } catch {}
              try { await setLoginRemediateFailedFlag(nome, { reason: lr.reason || 'login_requires_human', source: 'human_resume', stage: 'human_resume_preflight' }); } catch {}
              try {
                await fileStore.withDesiredFileLockUpdate((d) => {
                  d.perfis = d.perfis || {};
                  d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'off', humanHold: false };
                  return d;
                });
              } catch {}
              try { ctrl.trabalhando = false; try { await stopVirtus(nome); } catch {} } catch {}
              await snapshotStatusAndWrite();
              logger.info('[HANDLER] human-resume preflight -> needs_human', { nome, reason: lr.reason || '' });
              return { ok: true, preflight };
            }

            // login_form (ou outros loginRequired "automatable"): agenda login_remediate imediatamente.
            // Requisito do lead: após sucesso, conta nova/retomada deve iniciar com Robe em 24h (igual conta nova).
            try {
              const plus24 = 24 * 60 * 60 * 1000;
              const now = Date.now();
              await manifestStore.update(nome, (m) => {
                m = m || {};
                const curLeft = m.robeCooldownUntil ? (Number(m.robeCooldownUntil || 0) - now) : 0;
                const desiredLeft = plus24;
                const use = Math.max(0, curLeft, desiredLeft);
                m.robeCooldownUntil = now + use;
                m.robePauseReason = 'new_account';
                return m;
              });
              robeUpdateMeta(nome, { pauseReason: 'new_account' });
            } catch {}

            // Evita que Virtus reinicie antes do login_remediate pegar o provisionLock/quiesce.
            try {
              await fileStore.withDesiredFileLockUpdate((d) => {
                d.perfis = d.perfis || {};
                d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'off' };
                return d;
              });
            } catch {}
            try { ctrl.trabalhando = false; } catch {}
            try { await stopVirtus(nome); } catch {}

            scheduledLoginRemediate = true;
            try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_schedule_login_remediate', nome: String(nome||''), reason: String(lr && lr.reason || ''), source: String(lr && lr.domain || '') }); } catch {}
            const op2 = `human_resume:${String(nome || '').trim()}:${Date.now()}`;
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'human_resume_login_form',
                nome: String(nome || ''),
                reason: String(lr && lr.reason || '').slice(0, 120),
                source: String(lr && lr.domain || '')
              });
            } catch {}
            setTimeout(() => {
              try {
                handlers.login_remediate({
                  nome,
                  operator: op2,
                  options: { overrideHumanHold: true }
                }).then((res) => {
                  if (res && res.error === 'governor_busy') {
                    const queued = queueAutoLoginRemediate(nome, { reason: 'governor_busy', source: 'human_resume', immediate: true, force: true });
                    try { provisionAudit.append({ ts: Date.now(), event: 'login_remediate_governor_retry_queued', nome: String(nome||''), operator: op2, queued: !!queued }); } catch {}
                  }
                }).catch(()=>null);
              } catch {}
            }, 0);
            logger.info('[HANDLER] human-resume preflight -> scheduled login_remediate', { nome, reason: lr.reason || '' });
          }
        }
      } catch (e) {
        preflight = { ok: false, state: 'error', reason: (e && e.message) ? String(e.message) : String(e) };
        try { await issues.append(nome, 'human_resume_preflight', `state=error reason=${String(preflight.reason||'')}`); } catch {}
      }

      if (scheduledLoginRemediate) {
        try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_scheduled_login_remediate', nome: String(nome||''), reason: String(preflight && preflight.reason || '') }); } catch {}
        await snapshotStatusAndWrite();
        // desired é setado para virtus=off acima; login_remediate vai resolver e reativar se der certo.
        logger.info('[HANDLER] human-resume ok (login_remediate scheduled)', { nome, preflight });
        return { ok: true, scheduledLoginRemediate: true, preflight };
      }

      // ===== Fluxo original: se não caiu em nenhum estado "especial", retoma automação normal =====
      // Agora que o preflight passou, navegar para o Messenger (Virtus/Robe usam essa rota).
      try {
        let pagesN = [];
        try { pagesN = await ctrl.browser.pages(); } catch {}
        if (pagesN && pagesN[0]) {
          await pagesN[0].goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
          try {
            const lrPost = await browserHelper.detectLoginRequired(pagesN[0]).catch(()=>({ loginRequired:false }));
            try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_post_nav_lr', nome: String(nome||''), loginRequired: !!(lrPost && lrPost.loginRequired), reason: String(lrPost && lrPost.reason || ''), domain: String(lrPost && lrPost.domain || ''), url: String(lrPost && lrPost.url || '') }); } catch {}
            if (lrPost && lrPost.loginRequired) {
              const rrPost = String(lrPost.reason || '').toLowerCase();
              if (rrPost === 'login_form' || rrPost === 'login_required') {
                try { await setLoginRequiredFlag(nome, { reason: lrPost.reason || 'login_form', source: lrPost.domain || 'messenger' }); } catch {}
                try {
                  await fileStore.withDesiredFileLockUpdate((d) => {
                    d.perfis = d.perfis || {};
                    d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, humanHold: false, virtus: 'off' };
                    return d;
                  });
                } catch {}
                try { ctrl.trabalhando = false; } catch {}
                try { await stopVirtus(nome); } catch {}
                try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_post_nav_schedule_login_remediate', nome: String(nome||''), reason: String(lrPost && lrPost.reason || ''), source: String(lrPost && lrPost.domain || '') }); } catch {}
                const opPost = `human_resume_post_nav:${String(nome || '').trim()}:${Date.now()}`;
                try {
                  handlers.login_remediate({ nome, operator: opPost, options: { overrideHumanHold: true } })
                    .then((res) => {
                      try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_post_nav_result', nome: String(nome||''), operator: String(opPost||''), ok: !!(res && res.ok), error: String(res && res.error || '') }); } catch {}
                      const err = String(res && res.error || '');
                      if (err === 'governor_busy' || err === 'busy') {
                        const queued = queueAutoLoginRemediate(nome, { reason: 'governor_busy', source: 'human_resume_post_nav', immediate: true, force: true });
                        try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_post_nav_retry_queued', nome: String(nome||''), operator: String(opPost||''), queued: !!queued, error: err }); } catch {}
                      }
                    })
                    .catch((err) => {
                      try { provisionAudit.append({ ts: Date.now(), event: 'human_resume_post_nav_error', nome: String(nome||''), operator: String(opPost||''), error: String(err && err.message || err || '') }); } catch {}
                    });
                } catch {}
                await snapshotStatusAndWrite();
                return { ok: true, scheduledLoginRemediate: true, preflight: { ok: true, state: 'login_required_post_nav', reason: String(lrPost.reason || '') } };
              }
            }
          } catch {}
        }
      } catch {}

      if (!appealDetectedInPreflight) {
        if (automationAllowed(ctrl)) {
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
          ctrl.trabalhando = true;
        }
        try { unfreezeCooldownIfWorking(nome); } catch {}
      } else {
        ctrl.trabalhando = false;
        try { await stopVirtus(nome); } catch {}
      }

      await snapshotStatusAndWrite();
      logger.info('[HANDLER] human-resume ok', { nome });

      try {
        await fileStore.withDesiredFileLockUpdate((desired) => {
          desired.perfis = desired.perfis || {};
          desired.perfis[nome] = {
            ...(desired.perfis[nome] || {}),
            active: true,
            humanHold: false,
            virtus: appealDetectedInPreflight ? 'off' : 'on'
          };
          return desired;
        });
      } catch {}

      return { ok:true };
    });
  },

  async ['robe-play']({ nome }) {
    return lockProfileAction(nome, async () => {
      logger.info('[HANDLER] robe-play chamada', { nome });
      // #region agent log
      try { provisionAudit.append({ ts: Date.now(), event: 'dbg_worker_robe_play_handler_entry', nome: String(nome || ''), hasCtrl: !!controllers.get(nome) }); } catch {}
      // #endregion
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, error: 'Navegador não está aberto/vivo para esta conta!' };

      if (isFrozenNow(nome)) {
        return { ok: false, error: 'account_frozen' }
      }
      if (ctrl && ctrl.configurando) return { ok: false, error: 'perfil_em_configuracao' };

      try {
        await manifestStore.update(nome, (m) => {
          m = m || {};
          m.robeCooldownUntil = Date.now();
          m.robeCooldownRemainingMs = 0;
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
        if (robeMeta[nome]) {
          delete robeMeta[nome].pauseReason;
          delete robeMeta[nome].lastRobeBlockAt;
        }
      } catch {}

      if (!robeQueue.inQueue(nome) && !robeQueue.isActive(nome)) {
        // #region agent log
        try { provisionAudit.append({ ts: Date.now(), event: 'dbg_worker_robe_play_enqueued', nome: String(nome || ''), inQueue: !!robeQueue.inQueue(nome), isActive: !!robeQueue.isActive(nome) }); } catch {}
        // #endregion
        robeUpdateMeta(nome, { emFila: true });
        robeQueue.enqueue(nome, async () => {

          robeUpdateMeta(nome, { emExecucao: true, emFila: false });

          let virtusWasRunning = false;
          const ctrl = controllers.get(nome);
          const workingNow = getWorkingProfileNames();
          if (ctrl && ctrl.browser) ctrl.browser._robeActiveFor = nome;

          if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
            robeUpdateMeta(nome, { estado: 'erro' });
            try { await reportAction(nome, 'browser_disconnected', 'Browser desconectado antes de iniciar o Robe (robe-play guard)'); } catch {}
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            return;
          }

          try { logger.info('[WORKER][robe-play] Robe start', { nome }); } catch {}
          // #region agent log
          try { provisionAudit.append({ ts: Date.now(), event: 'dbg_worker_robe_play_startrobe_call', nome: String(nome || ''), virtusWasRunningHint: !!(ctrl && ctrl.virtus) }); } catch {}
          // #endregion
          try { await reportAction(nome, 'robe_start', 'Iniciando Robe via robe-play'); } catch {}

          let mainPage = null;
          try {
            if (ctrl && ctrl.browser && !ctrl.mainPage) {
              try {
                const pages = await ctrl.browser.pages();
                if (pages[0]) {
                  ctrl.mainPage = pages[0];
                  try { await wirePageObservers(nome, ctrl.mainPage); } catch {}
                }
              } catch {}
            }
            mainPage = ctrl.mainPage;

            if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
              virtusWasRunning = true;
              try { await ctrl.virtus.stop(); } catch {}
              ctrl.virtus = null;
            }

            try { await closeExtraPages(ctrl.browser, mainPage, nome); } catch {}

            let res;
            try {
              res = await startRobeDynamic(ctrl.browser, nome, drawRobeCooldownMs(), workingNow, getRobePhotoDeletePolicy());
            } catch (e) {
              if (e && e.ROBE_LOGIN_REQUIRED === true) {
                const rr = String(e.loginReason || 'login_required');
                const ss = String(e.loginSource || 'facebook');
                try {
                  provisionAudit.append({
                    ts: Date.now(),
                    event: 'robe_login_required_detected',
                    nome: String(nome || ''),
                    reason: rr,
                    source: ss
                  });
                } catch {}
                try { await setLoginRequiredFlag(nome, { reason: rr, source: ss }); } catch {}
                // Agenda remediação automática para convergir o fluxo Robe sem depender de novo clique.
                setTimeout(() => {
                  try {
                    handlers.login_remediate({
                      nome,
                      operator: `robe_play_login_required:${nome}:${Date.now()}`,
                      options: { overrideHumanHold: true }
                    }).catch(() => {});
                  } catch {}
                }, 0);
                try { await reportAction(nome, 'robe_login_required', `Robe detectou login_required (${rr}); remediação agendada.`); } catch {}
                robeUpdateMeta(nome, { estado: 'idle', cooldownSec: await normalizeCooldown(nome) });
                try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
                return;
              }
              if (e && (e.LIMIT_POSTING === true || String(e && e.message || '').includes('LIMIT_POSTING_ABORT'))) {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].limitPostingThisRun = Date.now();
                robeMeta[nome].pauseReason = 'limit_posting';
                robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
                try { await issues.append(nome, 'mil_action', 'limit_posting_guard:caught_throw (robe-play)'); } catch {}
                try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
                return;
              }
              await reportAction(nome, 'robe_error', `Falha técnica: ${(e&&e.message)||e}; cooldown padrão configurado no servidor será aplicado por robe.js`);
              robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
              try { logger.warn('[WORKER][robe-play] Robe error', { nome, error: e && e.message || e }); } catch {}
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (isLimitPostingRes(res)) {
              robeMeta[nome] = robeMeta[nome] || {};
              robeMeta[nome].limitPostingThisRun = Date.now();
              robeMeta[nome].pauseReason = 'limit_posting';
              robeUpdateMeta(nome, { estado: 'paused_limit', cooldownSec: await normalizeCooldown(nome), emExecucao: false });
              await issues.append(nome, 'mil_action', 'limit_posting_guard: cycle aborted and locked to 24h (robe-play)');
              try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
              return;
            }

            if (res && res.ok) {
              try {
                await manifestStore.update(nome, (m) => {
                  m = m || {};
                  m.ultimaPostagemRobe = Date.now();
                  return m;
                });
              } catch {}
              const last = await robeLastPosted(nome);
              robeUpdateMeta(nome, {
                estado: 'ok',
                cooldownSec: await normalizeCooldown(nome),
                proximaPostagem: last + ((15+Math.floor(Math.random()*16))*60*1000),
                ultimaPostagem: Date.now()
              });
              try { await reportAction(nome, 'robe_success', 'Robe finalizado com sucesso (robe-play)'); } catch {}
              try { logger.info('[WORKER][robe-play] Robe success', { nome }); } catch {}
            } else {
              robeUpdateMeta(nome, {
                estado: 'idle',
                cooldownSec: await normalizeCooldown(nome)
              });
            }
          } catch (e) {
            robeUpdateMeta(nome, { estado: 'erro', cooldownSec: await normalizeCooldown(nome) });
          } finally {
            try { if (ctrl && ctrl.browser) delete ctrl.browser._robeActiveFor; } catch {}
            if (robeMeta[nome] && robeMeta[nome].limitPostingThisRun) {
              await issues.append(nome, 'mil_action', 'robe_end_limit_posting');
              delete robeMeta[nome].limitPostingThisRun;
              try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}
              robeUpdateMeta(nome, { emExecucao: false });
              if (virtusWasRunning && automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
                  ctrl.trabalhando = true;
                  await issues.append(nome, 'mil_action', 'virtus_restarted_after_limit_posting');
                } catch {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              }
              await snapshotStatusAndWrite();
              return;
            }
            try { await closeExtraPages(ctrl.browser, ctrl.mainPage, nome); } catch {}

            robeUpdateMeta(nome, { emExecucao: false });

            if (virtusWasRunning) {
              if (automationAllowed(ctrl)) {
                try {
                  ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, { restrictTab: 0, epoch: ctrl.virtusEpoch || 0, slowMode: (autoMode && autoMode.mode !== 'full'), governorMode: (autoMode && autoMode.mode) || 'full' });
                  ctrl.trabalhando = true;
                } catch (e) {
                  ctrl.virtus = null;
                  ctrl.trabalhando = false;
                }
              } else {
                ctrl.virtus = null;
                ctrl.trabalhando = false;
              }
              await snapshotStatusAndWrite();
            } else {
              await snapshotStatusAndWrite();
            }

            try { await reportAction(nome, 'robe_end', 'Robe ciclo finalizado (robe-play)'); } catch {}
            try { logger.info('[WORKER][robe-play] Robe end', { nome }); } catch {}
          }
        });
        await snapshotStatusAndWrite();
      } else {
        // #region agent log
        try { provisionAudit.append({ ts: Date.now(), event: 'dbg_worker_robe_play_skip_already_queued_or_active', nome: String(nome || ''), inQueue: !!robeQueue.inQueue(nome), isActive: !!robeQueue.isActive(nome) }); } catch {}
        // #endregion
      }
      logger.info('[HANDLER] robe-play ok', { nome });
      return { ok: true };
    });
  },

  async ['robes-release-all']() {
    logger.info('[HANDLER] robes-release-all chamada');
    const perfisArr = loadPerfisJson();
    for (const p of perfisArr) {
      try {
        robeMeta[p.nome] = robeMeta[p.nome] || {};
        delete robeMeta[p.nome].pauseReason;
        delete robeMeta[p.nome].lastRobeBlockAt;
        await manifestStore.update(p.nome, m => {
          m = m || {};
          if (m.robePauseReason) delete m.robePauseReason;
          return m;
        });
      } catch {}
    }
    await snapshotStatusAndWrite();
    logger.info('[HANDLER] robes-release-all ok');
    return { ok: true };
  },

  // ====== HANDLER apply-city - aplica coordenadas da nova cidade em runtime ======
  async ['apply-city']({ nome }) {
    return lockProfileAction(nome, async () => {
      const ctrl = controllers.get(nome);

      // Se navegador não está ativo para este perfil, não há o que aplicar!
      if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) {
        await issues.append(nome, 'mil_action', 'apply_city_runtime_skip_not_active');

        return { ok: true, active: false };
      }

      try {
        const man = await manifestStore.read(nome).catch(()=>null);
        let coords = null;
        try {
          coords = browserHelper.resolvePatchCoordsForProfile(nome, man || {});
        } catch (eGeo) {
          const mGeo = (eGeo && eGeo.message) ? String(eGeo.message) : String(eGeo || '');
          await issues.append(nome, 'mil_action', `apply_city_skip ${mGeo.slice(0, 180)}`);
          return { ok: false, error: mGeo || 'coords_unavailable' };
        }
        if (!coords || !coords.latitude || !coords.longitude) {
          await issues.append(nome, 'mil_action', 'apply_city_skip coords_unavailable');
          return { ok: false, error: 'coords_unavailable' };
        }

        const pages = await ctrl.browser.pages().catch(()=>[]);
        let applied = 0;

        for (const p of (pages||[])) {
          try { await p.setGeolocation(coords); applied++; } catch {}
        }

        await issues.append(nome, 'mil_action', `apply_city_runtime_ok pages=${applied}`);

        // Optionally: update status snapshot
        try { await snapshotStatusAndWrite(); } catch {}

        return { ok: true, appliedPages: applied, cidade };

      } catch (e) {
        await issues.append(nome, 'mil_action', `apply_city_runtime_error ${(e&&e.message)||e}`);

        return { ok: false, error: (e && e.message) || String(e) };
      }
    });
  },

  async ['get-status']() {
    try {
      for (const n of Object.keys(robeMeta)) {
        const m = robeMeta[n];
        if (!m) continue;
        if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
        while (m.cpuHistory.length > 8) m.cpuHistory.shift();
        if (!Array.isArray(m.ramHist)) m.ramHist = [];
        while (m.ramHist.length > 8) m.ramHist.shift();
        if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
        while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
        if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
        while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
      }
    } catch {}

    const perfisArr = loadPerfisJson();
    const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
    const perfis = [];
    for (const p of perfisArr) {
      const nome = p.nome;
      let issuesCount = 0;
      try {
        if (issues && typeof issues.countErrors === 'function') {
          const res = issues.countErrors(nome);
          issuesCount = Number(res && res.count) || 0;
        } else {
          issuesCount = countErrorsLocal(nome);
        }
      } catch { issuesCount = 0; }
      const fail = getFailureCounts(nome);
      let manifestStatus = await computeManifestStatus(nome);
      const man = await manifestStore.read(nome).catch(()=>null);
      const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
      const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
      const loginSource = man ? ((man.accountFlags && man.accountFlags.loginSource) || null) : (robeMeta[nome]?.loginSource || null);
      const loginRemediateFailed = man ? !!(man.accountFlags && man.accountFlags.loginRemediateFailed === true) : !!robeMeta[nome]?.loginRemediateFailed;
      const loginRemediateFailedAt = man ? ((man.accountFlags && man.accountFlags.loginRemediateFailedAt) || null) : null;
      const loginRemediateFailedReason = man ? ((man.accountFlags && man.accountFlags.loginRemediateFailedReason) || null) : (robeMeta[nome]?.loginRemediateFailedReason || null);
      const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
      const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
      const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
      const twoFactor = man ? !!(man.accountFlags && man.accountFlags.twoFactor === true) : !!robeMeta[nome]?.twoFactor;
      const twoFactorAt = man ? ((man.accountFlags && man.accountFlags.twoFactorAt) || null) : null;
      const twoFactorReason = man ? ((man.accountFlags && man.accountFlags.twoFactorReason) || null) : null;
      const twoFactorText = man ? ((man.accountFlags && man.accountFlags.twoFactorText) || null) : null;
      const identityRequired = man ? !!(man.accountFlags && man.accountFlags.identityRequired === true) : false;
      const identitySubmitted = man ? !!(man.accountFlags && man.accountFlags.identitySubmitted === true) : false;
      const identityNextCheckAt = man ? ((man.accountFlags && man.accountFlags.identityNextCheckAt) || null) : null;
      const appealSubmitted = man ? !!(man.accountFlags && man.accountFlags.appealSubmitted === true) : !!robeMeta[nome]?.appealSubmitted;
      const appealSubmittedAt = man ? ((man.accountFlags && man.accountFlags.appealSubmittedAt) || null) : null;
      const appealNextCheckAt = man ? ((man.accountFlags && man.accountFlags.appealNextCheckAt) || null) : null;
      const appealLastCheckAt = man ? ((man.accountFlags && man.accountFlags.appealLastCheckAt) || null) : null;
      const appealLastReason = man ? ((man.accountFlags && man.accountFlags.appealLastReason) || null) : null;
      const messengerPin = man ? !!(man.accountFlags && man.accountFlags.messengerPin === true) : !!robeMeta[nome]?.messengerPin;
      const messengerPinReason = man ? ((man.accountFlags && man.accountFlags.messengerPinReason) || null) : null;
      const problem = man
        ? !!(
          (man.accountFlags && man.accountFlags.loginRequired === true) ||
          (man.accountFlags && man.accountFlags.banned === true) ||
          (man.accountFlags && man.accountFlags.twoFactor === true) ||
          (man.accountFlags && man.accountFlags.identityRequired === true) ||
          (man.accountFlags && man.accountFlags.identitySubmitted === true) ||
          (man.accountFlags && man.accountFlags.messengerPin === true) ||
          (man.accountFlags && man.accountFlags.appealSubmitted === true)
        )
        : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned || (robeMeta[nome] || {}).twoFactor || (robeMeta[nome] || {}).messengerPin || (robeMeta[nome] || {}).appealSubmitted);
      const man0 = await manifestStore.read(nome).catch(()=>null);
      const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';
      const robeDailyPlanSummary = await (async () => {
        try {
          const plan = await getOrCreateRobeDailyPlan(nome, Date.now(), man0);
          return _robeDailyPlanSummary(plan, Date.now());
        } catch {
          return { featureEnabled: false, date: _robeDailyDateYmd(Date.now()), enabled: false, dailyHours: 0, blocksCount: 0, blocks: [], inWindowNow: false, nextWindowStartMin: null, nextWindowLabel: null };
        }
      })();
      const robeSessionSummary = await (async () => {
        try {
          const gate = await getOrCreateRobeSessionGate(nome, Date.now(), null, man0);
          return gate && gate.summary ? gate.summary : { featureEnabled: true, enabled: false, state: 'none', plannedPosts: 0, postedPosts: 0, remainingInAction: 0, pauseUntil: null, nextAtLabel: null };
        } catch {
          return { featureEnabled: true, enabled: false, state: 'none', plannedPosts: 0, postedPosts: 0, remainingInAction: 0, pauseUntil: null, nextAtLabel: null };
        }
      })();

      // Observabilidade enterprise: flags runtime (usadas para pausa/quiescência determinística)
      const ctrl = controllers.get(nome);
      const isActive = !!ctrl;
      const virtusOnline = !!(ctrl && ctrl.virtus);
      const sendLockObj = (ctrl && ctrl.browser && ctrl.browser._sendLock && typeof ctrl.browser._sendLock === 'object')
        ? ctrl.browser._sendLock
        : null;
      const sendLockActive = !!(sendLockObj && sendLockObj.active);
      const sendLockOwner = sendLockObj && sendLockObj.owner ? String(sendLockObj.owner).slice(0, 40) : null;
      const sendLockChatId = sendLockObj && sendLockObj.chatId ? String(sendLockObj.chatId).slice(0, 80) : null;
      const sendLockSince = (sendLockObj && typeof sendLockObj.since === 'number') ? sendLockObj.since : null;
      const sendLockAgeMs = (sendLockSince && sendLockSince > 0) ? Math.max(0, Date.now() - sendLockSince) : null;
      const robeEmExecucao = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);

      perfis.push({
        nome,
        label: p.label || null,
        cidade: p.cidade,
        uaPresetId: p.uaPresetId,
        active: isActive,
        trabalhando: !!(ctrl?.trabalhando),
        virtusOnline,
        sendLockActive,
        sendLockOwner,
        sendLockChatId,
        sendLockSince,
        sendLockAgeMs,
        robeEmExecucao,
        configurando: !!(ctrl?.configurando),
        humanControl: !!(ctrl?.humanControl),
        humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
        issuesCount,
        ramMB: (() => {
          const v = typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null;
          // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
          return v;
        })(),
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        // Evita pill "Abas: N" stale quando o perfil já não tem controller/browser ativo.
        numPages: isActive
          ? (typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null)
          : 0,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
        killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
        reopenAt: robeMeta[nome]?.reopenAt || null,
        manifestStatus,
        closingReason: robeMeta[nome]?.closingReason || null,
        openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
        lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
        loginRequired,
        loginReason,
        loginSource,
        loginRemediateFailed,
        loginRemediateFailedAt,
        loginRemediateFailedReason,
        banned,
        bannedAt,
        bannedText,
        twoFactor,
        twoFactorAt,
        twoFactorReason,
        twoFactorText,
        identityRequired,
        identitySubmitted,
        identityNextCheckAt,
        appealSubmitted,
        appealSubmittedAt,
        appealNextCheckAt,
        appealLastCheckAt,
        appealLastReason,
        messengerPin,
        messengerPinReason,
        problem,
        robeMode,
        robeDailyPlanSummary,
        robeSessionSummary
      });
    }
    const robes = {};
    for (const p of perfisArr) {
      const nome = p.nome;
      const fail = getFailureCounts(nome);
      robes[nome] = {
        cooldownSec: await normalizeCooldown(nome),
        estado: robeMeta[nome]?.estado || '',
        proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
        ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
        emFila: !!robeMeta[nome]?.emFila,
        emExecucao: !!robeMeta[nome]?.emExecucao,
        ramMB: (() => {
          const v = typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null;
          // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
          return v;
        })(),
        cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
        numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
        robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
        frozenReason: robeMeta[nome]?.frozenReason || null,
        frozenAt: robeMeta[nome]?.frozenAt || null,
        frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
        internalFailCountWindow: fail.internal,
        externalFailCountWindow: fail.external,
        unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
        lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
        pauseReason: robeMeta[nome]?.pauseReason || null,
        blockedBy: null,
        lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
      };
      const pauseActive = await (async () => {
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
        } catch { return false; }
      })();
      if (pauseActive) {
        robes[nome].estado = 'paused_limit';
      }
      const man = await manifestStore.read(nome).catch(()=>null);
      if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
        robes[nome].pauseReason = 'limit_posting';
        robes[nome].estado = 'paused_limit';
        await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
      }
      robes[nome].blockedBy = _robeBlockedByFromMeta(robes[nome]);
    }
    const robeQueueList = robeQueue.queueList();
    const sys = {
      freeMB: Math.round(os.freemem()/(1024*1024)),
      totalMB: Math.round(os.totalmem()/(1024*1024)),
      cores: (os.cpus()||[]).length,
      cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length)))
    };
    return {
      perfis,
      robes,
      robeQueue: robeQueueList,
      autoMode,
      sys,
      serverConfig: (() => {
        try { return serverConfig.readServerConfigEffective({ totalMemMB: sys.totalMB }); } catch { return null; }
      })(),
      // Diagnóstico enterprise: ajuda a provar quando o dashboard está “cego” porque não há controllers vivos.
      _debug: {
        pid: process && process.pid ? process.pid : null,
        buildTag: (typeof WORKER_BUILD_TAG === 'string' ? WORKER_BUILD_TAG : null),
        humanOverlayEnabled: (typeof HUMAN_OVERLAY_CFG === 'object' ? !!HUMAN_OVERLAY_CFG.enabled : null),
        shardSize: SHARD_SET ? SHARD_SET.size : null,
        controllersCount: controllers ? controllers.size : null,
        ts: Date.now()
      }
    };
  },

  async unfreeze({ nome, setBy }) {
    return lockProfileAction(nome, async () => {
      if (!nome) return { ok: false, error: 'nome_obrigatorio' };
      try { await unfreezeProfile(nome, setBy || 'admin'); } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
      return { ok: true };
    });
  },

  async ['unfreeze-all']() {
    try {
      const perfisArr = loadPerfisJson();
      for (const p of perfisArr) {
        if (!p || !p.nome) continue;
        try { await unfreezeProfile(p.nome, 'admin_all'); } catch {}
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e && e.message || String(e) }; }
  },

  async ['robe-replan-all']({ reason, operator } = {}) {
    try {
      const perfisArr = loadPerfisJson();
      const nomes = (Array.isArray(perfisArr) ? perfisArr : [])
        .map((p) => String(p && p.nome || '').trim())
        .filter(Boolean);
      let manifestsUpdated = 0;
      let plansRegenerated = 0;
      let sessionsCleared = 0;
      const nowMs = Date.now();
      for (const nome of nomes) {
        try { _robeDailyPlanCache.delete(nome); } catch {}
        try { _robeDailyPlanInFlight.delete(nome); } catch {}
        try { _robeDailyGateState.delete(nome); } catch {}
        try {
          await manifestStore.update(nome, (m) => {
            m = m || {};
            if (m.robeDailyPlanV1) delete m.robeDailyPlanV1;
            if (m.robeBlockSessionV2) {
              delete m.robeBlockSessionV2;
              sessionsCleared += 1;
            }
            return m;
          });
          manifestsUpdated += 1;
        } catch {}
        try {
          const p = await getOrCreateRobeDailyPlan(nome, nowMs).catch(() => null);
          if (p) plansRegenerated += 1;
        } catch {}
      }
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'robe_replan_all_applied_now',
          totalProfiles: nomes.length,
          manifestsUpdated,
          plansRegenerated,
          sessionsCleared,
          reason: String(reason || '').slice(0, 120) || null,
          operator: String(operator || '').slice(0, 120) || null
        });
      } catch {}
      try { await snapshotStatusAndWrite(); } catch {}
      return { ok: true, totalProfiles: nomes.length, manifestsUpdated, plansRegenerated, sessionsCleared };
    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  },

  async ['set-shard']({ names }) {
    try {
      const newSet = new Set(Array.isArray(names) ? names : []);
      const removed = [];
      for (const nome of SHARD_SET) {
        if (!newSet.has(nome)) removed.push(nome);
      }
      SHARD_SET = newSet;

      // Airbag enterprise: nunca derrubar dezenas por "shard move"
      const MAX_SHARD_MOVE_DEACTIVATIONS = Math.max(0, parseInt(process.env.MAX_SHARD_MOVE_DEACTIVATIONS || '2', 10) || 2);
      let deactivatedCount = 0;

      for (const nome of removed) {
        const ctrl = controllers.get(nome);
        const rm = robeMeta[nome] || {};
        const robeRunning = rm.emExecucao === true || (ctrl && ctrl.browser && ctrl.browser._robeActiveFor === nome);
        const busy = robeRunning || (ctrl && (ctrl.configurando === true || ctrl.humanControl === true));

        if (busy) {
          robeMeta[nome] = rm;
          rm.pendingShardMove = true;
          rm.deferShardMoveUntil = Date.now() + 10*60*1000;
          await issues.append(nome, 'mil_action', 'shard_move_deferred (busy)');
          continue;
        }

        // Se passar do limite, adiar o resto (evita storm)
        if (deactivatedCount >= MAX_SHARD_MOVE_DEACTIVATIONS) {
          robeMeta[nome] = rm;
          rm.pendingShardMove = true;
          rm.deferShardMoveUntil = Date.now() + 15*60*1000;
          await issues.append(nome, 'mil_action', `shard_move_deferred (cap max=${MAX_SHARD_MOVE_DEACTIVATIONS})`);
          continue;
        }

        try { robeQueue.skip && robeQueue.skip(nome); } catch {}
        try {
          if (ctrl && ctrl.browser) {
            await handlers.deactivate({ nome, reason: 'shard_moved', policy: 'preserveDesired' });
            deactivatedCount++;
          }
        } catch {}
        controllers.delete(nome);
        try { healthState.delete(nome); } catch {}
        try { profileFailures.delete(nome); } catch {}
        if (robeMeta[nome]) {
          delete robeMeta[nome].emExecucao;
          delete robeMeta[nome].emFila;
          delete robeMeta[nome].cpuHistory;
          delete robeMeta[nome].ramHist;
          delete robeMeta[nome].reloadAttemptsWindow;
          delete robeMeta[nome].blockDetectWindow;
        }
      }
      await snapshotStatusAndWrite();
      return { ok: true, size: SHARD_SET.size, removed, deactivatedCount, maxDeactivations: MAX_SHARD_MOVE_DEACTIVATIONS };

    } catch (e) {
      return { ok: false, error: e && e.message || String(e) };
    }
  }
};

async function snapshotStatusAndWrite() {
_statusLock = _statusLock.then(async () => {
try {
try {
  for (const n of Object.keys(robeMeta)) {
    const m = robeMeta[n];
    if (!m) continue;
    if (!Array.isArray(m.cpuHistory)) m.cpuHistory = [];
    while (m.cpuHistory.length > 8) m.cpuHistory.shift();
    if (!Array.isArray(m.ramHist)) m.ramHist = [];
    while (m.ramHist.length > 8) m.ramHist.shift();
    if (!Array.isArray(m.reloadAttemptsWindow)) m.reloadAttemptsWindow = [];
    while (m.reloadAttemptsWindow.length > 8) m.reloadAttemptsWindow.shift();
    if (!Array.isArray(m.blockDetectWindow)) m.blockDetectWindow = [];
    while (m.blockDetectWindow.length > 8) m.blockDetectWindow.shift();
  }
} catch {}

const perfisArr = loadPerfisJson();
const desiredSnap = readJsonFile(desiredPath, { perfis: {} });
const perfis = [];
// #region agent log
// Forense enterprise: detectar e registrar (via provision_audit) quedas de working/Virtus inesperadas,
// sem depender do CT "poke" e sem spam (rate-limit).
let _anomalyTs = Date.now();
// #endregion
for (const p of perfisArr) {
const nome = p.nome;
let issuesCount = 0;
try {
  if (issues && typeof issues.countErrors === 'function') {
    const res = issues.countErrors(nome);
    issuesCount = Number(res && res.count) || 0;
  } else {
    issuesCount = countErrorsLocal(nome);
  }
} catch {}
const fail = getFailureCounts(nome);
let manifestStatus = await computeManifestStatus(nome);
const man = await manifestStore.read(nome).catch(()=>null);
const loginRequired = man ? !!(man.accountFlags && man.accountFlags.loginRequired === true) : !!robeMeta[nome]?.loginRequired;
const loginReason = man ? ((man.accountFlags && man.accountFlags.loginReason) || null) : (robeMeta[nome]?.loginReason || null);
const loginSource = man ? ((man.accountFlags && man.accountFlags.loginSource) || null) : (robeMeta[nome]?.loginSource || null);
const banned = man ? !!(man.accountFlags && man.accountFlags.banned === true) : !!robeMeta[nome]?.banned;
const bannedAt = man ? ((man.accountFlags && man.accountFlags.bannedAt) || null) : null;
const bannedText = man ? ((man.accountFlags && man.accountFlags.bannedText) || null) : null;
const identityRequired = man ? !!(man.accountFlags && man.accountFlags.identityRequired === true) : false;
const identitySubmitted = man ? !!(man.accountFlags && man.accountFlags.identitySubmitted === true) : false;
const identityNextCheckAt = man ? ((man.accountFlags && man.accountFlags.identityNextCheckAt) || null) : null;
const appealSubmitted = man ? !!(man.accountFlags && man.accountFlags.appealSubmitted === true) : !!robeMeta[nome]?.appealSubmitted;
const loginRemediateFailed = man ? !!(man.accountFlags && man.accountFlags.loginRemediateFailed === true) : !!robeMeta[nome]?.loginRemediateFailed;
const appealSubmittedAt = man ? ((man.accountFlags && man.accountFlags.appealSubmittedAt) || null) : null;
const appealNextCheckAt = man ? ((man.accountFlags && man.accountFlags.appealNextCheckAt) || null) : null;
const appealLastCheckAt = man ? ((man.accountFlags && man.accountFlags.appealLastCheckAt) || null) : null;
const appealLastReason = man ? ((man.accountFlags && man.accountFlags.appealLastReason) || null) : null;
const messengerPin = man ? !!(man.accountFlags && man.accountFlags.messengerPin === true) : !!robeMeta[nome]?.messengerPin;
const messengerPinReason = man ? ((man.accountFlags && man.accountFlags.messengerPinReason) || null) : null;
const problem = man
  ? !!(
    (man.accountFlags && man.accountFlags.loginRequired === true) ||
    (man.accountFlags && man.accountFlags.banned === true) ||
    (man.accountFlags && man.accountFlags.identityRequired === true) ||
    (man.accountFlags && man.accountFlags.identitySubmitted === true) ||
    (man.accountFlags && man.accountFlags.messengerPin === true) ||
    (man.accountFlags && man.accountFlags.appealSubmitted === true)
  )
  : !!((robeMeta[nome] || {}).loginRequired || (robeMeta[nome] || {}).banned || (robeMeta[nome] || {}).messengerPin || (robeMeta[nome] || {}).appealSubmitted);
const man0 = await manifestStore.read(nome).catch(()=>null);
const robeMode = (man0 && man0.robeMode) ? String(man0.robeMode) : 'itens';
// Estoque (CT): vínculo determinístico do perfil do servidor com a conta do estoque.
// Importante: NÃO expõe cookies/senha — só o ID (para o CT conseguir mapear mesmo quando cookie_fp ainda não foi calculado).
const stockAccountId = (() => {
  try {
    const sid = Number((man0 && (man0.stockAccountId || man0.stock_account_id)) ? (man0.stockAccountId || man0.stock_account_id) : 0) || 0;
    return sid > 0 ? sid : null;
  } catch { return null; }
})();
const robeDailyPlanSummary = await (async () => {
  try {
    const plan = await getOrCreateRobeDailyPlan(nome, Date.now(), man0);
    return _robeDailyPlanSummary(plan, Date.now());
  } catch {
    return { featureEnabled: false, date: _robeDailyDateYmd(Date.now()), enabled: false, dailyHours: 0, blocksCount: 0, blocks: [], inWindowNow: false, nextWindowStartMin: null, nextWindowLabel: null };
  }
})();
const robeSessionSummary = await (async () => {
  try {
    const gate = await getOrCreateRobeSessionGate(nome, Date.now(), null, man0);
    return gate && gate.summary ? gate.summary : { featureEnabled: true, enabled: false, state: 'none', plannedPosts: 0, postedPosts: 0, remainingInAction: 0, pauseUntil: null, nextAtLabel: null };
  } catch {
    return { featureEnabled: true, enabled: false, state: 'none', plannedPosts: 0, postedPosts: 0, remainingInAction: 0, pauseUntil: null, nextAtLabel: null };
  }
})();

perfis.push({
  nome,
  label: p.label || null,
  cidade: p.cidade,
  uaPresetId: p.uaPresetId,
  active: controllers.has(nome),
  trabalhando: !!(controllers.get(nome)?.trabalhando),
  // Observabilidade enterprise (p/ pausas determinísticas durante provisionamento)
  virtusOnline: !!(controllers.get(nome)?.virtus),
  sendLockActive: !!(controllers.get(nome)?.browser && controllers.get(nome).browser._sendLock && controllers.get(nome).browser._sendLock.active),
  robeEmExecucao: !!(robeMeta[nome]?.emExecucao),
  configurando: !!(controllers.get(nome)?.configurando),
  humanControl: !!(controllers.get(nome)?.humanControl),
  humanHold: !!(desiredSnap.perfis && desiredSnap.perfis[nome] && desiredSnap.perfis[nome].humanHold === true),
  issuesCount,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  activationHeldUntil: robeMeta[nome]?.activationHeldUntil || null,
  killGuardUntil: robeMeta[nome]?.killGuardUntil || null,
  reopenAt: robeMeta[nome]?.reopenAt || null,
  manifestStatus,
  closingReason: robeMeta[nome]?.closingReason || null,
  openBackoffMs: robeMeta[nome]?.openBackoffMs || null,
  lastSwapAt: robeMeta[nome]?.lastSwapAt || null,
  loginRequired,
  loginReason,
  loginSource,
  banned,
  bannedAt,
  bannedText,
  identityRequired,
  identitySubmitted,
  identityNextCheckAt,
  appealSubmitted,
  appealSubmittedAt,
  appealNextCheckAt,
  appealLastCheckAt,
  appealLastReason,
  loginRemediateFailed,
  messengerPin,
  messengerPinReason,
  problem,
  robeMode,
  stockAccountId,
  robeDailyPlanSummary,
  robeSessionSummary
});
}

// #region agent log
try {
  // Anomalia de massa: muitos perfis "ativos" porém não trabalhando.
  // Critério: captura quedas relevantes também em hosts menores, sem spammar.
  if (!global.__ANOMALY_WORKING_LAST_AT) global.__ANOMALY_WORKING_LAST_AT = 0;
  if (!global.__ANOMALY_PROFILE_LAST_AT) global.__ANOMALY_PROFILE_LAST_AT = new Map();

  const activeArr = perfis.filter(x => x && x.active === true);
  const workingArr = activeArr.filter(x => x.trabalhando === true);
  const virtusArr = activeArr.filter(x => x.virtusOnline === true);
  const deficit = activeArr.length - workingArr.length;

  const massMinActive = 10;
  const massMinDeficitAbs = 6;
  const massMinDeficitRatio = 0.30; // 30%+ de queda (ex.: 32->16)
  const shouldEmitMass =
    (activeArr.length >= massMinActive) &&
    (
      deficit >= massMinDeficitAbs ||
      (activeArr.length > 0 && (deficit / activeArr.length) >= massMinDeficitRatio)
    );
  const now = Date.now();
  if (shouldEmitMass && (now - Number(global.__ANOMALY_WORKING_LAST_AT || 0)) >= 60_000) {
    global.__ANOMALY_WORKING_LAST_AT = now;
    const dmap = (desiredSnap && desiredSnap.perfis && typeof desiredSnap.perfis === 'object') ? desiredSnap.perfis : {};
    const suspects = activeArr
      .filter(x =>
        x.trabalhando !== true &&
        x.virtusOnline !== true &&
        // "deveria trabalhar": desired ativo + virtus on e sem flags de bloqueio óbvias
        dmap[x.nome] && dmap[x.nome].active === true && String(dmap[x.nome].virtus || '') === 'on' &&
        x.loginRequired !== true &&
        x.identityRequired !== true &&
        x.appealSubmitted !== true &&
        x.humanControl !== true &&
        x.humanHold !== true
      )
      .slice(0, 12)
      .map(x => ({
        nome: x.nome,
        // sem PII: não incluir label/login
        virtusOnline: x.virtusOnline === true,
        trabalhando: x.trabalhando === true,
        loginRequired: x.loginRequired === true,
        loginReason: x.loginReason || null,
        identityRequired: x.identityRequired === true,
        appealSubmitted: x.appealSubmitted === true,
        humanControl: x.humanControl === true,
        humanHold: x.humanHold === true,
        sendLockActive: x.sendLockActive === true,
        configurando: x.configurando === true,
        robeEmExecucao: x.robeEmExecucao === true,
        manifestStatus: x.manifestStatus || null,
        openBackoffMs: x.openBackoffMs || null,
        closingReason: x.closingReason || null,
        desired: dmap[x.nome] ? { active: !!dmap[x.nome].active, virtus: String(dmap[x.nome].virtus || '') } : null
      }));
    try {
      provisionAudit.append({
        ts: now,
        event: 'anomaly_working_low',
        active: activeArr.length,
        working: workingArr.length,
        virtusOnline: virtusArr.length,
        deficit,
        suspects
      });
    } catch {}
  }

  // Anomalia por perfil: "Browser ativo" mas Virtus offline e deveria estar trabalhando.
  // Rate-limit por perfil: 15 min.
  const dmap = (desiredSnap && desiredSnap.perfis && typeof desiredSnap.perfis === 'object') ? desiredSnap.perfis : {};
  for (const x of activeArr) {
    if (!x || x.trabalhando === true) continue;
    if (x.virtusOnline === true) continue;
    const d = dmap[x.nome];
    if (!d || d.active !== true || String(d.virtus || '') !== 'on') continue;
    if (x.loginRequired === true || x.identityRequired === true || x.appealSubmitted === true) continue;
    if (x.humanControl === true || x.humanHold === true) continue;
    const last = global.__ANOMALY_PROFILE_LAST_AT.get(x.nome) || 0;
    if ((now - Number(last || 0)) < (15 * 60 * 1000)) continue;
    global.__ANOMALY_PROFILE_LAST_AT.set(x.nome, now);
    const ctrl = controllers.get(x.nome);
    const browserConnected = !!(ctrl && ctrl.browser && typeof ctrl.browser.isConnected === 'function' && ctrl.browser.isConnected());
    try {
      provisionAudit.append({
        ts: now,
        event: 'anomaly_profile_should_work_but_not',
        nome: x.nome,
        browserConnected,
        ctrlHasVirtus: !!(ctrl && ctrl.virtus),
        ctrlTrabalhando: !!(ctrl && ctrl.trabalhando),
        flags: {
          loginRequired: x.loginRequired === true,
          loginReason: x.loginReason || null,
          identityRequired: x.identityRequired === true,
          appealSubmitted: x.appealSubmitted === true,
          humanControl: x.humanControl === true,
          humanHold: x.humanHold === true,
          sendLockActive: x.sendLockActive === true,
          configurando: x.configurando === true,
          robeEmExecucao: x.robeEmExecucao === true
        },
        manifestStatus: x.manifestStatus || null,
        openBackoffMs: x.openBackoffMs || null,
        closingReason: x.closingReason || null,
        desired: { active: !!d.active, virtus: String(d.virtus || '') }
      });
    } catch {}
  }
} catch {}
// #endregion

const robes = {};
for (const p of perfisArr) {
const nome = p.nome;
const fail = getFailureCounts(nome);
robes[nome] = {
  cooldownSec: await normalizeCooldown(nome),
  estado: robeMeta[nome]?.estado || '',
  proximaPostagem: robeMeta[nome]?.proximaPostagem || null,
  ultimaPostagem: robeMeta[nome]?.ultimaPostagem || null,
  emFila: !!robeMeta[nome]?.emFila,
  emExecucao: !!robeMeta[nome]?.emExecucao,
  ramMB: typeof robeMeta[nome]?.ramMB === "number" ? robeMeta[nome].ramMB : null,
  cpuPercent: typeof robeMeta[nome]?.cpuPercent === "number" ? robeMeta[nome].cpuPercent : null,
  numPages: typeof robeMeta[nome]?.numPages === "number" ? robeMeta[nome].numPages : null,
  robeFrozenUntil: robeMeta[nome]?.frozenUntil || null,
  frozenReason: robeMeta[nome]?.frozenReason || null,
  frozenAt: robeMeta[nome]?.frozenAt || null,
  frozenSetBy: robeMeta[nome]?.frozenSetBy || null,
  unfreezeCount: robeMeta[nome]?.unfreezeCount || 0,
  lastUnfreezeAt: robeMeta[nome]?.lastUnfreezeAt || null,
  pauseReason: robeMeta[nome]?.pauseReason || null,
  blockedBy: null,
  lastRobeBlockAt: robeMeta[nome]?.lastRobeBlockAt || null
};
try {
  if (robes[nome].cooldownSec === 0) {
    await releaseLimitPostingIfExpired(nome);
  }
} catch {}
if (robes[nome].cooldownSec === 0 && robeMeta[nome] && robeMeta[nome].pauseReason === 'fb_block') {
  const ts = robeMeta[nome].lastRobeBlockAt || 0;
  if (ts && (Date.now() - ts) > 25*60*60*1000) {
    delete robeMeta[nome].pauseReason;
    delete robeMeta[nome].lastRobeBlockAt;
  }
}
const pauseActive = await (async () => {
  try {
    const man = await manifestStore.read(nome).catch(()=>null);
    return !!(man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now());
  } catch { return false; }
})();
if (pauseActive) {
  robes[nome].estado = 'paused_limit';
  robes[nome].pauseReason = 'limit_posting';
  await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
}
robes[nome].blockedBy = _robeBlockedByFromMeta(robes[nome]);
}
const robeQueueList = robeQueue.queueList();
const _nodeMu = (() => { try { return process.memoryUsage(); } catch { return null; } })();
const _nodeRssMB = (_nodeMu && Number.isFinite(Number(_nodeMu.rss))) ? Math.round(Number(_nodeMu.rss) / (1024 * 1024)) : null;
const _nodeHeapUsedMB = (_nodeMu && Number.isFinite(Number(_nodeMu.heapUsed))) ? Math.round(Number(_nodeMu.heapUsed) / (1024 * 1024)) : null;
const _nodeExternalMB = (_nodeMu && Number.isFinite(Number(_nodeMu.external))) ? Math.round(Number(_nodeMu.external) / (1024 * 1024)) : null;
const _nodeArrayBuffersMB = (_nodeMu && Number.isFinite(Number(_nodeMu.arrayBuffers))) ? Math.round(Number(_nodeMu.arrayBuffers) / (1024 * 1024)) : null;
const _profileRamMBLocal = perfis.reduce((acc, p) => {
  const v = Number(p && p.ramMB);
  return Number.isFinite(v) ? (acc + v) : acc;
}, 0);
const _freeMB = Math.round(os.freemem()/(1024*1024));
const _totalMB = Math.round(os.totalmem()/(1024*1024));
const _usedMB = (Number.isFinite(_totalMB) && Number.isFinite(_freeMB)) ? (_totalMB - _freeMB) : null;
const _residualMBLocal =
  (Number.isFinite(_usedMB) && Number.isFinite(_profileRamMBLocal) && Number.isFinite(_nodeRssMB))
    ? (_usedMB - _profileRamMBLocal - _nodeRssMB)
    : null;
const sys = {
  freeMB: _freeMB,
  totalMB: _totalMB,
  usedMB: _usedMB,
  cores: (os.cpus()||[]).length,
  cpuApprox: Math.min(100, Math.round(Object.values(robeMeta).reduce((acc, m) => acc + (typeof m.cpuPercent==='number' ? m.cpuPercent : 0), 0) / Math.max(1,(os.cpus()||[]).length))),
  workerPid: process.pid,
  nodeRssMB: _nodeRssMB,
  nodeHeapUsedMB: _nodeHeapUsedMB,
  nodeExternalMB: _nodeExternalMB,
  nodeArrayBuffersMB: _nodeArrayBuffersMB,
  profileRamMBLocal: _profileRamMBLocal,
  residualMBLocal: _residualMBLocal,
  ramDiagLast: _ramDiagLast
};
const statusObj = {
  perfis,
  robes,
  robeQueue: robeQueueList,
  autoMode,
  sys,
  serverConfig: (() => {
    try { return serverConfig.readServerConfigEffective({ totalMemMB: sys.totalMB }); } catch { return null; }
  })(),
  build: (typeof buildStatusSnap === 'function' ? buildStatusSnap() : null),
  ts: Date.now()
};

// LOGS DE DIAGNÓSTICO DA RAM — somente quando estiver null/undefined
try {
  // Logs removidos para evitar poluição do terminal (ramMB null é normal para perfis inativos)
  // for (const ent of perfis) {
  //   if (!(typeof ent.ramMB === 'number')) {
  //     logger.warn('[STATUS-WRITE] ramMB é null/undefined', { nome: ent.nome, ramMB: ent.ramMB, hasRobeMeta: !!robeMeta[ent.nome] });
  //   }
  // }
} catch {}

const ok = writeJsonAtomic(statusPath, statusObj);
if (!ok) { try { await issues.append('system','persist_failed', 'status_write'); } catch {} }
} catch (e) {
try { logger.warn('[WORKER][statusWrite] erro', { error: e && e.message || e }); } catch {}
}
});
try { supervisorClient.sendTelemetria({ type: 'hb', alive: controllers.size }); } catch {}
return _statusLock;
}

async function appendIssueNurseDebounced(nome, type, message, key) {
  if (!nome) return;
  robeMeta[nome] = robeMeta[nome] || {};
  robeMeta[nome].nurseLogDebounce = robeMeta[nome].nurseLogDebounce || {};
  const k = key || type;
  const last = robeMeta[nome].nurseLogDebounce[k] || 0;
  if (Date.now() - last < 60000) return;
  robeMeta[nome].nurseLogDebounce[k] = Date.now();
  await issues.append(nome, type, message);
}

const NURSE_CFG = {
  INTERVAL_MS: 5000,
  PAGE_EVAL_TIMEOUT_MS: 5000
};

const MAX_OPEN_CONCURRENCY = 1;
let slotsInUse = 0;
const OPEN_ACTIVATION_DELAY_MS = parseInt(process.env.OPEN_ACTIVATION_DELAY_MS || '1200', 10);

const ULTRA_RECOVERY = {
  MAX_RELOADS: 2,
  RELOAD_TIMEOUT_MS: 10000,
  RELOAD_POST_WAIT_MS: 250,
  REOPEN_DELAY_SHORT_MS: 5000, // NOVO: Reduzido de 60s para 5s (reabertura quase imediata, supervisor controla velocidade)
  REOPEN_DELAY_RAMCPU_MS: 60000,
  FAIL_WINDOW_MS: 3*60*60*1000,
  FAIL_FREEZE_AFTER: 5,
  FAIL_FREEZE_MS: 2*60*60*1000,
  REOPEN_DELAY_VIRTUS_BLOCK_MS: 2*60*60*1000
};

const CDP_RECONNECT_CFG = {
  enabled: String(process.env.CDP_RECONNECT_ENABLED || '1').trim() !== '0',
  attempts: Math.max(1, Math.min(5, Number(process.env.CDP_RECONNECT_ATTEMPTS || 3) || 3)),
  delaysMs: [2000, 5000, 10000]
};

function _envMs(name, fallback) {
  return Math.max(0, Number(process.env[name] || fallback) || fallback);
}

function getControlledReopenDelayMs(reason = '') {
  const r = String(reason || '').toLowerCase();
  const controlled = String(process.env.CONTROLLED_REOPEN_ENABLED || '1').trim() !== '0';
  if (!controlled) return ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
  if (r === 'ramkill' || r === 'cpukill') return ULTRA_RECOVERY.REOPEN_DELAY_RAMCPU_MS + Math.floor(Math.random() * 120000);
  if (r === 'virtus_block') return ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
  const minMs = _envMs('REOPEN_NON_RAM_MIN_MS', 5 * 60 * 1000);
  const maxMs = Math.max(minMs, _envMs('REOPEN_NON_RAM_MAX_MS', 15 * 60 * 1000));
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

function shouldCloseAfterLoginRemediateSuccess(opts = {}) {
  const hasExplicit = (
    Object.prototype.hasOwnProperty.call(opts, 'closeAfterSuccess') ||
    Object.prototype.hasOwnProperty.call(opts, 'stayOpenAfterSuccess')
  );
  if (hasExplicit) {
    if (Object.prototype.hasOwnProperty.call(opts, 'stayOpenAfterSuccess')) {
      const stay = (opts.stayOpenAfterSuccess === true || opts.stayOpenAfterSuccess === 1 || String(opts.stayOpenAfterSuccess || '').toLowerCase() === 'true');
      return !stay;
    }
    return !(opts.closeAfterSuccess === false || opts.closeAfterSuccess === 0 || String(opts.closeAfterSuccess || '').toLowerCase() === 'false');
  }
  const stayOpenDefault = String(process.env.LOGIN_REMEDIATE_STAY_OPEN_AFTER_SUCCESS || '1').trim() !== '0';
  return !stayOpenDefault;
}

async function tryReconnectAfterDisconnected(nome, prevCtrl) {
  const startedAt = Date.now();
  const flowId = newFlowId('reconnect');
  if (!CDP_RECONNECT_CFG.enabled) return { ok: false, reason: 'disabled', flowId };
  const wsEndpoint = (
    (robeMeta[nome] && typeof robeMeta[nome].wsEndpoint === 'string' && robeMeta[nome].wsEndpoint) ||
    (prevCtrl && prevCtrl.browser && typeof prevCtrl.browser.wsEndpoint === 'function' ? String(prevCtrl.browser.wsEndpoint() || '') : '')
  );
  if (!wsEndpoint) return { ok: false, reason: 'missing_ws_endpoint', flowId };

  const rootPid = (robeMeta[nome] && robeMeta[nome].rootPid) || null;
  if (rootPid && !isPidAlive(rootPid)) {
    return { ok: false, reason: 'root_pid_not_alive', flowId, rootPid };
  }

  for (let attempt = 1; attempt <= CDP_RECONNECT_CFG.attempts; attempt++) {
    const delayMs = CDP_RECONNECT_CFG.delaysMs[Math.min(CDP_RECONNECT_CFG.delaysMs.length - 1, Math.max(0, attempt - 1))];
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'reconnect_attempt',
        nome: String(nome || ''),
        flowId,
        attempt,
        wsPresent: true,
        rootPid: rootPid || null,
        pidAlive: rootPid ? isPidAlive(rootPid) : null
      });
    } catch {}
    try {
      const b = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null,
        protocolTimeout: 60000
      });
      if (b && b.isConnected && b.isConnected()) {
        const pages = await b.pages().catch(() => []);
        const current = controllers.get(nome);
        const nextCtrl = Object.assign({}, (current || prevCtrl || {}), { browser: b });
        controllers.set(nome, nextCtrl);
        try { attachBrowserLifecycle(nome, b); } catch {}
        try {
          if (pages && pages[0]) {
            nextCtrl.mainPage = pages[0];
            await wirePageObservers(nome, nextCtrl.mainPage).catch(() => {});
            maybeStartPruneLoop(nome, nextCtrl.browser, nextCtrl.mainPage);
          }
        } catch {}
        try { await snapshotStatusAndWrite(); } catch {}
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'reconnect_success',
            nome: String(nome || ''),
            flowId,
            attempt,
            pagesCount: Array.isArray(pages) ? pages.length : null,
            durationMs: Date.now() - startedAt
          });
        } catch {}
        return { ok: true, flowId, attempt, pagesCount: Array.isArray(pages) ? pages.length : null };
      }
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : String(e);
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'reconnect_fail',
          nome: String(nome || ''),
          flowId,
          attempt,
          error: msg.slice(0, 200),
          rootPid: rootPid || null,
          pidAliveAfter: rootPid ? isPidAlive(rootPid) : null
        });
      } catch {}
    }
    if (attempt < CDP_RECONNECT_CFG.attempts) await sleep(delayMs);
  }
  return { ok: false, reason: 'exhausted', flowId, durationMs: Date.now() - startedAt };
}

async function ensureFrozenShutdown(nome, origin = 'frozen') {
  const ctrl = controllers.get(nome);
  if (!ctrl) return;
  try { robeQueue.skip && robeQueue.skip(nome); } catch {}
  try { await reportAction(nome, 'mil_action', 'frozen_kill'); } catch {}
  try {
    await handlers.deactivate({ nome, reason: 'frozen', policy: 'preserveDesired' });
  } catch {}
  try { stopPruneLoop(nome); } catch {}
  try {
    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].reopenAt = null;
    robeMeta[nome].activationHeldUntil = robeMeta[nome].frozenUntil || (Date.now() + 3600_000);
  } catch {}
  try { await snapshotStatusAndWrite(); } catch {}
}

const INTERNAL_REASONS = new Set(['ramKill','cpuKill','manifest_missing','manifest_incomplete','panic','open_headroom']);
const EXTERNAL_REASONS = new Set(['disconnected','no_pages','zombie','network','fb_dom','messenger_temp_block','blocked']);

function classifyReason(reason, fallback) {
  if (INTERNAL_REASONS.has(reason)) return 'internal';
  if (EXTERNAL_REASONS.has(reason)) return 'external';
  return fallback || 'unknown';
}

function getFailureCounts(nome) {
  const now = Date.now();
  const rec = profileFailures.get(nome);
  if (!rec) return { internal: 0, external: 0, unknown: 0 };
  const pruned = {
    internal: (rec.internal||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    external: (rec.external||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS),
    unknown: (rec.unknown||[]).filter(ts => (now - ts) < ULTRA_RECOVERY.FAIL_WINDOW_MS)
  };
  profileFailures.set(nome, pruned);
  return { internal: pruned.internal.length, external: pruned.external.length, unknown: pruned.unknown.length };
}

const profileFailures = new Map();
async function registerFailure(nome, reason, classification) {
  const now = Date.now();
  const cls = classification || classifyReason(reason, 'unknown');
  const rec = profileFailures.get(nome) || { internal: [], external: [], unknown: [] };
  rec.internal = (rec.internal||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.external = (rec.external||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  rec.unknown  = (rec.unknown ||[]).filter(ts => ts > now - ULTRA_RECOVERY.FAIL_WINDOW_MS);
  if (cls === 'internal') rec.internal.push(now);
  else if (cls === 'external') rec.external.push(now);
  else rec.unknown.push(now);
  profileFailures.set(nome, rec);
  const counts = getFailureCounts(nome);
  try { await issues.append(nome, 'failure', `reason=${reason} class=${cls} internal=${counts.internal} external=${counts.external} unknown=${counts.unknown}`); } catch {}

  const ALLOWED_FREEZE_REASONS = new Set(['manifest_missing','manifest_incomplete']);
  if (ALLOWED_FREEZE_REASONS.has(reason)) {
    await freezeProfileFor(nome, 12*60*60*1000, reason, 'system');
    await ensureFrozenShutdown(nome, reason || 'frozen');
  }
}

async function pageReadyBasic(p0) {
  try {
    const diag = await Promise.race([
      p0.evaluate(() => {
        const readyState = document.readyState || 'unknown';
        const href = String((location && location.href) || '');
        const isMessengerMarketplace = /messenger\.com\/.*marketplace/i.test(href);
        const hasChatAnchor = !!document.querySelector('a[href^="/marketplace/t/"]');
        const hasGrid = !!document.querySelector('div[role="grid"], div[role="rowgroup"], div[role="row"]');
        const hasMarketplaceNav =
          !!document.querySelector('a[href*="/marketplace"], [aria-label*="Marketplace"], [aria-label*="marketplace"]');
        const bodyTextLen = String((document.body && document.body.innerText) || '').trim().length;
        const nodeCount = document.querySelectorAll('a,button,input,main,section,article,nav,aside,div,span').length;
        const hasMarketplaceSignals = hasChatAnchor || hasGrid || hasMarketplaceNav;
        const likelyWhiteScreen = !hasMarketplaceSignals && nodeCount < 40 && bodyTextLen < 16;
        return {
          readyState,
          isMessengerMarketplace,
          hasMarketplaceSignals,
          likelyWhiteScreen
        };
      }),
      new Promise(res => setTimeout(() => res({ readyState: 'timeout', isMessengerMarketplace: false, hasMarketplaceSignals: false, likelyWhiteScreen: false }), NURSE_CFG.PAGE_EVAL_TIMEOUT_MS))
    ]);

    const ready = (diag.readyState === 'interactive' || diag.readyState === 'complete');
    if (!ready) return false;

    // Hardening P0: Messenger/Marketplace com "DOM pronto" mas sem sinais mínimos
    // geralmente corresponde à aba branca/degradada.
    if (diag.isMessengerMarketplace && !diag.hasMarketplaceSignals && diag.likelyWhiteScreen) {
      return false;
    }
    return true;
  } catch { return false; }
}

async function tryReloadShort(p0, nome, attempt) {
  try {
    if (process.env.NURSE_DEBUG === '1') {
      await reportAction(nome, 'mil_action', `nurse_reload_try #${attempt} url=${(p0 && p0.url && p0.url()) || ''} readyState=${await (async () => { try { return await p0.evaluate(()=>document.readyState); } catch { return '-'; } })()} reloadsIn60s=${robeMeta[nome]?.reloadAttemptsWindow?.length||0}`);
    }
  } catch {}
  try {
    await p0.reload({ waitUntil: 'domcontentloaded', timeout: ULTRA_RECOVERY.RELOAD_TIMEOUT_MS }).catch(()=>{});
    await new Promise(r=>setTimeout(r, ULTRA_RECOVERY.RELOAD_POST_WAIT_MS));
  } catch {}
  return await pageReadyBasic(p0);
}

function ms(h) { return h * 60 * 60 * 1000; }

async function freezeProfileFor(nome, msDuration, reason, setBy = 'system') {
  try {
    const now = Date.now();
    let applied = { until: now + msDuration, mode: 'set' };
    await manifestStore.update(nome, (man) => {
      man = man || {};
      const existingMem = (robeMeta[nome] && robeMeta[nome].frozenUntil) || 0;
      const existingDisk = (man && man.frozenUntil) || 0;
      const existing = Math.max(existingMem, existingDisk, 0);
      let until = now + msDuration;
      let mode = 'set';
      if (existing > now) {
        until = existing + msDuration;
        mode = 'extended';
      }
      applied.until = until;
      applied.mode = mode;

      man.frozenUntil = until;
      man.frozenReason = String(reason || '');
      man.frozenAt = man.frozenAt || now;
      man.frozenSetBy = setBy || 'system';
      return man;
    });

    robeMeta[nome] = robeMeta[nome] || {};
    robeMeta[nome].frozenUntil = applied.until;
    robeMeta[nome].frozenReason = String(reason || '');
    robeMeta[nome].frozenAt = robeMeta[nome].frozenAt || now;
    robeMeta[nome].frozenSetBy = setBy || 'system';

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `frozen_${Math.round(msDuration/60000)}min(${applied.mode}): reason=${reason||''} setBy=${setBy} until=${new Date(applied.until).toISOString()}`
      );
    } catch {}

    await ensureFrozenShutdown(nome, reason || 'frozen');
    await snapshotStatusAndWrite();
  } catch {}
}

async function unfreezeProfile(nome, setBy = 'admin') {
  try {
    const now = Date.now();

    robeMeta[nome] = robeMeta[nome] || {};
    delete robeMeta[nome].frozenUntil;
    delete robeMeta[nome].frozenReason;
    delete robeMeta[nome].frozenAt;
    delete robeMeta[nome].frozenSetBy;
    robeMeta[nome].activationHeldUntil = now + 60*1000;
    robeMeta[nome].reloadAttemptsWindow = [];
    robeMeta[nome].unfreezeCount = (robeMeta[nome].unfreezeCount || 0) + 1;
    robeMeta[nome].lastUnfreezeAt = now;
    robeMeta[nome].reopenAt = null;

    await manifestStore.update(nome, (man) => {
      man = man || {};
      if ('frozenUntil' in man) delete man.frozenUntil;
      if ('frozenReason' in man) delete man.frozenReason;
      if ('frozenAt' in man) delete man.frozenAt;
      if ('frozenSetBy' in man) delete man.frozenSetBy;
      return man;
    });

    profileFailures.set(nome, { internal: [], external: [], unknown: [] });

    try {
      await issues.append(
        nome,
        setBy && String(setBy).startsWith('admin') ? 'admin_action' : 'mil_action',
        `unfreeze by=${setBy}`
      );
    } catch {}

    await snapshotStatusAndWrite();
  } catch {}
}

async function detectMessengerTempBlock(page) {
  try {
    const url = page.url ? page.url() : '';
    if (!/messenger.com/i.test(url)) return { blocked: false };
    return await page.evaluate(() => {
      const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      const texts = Array.from(document.querySelectorAll('h1,h2,span,div'))
        .slice(0, 300)
        .map(el => norm(el.innerText || el.content || el.textContent || ''))
        .filter(Boolean);

      const hasBlocked =
        texts.some(t =>
          t.includes('voce esta bloqueado temporariamente') ||
          t.includes('você está bloqueado temporariamente') ||
          t.includes('youre temporarily blocked') ||
          t.includes('you’re temporarily blocked') ||
          t.includes('temporarily blocked')
        );
      const hasReloadBtn =
        !!document.querySelector('[aria-label*="Recarregar pagina"],[aria-label*="Recarregar página"],[aria-label*="Reload"]');
      return { blocked: hasBlocked, hasReloadBtn };
    });
  } catch { return { blocked: false }; }
}

// =========================================================
// AUTO LOGIN-REMEDIATE (enterprise autopilot)
// - Objetivo: ao detectar loginRequired (login_form) em qualquer perfil aberto,
//   disparar automaticamente o fluxo robusto `login_remediate` com mínimo impacto.
// - Guardrails:
//   - 1 por vez por worker/host (evita storm ao "abrir todos")
//   - backoff por perfil + limite por janela
//   - NUNCA tenta para captcha/checkpoint/identity (vira humanHold)
// =========================================================
const AUTO_LR_CFG = {
  enabled: !(String(process.env.AUTO_LOGIN_REMEDIATE || '').trim() === '0'),
  tickMs: Math.max(2000, Number(process.env.AUTO_LOGIN_REMEDIATE_TICK_MS || 5000) || 5000),
  immediateDelayMs: Math.max(0, Number(process.env.AUTO_LOGIN_REMEDIATE_IMMEDIATE_DELAY_MS || 1200) || 1200),
  minIntervalPerProfileMs: Math.max(60_000, Number(process.env.AUTO_LOGIN_REMEDIATE_MIN_INTERVAL_MS || (20 * 60 * 1000)) || (20 * 60 * 1000)), // 20min
  maxAttemptsPerProfile24h: Math.max(1, Number(process.env.AUTO_LOGIN_REMEDIATE_MAX_ATTEMPTS_24H || 4) || 4),
  backoffFailMs: Math.max(60_000, Number(process.env.AUTO_LOGIN_REMEDIATE_BACKOFF_FAIL_MS || (45 * 60 * 1000)) || (45 * 60 * 1000)), // 45min
  totalTimeoutMs: Math.max(60_000, Number(process.env.AUTO_LOGIN_REMEDIATE_TOTAL_TIMEOUT_MS || (6 * 60 * 1000)) || (6 * 60 * 1000)),
  stageTimeoutMs: {
    activate: Math.max(10_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_ACTIVATE_MS || 90_000) || 90_000),
    injectCookies: Math.max(30_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_INJECT_MS || 240_000) || 240_000),
    loginFb: Math.max(30_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_LOGIN_FB_MS || 120_000) || 120_000),
    loginMsg: Math.max(30_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_LOGIN_MSG_MS || 120_000) || 120_000),
    collectCookies: Math.max(10_000, Number(process.env.AUTO_LOGIN_REMEDIATE_STAGE_COLLECT_MS || 90_000) || 90_000),
  }
};

let _autoLoginRemediateRunning = false;
let _autoLoginRemediateRunningNome = null;

function _pruneWindow(arr, winMs) {
  const now = Date.now();
  const a = Array.isArray(arr) ? arr : [];
  return a.filter(ts => ts && (now - ts) <= winMs);
}

function queueAutoLoginRemediate(nome, { reason = '', source = '', immediate = false, force = false } = {}) {
  try {
    if (!AUTO_LR_CFG.enabled) return false;
    if (!nome) return false;
    robeMeta[nome] = robeMeta[nome] || {};
    const st = robeMeta[nome].autoLoginRemediate = (robeMeta[nome].autoLoginRemediate || {});
    const now = Date.now();

    st.attempts24h = _pruneWindow(st.attempts24h, 24 * 60 * 60 * 1000);
    if ((st.attempts24h || []).length >= AUTO_LR_CFG.maxAttemptsPerProfile24h) {
      st.queued = false;
      st.nextAt = Math.max(st.nextAt || 0, now + (3 * 60 * 60 * 1000));
      try { issues.append(nome, 'mil_action', `auto_login_remediate_suppressed: max_attempts_24h=${AUTO_LR_CFG.maxAttemptsPerProfile24h}`).catch(()=>{}); } catch {}
      return false;
    }

    const last = Number(st.lastStartAt || 0) || 0;
    const earliest = force ? 0 : (last ? (last + AUTO_LR_CFG.minIntervalPerProfileMs) : 0);
    const when = Math.max(
      now + (immediate ? AUTO_LR_CFG.immediateDelayMs : 2500),
      earliest,
      force ? 0 : (Number(st.nextAt || 0) || 0)
    );
    st.queued = true;
    st.nextAt = when;
    st.reason = String(reason || '').slice(0, 80);
    st.source = String(source || '').slice(0, 80);
    st.force = !!force;
    st.enqueuedAt = now;
    try {
      provisionAudit.append({
        ts: now,
        event: 'auto_login_remediate_queued',
        nome: String(nome || ''),
        reason: String(reason || '').slice(0, 120),
        source: String(source || '').slice(0, 80),
        nextAt: when,
        immediate: !!immediate,
        force: !!force
      });
    } catch {}
    return true;
  } catch {
    return false;
  }
}

async function autoLoginRemediateTick() {
  if (!AUTO_LR_CFG.enabled) return;
  if (_autoLoginRemediateRunning) return;
  // Não competir com provisionamento/manual configure em andamento: evita alternância de lock
  try {
    if (provisionLock.isActive()) {
      try { provisionAudit.append({ ts: Date.now(), event: 'auto_lr_tick_blocked', reason: 'provision_lock' }); } catch {}
      return;
    }
  } catch {}

  const desired = readJsonFile(desiredPath, { perfis: {} });
  const now = Date.now();

  let best = null;
  for (const [nome, ctrl] of controllers.entries()) {
    if (!nome || !ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) continue;
    // humanControl: SEMPRE respeitar (humano invocado = pausa total).
    if (ctrl.humanControl === true) {
      continue;
    }

    // configurando: normalmente pula (evita conflito com provision/abas),
    // mas se o enqueue foi force=true (ex.: governor_busy) e o item já está "ready",
    // permitimos avançar a fila (a serialização REAL é do governor/provisionLock).
    if (ctrl.configurando === true) {
      let allowOverride = false;
      try {
        const st0 = (robeMeta[nome] && robeMeta[nome].autoLoginRemediate) ? robeMeta[nome].autoLoginRemediate : null;
        const queued0 = !!(st0 && st0.queued);
        const nextAt0 = Number(st0 && st0.nextAt || 0) || 0;
        const force0 = !!(st0 && st0.force);
        if (queued0 && force0 && nextAt0 && nextAt0 <= now) {
          if (!provisionLock.isActive()) allowOverride = true;
        }
        if (allowOverride) {
          try { provisionAudit.append({ ts: now, event: 'auto_lr_tick_override_configurando', nome: String(nome||''), reason: 'force_queued_ready' }); } catch {}
        }
      } catch {}
      if (!allowOverride) {
        continue;
      }
    }
    if (ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
      continue;
    }
    if (robeMeta[nome] && robeMeta[nome].emExecucao === true) {
      continue;
    }

    const want = desired && desired.perfis ? desired.perfis[nome] : null;
    if (want && want.humanHold === true) {
      continue;
    }

    const flags = await readAccountFlags(nome).catch(()=>({}));
    const lrFlag = !!(flags && flags.loginRequired === true);
    const lrFailed = !!(flags && flags.loginRemediateFailed === true);
    const st = robeMeta[nome] && robeMeta[nome].autoLoginRemediate ? robeMeta[nome].autoLoginRemediate : null;
    const queued = !!(st && st.queued);
    const nextAt = st ? (Number(st.nextAt || 0) || 0) : 0;

    // Só tenta se o perfil está marcado como loginRequired (persistido) e está enfileirado (evento detectado).
    if (!lrFlag || !queued) {
      continue;
    }
    // Blindagem anti-loop: se já falhou (cookies+login) recentemente e foi marcado, NÃO tenta de novo automaticamente.
    if (lrFailed) {
      try {
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].autoLoginRemediate = robeMeta[nome].autoLoginRemediate || {};
        robeMeta[nome].autoLoginRemediate.queued = false;
        robeMeta[nome].autoLoginRemediate.nextAt = Math.max(robeMeta[nome].autoLoginRemediate.nextAt || 0, Date.now() + (6 * 60 * 60 * 1000));
      } catch {}
      try { issues.append(nome, 'mil_action', 'auto_login_remediate_skip(loginRemediateFailed=true)').catch(()=>{}); } catch {}
      continue;
    }
    if (nextAt && nextAt > now) {
      continue;
    }

    if (!best || nextAt < best.nextAt) {
      best = { nome, nextAt: nextAt || now };
    }
  }

  if (!best) return;

  const nome = best.nome;
  robeMeta[nome] = robeMeta[nome] || {};
  const st = robeMeta[nome].autoLoginRemediate = (robeMeta[nome].autoLoginRemediate || {});

  _autoLoginRemediateRunning = true;
  _autoLoginRemediateRunningNome = nome;
  st.queued = false;
  st.inFlight = true;
  st.lastStartAt = Date.now();
  st.attempts24h = _pruneWindow(st.attempts24h, 24 * 60 * 60 * 1000);
  st.attempts24h.push(st.lastStartAt);

  const operator = `auto_login_remediate:${nome}:${st.lastStartAt}`;
  try {
    try { provisionAudit.append({ ts: Date.now(), event: 'auto_login_remediate_begin', nome, operator, reason: st.reason || null, source: st.source || null }); } catch {}
    try { await issues.append(nome, 'mil_action', `auto_login_remediate_begin reason=${st.reason||''} source=${st.source||''}`); } catch {}

    const resp = await handlers.login_remediate({
      nome,
      operator,
      options: {
        // Autopilot nunca quebra "humanHold" automaticamente.
        overrideHumanHold: false,
        // Pós-sucesso enterprise: fecha, reabre mínimos e inicia Virtus.
        closeAfterSuccess: (String(process.env.AUTO_LOGIN_REMEDIATE_CLOSE_AFTER_SUCCESS || '0').trim() === '1'),
        startAfterSuccess: true,
        reopenClosedForRam: true,
        // Guardrails (não fechar muito)
        maxHardDeactivations: 2,
        // Timeouts duros
        totalTimeoutMs: AUTO_LR_CFG.totalTimeoutMs,
        stageTimeoutMs: AUTO_LR_CFG.stageTimeoutMs,
        // Espera um pouco mais se estiver ocupado (robe/postagem/enviando)
        waitBusyMs: 120_000
      }
    });

    st.lastDoneAt = Date.now();
    st.lastOk = !!(resp && resp.ok);
    st.lastError = resp && resp.error ? String(resp.error).slice(0, 160) : null;
    try { provisionAudit.append({ ts: Date.now(), event: 'auto_login_remediate_done', nome, operator, ok: st.lastOk, error: st.lastError || null }); } catch {}

    if (!st.lastOk) {
      // Persistir estado de falha (para abrir em modo humano e impedir loops automáticos)
      try { await setLoginRemediateFailedFlag(nome, { reason: st.lastError || 'login_remediate_failed', source: 'auto_login_remediate', stage: 'auto' }); } catch {}
      // Backoff em falha: evita loop no mesmo perfil.
      st.nextAt = Date.now() + AUTO_LR_CFG.backoffFailMs;
      try { await issues.append(nome, 'mil_action', `auto_login_remediate_backoff ${Math.round(AUTO_LR_CFG.backoffFailMs/60000)}min err=${st.lastError||''}`); } catch {}
    } else {
      // Sucesso: limpa fila.
      st.nextAt = 0;
      st.reason = null;
      st.source = null;
      try { await clearAccountFlags(nome, ['loginRemediateFailed']); } catch {}
    }
  } catch (e) {
    st.lastDoneAt = Date.now();
    st.lastOk = false;
    st.lastError = (e && e.message) ? String(e.message).slice(0, 160) : String(e).slice(0, 160);
    st.nextAt = Date.now() + AUTO_LR_CFG.backoffFailMs;
    try { provisionAudit.append({ ts: Date.now(), event: 'auto_login_remediate_exception', nome, operator, error: st.lastError }); } catch {}
    try { await issues.append(nome, 'mil_action', `auto_login_remediate_exception err=${st.lastError}`); } catch {}
  } finally {
    try {
      st.inFlight = false;
      robeMeta[nome].autoLoginRemediate = st;
    } catch {}
    _autoLoginRemediateRunning = false;
    _autoLoginRemediateRunningNome = null;
  }
}

let _nurseTickRunning = false;
// Throttle: evidência enterprise de pausa durante provisionamento (evita spam a cada 5s)
let _provisionPauseLastLogAt = 0;
let _provisionPauseLastOwner = null;
let _provisionPauseLastUntilMs = 0;

// Open-all: política para não “travar o servidor” quando faltar recurso para abrir 100%.
// Se ficar parado por RAM/supervisor por tempo suficiente, finaliza como "sucesso parcial"
// (sem loop infinito e sem manter Virtus pausado indefinidamente).
const OPEN_ALL_PARTIAL_CFG = {
  enabled: String(process.env.OPEN_ALL_PARTIAL_ENABLED || '1').trim() !== '0',
  minAgeMs: Math.max(10_000, Number(process.env.OPEN_ALL_PARTIAL_MIN_AGE_MS || 60_000) || 60_000),
  stallMs: Math.max(15_000, Number(process.env.OPEN_ALL_PARTIAL_STALL_MS || 120_000) || 120_000),
  denyWindowMs: Math.max(5_000, Number(process.env.OPEN_ALL_PARTIAL_DENY_WINDOW_MS || 45_000) || 45_000)
};

// ===== Reconciliador de estado (modo humano) =====
// Problema real observado em produção (RM4): perfis ficam "engessados" com flags antigas
// (ex.: loginRemediateFailed) mesmo quando a UI mudou para identidade/ban/login_form.
// Este reconciliador NÃO posta nada e NÃO liga Virtus; ele só:
// - detecta BAN/disabled_checkpoint e aplica setBannedFlag (auto delete)
// - detecta identidade/appeal/login_required e atualiza flags corretas (limpando flags obsoletas)
// - opcional: se for login_form, pode agendar login_remediate com backoff (política do cliente)
const HUMAN_RECONCILE_CFG = {
  enabled: String(process.env.HUMAN_RECONCILE || '1').trim() !== '0',
  minIntervalMs: parseInt(process.env.HUMAN_RECONCILE_MIN_INTERVAL_MS || '60000', 10), // 60s por perfil
  maxPagesScan: 8,
  allowScheduleLoginRemediate: String(process.env.HUMAN_RECONCILE_SCHEDULE_LOGIN_REMEDIATE || '1').trim() !== '0',
  minIntervalScheduleMs: parseInt(process.env.HUMAN_RECONCILE_LOGIN_REMEDIATE_MIN_INTERVAL_MS || String(30 * 60 * 1000), 10) // 30min
};

async function reconcileHumanState(nome, ctrl, { source = 'nurse' } = {}) {
  const now = Date.now();
  try {
    if (!HUMAN_RECONCILE_CFG.enabled) return { ok: false, skipped: 'disabled' };
    if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) return { ok: false, skipped: 'no_browser' };
    // Em modo humano, não reconcilia nem agenda automações.
    if (ctrl && ctrl.humanControl === true) return { ok: false, skipped: 'human_control' };
    robeMeta[nome] = robeMeta[nome] || {};
    const last = Number(robeMeta[nome].humanReconcileLastAt || 0) || 0;
    if (last && (now - last) < HUMAN_RECONCILE_CFG.minIntervalMs) return { ok: false, skipped: 'throttle' };
    robeMeta[nome].humanReconcileLastAt = now;

    const pages = await ctrl.browser.pages().catch(()=>[]);
    const safeUrl = (pg) => { try { return (pg && typeof pg.url === 'function') ? String(pg.url() || '') : ''; } catch { return ''; } };
    const pick = () => {
      for (const pg of (pages || []).slice(0, HUMAN_RECONCILE_CFG.maxPagesScan)) {
        const u = safeUrl(pg);
        if (/facebook\.com|messenger\.com/i.test(u)) return pg;
      }
      return (pages && pages[0]) || null;
    };
    const pg = pick();
    if (!pg) return { ok: false, skipped: 'no_pages' };

    // 1) Ban/Suspensão (desabilitamos sua conta, disabled_checkpoint)
    try {
      const bd = await browserHelper.detectAccountSuspended(pg).catch(()=>({ banned:false }));
      if (bd && bd.banned) {
        try {
          provisionAudit.append({
            ts: now,
            event: 'human_reconcile_banned',
            nome: String(nome||''),
            source: String(source||''),
            url: String(safeUrl(pg)||'').slice(0,220),
            reason: String(bd.reason||'banned').slice(0,140)
          });
        } catch {}
        try { await setBannedFlag(nome, { reason: String(bd.reason || 'banned'), snippet: String(bd.snippet || '') }); } catch {}
        return { ok: true, state: 'banned', reason: bd.reason || '' };
      }
    } catch {}

    // 2) LoginRequired/Identity/Appeal
    // Detectar login_required em qualquer aba relevante (Messenger/Facebook).
    const reasonPriority = (r) => {
      const s = String(r || '').toLowerCase();
      if (s.includes('identity')) return 5;
      if (s.includes('captcha')) return 4;
      if (s.includes('checkpoint')) return 3;
      if (s.includes('login_form')) return 2;
      return 1;
    };
    let lr = null;
    let lrPage = pg;
    try {
      for (const p of (pages || []).slice(0, HUMAN_RECONCILE_CFG.maxPagesScan)) {
        const u = safeUrl(p);
        if (!/(facebook|messenger)\.com/i.test(u)) continue;
        const det = await browserHelper.detectLoginRequired(p).catch(()=>null);
        if (det && det.loginRequired) {
          if (!lr || reasonPriority(det.reason) > reasonPriority(lr.reason)) {
            lr = det;
            lrPage = p;
          }
        }
      }
    } catch {}
    if (!lr) lr = await browserHelper.detectLoginRequired(pg).catch(()=>({ loginRequired:false }));
    if (!lr || lr.loginRequired !== true) {
      // Estado real mudou: browser está ok, mas flags antigas podem ter ficado presas (ex.: loginRemediateFailed).
      // Regra ultra enterprise: refletir a verdade da UI e destravar o autopiloto sem precisar de clique manual.
      let cleared = [];
      let setVirtusOn = false;
      try {
        const flagsPrev = await readAccountFlags(nome).catch(()=>({}));
        const needsClear =
          (flagsPrev && flagsPrev.loginRemediateFailed === true) ||
          (flagsPrev && flagsPrev.loginRequired === true) ||
          (flagsPrev && flagsPrev.messengerPin === true);
        if (needsClear) {
          try { await clearAccountFlags(nome, ['loginRemediateFailed', 'loginRequired', 'messengerPin']).catch(()=>{}); } catch {}
          cleared = ['loginRemediateFailed', 'loginRequired', 'messengerPin'];
        }
      } catch {}

      // Se o perfil está active=true no desired e virtus estava off por conta dessas flags presas, religar.
      try {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d = d || {};
          d.perfis = d.perfis || {};
          const cur = d.perfis[nome] || {};
          if (cur && cur.active === true && cur.virtus === 'off') {
            d.perfis[nome] = { ...cur, virtus: 'on', humanHold: false };
            setVirtusOn = true;
          }
          return d;
        });
      } catch {}

      try {
        provisionAudit.append({
          ts: now,
          event: 'human_reconcile_ok_no_login_required',
          nome: String(nome||''),
          url: String(safeUrl(pg)||'').slice(0,220),
          cleared,
          setVirtusOn
        });
      } catch {}
      if (setVirtusOn) {
        try { await snapshotStatusAndWrite(); } catch {}
      }
      return { ok: true, state: 'not_login_required', cleared, setVirtusOn };
    }

    const rr = String(lr.reason || '').toLowerCase();
    try {
      provisionAudit.append({
        ts: now,
        event: 'human_reconcile_login_required',
        nome: String(nome||''),
        source: String(source||''),
        reason: String(lr.reason||'').slice(0,160),
        url: String(lr.url||safeUrl(pg)||'').slice(0,220)
      });
    } catch {}

    if (rr.includes('identity_submitted')) {
      try { await setIdentitySubmittedFlag(nome, { source: lr.domain || source, url: lr.url || '', title: lr.title || '' }); } catch {}
      return { ok: true, state: 'identity_submitted' };
    }
    if (rr.includes('identity')) {
      try { await setIdentityRequiredFlag(nome, { source: lr.domain || source, url: lr.url || '', title: lr.title || '' }); } catch {}
      return { ok: true, state: 'identity_required' };
    }
    if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
      try { await setAppealSubmittedFlag(nome, { source: lr.domain || source, url: lr.url || '', title: lr.title || '' }); } catch {}
      try { await armAppealMonitor(nome, { delayMs: APPEAL_CFG.firstDelayMs }); } catch {}
      return { ok: true, state: 'appeal_submitted' };
    }

    // login_form: permitir liberar o sistema (política do cliente) com agendamento controlado
    if (rr.includes('login_form') && HUMAN_RECONCILE_CFG.allowScheduleLoginRemediate) {
      const lastSch = Number(robeMeta[nome].humanReconcileLastScheduleAt || 0) || 0;
      if (!lastSch || (now - lastSch) >= HUMAN_RECONCILE_CFG.minIntervalScheduleMs) {
        robeMeta[nome].humanReconcileLastScheduleAt = now;
        const op = `human_reconcile_login_form:${String(nome||'')}:${now}`;
        try { provisionAudit.append({ ts: now, event: 'human_reconcile_schedule_login_remediate', nome: String(nome||''), operator: op }); } catch {}
        setTimeout(() => {
          try { handlers.login_remediate({ nome, operator: op, options: { overrideHumanHold: true } }).catch(()=>{}); } catch {}
        }, 0);
      } else {
        try { provisionAudit.append({ ts: now, event: 'human_reconcile_schedule_suppressed', nome: String(nome||''), reason: 'min_interval' }); } catch {}
      }
      // Mesmo agendando, marque loginRequired correto (sem deixar "loginRemediateFailed" como estado final)
      try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || source }); } catch {}
      return { ok: true, state: 'login_form' };
    }

    // Padrão: loginRequired, mas não tentar automação (captcha/checkpoint etc)
    try { await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || source }); } catch {}
    return { ok: true, state: 'login_required', reason: rr };
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    try { provisionAudit.append({ ts: now, event: 'human_reconcile_error', nome: String(nome||''), error: msg.slice(0,220) }); } catch {}
    return { ok: false, error: msg };
  }
}

async function nurseTick() {
  if (_nurseTickRunning) return;
  _nurseTickRunning = true;
  try {
    // Ultra enterprise (safety+performance):
    // Se não há browsers abertos, NÃO rode o nurse completo a cada 5s (custa I/O em centenas de perfis).
    // Mas ainda precisamos de um sweep leve para exclusões retroativas (ban/2FA) já marcadas em flags.
    const now0 = Date.now();

    // Enterprise: retry de arquivamento no CT (quando CT estava 503/offline).
    // Isso evita “contas sumirem” (ficam assigned no CT mas perfil local já foi deletado).
    try {
      robeMeta.system = robeMeta.system || {};
      const lastQ = Number(robeMeta.system.ctArchiveQueueLastAt || 0) || 0;
      if (!lastQ || (now0 - lastQ) > 60_000) {
        robeMeta.system.ctArchiveQueueLastAt = now0;
        const qr = await processCtArchiveQueue({ limit: 4 }).catch(()=>null);
        try { provisionAudit.append({ ts: Date.now(), event: 'ct_archive_queue_tick', ok: !!(qr && qr.ok), processed: (qr && qr.processed !== undefined) ? qr.processed : null }); } catch {}
      }
    } catch {}
    // Importante (P0, 2026-01-30): o nurse NÃO pode "dormir" quando há intenção de abrir.
    // Open-all e abertura manual começam com controllers=0.
    // Otimização permitida: só reduzir trabalho quando NÃO existe nenhum desired.active=true e _openAll não está ativo.
    let desired0 = null;
    try { desired0 = readJsonFile(desiredPath, { perfis: {} }); } catch { desired0 = { perfis: {} }; }

    // Autopilot "Tudo aberto": só força desired.active=true quando _autoOpen.enabled=true.
    // Fazemos enforcement leve e com debounce para evitar IO excessivo.
    let autoOpenEnabled = false;
    try {
      const ao = desired0 && desired0._autoOpen && typeof desired0._autoOpen === 'object' ? desired0._autoOpen : null;
      autoOpenEnabled = !!(ao && ao.enabled === true);
    } catch {}
    try {
      if (autoOpenEnabled) {
        robeMeta.system = robeMeta.system || {};
        const last = Number(robeMeta.system.desiredEnforceActiveAt || 0) || 0;
        if (!last || (now0 - last) > 60_000) {
          robeMeta.system.desiredEnforceActiveAt = now0;
          const perfisArr = loadPerfisJson();
          const names = Array.isArray(perfisArr) ? perfisArr.map(p => p && p.nome).filter(Boolean) : [];
          let changed = 0;
          await fileStore.withDesiredFileLockUpdate((d) => {
            d = d || {}; d.perfis = d.perfis || {};
            for (const nome of names) {
              const cur = d.perfis[nome] || {};
              if (cur.active !== true) {
                d.perfis[nome] = { ...cur, active: true };
                changed++;
              }
            }
            return d;
          });
          if (changed > 0) {
            try { provisionAudit.append({ ts: now0, event: 'desired_enforce_active', changed, total: names.length }); } catch {}
            try { desired0 = readJsonFile(desiredPath, { perfis: {} }); } catch {}
          }
        }
      }
    } catch {}
    const hasOpenIntent = (() => {
      try {
        const oa = desired0 && desired0._openAll && typeof desired0._openAll === 'object' ? desired0._openAll : null;
        if (oa && oa.active === true) return true;
        if (autoOpenEnabled) return true;
        for (const n of Object.keys((desired0 && desired0.perfis) || {})) {
          const w = desired0.perfis[n] || {};
          if (w && w.active === true) return true;
        }
      } catch {}
      return false;
    })();

    if (controllers.size === 0) {
      // Ainda fazemos o sweep leve (ban/2FA) 1x/min.
      try {
        robeMeta.system = robeMeta.system || {};
        const last = Number(robeMeta.system.nurseZeroControllersSweepAt || 0) || 0;
        if (!last || (now0 - last) > 60_000) { // no máximo 1x/min
          robeMeta.system.nurseZeroControllersSweepAt = now0;
          for (const nome of Object.keys((desired0 && desired0.perfis) || {})) {
            try {
              const flags = await readAccountFlags(nome).catch(()=>({}));
              // Ban já marcado => tentar excluir (best-effort, idempotente)
              if (flags && flags.banned === true) {
                try { await setBannedFlag(nome, { reason: String(flags.bannedReason || 'banned'), snippet: String(flags.bannedText || '') }); } catch {}
                continue;
              }
              // 2FA já marcado => tentar excluir
              if (flags && flags.twoFactor === true) {
                try { await setTwoFactorFlag(nome, { reason: String(flags.twoFactorReason || 'two_factor'), snippet: String(flags.twoFactorText || '') }); } catch {}
                continue;
              }
              // Compat retroativa: loginRequired+reason two_factor => excluir
              if (flags && flags.loginRequired === true) {
                const rr = String(flags.loginReason || '').toLowerCase();
                if (rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor')) {
                  try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(flags.loginReason || '') }); } catch {}
                  continue;
                }
              }
            } catch {}
          }
        }
      } catch {}

      // Se NÃO há intenção de abrir, pode sair cedo (economia).
      if (!hasOpenIntent) {
        _nurseTickRunning = false;
        return;
      }
      // Se há intenção de abrir, continua para o fluxo completo (vai abrir).
    }
    // Ultra enterprise: durante operações globais, pausar Virtus de forma controlada
    // (não interromper envio em andamento; não mexer em perfis em config/humano/robe ativo).
    // Importante (2026-01-29): NÃO pausar Virtus globalmente durante stock_provision.
    // Stock provision só pode "mexer em RAM" (deactivate_for_ram) sem parar o robô inteiro.
    let provisionLockSnap = null;
    try {
      const lk = provisionLock.get ? provisionLock.get() : (provisionLock.isActive() ? { active: true, lock: null } : { active: false, lock: null });
      provisionLockSnap = lk;
      if (lk && lk.active) {
        const owner = lk.lock && lk.lock.owner ? String(lk.lock.owner) : null;
        const untilMs = lk.lock && lk.lock.untilMs ? Number(lk.lock.untilMs) : 0;
        const kind = (lk.lock && lk.lock.meta && lk.lock.meta.kind) ? String(lk.lock.meta.kind) : '';
        const shouldPauseVirtus =
          kind === 'open_all_map' ||
          kind === 'close_all' ||
          // compat retroativa (locks antigos sem meta.kind)
          (!kind && owner && /^(open_all_map:|close_all:)/i.test(owner));

        if (!shouldPauseVirtus) {
          // Não pausar virtus para outros locks (ex.: stock_provision).
          _provisionPauseLastOwner = null;
          _provisionPauseLastUntilMs = 0;
        } else {
        const paused = [];
        const skipped = { noVirtus: 0, human: 0, configurando: 0, robeExec: 0, sendLock: 0, other: 0 };

        for (const [n, c] of controllers.entries()) {
          try {
            if (!c || !c.virtus) { skipped.noVirtus++; continue; }
            if (c.humanControl === true) { skipped.human++; continue; }
            if (c.configurando === true) { skipped.configurando++; continue; }
            if (robeMeta[n] && robeMeta[n].emExecucao === true) { skipped.robeExec++; continue; }
            if (c.browser && c.browser._sendLock && c.browser._sendLock.active) { skipped.sendLock++; continue; }
            try { await stopVirtus(n); paused.push(String(n)); } catch { skipped.other++; }
          } catch { skipped.other++; }
        }

        // Evidência enterprise: loga no início do lock (ou mudança de owner) e depois a cada ~30s.
        const now = Date.now();
        const shouldLog =
          (owner && owner !== _provisionPauseLastOwner) ||
          (untilMs && untilMs !== _provisionPauseLastUntilMs) ||
          (now - _provisionPauseLastLogAt) > 30_000 ||
          paused.length > 0;

        if (shouldLog) {
          _provisionPauseLastLogAt = now;
          _provisionPauseLastOwner = owner;
          _provisionPauseLastUntilMs = untilMs;
          try {
            provisionAudit.append({
              ts: now,
              event: 'provision_lock_virtus_pause_tick',
              owner,
              kind: kind || null,
              untilMs,
              controllers: controllers.size,
              pausedCount: paused.length,
              pausedNames: paused.slice(0, 40),
              skipped
            });
          } catch {}
        }
        }
      } else {
        // lock acabou: reseta para o próximo provisionamento
        _provisionPauseLastOwner = null;
        _provisionPauseLastUntilMs = 0;
      }
    } catch {}

    const now = Date.now();
    const desired = desired0 || readJsonFile(desiredPath, { perfis: {} });

    // ===== OPEN-ALL (sequência) — manter lock vivo e finalizar automaticamente =====
    // Modelo:
    // - /api/perfis/open-all-24h cria desired._openAll.active=true e segura provision_lock (kind=open_all_map).
    // - Enquanto existirem perfis do shard para abrir, cada worker mantém o TTL vivo (reentrante).
    // - Quando todos os shards terminarem (ninguém mais renova), o lock expira sozinho.
    // - Ao detectar expiração, finalizamos desired._openAll e religamos virtus para perfis que não estão em humanHold.
    try {
      const oa = (desired && desired._openAll && typeof desired._openAll === 'object') ? desired._openAll : null;
      const oaActive = !!(oa && oa.active === true);
      const oaOwner = oa ? String(oa.lockOwner || oa.op || '') : '';
      const lkActive = !!(provisionLockSnap && provisionLockSnap.active);
      const lkOwner = provisionLockSnap && provisionLockSnap.lock && provisionLockSnap.lock.owner ? String(provisionLockSnap.lock.owner) : '';
      const lkKind = (provisionLockSnap && provisionLockSnap.lock && provisionLockSnap.lock.meta && provisionLockSnap.lock.meta.kind)
        ? String(provisionLockSnap.lock.meta.kind)
        : '';

      // Finalizar: openAll ativo, mas lock já expirou/foi removido => concluir e reativar virtus (safe).
      if (oaActive && (!lkActive || !oaOwner || lkOwner !== oaOwner)) {
        await fileStore.withDesiredFileLockUpdate((d) => {
          d = d || {}; d.perfis = d.perfis || {};
          d._openAll = d._openAll || {};
          d._openAll.active = false;
          d._openAll.doneAt = Date.now();
          d._openAll.lastError = d._openAll.lastError || null;
          // Regra do humano: ao concluir o open-all, liberar Virtus para quem NÃO está em humanHold.
          for (const n of Object.keys(d.perfis || {})) {
            const cur = d.perfis[n] || {};
            if (cur && cur.active === true && cur.humanHold !== true && String(cur.virtus || '') === 'off') {
              d.perfis[n] = { ...cur, virtus: 'on' };
            }
          }
          return d;
        });
        try { provisionAudit.append({ ts: Date.now(), event: 'open_all_finalize', ok: true, hadLock: lkActive, lockOwner: lkOwner || null }); } catch {}
      }

      // Keepalive: se openAll ativo e este shard ainda tem perfis a abrir, estender TTL do lock.
      if (oaActive && lkActive && oaOwner && lkOwner === oaOwner && (lkKind === 'open_all_map' || (!lkKind && /^open_all_map:/i.test(lkOwner)))) {
        let pending = 0;
        let pendingNames = [];
        let ramDeniedPending = [];
        let stalledSince = 0;
        try {
          for (const n of Object.keys(desired.perfis || {})) {
            if (!n) continue;
            if (SHARD_SET.size && !inShard(n)) continue;
            const want = desired.perfis[n] || {};
            if (want.active === true && !controllers.has(n)) {
              pending++;
              pendingNames.push(String(n));
            }
          }
        } catch {}

        // Heurística enterprise (P1): se está "preso" abrindo e os pendentes só recebem negação por RAM/supervisor,
        // finaliza como sucesso parcial para liberar o servidor (Virtus/Robe).
        try {
          if (OPEN_ALL_PARTIAL_CFG.enabled && pending > 0) {
            const now = Date.now();
            const startedAt = Number(oa && oa.startedAt || 0) || 0;
            const lastProgressAt = Number(oa && oa.lastProgressAt || 0) || 0;
            stalledSince = lastProgressAt || startedAt || now;

            for (const n of (pendingNames || [])) {
              const rm = robeMeta[n] || {};
              const deniedAt = Number(rm.lastOpenDeniedAt || 0) || 0;
              const deniedReason = String(rm.lastOpenDeniedReason || '').toLowerCase();
              const recent = deniedAt && (now - deniedAt) <= OPEN_ALL_PARTIAL_CFG.denyWindowMs;
              const isRamish =
                deniedReason.includes('ram_insuficiente_para_ativar') ||
                deniedReason.includes('supervisor_denied:ram_low') ||
                deniedReason.includes('supervisor_denied:slots') ||
                deniedReason.includes('headroom_below_min_after_open');
              if (recent && isRamish) ramDeniedPending.push(String(n));
            }

            const ageOk = startedAt && (now - startedAt) >= OPEN_ALL_PARTIAL_CFG.minAgeMs;
            const stalledOk = stalledSince && (now - stalledSince) >= OPEN_ALL_PARTIAL_CFG.stallMs;
            if (ageOk && stalledOk && ramDeniedPending.length === pendingNames.length) {
              // Finaliza e "desliga" desired.active para os que não abriram por limitação (evita loop infinito).
              try {
                await fileStore.withDesiredFileLockUpdate((d) => {
                  d = d || {}; d.perfis = d.perfis || {};
                  d._openAll = d._openAll || {};
                  const total = Array.isArray(d._openAll.queue) ? d._openAll.queue.length : 0;
                  let opened = 0;
                  try {
                    for (const qn of (d._openAll.queue || [])) {
                      if (controllers.has(qn)) opened++;
                    }
                  } catch {}
                  d._openAll.active = false;
                  d._openAll.doneAt = Date.now();
                  d._openAll.lastError = 'partial_ram';
                  d._openAll.partial = true;
                  d._openAll.partialSkipped = (ramDeniedPending || []).slice(0, 60);
                  d._openAll.partialReason = 'ram_or_supervisor_denied';
                  d._openAll.partialOpened = opened;
                  d._openAll.partialTotal = total;
                  // Regra do humano: NUNCA desligar desired.active automaticamente.
                  // Em vez disso, aplicar backoff curto para evitar loop agressivo; o nurse reabre quando houver RAM.
                  const backoffMs = Math.max(30_000, Number(process.env.OPEN_ALL_PARTIAL_BACKOFF_MS || 60000) || 60000);
                  for (const nn of (ramDeniedPending || [])) {
                    try {
                      robeMeta[nn] = robeMeta[nn] || {};
                      const now2 = Date.now();
                      robeMeta[nn].activationHeldUntil = now2 + backoffMs;
                      robeMeta[nn].reopenAt = now2 + backoffMs;
                      robeMeta[nn].whyNotOpen = 'open_all_partial_ram';
                    } catch {}
                  }
                  // Libera Virtus para quem ficou ativo e não está em humanHold.
                  for (const n of Object.keys(d.perfis || {})) {
                    const cur = d.perfis[n] || {};
                    if (cur && cur.active === true && cur.humanHold !== true && String(cur.virtus || '') === 'off') {
                      d.perfis[n] = { ...cur, virtus: 'on' };
                    }
                  }
                  return d;
                });
              } catch {}
              try { provisionLock.release({ owner: oaOwner, force: false }); } catch {}
              try {
                provisionAudit.append({
                  ts: Date.now(),
                  event: 'open_all_finalize_partial',
                  ok: true,
                  reason: 'partial_ram',
                  pending,
                  pendingNames: (pendingNames || []).slice(0, 60),
                  skipped: (ramDeniedPending || []).slice(0, 60)
                });
              } catch {}
              // Não faça keepalive se finalizamos agora.
              pending = 0;
              pendingNames = [];
            }
          }
        } catch {}

        if (pending > 0) {
          try {
            // TTL pequeno e renovável => lock cai rápido quando todos terminarem.
            provisionLock.tryAcquire({ owner: oaOwner, ttlMs: 120000, meta: { kind: 'open_all_keepalive', pending } });
          } catch {}
        }
      }
    } catch {}

    // ===== PRIORIDADE ENTERPRISE: Recurso em análise (Pronto!) =====
    // Se existir qualquer perfil com appealSubmitted=true e appealNextCheckAt<=now e ainda sem controller,
    // ele deve ser o próximo a abrir (não pode ser “pulado”).
    let appealReadyPick = '';
    try {
      const names0 = Object.keys(desired.perfis || {});
      for (const n of names0) {
        try {
          if (!n) continue;
          if (SHARD_SET.size && !inShard(n)) continue;
          const want0 = desired.perfis[n] || {};
          if (want0.active !== true) continue;
          if (controllers.has(n)) continue;
          if (robeMeta[n]?.activationHeldUntil && robeMeta[n].activationHeldUntil > Date.now()) continue;
          if (robeMeta[n]?.reopenAt && robeMeta[n].reopenAt > Date.now()) continue;
          const flags = await readAccountFlags(n).catch(()=>null);
          const ap = flags && flags.appealSubmitted === true;
          const nextAt = flags ? (Number(flags.appealNextCheckAt || 0) || 0) : 0;
          if (ap && nextAt && nextAt <= Date.now()) { appealReadyPick = String(n); break; }
        } catch {}
      }
    } catch {}

    // Se achamos um "Pronto!", abre ele agora e não abre outros nesta rodada.
    if (appealReadyPick) {
      if (robeMeta[appealReadyPick]?.activationHeldUntil && robeMeta[appealReadyPick].activationHeldUntil > Date.now()) {
        // Não deve acontecer (guard), mas não travar: segue o loop normal.
      } else if (slotsInUse < MAX_OPEN_CONCURRENCY) {
        slotsInUse++;
        try {
          await reportAction(appealReadyPick, 'nurse_restart', 'appeal_ready_priority_open');
          await activateOnce(appealReadyPick, 'nurse_appeal_ready').catch(()=>null);
        } catch {} finally {
          slotsInUse--;
        }
        await new Promise(r => setTimeout(r, OPEN_ACTIVATION_DELAY_MS));
        return;
      }
    }

    for (const nome of Object.keys(desired.perfis || {})) {
      const ctrlExisting = controllers.get(nome);
      if (SHARD_SET.size && !inShard(nome) && !ctrlExisting) {
        // Debug enterprise (P0 gaps): se o perfil está desired.active=true mas não está no shard,
        // ele fica "órfão" e nunca abre. Logar com debounce para evidência irrefutável.
        try {
          const want0 = desired.perfis ? (desired.perfis[nome] || {}) : {};
          if (want0 && want0.active === true) {
            robeMeta.system = robeMeta.system || {};
            robeMeta.system._dbgShardSkip = robeMeta.system._dbgShardSkip || {};
            const k = String(nome || '');
            const last = Number(robeMeta.system._dbgShardSkip[k] || 0) || 0;
            const now = Date.now();
            if (!last || (now - last) > 60_000) {
              robeMeta.system._dbgShardSkip[k] = now;
              try { provisionAudit.append({ ts: now, event: 'nurse_skip_other_shard_active', nome: String(nome||''), shardSize: SHARD_SET.size, pid: process.pid }); } catch {}
            }
          }
        } catch {}
        if (process.env.NURSE_DEBUG === '1') {
          try { logger.info(`[NURSE][SKIP_OTHER_SHARD] ${nome}`); } catch {}
        }
        continue;
      }
      const want = desired.perfis[nome] || {};
      const ctrl = ctrlExisting || null;

      // Reconciliador: mesmo em modo humano/hold, precisamos atualizar flags conforme a UI real,
      // senão o sistema fica "engessado" em estados antigos (ex.: loginRemediateFailed) e gera falso positivo.
      try {
        const flagsR = await readAccountFlags(nome).catch(()=>({}));
        const needsRecon =
          (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) &&
          (ctrl.humanControl === true || want.humanHold === true || (flagsR && flagsR.loginRemediateFailed === true));
        if (needsRecon) {
          await reconcileHumanState(nome, ctrl, { source: 'nurse' }).catch(()=>null);
        }
      } catch {}

      // Auto-exclusão enterprise: se já está marcado como banned/suspended, arquiva no CT e deleta o perfil local.
      // Isso cobre casos pós-restart onde a flag já estava setada e não vai passar novamente pelos fluxos de detecção.
      try {
        const flagsB = await readAccountFlags(nome).catch(()=>({}));
        if (flagsB && flagsB.banned === true) {
          robeMeta[nome] = robeMeta[nome] || {};
          const last = Number(robeMeta[nome].banSweepLastAt || 0) || 0;
          if (!last || (now - last) > (2 * 60 * 1000)) { // no máximo 1 tentativa a cada 2min por perfil
            robeMeta[nome].banSweepLastAt = now;
            try {
              provisionAudit.append({
                ts: now,
                event: 'ban_sweep_attempt',
                nome: String(nome || ''),
                reason: String(flagsB.bannedReason || flagsB.reason || '').slice(0, 160)
              });
            } catch {}
            try { await setBannedFlag(nome, { reason: String(flagsB.bannedReason || 'banned'), snippet: String(flagsB.bannedText || '') }); } catch {}
          }
          continue;
        }
      } catch {}

      // Auto-exclusão enterprise: 2FA (persistente) — cobre pós-restart.
      try {
        const flags2 = await readAccountFlags(nome).catch(()=>({}));
        if (flags2 && flags2.twoFactor === true) {
          robeMeta[nome] = robeMeta[nome] || {};
          const last = Number(robeMeta[nome].twoFactorSweepLastAt || 0) || 0;
          if (!last || (now - last) > (2 * 60 * 1000)) {
            robeMeta[nome].twoFactorSweepLastAt = now;
            try { provisionAudit.append({ ts: now, event: 'two_factor_sweep_attempt', nome: String(nome||''), reason: String(flags2.twoFactorReason||'two_factor').slice(0,160) }); } catch {}
            try { await setTwoFactorFlag(nome, { reason: String(flags2.twoFactorReason || 'two_factor'), snippet: String(flags2.twoFactorText || '') }); } catch {}
          }
          continue;
        }
      } catch {}

      // Compat retroativa: versões antigas marcavam 2FA como loginRequired com reason "two_factor/2fa".
      // Se isso acontecer, convertemos para twoFactor e excluímos.
      try {
        const flags3 = await readAccountFlags(nome).catch(()=>({}));
        if (flags3 && flags3.loginRequired === true) {
          const rr = String(flags3.loginReason || flags3.reason || '').toLowerCase();
          const isTwoFactor = rr.includes('two_factor') || rr.includes('2fa') || rr.includes('two factor');
          if (isTwoFactor) {
            robeMeta[nome] = robeMeta[nome] || {};
            const last = Number(robeMeta[nome].twoFactorCompatSweepLastAt || 0) || 0;
            if (!last || (now - last) > (2 * 60 * 1000)) {
              robeMeta[nome].twoFactorCompatSweepLastAt = now;
              try { provisionAudit.append({ ts: now, event: 'two_factor_compat_sweep_attempt', nome: String(nome||''), reason: rr.slice(0,160) }); } catch {}
              try { await setTwoFactorFlag(nome, { reason: rr || 'two_factor', snippet: String(flags3.loginReason || '') }); } catch {}
            }
            continue;
          }
        }
      } catch {}

      // Monitoramento: identidade (selfie/vídeo) submetida — checa a cada 1h, mesmo com humanHold.
      try {
        const flagsI = await readAccountFlags(nome).catch(()=>({}));
        if (flagsI && flagsI.identitySubmitted === true) {
          // Garantia ultra enterprise: nunca manter Virtus rodando em identitySubmitted.
          try {
            if (ctrl) {
              ctrl.trabalhando = false;
              await stopVirtus(nome).catch(()=>{});
              await snapshotStatusAndWrite().catch(()=>{});
            }
          } catch {}
          const nextAt = Number(flagsI.identityNextCheckAt || 0) || 0;
          if (!nextAt || nextAt <= now) {
            if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'identity_monitor_check', 'identity_monitor_check');
              await identityMonitorCheckNow(nome, ctrl).catch(()=>null);
              await snapshotStatusAndWrite().catch(()=>{});
            }
          } else {
            await appendIssueNurseDebounced(nome, 'mil_action', 'identity_monitor_waiting', 'identity_monitor_waiting');
          }
          continue;
        }
      } catch {}

      // Identidade requerida (pré-submissão):
      // Regra do usuário: NUNCA invocar humano automaticamente. O nurse pode rodar assist, mas não seta humanControl/overlay.
      try {
        const flagsIR = await readAccountFlags(nome).catch(()=>({}));
        if (flagsIR && flagsIR.identityRequired === true) {
          // P0: Se o navegador NÃO está aberto, não podemos "assistir" identidade.
          // Regra do humano: se desired.active=true, o navegador precisa abrir mesmo em identityRequired.
          if (!ctrl && want && want.active === true) {
            try { provisionAudit.append({ ts: now, event: 'nurse_identity_required_no_ctrl_allow_open', nome: String(nome||'') }); } catch {}
            // NÃO continue aqui: deixa cair no bloco normal de abertura (want.active && !ctrl).
          } else {
          try {
            if (ctrl) {
              ctrl.trabalhando = false;
              await stopVirtus(nome).catch(()=>{});
              // Debounce do assist (não spammar cliques)
              robeMeta[nome] = robeMeta[nome] || {};
              const last = Number(robeMeta[nome].identityAssistLastAt || 0) || 0;
              if (!last || (now - last) > 30_000) {
                robeMeta[nome].identityAssistLastAt = now;
                const pages = ctrl.browser ? await ctrl.browser.pages().catch(()=>[]) : [];
                const pg = pages && pages[0];
                if (pg) {
                  await runIdentityFlow(nome, ctrl, pg, { source: 'nurse_identity_required' }).catch(()=>null);
                }
              }
              await snapshotStatusAndWrite().catch(()=>{});
            }
          } catch {}
          await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_identity_required', 'nurse_identity_required');
          continue;
          }
        }
      } catch {}

      // Captcha/Checkpoint (pré-screen ou captcha clássico):
      // Ultra enterprise: não pode ficar "parado" na tela. Se já está marcado como captcha, o nurse agenda o captcha flow.
      // Guardrails: 1) não roda em humanControl/humanHold; 2) debounce 30s por perfil; 3) governança do próprio flow.
      try {
        const flagsC = await readAccountFlags(nome).catch(()=>({}));
        if (flagsC && flagsC.loginRequired === true) {
          const rr = String(flagsC.loginReason || flagsC.reason || '').toLowerCase();
          const isCaptcha =
            rr.includes('captcha_persona_pre_screen') ||
            rr.includes('captcha_persona') ||
            rr.includes('checkpoint_captcha') ||
            rr.includes('captcha') ||
            rr.includes('checkpoint');
          if (isCaptcha) {
            if (ctrl && ctrl.browser && ctrl.browser.isConnected?.() && ctrl.humanControl !== true && want.humanHold !== true) {
              robeMeta[nome] = robeMeta[nome] || {};
              const last = Number(robeMeta[nome].captchaAssistLastAt || 0) || 0;
              if (!last || (now - last) > 30_000) {
                robeMeta[nome].captchaAssistLastAt = now;
                const pages = ctrl.browser ? await ctrl.browser.pages().catch(()=>[]) : [];
                const pg = (pages && pages[0]) || ctrl.mainPage || null;
                if (pg) {
                  try { provisionAudit.append({ ts: now, event: 'nurse_captcha_flow_schedule', nome: String(nome||''), reason: rr.slice(0,160) }); } catch {}
                  runCaptchaFlow(nome, ctrl, pg, { source: 'nurse_captcha_login_required', force: true }).catch(()=>{});
                } else {
                  try { provisionAudit.append({ ts: now, event: 'nurse_captcha_flow_no_page', nome: String(nome||''), reason: rr.slice(0,160) }); } catch {}
                }
              } else {
                await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_captcha_debounced', 'nurse_captcha_debounced');
              }
              continue;
            }
            // P0: Se o navegador NÃO está aberto, não dá pra rodar captcha flow.
            // Regra do humano: se desired.active=true, o navegador precisa abrir mesmo em captcha/loginRequired.
            if (!ctrl && want && want.active === true) {
              try { provisionAudit.append({ ts: now, event: 'nurse_captcha_required_no_ctrl_allow_open', nome: String(nome||''), reason: rr.slice(0,160) }); } catch {}
              // NÃO continue: deixa cair no bloco normal de abertura.
            } else {
              continue;
            }
          }
        }
      } catch {}

      // Monitoramento: recurso/apelação submetida (após "Retomar trabalho")
      try {
        const flags = await readAccountFlags(nome).catch(()=>({}));
        if (flags && flags.appealSubmitted === true) {
          try { provisionAudit.append({ ts: Date.now(), event: 'appeal_submitted_guard', nome: String(nome||''), nextAt: Number(flags.appealNextCheckAt || 0) || 0, hasCtrl: !!ctrl }); } catch {}
          // Garantia ultra enterprise: nunca manter Virtus rodando em appealSubmitted.
          try {
            if (ctrl) {
              ctrl.trabalhando = false;
              await stopVirtus(nome).catch(()=>{});
              await snapshotStatusAndWrite().catch(()=>{});
            }
          } catch {}
          // IMPORTANTE (P0): "Abrir todos" / desired.active=true deve abrir o navegador mesmo em appealSubmitted,
          // porque conta fechada impede diagnóstico e impede o monitor de verificar o estado real.
          // Regra: se não há controller e queremos active=true, NÃO bloqueie a abertura aqui.
          // Mantemos o bloqueio de automação (Robe/Virtus) via continue APENAS quando o navegador já está aberto
          // ou quando não queremos abrir.
          if (!ctrl && want && want.active === true) {
            try { provisionAudit.append({ ts: Date.now(), event: 'appeal_submitted_allow_open_no_ctrl', nome: String(nome||''), nextAt: Number(flags.appealNextCheckAt || 0) || 0 }); } catch {}
            // NÃO continue: deixa cair no bloco normal de abertura (activateOnce) logo abaixo.
          } else {
          const nextAt = Number(flags.appealNextCheckAt || 0) || 0;
          if (!nextAt || nextAt <= now) {
            // Só monitora se o navegador está aberto; senão, o nurse seguirá a regra normal de desired.active.
            if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'appeal_monitor_check', 'appeal_monitor_check');
              await appealMonitorCheckNow(nome, ctrl).catch(()=>null);
              await snapshotStatusAndWrite().catch(()=>{});
            } else {
              try { provisionAudit.append({ ts: Date.now(), event: 'appeal_ready_no_ctrl', nome: String(nome||''), nextAt: Number(nextAt || 0) || 0 }); } catch {}
            }
          } else {
            await appendIssueNurseDebounced(nome, 'mil_action', 'appeal_monitor_waiting', 'appeal_monitor_waiting');
            try { provisionAudit.append({ ts: Date.now(), event: 'appeal_waiting', nome: String(nome||''), nextAt: Number(nextAt || 0) || 0 }); } catch {}
          }
          // Enquanto estiver em appealSubmitted, NÃO rodar automação normal (Robe/Virtus).
          continue;
          }
        }
      } catch {}

      if (want.humanHold === true) {
        // Overlay deve aparecer e se manter (retry periódico com debounce).
        try {
          if (ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
            robeMeta[nome] = robeMeta[nome] || {};
            const last = Number(robeMeta[nome].overlayNurseLastAt || 0) || 0;
            if (!last || (now - last) > 45_000) {
              robeMeta[nome].overlayNurseLastAt = now;
              await syncHumanOverlay(nome).catch(()=>{});
            }
          }
        } catch {}
        await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_human_hold', 'nurse_skip_human_hold');
        continue;
      }

      {
        const rm = robeMeta[nome] || {};
        if (rm.emExecucao === true) {
          await appendIssueNurseDebounced(nome, 'mil_action', 'nurse_skip_robe_running', 'nurse_skip_robe_running');
          continue;
        }
      }

      if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) {
        continue;
      }
      if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'send_lock_skip', 'send_lock_skip');
        continue;
      }

      if (isFrozenNow(nome)) {
        if (ctrl) { await ensureFrozenShutdown(nome, 'nurse_guard'); }
        continue;
      }

      const hs = getHealth && getHealth(nome);
      if (hs && ['recover1','recover2','recover3'].includes(hs.stage)) {
        await appendIssueNurseDebounced(nome, 'mil_action', 'health_recovery_in_progress_skip', 'health_recovery_in_progress_skip');
        continue;
      }

      if (want.active === true && !ctrl) {
        if (isFrozenNow(nome)) continue;

        if (robeMeta[nome]?.activationHeldUntil && robeMeta[nome].activationHeldUntil > Date.now()) {
          continue;
        }
        if (robeMeta[nome]?.reopenAt && robeMeta[nome].reopenAt > Date.now()) {
          continue;
        }

        if (slotsInUse >= MAX_OPEN_CONCURRENCY) {
          continue;
        }
        slotsInUse++;
        try {
          let _flags = null;
          try { _flags = await readAccountFlags(nome).catch(()=>null); } catch {}
          if (_flags && _flags.appealSubmitted === true) {
            try { provisionAudit.append({ ts: Date.now(), event: 'nurse_open_pending_appeal', nome: String(nome||''), appealNextCheckAt: Number(_flags.appealNextCheckAt || 0) || 0 }); } catch {}
          }
          await reportAction(nome, 'nurse_restart', 'desired ativo porém controller ausente — tentando ativar');
          try {
            // Se existe um open-all ativo sob provision_lock (kind=open_all_map),
            // a abertura precisa:
            // - bypass do lock (operator = lockOwner)
            // - entrar em "bulk-open mode" (source contém open_all_24h)
            let r = null;
            try {
              const oa = (desired && desired._openAll && typeof desired._openAll === 'object') ? desired._openAll : null;
              const oaActive = !!(oa && oa.active === true);
              const oaOwner = oa ? String(oa.lockOwner || oa.op || '') : '';
              const lkActive = !!(provisionLockSnap && provisionLockSnap.active);
              const lkOwner = provisionLockSnap && provisionLockSnap.lock && provisionLockSnap.lock.owner ? String(provisionLockSnap.lock.owner) : '';
              const lkKind = (provisionLockSnap && provisionLockSnap.lock && provisionLockSnap.lock.meta && provisionLockSnap.lock.meta.kind)
                ? String(provisionLockSnap.lock.meta.kind)
                : '';
              const useOpenAll = oaActive && oaOwner && lkActive && lkOwner === oaOwner && (lkKind === 'open_all_map' || (!lkKind && /^open_all_map:/i.test(lkOwner)));
              try { provisionAudit.append({ ts: Date.now(), event: 'nurse_open_attempt', nome: String(nome||''), source: useOpenAll ? 'open_all_24h' : 'nurse_auto', oaActive: !!oaActive, lkActive: !!lkActive, lkKind: lkKind || null }); } catch {}
              r = useOpenAll
                ? await activateOnce(nome, 'open_all_24h', oaOwner)
                : await activateOnce(nome, 'nurse_auto');
            } catch {
              try { provisionAudit.append({ ts: Date.now(), event: 'nurse_open_attempt', nome: String(nome||''), source: 'nurse_auto', oaActive: false, lkActive: false, lkKind: null }); } catch {}
              r = await activateOnce(nome, 'nurse_auto');
            }
            if (!r || !r.ok) {
              const err = (r && r.error) || '';
              try { provisionAudit.append({ ts: Date.now(), event: 'nurse_open_denied', nome: String(nome||''), error: String(err || '').slice(0, 160) }); } catch {}
              try {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].lastOpenDeniedAt = Date.now();
                robeMeta[nome].lastOpenDeniedReason = String(err || '').slice(0, 220);
              } catch {}
              if (/ram_insuficiente_para_ativar|supervisor_denied:ram_low|supervisor_denied:slots|headroom_below_min_after_open/.test(err)) {
                await issues.append(nome, 'mil_action', 'open_denied_ram_swap_attempt err='+err);

                const swapped = await trySwapOpen(nome);

                if (!swapped) {
                  robeMeta[nome] = robeMeta[nome] || {};
                  // NOVO: Backoff fixo de 3s ao invés de escalonado (supervisor já controla velocidade)
                  const curBackoff = 3000;
                  robeMeta[nome].openBackoffMs = curBackoff;
                  robeMeta[nome].activationHeldUntil = Date.now() + curBackoff;
                  await issues.append(nome, 'mil_action', `open_backoff set to ${Math.floor(curBackoff/1000)}s (fixed)`);
                  logger.warn('[SWAP] open_backoff set', { nome, backoffMs: curBackoff, reason: err });
                } else {
                  logger.info('[SWAP] swap_open_success (nurse)', { target: nome });
                }
              }
            } else {
              // NOVO: Backoff fixo de 3s ao invés de 15s
              if (robeMeta[nome]) robeMeta[nome].openBackoffMs = 3000;
              // Progresso do open-all: marca avanço para evitar "stall detector" falso.
              try {
                const oa = (desired && desired._openAll && typeof desired._openAll === 'object') ? desired._openAll : null;
                const oaActive = !!(oa && oa.active === true);
                const oaOwner = oa ? String(oa.lockOwner || oa.op || '') : '';
                const lkActive = !!(provisionLockSnap && provisionLockSnap.active);
                const lkOwner = provisionLockSnap && provisionLockSnap.lock && provisionLockSnap.lock.owner ? String(provisionLockSnap.lock.owner) : '';
                const lkKind = (provisionLockSnap && provisionLockSnap.lock && provisionLockSnap.lock.meta && provisionLockSnap.lock.meta.kind)
                  ? String(provisionLockSnap.lock.meta.kind)
                  : '';
                const useOpenAll = oaActive && oaOwner && lkActive && lkOwner === oaOwner && (lkKind === 'open_all_map' || (!lkKind && /^open_all_map:/i.test(lkOwner)));
                if (useOpenAll) {
                  await fileStore.withDesiredFileLockUpdate((d) => {
                    d = d || {}; d._openAll = d._openAll || {};
                    if (d._openAll && d._openAll.active === true) {
                      d._openAll.lastProgressAt = Date.now();
                      d._openAll.lastOpened = String(nome || '').slice(0, 120);
                    }
                    return d;
                  }).catch(()=>null);
                }
              } catch {}
              logger.info('[NURSE] activateOnce ok', { nome });
            }
          } catch { }
        } finally {
          slotsInUse--;
        }
        await new Promise(r => setTimeout(r, OPEN_ACTIVATION_DELAY_MS));
        continue;
      }

      if (!ctrl || !ctrl.browser) continue;
      let pages = [];
      try { pages = await ctrl.browser.pages().catch(()=>[]); } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].noPagesStrikes = robeMeta[nome].noPagesStrikes || 0;
      robeMeta[nome].lastNoPagesAt = robeMeta[nome].lastNoPagesAt || 0;

      if (!pages || !pages[0]) {
        let retryFailed = false;
        if (ctrl.browser.isConnected?.()) {
          await new Promise(r=>setTimeout(r,400));
          let retryPages = [];
          try { retryPages = await ctrl.browser.pages(); } catch {}
          if (!retryPages || !retryPages[0]) retryFailed = true;
        } else {
          retryFailed = true;
        }
        if (retryFailed) {
          // Mesmo sem páginas, registre um snapshot leve quando a flag LR já está setada.
          // Isso cria o arquivo `login_required_events.jsonl` e prova "flag presa" sem depender do browser aberto.
          try {
            const flags = await readAccountFlags(nome).catch(()=>({}));
            if (flags && flags.loginRequired === true) {
              robeMeta[nome] = robeMeta[nome] || {};
              const now = Date.now();
              const last = Number(robeMeta[nome].lastLRFlagSnapshotNoPagesAt || 0) || 0;
              if (!last || (now - last) > (30 * 60 * 1000)) {
                robeMeta[nome].lastLRFlagSnapshotNoPagesAt = now;
                appendJsonl(LR_EVENTS_JSONL, {
                  ts: now,
                  host: os.hostname(),
                  perfil: nome,
                  event: 'lr_flag_snapshot_no_pages',
                  storedReason: flags.loginReason || null,
                  storedSource: flags.loginSource || null,
                  pagesCount: 0,
                  evidenceCaptured: false,
                  url: null,
                  title: null
                });
              }
            }
          } catch {}

          robeMeta[nome].noPagesStrikes += 1;
          robeMeta[nome].lastNoPagesAt = Date.now();
          await appendIssueNurseDebounced(nome, `suspect_no_pages`, `strike=${robeMeta[nome].noPagesStrikes}`, 'suspect_no_pages');
          if (robeMeta[nome].noPagesStrikes >= 2 && (Date.now() - robeMeta[nome].lastNoPagesAt) >= 5000) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_nopages`, `Strikes=${robeMeta[nome].noPagesStrikes}`, 'action_nurse_kill_nopages');
            await registerFailure(nome, 'no_pages', 'external');
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].noPagesStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].noPagesStrikes = 0;
      }

      const p0 = pages[0];
      try {
        // Se a flag LR já está setada (persistida), capture evidência do estado atual
        // para provar se é falso positivo (ex.: já está logado mas flag ficou presa).
        try {
          const flags = await readAccountFlags(nome).catch(()=>({}));
          if (flags && flags.loginRequired === true) {
            const captured = await captureLoginRequiredEvidence(nome, p0, { reason: 'flag_snapshot' });
            if (captured) {
              let urlNow = null, titleNow = null;
              try { urlNow = (typeof p0.url === 'function') ? (p0.url() || null) : null; } catch {}
              try { titleNow = (typeof p0.title === 'function') ? (await p0.title().catch(()=>null)) : null; } catch {}
              appendJsonl(LR_EVENTS_JSONL, {
                ts: Date.now(),
                host: os.hostname(),
                perfil: nome,
                event: 'lr_flag_snapshot',
                storedReason: flags.loginReason || null,
                storedSource: flags.loginSource || null,
                url: urlNow,
                title: titleNow
              });
            }
          }
        } catch {}

        // === Enterprise: detectar loginRequired em QUALQUER aba (não só pages[0]) ===
        // Prioridade de motivos (mais grave primeiro)
        const reasonPriority = (r) => {
          const s = String(r || '').toLowerCase();
          if (s.includes('identity')) return 5;
          if (s.includes('captcha')) return 4;
          if (s.includes('checkpoint')) return 3;
          if (s.includes('login_form')) return 2;
          return 1;
        };
        let lr = null;
        let lrPage = p0;
        try {
          const scan = [];
          let hasMessengerTab = false;
          let hasMessengerOk = false;
          let weakCreateProbeFailed = null;
          for (const pg of (pages || []).slice(0, 8)) {
            let u = '';
            try { u = (typeof pg.url === 'function') ? (pg.url() || '') : ''; } catch {}
            // só avalia FB/Messenger
            if (!/(^https?:\/\/)?(www\.)?(facebook|messenger)\.com/i.test(String(u || ''))) continue;
            const det = await browserHelper.detectLoginRequired(pg).catch(()=>null);
            if (det && typeof det === 'object') {
              const urlNow = String(u || '');
              const domainNow = String(det.domain || '').toLowerCase();
              const reasonNow = String(det.reason || '').toLowerCase();
              const isMessengerTab = /messenger\.com/i.test(urlNow) || domainNow === 'messenger';
              const isCreateItemTab = /facebook\.com\/marketplace\/create\/(?:item|vehicle)\b/i.test(urlNow);

              scan.push({ u: urlNow.slice(0, 120), lr: !!det.loginRequired, reason: det.reason || null, domain: det.domain || null });

              if (isMessengerTab) hasMessengerTab = true;
              if (isMessengerTab && !det.loginRequired) hasMessengerOk = true;

              if (det.loginRequired) {
                // Regra de domínio: Virtus é decidido por Messenger.
                // "probe_failed" em create/item é sinal fraco quando Messenger está saudável.
                if (isCreateItemTab && reasonNow === 'probe_failed') {
                  weakCreateProbeFailed = { det, pg, url: urlNow };
                  continue;
                }
                if (!lr || reasonPriority(det.reason) > reasonPriority(lr.reason)) {
                  lr = det;
                  lrPage = pg;
                }
              }
            }
          }
          if (!lr && weakCreateProbeFailed && hasMessengerTab && hasMessengerOk) {
            try {
              provisionAudit.append({
                ts: Date.now(),
                event: 'lr_scan_weak_signal_ignored',
                nome: String(nome || ''),
                reason: 'probe_failed',
                sourceUrl: String(weakCreateProbeFailed.url || '').slice(0, 220),
                policy: 'messenger_domain_priority'
              });
            } catch {}
          } else if (!lr && weakCreateProbeFailed && !hasMessengerTab) {
            // Se não há Messenger disponível, mantém fallback para não ficar cego.
            lr = weakCreateProbeFailed.det;
            lrPage = weakCreateProbeFailed.pg;
          }
          // Log leve: scan (para auditoria e ajuste fino)
          try {
            const fs = require('fs');
            const path = require('path');
            const fp = path.join(__dirname, '..', 'dados', 'login_required_events.jsonl');
            fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), host: os.hostname(), perfil: nome, event: 'lr_scan_tabs', pages: scan }) + '\n');
          } catch {}

          // === Enterprise hardening (P0): auto-desengessar "probe_failed" quando o scan prova LR=false ===
          // Problema observado em produção (RM3): detectLoginRequired às vezes marca `probe_failed` (pessimista),
          // a automação pausa (virtus off), mas o próprio scan subsequente mostra LR=false em abas reais.
          // Guardrails:
          // - só atua se o flag persistido é loginRequired=true com reason=probe_failed
          // - só se o scan tem pelo menos 1 página FB/Messenger válida e TODAS têm lr=false
          // - precisa de streak (evita flapping) + debounce (evita loop)
          try {
            const now = Date.now();
            const scanHasPages = Array.isArray(scan) && scan.length > 0;
            const hasMessengerClear = hasMessengerTab && hasMessengerOk;
            const isHardReason = (r) => {
              const s = String(r || '').toLowerCase();
              if (!s) return false;
              return (
                s.includes('login_form') ||
                s.includes('captcha') ||
                s.includes('checkpoint') ||
                s.includes('two_factor') ||
                s.includes('2fa') ||
                s.includes('identity') ||
                s.includes('appeal') ||
                s.includes('banned') ||
                s.includes('suspended') ||
                s.includes('messenger_pin')
              );
            };
            // Menos rígido e mais robusto: limpar probe_failed preso quando Messenger está comprovadamente limpo
            // e não há nenhum sinal forte de bloqueio nas abas escaneadas.
            const scanAllClear = scanHasPages && hasMessengerClear && scan.every(p => p && p.lr === false && !isHardReason(p.reason));
            if (scanAllClear) {
              const flags = await readAccountFlags(nome).catch(()=>null);
              // Auto-heal de "virtus off" órfão:
              // quando Messenger está comprovadamente limpo e não há bloqueadores, não deixar conta presa em off.
              try {
                const wantNow = (desired && desired.perfis && desired.perfis[nome]) ? desired.perfis[nome] : {};
                const desiredVirtusOff = String((wantNow && wantNow.virtus) || '').toLowerCase() === 'off';
                const hasHardBlock =
                  !!(flags && (
                    flags.loginRequired === true ||
                    flags.loginRemediateFailed === true ||
                    flags.messengerPin === true ||
                    flags.banned === true ||
                    flags.twoFactor === true ||
                    flags.identityRequired === true ||
                    flags.identitySubmitted === true ||
                    flags.appealSubmitted === true
                  ));
                const ctrlNow = controllers.get(nome);
                const shouldHealVirtusOff =
                  desiredVirtusOff &&
                  !hasHardBlock &&
                  !!(wantNow && wantNow.active === true) &&
                  !!ctrlNow &&
                  ctrlNow.humanControl !== true &&
                  ctrlNow.configurando !== true &&
                  ctrlNow.trabalhando !== true;
                if (shouldHealVirtusOff) {
                  const nowHeal = Date.now();
                  robeMeta[nome] = robeMeta[nome] || {};
                  const lastHeal = Number(robeMeta[nome].lastVirtusOffAutoHealAt || 0) || 0;
                  if (!lastHeal || (nowHeal - lastHeal) > (10 * 60 * 1000)) {
                    robeMeta[nome].lastVirtusOffAutoHealAt = nowHeal;
                    await fileStore.withDesiredFileLockUpdate((d) => {
                      d = d || {};
                      d.perfis = d.perfis || {};
                      d.perfis[nome] = { ...(d.perfis[nome] || {}), active: true, virtus: 'on', humanHold: false };
                      return d;
                    }).catch(()=>{});
                    try {
                      provisionAudit.append({
                        ts: nowHeal,
                        event: 'virtus_off_auto_heal_messenger_clear',
                        nome: String(nome || ''),
                        policy: 'messenger_clear_no_hard_block'
                      });
                    } catch {}
                    setTimeout(() => { try { handlers.start_work({ nome, operator: 'virtus_off_auto_heal' }).catch(()=>{}); } catch {} }, 0);
                  }
                }
              } catch {}
              const reason0 = flags && typeof flags.loginReason === 'string' ? String(flags.loginReason || '') : '';
              const reasonNorm0 = String(reason0 || '').toLowerCase();
              // Auto-clear enterprise (stale LR):
              // além de probe_failed, também pode limpar login_form preso quando
              // o scan prova Messenger limpo + nenhuma aba com bloqueio real.
              const isClearableStaleReason =
                !reasonNorm0 ||
                reasonNorm0 === 'probe_failed' ||
                reasonNorm0 === 'login_form' ||
                reasonNorm0 === 'checkpoint_interstitial' ||
                reasonNorm0 === 'messenger_page_not_available';
              if (flags && flags.loginRequired === true && isClearableStaleReason) {
                robeMeta[nome] = robeMeta[nome] || {};
                const lastClearAt = Number(robeMeta[nome].lastLRAutoClearAt || 0) || 0;
                if (!lastClearAt || (now - lastClearAt) > (15 * 60 * 1000)) {
                  const prevTs = Number(robeMeta[nome].lrAutoClearStreakTs || 0) || 0;
                  const prev = Number(robeMeta[nome].lrAutoClearStreak || 0) || 0;
                  const next = (prevTs && (now - prevTs) < (2 * 60 * 1000)) ? (prev + 1) : 1;
                  robeMeta[nome].lrAutoClearStreak = next;
                  robeMeta[nome].lrAutoClearStreakTs = now;
                  if (next >= 3) {
                    robeMeta[nome].lastLRAutoClearAt = now;
                    robeMeta[nome].lrAutoClearStreak = 0;
                    robeMeta[nome].lrAutoClearStreakTs = 0;
                    await clearAccountFlags(nome, ['loginRequired','loginRemediateFailed','messengerPin']).catch(()=>{});
                    try {
                      provisionAudit.append({
                        ts: now,
                        event: 'lr_auto_clear_stale',
                        nome: String(nome||''),
                        streak: next,
                        storedReason: reasonNorm0 || null,
                        pages: scan.length
                      });
                    } catch {}
                    try {
                      appendJsonl(LR_EVENTS_JSONL, {
                        ts: now,
                        host: os.hostname(),
                        perfil: nome,
                        event: 'lr_auto_clear',
                        storedReason: reasonNorm0 || '',
                        method: 'lr_scan_tabs_all_clear',
                        streak: next,
                        pages: scan
                      });
                    } catch {}
                    // Retoma trabalho sem forçar open/close (nurse faz o resto)
                    setTimeout(() => { try { handlers.start_work({ nome, operator: 'lr_auto_clear_stale' }).catch(()=>{}); } catch {} }, 0);
                  }
                }
              }
            } else {
              // se o scan não está "limpo", zera streak (evita limpar em cenário flapping/ambíguo)
              try {
                robeMeta[nome] = robeMeta[nome] || {};
                robeMeta[nome].lrAutoClearStreak = 0;
                robeMeta[nome].lrAutoClearStreakTs = 0;
              } catch {}
            }
          } catch {}
        } catch {}

        if (lr && lr.loginRequired) {
          try {
            const prev = await readAccountFlags(nome).catch(()=>({}));
            const prevLR = !!(prev && prev.loginRequired === true);
            const prevReason = prev && typeof prev.loginReason === 'string' ? prev.loginReason : '';
            const prevSource = prev && typeof prev.loginSource === 'string' ? prev.loginSource : '';
            const curReason = String(lr.reason || '');
            const curSource = String(lr.domain || '');
            const changed = !(prevLR && (String(prevReason) === curReason) && (String(prevSource) === curSource));
            const captured = await captureLoginRequiredEvidence(nome, lrPage || p0, lr);
            if (captured || changed) {
              appendJsonl(LR_EVENTS_JSONL, {
                ts: Date.now(),
                host: os.hostname(),
                perfil: nome,
                event: 'lr_detected',
                reason: curReason,
                source: curSource,
                url: lr.url || null,
                title: lr.title || null,
                evidence: lr.evidence || null
              });
            }

            // GPT fallback (central): envia evidência redacted para o sitechatbot classificar e registrar padrões.
            // Guardrails:
            // - só envia se LOG_INGEST_SECRET estiver configurado (segurança)
            // - rate-limit 30min por perfil+reason (no cliente e também no servidor central)
            try {
              // Evita custo se não houver chance real de envio
              const cfg = (() => { try { return readCtConfig(); } catch { return null; } })();
              const secret = String((cfg && cfg.logIngestSecret) ? cfg.logIngestSecret : (process.env.LOG_INGEST_SECRET || '')).trim();
              if (secret) {
                robeMeta[nome] = robeMeta[nome] || {};
                const now = Date.now();
                const last = Number(robeMeta[nome].lastFbGptIngestAt || 0) || 0;
                if (!last || (now - last) > (30 * 60 * 1000)) {
                  // Para reduzir custo: envia só quando capturou evidência ou houve mudança no motivo
                  if (captured || changed) {
                    const html = await (lrPage || p0).content().catch(()=>null);
                    await gptFallback.ingestFbGpt({
                      perfil: nome,
                      url: lr.url || null,
                      title: lr.title || null,
                      html: html || '',
                      reason: curReason || null,
                      source: `lr:${curSource || 'unknown'}`
                    }).catch(()=>{});
                    robeMeta[nome].lastFbGptIngestAt = now;
                  }
                }
              }
            } catch {}

            // Classificação enterprise do LR (sem achismo):
            // - Identidade => marca identityRequired/Submitted e roda assist (sem humano invocado)
            // - Captcha/Checkpoint => marca captchaCheckpoint e aqui SIM invoca humano automaticamente (ordem do usuário)
            try {
              const rr = String(curReason || '').toLowerCase();
              if (rr.includes('identity_submitted')) {
                await setIdentitySubmittedFlag(nome, { source: curSource || '', url: lr.url || '', title: lr.title || '' }).catch(()=>{});
              } else if (rr.includes('identity_confirm') || rr === 'identity' || rr.startsWith('identity_') || rr.includes('identity')) {
                await setIdentityRequiredFlag(nome, { source: curSource || '', url: lr.url || '', title: lr.title || '' }).catch(()=>{});
                // AÇÃO AUTOMÁTICA (ultra enterprise): se caiu em identidade, executa o fluxo multi-step
                // com gate/cooldown + refresh + reclassificação.
                try {
                  const pg = (lrPage || p0);
                  if (pg && ctrl && ctrl.browser && ctrl.browser.isConnected?.()) {
                    await runIdentityFlow(nome, ctrl, pg, { source: 'lr_scan' }).catch(()=>null);
                  }
                } catch {}
              } else if (rr.includes('captcha') || rr.includes('checkpoint')) {
                await setCaptchaCheckpointFlag(nome, { reason: rr || 'captcha_checkpoint', source: curSource || '', url: lr.url || '', title: lr.title || '' }).catch(()=>{});
              }
            } catch {}
          } catch {}
          // 2FA => exclusão automática (não é humano, não é automação)
          try {
            const rr0 = String(lr && lr.reason || '').toLowerCase();
            if (rr0.includes('two_factor') || rr0.includes('2fa') || rr0.includes('two factor')) {
              try { await issues.append(nome, 'mil_action', `two_factor_detected_autodelete reason=${rr0}`); } catch {}
              try { await setTwoFactorFlag(nome, { reason: rr0 || 'two_factor', snippet: String(lr && lr.title || '') }); } catch {}
              // Perfil pode ter sido deletado; sair do fluxo atual.
              return;
            }
          } catch {}
          // Mantém também o flag genérico para rastreio, mas sem mascarar identidade/captcha:
          await setLoginRequiredFlag(nome, { reason: lr.reason || '', source: lr.domain || '' });

          // Enterprise autopilot:
          // - login_form => tentar auto-remediação (cookies -> login/senha) com mínimo impacto (1 por vez)
          // - captcha/checkpoint => segurar em humanHold (não existe automação confiável)
          try {
            const rr = String(lr && lr.reason || '').toLowerCase();
            if (rr.includes('appeal_submitted') || rr.includes('appeal')) {
              try { await issues.append(nome, 'mil_action', `appeal_submitted_hold reason=${rr}`); } catch {}
              try {
                await setAppealSubmittedFlag(nome, {
                  source: lr.domain || '',
                  url: lr.url || '',
                  title: lr.title || ''
                });
              } catch {}
            } else if (rr.includes('login_form')) {
              // Blindagem anti-loop: se já falhou e foi marcado, não re-tenta automaticamente.
              try {
                const flags = await readAccountFlags(nome).catch(()=>({}));
                if (flags && flags.loginRemediateFailed === true) {
                  try { await issues.append(nome, 'mil_action', 'auto_login_remediate_skip(loginRemediateFailed=true)'); } catch {}
                } else {
                  const okQueue = queueAutoLoginRemediate(nome, { reason: lr.reason || '', source: lr.domain || '', immediate: true });
                  if (okQueue) {
                    try { await issues.append(nome, 'mil_action', `auto_login_remediate_queued reason=${String(lr.reason||'').slice(0,80)}`); } catch {}
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
      try {
        const bd = await browserHelper.detectAccountSuspended(p0);
        if (bd && bd.banned) {
          await setBannedFlag(nome, { reason: bd.reason || '', snippet: bd.snippet || '' });
        }
      } catch {}

      // Curador enterprise: PIN do Messenger / "Continuar sem restaurar?"
      try {
        // Só tenta curar quando NÃO está configurando e não está com Robe executando (evita interferir no fluxo de postagem)
        if (ctrl && !ctrl.configurando && !(robeMeta[nome] && robeMeta[nome].emExecucao === true) && ctrl.browser && typeof ctrl.browser.pages === 'function') {
          robeMeta[nome] = robeMeta[nome] || {};
          const nowp = Date.now();
          const cd = Number(robeMeta[nome].pinCooldownUntil || 0) || 0;
          if (cd && cd > nowp) {
            // Anti-loop: se já tentamos recentemente, não mexer no modal (evita “piscar” infinito)
            // (o login_remediate/configure também tenta em momentos próprios).
          } else {
          const lastScan = Number(robeMeta[nome].lastPinScanAt || 0) || 0;
          if (!lastScan || (nowp - lastScan) > 8000) {
            robeMeta[nome].lastPinScanAt = nowp;
            let pagesAll = [];
            try { pagesAll = await ctrl.browser.pages(); } catch { pagesAll = []; }

            // log curto: sempre registra scan (cria messenger_pin.jsonl para auditoria via fetch_logs)
            let scan = [];
            let anyPresent = false;
            let firstMatch = null;
            for (const pg of pagesAll.slice(0, 8)) {
              let urlNow = '';
              try { urlNow = (typeof pg.url === 'function') ? (pg.url() || '') : ''; } catch {}
              const detPin = await browserHelper.detectMessengerPinModal(pg).catch(()=>({ present:false }));
              scan.push({ u: String(urlNow || '').slice(0, 140), p: !!detPin.present, k: detPin.kind || null });
              if (detPin && detPin.present && !firstMatch) firstMatch = { pg, det: detPin, urlNow };
              if (detPin && detPin.present) anyPresent = true;
            }
            try {
              const fsSync2 = require('fs');
              const path2 = require('path');
              const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
              fsSync2.appendFileSync(p, JSON.stringify({ ts: nowp, src:'worker.js', perfil:nome, event:'scan', pages: scan }) + '\n');
            } catch {}

            if (firstMatch) {
              try { await issues.append(nome, 'mil_action', `messenger_pin_seen kind=${firstMatch.det.kind||''}`); } catch {}
              // Anti-loop: ao ver PIN_INPUT, não usar GPT (pode clicar em X/voltar e ficar “piscando”).
              await browserHelper.tryDismissMessengerPinModal(firstMatch.pg, { logPrefix: '[NURSE][PIN]', maxTries: 2 }).catch(()=>null);
              // Cooldown pós tentativa: dá tempo do Messenger processar e evita re-tentativa imediata.
              robeMeta[nome].pinCooldownUntil = Date.now() + 45_000;
              const still = await browserHelper.detectMessengerPinModal(firstMatch.pg).catch(()=>({ present:false }));
              if (still && still.present) {
                // PIN_INPUT: não chamar GPT. Apenas marcar flag para humano ver, mas sem loop.
                await setMessengerPinFlag(nome, { reason: still.kind || 'messenger_pin_modal', source: 'nurse' });
                try {
                  const fsSync2 = require('fs');
                  const path2 = require('path');
                  const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
                  fsSync2.appendFileSync(p, JSON.stringify({ ts: Date.now(), src:'worker.js', perfil:nome, event:'pin_still_present', kind: still.kind||null, url: String(firstMatch.urlNow||'').slice(0, 220) }) + '\n');
                } catch {}
              } else {
                await clearAccountFlags(nome, ['messengerPin']).catch(()=>{});
                try {
                  const fsSync2 = require('fs');
                  const path2 = require('path');
                  const p = path2.join(__dirname, '..', 'dados', 'messenger_pin.jsonl');
                  fsSync2.appendFileSync(p, JSON.stringify({ ts: Date.now(), src:'worker.js', perfil:nome, event:'pin_cleared', url: String(firstMatch.urlNow||'').slice(0, 220) }) + '\n');
                } catch {}
              }
            } else if (!anyPresent) {
              // se não há PIN em nenhuma aba, limpa flag (se existir)
              await clearAccountFlags(nome, ['messengerPin']).catch(()=>{});
            }
          }
          }
        }
      } catch {}
      let det = { blocked:false };
      try {
        const urlNow = (typeof p0.url === 'function') ? (p0.url() || '') : '';
        const isMessenger = /messenger.com/i.test(urlNow);
        const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const isCreateOrSellerRoute =
          /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

        if (isMessenger) {
          det = await browserHelper.detectMessengerTempBlock(p0);
          det.domain = 'messenger';
        } else if (robeRunning || isCreateOrSellerRoute) {
          const deep = await detectLimitOverlayDeep(p0, { alsoCheckFrames: true }).catch(()=>null);
          if (deep && deep.blocked) {
            det = { blocked: true, domain: 'facebook' };
          } else {
            det = await browserHelper.detectMessengerTempBlock(p0);
            det.domain = det.domain || 'facebook';
          }
        }
      } catch {}

      robeMeta[nome] = robeMeta[nome] || {};
      robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow || [];
      let now2 = Date.now();

      if (det && det.blocked && det.domain === 'messenger') {
        robeMeta[nome].blockDetectWindow.push(now2);
        robeMeta[nome].blockDetectWindow = robeMeta[nome].blockDetectWindow.filter(ts => now2 - ts <= 5000);
        while (robeMeta[nome].blockDetectWindow.length > 8) robeMeta[nome].blockDetectWindow.shift();

        if (robeMeta[nome].blockDetectWindow.length >= 2 && (!robeMeta[nome].blockHysteresisUntil || robeMeta[nome].blockHysteresisUntil < now2)) {
          await appendIssueNurseDebounced(nome, `action_virtus_block`, `blockDetectWindow=${robeMeta[nome].blockDetectWindow.length}`, 'action_virtus_block');
          robeMeta[nome].blockHysteresisUntil = now2 + 15*60*1000;
          if (killGuardActive(nome)) {
            await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)', 'guard_skip_block');
            continue;
          }
          await stopVirtus(nome);
          if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > now2)) {
            robeMeta[nome].reopenAt = now2 + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + Math.floor(Math.random() * 21 + 5) * 60 * 1000;
            robeMeta[nome].closingReason = 'virtus_block';
          }
          await registerFailure(nome, 'messenger_temp_block', 'external');
          await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
          setKillGuard(nome);
          await snapshotStatusAndWrite();
          continue;
        } else {
          await appendIssueNurseDebounced(nome, `suspect_messenger_block`, `strike=${robeMeta[nome].blockDetectWindow.length}`, 'suspect_messenger_block');
          continue;
        }
      }
      if (robeMeta[nome].blockHysteresisUntil && robeMeta[nome].blockHysteresisUntil > now2) continue;

      if (det && det.blocked && det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      let anyFbBlocked = false;
      try {
        if (robeMeta[nome] && robeMeta[nome].emExecucao === true && ctrl && ctrl.browser) {
          anyFbBlocked = await detectFbLimitInAnyPage(ctrl);
        }
      } catch {}
      if (anyFbBlocked) {
        try { await issues.append(nome, 'block_detected', 'domain=facebook multi-page=true'); } catch {}
        const nowf = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man && man.robeCooldownUntil ? (man.robeCooldownUntil - nowf) : 0;
          if (!man || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = nowf + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'preserve_limit_posting_on_fb_block');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }

      const hs2 = getHealth && getHealth(nome);
      if (hs2 && (hs2.stage === 'recover1' || hs2.stage === 'recover2' || hs2.stage === 'recover3')) {
        continue;
      }

      let healthy = await pageReadyBasic(p0);
      if (!healthy) {
        if (robeMeta[nome].recoveryHysteresisUntil && robeMeta[nome].recoveryHysteresisUntil > Date.now()) {
          await appendIssueNurseDebounced(nome, 'hysteresis_skip', 'Aguardando histerese pós-recover', 'hysteresis_skip_after_recover');
          continue;
        }

        robeMeta[nome] = robeMeta[nome] || {};
        const nowReload = Date.now();
        if (!robeMeta[nome].reloadAttemptsWindow) robeMeta[nome].reloadAttemptsWindow = [];
        robeMeta[nome].reloadAttemptsWindow = robeMeta[nome].reloadAttemptsWindow.filter(ts => nowReload - ts < 60000);

        robeMeta[nome].reloadAttemptsWindow.push(nowReload);
        while (robeMeta[nome].reloadAttemptsWindow.length > 8) robeMeta[nome].reloadAttemptsWindow.shift();

        if (robeMeta[nome].reloadAttemptsWindow.length > 3) {
          robeMeta[nome].reloadBlockedUntil = nowReload+60000;
          await reportAction(nome, 'mil_action', 
            `nurse_reload_blocked: Excesso de reloads (${robeMeta[nome].reloadAttemptsWindow.length}) em 60s, url=${((p0.url&&p0.url())||'')}`
          );
          continue;
        }
        if (robeMeta[nome].reloadBlockedUntil && robeMeta[nome].reloadBlockedUntil > nowReload) {
          continue;
        }

        healthy = await tryReloadShort(p0, nome, 1);
        if (!healthy) {
          healthy = await tryReloadShort(p0, nome, 2);
        }
        if (healthy) {
          await reportAction(nome, 'mil_action', 'nurse_recover_success(reload)');
          robeMeta[nome].recoveryHysteresisUntil = Date.now() + 90000;
        } else {
          robeMeta[nome].zombieStrikes = robeMeta[nome].zombieStrikes || 0;
          robeMeta[nome].zombieStrikes += 1;
          await appendIssueNurseDebounced(nome, `suspect_page_zombie`, `strike=${robeMeta[nome].zombieStrikes}`, 'suspect_page_zombie');
          if (robeMeta[nome].zombieStrikes >= 2) {
            if (killGuardActive(nome)) {
              await appendIssueNurseDebounced(nome, 'guard_skip', 'Ação suprimida por kill_guard_until', 'guard_skip_page_zombie');
              continue;
            }
            // PATCH P1 START (anti-flap deactivate)
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            if (robeMeta[nome].lastDeactivateAt && (now - robeMeta[nome].lastDeactivateAt) < 10000) {
              await appendIssueNurseDebounced(nome, 'mil_action', 'deactivate_backoff_skip', 'deactivate_backoff_skip');
              continue;
            }
            robeMeta[nome].lastDeactivateAt = now;
            // PATCH P1 END
            await appendIssueNurseDebounced(nome, `action_nurse_kill_page_zombie`, `Strike=${robeMeta[nome].zombieStrikes}`, 'action_nurse_kill_page_zombie');
            try { registerFailure(nome, 'zombie', 'external'); } catch {}
            await handlers.deactivate({ nome, reason: 'nurse_zombie', policy: 'preserveDesired' });
            setKillGuard(nome);
            robeMeta[nome].zombieStrikes = 0;
            continue;
          }
          continue;
        }
      } else {
        robeMeta[nome].zombieStrikes = 0;
      }

      try {
        const url = p0.url ? p0.url() : '';
        if (/messenger\.com\/.*marketplace/i.test(url) && !ctrl.configurando && !(robeMeta[nome] && robeMeta[nome].emExecucao)) {
          const ph = getPhantomState(nome);
          const snap = await evaluateChatsState(p0);
          if (isOkFromSnapshot(snap)) {
            ph.lastOkAt = Date.now(); ph.firstSeenAt = 0;
          } else {
            const now = Date.now();
            if (isPhantomFromSnapshot(snap)) {
              if (!ph.firstSeenAt) ph.firstSeenAt = now;
              const elapsed = now - ph.firstSeenAt;
              const sinceOk = ph.lastOkAt ? (now - ph.lastOkAt) : Infinity;
              if (elapsed > PHANTOM_CFG.PERSIST_MS && sinceOk > PHANTOM_CFG.INITIAL_GRACE_MS) {
                await issues.append(nome, 'mil_action',
                  `phantom_detected rows=${snap.rows} anchors=${snap.anchors} sk=${snap.skeletons} elapsed=${elapsed}ms`);
                await tryFixPhantom(nome, p0);
              }
            } else if (snap.skeletons === 0) {
              ph.firstSeenAt = 0;
            }
          }
        }
      } catch {}

      if (ctrl && ctrl.configurando) {
        logger.info('[NURSE][SKIP PRUNE] Perfil em configuração, prune ignorado', { nome });
        continue;
      }
      if (!(robeMeta[nome] && robeMeta[nome].emExecucao)) {
        try { await closeExtraPages(ctrl.browser, p0, nome).catch(()=>{}); } catch {}
      }
      if (want.virtus === 'on' && automationAllowed(ctrl)) {
        // Se o governor mudou de modo, reinicia o runner do Virtus para aplicar slowMode sem derrubar browser/sessão.
        try {
          const curMode = (autoMode && autoMode.mode) ? autoMode.mode : 'full';
          const prevMode = ctrl._virtusGovernorMode || null;
          if (ctrl.virtus && prevMode && prevMode !== curMode) {
            await appendIssueNurseDebounced(nome, 'mil_action', `virtus_restart_due_governor prev=${prevMode} cur=${curMode}`, 'virtus_restart_due_governor');
            try { await stopVirtus(nome); } catch {}
          }
        } catch {}
        try {
          ctrl.virtus = virtusHelper.startVirtus(ctrl.browser, nome, {
            restrictTab: 0,
            epoch: ctrl.virtusEpoch || 0,
            slowMode: (autoMode && autoMode.mode !== 'full'),
            governorMode: (autoMode && autoMode.mode) || 'full'
          });
          ctrl._virtusGovernorMode = (autoMode && autoMode.mode) ? autoMode.mode : 'full';
          ctrl.trabalhando = true;
          try {
            const now = Date.now();
            if (!ctrl.virtus) {
              robeMeta[nome] = robeMeta[nome] || {};
              const last = Number(robeMeta[nome].dbgVirtusFalsyAt || 0) || 0;
              if (!last || (now - last) > 5 * 60 * 1000) {
                robeMeta[nome].dbgVirtusFalsyAt = now;
                try { provisionAudit.append({ ts: now, event: 'dbg_virtus_start_return_falsy', nome: String(nome||''), pid: process.pid, mode: (autoMode && autoMode.mode) ? String(autoMode.mode) : null }); } catch {}
              }
            }
          } catch {}
        } catch (e) {
          try {
            const now = Date.now();
            robeMeta[nome] = robeMeta[nome] || {};
            const last = Number(robeMeta[nome].dbgVirtusErrAt || 0) || 0;
            if (!last || (now - last) > 2 * 60 * 1000) {
              robeMeta[nome].dbgVirtusErrAt = now;
              const msg = (e && e.message) ? String(e.message) : String(e);
              try {
                provisionAudit.append({
                  ts: now,
                  event: 'dbg_virtus_start_error',
                  nome: String(nome||''),
                  pid: process.pid,
                  mode: (autoMode && autoMode.mode) ? String(autoMode.mode) : null,
                  error: msg.slice(0, 220)
                });
              } catch {}
            }
          } catch {}
        }
      }
    }
  } finally {
    _nurseTickRunning = false;
  }
}

async function trySwapOpen(target) {
  // Ultra enterprise: nunca executar swap agressivo durante provisionamento.
  // O provisionamento tem seu próprio fluxo de liberação mínima de RAM (dashboard hardRecoverRam)
  // e o supervisor já bloqueia aberturas de terceiros via maintenance_provision.
  try { if (provisionLock.isActive()) return false; } catch {}

  const aliveNames = Array.from(controllers.keys());
  if (aliveNames.length <= 1) return false;

  const free0 = getAvailableMB();
  const minNeed = getOpenMinFreeMB(''); // operação normal (sem owner do lock)
  const deficit = Math.max(0, (Number(minNeed || 0) || 0) - (Number(free0 || 0) || 0));
  // Se não há déficit de RAM, não fazer swap. (Evita fechar dezenas por erro de slots/transiente)
  if (deficit <= 0) return false;

  // Cap militar: nunca fechar muitos perfis numa única tentativa.
  const MAX_SWAP_KILLS = Math.max(0, parseInt(process.env.SWAP_OPEN_MAX_KILLS || '2', 10) || 2);
  let closed = 0;
  let freedEstimate = 0;

  const candidates = aliveNames
    .filter(n => n !== target)
    .map(n => ({
      n,
      mb: (typeof robeMeta[n]?.ramMB === 'number') ? robeMeta[n].ramMB : -1,
      emExecucao: robeMeta[n]?.emExecucao,
      configurando: controllers.get(n)?.configurando,
      humanControl: controllers.get(n)?.humanControl
    }))
    .filter(c => !c.configurando && !c.emExecucao && !c.humanControl && c.mb >= (process.platform==='win32' ? 900 : 700))
    .sort((a, b) => b.mb - a.mb);

  for (const cand of candidates) {
    if (closed >= MAX_SWAP_KILLS) break;
    if (freedEstimate >= (deficit + 128)) break; // margem pequena p/ evitar “apertado”
    if (killGuardActive(cand.n)) continue;
    await issues.append(cand.n, 'mil_action', `swap_kill fechamento para abrir ${target} RAM=${cand.mb}MB`);
    logger.info('[SWAP] swap_kill', { fechar: cand.n, abrir: target, ramMB: cand.mb });
    await handlers.deactivate({ nome: cand.n, reason: 'swap_for_open', policy: 'preserveDesired' });
    setKillGuard(cand.n, 45000);
    await new Promise(r=>setTimeout(r, 2000));
    closed++;
    freedEstimate += Math.max(0, Number(cand.mb || 0) || 0);
  }

  if (closed <= 0) return false;

  // Tenta abrir uma única vez após liberar o mínimo necessário.
  const r = await activateOnce(target, 'nurse_swap');
  if (r && r.ok) {
    await issues.append(target, 'mil_action', `swap_open_success closed=${closed} deficit=${deficit}MB`);
    robeMeta[target] = robeMeta[target] || {};
    robeMeta[target].lastSwapAt = Date.now();
    logger.info('[SWAP] swap_open_success', { target, closed, deficitMB: deficit });
    return true;
  }
  await issues.append(target, 'mil_action', `swap_open_failed closed=${closed} deficit=${deficit}MB err=${(r && r.error) || ''}`);
  logger.warn('[SWAP] swap_open_failed', { target, closed, deficitMB: deficit, err: (r && r.error) || '' });
  return false;
}

// =========================
// P0 hardening: post stock_provision resume (sharded)
// =========================
let _spLastActive = null;
let _spLastOwner = null;
let _spLastKind = null;
let _spLastUntilMs = 0;

function _readProvisionLockSnapSafe() {
  try {
    const lk = provisionLock.get ? provisionLock.get() : (provisionLock.isActive() ? { active: true, lock: null } : { active: false, lock: null });
    const active = !!(lk && lk.active);
    const lock = lk && lk.lock ? lk.lock : null;
    const owner = lock && lock.owner ? String(lock.owner) : null;
    const kind = (lock && lock.meta && lock.meta.kind) ? String(lock.meta.kind) : null;
    const untilMs = lock && lock.untilMs ? Number(lock.untilMs) : 0;
    return { ok: true, active, owner, kind, untilMs, lock };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), active: false, owner: null, kind: null, untilMs: 0, lock: null };
  }
}

function stockProvisionLockWatchTick() {
  // Detecta transição active->inactive com owner stock_provision
  const snap = _readProvisionLockSnapSafe();
  const active = !!snap.active;
  const owner = snap.owner || null;
  const kind = snap.kind || (owner && /^stock_provision:/i.test(owner) ? 'stock_provision' : null);
  const untilMs = Number(snap.untilMs || 0) || 0;

  if (_spLastActive === null) {
    _spLastActive = active;
    _spLastOwner = owner;
    _spLastKind = kind;
    _spLastUntilMs = untilMs;
    return;
  }

  const wasActive = !!_spLastActive;
  const wasOwner = _spLastOwner;
  const wasKind = _spLastKind;
  const wasUntil = Number(_spLastUntilMs || 0) || 0;

  _spLastActive = active;
  _spLastOwner = owner;
  _spLastKind = kind;
  _spLastUntilMs = untilMs;

  // Transição: ativo -> inativo
  if (wasActive && !active) {
    const wasStockProvision = (wasKind === 'stock_provision') || (wasOwner && /^stock_provision:/i.test(String(wasOwner)));
    if (wasStockProvision) {
      const w = writeStockProvisionEndMarker({ owner: wasOwner || null, kind: 'stock_provision', untilMs: wasUntil || 0 });
      try {
        provisionAudit.append({
          ts: Date.now(),
          event: 'stock_provision_lock_end_detected',
          ok: !!(w && w.ok),
          owner: wasOwner || null,
          untilMs: wasUntil || 0
        });
      } catch {}
    }
  }
}

async function stockProvisionResumeTick() {
  try {
    if (provisionLock && provisionLock.isActive && provisionLock.isActive()) return;
  } catch {}

  const marker = _readJsonSafe(STOCK_PROVISION_LAST_END_MARKER, null);
  if (!marker || !marker.ts) return;

  const maxAgeMs = Math.max(30_000, parseInt(process.env.STOCK_PROVISION_RESUME_MAX_AGE_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000));
  if ((Date.now() - Number(marker.ts || 0)) > maxAgeMs) return;

  robeMeta.system = robeMeta.system || {};
  const lastDone = Number(robeMeta.system.stockProvisionResumeLastTs || 0) || 0;
  if (lastDone >= Number(marker.ts || 0)) return;

  // Rate limit global por worker (evita loop caso esteja falhando por alguma razão)
  const lastTry = Number(robeMeta.system.stockProvisionResumeLastTryAt || 0) || 0;
  if (lastTry && (Date.now() - lastTry) < 10_000) return;
  robeMeta.system.stockProvisionResumeLastTryAt = Date.now();

  const maxOpen = Math.max(0, parseInt(process.env.STOCK_PROVISION_RESUME_MAX_OPEN_PER_TICK || '2', 10) || 2);
  const maxStart = Math.max(1, parseInt(process.env.STOCK_PROVISION_RESUME_MAX_START_PER_TICK || '12', 10) || 12);

  let desired = null;
  try { desired = readJsonFile(desiredPath, { perfis: {} }); } catch { desired = { perfis: {} }; }
  const perfis = desired && desired.perfis && typeof desired.perfis === 'object' ? desired.perfis : {};

  const candidates = [];
  for (const nome of Object.keys(perfis)) {
    const w = perfis[nome] || {};
    if (w.active !== true) continue;
    if (w.humanHold === true) continue;
    const v = String(w.virtus || '').toLowerCase();
    if (v === 'off') continue;
    if (SHARD_SET.size && !inShard(nome)) continue;
    candidates.push(String(nome));
  }

  let opened = 0;
  let started = 0;
  let skipped = 0;
  let errors = 0;
  const op = `stock_provision_resume:${Number(marker.ts || 0) || Date.now()}`;

  for (const nome of candidates) {
    if (started >= maxStart && opened >= maxOpen) break;

    const ctrl = controllers.get(nome);
    const hasBrowser = !!(ctrl && ctrl.browser && ctrl.browser.isConnected?.());
    const alreadyWorking = !!(ctrl && ctrl.trabalhando === true && ctrl.virtus);

    if (alreadyWorking) { skipped++; continue; }
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) { skipped++; continue; }

    if (hasBrowser) {
      if (started >= maxStart) { skipped++; continue; }
      const r = await handlers.start_work({ nome, operator: op }).catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
      if (r && r.ok) started++;
      else { errors++; }
      continue;
    }

    // Sem browser: tenta abrir + start_work (limitado)
    if (opened >= maxOpen) { skipped++; continue; }
    const a = await activateOnce(nome, 'stock_provision_resume', op).catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
    if (!a || a.ok !== true) { errors++; continue; }
    opened++;
    if (started < maxStart) {
      const r2 = await handlers.start_work({ nome, operator: op }).catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
      if (r2 && r2.ok) started++;
      else { errors++; }
    }
  }

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'stock_provision_post_resume_tick',
      markerTs: Number(marker.ts || 0) || 0,
      shardSize: SHARD_SET.size || 0,
      candidates: candidates.length,
      opened,
      started,
      skipped,
      errors
    });
  } catch {}

  // Se rodou e não teve erro, marca como done para este worker.
  // Mesmo com erros: não marcar done (próximos ticks tentam novamente; guardrails impedem storm).
  if (errors === 0) {
    robeMeta.system.stockProvisionResumeLastTs = Number(marker.ts || 0) || Date.now();
  }
}

setInterval(() => { nurseTick().catch(()=>{}); }, NURSE_CFG.INTERVAL_MS);
setTimeout(() => { nurseTick().catch(()=>{}); }, 2000);
// Watch do provision_lock e auto-resume pós stock_provision (P0 gaps)
setInterval(() => { try { stockProvisionLockWatchTick(); } catch {} }, 2000);
setInterval(() => { stockProvisionResumeTick().catch(()=>{}); }, 5000);
setTimeout(() => { try { stockProvisionLockWatchTick(); } catch {} }, 2500);
setTimeout(() => { stockProvisionResumeTick().catch(()=>{}); }, 5500);
// Autopilot login_remediate: roda em paralelo ao nurseTick, mas com guardrails (1 por vez + skip se provision_lock ativo)
setInterval(() => { autoLoginRemediateTick().catch(()=>{}); }, AUTO_LR_CFG.tickMs);
setTimeout(() => { autoLoginRemediateTick().catch(()=>{}); }, 3500);

// Inicializa reloadManager após todos os sistemas estarem prontos
reloadManager.startReloadManager(controllers, robeMeta);

async function wirePageObservers(nome, page) {
  const st = getHealth(nome);
  try {
    page.removeAllListeners && page.removeAllListeners('domcontentloaded');
    page.removeAllListeners && page.removeAllListeners('framenavigated');
    page.removeAllListeners && page.removeAllListeners('requestfinished');
    page.removeAllListeners && page.removeAllListeners('requestfailed');
    page.removeAllListeners && page.removeAllListeners('console');
    page.removeAllListeners && page.removeAllListeners('pageerror');
  } catch {}
  page.on('domcontentloaded', async () => {
    const st = getHealth(nome);
    st.lastDomEventAt = Date.now();
    try { st.lastTitle = await page.title().catch(()=>st.lastTitle); } catch {}
    try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
  });
  page.on('framenavigated', (frame) => {
    const st = getHealth(nome);
    if (frame === page.mainFrame()) {
      st.lastDomEventAt = Date.now();
      try { st.lastUrl = page.url ? page.url() : st.lastUrl; } catch {}
    }
  });
  page.on('requestfinished', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('requestfailed', () => { getHealth(nome).lastNetEventAt = Date.now(); });
  page.on('console', (msg) => { if (msg && msg.type && msg.type() === 'error') getHealth(nome).lastConsoleErrorAt = Date.now(); });
  page.on('pageerror', () => { getHealth(nome).lastConsoleErrorAt = Date.now(); });
}

async function isPageLikelyAlive(page, nome) {
  const st = getHealth(nome);
  const now = Date.now();
  const noDom = (now - st.lastDomEventAt) > HEALTH_CFG.DEAD_NO_DOM_MS;
  const noNet = (now - st.lastNetEventAt) > HEALTH_CFG.DEAD_NO_NET_MS;
  let readyOk = false, url = '';
  try {
    const rs = await Promise.race([
      page.evaluate(()=>document.readyState).catch(()=> 'err'),
      new Promise(res=>setTimeout(()=>res('timeout'), 1200))
    ]);
    readyOk = (rs === 'interactive' || rs === 'complete');
    url = page.url ? page.url() : '';
  } catch {}
  const aboutBlankStuck = (url === 'about:blank') && ((now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS);
  const urlIsFb = /facebook\.com|messenger\.com/i.test(url);
  const aliveBySignals = (!noDom || !noNet);
  const aliveByReady = (readyOk && urlIsFb && !aboutBlankStuck);
  return aliveBySignals || aliveByReady;
}

async function recoveryStep(nome, page, step) {
  const st = getHealth(nome);
  const now = Date.now();
  if (st.nextTryAt && st.nextTryAt > now) return false;
  if (step === 'reload') {
    st.counters.softReloads10m = _pruneWindow(st.counters.softReloads10m, 10*60*1000);
    if (st.counters.softReloads10m.length >= HEALTH_CFG.MAX_SOFT_RELOADS_10MIN) return false;
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); } catch {}
    st.counters.softReloads10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.reload;
    try { await issues.append(nome, 'mil_action', 'health_recover:reload'); } catch {}
    return true;
  }
  if (step === 'navHome') {
    st.counters.navHomes10m = _pruneWindow(st.counters.navHomes10m, 10*60*1000);
    if (st.counters.navHomes10m.length >= HEALTH_CFG.MAX_NAVHOME_10MIN) return false;
    try { await page.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{}); } catch {}
    st.counters.navHomes10m.push(Date.now());
    st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.navHome;
    try { await issues.append(nome, 'mil_action', 'health_recover:navHome'); } catch {}
    return true;
  }
  if (step === 'newPage') {
    if (st.newPageInFlight) return false;
    if (st.lastNewPageAt && (now - st.lastNewPageAt) < 90000) return false;
    st.counters.newPages30m = _pruneWindow(st.counters.newPages30m, 30*60*1000);
    if (st.counters.newPages30m.length >= HEALTH_CFG.MAX_NEWPAGE_30MIN) return false;
    st.newPageInFlight = true;
    try {
      const ctrl = controllers.get(nome);
      if (!ctrl || !ctrl.browser) return false;
      const np = await ctrl.browser.newPage();
      try {
        const man = await manifestStore.read(nome).catch(() => null);
        const coords = browserHelper.resolvePatchCoordsForProfile(nome, man || {});
        await browserHelper.patchPage(nome, np, coords);
      } catch {}
      await np.goto('https://www.messenger.com/marketplace', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
      try { await ctrl.mainPage.close({ runBeforeUnload: false }).catch(()=>{}); } catch {}
      ctrl.mainPage = np;
      await wirePageObservers(nome, np);
      st.counters.newPages30m.push(Date.now());
      st.nextTryAt = now + HEALTH_CFG.RECOVERY_COOLDOWN_MS.newPage;
      st.lastNewPageAt = now;
      try { await issues.append(nome, 'mil_action', 'health_recover:newPage'); } catch {}
      return true;
    } finally {
      st.newPageInFlight = false;
    }
  }
  return false;
}
async function escalateToReopen(nome, reason='health_reopen') {
  const ctrl = controllers.get(nome);
  try { await issues.append(nome, 'mil_action', `health_escalate:${reason}`); } catch {}
  if (killGuardActive(nome)) {
    await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until');
    return;
  }
  await handlers.deactivate({ nome, reason, policy: 'preserveDesired' });
  setKillGuard(nome);
  const st = getHealth(nome);
  st.stage = 'reopen';
  st.nextTryAt = Date.now() + 60000;
}

async function healthTick() {
  if (controllers.size === 0) { return; }
  for (const [nome, ctrl] of controllers) {
    if (robeMeta[nome] && robeMeta[nome].emExecucao === true) continue;
    if (ctrl && (ctrl.humanControl === true || ctrl.configurando === true)) continue;

    if (!ctrl || !ctrl.browser) continue;
    if (ctrl && ctrl.browser && ctrl.browser._sendLock && ctrl.browser._sendLock.active) {
      continue;
    }
    const st = getHealth(nome);
    const now = Date.now();
    let pages = [];
    try { pages = await ctrl.browser.pages(); } catch {}
    if (!pages || !pages[0]) continue;
    const page = pages[0];
    if (page && ctrl.mainPage !== page) {
      ctrl.mainPage = page;
      await wirePageObservers(nome, page);
    }

    let det = { blocked:false };
    try {
      const urlNow = (typeof page.url === 'function') ? (page.url() || '') : '';
      const isMessenger = /messenger.com/i.test(urlNow);
      const robeRunning = !!(robeMeta[nome] && robeMeta[nome].emExecucao === true);
      const isCreateOrSellerRoute =
        /facebook\.com\/marketplace\/(?:create|you\/selling|sell|listing|inventory|commerce_manager)/i.test(urlNow);

      if (isMessenger) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = 'messenger';
      } else if (robeRunning || isCreateOrSellerRoute) {
        det = await browserHelper.detectMessengerTempBlock(page);
        det.domain = det.domain || 'facebook';
      }
    } catch {}
    if (det && det.blocked) {
      if (det.domain === 'messenger') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        try { await stopVirtus(nome); } catch {}
        robeMeta[nome] = robeMeta[nome] || {};
        const jitterMs = (5 + Math.floor(Math.random() * 21)) * 60 * 1000;
        if (!(robeMeta[nome].reopenAt && robeMeta[nome].reopenAt > Date.now())) {
          robeMeta[nome].reopenAt = Date.now() + ULTRA_RECOVERY.REOPEN_DELAY_VIRTUS_BLOCK_MS + jitterMs;
          robeMeta[nome].closingReason = 'virtus_block';
        }
        try { registerFailure(nome, 'messenger_temp_block', 'external'); } catch {}
        if (killGuardActive(nome)) {
          await issues.append(nome, 'guard_skip', 'Ação suprimida por kill_guard_until (block)');
          continue;
        }
        await handlers.deactivate({ nome, reason: 'virtus_block', policy: 'preserveDesired' });
        setKillGuard(nome);
        await snapshotStatusAndWrite();
        continue;
      }
      if (det.domain === 'facebook') {
        try { await issues.append(nome, 'block_detected', `domain=${det.domain}`); } catch {}
        const now = Date.now();
        const plus24 = 24 * 60 * 60 * 1000;
        try {
          const man0 = await manifestStore.read(nome).catch(()=>null);
          const curLeft = man0 && man0.robeCooldownUntil ? (man0.robeCooldownUntil - now) : 0;
          if (!man0 || curLeft < 80*60*1000) {
            await manifestStore.update(nome, m => {
              m = m || {};
              m.robeCooldownUntil = now + plus24;
              m.robeCooldownRemainingMs = 0;
              return m;
            });
          }
        } catch {}
        const man = await manifestStore.read(nome).catch(()=>null);
        if (man && man.robePauseReason === 'limit_posting' && (man.robeCooldownUntil||0) > Date.now()) {
          await issues.append(nome, 'mil_action', 'health_detect_facebook_block_preserve_reason=limit_posting');
          await appendIssueNurseDebounced(nome, 'mil_action', 'status_force_limit_posting', 'status_force_limit_posting');
          await snapshotStatusAndWrite();
          continue;
        }
        robeMeta[nome] = robeMeta[nome] || {};
        robeMeta[nome].pauseReason = 'fb_block';
        robeMeta[nome].lastRobeBlockAt = Date.now();
        await snapshotStatusAndWrite();
        continue;
      }
    }

    if (isFrozenNow(nome)) continue;
    const alive = await isPageLikelyAlive(page, nome);
    if (alive) {
      st.lastOkAt = now;
      st.stage = 'ok';
      st.counters.cyclesWithoutLife = 0;
      continue;
    }
    const noEventsFor = Math.max(now - st.lastDomEventAt, now - st.lastNetEventAt);
    if (noEventsFor > HEALTH_CFG.DEAD_NO_EVENT_MS) {
      st.counters.cyclesWithoutLife++;
      if (st.stage === 'ok') st.stage = 'suspect';
    }
    try {
      const url = page.url ? page.url() : '';
      if (url === 'about:blank' && (now - st.lastDomEventAt) > HEALTH_CFG.ABOUT_BLANK_GRACE_MS) {
        if (await recoveryStep(nome, page, 'navHome')) continue;
      }
    } catch {}
    if (st.stage === 'suspect') {
      if (await recoveryStep(nome, page, 'reload')) { st.stage = 'recover1'; continue; }
      st.stage = 'recover1';
    } else if (st.stage === 'recover1') {
      if (await recoveryStep(nome, page, 'navHome')) { st.stage = 'recover2'; continue; }
      st.stage = 'recover2';
    } else if (st.stage === 'recover2') {
      if (await recoveryStep(nome, page, 'newPage')) { st.stage = 'recover3'; continue; }
      st.stage = 'recover3';
    } else if (st.stage === 'recover3') {
      if (st.counters.cyclesWithoutLife >= HEALTH_CFG.ESCALATE_TO_REOPEN_AFTER) {
        await escalateToReopen(nome, 'health_no_progress');
      }
    }
  }
}
setInterval(() => { healthTick().catch(()=>{}); }, HEALTH_CFG.TICK_MS);
setTimeout(() => { healthTick().catch(()=>{}); }, 2500);

// ====== LIMPEZA PERIÓDICA DE ABAS ABOUT:BLANK ÓRFÃS ======
// Varre todos os navegadores ativos e fecha abas about:blank que estão órfãs
// (criadas mas abandonadas quando Robe aborta/abandona postagem)
// Roda a cada 3 minutos - não agressivo, apenas limpa o que ficou esquecido
async function periodicAboutBlankCleanup() {
  try {
    const issues = require('./issues.js');
    let totalClosed = 0;

    for (const [nome, ctrl] of controllers.entries()) {
      try {
        if (!ctrl || !ctrl.browser || !ctrl.browser.isConnected?.()) continue;

        // Proteções: não limpa se Robe está ativo, configurando, ou em modo humano
        const inRobe = (ctrl.browser._robeActiveFor === nome) || (robeMeta[nome] && robeMeta[nome].emExecucao === true);
        const sendLockActive = ctrl.browser._sendLock && ctrl.browser._sendLock.active;
        const inConfig = ctrl.configurando === true;
        const inHuman = ctrl.humanControl === true;

        if (inRobe || sendLockActive || inConfig || inHuman) continue;

        // Varre todas as páginas procurando about:blank órfãs
        const pages = await ctrl.browser.pages().catch(() => []);
        if (!Array.isArray(pages) || pages.length <= 1) continue;

        const mainPage = ctrl.mainPage || pages[0];
        
        // Proteção extra: verifica se há create item aberto (só verifica uma vez)
        const hasCreateItem = pages.some(pg => {
          try {
            const u = pg.url ? pg.url() : '';
            return /facebook\.com\/marketplace\/create\/item/i.test(u);
          } catch { return false; }
        });
        
        // Se há create item, não limpa (pode ser que o Robe esteja prestes a usar)
        if (hasCreateItem) continue;

        let closed = 0;

        for (const p of pages) {
          try {
            // Nunca fecha a página principal
            if (p === mainPage) continue;
            if (!mainPage && p === pages[0]) continue;

            // Verifica se é about:blank
            let url = '';
            try { url = typeof p.url === 'function' ? p.url() : ''; } catch {}
            if (!url || url !== 'about:blank') continue;

            // Fecha a aba about:blank órfã
            // (já verificamos que não há Robe ativo e não há create item)
            await p.close({ runBeforeUnload: false }).catch(() => {});
            closed++;
          } catch {}
        }

        if (closed > 0) {
          totalClosed += closed;
          try {
            await issues.append(nome, 'mil_action', `periodic_cleanup_aboutblank n=${closed}`);
          } catch {}
        }
      } catch (e) {
        if (process.env.PRUNE_DEBUG === '1') {
          logger.warn('[PERIODIC_CLEANUP] Erro em perfil', { nome, error: e && e.message || e });
        }
      }
    }

    if (totalClosed > 0) {
      logger.info('[PERIODIC_CLEANUP] Fechou abas about:blank órfãs', { total: totalClosed });
    }
  } catch (e) {
    if (process.env.PRUNE_DEBUG === '1') {
      logger.warn('[PERIODIC_CLEANUP] Erro geral', { error: e && e.message || e });
    }
  }
}

// Roda a cada 3 minutos (180000ms) - não agressivo, apenas limpa o que ficou esquecido
setInterval(() => { periodicAboutBlankCleanup().catch(() => {}); }, 3 * 60 * 1000);
// Primeira execução após 30 segundos (dá tempo para sistema inicializar)
setTimeout(() => { periodicAboutBlankCleanup().catch(() => {}); }, 30000);

setInterval(() => {
  const now = Date.now();
  for (const nome of Object.keys(robeMeta)) {
    if (robeMeta[nome]?.frozenUntil && robeMeta[nome].frozenUntil > now && (robeMeta[nome].frozenUntil - now > 6 * 3600 * 1000)) {
      issues.append(nome, 'frozen_watchdog', 'Perfil congelado > 6h');
    }
    const desired = readJsonFile(desiredPath, { perfis: {} });
    if (desired.perfis?.[nome]?.active === true && !controllers.has(nome)) {
      issues.append(nome, 'stuck_activation', 'Desired ativo sem browser por >10min');
    }
  }
}, 10 * 60 * 1000);

let _shuttingDown = false;
async function gracefulShutdown(reason) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try {
    logger.info('[WORKER] gracefulShutdown start', { reason });
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'dbg_shutdown_begin',
        reason: String(reason || ''),
        pid: process.pid,
        controllersSize: controllers ? controllers.size : null
      });
    } catch {}
    try { robeQueue.clear(); } catch {}
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.virtus && typeof ctrl.virtus.stop === 'function') {
          await ctrl.virtus.stop().catch(()=>{});
        }
      } catch {}
    }
    for (const [nome, ctrl] of controllers) {
      try {
        if (ctrl && ctrl.browser && typeof ctrl.browser.close === 'function') {
          await ctrl.browser.close().catch(()=>{});
        }
      } catch {}
    }
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'dbg_shutdown_after_close',
        reason: String(reason || ''),
        pid: process.pid,
        controllersSize: controllers ? controllers.size : null
      });
    } catch {}
    // P0: após fechar browsers, limpar controllers e gravar status final (evita "ativos fantasmas" no próximo boot)
    try {
      const before = controllers ? controllers.size : null;
      try { controllers && controllers.clear && controllers.clear(); } catch {}
      const after = controllers ? controllers.size : null;
      provisionAudit.append({
        ts: Date.now(),
        event: 'dbg_shutdown_controllers_cleared',
        reason: String(reason || ''),
        pid: process.pid,
        before,
        after
      });
    } catch {}
    try { await snapshotStatusAndWrite(); } catch {}
    for (const nome of _pruners.keys()) stopPruneLoop(nome);
    if (ramMonitorInterval) try { clearTimeout(ramMonitorInterval); } catch{}
  } catch (e) {
    try { logger.error('[WORKER] gracefulShutdown exception', { reason, error: e && e.message || e }, e); } catch {}
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('disconnect', () => gracefulShutdown('disconnect'));

process.on('message', async (msg) => {
  if (!msg || !msg.type || !msg.msgId) return;
  const fn = handlers[msg.type];
  if (typeof fn !== 'function') {
    logger.warn('Comando desconhecido recebido', { type: msg.type, hasMsgId: !!msg.msgId });
    sendReply(msg.msgId, { ok: false, error: 'Comando desconhecido' });
    return;
  }
  try {
    const resp = await fn(msg.payload || {});
    sendReply(msg.msgId, resp);
  } catch (e) {
    logger.error('[WORKER][MESSAGE] handler error', { type: msg.type, error: e && e.message || e }, e);
    sendReply(msg.msgId, { ok: false, error: e && e.message || String(e) });
  }
});

const CDP_FATAL_RECOVERY_SWEEP_COOLDOWN_MS = Math.max(5000, parseInt(process.env.CONVENIENTE_CDP_FATAL_RECOVERY_SWEEP_COOLDOWN_MS || '15000', 10) || 15000);
let _lastCdpFatalRecoverySweepAt = 0;

async function runCdpFatalRecoverySweep({ source = '', msg = '' } = {}) {
  try {
    const now = Date.now();
    if ((now - _lastCdpFatalRecoverySweepAt) < CDP_FATAL_RECOVERY_SWEEP_COOLDOWN_MS) {
      try {
        logger.warn('[FATAL][WORKER] cdp_recovery_sweep_debounced', {
          source: String(source || ''),
          cooldownMs: CDP_FATAL_RECOVERY_SWEEP_COOLDOWN_MS
        });
      } catch {}
      return;
    }
    _lastCdpFatalRecoverySweepAt = now;
    const desired = readJsonFile(desiredPath, { perfis: {} }) || { perfis: {} };
    const entries = Array.from(controllers.entries());
    let scanned = 0;
    let recovered = 0;
    for (const [nome, ctrl] of entries) {
      scanned++;
      let connected = true;
      try {
        connected = !!(ctrl && ctrl.browser && typeof ctrl.browser.isConnected === 'function' ? ctrl.browser.isConnected() : true);
      } catch {
        connected = false;
      }
      if (connected) continue;
      try { await hardCloseController(nome, ctrl, { reason: 'cdp_fatal_soft_recover', allowKillUserDataDir: true }); } catch {}
      try { controllers.delete(nome); } catch {}
      try {
        const isDesiredActive = desired.perfis?.[nome]?.active === true;
        const isHold = desired.perfis?.[nome]?.humanHold === true;
        if (!isFrozenNow(nome) && isDesiredActive && !isHold) {
          robeMeta[nome] = robeMeta[nome] || {};
          robeMeta[nome].reopenAt = Date.now() + ULTRA_RECOVERY.REOPEN_DELAY_SHORT_MS;
          robeMeta[nome].closingReason = 'cdp_fatal_soft_recover';
          setKillGuard(nome, 5000);
          recovered++;
        }
      } catch {}
    }
    try {
      logger.warn('[FATAL][WORKER] cdp_recovery_sweep_done', {
        source: String(source || ''),
        scanned,
        recovered,
        msg: String(msg || '').slice(0, 220)
      });
    } catch {}
    try { await snapshotStatusAndWrite(); } catch {}
  } catch {}
}

process.on('uncaughtException', (e) => {
  try { logger.error('[FATAL][WORKER] uncaughtException', { error: e && e.message || e }, e); } catch {}
  try {
    const msg = String((e && e.message) || e || '');
    const isCdpFatal = /Target closed|Network\.enable|Protocol error.*Target|setUserAgentOverride/i.test(msg);
    if (isCdpFatal) {
      try { logger.warn('[FATAL][WORKER] CDP fatal detectado (sem exit de worker)', { source: 'uncaughtException' }); } catch {}
      runCdpFatalRecoverySweep({ source: 'uncaughtException', msg }).catch(() => {});
    } else {
      try { logger.warn('[FATAL][WORKER] processo continua (sem exit automático). Humano deve reiniciar: node index.js'); } catch {}
    }
  } catch {}
});
process.on('unhandledRejection', (e) => {
  try { logger.error('[FATAL][WORKER] unhandledRejection', { error: (e && e.message) || e }, e); } catch {}
  try {
    const msg = String((e && e.message) || e || '');
    const isCdpFatal = /Target closed|Network\.enable|Protocol error.*Target|setUserAgentOverride/i.test(msg);
    if (isCdpFatal) {
      try { logger.warn('[FATAL][WORKER] CDP fatal detectado (sem exit de worker)', { source: 'unhandledRejection' }); } catch {}
      runCdpFatalRecoverySweep({ source: 'unhandledRejection', msg }).catch(() => {});
    } else {
      try { logger.warn('[FATAL][WORKER] processo continua (sem exit automático). Humano deve reiniciar: node index.js'); } catch {}
    }
  } catch {}
});