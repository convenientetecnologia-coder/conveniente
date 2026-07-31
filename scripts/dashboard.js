"use strict";

// scripts/dashboard.js

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger.js');
const fotos = require('./fotos.js'); // ADICIONADO
const provisionLock = require('./provisionLock.js');
const ramPolicy = require('./ramPolicy.js');
const provisionAudit = require('./provisionAudit.js');
const fileStore = require('./fileStore.js');
const { readGroqConfig, readGroqConfigMeta, writeGroqConfig } = require('./groqConfig');
const gatewayProxy = require('./gatewayProxy');

const httpPort = parseInt(process.env.PORT || '8088', 10);
const POLL_INTERVAL_MS = parseInt(process.env.DASHBOARD_INTERVAL_MS || '30000', 10); // poll leve de comandos
const FULL_REPORT_INTERVAL_MS = parseInt(process.env.DASHBOARD_FULL_REPORT_INTERVAL_MS || '300000', 10); // 5 min padrão
const STATUS_PATH = path.join(__dirname, '..', 'dados', 'status.json');
const HOSTID_PATH = path.join(__dirname, '..', 'dados', '.telemetry_hostid');
const ACK_PENDING_PATH = path.join(__dirname, '..', 'dados', 'acks_pending.json');
const GATEWAY_RECYCLE_QUEUE_PATH = path.join(__dirname, '..', 'dados', 'gateway_recycle_queue.json');

// Endpoint do notificador (centralizado)
const { resolveEndpoints } = require('./notifierEndpoints');
const { readCtConfig } = require('./ctConfig');

let timer = null;
let inFlight = false;
let pending = false;
let lastWarnAt = 0;
let lastTickDoneAt = 0;
let gatewayRecycleQueueInFlight = false;
let lastFullReportAt = 0;

// ===== ALTERAÇÃO INÍCIO: adicionado hostIdCache ===========
let hostIdCache = null;
// ===== ALTERAÇÃO FIM =====================================
let lastJsonlAutoRotateAt = 0;
let virtusMetricsCache = { at: 0, key: '', value: null };

// ===== Guardrail: close_all durante provision =====
// Regras:
// - Se provision_lock ativo:
//   - close_all humano (UI): DEFERIR (não ACK até terminar a provisão; executa depois)
//   - close_all não-humano (deploy/script): BLOQUEAR (ACK erro imediato)
let deferredCloseAllCmdId = null;
let deferredCloseAllPayload = null;
let deferredCloseAllEnqueuedAt = 0;
function isHumanCloseAll(cmd) {
  const p = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : null;
  if (p && String(p.origin || '').toLowerCase() === 'ui') return true;
  if (p && String(p.origin || '').trim() && String(p.origin || '').toLowerCase() !== 'ui') return false;
  if (p && (p.human === true || p.manual === true)) return true;
  const reqId = p ? String(p.requestId || '') : '';
  if (/^(deploy_|deployall_|deploy_close_all_|deploy_all_close_|close_before_restart_|stabilize_)/i.test(reqId)) return false;
  // Compatibilidade: payload ausente normalmente é UI antiga → tratar como humano
  if (!p) return true;
  // Sem evidência de automação → tratar como humano (mais seguro: deferir do que executar no meio da provisão)
  return true;
}

function now() { return Date.now(); }
function debounceWarn(msg, ms = 60000) {
  const t = now();
  if ((t - lastWarnAt) >= ms) {
    lastWarnAt = t;
    logger.warn('[DASHBOARD] ' + msg);
  }
}

function ensureDirSync(p) {
  try { fsSync.mkdirSync(p, { recursive: true }); } catch {}
}

function randId() {
  try { return require('crypto').randomUUID(); }
  catch {
    const b = require('crypto').randomBytes(16);
    return [...b].map(x => x.toString(16).padStart(2,'0')).join('');
  }
}

async function getOrCreateHostId() {
  try {
    if (fsSync.existsSync(HOSTID_PATH)) {
      const v = fsSync.readFileSync(HOSTID_PATH, 'utf8').trim();
      if (v) return v;
    }
  } catch {}
  try {
    ensureDirSync(path.dirname(HOSTID_PATH));
    const id = randId();
    fsSync.writeFileSync(HOSTID_PATH, id, 'utf8');
    return id;
  } catch {
    return randId();
  }
}

// Função utilitária de fetch com timeout (NOVO)
function timeoutFetch(url, { timeoutMs = 3000, ...opt } = {}) {
  const ac = new (global.AbortController || require('node-abort-controller'))();
  const id = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);
  return fetch(url, { ...opt, signal: ac.signal }).finally(() => clearTimeout(id));
}

// Nova função: vê API, fallback para arquivos locais - PATCH CIRÚRGICO!
async function readAggregatedStatus() {
  // NOVO: HTTP local COM TIMEOUT aumentado para 15s (multi-node precisa de mais tempo)
  try {
    const res = await timeoutFetch(`http://127.0.0.1:${httpPort}/api/status`, { timeoutMs: 15000 });
    if (res && res.ok) {
      const st = await res.json();
      if (st && typeof st === 'object') return st;
    }
  } catch {
    logger && logger.warn && logger.warn('[DASH][TICK] api/status timeout (15s), using fallback');
  }
  // (2) Local status.json
  try {
    const raw = await fs.readFile(STATUS_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch {}
  // (3) Fallback: agrega todos os status_node_*.json
  try {
    const dir = path.join(__dirname, '..', 'dados');
    const files = fsSync.readdirSync(dir).filter(n => /^status_node_\d+.json$/i.test(n));
    const basePerfisArr = (() => {
      try { return JSON.parse(fsSync.readFileSync(path.join(dir, 'perfis.json'), 'utf8')) || []; }
      catch { return []; }
    })();
    const baseMap = new Map(basePerfisArr.map(p => [p.nome, {
      nome: p.nome,
      label: p.label || null,
      cidade: p.cidade,
      uaPresetId: p.uaPresetId,
      active: false, trabalhando: false, configurando: false, humanControl: false, issuesCount: 0,
      ramMB: null, cpuPercent: null, numPages: null, robeEstado: null, robeCooldownSec: null,
      robeFrozenUntil: null, frozenReason: null, frozenAt: null, frozenSetBy: null,
      activationHeldUntil: null, reopenAt: null, openBackoffMs: null, lastSwapAt: null, lastSwapPeer: null,
      swapCooldown: null, whyNotOpen: null, manifestStatus: null, closingReason: null
    }]));
    let combinedRobes = {};
    let combinedQueue = [];
    let sysPick = null;
    for (const f of files) {
      try {
        const j = JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || typeof j !== 'object') continue;
        const perf = Array.isArray(j.perfis) ? j.perfis : [];
        for (const o of perf) {
          const dst = baseMap.get(o && o.nome);
          if (!dst) continue;
          const ramBefore = dst.ramMB;
          const cpuBefore = dst.cpuPercent;
          Object.assign(dst, o);
          // Se o overlay atual não trouxe número, mantenha o valor numérico já presente
          if (typeof o.ramMB !== 'number' && typeof ramBefore === 'number') dst.ramMB = ramBefore;
          if (typeof o.cpuPercent !== 'number' && typeof cpuBefore === 'number') dst.cpuPercent = cpuBefore;
        }
        if (j.robes && typeof j.robes === 'object') {
          combinedRobes = Object.assign(combinedRobes, j.robes);
        }
        if (Array.isArray(j.robeQueue)) {
          combinedQueue.push(...j.robeQueue);
        }
        if (!sysPick && j.sys) sysPick = j.sys;
      } catch {}
    }
    if (combinedQueue.length) {
      const seen = new Set();
      combinedQueue = combinedQueue.filter(n => {
        if (!n || seen.has(n)) return false;
        seen.add(n); return true;
      });
    }
    return {
      perfis: Array.from(baseMap.values()),
      robes: combinedRobes,
      robeQueue: combinedQueue,
      sys: sysPick || {
        freeMB: Math.round(os.freemem()/(1024*1024)),
        totalMB: Math.round(os.totalmem()/(1024*1024)),
        cores: (os.cpus()||[]).length
      },
      ts: Date.now()
    };
  } catch (e) {
    return { perfis: [], robes: {}, robeQueue: [], ts: Date.now(), error: 'sem snapshot' };
  }
}

function buildUtcMinus3DayWindow(dayDelta) {
  const nowMs = Date.now();
  const shifted = new Date(nowMs - (3 * 60 * 60 * 1000));
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate() + (Number(dayDelta || 0) || 0);
  const startMs = Date.UTC(y, m, d, 3, 0, 0, 0);
  const endMs = startMs + (24 * 60 * 60 * 1000);
  return {
    startMs,
    endMs,
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000)
  };
}

function collectVirtusProfileNames(status) {
  const set = new Set();
  try {
    const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
    for (const p of perfis) {
      const nome = String(p && p.nome || '').trim();
      if (nome) set.add(nome);
    }
  } catch {}
  try {
    const desiredPath = path.join(__dirname, '..', 'dados', 'desired.json');
    if (fsSync.existsSync(desiredPath)) {
      const desired = JSON.parse(fsSync.readFileSync(desiredPath, 'utf8'));
      const perfisObj = (desired && typeof desired === 'object' && desired.perfis && typeof desired.perfis === 'object')
        ? desired.perfis
        : null;
      if (perfisObj) {
        for (const nome of Object.keys(perfisObj)) {
          const n = String(nome || '').trim();
          if (n) set.add(n);
        }
      }
    }
  } catch {}
  return Array.from(set);
}

function computeVirtusMetricsFromChats(status) {
  const names = collectVirtusProfileNames(status);
  const base = path.join(__dirname, '..', 'dados', 'perfis');
  const today = buildUtcMinus3DayWindow(0);
  const yesterday = buildUtcMinus3DayWindow(-1);
  let profilesWithFile = 0;
  let profilesMissingFile = 0;
  let parseErrors = 0;
  let todayCount = 0;
  let yesterdayCount = 0;

  for (const nome of names) {
    try {
      const fp = path.join(base, nome, 'chats_respondidos.json');
      if (!fsSync.existsSync(fp)) {
        profilesMissingFile += 1;
        continue;
      }
      profilesWithFile += 1;
      let obj = null;
      try {
        obj = JSON.parse(fsSync.readFileSync(fp, 'utf8'));
      } catch {
        parseErrors += 1;
        continue;
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
      for (const v of Object.values(obj)) {
        const t = Number(v || 0) || 0;
        if (!t) continue;
        if (t >= today.startSec && t < today.endSec) todayCount += 1;
        if (t >= yesterday.startSec && t < yesterday.endSec) yesterdayCount += 1;
      }
    } catch {
      parseErrors += 1;
    }
  }

  return {
    source: 'chats_respondidos',
    generatedAt: Date.now(),
    timezone: 'UTC-3',
    profiles: {
      expected: names.length,
      withFile: profilesWithFile,
      missingFile: profilesMissingFile,
      parseErrors
    },
    windows: {
      yesterday: {
        startSec: yesterday.startSec,
        endSec: yesterday.endSec,
        chatsRespondidos: yesterdayCount
      },
      today: {
        startSec: today.startSec,
        endSec: today.endSec,
        chatsRespondidos: todayCount
      }
    }
  };
}

function getVirtusMetricsCached(status) {
  try {
    const names = collectVirtusProfileNames(status).sort();
    const key = names.join('|');
    const nowMs = Date.now();
    if (virtusMetricsCache.value && virtusMetricsCache.key === key && (nowMs - Number(virtusMetricsCache.at || 0)) < 25000) {
      return virtusMetricsCache.value;
    }
    const value = computeVirtusMetricsFromChats(status);
    virtusMetricsCache = { at: nowMs, key, value };
    return value;
  } catch {
    return null;
  }
}

// Helper para verificar se é imagem
function isImage(name) { return /\.(jpe?g|png)$/i.test(String(name||'')); }

// ===== Backup restore (enterprise) =====
function _readJsonSafeSync(fp, fallback = null) {
  try { return JSON.parse(fsSync.readFileSync(fp, 'utf8')); } catch { return fallback; }
}
function _sha256FileBestEffort(fp) {
  try {
    const crypto = require('crypto');
    const buf = fsSync.readFileSync(fp);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch { return null; }
}
function _resolveBackupDir(inputPath) {
  const p = String(inputPath || '').trim();
  if (!p) return { ok: false, error: 'missing_backupDir' };
  const resolved = path.resolve(p);
  const roots = [
    path.resolve(path.join(__dirname, '..', '_backup_auto')),
    path.resolve(path.join(__dirname, '..', '_backup_auto_root'))
  ];
  const okPrefix = roots.some(r => (resolved === r) || resolved.startsWith(r + path.sep));
  if (!okPrefix) return { ok: false, error: 'backupDir_not_allowed', resolved, roots };
  if (!fsSync.existsSync(resolved)) return { ok: false, error: 'backupDir_not_found', resolved };
  return { ok: true, resolved, roots };
}
function _findBackupJsonFiles(backupDirResolved) {
  const candidates = [
    // backup root
    { perfis: path.join(backupDirResolved, 'perfis.json'), desired: path.join(backupDirResolved, 'desired.json') },
    // common layout: <backup>/dados/*.json
    { perfis: path.join(backupDirResolved, 'dados', 'perfis.json'), desired: path.join(backupDirResolved, 'dados', 'desired.json') },
  ];
  for (const c of candidates) {
    if (c.perfis && c.desired && fsSync.existsSync(c.perfis) && fsSync.existsSync(c.desired)) {
      return { ok: true, perfisPath: c.perfis, desiredPath: c.desired };
    }
  }
  // Partial info for diagnostics
  const tried = candidates.flatMap(c => [c.perfis, c.desired]).filter(Boolean);
  return { ok: false, error: 'backup_files_not_found', tried };
}

// ===== Backup inventory (enterprise): listar backups e detectar wipes =====
function _isBackupTagDirName(name) {
  const s = String(name || '').trim();
  // autoBackupWorker: YYYYMMDD_HHMMSS
  return /^\d{8}_\d{6}$/.test(s);
}

function _safeStatBestEffort(fp) {
  try { return fsSync.statSync(fp); } catch { return null; }
}

function _countPerfisBestEffort(fp) {
  try {
    const j = JSON.parse(fsSync.readFileSync(fp, 'utf8'));
    return Array.isArray(j) ? j.length : null;
  } catch { return null; }
}

function _countDesiredBestEffort(fp) {
  try {
    const j = JSON.parse(fsSync.readFileSync(fp, 'utf8'));
    const p = j && j.perfis && typeof j.perfis === 'object' ? j.perfis : null;
    return p ? Object.keys(p).length : null;
  } catch { return null; }
}

function _listBackupDirsUnder(rootDir, { limit = 200 } = {}) {
  try {
    if (!fsSync.existsSync(rootDir)) return [];
    const names = fsSync.readdirSync(rootDir).filter(_isBackupTagDirName);
    names.sort((a, b) => String(b).localeCompare(String(a))); // desc
    return names.slice(0, Math.max(1, Math.min(800, Number(limit || 0) || 200)));
  } catch {
    return [];
  }
}

async function execBackupsManifest(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const limit = Math.max(1, Math.min(800, Number(payload.limit || 200) || 200));
  const roots = [
    path.resolve(path.join(__dirname, '..', '_backup_auto')),
    path.resolve(path.join(__dirname, '..', '_backup_auto_root'))
  ];
  const requestedRoot = String(payload.root || 'auto').trim().toLowerCase(); // auto|_backup_auto|_backup_auto_root

  let rootUsed = null;
  let dirs = [];
  if (requestedRoot === '_backup_auto' || requestedRoot === 'backup_auto') {
    rootUsed = roots[0];
    dirs = _listBackupDirsUnder(rootUsed, { limit });
  } else if (requestedRoot === '_backup_auto_root' || requestedRoot === 'backup_auto_root') {
    rootUsed = roots[1];
    dirs = _listBackupDirsUnder(rootUsed, { limit });
  } else {
    // auto: prefer _backup_auto se existir e tiver dirs; fallback para _backup_auto_root
    const d1 = _listBackupDirsUnder(roots[0], { limit });
    const d2 = _listBackupDirsUnder(roots[1], { limit });
    if (d1 && d1.length) { rootUsed = roots[0]; dirs = d1; }
    else { rootUsed = roots[1]; dirs = d2; }
  }

  const backups = [];
  const errors = [];

  for (const tag of dirs) {
    const dir = path.join(rootUsed, tag);
    const ff = _findBackupJsonFiles(dir);
    if (!ff || ff.ok !== true) {
      errors.push({ tag, dir, error: ff && ff.error ? String(ff.error) : 'backup_files_not_found', tried: ff && ff.tried ? ff.tried : null });
      continue;
    }
    const stPerfis = _safeStatBestEffort(ff.perfisPath);
    const stDesired = _safeStatBestEffort(ff.desiredPath);
    const perfisBytes = stPerfis ? Number(stPerfis.size || 0) : null;
    const desiredBytes = stDesired ? Number(stDesired.size || 0) : null;
    const perfisMtimeMs = stPerfis ? Number(stPerfis.mtimeMs || 0) : null;
    const desiredMtimeMs = stDesired ? Number(stDesired.mtimeMs || 0) : null;

    // Counts são fundamentais para detectar wipe; payloads aqui são pequenos (~200KB), então parse é aceitável.
    const perfisCount = _countPerfisBestEffort(ff.perfisPath);
    const desiredCount = _countDesiredBestEffort(ff.desiredPath);

    backups.push({
      tag,
      dir,
      perfis: { path: ff.perfisPath, bytes: perfisBytes, mtimeMs: perfisMtimeMs, count: perfisCount },
      desired: { path: ff.desiredPath, bytes: desiredBytes, mtimeMs: desiredMtimeMs, count: desiredCount }
    });
  }

  // Heurística: detectar quedas bruscas (sem tomar ação; só evidência)
  const drops = [];
  for (let i = 1; i < backups.length; i++) {
    const newer = backups[i - 1];
    const older = backups[i];
    const a = Number(newer?.perfis?.count || 0) || 0;
    const b = Number(older?.perfis?.count || 0) || 0;
    if (a > 0 && b > 0) {
      const ratio = a / b;
      if (ratio <= 0.20) { // caiu 80%+
        drops.push({ fromTag: older.tag, toTag: newer.tag, fromCount: b, toCount: a, kind: 'perfis_count_drop' });
      }
    }
    const ab = Number(newer?.perfis?.bytes || 0) || 0;
    const bb = Number(older?.perfis?.bytes || 0) || 0;
    if (ab > 0 && bb > 0) {
      const ratioB = ab / bb;
      if (ratioB <= 0.20) {
        drops.push({ fromTag: older.tag, toTag: newer.tag, fromBytes: bb, toBytes: ab, kind: 'perfis_bytes_drop' });
      }
    }
  }

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'backups_manifest',
      rootUsed,
      limit,
      backupsCount: backups.length,
      errorsCount: errors.length,
      dropsCount: drops.length
    });
  } catch {}

  return { ok: true, rootUsed, limit, backups, errors, drops };
}
function _mergePerfisByNome({ backupPerfisArr, currentPerfisArr }) {
  const backup = Array.isArray(backupPerfisArr) ? backupPerfisArr : [];
  const current = Array.isArray(currentPerfisArr) ? currentPerfisArr : [];
  const seen = new Set();
  const duplicatesInBackup = [];
  for (const p of backup) {
    const n = p && p.nome ? String(p.nome) : '';
    if (!n) continue;
    if (seen.has(n)) duplicatesInBackup.push(n);
    seen.add(n);
  }
  const merged = [];
  const mergedSet = new Set();
  for (const p of backup) {
    const n = p && p.nome ? String(p.nome) : '';
    if (!n) continue;
    if (mergedSet.has(n)) continue; // de-dup backup
    merged.push(p);
    mergedSet.add(n);
  }
  const addedFromCurrent = [];
  for (const p of current) {
    const n = p && p.nome ? String(p.nome) : '';
    if (!n) continue;
    if (mergedSet.has(n)) continue;
    merged.push(p);
    mergedSet.add(n);
    addedFromCurrent.push(n);
  }
  return { merged, addedFromCurrent, duplicatesInBackup: Array.from(new Set(duplicatesInBackup)) };
}
function _mergeDesiredKeepBackupPlusCurrentNew({ backupDesired, currentDesired, currentNamesSet }) {
  const b = (backupDesired && typeof backupDesired === 'object') ? backupDesired : { perfis: {} };
  const c = (currentDesired && typeof currentDesired === 'object') ? currentDesired : { perfis: {} };
  const out = { ...b, perfis: { ...(b.perfis || {}) } };
  const merged = [];
  const keptFromCurrent = [];
  const currentPerfis = (c && c.perfis && typeof c.perfis === 'object') ? c.perfis : {};
  for (const nome of Object.keys(currentPerfis)) {
    if (!currentNamesSet || !currentNamesSet.has(nome)) continue;
    out.perfis[nome] = { ...(currentPerfis[nome] || {}) };
    keptFromCurrent.push(nome);
  }
  return { desired: out, keptFromCurrent, merged };
}
function _listMissingProfileDirs(perfisArr, { cap = 80 } = {}) {
  const missing = [];
  for (const p of (Array.isArray(perfisArr) ? perfisArr : [])) {
    const nome = p && p.nome ? String(p.nome) : '';
    if (!nome) continue;
    const dir = path.join(fileStore.perfisDir, nome);
    if (!fsSync.existsSync(dir)) missing.push(nome);
    if (missing.length >= cap) break;
  }
  return missing;
}

async function execBackupRestoreProbe(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const backupDir = String(payload.backupDir || '').trim();
  const rr = _resolveBackupDir(backupDir);
  if (!rr.ok) return { ok: false, error: rr.error, resolved: rr.resolved || null };

  const ff = _findBackupJsonFiles(rr.resolved);
  if (!ff.ok) return { ok: false, error: ff.error, resolved: rr.resolved, tried: ff.tried || [] };

  const stPerfis = (() => { try { return fsSync.statSync(ff.perfisPath); } catch { return null; } })();
  const stDesired = (() => { try { return fsSync.statSync(ff.desiredPath); } catch { return null; } })();

  const backupPerfis = _readJsonSafeSync(ff.perfisPath, null);
  const backupDesired = _readJsonSafeSync(ff.desiredPath, null);
  const currentPerfis = _readJsonSafeSync(fileStore.perfisPath, []);
  const currentDesired = _readJsonSafeSync(fileStore.desiredPath, { perfis: {} });

  const backupPerfisCount = Array.isArray(backupPerfis) ? backupPerfis.length : null;
  const backupDesiredCount = (backupDesired && backupDesired.perfis && typeof backupDesired.perfis === 'object') ? Object.keys(backupDesired.perfis).length : null;
  const currentPerfisCount = Array.isArray(currentPerfis) ? currentPerfis.length : null;
  const currentDesiredCount = (currentDesired && currentDesired.perfis && typeof currentDesired.perfis === 'object') ? Object.keys(currentDesired.perfis).length : null;

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'backup_restore_probe',
      backupDir: rr.resolved,
      backupPerfisCount,
      backupDesiredCount,
      currentPerfisCount,
      currentDesiredCount
    });
  } catch {}

  return {
    ok: true,
    backupDir: rr.resolved,
    files: {
      backupPerfis: { path: ff.perfisPath, bytes: stPerfis ? Number(stPerfis.size || 0) : null, sha256: _sha256FileBestEffort(ff.perfisPath) },
      backupDesired: { path: ff.desiredPath, bytes: stDesired ? Number(stDesired.size || 0) : null, sha256: _sha256FileBestEffort(ff.desiredPath) }
    },
    counts: {
      backupPerfisCount,
      backupDesiredCount,
      currentPerfisCount,
      currentDesiredCount
    }
  };
}

async function execBackupRestoreMerge(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const backupDir = String(payload.backupDir || '').trim();
  const mode = String(payload.mode || 'dry_run').trim().toLowerCase();
  const force = (payload.force === true || payload.force === 1 || payload.force === '1' || String(payload.force || '').toLowerCase() === 'true');
  const policy = String(payload.policy || 'keep_backup_desired_plus_current_new').trim().toLowerCase();

  const rr = _resolveBackupDir(backupDir);
  if (!rr.ok) return { ok: false, error: rr.error, resolved: rr.resolved || null };

  const ff = _findBackupJsonFiles(rr.resolved);
  if (!ff.ok) return { ok: false, error: ff.error, resolved: rr.resolved, tried: ff.tried || [] };

  const backupPerfis = _readJsonSafeSync(ff.perfisPath, null);
  const backupDesired = _readJsonSafeSync(ff.desiredPath, null);
  if (!Array.isArray(backupPerfis)) return { ok: false, error: 'backup_perfis_invalid', resolved: rr.resolved };
  if (!backupDesired || typeof backupDesired !== 'object') return { ok: false, error: 'backup_desired_invalid', resolved: rr.resolved };

  const currentPerfis = _readJsonSafeSync(fileStore.perfisPath, []);
  const currentDesired = _readJsonSafeSync(fileStore.desiredPath, { perfis: {} });

  const mergedPerfisR = _mergePerfisByNome({ backupPerfisArr: backupPerfis, currentPerfisArr: currentPerfis });
  const backupOnlyPerfisR = _mergePerfisByNome({ backupPerfisArr: backupPerfis, currentPerfisArr: [] });
  const currentNamesSet = new Set(mergedPerfisR.addedFromCurrent || []);

  let desiredMergeR = null;
  let mergedPerfis = null;
  let mergedDesired = null;
  if (policy === 'keep_backup_desired_plus_current_new' || policy === 'keep-backup-desired') {
    desiredMergeR = _mergeDesiredKeepBackupPlusCurrentNew({ backupDesired, currentDesired, currentNamesSet });
    mergedPerfis = mergedPerfisR.merged;
    mergedDesired = desiredMergeR.desired;
  } else if (policy === 'replace_with_backup' || policy === 'backup_only' || policy === 'backup-only') {
    // Enterprise: modo recovery — restaura EXATAMENTE o backup (perfis + desired),
    // mas ainda calcula addedFromCurrent para facilitar reconciliação pós-wipe (voltar para estoque).
    desiredMergeR = { desired: backupDesired, keptFromCurrent: [], merged: [] };
    mergedPerfis = backupOnlyPerfisR.merged;
    mergedDesired = desiredMergeR.desired;
  } else {
    return { ok: false, error: 'unknown_policy', policy };
  }

  const mergedPerfisCount = mergedPerfis.length;
  const mergedDesiredCount = (mergedDesired && mergedDesired.perfis && typeof mergedDesired.perfis === 'object') ? Object.keys(mergedDesired.perfis).length : null;

  // Sanidade: desired cobre TODOS perfis
  const missingDesired = [];
  try {
    const dp = (mergedDesired && mergedDesired.perfis && typeof mergedDesired.perfis === 'object') ? mergedDesired.perfis : {};
    for (const p of mergedPerfis) {
      const nome = p && p.nome ? String(p.nome) : '';
      if (!nome) continue;
      if (!dp[nome]) missingDesired.push(nome);
      if (missingDesired.length >= 50) break;
    }
  } catch {}

  const missingProfileDirs = _listMissingProfileDirs(mergedPerfis, { cap: 80 });
  const missingProfileDirsCount = missingProfileDirs.length;

  const report = {
    ok: true,
    mode,
    policy,
    backupDir: rr.resolved,
    counts: {
      backupPerfisCount: backupPerfis.length,
      currentPerfisCount: Array.isArray(currentPerfis) ? currentPerfis.length : null,
      mergedPerfisCount,
      backupDesiredCount: (backupDesired && backupDesired.perfis && typeof backupDesired.perfis === 'object') ? Object.keys(backupDesired.perfis).length : null,
      currentDesiredCount: (currentDesired && currentDesired.perfis && typeof currentDesired.perfis === 'object') ? Object.keys(currentDesired.perfis).length : null,
      mergedDesiredCount
    },
    merge: {
      addedFromCurrentCount: (mergedPerfisR.addedFromCurrent || []).length,
      addedFromCurrentSample: (mergedPerfisR.addedFromCurrent || []).slice(0, 25),
      duplicatesInBackupCount: (mergedPerfisR.duplicatesInBackup || []).length,
      duplicatesInBackupSample: (mergedPerfisR.duplicatesInBackup || []).slice(0, 25),
      keptDesiredFromCurrentCount: (desiredMergeR.keptFromCurrent || []).length,
      keptDesiredFromCurrentSample: (desiredMergeR.keptFromCurrent || []).slice(0, 25)
    },
    sanity: {
      missingDesiredCount: missingDesired.length,
      missingDesiredSample: missingDesired.slice(0, 25),
      missingProfileDirsCount,
      missingProfileDirsSample: missingProfileDirs.slice(0, 25)
    }
  };

  // Gate: se faltam muitos diretórios de perfil, não aplicar sem force
  if (mode === 'apply') {
    const lockOwner = `backup_restore:${String(cmd && cmd.id || randId()).slice(0, 24)}`;
    const lock = provisionLock.tryAcquire({ owner: lockOwner, ttlMs: 15 * 60 * 1000, meta: { op: 'backup_restore', mode: 'apply' } });
    if (!lock || !lock.ok) {
      try { provisionAudit.append({ ts: Date.now(), event: 'backup_restore_apply_denied_lock_busy', owner: lockOwner, error: lock && lock.error ? String(lock.error) : 'busy' }); } catch {}
      return { ok: false, error: 'provision_lock_busy', lock: lock && lock.lock ? lock.lock : null };
    }
    try {
      if (!force && missingProfileDirsCount > 5) {
        try { provisionAudit.append({ ts: Date.now(), event: 'backup_restore_apply_denied_missing_dirs', owner: lockOwner, missingProfileDirsCount }); } catch {}
        return { ok: false, error: 'missing_profile_dirs', missingProfileDirsCount, sample: missingProfileDirs.slice(0, 25) };
      }
      if (!force && missingDesired.length > 0) {
        try { provisionAudit.append({ ts: Date.now(), event: 'backup_restore_apply_denied_missing_desired', owner: lockOwner, missingDesiredCount: missingDesired.length }); } catch {}
        return { ok: false, error: 'missing_desired_entries', missingDesiredCount: missingDesired.length, sample: missingDesired.slice(0, 25) };
      }

      const ts = Date.now();
      const auditDir = path.join(fileStore.dadosDir, '_ops_audit');
      try { fsSync.mkdirSync(auditDir, { recursive: true }); } catch {}

      // Backup arquivos atuais (rollback)
      const beforePerfis = _readJsonSafeSync(fileStore.perfisPath, null);
      const beforeDesired = _readJsonSafeSync(fileStore.desiredPath, null);
      try { fsSync.writeFileSync(path.join(auditDir, `restore_${ts}_perfis.before.json`), JSON.stringify(beforePerfis, null, 2), 'utf8'); } catch {}
      try { fsSync.writeFileSync(path.join(auditDir, `restore_${ts}_desired.before.json`), JSON.stringify(beforeDesired, null, 2), 'utf8'); } catch {}

      try { provisionAudit.append({ ts, event: 'backup_restore_apply_begin', owner: lockOwner, backupDir: rr.resolved, mergedPerfisCount, mergedDesiredCount }); } catch {}

      // CRÍTICO: perfis.json deve passar pelo lock canônico para evitar corrida com outros escritores.
      const wrPerfis = fileStore.withPerfisFileLockUpdate(() => mergedPerfis, {
        caller: 'backup_restore_merge',
        reason: `apply:${String(cmd && cmd.id || '').slice(0, 40)}`
      });
      const okPerfis = !!(wrPerfis && wrPerfis.ok === true);
      const okDesired = fileStore.writeJsonAtomic(fileStore.desiredPath, mergedDesired);
      if (!okPerfis || !okDesired) {
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'backup_restore_apply_fail_write',
            owner: lockOwner,
            okPerfis: !!okPerfis,
            okDesired: !!okDesired,
            perfisError: (wrPerfis && wrPerfis.error) ? String(wrPerfis.error) : null
          });
        } catch {}
        return {
          ok: false,
          error: 'write_failed',
          okPerfis: !!okPerfis,
          okDesired: !!okDesired,
          perfisError: (wrPerfis && wrPerfis.error) ? String(wrPerfis.error) : null
        };
      }

      try { provisionAudit.append({ ts: Date.now(), event: 'backup_restore_apply_ok', owner: lockOwner, mergedPerfisCount, mergedDesiredCount }); } catch {}
      return { ...report, applied: true, auditDir };
    } finally {
      try { provisionLock.release({ owner: lockOwner, force: true }); } catch {}
    }
  }

  // dry_run
  try { provisionAudit.append({ ts: Date.now(), event: 'backup_restore_dry_run', backupDir: rr.resolved, mergedPerfisCount, mergedDesiredCount }); } catch {}
  return report;
}

function buildQuickSnapshot(status) {
  const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
  const perfisCount = perfis.length;
  const activeCount = perfis.filter(p => p && p.active).length;
  const workingCount = perfis.filter(p => p && p.trabalhando).length;
  const sys = (status && status.sys) ? status.sys : {
    freeMB: Math.round(os.freemem() / (1024*1024)),
    totalMB: Math.round(os.totalmem() / (1024*1024)),
    cores: (os.cpus() || []).length
  };
  const risk = {
    memLow: typeof sys.freeMB === 'number' ? (sys.freeMB < 512) : false,
    cpuHigh: typeof sys.cpuApprox === 'number' ? (sys.cpuApprox >= 90) : false
  };

  // Identidade humana (hostname, username, operador customizável)
  const username = (os.userInfo && os.userInfo().username) || process.env.USER || process.env.USERNAME || 'user';
  const computerName = process.env.COMPUTERNAME || os.hostname();
  const displayName = process.env.OPERATOR_NAME || '';
  const avatarUrl = process.env.OPERATOR_AVATAR || '';
  const humanId = `${username}@${computerName}`;

  // NOVO: fotosCount — leitura do diretório de fotos (raiz + subpastas p/m/g do V3)
  let fotosCount = 0;
  try {
    const dir = fotos.resolveFotosDir();
    const list = fsSync.readdirSync(dir, { withFileTypes: true });
    for (const ent of list) {
      if (ent.isFile() && isImage(ent.name)) {
        fotosCount += 1;
        continue;
      }
      if (!ent.isDirectory()) continue;
      const sub = String(ent.name || '').trim().toLowerCase();
      if (sub !== 'p' && sub !== 'm' && sub !== 'g') continue;
      try {
        const subList = fsSync.readdirSync(path.join(dir, ent.name), { withFileTypes: true });
        fotosCount += subList.filter(e => e.isFile() && isImage(e.name)).length;
      } catch {}
    }
  } catch {}

  return {
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime: os.uptime()
    },
    human: {
      username,
      computerName,
      humanId,
      displayName,
      avatarUrl
    },
    perfisCount,
    activeCount,
    workingCount,
    sys,
    risk,
    ts: now(),
    fotosCount // NOVO CAMPO
  };
}

function buildPollLightTelemetry(status) {
  const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
  const counts = {
    perfis: perfis.length,
    ativos: perfis.filter((p) => p && p.active).length,
    trabalhando: perfis.filter((p) => p && p.trabalhando).length
  };
  const accountsAgg = { total: 0 };
  const flagsAgg = {
    totalPerfis: 0,
    human_invoked: 0,
    messenger_pin: 0,
    problem: 0,
    virtus_offline: 0,
    login_required: 0,
    login_cookies_failed: 0,
    appeal_submitted: 0,
    // Marketplace ID doc 1x/dia (pill conta "ID - sim"); ≠ Facebook identity checkpoint
    id_sim: 0,
    renovados: 0,
    renovados_qtd: 0
  };

  for (const p of perfis) {
    if (!p) continue;
    const banned = p.banned === true;
    const loginRequired = p.loginRequired === true;
    const reason = String(p.loginReason || "").trim().toLowerCase();
    let kind = "ok";
    if (banned) {
      kind = "banned";
    } else if (loginRequired) {
      if (reason.includes("captcha") || reason.includes("checkpoint")) kind = "captcha";
      else if (reason === "login_form" || reason === "aymh_continue" || reason.includes("aymh_continue")) kind = "login";
      else if (reason.includes("session")) kind = "session";
      else if (reason.includes("2fa") || reason.includes("two_factor")) kind = "two_factor";
      else if (reason.includes("identity")) kind = "identity";
      else if (reason.includes("consent")) kind = "consent";
      else kind = "login_other";
    } else {
      const r = p && p.nome ? String(p.nome) : "";
      const robeRec = (status && status.robes && typeof status.robes === "object" && r) ? status.robes[r] : null;
      const isLimit = !!(
        robeRec &&
        (String(robeRec.estado || "").toLowerCase() === "paused_limit" ||
         String(robeRec.pauseReason || "").toLowerCase() === "limit_posting") &&
        Number(robeRec.cooldownSec || 0) > 0
      );
      if (isLimit) kind = "limit_exceeded";
    }
    accountsAgg[kind] = (Number(accountsAgg[kind] || 0) || 0) + 1;
    accountsAgg.total++;

    flagsAgg.totalPerfis++;
    if (p.humanControl === true || p.humanHold === true) flagsAgg.human_invoked++;
    if (p.messengerPin === true) flagsAgg.messenger_pin++;
    if (p.problem === true) flagsAgg.problem++;
    if (p.virtusOnline === false) flagsAgg.virtus_offline++;
    if (p.loginRequired === true) flagsAgg.login_required++;
    if (p.loginRemediateFailed === true) flagsAgg.login_cookies_failed++;
    if (p.appealSubmitted === true) flagsAgg.appeal_submitted++;
    if (p.robeIdDocDoneToday === true) flagsAgg.id_sim++;
    const renovN = Math.floor(Number(p.renovadosLastCount || 0) || 0);
    if (renovN > 0) {
      flagsAgg.renovados++;
      flagsAgg.renovados_qtd += renovN;
    }
  }

  accountsAgg.lr_total = ["captcha", "login", "session", "two_factor", "identity", "consent", "login_other"]
    .reduce((acc, k) => acc + (Number(accountsAgg[k] || 0) || 0), 0);

  const quick = buildQuickSnapshot(status);
  return {
    counts,
    accountsAgg,
    flagsAgg,
    quick: {
      perfisCount: Number(quick && quick.perfisCount || 0) || 0,
      activeCount: Number(quick && quick.activeCount || 0) || 0,
      workingCount: Number(quick && quick.workingCount || 0) || 0,
      fotosCount: Number(quick && quick.fotosCount || 0) || 0,
      sys: {
        freeMB: Number(quick && quick.sys && quick.sys.freeMB),
        totalMB: Number(quick && quick.sys && quick.sys.totalMB),
        cpuApprox: Number(quick && quick.sys && quick.sys.cpuApprox)
      }
    }
  };
}

async function postPayload(url, payload) {
  let bodyStr;
  let body = null;
  try {
    bodyStr = JSON.stringify(payload);
  } catch (e) {
    throw new Error('payload_stringify_failed: ' + (e && e.message || e));
  }

  // Nunca gzip!
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const bodyBuf = Buffer.from(bodyStr, 'utf8');

  const Aborter = global.AbortController || require('node-abort-controller');
  const ac = new Aborter();
  const timeoutMs = parseInt(process.env.DASHBOARD_TIMEOUT_MS || '8000', 10);
  const t = setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyBuf,
      signal: ac.signal
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      const err = new Error(`HTTP ${resp.status}: ${txt}`);
      err.status = resp.status;
      err.text = txt;
      throw err;
    }
    try { body = await resp.json(); } catch { body = { ok: true }; }
    if (process.env.DASHBOARD_DEBUG === '1') {
      logger.info('[DASHBOARD] enviado com sucesso para ' + url);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function tryAllEndpoints(payload) {
  const endpoints = resolveEndpoints();
  let lastErr = null;
  for (const u of endpoints) {
    try {
      const body = await postPayload(u, payload);
      return body || { ok:true };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return { ok:false };
}

// === Helpers/execução de comandos remotos (inserido acima de tick()) ===
async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function httpJson(path, { method='GET', body=null, headers=null, rawBody=null, timeoutMs=0, retries=0 } = {}) {
  const hasBody = !(rawBody == null) || !(body == null);
  const h = Object.assign({}, (headers && typeof headers === 'object') ? headers : {});
  let sendBody = null;
  if (rawBody != null) {
    sendBody = rawBody;
  } else if (body != null) {
    try { sendBody = JSON.stringify(body); }
    catch (e) { throw new Error('httpJson_body_stringify_failed:' + ((e && e.message) || String(e))); }
  }
  if (hasBody && !h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';

  // P1 hardening: nunca deixar fetch “pendurado” (gera ACK `fetch failed` opaco no CT).
  const tms = Math.max(1000, Number(timeoutMs || process.env.DASHBOARD_LOCAL_HTTP_TIMEOUT_MS || 8000) || 8000);
  const maxAttempts = Math.max(1, (Number(retries || 0) || 0) + 1);
  const urls = [
    `http://127.0.0.1:${httpPort}${path}`,
    `http://localhost:${httpPort}${path}`
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const url of urls) {
      try {
        const res = await timeoutFetch(url, {
          timeoutMs: tms,
          method,
          headers: Object.keys(h).length ? h : undefined,
          body: sendBody
        });
        const txt = await res.text().catch(() => '');
        if (!res || !res.ok) {
          const status = res ? Number(res.status || 0) : 0;
          throw new Error(`http_${status || 'no_status'}:${String(txt || '').slice(0, 200)}`);
        }
        if (!txt) return {};
        try { return JSON.parse(txt); }
        catch (e) {
          throw new Error(`json_parse_failed:${((e && e.message) || String(e))}:${String(txt).slice(0, 160)}`);
        }
      } catch (e) {
        lastErr = new Error(`local_http_failed:${String(method || 'GET').toUpperCase()}:${url}:timeoutMs=${tms}:err=${(e && e.message) || String(e)}`);
      }
    }
    if (attempt < maxAttempts) await sleep(250 * attempt);
  }
  throw lastErr || new Error(`local_http_failed:${String(method || 'GET').toUpperCase()}:${path}`);
}
async function ensureFreeMB(minMB = 3072, {
  timeoutMs = 120_000,
  pollMs = 1200,
  maxCpuPercent = 90,
  logEveryMs = 15_000
} = {}) {
  // P1 guardrail: nunca esperar infinito.
  const t0 = Date.now();
  let lastLogAt = 0;
  while (true) {
    let free = 0;
    let cpu = 0;
    try {
      const m = await httpJson('/api/sys');
      free = (m && m.mem && m.mem.freeMB) || 0;
      cpu  = (m && m.cpu && typeof m.cpu.percent === 'number') ? m.cpu.percent : 0;
      if (free >= minMB && (cpu === 0 || cpu <= maxCpuPercent)) return;
    } catch {}

    const elapsed = Date.now() - t0;
    if (timeoutMs > 0 && elapsed >= timeoutMs) {
      throw new Error(`ensureFreeMB_timeout:min=${minMB}:free=${free}:cpu=${cpu}:waitedMs=${elapsed}`);
    }
    if ((Date.now() - lastLogAt) >= logEveryMs) {
      lastLogAt = Date.now();
      try {
        logger.warn('[DASH][ensureFreeMB] aguardando RAM/CPU', {
          minMB,
          freeMB: free,
          cpuPercent: cpu,
          waitedMs: elapsed,
          timeoutMs
        });
      } catch {}
    }
    await sleep(Math.max(250, Number(pollMs || 0) || 1200));
  }
}
async function execCloseAll(cmd) {
  // NÃO engolir erro: se o servidor estiver desatualizado (sem endpoint canônico),
  // o ACK precisa refletir falha para o notificador mostrar claramente.
  const cmdId = (cmd && cmd.id) ? String(cmd.id).trim() : '';
  const operator = `dashboard_cmd_close_all:${cmdId || Date.now()}`;
  const closeTimeoutMs = Math.max(60_000, Number(process.env.CLOSE_ALL_HTTP_TIMEOUT_MS || (15 * 60 * 1000)) || (15 * 60 * 1000));
  const r = await httpJson('/api/perfis/close-all', {
    method: 'POST',
    headers: { 'x-operator': operator },
    timeoutMs: closeTimeoutMs,
    retries: 1
  });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'close_all_failed');
}
// ===== INÍCIO ALTERAÇÃO =====
async function execOpenAll24h() {
  const r = await httpJson('/api/perfis/open-all-24h', { method: 'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'open_all_24h_failed');
}
// ===== FIM ALTERAÇÃO =====
async function execRobePauseAll() {
  const r = await httpJson('/api/robes/pause-24h-all', { method:'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'robes_pause_24h_all_failed');
}
async function execRobeReleaseAll() {
  const r = await httpJson('/api/robes/release-all', { method:'POST' });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'robes_release_all_failed');
}
async function execRobeV2Recalc(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const reasonRaw = String(payload.reason || '').trim();
  const reason = reasonRaw ? reasonRaw.slice(0, 120) : 'ct_remote_recalc';
  const force = (payload.force === true || payload.force === 1 || payload.force === '1' || String(payload.force || '').toLowerCase() === 'true');
  const r = await httpJson('/api/robes/v2/recalc', {
    method: 'POST',
    body: { reason, force: force !== false },
    headers: { 'x-operator': `ct_remote:${String(cmd && cmd.id || '').slice(0, 36)}` }
  });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'robe_v2_recalc_failed');
  return r;
}

// ===== NOVO: profiles_cleanup (limpeza cirúrgica enterprise) =====
// Objetivo: desfazer “lixo de testes” sem close_all.
// - Desativa uma lista de perfis via /api/perfis/:nome/deactivate (isso também zera desired.active por padrão).
// - Sem loops infinitos: limites e small-jitter.
async function execProfilesCleanup(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const names = Array.isArray(payload.profileNames)
    ? payload.profileNames
    : (Array.isArray(payload.names) ? payload.names : []);
  const list = names.map(x => String(x || '').trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(30, Number(payload.limit || 30) || 30));
  const targets = list.slice(0, limit);
  if (!targets.length) return { ok: false, error: 'missing_profileNames' };

  const operator = `profiles_cleanup:${String(cmd && cmd.id || '').trim() || Date.now()}`;
  const results = [];
  for (const nome of targets) {
    try {
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, {
        method: 'POST',
        headers: { 'x-operator': operator },
        body: {}
      });
      if (!r || r.ok === false) {
        results.push({ nome, ok: false, error: (r && r.error) ? String(r.error) : 'deactivate_failed' });
      } else {
        results.push({ nome, ok: true });
      }
    } catch (e) {
      results.push({ nome, ok: false, error: (e && e.message) || String(e) });
    }
    await sleep(250);
  }
  const okCount = results.filter(x => x && x.ok).length;
  const failCount = results.length - okCount;
  return { ok: failCount === 0, okCount, failCount, results };
}

// ===== NOVO: profiles_fs_audit (auditoria perfis.json vs dados/perfis vs userDataDir) =====
// Objetivo: alinhar “verdade” sem risco de ressuscitar legado.
// - NÃO deleta nada.
// - Gera relatório em dados/_ops_audit e devolve summary + listas limitadas (via ACK).
async function execProfilesFsAudit(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const cutoffDays = Math.max(0, Math.min(365, Number(payload.cutoffDays || 12) || 12));
  const maxItems = Math.max(50, Math.min(2000, Number(payload.maxItems || 800) || 800));
  const includeLists = (payload.includeLists === false) ? false : true;
  const nowMs = Date.now();
  const cutoffMs = nowMs - (cutoffDays * 24 * 60 * 60 * 1000);

  const safeStat = (p) => { try { return fsSync.statSync(p); } catch { return null; } };
  const safeExists = (p) => { try { return fsSync.existsSync(p); } catch { return false; } };
  const safeReadJson = (p) => {
    try { return JSON.parse(fsSync.readFileSync(p, 'utf8')); } catch { return null; }
  };
  const resolveChromeUserDataRoot = () => {
    try {
      if (process.platform === 'win32') {
        const la = process.env.LOCALAPPDATA;
        if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
        // fallback defensivo
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
      }
      return path.join(os.homedir(), '.config', 'google-chrome');
    } catch { return null; }
  };
  const chromeRoot = resolveChromeUserDataRoot();
  const guessUserDataDirFor = (nome) => {
    try {
      if (!chromeRoot || !nome) return null;
      return path.join(chromeRoot, 'Conveniente', String(nome));
    } catch { return null; }
  };
  const readDesiredBestEffort = () => {
    // audit-only: se estiver inválido, devolve null (não tenta corrigir aqui)
    try {
      if (!safeExists(fileStore.desiredPath)) return { perfis: {} };
      const j = safeReadJson(fileStore.desiredPath);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
      j.perfis = j.perfis && typeof j.perfis === 'object' ? j.perfis : {};
      return j;
    } catch { return null; }
  };

  const perfisArr = Array.isArray(fileStore.loadPerfisJson()) ? (fileStore.loadPerfisJson() || []) : [];
  const perfisNames = perfisArr.map(p => p && p.nome ? String(p.nome) : '').filter(Boolean);
  const perfisSet = new Set(perfisNames);

  const desired = readDesiredBestEffort();
  const desiredPerfis = (desired && desired.perfis && typeof desired.perfis === 'object') ? desired.perfis : {};

  // Listar diretórios de dados/perfis
  const dirs = [];
  try {
    if (safeExists(fileStore.perfisDir)) {
      const entries = fsSync.readdirSync(fileStore.perfisDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent || !ent.isDirectory()) continue;
        const nome = String(ent.name || '').trim();
        if (!nome) continue;
        const full = path.join(fileStore.perfisDir, nome);
        const st = safeStat(full);
        const recPath = path.join(full, 'perfil.json');
        const rec = safeExists(recPath) ? safeReadJson(recPath) : null;
        const recOk = !!(rec && typeof rec === 'object' && rec.nome);
        const recUserDataDir = recOk && rec.userDataDir ? String(rec.userDataDir) : null;
        const manPath = recUserDataDir ? path.join(recUserDataDir, 'manifest.json') : null;
        const manStat = manPath && safeExists(manPath) ? safeStat(manPath) : null;

        // Heurística militar: mesmo sem record, o padrão é chromeRoot/Conveniente/<nome>
        const guessUserDataDir = guessUserDataDirFor(nome);
        const guessUserDataDirExists = guessUserDataDir ? safeExists(guessUserDataDir) : null;
        const guessManPath = guessUserDataDir ? path.join(guessUserDataDir, 'manifest.json') : null;
        const guessManStat = (guessManPath && safeExists(guessManPath)) ? safeStat(guessManPath) : null;

        const lastTouchMs = Math.max(
          Number(st && st.mtimeMs || 0) || 0,
          Number(recOk && rec.updatedAt || 0) || 0,
          Number(manStat && manStat.mtimeMs || 0) || 0,
          Number(guessManStat && guessManStat.mtimeMs || 0) || 0
        );

        dirs.push({
          nome,
          dirMtimeMs: Number(st && st.mtimeMs || 0) || 0,
          inPerfisJson: perfisSet.has(nome),
          inDesired: !!(desiredPerfis && desiredPerfis[nome]),
          hasPerfilRecord: safeExists(recPath),
          perfilRecordOk: recOk,
          recordUpdatedAt: Number(recOk && rec.updatedAt || 0) || 0,
          userDataDir: recUserDataDir,
          userDataDirExists: recUserDataDir ? safeExists(recUserDataDir) : null,
          manifestExists: manPath ? safeExists(manPath) : null,
          manifestMtimeMs: Number(manStat && manStat.mtimeMs || 0) || 0,
          guessUserDataDir,
          guessUserDataDirExists,
          guessManifestExists: guessManPath ? safeExists(guessManPath) : null,
          guessManifestMtimeMs: Number(guessManStat && guessManStat.mtimeMs || 0) || 0,
          lastTouchMs,
          olderThanCutoff: lastTouchMs > 0 ? (lastTouchMs < cutoffMs) : null
        });
      }
    }
  } catch {}

  const dirNames = dirs.map(d => d.nome);
  const dirSet = new Set(dirNames);

  const missingDirForActive = perfisNames.filter(n => !dirSet.has(n));
  const orphanDirs = dirs.filter(d => !d.inPerfisJson);
  const orphanDirsOlder = orphanDirs.filter(d => d.olderThanCutoff === true);
  const orphanDirsRecent = orphanDirs.filter(d => d.olderThanCutoff === false);

  // Candidatos para “recovery”: existe pasta mas não está no perfis.json e é recente (janela dos 12 dias)
  const recoveryCandidates = orphanDirsRecent
    .filter(d => {
      if (d.hasPerfilRecord && d.perfilRecordOk && d.userDataDir && d.userDataDirExists) return true;
      if (d.guessUserDataDirExists === true && d.guessManifestExists === true) return true;
      return false;
    });

  const summary = {
    nowMs,
    cutoffDays,
    cutoffMs,
    perfisJsonCount: perfisNames.length,
    desiredCount: desiredPerfis ? Object.keys(desiredPerfis).length : null,
    perfisDirCount: dirs.length,
    missingDirForActiveCount: missingDirForActive.length,
    orphanDirsCount: orphanDirs.length,
    orphanDirsOlderCount: orphanDirsOlder.length,
    orphanDirsRecentCount: orphanDirsRecent.length,
    recoveryCandidatesCount: recoveryCandidates.length,
    chromeRoot: chromeRoot || null
  };

  // Persistir relatório
  const outDir = path.join(__dirname, '..', 'dados', '_ops_audit');
  try { fsSync.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, `profiles_fs_audit_${nowMs}_${String(cmd && cmd.id || '').slice(0, 18) || 'cmd'}.json`);
  const report = {
    ok: true,
    hostNowMs: nowMs,
    cmdId: cmd && cmd.id ? String(cmd.id) : null,
    cutoffDays,
    summary,
    // listas podem ficar grandes; limitamos para não estourar ACK/memória
    lists: includeLists ? {
      missingDirForActive: missingDirForActive.slice(0, maxItems),
      orphanDirsOlder: orphanDirsOlder.slice(0, maxItems),
      orphanDirsRecent: orphanDirsRecent.slice(0, maxItems),
      recoveryCandidates: recoveryCandidates.slice(0, maxItems),
      sampleDirs: dirs.slice(0, Math.min(maxItems, 300))
    } : null
  };
  try { fsSync.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8'); } catch {}

  // Importante: devolvemos listas limitadas no ACK para o CT enxergar sem depender de fetch de arquivo.
  // (o arquivo completo continua salvo em _ops_audit para auditoria local / coleta via logs no futuro)
  const compact = (arr) => {
    const xs = Array.isArray(arr) ? arr : [];
    return xs.slice(0, Math.min(maxItems, 300)).map(x => {
      if (!x || typeof x !== 'object') return x;
      return {
        nome: x.nome,
        lastTouchMs: x.lastTouchMs,
        olderThanCutoff: x.olderThanCutoff,
        userDataDirExists: x.userDataDirExists,
        manifestExists: x.manifestExists,
        guessUserDataDirExists: x.guessUserDataDirExists,
        guessManifestExists: x.guessManifestExists,
        inDesired: x.inDesired
      };
    });
  };
  return {
    ok: true,
    summary,
    reportPath: outPath,
    lists: includeLists ? {
      missingDirForActive: missingDirForActive.slice(0, Math.min(maxItems, 300)),
      orphanDirsOlder: compact(orphanDirsOlder),
      orphanDirsRecent: compact(orphanDirsRecent),
      recoveryCandidates: compact(recoveryCandidates)
    } : null
  };
}

// ===== NOVO: profiles_purge_dirs (purge seguro de lixo órfão) =====
// Objetivo: remover lixo (dados/perfis/<nome> e Chrome User Data/Conveniente/<nome>) APENAS
// quando o perfil NÃO está no perfis.json/desired.json.
// - Suporta dryRun=1 (não apaga, só reporta).
// - Não depende do CT; o CT fornece a lista (ex.: ctDeleted).
async function execProfilesPurgeDirs(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const names0 = Array.isArray(payload.profileNames) ? payload.profileNames : (Array.isArray(payload.names) ? payload.names : []);
  const list = names0.map(x => String(x || '').trim()).filter(Boolean);
  const dryRun = (payload.dryRun === true || payload.dryRun === 1 || payload.dryRun === '1');
  const maxItems = Math.max(20, Math.min(1200, Number(payload.maxItems || 600) || 600));
  const nowMs = Date.now();

  const safeExistsDir = (p) => { try { return !!(p && fsSync.existsSync(p) && fsSync.statSync(p).isDirectory()); } catch { return false; } };
  const safeRmDir = (p) => { try { fsSync.rmSync(p, { recursive: true, force: true }); return { ok:true }; } catch (e) { return { ok:false, error: (e && e.message) || String(e) }; } };

  const resolveChromeUserDataRoot = () => {
    try {
      if (process.platform === 'win32') {
        const la = process.env.LOCALAPPDATA;
        if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
      }
      return path.join(os.homedir(), '.config', 'google-chrome');
    } catch { return null; }
  };
  const chromeRoot = resolveChromeUserDataRoot();

  const perfisArr = Array.isArray(fileStore.loadPerfisJson()) ? (fileStore.loadPerfisJson() || []) : [];
  const perfisSet = new Set(perfisArr.map(p => p && p.nome ? String(p.nome) : '').filter(Boolean));
  let desiredPerfis = {};
  try {
    const j = fileStore.readJsonSafe(fileStore.desiredPath, null);
    desiredPerfis = (j && j.perfis && typeof j.perfis === 'object') ? j.perfis : {};
  } catch { desiredPerfis = {}; }

  const results = [];
  for (const nome of list.slice(0, maxItems)) {
    if (!nome || nome.toLowerCase() === 'system') {
      results.push({ nome, ok:false, skipped:true, reason:'invalid_name' });
      continue;
    }
    // Safety gate: nunca apagar algo que ainda está “vivo” no estado declarativo/runtime.
    if (perfisSet.has(nome) || (desiredPerfis && desiredPerfis[nome])) {
      results.push({ nome, ok:false, skipped:true, reason:'still_in_perfis_or_desired' });
      continue;
    }

    const perfDir = path.join(fileStore.perfisDir, nome);
    const udir = (chromeRoot && nome) ? path.join(chromeRoot, 'Conveniente', nome) : null;

    const perfDirExists = safeExistsDir(perfDir);
    const udirExists = udir ? safeExistsDir(udir) : false;

    const item = {
      nome,
      ok: true,
      dryRun,
      perfDir,
      perfDirExists,
      userDataDir: udir,
      userDataDirExists: udirExists,
      deleted: { perfDir: false, userDataDir: false },
      errors: []
    };

    if (!dryRun) {
      // Best-effort: tentar matar processos do Chrome para este profile (evita "dir em uso").
      if (udirExists) {
        try {
          const browserHelper = require('./browser.js');
          try { if (browserHelper && browserHelper.killChromeProfileProcesses) browserHelper.killChromeProfileProcesses(udir); } catch {}
          await sleep(500);
        } catch {}
      }

      if (perfDirExists) {
        const rr = safeRmDir(perfDir);
        if (rr.ok) item.deleted.perfDir = true;
        else { item.ok = false; item.errors.push({ target: 'perfisDir', error: rr.error }); }
      }
      if (udirExists && udir) {
        const rr = safeRmDir(udir);
        if (rr.ok) item.deleted.userDataDir = true;
        else { item.ok = false; item.errors.push({ target: 'userDataDir', error: rr.error }); }
      }
    }

    results.push(item);
    await sleep(10);
  }

  const okCount = results.filter(r => r && r.ok === true).length;
  const skippedCount = results.filter(r => r && r.skipped === true).length;
  const failCount = results.length - okCount - skippedCount;

  const outDir = path.join(__dirname, '..', 'dados', '_ops_audit');
  try { fsSync.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, `profiles_purge_dirs_${nowMs}_${String(cmd && cmd.id || '').slice(0, 18) || 'cmd'}.json`);
  try {
    fsSync.writeFileSync(outPath, JSON.stringify({
      ok: true,
      hostNowMs: nowMs,
      cmdId: cmd && cmd.id ? String(cmd.id) : null,
      dryRun,
      chromeRoot: chromeRoot || null,
      requestedCount: list.length,
      processedCount: results.length,
      okCount,
      skippedCount,
      failCount,
      results
    }, null, 2), 'utf8');
  } catch {}

  // ACK compacto
  const compact = results.slice(0, 250).map(r => ({
    nome: r.nome,
    ok: r.ok === true,
    skipped: r.skipped === true,
    reason: r.reason || null,
    perfDirExists: r.perfDirExists,
    userDataDirExists: r.userDataDirExists,
    deleted: r.deleted || null,
    errors: (r.errors && r.errors.length) ? r.errors.slice(0, 2) : []
  }));

  return {
    ok: failCount === 0,
    dryRun,
    requestedCount: list.length,
    processedCount: results.length,
    okCount,
    skippedCount,
    failCount,
    reportPath: outPath,
    sample: compact
  };
}

// ===== NOVO: profiles_manifest_probe (probe forense sanitizado) =====
// Objetivo: extrair evidência máxima SEM vazar secrets.
// - NUNCA retorna cookie values, login, password.
// - Retorna apenas flags/contagens/metadados + stockAccountId (se existir).
async function execProfilesManifestProbe(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const names0 = Array.isArray(payload.profileNames) ? payload.profileNames : (Array.isArray(payload.names) ? payload.names : []);
  const list = names0.map(x => String(x || '').trim()).filter(Boolean);
  const maxItems = Math.max(10, Math.min(800, Number(payload.maxItems || 200) || 200));
  const nowMs = Date.now();

  const safeExists = (p) => { try { return !!(p && fsSync.existsSync(p)); } catch { return false; } };
  const safeStat = (p) => { try { return fsSync.statSync(p); } catch { return null; } };
  const safeReadJson = (p) => { try { return JSON.parse(fsSync.readFileSync(p, 'utf8')); } catch { return null; } };

  const resolveChromeUserDataRoot = () => {
    try {
      if (process.platform === 'win32') {
        const la = process.env.LOCALAPPDATA;
        if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
      }
      return path.join(os.homedir(), '.config', 'google-chrome');
    } catch { return null; }
  };
  const chromeRoot = resolveChromeUserDataRoot();

  const perfisArr = Array.isArray(fileStore.loadPerfisJson()) ? (fileStore.loadPerfisJson() || []) : [];
  const perfisSet = new Set(perfisArr.map(p => p && p.nome ? String(p.nome) : '').filter(Boolean));
  let desiredPerfis = {};
  try {
    const j = fileStore.readJsonSafe(fileStore.desiredPath, null);
    desiredPerfis = (j && j.perfis && typeof j.perfis === 'object') ? j.perfis : {};
  } catch { desiredPerfis = {}; }

  const results = [];
  for (const nome of list.slice(0, maxItems)) {
    if (!nome) continue;
    const r = { nome };
    // status runtime (não tocar)
    r.inPerfisJson = perfisSet.has(nome);
    r.inDesired = !!(desiredPerfis && desiredPerfis[nome]);

    // dados/perfis/<nome>
    const perfDir = path.join(fileStore.perfisDir, nome);
    r.perfDirExists = safeExists(perfDir);
    const perfilRecPath = path.join(perfDir, 'perfil.json');
    const issuesPath = path.join(perfDir, 'issues.json');
    r.perfilRecordExists = safeExists(perfilRecPath);
    r.issuesExists = safeExists(issuesPath);

    // perfil.json (sanitizado)
    if (r.perfilRecordExists) {
      const rec = safeReadJson(perfilRecPath);
      const st = safeStat(perfilRecPath);
      r.perfilRecord = rec && typeof rec === 'object' ? {
        nome: rec.nome ? String(rec.nome) : null,
        cidade: rec.cidade ? String(rec.cidade) : null,
        label: rec.label ? String(rec.label) : null,
        uaPresetId: rec.uaPresetId ? String(rec.uaPresetId) : null,
        userDataDirPresent: !!rec.userDataDir,
        stockAccountId: (rec.stockAccountId || rec.stock_account_id) ? (Number(rec.stockAccountId || rec.stock_account_id) || null) : null,
        createdAt: (typeof rec.createdAt === 'number') ? rec.createdAt : null,
        updatedAt: (typeof rec.updatedAt === 'number') ? rec.updatedAt : null
      } : null;
      r.perfilRecordMeta = {
        bytes: Number(st && st.size || 0) || 0,
        mtimeMs: Number(st && st.mtimeMs || 0) || 0
      };
    }

    // issues.json (apenas últimos N tipos/mensagens truncadas)
    if (r.issuesExists) {
      const arr = safeReadJson(issuesPath);
      const st = safeStat(issuesPath);
      const listIssues = Array.isArray(arr) ? arr : [];
      const tail = listIssues.slice(Math.max(0, listIssues.length - 12)).map(it => ({
        ts: (it && typeof it.ts === 'number') ? it.ts : null,
        type: it && it.type ? String(it.type).slice(0, 80) : null,
        message: it && it.message ? String(it.message).slice(0, 140) : null
      }));
      r.issuesMeta = {
        bytes: Number(st && st.size || 0) || 0,
        mtimeMs: Number(st && st.mtimeMs || 0) || 0,
        count: listIssues.length
      };
      r.issuesTail = tail;
      // sinal de delete manual (evidência)
      r.hasDeleteIssue = tail.some(x => x && x.type && String(x.type).includes('admin_delete_perfil'));
    }

    // manifest.json no User Data (padrão) — SANITIZADO
    const udir = (chromeRoot && nome) ? path.join(chromeRoot, 'Conveniente', nome) : null;
    r.userDataDir = udir;
    r.userDataDirExists = udir ? safeExists(udir) : null;
    const manPath = udir ? path.join(udir, 'manifest.json') : null;
    r.manifestPath = manPath;
    r.manifestExists = manPath ? safeExists(manPath) : null;
    if (r.manifestExists) {
      const st = safeStat(manPath);
      const man = safeReadJson(manPath);
      r.manifestMeta = {
        bytes: Number(st && st.size || 0) || 0,
        mtimeMs: Number(st && st.mtimeMs || 0) || 0
      };
      if (man && typeof man === 'object') {
        const cookiesArr = Array.isArray(man.cookies) ? man.cookies : [];
        const cookieNames = new Set(cookiesArr.map(c => c && c.name ? String(c.name) : '').filter(Boolean));
        // cookie_fp (sha1) compatível com CT: sha1(`c_user=<...>;xs=<...>;datr=<...>`)
        let cookieFp = null;
        try {
          if (cookiesArr.length) {
            const crypto = require('crypto');
            const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');
            const byName = new Map(cookiesArr.map(c => [String(c && c.name || '').trim(), String(c && c.value || '')]));
            const cUser = byName.get('c_user') || '';
            const xs = byName.get('xs') || '';
            const datr = byName.get('datr') || '';
            if (cUser && xs) cookieFp = sha1(`c_user=${cUser};xs=${xs};datr=${datr}`);
          }
        } catch {}
        r.manifest = {
          nome: man.nome ? String(man.nome) : null,
          cidade: man.cidade ? String(man.cidade) : null,
          label: man.label ? String(man.label) : null,
          stockAccountId: (man.stockAccountId || man.stock_account_id) ? (Number(man.stockAccountId || man.stock_account_id) || null) : null,
          hasLogin: typeof man.login === 'string' && man.login.length > 0,
          hasPassword: typeof man.password === 'string' && man.password.length > 0,
          cookiesCount: cookiesArr.length,
          has_c_user: cookieNames.has('c_user'),
          has_xs: cookieNames.has('xs'),
          has_datr: cookieNames.has('datr'),
          cookie_fp: cookieFp
        };
      } else {
        r.manifest = null;
      }
    }

    results.push(r);
    await sleep(5);
  }

  const outDir = path.join(__dirname, '..', 'dados', '_ops_audit');
  try { fsSync.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, `profiles_manifest_probe_${nowMs}_${String(cmd && cmd.id || '').slice(0, 18) || 'cmd'}.json`);
  try {
    fsSync.writeFileSync(outPath, JSON.stringify({
      ok: true,
      hostNowMs: nowMs,
      cmdId: cmd && cmd.id ? String(cmd.id) : null,
      chromeRoot: chromeRoot || null,
      requestedCount: list.length,
      processedCount: results.length,
      results
    }, null, 2), 'utf8');
  } catch {}

  // ACK compacto (sem dados sensíveis)
  const sample = results.slice(0, 80).map(r => ({
    nome: r.nome,
    inPerfisJson: r.inPerfisJson,
    inDesired: r.inDesired,
    perfDirExists: r.perfDirExists,
    perfilRecordExists: r.perfilRecordExists,
    issuesExists: r.issuesExists,
    hasDeleteIssue: r.hasDeleteIssue || false,
    userDataDirExists: r.userDataDirExists,
    manifestExists: r.manifestExists,
    manifest: r.manifest ? {
      stockAccountId: r.manifest.stockAccountId || null,
      hasLogin: !!r.manifest.hasLogin,
      hasPassword: !!r.manifest.hasPassword,
      cookiesCount: Number(r.manifest.cookiesCount || 0) || 0,
      has_c_user: !!r.manifest.has_c_user,
      has_xs: !!r.manifest.has_xs,
      cookie_fp: r.manifest.cookie_fp || null
    } : null
  }));

  return {
    ok: true,
    requestedCount: list.length,
    processedCount: results.length,
    reportPath: outPath,
    sample
  };
}

// ===== NOVO: profiles_relink_orphans (re-cadastrar órfãos no perfis.json) =====
// Objetivo: permitir teste visual/humano de perfis órfãos que ainda têm Chrome profile no disco.
// Regras:
// - NÃO apaga nada.
// - Só relinka se:
//   - NÃO está em perfis.json
//   - userDataDir existe (chromeRoot/Conveniente/<nome>)
//   - manifest.json existe e tem shape mínimo
// - Não devolve cookies no ACK (somente counts/flags).
async function execProfilesRelinkOrphans(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const names0 = Array.isArray(payload.profileNames) ? payload.profileNames : (Array.isArray(payload.names) ? payload.names : []);
  const list = names0.map(x => String(x || '').trim()).filter(Boolean);
  const maxItems = Math.max(5, Math.min(300, Number(payload.maxItems || 80) || 80));
  const nowMs = Date.now();

  const safeExists = (p) => { try { return !!(p && fsSync.existsSync(p)); } catch { return false; } };
  const safeStat = (p) => { try { return fsSync.statSync(p); } catch { return null; } };
  const safeReadJson = (p) => { try { return JSON.parse(fsSync.readFileSync(p, 'utf8')); } catch { return null; } };

  const resolveChromeUserDataRoot = () => {
    try {
      if (process.platform === 'win32') {
        const la = process.env.LOCALAPPDATA;
        if (la) return path.join(la, 'Google', 'Chrome', 'User Data');
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
      }
      return path.join(os.homedir(), '.config', 'google-chrome');
    } catch { return null; }
  };
  const chromeRoot = resolveChromeUserDataRoot();

  const perfisArr = Array.isArray(fileStore.loadPerfisJson()) ? (fileStore.loadPerfisJson() || []) : [];
  const perfisSet = new Set(perfisArr.map(p => p && p.nome ? String(p.nome) : '').filter(Boolean));
  let desiredPerfis = {};
  try {
    const j = fileStore.readJsonSafe(fileStore.desiredPath, null);
    desiredPerfis = (j && j.perfis && typeof j.perfis === 'object') ? j.perfis : {};
  } catch { desiredPerfis = {}; }

  const results = [];
  for (const nome of list.slice(0, maxItems)) {
    const item = { nome, ok: false, skipped: false, reason: null };
    if (!nome || nome.toLowerCase() === 'system') {
      item.skipped = true; item.reason = 'invalid_name'; results.push(item); continue;
    }
    if (perfisSet.has(nome)) {
      item.skipped = true; item.reason = 'still_in_perfis'; results.push(item); continue;
    }
    if (!chromeRoot) {
      item.skipped = true; item.reason = 'chrome_root_unavailable'; results.push(item); continue;
    }
    const udir = path.join(chromeRoot, 'Conveniente', nome);
    const manPath = path.join(udir, 'manifest.json');
    if (!safeExists(udir) || !safeExists(manPath)) {
      item.skipped = true; item.reason = 'missing_userData_or_manifest'; results.push(item); continue;
    }
    const man = safeReadJson(manPath);
    if (!man || typeof man !== 'object') {
      item.skipped = true; item.reason = 'manifest_invalid'; results.push(item); continue;
    }
    const cookiesArr = Array.isArray(man.cookies) ? man.cookies : [];
    const byName = new Set(cookiesArr.map(c => c && c.name ? String(c.name) : '').filter(Boolean));

    // Monta objeto de perfil (sem inventar nada): usa dados do manifest quando disponíveis.
    const perfilObj = {
      nome: String(nome),
      cidade: man.cidade ? String(man.cidade) : null,
      label: man.label ? String(man.label) : null,
      uaPresetId: man.uaPresetId ? String(man.uaPresetId) : 'default',
      uaString: man.uaString ? String(man.uaString) : null,
      uaCh: (man.uaCh && typeof man.uaCh === 'object') ? man.uaCh : {},
      fp: (man.fp && typeof man.fp === 'object') ? man.fp : {},
      cookies: cookiesArr, // necessário para “como se estivesse cadastrada”; NÃO expor no ACK
      robeCooldownUntil: (typeof man.robeCooldownUntil === 'number') ? man.robeCooldownUntil : 0,
      configuredAt: (man.configuredAt !== undefined) ? man.configuredAt : null,
      userDataDir: udir,
      createdAt: (typeof man.createdAt === 'number') ? man.createdAt : nowMs,
      recoveredAt: nowMs
    };

    // 1) gravar em perfis.json (lock)
    const wr = fileStore.withPerfisFileLockUpdate((arr) => {
      const next = Array.isArray(arr) ? arr.slice() : [];
      if (next.some(p => p && p.nome === nome)) return next;
      next.push(perfilObj);
      return next;
    }, { caller: 'profiles_relink_orphans', reason: `relink:${nome}` });
    if (!wr || wr.ok === false) {
      item.ok = false; item.reason = (wr && wr.error) ? String(wr.error) : 'perfis_write_failed';
      results.push(item);
      continue;
    }

    // 2) desired: manter desligado + hold humano (evita auto abrir/trabalhar)
    try {
      await fileStore.withDesiredFileLockUpdate(desired => {
        desired.perfis = desired.perfis || {};
        desired.perfis[nome] = { ...(desired.perfis[nome] || {}), active: false, virtus: 'off', humanHold: true, recovered: true };
        return desired;
      });
    } catch {}

    // 3) record redundante (sem secrets)
    try { fileStore.writePerfilRecord && fileStore.writePerfilRecord(perfilObj, { caller: 'profiles_relink_orphans' }); } catch {}

    const stMan = safeStat(manPath);
    item.ok = true;
    item.reason = 'relinked';
    item.summary = {
      userDataDirExists: true,
      manifestExists: true,
      manifestMtimeMs: Number(stMan && stMan.mtimeMs || 0) || 0,
      cookiesCount: cookiesArr.length,
      has_c_user: byName.has('c_user'),
      has_xs: byName.has('xs'),
      hasLogin: typeof man.login === 'string' && man.login.length > 0,
      hasPassword: typeof man.password === 'string' && man.password.length > 0
    };
    results.push(item);
    await sleep(10);
  }

  const okCount = results.filter(r => r && r.ok).length;
  const skippedCount = results.filter(r => r && r.skipped).length;
  const failCount = results.length - okCount - skippedCount;

  const outDir = path.join(__dirname, '..', 'dados', '_ops_audit');
  try { fsSync.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, `profiles_relink_orphans_${nowMs}_${String(cmd && cmd.id || '').slice(0, 18) || 'cmd'}.json`);
  try { fsSync.writeFileSync(outPath, JSON.stringify({ ok: true, hostNowMs: nowMs, cmdId: cmd && cmd.id ? String(cmd.id) : null, okCount, skippedCount, failCount, results }, null, 2), 'utf8'); } catch {}

  return {
    ok: failCount === 0,
    requestedCount: list.length,
    processedCount: results.length,
    okCount,
    skippedCount,
    failCount,
    reportPath: outPath,
    sample: results.slice(0, 120)
  };
}

// ===== NOVO: repair_perfis_json (reparo cirúrgico de corrupção) =====
// Objetivo:
// - recuperar perfis.json quando estiver inválido (JSON corrompido),
// - sem fallback de leitura para "maquiar" dashboard,
// - com escrita atômica + validação pós-write.
//
// Fontes de recuperação (ordem de preferência):
// 1) perfis.json.old (se válido)
// 2) perfis.json.bak_last (se válido)
// 3) records em dados/perfis/*/perfil.json (best-effort, sem cookies)
//
// Segurança:
// - Nunca apaga dados.
// - Mantém snapshot forense do arquivo corrompido em dados/_ops_audit.
// - Se não houver fonte válida, falha explicitamente (sem "inventar" lista).
async function execRepairPerfisJson(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const allowRebuildFromRecords = (payload.allowRebuildFromRecords === true || payload.allowRebuildFromRecords === 1 || payload.allowRebuildFromRecords === '1');
  const nowMs = Date.now();
  const perfisFile = fileStore.perfisPath;
  const oldFile = `${perfisFile}.old`;
  const bakFile = `${perfisFile}.bak_last`;

  const outDir = path.join(__dirname, '..', 'dados', '_ops_audit');
  try { fsSync.mkdirSync(outDir, { recursive: true }); } catch {}

  const readRaw = (fp) => {
    try { return fsSync.readFileSync(fp, 'utf8'); } catch { return null; }
  };
  const parseArrayFile = (fp) => {
    try {
      if (!fp || !fsSync.existsSync(fp)) return { ok: false, error: 'not_found', path: fp };
      const raw = String(fsSync.readFileSync(fp, 'utf8') || '').replace(/^\uFEFF/, '');
      const j = JSON.parse(raw);
      if (!Array.isArray(j)) return { ok: false, error: 'invalid_shape_not_array', path: fp };
      const st = fsSync.statSync(fp);
      return { ok: true, path: fp, arr: j, count: j.length, mtimeMs: Number(st && st.mtimeMs || 0) || 0 };
    } catch (e) {
      return { ok: false, error: (e && e.message) ? String(e.message) : String(e), path: fp };
    }
  };
  const desiredCount = (() => {
    try {
      const d = fileStore.readJsonSafe(fileStore.desiredPath, null);
      const p = d && d.perfis && typeof d.perfis === 'object' ? d.perfis : {};
      return Object.keys(p).length;
    } catch { return null; }
  })();

  const current = parseArrayFile(perfisFile);
  if (current.ok) {
    return {
      ok: true,
      alreadyValid: true,
      source: 'current',
      count: current.count,
      desiredCount
    };
  }

  // Snapshot forense do arquivo atual inválido (se existir).
  try {
    const raw = readRaw(perfisFile);
    if (raw !== null) {
      fsSync.writeFileSync(path.join(outDir, `repair_perfis_corrupt_snapshot_${nowMs}_${String(cmd && cmd.id || 'cmd').slice(0, 18)}.txt`), raw, 'utf8');
    }
  } catch {}

  const cOld = parseArrayFile(oldFile);
  const cBak = parseArrayFile(bakFile);
  const candidates = [cOld, cBak].filter(x => x && x.ok);
  // Melhor backup: mais recente; empate por maior count.
  candidates.sort((a, b) => {
    const d1 = Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0);
    if (d1 !== 0) return d1;
    return Number(b.count || 0) - Number(a.count || 0);
  });

  let source = null;
  let nextArr = null;
  if (candidates.length > 0) {
    source = candidates[0];
    nextArr = Array.isArray(source.arr) ? source.arr : null;
  } else if (allowRebuildFromRecords && fileStore.loadPerfisFromRecordsBestEffort) {
    try {
      const rebuilt = fileStore.loadPerfisFromRecordsBestEffort(10000) || [];
      if (Array.isArray(rebuilt) && rebuilt.length > 0) {
        source = { path: 'records_best_effort', count: rebuilt.length, mtimeMs: nowMs };
        nextArr = rebuilt;
      }
    } catch {}
  }

  if (!Array.isArray(nextArr) || nextArr.length === 0) {
    return {
      ok: false,
      error: 'no_valid_recovery_source',
      currentError: current.error || 'invalid_current',
      old: { ok: cOld.ok === true, error: cOld.error || null, count: cOld.count || 0 },
      bak_last: { ok: cBak.ok === true, error: cBak.error || null, count: cBak.count || 0 },
      desiredCount
    };
  }

  // Lock simples (arquivo) para evitar concorrência na troca do perfis.json.
  const lockPath = `${perfisFile}.lock`;
  let lockFd = null;
  try {
    const maxTries = 240;
    for (let i = 0; i < maxTries; i++) {
      try {
        lockFd = fsSync.openSync(lockPath, 'wx');
        break;
      } catch {
        const now = Date.now();
        try {
          if (fsSync.existsSync(lockPath)) {
            const st = fsSync.statSync(lockPath);
            const age = now - (Number(st && st.mtimeMs || 0) || now);
            if (age > 120000) {
              try { fsSync.unlinkSync(lockPath); } catch {}
            }
          }
        } catch {}
        await sleep(25);
      }
    }
    if (typeof lockFd !== 'number') {
      return { ok: false, error: 'repair_perfis_lock_timeout', source: source ? source.path : null };
    }
    const okWrite = fileStore.writeJsonAtomic(perfisFile, nextArr);
    if (!okWrite) {
      return { ok: false, error: 'repair_write_failed', source: source ? source.path : null };
    }
  } finally {
    try { if (typeof lockFd === 'number') fsSync.closeSync(lockFd); } catch {}
    try { if (typeof lockFd === 'number') fsSync.unlinkSync(lockPath); } catch {}
  }

  const after = parseArrayFile(perfisFile);
  if (!after.ok) {
    return {
      ok: false,
      error: 'repair_post_validation_failed',
      source: source ? source.path : null,
      postError: after.error || 'invalid_after'
    };
  }

  const report = {
    ok: true,
    ts: nowMs,
    cmdId: cmd && cmd.id ? String(cmd.id) : null,
    source: source ? source.path : null,
    count: after.count,
    desiredCount
  };
  try {
    fsSync.writeFileSync(
      path.join(outDir, `repair_perfis_json_${nowMs}_${String(cmd && cmd.id || 'cmd').slice(0, 18)}.json`),
      JSON.stringify(report, null, 2),
      'utf8'
    );
  } catch {}

  return report;
}

// ===== NOVO: profiles_backfill_labels (recupera nome amigável em perfis existentes) =====
// Objetivo:
// - preencher `label` ausente em perfis já presentes no perfis.json;
// - fonte canônica: dados/perfis/<nome>/perfil.json; fallback: manifest.json do userDataDir.
// - não altera nome interno do perfil.
async function execProfilesBackfillLabels(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const maxItems = Math.max(10, Math.min(2000, Number(payload.maxItems || 1000) || 1000));
  const nowMs = Date.now();

  const safeReadJson = (fp) => {
    try { return JSON.parse(fsSync.readFileSync(fp, 'utf8')); } catch { return null; }
  };

  const perfisArr = Array.isArray(fileStore.loadPerfisJson()) ? (fileStore.loadPerfisJson() || []) : [];
  const beforeMissing = perfisArr.filter(p => !String((p && p.label) || '').trim()).length;

  const targets = perfisArr
    .filter(p => p && p.nome && !String(p.label || '').trim())
    .slice(0, maxItems);

  const updates = [];
  const notFound = [];
  for (const p of targets) {
    const nome = String(p.nome || '').trim();
    if (!nome) continue;
    let nextLabel = '';
    let source = '';

    try {
      const recPath = path.join(fileStore.perfisDir, nome, 'perfil.json');
      const rec = safeReadJson(recPath);
      const recLabel = String((rec && rec.label) || '').trim();
      if (recLabel) {
        nextLabel = recLabel;
        source = 'perfil_record';
      }
    } catch {}

    if (!nextLabel) {
      try {
        const udir = String((p && p.userDataDir) || '').trim();
        if (udir) {
          const man = safeReadJson(path.join(udir, 'manifest.json'));
          const manLabel = String((man && man.label) || '').trim();
          if (manLabel) {
            nextLabel = manLabel;
            source = 'manifest';
          }
        }
      } catch {}
    }

    if (nextLabel) updates.push({ nome, label: nextLabel, source });
    else notFound.push(nome);
  }

  let writeResult = { ok: true };
  if (updates.length > 0) {
    writeResult = fileStore.withPerfisFileLockUpdate((arr) => {
      const list = Array.isArray(arr) ? arr.slice() : [];
      const byNome = new Map(updates.map(u => [u.nome, u]));
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!it || !it.nome) continue;
        if (String(it.label || '').trim()) continue;
        const u = byNome.get(String(it.nome));
        if (!u) continue;
        list[i] = { ...it, label: u.label };
      }
      return list;
    }, { caller: 'profiles_backfill_labels', reason: `cmd:${String(cmd && cmd.id || '').slice(0, 32)}` });
    if (!writeResult || writeResult.ok === false) {
      return {
        ok: false,
        error: (writeResult && writeResult.error) ? String(writeResult.error) : 'perfis_write_failed',
        beforeMissing,
        targeted: targets.length,
        plannedUpdates: updates.length,
        unresolved: notFound.length
      };
    }
  }

  // Record redundante: mantém alinhado com label recuperado.
  for (const u of updates) {
    try {
      const recPath = path.join(fileStore.perfisDir, u.nome, 'perfil.json');
      const rec = safeReadJson(recPath) || {};
      rec.nome = rec.nome || u.nome;
      rec.label = u.label;
      rec.updatedAt = nowMs;
      fsSync.mkdirSync(path.dirname(recPath), { recursive: true });
      fsSync.writeFileSync(recPath, JSON.stringify(rec, null, 2), 'utf8');
    } catch {}
  }

  const afterPerfis = Array.isArray(fileStore.loadPerfisJson()) ? (fileStore.loadPerfisJson() || []) : [];
  const afterMissing = afterPerfis.filter(p => !String((p && p.label) || '').trim()).length;

  const outDir = path.join(__dirname, '..', 'dados', '_ops_audit');
  try { fsSync.mkdirSync(outDir, { recursive: true }); } catch {}
  const outPath = path.join(outDir, `profiles_backfill_labels_${nowMs}_${String(cmd && cmd.id || '').slice(0, 18) || 'cmd'}.json`);
  const report = {
    ok: true,
    ts: nowMs,
    cmdId: cmd && cmd.id ? String(cmd.id) : null,
    beforeMissing,
    targeted: targets.length,
    updated: updates.length,
    unresolved: notFound.length,
    afterMissing,
    sampleUpdated: updates.slice(0, 120),
    sampleUnresolved: notFound.slice(0, 120)
  };
  try { fsSync.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8'); } catch {}

  return { ...report, reportPath: outPath };
}

// ===== NOVO: login_remediate (teste/controlado via comando remoto) =====
async function execLoginRemediate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const nome = String(payload.profileName || payload.nome || '').trim();
  if (!nome) throw new Error('missing_profileName');
  const operator = `login_remediate:${String(cmd && cmd.id || '').trim() || Date.now()}`;
  const timeoutMs = Math.max(30_000, Number(payload.timeoutMs || 0) || (8 * 60 * 1000));

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'login_remediate_cmd_begin',
      cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
      nome,
      operator,
      timeoutMs
    });
  } catch {}

  // Enterprise: após restart, pode haver race onde o worker ainda está subindo.
  // Retry curto e controlado (sem loop infinito) para evitar "falso fail".
  const isTransient = (err) => {
    const m = String(err || '').toLowerCase();
    return m.includes('worker off') || m.includes('queue_timeout') || m.includes('timeout') || m.includes('supervisor_unreachable');
  };
  let r = null;
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // IMPORTANT: cluster-safe path (single source of truth):
    // chama endpoint local, que por sua vez chama workerClient do CLUSTER (clusterMaster),
    // evitando abrir browsers em um "worker paralelo" fora do cluster.
    r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/login-remediate`, {
      method: 'POST',
      headers: { 'x-operator': operator },
      body: { options: (payload && payload.options ? payload.options : {}), timeoutMs }
    }).catch(() => null);

    if (r && r.ok !== false) break;
    const err = (r && r.error) ? String(r.error) : 'login_remediate_failed';
    if (!isTransient(err) || attempt >= maxAttempts) break;
    try { provisionAudit.append({ ts: Date.now(), event: 'login_remediate_retry', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, nome, operator, attempt, error: err }); } catch {}
    await sleep(2500);
  }
  if (!r || r.ok === false) {
    const err = (r && r.error) ? String(r.error) : 'login_remediate_failed';
    try {
      provisionAudit.append({
        ts: Date.now(),
        event: 'login_remediate_cmd_fail',
        cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
        nome,
        operator,
        error: err,
        details: (r && typeof r === 'object') ? r : null
      });
    } catch {}
    return { ok: false, nome, error: err, details: r || null };
  }

  try {
    provisionAudit.append({
      ts: Date.now(),
      event: 'login_remediate_cmd_done',
      cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
      nome,
      operator,
      result: r
    });
  } catch {}

  return Object.assign({ ok: true, nome }, r);
}

// ===== NOVO: Deletar perfis remotamente (para limpeza de duplicados) =====
async function execDeletePerfis(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const one = String(payload.profileName || payload.nome || '').trim();
  const many = Array.isArray(payload.profileNames) ? payload.profileNames.map(x => String(x || '').trim()).filter(Boolean) : [];
  const list = one ? [one] : many;
  if (!list.length) throw new Error('missing_profileNames');

  const results = [];
  for (const nome of list) {
    try {
      // IMPORTANTE (forense/ops):
      // Mesmo que o perfil não esteja no perfis.json, ainda podemos precisar limpar:
      // - desired.perfis[nome] (sobras)
      // - dados/perfis/<nome> (pastas órfãs)
      // - Chrome User Data/Conveniente/<nome> (best-effort)
      // A rota DELETE já faz esse cleanup. Portanto, NÃO short-circuit aqui.
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}`, { method: 'DELETE' });
      if (!r || r.ok === false) {
        results.push({ nome, ok: false, error: (r && r.error) ? String(r.error) : 'delete_failed' });
      } else {
        results.push({ nome, profileName: nome, ok: true, alreadyDeleted: !!r.alreadyDeleted });
      }
    } catch (e) {
      results.push({ nome, ok: false, error: (e && e.message) || String(e) });
    }
  }
  const okCount = results.filter(x => x && x.ok).length;
  const failCount = results.length - okCount;
  return { ok: failCount === 0, okCount, failCount, results };
}

function migrationsLogAppend(obj) {
  try {
    const p = path.join(__dirname, '..', 'dados', 'migrations.jsonl');
    fsSync.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
  } catch {}
}

async function execMigrateProfiles(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const batchId = String(payload.batchId || '').trim();
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (!batchId) throw new Error('missing_batchId');
  if (!actions.length) throw new Error('missing_actions');

  // Idempotência: não repetir um batch já aplicado automaticamente
  const appliedPath = path.join(__dirname, '..', 'dados', `.migrations_applied_${batchId}`);
  if (fsSync.existsSync(appliedPath)) {
    migrationsLogAppend({ event: 'migrate_skip_already_applied', batchId, cmdId: cmd && cmd.id });
    return;
  }

  // Snapshot atual para validar fromCity exato
  let st = null;
  try { st = await httpJson('/api/status'); } catch {}
  const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
  const byName = new Map(perfis.map(p => [String(p && p.nome || '').trim(), p]));

  const results = [];
  for (const a of actions) {
    const nome = String(a && a.nome || '').trim();
    const fromCity = String(a && a.fromCity || '').trim();
    const toCity = String(a && a.toCity || '').trim();
    if (!nome || !fromCity || !toCity) {
      results.push({ nome, ok: false, error: 'missing_fields' });
      continue;
    }
    const cur = byName.get(nome) || null;
    const curCity = cur ? String(cur.cidade || '') : '';
    if (!cur || !curCity) {
      results.push({ nome, ok: false, error: 'profile_not_found' });
      continue;
    }
    if (curCity !== fromCity) {
      results.push({ nome, ok: false, error: 'from_mismatch', curCity, fromCity });
      migrationsLogAppend({ event: 'migrate_action_skip', batchId, nome, error: 'from_mismatch', curCity, fromCity });
      continue;
    }
    try {
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/cidade`, {
        method: 'PATCH',
        headers: { 'x-operator': 'contas-facebook-auto' },
        body: { novaCidade: toCity }
      });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'api_failed');
      results.push({ nome, ok: true, fromCity, toCity });
      migrationsLogAppend({ event: 'migrate_action_ok', batchId, nome, fromCity, toCity });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      results.push({ nome, ok: false, error: msg, fromCity, toCity });
      migrationsLogAppend({ event: 'migrate_action_fail', batchId, nome, fromCity, toCity, error: msg });
    }
  }

  try { fsSync.writeFileSync(appliedPath, `${Date.now()}\n`, 'utf8'); } catch {}

  const okCount = results.filter(r => r && r.ok).length;
  const failCount = results.length - okCount;
  migrationsLogAppend({ event: 'migrate_batch_done', batchId, cmdId: cmd && cmd.id, okCount, failCount });
  const out = {
    ok: failCount === 0,
    batchId,
    okCount,
    failCount,
    results
  };
  return out;
}

async function execStockProvision(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const batchId = String(payload.batchId || '').trim() || String(cmd && cmd.id || '').trim();
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  if (!batchId) throw new Error('missing_batchId');
  if (!actions.length) throw new Error('missing_actions');

  const tBatch0 = Date.now();
  const sleepMs = (ms) => new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)));
  const stockAuthModeRaw = String(process.env.STOCK_PROVISION_AUTH_MODE || 'cookies_first').trim().toLowerCase();
  const stockAuthMode = (stockAuthModeRaw === 'password_first') ? 'password_first' : 'cookies_first';

  // Hardening: lock global com TTL para isolamento total durante provisão.
  // Evita concorrência (already_opening / slot storms) e permite hard-recovery com segurança.
  // P1 policy (humano): permitir esperar busy por mais tempo, com deadline hard (evita “reserved preso”).
  // Default anterior (8min) era curto para ambientes com muitos perfis ativos.
  const budgetMs = Math.max(30_000, Number(process.env.STOCK_PROVISION_BUDGET_MS || (20 * 60 * 1000)) || (20 * 60 * 1000));
  const lockOwner = `stock_provision:${batchId}`;
  // P0 hardening (2026-01-30): se provision_lock estiver ocupado, NÃO falhar imediato.
  // Esperar até ficar livre (dentro do budget) — evita “conta liberada mas não cadastrou”.
  let lk = null;
  let lockAttempts = 0;
  while (true) {
    lockAttempts++;
    lk = provisionLock.tryAcquire({
      owner: lockOwner,
      ttlMs: Math.max(9 * 60 * 1000, budgetMs + (2 * 60 * 1000)),
      meta: { kind: 'stock_provision', batchId, cmdId: String(cmd && cmd.id || '') || null }
    });
    if (lk && lk.ok) break;
    const curOwner = lk && lk.lock && lk.lock.owner ? String(lk.lock.owner) : '';
    const waitedMs = Date.now() - tBatch0;
    try {
      provisionAudit.append({
        event: 'stock_provision_wait_provision_lock',
        cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
        batchId,
        attempt: lockAttempts,
        waitedMs,
        curOwner: curOwner || null
      });
    } catch {}
    if (waitedMs >= budgetMs) {
      throw new Error(`provision_lock_busy${curOwner ? ` owner=${curOwner}` : ''} waitedMs=${waitedMs} attempts=${lockAttempts}`);
    }
    // Backoff leve para não martelar o lock file.
    const base = [800, 1200, 2000, 3000, 5000][Math.min(4, Math.max(0, lockAttempts - 1))];
    const jitter = Math.floor(Math.random() * 350);
    await sleepMs(Math.min(base + jitter, Math.max(250, budgetMs - waitedMs)));
  }

  // Se o CT informar capacidade manual, aplica no runtime config local antes de criar perfil.
  // Fonte de verdade operacional: valor manual definido no painel de estoque do CT.
  const capacityMaxManual = Number(payload && payload.capacityMaxManual || 0) || 0;
  if (capacityMaxManual > 0) {
    const capSync = await httpJson('/api/server-config', {
      method: 'POST',
      headers: { 'x-operator': lockOwner },
      timeoutMs: 60_000,
      body: {
        capacity: {
          mode: 'absolute',
          maxAccountsOverride: Math.max(1, Math.floor(capacityMaxManual))
        },
        applyNow: false
      }
    });
    if (!capSync || capSync.ok === false) {
      const capErr = String((capSync && capSync.error) || 'capacity_sync_failed');
      throw new Error(`capacity_sync_failed:${capErr}`);
    }
    try {
      provisionAudit.append({
        event: 'stock_provision_capacity_synced_from_ct',
        cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
        batchId,
        requestedCapacityMaxManual: Math.max(1, Math.floor(capacityMaxManual)),
        appliedMaxAccountsEffective: Number(capSync && capSync.config && capSync.config.capacity && capSync.config.capacity.maxAccountsEffective || 0) || null
      });
    } catch {}
  }

  // Política ultra enterprise:
  // - durante provisão, o 1GB/node é "emprestável" (Robe/Virtus ficam controlados)
  // - então o headroom mínimo vira: 2GB (host) + pico de cookies (~1.5GB)
  const snapPolicy = ramPolicy.snapshotPolicy();
  const minFreeEnv = Math.max(0, Number(process.env.STOCK_PROVISION_MIN_FREE_MB || 0) || 0);
  const minFreeMB = minFreeEnv > 0 ? minFreeEnv : snapPolicy.reserveProvisionMB;
  const maxHardDeactivations = Math.max(0, Number(process.env.STOCK_PROVISION_MAX_HARD_DEACTIVATIONS || 4) || 4);
  try {
    provisionAudit.append({
      event: 'stock_provision_begin',
      cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
      batchId,
      actionsCount: actions.length,
      stockAuthMode,
      minFreeMB,
      maxHardDeactivations,
      lockOwner,
      lockUntilMs: (lk && lk.lock && lk.lock.untilMs) ? lk.lock.untilMs : null
    });
  } catch {}

  const budgetLeftMs = () => Math.max(0, budgetMs - (Date.now() - tBatch0));
  const jitter = (n) => Math.floor(Math.random() * Math.max(1, n));
  const backoffMs = (attempt) => {
    const base = [2000, 5000, 10000, 15000, 20000][Math.min(4, Math.max(0, attempt - 1))];
    return base + jitter(700);
  };

  const normalizeErr = (e) => {
    const msg = (e && e.message) ? String(e.message) : String(e || '');
    return msg.trim().slice(0, 500);
  };
  const isTransient = (msg) => {
    const m = String(msg || '').toLowerCase();
    return (
      m.includes('timeout') ||
      m.includes('already_opening') ||
      // Gateway strict mode: perfil novo pode existir alguns segundos antes do
      // assignment do CT chegar; nesse intervalo, activate deve retryar.
      m.includes('gateway_proxy_required:missing_slot_assignment') ||
      m.includes('gateway_proxy_required:assigned_slot_unavailable') ||
      m.includes('gateway_geo_required:missing_slot_geo') ||
      m.includes('gateway_geo_required:missing_slot_assignment') ||
      m.includes('gateway_geo_required:assigned_slot_unavailable') ||
      // Provision pode pegar cooldown curto após tentativa de activate
      // enquanto o assignment de gateway ainda está propagando do CT.
      // Nesse caso precisamos continuar retryando dentro do budget.
      m.includes('supervisor_denied:cooldown') ||
      m.includes('supervisor_denied:slots') ||
      m.includes('supervisor_denied:ram_low') ||
      m.includes('supervisor_denied:maintenance_provision') ||
      m.includes('maintenance_provision') ||
      m.includes('ram_insuficiente_para_ativar') ||
      m.includes('impossível abrir nova conta por falta de ram') ||
      m.includes('supervisor_unreachable')
    );
  };

  async function getSysSnapshot() {
    try { return await httpJson('/api/sys'); } catch { return null; }
  }
  async function getFreeMB() {
    const s = await getSysSnapshot();
    return Number(s && s.mem && s.mem.freeMB || 0) || 0;
  }
  async function getStatusSnapshot() {
    try { return await httpJson('/api/status'); } catch { return null; }
  }

  function computeQuiesceSnapshot(st) {
    const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    const active = perfis.filter(p => p && p.nome && p.active === true);
    const busy = active.filter(p => (p.sendLockActive === true) || (p.robeEmExecucao === true));
    const pauseableVirtus = active.filter(p =>
      p.virtusOnline === true &&
      p.humanControl !== true &&
      p.configurando !== true &&
      p.sendLockActive !== true &&
      p.robeEmExecucao !== true
    );
    const virtusOnline = active.filter(p => p.virtusOnline === true);
    return {
      activeCount: active.length,
      busyCount: busy.length,
      busyNames: busy.map(p => String(p.nome)).slice(0, 40),
      // P1: evidência para “busy_timeout” (sem achismo)
      busyDetails: busy.map(p => ({
        nome: String(p && p.nome || ''),
        trabalhando: p && p.trabalhando === true,
        configurando: p && p.configurando === true,
        humanControl: p && p.humanControl === true,
        sendLockActive: p && p.sendLockActive === true,
        robeEmExecucao: p && p.robeEmExecucao === true,
        virtusOnline: p && p.virtusOnline === true
      })).slice(0, 40),
      pauseableVirtusCount: pauseableVirtus.length,
      pauseableVirtusNames: pauseableVirtus.map(p => String(p.nome)).slice(0, 40),
      // P1: evidência do que ainda está “pausável” (para debug de pause_timeout)
      pauseableVirtusDetails: pauseableVirtus.map(p => ({
        nome: String(p && p.nome || ''),
        trabalhando: p && p.trabalhando === true,
        configurando: p && p.configurando === true,
        humanControl: p && p.humanControl === true,
        sendLockActive: p && p.sendLockActive === true,
        robeEmExecucao: p && p.robeEmExecucao === true,
        virtusOnline: p && p.virtusOnline === true
      })).slice(0, 40),
      virtusOnlineCount: virtusOnline.length
    };
  }

  async function waitForQuiesce({ out, phaseBudgetMs, waitBusyMs, waitPauseMs }) {
    const startedAt = Date.now();
    const maxTotal = Math.max(0, Number(phaseBudgetMs) || 0);
    const maxBusy = Math.max(0, Number(waitBusyMs) || 0);
    const maxPause = Math.max(0, Number(waitPauseMs) || 0);

    const push = (obj) => { try { out.steps.push({ ...obj, at: Date.now() }); } catch {} };
    const audit = (obj) => { try { provisionAudit.append({ ts: Date.now(), cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, ...obj }); } catch {} };

    push({ step: 'quiesce_begin', waitBusyMs: maxBusy, waitPauseMs: maxPause });
    audit({ event: 'stock_provision_quiesce_begin', waitBusyMs: maxBusy, waitPauseMs: maxPause });

    // (A) Espera busy finalizar (respostas/postagens em andamento)
    if (maxBusy > 0) {
      const t0 = Date.now();
      let last = null;
      while ((Date.now() - t0) < maxBusy && (Date.now() - startedAt) < maxTotal) {
        const st = await getStatusSnapshot();
        const snap = computeQuiesceSnapshot(st);
        last = snap;
        if (snap.busyCount <= 0) break;
        await sleep(1200);
      }
      const st2 = await getStatusSnapshot();
      const snap2 = computeQuiesceSnapshot(st2);
      push({ step: 'quiesce_busy_done', ok: snap2.busyCount <= 0, busyCount: snap2.busyCount, busyNames: snap2.busyNames, busyDetails: snap2.busyDetails });
      audit({ event: 'stock_provision_quiesce_busy_done', ok: snap2.busyCount <= 0, busyCount: snap2.busyCount, busyNames: snap2.busyNames, busyDetails: snap2.busyDetails });
      if (snap2.busyCount > 0) {
        // Regra enterprise: NÃO prosseguir se não conseguiu garantir quiescência.
        throw new Error(`busy_timeout count=${snap2.busyCount} sample=${snap2.busyNames.slice(0, 8).join(',')}`);
      }
    }

    // (B) Espera Virtus pausado (exceto humano/config/ocupado)
    if (maxPause > 0) {
      const t1 = Date.now();
      while ((Date.now() - t1) < maxPause && (Date.now() - startedAt) < maxTotal) {
        const st = await getStatusSnapshot();
        const snap = computeQuiesceSnapshot(st);
        if (snap.pauseableVirtusCount <= 0) break;
        await sleep(900);
      }
      const st3 = await getStatusSnapshot();
      const snap3 = computeQuiesceSnapshot(st3);
      push({ step: 'quiesce_pause_done', ok: snap3.pauseableVirtusCount <= 0, pauseableVirtusCount: snap3.pauseableVirtusCount, pauseableVirtusNames: snap3.pauseableVirtusNames, pauseableVirtusDetails: snap3.pauseableVirtusDetails, virtusOnlineCount: snap3.virtusOnlineCount });
      audit({ event: 'stock_provision_quiesce_pause_done', ok: snap3.pauseableVirtusCount <= 0, pauseableVirtusCount: snap3.pauseableVirtusCount, pauseableVirtusNames: snap3.pauseableVirtusNames, pauseableVirtusDetails: snap3.pauseableVirtusDetails, virtusOnlineCount: snap3.virtusOnlineCount });
      if (snap3.pauseableVirtusCount > 0) {
        // P0 policy (2026-01-30): cadastro NÃO pode falhar por não conseguir "pausar Virtus".
        // Virtus pode continuar rodando; se faltar RAM, o fluxo já tem hardRecoverRam()/ensureFreeMBWithin().
        // Mantemos a telemetria para auditoria, mas seguimos (best-effort).
        try {
          push({
            step: 'quiesce_pause_best_effort',
            ok: true,
            note: 'pause_timeout_ignored_best_effort',
            pauseableVirtusCount: snap3.pauseableVirtusCount,
            sample: snap3.pauseableVirtusNames.slice(0, 8)
          });
        } catch {}
        audit({
          event: 'stock_provision_quiesce_pause_best_effort',
          ok: true,
          note: 'pause_timeout_ignored_best_effort',
          pauseableVirtusCount: snap3.pauseableVirtusCount,
          pauseableVirtusNames: snap3.pauseableVirtusNames,
          virtusOnlineCount: snap3.virtusOnlineCount
        });
      }
    }

    push({ step: 'quiesce_done', elapsedMs: Date.now() - startedAt });
    audit({ event: 'stock_provision_quiesce_done', elapsedMs: Date.now() - startedAt });
    return { ok: true, elapsedMs: Date.now() - startedAt };
  }
  async function ensureFreeMBWithin(minMB, maxWaitMs) {
    const t0 = Date.now();
    let last = 0;
    while ((Date.now() - t0) < Math.max(0, Number(maxWaitMs) || 0)) {
      try { last = await getFreeMB(); } catch { last = 0; }
      if (last >= minMB) return { ok: true, freeMB: last, waitedMs: Date.now() - t0 };
      await sleep(1200);
    }
    try { last = await getFreeMB(); } catch {}
    return { ok: false, freeMB: last, waitedMs: Date.now() - t0 };
  }
  async function hardRecoverRam({ out, minMB }) {
    const hard = { ok: true, attempts: 0, deactivated: 0, names: [] };
    while (hard.deactivated < maxHardDeactivations && budgetLeftMs() > 5000) {
      const free0 = await getFreeMB().catch(()=>0);
      if (free0 >= minMB) break;
      hard.attempts++;
      out.steps.push({ step: 'hard_ram_recover_check', at: Date.now(), freeMB: free0, minFreeMB: minMB });
      try {
        provisionAudit.append({ event: 'hard_ram_recover_check', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, attempt: hard.attempts, freeMB: free0, minFreeMB: minMB });
      } catch {}
      let st = null;
      try { st = await httpJson('/api/status'); } catch {}
      const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
      const actives = perfis
        .filter(p => p && p.nome && p.active === true && p.humanControl !== true && p.configurando !== true)
        .map(p => ({ nome: String(p.nome), ramMB: (typeof p.ramMB === 'number' ? p.ramMB : 0), trabalhando: !!p.trabalhando }))
        // preferir liberar o que está "menos crítico" primeiro: não trabalhando, depois maior RAM
        .sort((a, b) => {
          if (a.trabalhando !== b.trabalhando) return (a.trabalhando ? 1 : -1) - (b.trabalhando ? 1 : -1);
          return (Number(b.ramMB || 0) || 0) - (Number(a.ramMB || 0) || 0);
        });
      const pick = actives[0];
      if (!pick || !pick.nome) break;
      const nome = pick.nome;
      out.steps.push({ step: 'hard_ram_recover_deactivate', at: Date.now(), nome });
      try {
        provisionAudit.append({ event: 'hard_ram_recover_deactivate', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, nome, freeMB_before: free0 });
      } catch {}
      const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, {
        method: 'POST',
        headers: { 'x-operator': lockOwner },
        body: { policy: 'preserveDesired', reason: 'ramKill' }
      });
      if (!r || r.ok === false) {
        out.steps.push({ step: 'hard_ram_recover_deactivate_fail', at: Date.now(), nome, error: (r && r.error) ? String(r.error) : 'deactivate_failed' });
        try {
          provisionAudit.append({ event: 'hard_ram_recover_deactivate_fail', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, nome, error: (r && r.error) ? String(r.error) : 'deactivate_failed' });
        } catch {}
        break;
      }
      hard.deactivated++;
      hard.names.push(nome);
      // aguarda o SO liberar RAM
      await sleep(2000 + jitter(800));
    }
    try {
      provisionAudit.append({ event: 'hard_ram_recover_done', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, deactivated: hard.deactivated, names: hard.names.slice(0, 200) });
    } catch {}
    return hard;
  }

  // Serializa por ação (segurança) e retorna detalhes por etapa
  const results = [];
  try {
    for (const a of actions) {
      const startedAt = Date.now();
      const city = String(a && (a.city || a.cidade || a.toCity || a.city_uf) || '').trim();
      const cookies = a && a.cookies;
      const label = String(a && a.label || '').trim();
      const stockAccountId = (a && (a.stockAccountId || a.stock_account_id)) ? Number(a.stockAccountId || a.stock_account_id) : null;
      // Credenciais podem vir do CT Stock payload (não logar).
      const login = String(a && (a.login || a.user || a.email || a.username) || '').trim();
      const password = String(a && (a.password || a.pass) || '').trim();
      const category = String(a && a.category || '').trim().toLowerCase();
      const robeMode = (category === 'veiculos') ? 'veiculos' : 'itens';

      const out = {
        ok: false,
        batchId,
        stockAccountId,
        city,
        label,
        steps: [],
        profileName: null,
        robeMode,
        maintenanceMode: true,
        lockOwner,
        lockUntilMs: lk && lk.lock && lk.lock.untilMs || null,
        budgetMs,
        minFreeMB,
        retries: []
      };

      const runStep = async (step, fn) => {
        const maxAttempts = 20;
        let attempt = 0;
        while (true) {
          attempt++;
          const freeBefore = await getFreeMB().catch(()=>0);
          out.steps.push({ step, at: Date.now(), attempt, freeMB_before: freeBefore });
          try {
            const r = await fn();
            const freeAfter = await getFreeMB().catch(()=>0);
            out.steps.push({ step: `${step}_ok`, at: Date.now(), attempt, freeMB_after: freeAfter });
            return r;
          } catch (e) {
            const msg = normalizeErr(e);
            out.retries.push({ step, attempt, at: Date.now(), error: msg, budgetLeftMs: budgetLeftMs() });
            out.steps.push({ step: `${step}_fail`, at: Date.now(), attempt, error: msg });
            if (!isTransient(msg) || attempt >= maxAttempts || budgetLeftMs() <= 0) {
              throw new Error(msg || `${step}_failed`);
            }
            const waitMs = Math.min(backoffMs(attempt), Math.max(1000, budgetLeftMs() - 500));
            await sleep(waitMs);
            continue;
          }
        }
      };

      try {
        // 0) baseline telemetria
        out.steps.push({ step: 'lock_acquired', at: Date.now(), lockOwner, lockUntilMs: out.lockUntilMs });

        // 0.5) Stock provision NÃO deve pausar Robe/Virtus do servidor (requisito do lead).
        // O único guardrail necessário aqui é headroom (RAM) + supervisor slots.
        // Se o operador quiser reativar o quiesce legado, pode ligar via env.
        {
          const quiesceEnabled = String(process.env.STOCK_PROVISION_QUIESCE_ENABLED || '0').trim() === '1';
          if (quiesceEnabled) {
            // Legacy: quiescência determinística (busy + pause).
            const waitBusyMs = Math.max(0, Number(process.env.STOCK_PROVISION_WAIT_BUSY_MS || (10 * 60 * 1000)) || (10 * 60 * 1000));
            const waitPauseMs = Math.max(0, Number(process.env.STOCK_PROVISION_WAIT_PAUSE_MS || (2 * 60 * 1000)) || (2 * 60 * 1000));
            const phaseBudgetMs = Math.min(budgetLeftMs(), Math.max(20_000, waitBusyMs + waitPauseMs + 10_000));
            await waitForQuiesce({ out, phaseBudgetMs, waitBusyMs, waitPauseMs });
          } else {
            try {
              const st = await getStatusSnapshot();
              const snap = computeQuiesceSnapshot(st);
              provisionAudit.append({
                event: 'stock_provision_quiesce_skipped',
                cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
                batchId,
                quiesceEnabled: false,
                snap
              });
            } catch {}
            out.steps.push({ step: 'quiesce_skipped', at: Date.now() });
          }
        }

        // 1) criar perfil
        const created = await runStep('create_profile', async () => {
          const r = await httpJson('/api/perfis', {
            method: 'POST',
            headers: { 'x-operator': lockOwner },
            timeoutMs: Math.max(15_000, Math.min(90_000, budgetLeftMs() + 10_000)),
            // Ultra enterprise: persiste login/senha no manifest já na criação, para permitir fluxo
            // automático "cookies -> login+senha" sem depender de clique em "retomar trabalho".
            body: { cidade: city, cookies, login, password, stockAccountId }
          });
          if (!r || r.ok === false) {
            const err = String((r && r.error) || 'create_profile_failed');
            const existingProfile = String((r && r.existingProfile) || '').trim();
            if ((err === 'duplicate_c_user' || err === 'duplicate_stockAccountId') && existingProfile) {
              return { ok: true, perfil: { nome: existingProfile }, reusedExisting: true };
            }
            throw new Error(err);
          }
          return r;
        });
        const nome = created?.perfil?.nome ? String(created.perfil.nome) : '';
        if (!nome) throw new Error('create_profile_missing_name');
        out.profileName = nome;
        try {
          provisionAudit.append({ event: 'stock_provision_profile_created', cmdId: (cmd && cmd.id) ? String(cmd.id) : null, batchId, profileName: nome });
        } catch {}

        // 2) set label (interno)
        if (label) {
          await runStep('set_label', async () => {
            const r2 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/label`, {
              method: 'PATCH',
              headers: { 'x-operator': lockOwner },
              timeoutMs: Math.max(10_000, Math.min(60_000, budgetLeftMs() + 10_000)),
              body: { novoLabel: label }
            });
            if (!r2 || r2.ok === false) throw new Error((r2 && r2.error) ? String(r2.error) : 'set_label_failed');
            return r2;
          });
        }

        // 3) set robe mode (categoria)
        await runStep('set_robe_mode', async () => {
          const r3 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/robe-mode`, {
            method: 'POST',
            timeoutMs: Math.max(10_000, Math.min(60_000, budgetLeftMs() + 10_000)),
            body: { mode: robeMode }
          });
          if (!r3 || r3.ok === false) throw new Error((r3 && r3.error) ? String(r3.error) : 'set_robe_mode_failed');
          return r3;
        });

        // 3.5) garantir headroom antes de abrir browser
        const free0 = await getFreeMB().catch(()=>0);
        out.steps.push({ step: 'pre_activate_headroom', at: Date.now(), freeMB: free0, minFreeMB });
        if (free0 < minFreeMB) {
          const hard = await hardRecoverRam({ out, minMB: minFreeMB });
          out.steps.push({ step: 'hard_ram_recover_done', at: Date.now(), ...hard });
          const remain = Math.min(budgetLeftMs(), 90_000);
          const ensured = await ensureFreeMBWithin(minFreeMB, remain);
          out.steps.push({ step: 'ensure_free_mb', at: Date.now(), ...ensured, minFreeMB });
          if (!ensured.ok) throw new Error(`ram_low_wait_timeout freeMB=${ensured.freeMB} min=${minFreeMB}`);
        }

        // 4) activate
        await runStep('activate', async () => {
          const r4 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/activate`, {
            method: 'POST',
            headers: { 'x-operator': lockOwner },
            timeoutMs: Math.max(20_000, Math.min(3 * 60 * 1000, budgetLeftMs() + 20_000)),
            body: {}
          });
          if (!r4 || r4.ok === false) throw new Error((r4 && r4.error) ? String(r4.error) : 'activate_failed');
          return r4;
        });

        // 5) Cadastro por modo de autenticação (flag runtime):
        // - cookies_first (canônico atual): /configure
        // - password_first (novo): /login-remediate com authMode=password_first
        if (stockAuthMode === 'password_first') {
          await runStep('login_remediate_password_first', async () => {
            const longTimeoutMs = Math.max(120_000, Math.min(10 * 60 * 1000, budgetLeftMs() + 45_000));
            const r5 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/login-remediate`, {
              method: 'POST',
              headers: { 'x-operator': lockOwner },
              timeoutMs: longTimeoutMs,
              retries: 0,
              body: {
                options: {
                  authMode: 'password_first',
                  skipAttempt1InjectCookies: true,
                  overrideHumanHold: true
                }
              }
            });
            const rr = (r5 && r5.result && typeof r5.result === 'object') ? r5.result : r5;
            if (!r5 || r5.ok === false || !rr || rr.ok === false) {
              const err = String(
                (rr && rr.error) ||
                (r5 && r5.error) ||
                'login_remediate_failed'
              );
              throw new Error(err);
            }
            return r5;
          });
        } else {
          await runStep('configure', async () => {
            const longTimeoutMs = Math.max(60_000, Math.min(8 * 60 * 1000, budgetLeftMs() + 30_000));
            const r5 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/configure`, {
              method: 'POST',
              headers: { 'x-operator': lockOwner },
              timeoutMs: longTimeoutMs,
              retries: 0,
              body: {}
            });
            if (!r5 || r5.ok === false) throw new Error((r5 && r5.error) ? String(r5.error) : 'configure_failed');
            return r5;
          });
        }
        // Ciclo legado pós-cadastro (fallback):
        // por padrão NÃO fecha/reabre mais; manter browser aberto reduz captcha/deslog.
        // Se precisar voltar ao comportamento antigo, ativar STOCK_PROVISION_RECYCLE_AFTER_CONFIGURE=1.
        const recycleAfterConfigure = (String(process.env.STOCK_PROVISION_RECYCLE_AFTER_CONFIGURE || '0').trim() === '1');
        if (recycleAfterConfigure) {
          await runStep('recycle_after_configure_deactivate', async () => {
            const longTimeoutMs = Math.max(45_000, Math.min(4 * 60 * 1000, budgetLeftMs() + 20_000));
            const r6 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, {
              method: 'POST',
              headers: { 'x-operator': lockOwner },
              timeoutMs: longTimeoutMs,
              retries: 0,
              body: { reason: 'stock_provision_post_configure_recycle', policy: 'preserveDesired' }
            });
            if (!r6 || r6.ok === false) throw new Error((r6 && r6.error) ? String(r6.error) : 'recycle_deactivate_failed');
            return r6;
          });
          await runStep('recycle_after_configure_activate', async () => {
            const deadlineAt = Date.now() + Math.max(20_000, Math.min(90_000, budgetLeftMs() + 10_000));
            let attempts = 0;
            let lastErr = '';
            while (Date.now() < deadlineAt) {
              attempts++;
              const longTimeoutMs = Math.max(20_000, Math.min(45_000, budgetLeftMs() + 10_000));
              const r7 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/activate`, {
                method: 'POST',
                headers: { 'x-operator': lockOwner },
                timeoutMs: longTimeoutMs,
                retries: 0,
                body: {}
              });
              if (r7 && r7.ok !== false) return { ...r7, attempts };
              lastErr = (r7 && r7.error) ? String(r7.error) : 'recycle_activate_failed';
              if (!/kill_guard_until/i.test(lastErr)) throw new Error(lastErr);
              await sleep(2000);
            }
            throw new Error(lastErr || 'recycle_activate_failed_timeout');
          });
        } else {
          out.steps.push({ step: 'recycle_after_configure_skipped', at: Date.now() });
          try {
            provisionAudit.append({
              event: 'stock_provision_recycle_skipped',
              cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
              batchId,
              profileName: nome
            });
          } catch {}
        }
        await runStep('start_work', async () => {
          const longTimeoutMs = Math.max(45_000, Math.min(4 * 60 * 1000, budgetLeftMs() + 20_000));
          const r8 = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/start-work`, {
            method: 'POST',
            headers: { 'x-operator': lockOwner },
            timeoutMs: longTimeoutMs,
            retries: 0,
            body: {}
          });
          if (!r8 || r8.ok === false) throw new Error((r8 && r8.error) ? String(r8.error) : 'start_work_failed');
          return r8;
        });

        out.ok = true;
        out.finishedAt = Date.now();
        out.durationMs = out.finishedAt - startedAt;
        results.push(out);
      } catch (e) {
        out.ok = false;
        out.error = normalizeErr(e);
        out.finishedAt = Date.now();
        out.durationMs = out.finishedAt - startedAt;
        results.push(out);
        try {
          provisionAudit.append({
            ts: Date.now(),
            event: 'stock_provision_action_fail',
            cmdId: (cmd && cmd.id) ? String(cmd.id) : null,
            batchId,
            profileName: out.profileName || null,
            city,
            label: label || null,
            error: out.error
          });
        } catch {}
      }
    }
  } finally {
    // Sempre libera lock global.
    try { provisionLock.release({ owner: lockOwner }); } catch {}
  }

  const okCount = results.filter(r => r && r.ok).length;
  const failCount = results.length - okCount;
  return {
    ok: failCount === 0,
    batchId,
    okCount,
    failCount,
    results
  };
}

// ===== ALTERAÇÃO INÍCIO: add notifierBaseFromEndpoints e ackCommand =====
function notifierBaseFromEndpoints() {
  try {
    const u = resolveEndpoints()[0] || '';
    const url = new URL(u);
    return `${url.protocol}//${url.host}`;
  } catch { return null; }
}

function readAckPending() {
  try {
    const raw = fsSync.readFileSync(ACK_PENDING_PATH, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => x && typeof x === 'object' && x.id && x.hostId);
  } catch {
    return [];
  }
}

function writeAckPending(list) {
  try {
    const arr = Array.isArray(list) ? list : [];
    return !!fileStore.writeJsonAtomic(ACK_PENDING_PATH, arr);
  } catch {
    return false;
  }
}

function upsertAckPending(rec) {
  try {
    const arr = readAckPending();
    const id = String(rec && rec.id || '').trim();
    if (!id) return false;
    const i = arr.findIndex(x => String(x && x.id || '') === id);
    if (i >= 0) arr[i] = { ...arr[i], ...rec };
    else arr.push(rec);
    return writeAckPending(arr);
  } catch {
    return false;
  }
}

function removeAckPending(cmdId) {
  try {
    const id = String(cmdId || '').trim();
    if (!id) return false;
    const arr = readAckPending();
    const next = arr.filter(x => String(x && x.id || '') !== id);
    if (next.length === arr.length) return true;
    return writeAckPending(next);
  } catch {
    return false;
  }
}

async function sendAckOnce({ base, payload, timeoutMs = 3000 } = {}) {
  const controller = new (global.AbortController || require('node-abort-controller'))();
  const t = setTimeout(() => { try { controller.abort(); } catch {} }, Math.max(1000, Number(timeoutMs) || 3000));
  try {
    const url = `${base}/api/commands/ack`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    }).catch(() => null);
    if (!resp) return { ok: false, status: null };
    return { ok: !!resp.ok, status: Number(resp.status || 0) || null };
  } finally {
    clearTimeout(t);
  }
}

function getAckTimeoutMs(cmdType, phase = 'direct') {
  const t = String(cmdType || '').trim().toLowerCase();
  const baseDefault = Math.max(1000, Number(process.env.DASHBOARD_ACK_TIMEOUT_MS || 3000) || 3000);
  const retryDefault = Math.max(baseDefault, Number(process.env.DASHBOARD_ACK_TIMEOUT_RETRY_MS || 4000) || 4000);
  const stockDirectDefault = Math.max(baseDefault, Number(process.env.DASHBOARD_ACK_TIMEOUT_STOCK_PROVISION_MS || 8000) || 8000);
  const stockRetryDefault = Math.max(stockDirectDefault, Number(process.env.DASHBOARD_ACK_TIMEOUT_STOCK_PROVISION_RETRY_MS || 10000) || 10000);
  if (t === 'stock_provision') return phase === 'retry' ? stockRetryDefault : stockDirectDefault;
  return phase === 'retry' ? retryDefault : baseDefault;
}

async function flushPendingAcks({ limit = 20 } = {}) {
  try {
    const base = notifierBaseFromEndpoints();
    if (!base) return { ok: false, error: 'base_unavailable', flushed: 0 };
    const nowTs = Date.now();
    const arr = readAckPending().sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    if (!arr.length) return { ok: true, flushed: 0, remaining: 0 };
    let changed = false;
    let flushed = 0;
    const max = Math.max(1, Math.min(100, Number(limit) || 20));
    for (const rec of arr) {
      if (flushed >= max) break;
      const attempts = Number(rec && rec.attempts || 0) || 0;
      const lastAttemptAt = Number(rec && rec.lastAttemptAt || 0) || 0;
      const backoffMs = Math.min(60_000, Math.max(1000, (2 ** Math.min(8, attempts)) * 1000));
      if (lastAttemptAt && (nowTs - lastAttemptAt) < backoffMs) continue;
      const payload = {
        hostId: String(rec.hostId || ''),
        id: String(rec.id || ''),
        ok: !!rec.ok,
        error: rec.error ? String(rec.error) : null,
        details: (rec.details && typeof rec.details === 'object') ? rec.details : null
      };
      const cmdType = String(rec && rec.cmdType || '').trim().toLowerCase();
      const r = await sendAckOnce({ base, payload, timeoutMs: getAckTimeoutMs(cmdType, 'retry') });
      rec.lastAttemptAt = Date.now();
      rec.attempts = attempts + 1;
      changed = true;
      if (r && r.ok) {
        rec._remove = true;
        flushed++;
      }
    }
    if (!changed) return { ok: true, flushed: 0, remaining: arr.length };
    const next = arr.filter(x => !x._remove).map(({ _remove, ...rest }) => rest);
    writeAckPending(next);
    return { ok: true, flushed, remaining: next.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e), flushed: 0 };
  }
}

async function ackCommand(cmdId, ok, errorMsg, details, cmdType = '') {
  try {
    const base = notifierBaseFromEndpoints();
    if (!cmdId) return;
    if (!hostIdCache) {
      try { hostIdCache = await getOrCreateHostId(); } catch {}
    }
    if (!base || !hostIdCache) return;
    const ackDebug = String(process.env.DASHBOARD_ACK_DEBUG || '').trim() === '1';
    const payload = {
      hostId: hostIdCache,
      id: String(cmdId),
      ok: !!ok,
      error: errorMsg ? String(errorMsg) : null,
      details: (details && typeof details === 'object') ? details : null
    };
    const normalizedType = String(cmdType || '').trim().toLowerCase();
    let r = await sendAckOnce({ base, payload, timeoutMs: getAckTimeoutMs(normalizedType, 'direct') });
    // Provision é crítico: tenta uma segunda vez imediata antes de enfileirar retry.
    if ((!r || !r.ok) && normalizedType === 'stock_provision') {
      r = await sendAckOnce({ base, payload, timeoutMs: getAckTimeoutMs(normalizedType, 'retry') });
    }
    if (!r || !r.ok) {
      upsertAckPending({
        hostId: String(payload.hostId),
        id: String(payload.id),
        ok: !!payload.ok,
        cmdType: normalizedType || null,
        error: payload.error,
        details: payload.details,
        createdAt: Date.now(),
        lastAttemptAt: Date.now(),
        attempts: 1
      });
      if (ackDebug) {
        try {
          const p = path.join(__dirname, '..', 'dados', 'commands_ack_debug.jsonl');
          fsSync.appendFileSync(p, JSON.stringify({
            ts: Date.now(),
            event: 'ack_queued_for_retry',
            hostId: hostIdCache,
            cmdId,
            cmdType: normalizedType || null,
            ok: !!ok,
            httpStatus: r ? r.status : null
          }) + '\n');
        } catch {}
      }
      return;
    }
    removeAckPending(String(cmdId));
    if (ackDebug) {
      try {
        const p = path.join(__dirname, '..', 'dados', 'commands_ack_debug.jsonl');
        fsSync.appendFileSync(p, JSON.stringify({
          ts: Date.now(),
          event: 'ack_done',
          via: 'direct',
          hostId: hostIdCache,
          cmdId,
          cmdType: normalizedType || null,
          ackOk: !!ok,
          httpStatus: r ? Number(r.status || 0) : null,
          httpOk: true
        }) + '\n');
      } catch {}
    }
  } catch {}
}
// ===== ALTERAÇÃO FIM ===============================================

// ===== Logs sob demanda (fetch_logs) =====
function logsSecret() {
  try {
    const { readCtConfig } = require('./ctConfig');
    const cfg = readCtConfig();
    const fromCfg = String(cfg && cfg.logIngestSecret || '').trim();
    if (fromCfg) return fromCfg;
  } catch {
    // ignore
  }
  // Fallback: permite env var, mas ct_config tem prioridade (permite correção remota via set_ct_config)
  const env = String(process.env.LOG_INGEST_SECRET || '').trim();
  if (env) return env;
  return '';
}
function logsAllowlist() {
  const base = path.join(__dirname, '..', 'dados');
  const repo = path.join(__dirname, '..');
  const perfisDir = path.join(base, 'perfis');
  function safeKey(v) {
    return String(v || '')
      .trim()
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 180);
  }
  function collectProfileNames() {
    const set = new Set();
    try {
      const desiredPath = path.join(base, 'desired.json');
      if (fsSync.existsSync(desiredPath)) {
        const desired = JSON.parse(fsSync.readFileSync(desiredPath, 'utf8'));
        const perfisObj = (desired && typeof desired === 'object' && desired.perfis && typeof desired.perfis === 'object')
          ? desired.perfis
          : null;
        if (perfisObj) {
          for (const nome of Object.keys(perfisObj)) {
            const n = String(nome || '').trim();
            if (n) set.add(n);
          }
        }
      }
    } catch {}
    try {
      if (fsSync.existsSync(perfisDir)) {
        const ents = fsSync.readdirSync(perfisDir, { withFileTypes: true });
        for (const ent of ents) {
          if (!ent || !ent.isDirectory || !ent.isDirectory()) continue;
          const n = String(ent.name || '').trim();
          if (n) set.add(n);
        }
      }
    } catch {}
    return Array.from(set);
  }
  const allow = {
    logger: path.join(base, 'logger.log'),
    issues_fallback: path.join(base, 'issues_fallback.log'),
    // Auditoria de estado (enterprise): permite verificar “sobras” de desired/perfis/status
    desired: path.join(base, 'desired.json'),
    perfis: path.join(base, 'perfis.json'),
    status: path.join(base, 'status.json'),
    provision_audit: path.join(base, 'provision_audit.jsonl'),
    server_runtime_config: path.join(base, 'server_runtime_config.json'),
    ct_config: path.join(base, 'ct_config.json'),
    // Fila durável Delta (diagnóstico de reenvio/queda CT sem perda).
    delta_thread_state: path.join(base, 'delta_thread_state.json'),
    delta_queue: path.join(base, 'mensagens_pendentes.jsonl'),
    delta_queue_cursor: path.join(base, 'mensagens_pendentes.cursor.json'),
    delta_deadletter: path.join(base, 'mensagens_pendentes.deadletter.jsonl'),
    delta_deadletter_cursor: path.join(base, 'mensagens_pendentes.deadletter.cursor.json'),
    // Forense de parsing/rede do Delta (sem depender de logger.log).
    forensic_triagem: path.join(base, 'forensic_triagem.log'),
    forensic_edge: path.join(base, 'forensic_edge.log'),
    login_required_events: path.join(base, 'login_required_events.jsonl'),
    login_remediate_evidence: path.join(base, 'login_remediate_evidence.jsonl'),
    messenger_pin: path.join(base, 'messenger_pin.jsonl'),
    // Governor RAM/light/full monitoring (1/min) — para análise 48h via CT fetch_logs
    governor_snapshots: path.join(base, 'governor_snapshots.jsonl'),
    migrations: path.join(base, 'migrations.jsonl'),
    updates: path.join(base, 'updates.jsonl'),
    // Evidência de versão (para auditoria E2E): prova qual commit está no disco
    git_head: path.join(repo, '.git', 'HEAD'),
    git_main_ref: path.join(repo, '.git', 'refs', 'heads', 'main'),
    // Auditoria enterprise: lock de provisão (para diagnosticar maintenance_provision/locks presos)
    provision_lock: path.join(base, 'provision_lock.json'),
    // útil para auditoria do canal de comandos
    commands: path.join(base, 'commands.log'),
    // estado real do gerador V2 (fila + falhas/backoff/meta)
    robe_v2_queue: path.join(base, 'robe_v2_queue.json'),
    // logs do serviço (quando NSSM estiver configurado)
    service_stdout: path.join(base, 'service_stdout.log'),
    service_stderr: path.join(base, 'service_stderr.log')
  };
  // Virtus Messenger (por perfil): permite auditoria de chats respondidos por período.
  // Chaves:
  // - virtus_step_<perfil>: dados/perfis/<perfil>/virtus-step.log
  // - chats_respondidos_<perfil>: dados/perfis/<perfil>/chats_respondidos.json
  try {
    const nomes = collectProfileNames();
    for (const nome of nomes) {
      const sk = safeKey(nome);
      if (!sk) continue;
      allow[`virtus_step_${sk}`] = path.join(perfisDir, nome, 'virtus-step.log');
      allow[`chats_respondidos_${sk}`] = path.join(perfisDir, nome, 'chats_respondidos.json');
    }
  } catch {}
  const statusNodeMax = Math.max(6, parseInt(process.env.STATUS_NODE_ALLOWLIST_MAX || '16', 10) || 16);
  for (let i = 1; i <= statusNodeMax; i += 1) {
    allow[`status_node_${i}`] = path.join(base, `status_node_${i}.json`);
  }
  return allow;
}
function tailFileLines(filePath, maxLines = 2000, maxBytes = 1200_000) {
  try {
    if (!fsSync.existsSync(filePath)) return { ok:false, error:'not_found', filePath };
    const st = fsSync.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    const readBytes = Math.min(maxBytes, size);
    const start = Math.max(0, size - readBytes);
    const buf = Buffer.alloc(readBytes);
    const fd = fsSync.openSync(filePath, 'r');
    try { fsSync.readSync(fd, buf, 0, readBytes, start); }
    finally { try { fsSync.closeSync(fd); } catch {} }
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - maxLines));
    const truncated = (start > 0) || (lines.length > maxLines);
    return { ok:true, filePath, bytes: readBytes, lines: tail.length, truncated, text: tail.join('\n') };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e), filePath };
  }
}

function tailFileGrep(filePath, { patterns = [], maxBytes = 10_000_000, maxMatches = 600 } = {}) {
  try {
    if (!fsSync.existsSync(filePath)) return { ok:false, error:'not_found', filePath };
    const st = fsSync.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    const readBytes = Math.min(Math.max(0, Number(maxBytes || 0) || 0), size);
    const start = Math.max(0, size - readBytes);
    const buf = Buffer.alloc(readBytes);
    const fd = fsSync.openSync(filePath, 'r');
    try { fsSync.readSync(fd, buf, 0, readBytes, start); }
    finally { try { fsSync.closeSync(fd); } catch {} }
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/);
    const pats = Array.isArray(patterns) ? patterns.map(x => String(x||'').trim()).filter(Boolean) : [];
    if (!pats.length) return { ok:false, error:'missing_patterns', filePath };
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      let hit = false;
      for (const p of pats) {
        if (line.includes(p)) { hit = true; break; }
      }
      if (!hit) continue;
      out.push(line);
      if (out.length >= maxMatches) break;
    }
    const truncated = (start > 0) || (out.length >= maxMatches);
    return { ok:true, filePath, bytes: readBytes, lines: out.length, truncated, text: out.join('\n') };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e), filePath };
  }
}

function safeMkdirp(dir) {
  try { if (!dir) return; fsSync.mkdirSync(dir, { recursive: true }); } catch {}
}
function rotateFileBestEffort(filePath, { destDir, baseName, maxRetries = 8 } = {}) {
  try {
    if (!filePath) return { ok:false, error:'missing_filePath' };
    if (!fsSync.existsSync(filePath)) return { ok:false, error:'not_found', filePath };
    const st = fsSync.statSync(filePath);
    const size = Number(st.size || 0) || 0;
    if (size <= 0) return { ok:false, error:'empty', filePath, bytes: 0 };

    const dir = destDir || path.join(__dirname, '..', 'dados', 'logs');
    safeMkdirp(dir);
    const ts = new Date();
    const stamp =
      String(ts.getFullYear()) +
      String(ts.getMonth() + 1).padStart(2, '0') +
      String(ts.getDate()).padStart(2, '0') + '-' +
      String(ts.getHours()).padStart(2, '0') +
      String(ts.getMinutes()).padStart(2, '0') +
      String(ts.getSeconds()).padStart(2, '0');
    const bn = String(baseName || path.basename(filePath) || 'log').replace(/[^\w.\-]+/g, '_');
    const destPath = path.join(dir, `${bn}.${stamp}.log`);

    let lastErr = null;
    for (let i = 0; i < Math.max(1, Number(maxRetries || 0) || 0); i++) {
      try {
        fsSync.renameSync(filePath, destPath);
        // Recria o arquivo vazio para o próximo append (sem depender de abrir/fechar).
        try { fsSync.writeFileSync(filePath, '', { encoding: 'utf8' }); } catch {}
        return { ok:true, filePath, destPath, bytes: size };
      } catch (e) {
        lastErr = e;
        // Windows: rename pode falhar se alguém estiver escrevendo exatamente no momento; retry curto.
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 + (i * 40)); } catch {}
      }
    }
    return { ok:false, error: (lastErr && lastErr.message) ? String(lastErr.message) : 'rename_failed', filePath, destPath, bytes: size };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e), filePath };
  }
}
function pruneOldLogs(dir, { prefix = '', keep = 20 } = {}) {
  try {
    const k = Math.max(1, Math.min(200, Number(keep || 0) || 0));
    if (!fsSync.existsSync(dir)) return { ok:true, deleted: 0 };
    const items = fsSync.readdirSync(dir).map(name => ({ name, full: path.join(dir, name) }));
    const filtered = items.filter(x => {
      if (!x || !x.name) return false;
      if (prefix && !String(x.name).startsWith(prefix)) return false;
      return String(x.name).toLowerCase().endsWith('.log');
    });
    const withStat = filtered.map(x => {
      try {
        const st = fsSync.statSync(x.full);
        return { ...x, mtimeMs: Number(st.mtimeMs || 0) || 0 };
      } catch { return { ...x, mtimeMs: 0 }; }
    }).sort((a, b) => (b.mtimeMs - a.mtimeMs));
    const toDelete = withStat.slice(k);
    let deleted = 0;
    for (const f of toDelete) {
      try { fsSync.rmSync(f.full, { force: true }); deleted++; } catch {}
    }
    return { ok:true, deleted };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e) };
  }
}
function pruneLogsByAgeHours(dir, { prefix = '', maxAgeHours = 48 } = {}) {
  try {
    const hours = Math.max(1, Math.min(24 * 30, Number(maxAgeHours || 0) || 48));
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    if (!fsSync.existsSync(dir)) return { ok:true, deleted: 0 };
    const items = fsSync.readdirSync(dir).map(name => ({ name, full: path.join(dir, name) }));
    const filtered = items.filter(x => {
      if (!x || !x.name) return false;
      if (prefix && !String(x.name).startsWith(prefix)) return false;
      return String(x.name).toLowerCase().endsWith('.log');
    });
    let deleted = 0;
    for (const f of filtered) {
      try {
        const st = fsSync.statSync(f.full);
        const m = Number(st && st.mtimeMs || 0) || 0;
        if (m > 0 && m < cutoff) {
          fsSync.rmSync(f.full, { force: true });
          deleted++;
        }
      } catch {}
    }
    return { ok:true, deleted };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e) };
  }
}
function maybeAutoRotateCriticalJsonl() {
  try {
    const enabled = String(process.env.JSONL_AUTO_ROTATE_ENABLED || '1').trim() !== '0';
    if (!enabled) return { ok:true, skipped: true, reason: 'disabled' };
    const intervalMin = Math.max(5, Math.min(24 * 60, Number(process.env.JSONL_AUTO_ROTATE_INTERVAL_MIN || 60) || 60));
    const maxAgeHours = Math.max(6, Math.min(24 * 30, Number(process.env.JSONL_AUTO_ROTATE_MAX_AGE_HOURS || 48) || 48));
    const now = Date.now();
    if (lastJsonlAutoRotateAt && (now - lastJsonlAutoRotateAt) < (intervalMin * 60 * 1000)) {
      return { ok:true, skipped: true, reason: 'interval' };
    }
    lastJsonlAutoRotateAt = now;

    const allow = logsAllowlist();
    const dir = path.join(__dirname, '..', 'dados', 'logs');
    safeMkdirp(dir);
    const keys = ['provision_audit', 'login_required_events', 'messenger_pin'];
    const rotated = [];
    for (const key of keys) {
      const fp = allow[key];
      if (!fp) continue;
      const rr = rotateFileBestEffort(fp, { destDir: dir, baseName: `${key}` });
      // not_found/empty são esperados quando arquivo ainda não existe ou sem dados
      if (rr && rr.ok) rotated.push({ key, ok: true, bytes: Number(rr.bytes || 0) || 0 });
      else rotated.push({ key, ok: false, error: rr && rr.error ? String(rr.error) : 'rotate_failed' });
      try { pruneLogsByAgeHours(dir, { prefix: `${key}.`, maxAgeHours }); } catch {}
      try { pruneOldLogs(dir, { prefix: `${key}.`, keep: 96 }); } catch {}
    }
    return { ok:true, intervalMin, maxAgeHours, rotated };
  } catch (e) {
    return { ok:false, error: (e && e.message) || String(e) };
  }
}
async function postLogsToNotifier({ requestId, items }) {
  const base = notifierBaseFromEndpoints();
  if (!base) throw new Error('notifier_base_unavailable');
  let hostId = String(hostIdCache || '').trim();
  if (!hostId) {
    try {
      hostId = String(await getOrCreateHostId() || '').trim();
      if (hostId) hostIdCache = hostId;
    } catch {}
  }
  if (!hostId) throw new Error('hostId_unavailable');
  const sec = logsSecret();
  const controller = new (global.AbortController || require('node-abort-controller'))();
  const t = setTimeout(() => { try { controller.abort(); } catch {} }, 8000);
  try {
    const resp = await fetch(`${base}/api/logs/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sec ? { 'X-Log-Secret': sec } : {})
      },
      body: JSON.stringify({
        hostId,
        hostname: (os && os.hostname) ? os.hostname() : '',
        requestId,
        sentAt: Date.now(),
        items
      }),
      signal: controller.signal
    });
    if (!resp || !resp.ok) {
      const status = resp ? Number(resp.status || 0) : 0;
      throw new Error(`logs_ingest_http_${status || 'unknown'}`);
    }
  } finally {
    clearTimeout(t);
  }
}
async function execFetchLogs(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const keys = Array.isArray(payload.keys) ? payload.keys.map(x => String(x||'').trim()).filter(Boolean) : [];
  const tailLines = Math.max(50, Math.min(8000, Number(payload.tailLines || 1200) || 1200));
  if (!requestId) throw new Error('missing_requestId');
  if (!keys.length) throw new Error('missing_keys');
  const allow = logsAllowlist();
  const items = [];
  for (const key of keys.slice(0, 8)) {
    const fp = allow[key];
    if (!fp) { items.push({ key, ok:false, error:'not_allowed' }); continue; }
    const r = tailFileLines(fp, tailLines);
    items.push({ key, ...r });
  }
  await postLogsToNotifier({ requestId, items });
}

async function execFetchLogsQuery(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const key = String(payload.key || '').trim();
  const patterns = Array.isArray(payload.patterns) ? payload.patterns : [];
  const maxBytes = Math.max(500_000, Math.min(50_000_000, Number(payload.maxBytes || 10_000_000) || 10_000_000));
  const maxMatches = Math.max(10, Math.min(5000, Number(payload.maxMatches || 600) || 600));
  if (!requestId) throw new Error('missing_requestId');
  if (!key) throw new Error('missing_key');
  const allow = logsAllowlist();
  const fp = allow[key];
  if (!fp) throw new Error('not_allowed');
  const r = tailFileGrep(fp, { patterns, maxBytes, maxMatches });
  const items = [{
    key: `query_${key}`,
    ...r,
    meta: { key, patterns: patterns.map(x => String(x||'').slice(0, 120)), maxBytes, maxMatches }
  }];
  await postLogsToNotifier({ requestId, items });
}

/**
 * Fallback cookies-only: coleta cidade a partir do item_link Marketplace.
 * Preferir o caminho vivo (IPC delta-force-city-collect-task) no command-bus:
 * esse abre o thread, recupera link se faltar e roda o match-duplo.
 */
async function execDeltaForceCityCollect(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object')
    ? cmd.payload
    : ((cmd && cmd.data && typeof cmd.data === 'object') ? cmd.data : {});
  const itemLink = String(payload.item_link || payload.itemLink || '').trim();
  const accountLogin = String(payload.account_login || payload.accountLogin || '').trim();
  const threadKey = String(payload.thread_key || payload.threadKey || '').trim();
  const ticketId = Number(payload.ticket_id || payload.ticketId || 0) || 0;
  if (!itemLink) {
    return {
      ok: false,
      error: 'missing_item_link',
      ticket_id: ticketId || null,
      account_login: accountLogin || null,
      thread_key: threadKey || null,
      hint: 'use_live_browser_force_collect',
    };
  }
  if (!/marketplace\/item\//i.test(itemLink)) {
    return { ok: false, error: 'invalid_marketplace_item_link', ticket_id: ticketId || null };
  }

  let sessionCookies = [];
  if (accountLogin) {
    try {
      const manifestStore = require('./manifestStore');
      const man = await manifestStore.read(accountLogin);
      if (man && Array.isArray(man.cookies) && man.cookies.length) {
        sessionCookies = man.cookies.filter(Boolean);
      }
    } catch (_) {}
  }

  try {
    const { getDeltaCityCollector } = require('./deltaCityCollector');
    const collector = await getDeltaCityCollector();
    if (!collector || typeof collector.collectCityFromItemLink !== 'function') {
      return { ok: false, error: 'delta_city_collector_runtime_invalid', ticket_id: ticketId || null };
    }
    const out = await collector.collectCityFromItemLink({
      item_link: itemLink,
      thread_key: threadKey || null,
      account_login: accountLogin || null,
      timeoutMs: Math.max(12_000, Number(payload.timeoutMs || 20_000) || 20_000),
      attempts: Math.max(1, Math.min(5, Number(payload.attempts || 3) || 3)),
      session_cookies: sessionCookies,
    });
    const cidade = String((out && out.ok && out.cidade) || '').trim() || null;
    if (!cidade) {
      return {
        ok: false,
        error: String((out && out.error) || 'city_collect_failed').slice(0, 220),
        ticket_id: ticketId || null,
        account_login: accountLogin || null,
        thread_key: threadKey || null,
        item_link: itemLink,
        collector: out && typeof out === 'object' ? {
          login_wall: !!out.login_wall,
          has_localizacao: !!out.has_localizacao,
          has_anunciado: !!out.has_anunciado,
          candidates_count: Number(out.candidates_count || 0) || 0,
        } : null,
      };
    }
    return {
      ok: true,
      cidade,
      city_source: String((out && out.city_source) || 'collector_listing_page').trim() || 'collector_listing_page',
      ticket_id: ticketId || null,
      account_login: accountLogin || null,
      thread_key: threadKey || null,
      item_link: itemLink,
      cached: !!(out && out.cached),
    };
  } catch (e) {
    return {
      ok: false,
      error: String((e && e.message) || e || 'delta_force_city_collect_exception').slice(0, 220),
      ticket_id: ticketId || null,
      account_login: accountLogin || null,
      thread_key: threadKey || null,
      item_link: itemLink,
    };
  }
}

async function execLogsManifest(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  if (!requestId) throw new Error('missing_requestId');
  const allow = logsAllowlist();
  const items = [];
  for (const key of Object.keys(allow)) {
    const fp = allow[key];
    try {
      if (!fp || !fsSync.existsSync(fp)) {
        items.push({ key, ok:false, error:'not_found', filePath: fp || null, bytes: 0, mtimeMs: null });
        continue;
      }
      const st = fsSync.statSync(fp);
      items.push({ key, ok:true, filePath: fp, bytes: Number(st.size || 0) || 0, mtimeMs: Number(st.mtimeMs || 0) || null });
    } catch (e) {
      items.push({ key, ok:false, error: (e && e.message) || String(e), filePath: fp || null, bytes: 0, mtimeMs: null });
    }
  }
  await postLogsToNotifier({ requestId, items });
}

async function execHealthBundle(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim();
  const includeTail = (payload.includeTail === true || payload.includeTail === 1 || payload.includeTail === '1' || String(payload.includeTail || '').toLowerCase() === 'true');
  const tailLines = Math.max(50, Math.min(2500, Number(payload.tailLines || 400) || 400));
  if (!requestId) throw new Error('missing_requestId');

  const allow = logsAllowlist();
  const status = await readAggregatedStatus().catch(() => ({}));
  const perfis = Array.isArray(status && status.perfis) ? status.perfis : [];
  const active = perfis.filter(p => p && p.nome && p.active === true);
  const busy = active.filter(p => (p.sendLockActive === true) || (p.robeEmExecucao === true));
  const summary = {
    ts: Date.now(),
    hostId: hostIdCache || null,
    hostname: (os && os.hostname) ? os.hostname() : '',
    activeCount: active.length,
    busyCount: busy.length,
    busyNames: busy.map(p => String(p.nome)).slice(0, 40),
    busyDetails: busy.map(p => ({
      nome: String(p && p.nome || ''),
      sendLockActive: p && p.sendLockActive === true,
      sendLockOwner: (p && p.sendLockOwner) ? String(p.sendLockOwner) : null,
      sendLockAgeMs: (typeof (p && p.sendLockAgeMs) === 'number') ? p.sendLockAgeMs : null,
      robeEmExecucao: p && p.robeEmExecucao === true
    })).slice(0, 40),
    sys: (status && status.sys) ? status.sys : null,
    _debug: (status && status._debug) ? status._debug : null
  };

  // Manifest compacto (1 item) para não estourar o limite de 12 itens do CT.
  const manifest = [];
  for (const key of Object.keys(allow)) {
    const fp = allow[key];
    try {
      if (!fp || !fsSync.existsSync(fp)) {
        manifest.push({ key, ok:false, error:'not_found', filePath: fp || null, bytes: 0, mtimeMs: null });
      } else {
        const st = fsSync.statSync(fp);
        manifest.push({ key, ok:true, filePath: fp, bytes: Number(st.size || 0) || 0, mtimeMs: Number(st.mtimeMs || 0) || null });
      }
    } catch (e) {
      manifest.push({ key, ok:false, error: (e && e.message) || String(e), filePath: fp || null, bytes: 0, mtimeMs: null });
    }
  }

  const items = [
    { key: 'health_summary', ok: true, bytes: 0, lines: 0, truncated: false, text: JSON.stringify(summary, null, 2) },
    { key: 'health_manifest', ok: true, bytes: 0, lines: 0, truncated: false, text: JSON.stringify(manifest, null, 2) }
  ];

  // Por segurança, tails são opt-in (pode conter dados sensíveis).
  if (includeTail) {
    for (const key of ['logger', 'issues_fallback']) {
      const fp = allow[key];
      if (!fp) continue;
      const r = tailFileLines(fp, tailLines);
      items.push({ key: `tail_${key}`, ...r });
    }
  }
  await postLogsToNotifier({ requestId, items: items.slice(0, 12) });
}

async function execRotateLogs(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const keep = Math.max(1, Math.min(200, Number(payload.keep || 30) || 30));
  const keys = Array.isArray(payload.keys) ? payload.keys.map(x => String(x||'').trim()).filter(Boolean) : ['logger'];
  const allow = logsAllowlist();
  const dir = path.join(__dirname, '..', 'dados', 'logs');
  safeMkdirp(dir);

  const results = [];
  for (const key of keys.slice(0, 8)) {
    const fp = allow[key];
    if (!fp) { results.push({ key, ok:false, error:'not_allowed' }); continue; }
    const r = rotateFileBestEffort(fp, { destDir: dir, baseName: `${key}` });
    results.push({ key, ...r });
    try { pruneOldLogs(dir, { prefix: `${key}.`, keep }); } catch {}
  }
  const okCount = results.filter(r => r && r.ok).length;
  const failCount = results.length - okCount;
  return { ok: failCount === 0, keep, okCount, failCount, results };
}

// ===== Update massivo (self_update = git pull) =====
function updateLogAppend(obj) {
  try {
    const p = path.join(__dirname, '..', 'dados', 'updates.jsonl');
    fsSync.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...obj }) + '\n');
  } catch {}
}
async function runGit(args, { cwd } = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    // Ultra enterprise: nunca permitir prompt interativo (evita self_update travar em inflight).
    // - GIT_TERMINAL_PROMPT=0: desabilita prompts
    // - GCM_INTERACTIVE=Never: bloqueia Git Credential Manager UI
    // - timeout: evita pendurar indefinidamente em fetch/pull (rede/credencial)
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
    execFile('git', args, {
      cwd: cwd || path.join(__dirname, '..'),
      env,
      timeout: Math.max(15_000, Number(process.env.SELF_UPDATE_GIT_TIMEOUT_MS || 120_000) || 120_000)
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok:false, error: (err && err.message) || String(err), stdout: String(stdout||''), stderr: String(stderr||'') });
      return resolve({ ok:true, stdout: String(stdout||''), stderr: String(stderr||'') });
    });
  });
}
async function execSelfUpdate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const requestId = String(payload.requestId || '').trim() || (cmd && cmd.id) || 'noid';
  const branch = String(payload.branch || 'main').trim() || 'main';
  // Segurança enterprise: por padrão NÃO derruba o processo.
  // Restart automático só é permitido se o operador habilitar explicitamente via env.
  const restartRequested = (payload.restart === true || payload.restart === 1 || payload.restart === '1' || String(payload.restart || '').toLowerCase() === 'true');
  const restartAllowed = String(process.env.ALLOW_SELF_UPDATE_RESTART || '').trim() === '1';
  const restart = restartRequested && restartAllowed;
  const repoDir = path.join(__dirname, '..');

  updateLogAppend({ event: 'self_update_start', requestId, branch, restart });
  const steps = [];
  steps.push({ step: 'rev-parse', ...(await runGit(['rev-parse','--is-inside-work-tree'], { cwd: repoDir })) });
  steps.push({ step: 'fetch', ...(await runGit(['fetch','--all','--prune'], { cwd: repoDir })) });
  steps.push({ step: 'status_before', ...(await runGit(['status','--porcelain'], { cwd: repoDir })) });
  steps.push({ step: 'pull', ...(await runGit(['pull','--ff-only','origin',branch], { cwd: repoDir })) });
  steps.push({ step: 'rev', ...(await runGit(['rev-parse','HEAD'], { cwd: repoDir })) });

  const ok = steps.every(s => s && s.ok);
  updateLogAppend({ event: 'self_update_done', requestId, branch, ok, steps: steps.map(s => ({ step: s.step, ok: s.ok, error: s.error || null })) });
  if (!ok) {
    const err = steps.find(s => !s.ok);
    throw new Error(`self_update_failed:${(err && err.step) || 'unknown'}:${(err && err.error) || 'error'}`);
  }

  // Reinício opcional: somente se explicitamente permitido.
  // Agendado após o retorno para não interromper o ACK em trânsito.
  if (restart) {
    try { updateLogAppend({ event: 'self_update_restart_scheduled', requestId, at: Date.now() }); } catch {}
    setTimeout(() => {
      try { logger.info('[DASH][SELF_UPDATE] restart=1 -> saindo do processo para o gerenciador reiniciar'); } catch {}
      try { process.exit(0); } catch {}
    }, 2500);
  } else if (restartRequested && !restartAllowed) {
    try { updateLogAppend({ event: 'self_update_restart_blocked', requestId, reason: 'ALLOW_SELF_UPDATE_RESTART!=1' }); } catch {}
  }
}

// ===== NOVO: Configurar CT_BASE_URL + LOG_INGEST_SECRET via comando (persistente) =====
async function execSetCtConfig(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const ctBaseUrl = (payload.ctBaseUrl !== undefined) ? String(payload.ctBaseUrl || '').trim() : undefined;
  const logIngestSecret = (payload.logIngestSecret !== undefined) ? String(payload.logIngestSecret || '').trim() : undefined;
  const isNgrokCtBase = (() => {
    if (!ctBaseUrl) return false;
    try {
      const host = String(new URL(ctBaseUrl).hostname || '').toLowerCase();
      return /(?:^|\.)ngrok(?:-free)?\.(?:io|app)$/.test(host);
    } catch {
      return /ngrok/i.test(ctBaseUrl);
    }
  })();
  if (isNgrokCtBase) {
    throw new Error('set_ct_config_blocked_ngrok_base');
  }
  const { writeCtConfig } = require('./ctConfig');
  const r = writeCtConfig({ ctBaseUrl, logIngestSecret });
  if (!r || r.ok !== true) throw new Error('set_ct_config_failed');
  return { ok: true };
}

// ===== NOVO: Config Groq (API key/model) via comando (persistente) =====
async function execSetGroqConfig(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const groqApiKey = (payload.groqApiKey !== undefined) ? String(payload.groqApiKey || '').trim() : undefined;
  const groqModel = (payload.groqModel !== undefined) ? String(payload.groqModel || '').trim() : undefined;
  const r = writeGroqConfig({ groqApiKey, groqModel });
  if (!r || r.ok !== true) throw new Error('set_groq_config_failed');
  return { ok: true };
}

async function execReseedHostId(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const newHostId = String(payload.newHostId || '').trim();
  if (!newHostId) return { ok: false, error: 'missing_newHostId' };
  try {
    ensureDirSync(path.dirname(HOSTID_PATH));
    fsSync.writeFileSync(HOSTID_PATH, newHostId, 'utf8');
    hostIdCache = newHostId;
    // Forca refresh completo imediato para o CT consolidar o novo hostId rapido.
    lastFullReportAt = 0;
    pending = true;
    return { ok: true, newHostId };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  }
}

async function listActiveGatewayProfiles() {
  const st = await httpJson('/api/status', { timeoutMs: 45_000, retries: 1 });
  const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
  return perfis
    .filter((p) => p && p.active === true)
    .map((p) => String(p && p.nome || '').trim())
    .filter(Boolean);
}

async function getProfileManifest(nome) {
  try {
    const r = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/manifest`, { timeoutMs: 45_000, retries: 1 });
    if (!r || r.ok !== true || !r.manifest || typeof r.manifest !== 'object') return null;
    return r.manifest;
  } catch {
    return null;
  }
}

function gatewayResolvedSignature(resolved) {
  if (!resolved || resolved.enabled !== true) return `off:${String(resolved && resolved.reason || 'disabled')}`;
  const slotId = String(resolved && resolved.slot && resolved.slot.slotId || '').trim();
  const ip = String(resolved && resolved.slot && resolved.slot.ipCurrent || '').trim();
  const proxyServer = String(resolved && resolved.proxyServer || '').trim();
  return `on:${slotId}:${ip}:${proxyServer}`;
}

async function collectGatewayResolutionSnapshot(profileNames) {
  const names = Array.isArray(profileNames) ? profileNames : [];
  const out = new Map();
  if (!names.length) return out;
  const concurrency = Math.max(1, Math.min(12, Number(process.env.GATEWAY_RESOLVE_SNAPSHOT_CONCURRENCY || 6) || 6));
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, names.length) }).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= names.length) break;
      const nome = names[i];
      const manifest = await getProfileManifest(nome);
      const resolved = gatewayProxy.resolveProxyForProfile({ profileName: nome, manifest });
      out.set(nome, {
        nome,
        signature: gatewayResolvedSignature(resolved),
        enabled: !!(resolved && resolved.enabled === true),
        slotId: String(resolved && resolved.slot && resolved.slot.slotId || '').trim() || null,
        reason: String(resolved && resolved.reason || '').trim() || null
      });
    }
  });
  await Promise.all(workers);
  return out;
}

async function recycleGatewayProfile(nome, reasonTag, { allowBusy = false } = {}) {
  // Fail-safe: se kill guard estiver ativo, não desativa o perfil agora.
  // Evita derrubar browser ativo e deixar o perfil offline por bloqueio transitório.
  try {
    const st = await httpJson('/api/status', { timeoutMs: 30_000, retries: 1 });
    const perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    const p = perfis.find((x) => String(x && x.nome || '').trim() === String(nome || '').trim());
    if (!allowBusy && p && p.trabalhando === true) {
      return { ok: false, stage: 'precheck', error: 'profile_busy' };
    }
    // Guardrail: nunca reciclar proxy no meio de provision/configuração.
    // Isso evita trocar IP/fingerprint durante o fluxo de cadastro.
    if (!allowBusy && p && p.configurando === true) {
      return { ok: false, stage: 'precheck', error: 'profile_configuring' };
    }
    if (!allowBusy && p && p.humanControl === true) {
      return { ok: false, stage: 'precheck', error: 'profile_human_control' };
    }
    const killGuardUntil = Number((p && p.killGuardUntil) || 0) || 0;
    if (!allowBusy && killGuardUntil > Date.now()) {
      return { ok: false, stage: 'precheck', error: 'kill_guard_until', retryAt: killGuardUntil };
    }
  } catch {}

  const operator = `gateway_recycle:${String(reasonTag || 'gateway_update').slice(0, 80)}`;
  const deactivate = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/deactivate`, {
    method: 'POST',
    headers: { 'x-operator': operator },
    body: { policy: 'preserveDesired', reason: 'gateway_recycle' },
    timeoutMs: 90_000,
    retries: 1
  });
  if (!deactivate || deactivate.ok !== true) {
    return { ok: false, stage: 'deactivate', error: (deactivate && deactivate.error) ? String(deactivate.error) : 'deactivate_failed' };
  }
  await sleep(Math.max(200, Number(process.env.GATEWAY_RECYCLE_STEP_WAIT_MS || 350) || 350));

  let lastErr = null;
  const activateTries = Math.max(1, Math.min(5, Number(process.env.GATEWAY_RECYCLE_ACTIVATE_RETRIES || 3) || 3));
  for (let i = 0; i < activateTries; i++) {
    const activate = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/activate`, {
      method: 'POST',
      headers: { 'x-operator': operator },
      timeoutMs: 90_000,
      retries: 1
    });
    if (activate && activate.ok === true) return { ok: true };
    lastErr = (activate && activate.error) ? String(activate.error) : 'activate_failed';
    await sleep(700 + (i * 600));
  }
  return { ok: false, stage: 'activate', error: lastErr || 'activate_failed' };
}

async function recycleGatewayActives({ reasonTag = 'gateway_update', profileNames = null, limit = null, allowBusy = false } = {}) {
  const names = Array.isArray(profileNames) ? profileNames : await listActiveGatewayProfiles();
  const targets = (limit && Number(limit) > 0)
    ? names.slice(0, Number(limit))
    : names;
  if (!targets.length) return { ok: true, total: 0, okCount: 0, failCount: 0, failures: [] };

  const concurrency = Math.max(1, Math.min(12, Number(process.env.GATEWAY_RECYCLE_CONCURRENCY || 4) || 4));
  let idx = 0;
  const out = [];
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= targets.length) break;
      const nome = targets[i];
      try {
        const rr = await recycleGatewayProfile(nome, reasonTag, { allowBusy: !!allowBusy });
        out.push({ nome, ...(rr || { ok: false, error: 'recycle_failed' }) });
      } catch (e) {
        out.push({ nome, ok: false, error: (e && e.message) ? String(e.message) : String(e) });
      }
    }
  });
  await Promise.all(workers);
  const okCount = out.filter((x) => x && x.ok === true).length;
  const failures = out.filter((x) => !x || x.ok !== true);
  const failCount = out.length - okCount;
  return { ok: failCount === 0, total: out.length, okCount, failCount, failures };
}

function readGatewayRecycleQueue() {
  try {
    if (!fsSync.existsSync(GATEWAY_RECYCLE_QUEUE_PATH)) return { version: 1, pending: [], updatedAt: 0 };
    const raw = String(fsSync.readFileSync(GATEWAY_RECYCLE_QUEUE_PATH, 'utf8') || '');
    const j = raw ? JSON.parse(raw) : null;
    return {
      version: 1,
      pending: Array.isArray(j && j.pending) ? j.pending : [],
      updatedAt: Number(j && j.updatedAt || 0) || 0
    };
  } catch {
    return { version: 1, pending: [], updatedAt: 0 };
  }
}

function writeGatewayRecycleQueue(state) {
  const st = (state && typeof state === 'object') ? state : {};
  const next = {
    version: 1,
    pending: Array.isArray(st.pending) ? st.pending : [],
    updatedAt: Date.now()
  };
  ensureDirSync(path.dirname(GATEWAY_RECYCLE_QUEUE_PATH));
  const tmp = `${GATEWAY_RECYCLE_QUEUE_PATH}.tmp`;
  fsSync.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fsSync.renameSync(tmp, GATEWAY_RECYCLE_QUEUE_PATH);
}

function enqueueGatewayRecycleProfiles(profileNames, reason = 'gateway_retry') {
  const names = Array.isArray(profileNames) ? profileNames.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!names.length) return { ok: true, enqueued: 0 };
  const q = readGatewayRecycleQueue();
  const nowTs = Date.now();
  const byNome = new Map();
  for (const row of (q.pending || [])) {
    const nome = String(row && row.nome || '').trim();
    if (!nome) continue;
    byNome.set(nome, {
      nome,
      firstSeenAt: Number(row.firstSeenAt || nowTs) || nowTs,
      attempts: Number(row.attempts || 0) || 0,
      nextRetryAt: Number(row.nextRetryAt || 0) || 0,
      lastError: row && row.lastError ? String(row.lastError).slice(0, 220) : null,
      reason: row && row.reason ? String(row.reason).slice(0, 80) : String(reason).slice(0, 80),
      updatedAt: Number(row.updatedAt || nowTs) || nowTs
    });
  }
  let inserted = 0;
  for (const nome of names) {
    const cur = byNome.get(nome);
    if (cur) {
      cur.reason = String(reason || cur.reason || 'gateway_retry').slice(0, 80);
      cur.updatedAt = nowTs;
      byNome.set(nome, cur);
      continue;
    }
    inserted += 1;
    byNome.set(nome, {
      nome,
      firstSeenAt: nowTs,
      attempts: 0,
      nextRetryAt: 0,
      lastError: null,
      reason: String(reason || 'gateway_retry').slice(0, 80),
      updatedAt: nowTs
    });
  }
  writeGatewayRecycleQueue({ pending: Array.from(byNome.values()) });
  return { ok: true, enqueued: inserted };
}

async function processGatewayRecycleQueue({ maxProfiles = null } = {}) {
  if (gatewayRecycleQueueInFlight) return { ok: true, skipped: true, reason: 'queue_inflight' };
  gatewayRecycleQueueInFlight = true;
  try {
    const q = readGatewayRecycleQueue();
    const pendingRows = Array.isArray(q.pending) ? q.pending : [];
    if (!pendingRows.length) return { ok: true, skipped: true, reason: 'queue_empty' };

    let status = null;
    try { status = await httpJson('/api/status', { timeoutMs: 45_000, retries: 1 }); } catch {}
    const openAllActive = !!(status && status.openAll && status.openAll.active === true);
    if (openAllActive) return { ok: true, skipped: true, reason: 'open_all_active' };

    const activeNames = await listActiveGatewayProfiles();
    const activeSet = new Set(activeNames);
    const workingSet = new Set(
      (Array.isArray(status && status.perfis) ? status.perfis : [])
        .filter((p) => p && p.active === true && p.trabalhando === true)
        .map((p) => String(p && p.nome || '').trim())
        .filter(Boolean)
    );
    const nowTs = Date.now();
    const eligibleNames = pendingRows
      .filter((row) => {
        const nome = String(row && row.nome || '').trim();
        if (!nome || !activeSet.has(nome)) return false;
        if (workingSet.has(nome)) return false;
        const nextRetryAt = Number(row && row.nextRetryAt || 0) || 0;
        return nextRetryAt <= nowTs;
      })
      .map((row) => String(row && row.nome || '').trim());

    const batchLimit = Math.max(1, Math.min(20, Number(maxProfiles || process.env.GATEWAY_RECYCLE_QUEUE_BATCH || 3) || 3));
    const runNames = eligibleNames.slice(0, batchLimit);
    if (!runNames.length) return { ok: true, skipped: true, reason: 'no_eligible_profiles' };

    // Retry de fila também deve respeitar fase de configuração/human control.
    const rr = await recycleGatewayActives({ reasonTag: 'gateway_retry', profileNames: runNames, allowBusy: false });
    const failMap = new Map();
    for (const f of (Array.isArray(rr && rr.failures) ? rr.failures : [])) {
      const nome = String(f && f.nome || '').trim();
      if (!nome) continue;
      failMap.set(nome, String(f && f.error || 'recycle_failed').slice(0, 220));
    }

    const runSet = new Set(runNames);
    const baseMs = Math.max(15 * 1000, Number(process.env.GATEWAY_RECYCLE_RETRY_BASE_MS || 30 * 1000) || (30 * 1000));
    const maxMs = Math.max(baseMs, Number(process.env.GATEWAY_RECYCLE_RETRY_MAX_MS || (15 * 60 * 1000)) || (15 * 60 * 1000));
    const nextPending = [];
    for (const row of pendingRows) {
      const nome = String(row && row.nome || '').trim();
      if (!nome) continue;
      if (!runSet.has(nome)) {
        nextPending.push(row);
        continue;
      }
      const failErr = failMap.get(nome);
      if (!failErr) continue;
      const attempts = (Number(row && row.attempts || 0) || 0) + 1;
      const retryInMs = Math.min(maxMs, baseMs * Math.max(1, attempts));
      nextPending.push({
        nome,
        firstSeenAt: Number(row && row.firstSeenAt || nowTs) || nowTs,
        attempts,
        nextRetryAt: nowTs + retryInMs,
        lastError: failErr,
        reason: String(row && row.reason || 'gateway_retry').slice(0, 80),
        updatedAt: nowTs
      });
    }
    writeGatewayRecycleQueue({ pending: nextPending });
    return { ok: true, processed: runNames.length, failed: failMap.size, queueRemaining: nextPending.length };
  } finally {
    gatewayRecycleQueueInFlight = false;
  }
}

async function execGatewaySetProxies(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const activeNames = await listActiveGatewayProfiles();
  const beforeMap = await collectGatewayResolutionSnapshot(activeNames);
  const r = gatewayProxy.applyGatewayPayload(payload);
  if (!r || r.ok !== true) throw new Error('gateway_set_proxies_failed');
  const afterMap = await collectGatewayResolutionSnapshot(activeNames);

  const changed = [];
  for (const nome of activeNames) {
    const b = beforeMap.get(nome);
    const a = afterMap.get(nome);
    const sigBefore = String(b && b.signature || 'off:missing');
    const sigAfter = String(a && a.signature || 'off:missing');
    if (sigBefore !== sigAfter) changed.push(nome);
  }

  let recycle = { ok: true, skipped: true, reason: 'no_profile_proxy_change' };
  if (changed.length > 0) {
    // Importante: não forçar recycle durante stock_provision/login em andamento.
    // Perfis ocupados entram em retry queue e reciclam depois.
    recycle = await recycleGatewayActives({ reasonTag: 'gateway_changed', profileNames: changed, allowBusy: false });
    const failedNames = (Array.isArray(recycle && recycle.failures) ? recycle.failures : [])
      .map((f) => String(f && f.nome || '').trim())
      .filter(Boolean);
    if (failedNames.length > 0) {
      try { enqueueGatewayRecycleProfiles(failedNames, 'gateway_changed_retry'); } catch {}
    }
  }
  return {
    ok: true,
    inventoryVersion: String(r.inventoryVersion || ''),
    slotsCount: Number(r.slotsCount || 0) || 0,
    recycle: {
      triggered: changed.length > 0,
      totalActive: activeNames.length,
      changedProfiles: changed.length,
      changedSample: changed.slice(0, 25),
      result: recycle
    }
  };
}

// ===== NOVO: Exportar perfis para o estoque =====
async function execStockExportProfiles(cmd) {
  try {
    const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
    const wantedNames = Array.isArray(payload.profileNames) ? payload.profileNames.map(x => String(x || '').trim()).filter(Boolean) : [];
    const includeCookies = payload.includeCookies === true || payload.includeCookies === 1 || String(payload.includeCookies || '').trim() === '1';

    // Busca lista de perfis do snapshot/status
    let st = null;
    try { st = await httpJson('/api/status'); } catch {}
    let perfis = Array.isArray(st && st.perfis) ? st.perfis : [];
    if (wantedNames.length) {
      const want = new Set(wantedNames);
      perfis = perfis.filter(p => p && want.has(String(p.nome || '').trim()));
    }
    
    const results = [];
    const BATCH_SIZE = 20; // Limite para não estourar payload
    const batches = [];
    for (let i = 0; i < perfis.length; i += BATCH_SIZE) {
      batches.push(perfis.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      for (const p of batch) {
        const nome = String(p && p.nome || '').trim();
        if (!nome) continue;

        const result = {
          profile_name: nome,
          city: String(p.cidade || '').trim() || null,
          label: String(p.label || '').trim() || null,
          active: !!(p.active),
          working: !!(p.trabalhando),
          uaPresetId: null,
          fp_summary_json: null,
          cookies: null,
          cookie_fp: null
        };

        // Busca manifest (com cookies) se disponível.
        // Regra enterprise: por padrão NÃO envia cookies no export (payload grande).
        // Quando includeCookies=1 (ação manual no CT), aí sim envia cookies.
        try {
          const manifest = await httpJson(`/api/perfis/${encodeURIComponent(nome)}/manifest`);
          if (manifest && manifest.manifest && manifest.manifest.cookies) {
            const cookiesArr = Array.isArray(manifest.manifest.cookies) ? manifest.manifest.cookies : [];
            try {
              const uaPresetId = manifest && manifest.manifest && manifest.manifest.uaPresetId ? String(manifest.manifest.uaPresetId).trim() : '';
              if (uaPresetId) result.uaPresetId = uaPresetId;
              const fp = (manifest && manifest.manifest && manifest.manifest.fp && typeof manifest.manifest.fp === 'object') ? manifest.manifest.fp : null;
              const uaString = manifest && manifest.manifest && manifest.manifest.uaString ? String(manifest.manifest.uaString) : '';
              // fp_summary_json é usado no CT para drilldown humano (sem poluir a tabela principal)
              const fpSummary = {
                viewport: fp && fp.viewport ? fp.viewport : null,
                dpr: fp && (fp.dpr !== undefined) ? fp.dpr : null,
                hardwareConcurrency: fp && (fp.hardwareConcurrency !== undefined) ? fp.hardwareConcurrency : null,
                uaString: uaString ? uaString.slice(0, 260) : null
              };
              result.fp_summary_json = JSON.stringify(fpSummary);
            } catch {}
            // Calcula fingerprint (sempre, se possível)
            if (cookiesArr.length) {
              try {
                const crypto = require('crypto');
                const sha1 = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex');
                const byName = new Map(cookiesArr.map(c => [String(c?.name || '').trim(), String(c?.value || '')]));
                const cUser = byName.get('c_user') || '';
                const xs = byName.get('xs') || '';
                const datr = byName.get('datr') || '';
                if (cUser && xs) result.cookie_fp = sha1(`c_user=${cUser};xs=${xs};datr=${datr}`);
              } catch {}
            }
            if (includeCookies) {
              result.cookies = cookiesArr;
            }
          }
        } catch (e) {
          // Se não conseguir manifest, continua sem cookies
        }

        results.push(result);
      }
      // Pequeno delay entre batches para não estourar
      if (batches.length > 1) await sleep(500);
    }

    return {
      ok: true,
      profilesCount: results.length,
      results
    };
  } catch (e) {
    return {
      ok: false,
      error: (e && e.message) || String(e),
      profilesCount: 0,
      results: []
    };
  }
}

// ===== NOVO: Push de atualização do Estoque para um perfil existente =====
async function execStockPushAccountUpdate(cmd) {
  const payload = (cmd && cmd.payload && typeof cmd.payload === 'object') ? cmd.payload : {};
  const profileName = String(payload.profileName || '').trim();
  if (!profileName) throw new Error('missing_profileName');
  const body = {
    label: payload.label ?? null,
    login: payload.login ?? null,
    password: payload.password ?? null,
    cookies: Array.isArray(payload.cookies) ? payload.cookies : null,
    // default enterprise: store only (não reinjeta automaticamente)
    applyCookies: (payload.applyCookies === true || payload.applyCookies === 1 || String(payload.applyCookies || '').trim() === '1') ? 1 : 0
  };
  const r = await httpJson(`/api/perfis/${encodeURIComponent(profileName)}/stock-update`, {
    method: 'POST',
    headers: { 'x-operator': 'stock_push' },
    body
  });
  if (!r || r.ok === false) throw new Error((r && r.error) ? String(r.error) : 'stock_update_failed');
  return r;
}

// ===== NOVO: Unlock do lock global de provisão (safe recovery) =====
async function execProvisionUnlock(cmd) {
  const before = (() => {
    try { return provisionLock.get(); } catch { return null; }
  })();
  const wasActive = !!(before && before.active);
  const lock = before && before.lock ? before.lock : null;
  const released = (() => {
    try { return provisionLock.release({ force: true }); } catch { return { ok: false, released: false }; }
  })();
  return {
    ok: true,
    wasActive,
    lock,
    released: !!(released && released.ok && released.released)
  };
}

// ===== ALTERAÇÃO INÍCIO: applyCommands para ACK após cada execução =====
async function applyCommands(cmds = []) {
  const incoming = Array.isArray(cmds) ? cmds.filter(Boolean) : [];
  if (!incoming.length) {
    return { ok: true, results: [] };
  }

  // Enterprise: em lotes com tempestade de gateway, processar só o último comando
  // de gateway no lote atual (os anteriores ficam superseded) para não atrasar provision.
  const gatewayTypes = new Set(['gateway_set_proxies', 'gateway_reconcile']);
  let lastGatewayIdx = -1;
  for (let i = incoming.length - 1; i >= 0; i--) {
    const t = String(incoming[i] && incoming[i].type || '').trim();
    if (gatewayTypes.has(t)) { lastGatewayIdx = i; break; }
  }

  const collapsed = [];
  const superseded = [];
  for (let i = 0; i < incoming.length; i++) {
    const c = incoming[i];
    const t = String(c && c.type || '').trim();
    if (gatewayTypes.has(t) && lastGatewayIdx >= 0 && i !== lastGatewayIdx) {
      superseded.push(c);
      continue;
    }
    collapsed.push(c);
  }

  // Prioridade operacional: cadastro/login primeiro; gateway depois.
  const highPriorityTypes = new Set(['stock_provision', 'login_remediate', 'stock_push_account_update']);
  const prioritized = [];
  const regular = [];
  for (const c of collapsed) {
    const t = String(c && c.type || '').trim();
    if (highPriorityTypes.has(t)) prioritized.push(c);
    else regular.push(c);
  }
  const ordered = [...prioritized, ...regular];

  const results = [];
  for (const c of superseded) {
    try {
      results.push({
        id: c && c.id ? String(c.id) : null,
        type: c && c.type ? String(c.type) : null,
        ok: true,
        skipped: true,
        reason: 'superseded_by_newer_gateway_command_in_same_batch'
      });
    } catch {}
  }

  for (const c of ordered) {
    try {
      if (!c || !c.type) continue;
      const cmdId = c && c.id ? String(c.id).trim() : '';
      const cmdType = String(c.type || '').trim();
      // Compat: Gemini mencionou `data`, legado usa `payload`.
      if (!c.payload && c.data && typeof c.data === 'object') c.payload = c.data;
      let details = null;
      if (c.type === 'close_all')             {
        // Ultra enterprise: close_all só pode ser executado quando explicitamente humano (UI / operador).
        // Qualquer close_all “automático” (deploy/script) é bloqueado para evitar side-effects e instabilidade.
        if (!isHumanCloseAll(c)) {
          results.push({ id: cmdId || null, type: cmdType, ok: false, error: 'close_all_blocked_not_human', details: { blocked: true } });
          continue;
        }
        // Guardrail: nunca executar close_all automaticamente no meio de provisão.
        if (provisionLock.isActive()) {
          results.push({ id: cmdId || null, type: cmdType, ok: false, error: 'close_all_blocked_due_provision', details: { blocked: true, reason: 'provision_lock' } });
          continue;
        }
        await execCloseAll(c);
        results.push({ id: cmdId || null, type: cmdType, ok: true });
      }
      else if (c.type === 'open_all_24h')     { await execOpenAll24h(); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'robes_pause_24h_all')  { await execRobePauseAll(); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'robes_release_all')    { await execRobeReleaseAll(); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'robe_v2_recalc')       { details = await execRobeV2Recalc(c); results.push({ id: cmdId || null, type: cmdType, ok: true, details: details || null }); }
      else if (c.type === 'delete_perfis')    { details = await execDeletePerfis(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'migrate_profiles') { details = await execMigrateProfiles(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'stock_provision') { details = await execStockProvision(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'login_remediate') { details = await execLoginRemediate(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'profiles_cleanup') { details = await execProfilesCleanup(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'provision_unlock') { details = await execProvisionUnlock(c); results.push({ id: cmdId || null, type: cmdType, ok: true, details: details || null }); }
      else if (c.type === 'stock_export_profiles') { details = await execStockExportProfiles(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'stock_push_account_update') { details = await execStockPushAccountUpdate(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'backup_restore_probe') { details = await execBackupRestoreProbe(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'backup_restore_merge') { details = await execBackupRestoreMerge(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'backups_manifest')     { details = await execBackupsManifest(c); results.push({ id: cmdId || null, type: cmdType, ok: true, details: details || null }); }
      else if (c.type === 'profiles_fs_audit')    { details = await execProfilesFsAudit(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'profiles_purge_dirs')  { details = await execProfilesPurgeDirs(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'profiles_manifest_probe') { details = await execProfilesManifestProbe(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'profiles_relink_orphans') { details = await execProfilesRelinkOrphans(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'repair_perfis_json') { details = await execRepairPerfisJson(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'profiles_backfill_labels') { details = await execProfilesBackfillLabels(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'fetch_logs')       { await execFetchLogs(c); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'fetch_logs_query') { await execFetchLogsQuery(c); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'delta_force_city_collect') {
        details = await execDeltaForceCityCollect(c);
        results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok === true), details: details || null, error: (details && details.ok) ? null : String((details && details.error) || 'city_collect_failed') });
      }
      else if (c.type === 'logs_manifest')    { await execLogsManifest(c); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'health_bundle')    { await execHealthBundle(c); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'set_ct_config')    { details = await execSetCtConfig(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'set_groq_config')  { details = await execSetGroqConfig(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'reseed_host_id')   { details = await execReseedHostId(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'gateway_set_proxies' || c.type === 'gateway_reconcile') { details = await execGatewaySetProxies(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'force_full_report') { results.push({ id: cmdId || null, type: cmdType, ok: true, details: { ok: true, forced: true } }); }
      else if (c.type === 'rotate_logs')      { details = await execRotateLogs(c); results.push({ id: cmdId || null, type: cmdType, ok: !!(details && details.ok !== false), details: details || null }); }
      else if (c.type === 'self_update')      { await execSelfUpdate(c); results.push({ id: cmdId || null, type: cmdType, ok: true }); }
      else if (c.type === 'infra_ping')       { results.push({ id: cmdId || null, type: cmdType, ok: true, details: { ok: true, pong: true, ts: Date.now() } }); }
      else { throw new Error('unknown_command:' + String(c.type)); }
      logger.info('[DASH][CMD] executado: ' + c.type);
    } catch (e) {
      logger.warn('[DASH][CMD] falha ao executar ' + (c && c.type), { error: e && e.message || e });
      results.push({
        id: c && c.id ? String(c.id) : null,
        type: c && c.type ? String(c.type) : null,
        ok: false,
        error: (e && e.message) ? String(e.message) : String(e),
        details: null
      });
    }
  }
  const okAll = results.every((r) => r && r.ok === true);
  return { ok: okAll, results };
}
// ===== ALTERAÇÃO FIM ===============================================

async function tick(reason = 'interval') {
  if (process.env.DASHBOARD_DEBUG === '1') {
    logger.info('[DASH][TICK] start: ' + new Date().toISOString());
  }
  const start = Date.now();

  // Enterprise: NUNCA "pular" envio silenciosamente.
  // Se um tick estiver em voo, marcamos pending e rodamos um tick extra assim que terminar (last-wins).
  if (inFlight) {
    pending = true;
    // log rate-limited para auditoria (evita sumir telemetria por "skip")
    try {
      tick._lastInFlightSkipLogAt = tick._lastInFlightSkipLogAt || 0;
      const nowTs = Date.now();
      const last = Number(tick._lastInFlightSkipLogAt || 0) || 0;
      if (!last || (nowTs - last) > 60000) {
        tick._lastInFlightSkipLogAt = nowTs;
        logger.warn('[DASH][TICK] inFlight=true -> pending=1 (will run after current finishes)', { reason: String(reason || ''), sinceLastDoneMs: lastTickDoneAt ? (nowTs - lastTickDoneAt) : null });
      }
    } catch {}
    return;
  }
  inFlight = true;
  pending = false;
  try {
    const nowTick = Date.now();
    const shouldSendFullReport =
      String(reason || '').toLowerCase() === 'boot' ||
      !lastFullReportAt ||
      (nowTick - Number(lastFullReportAt || 0)) >= FULL_REPORT_INTERVAL_MS;

    // Modo poll-only: mantém entrega de comandos rápida sem enviar status pesado.
    if (!shouldSendFullReport) {
      const hostId = await getOrCreateHostId();
      hostIdCache = hostId;
      try { await flushPendingAcks({ limit: 40 }); } catch {}
      // Pulso leve de RAM (lê só status.json local): o CT não recebe snapshot completo por horas,
      // mas o scheduler de estoque precisa de freeMB atual para não travar em "no_headroom" fantasioso.
      let pulseSys = null;
      let pollLight = null;
      try {
        const raw = fsSync.readFileSync(STATUS_PATH, 'utf8');
        const sj = JSON.parse(raw);
        const fm = Number(sj && sj.sys && sj.sys.freeMB);
        if (Number.isFinite(fm) && fm >= 0) {
          pulseSys = { freeMB: Math.round(fm) };
          const tm = Number(sj && sj.sys && sj.sys.totalMB);
          if (Number.isFinite(tm) && tm > 0) pulseSys.totalMB = Math.round(tm);
        }
        pollLight = buildPollLightTelemetry(sj);
      } catch {}
      const pollPayload = {
        pollOnly: true,
        hostname: (os && os.hostname) ? os.hostname() : '',
        hostId,
        sentAt: now(),
        ...(pulseSys ? { pulseSys } : {}),
        ...(pollLight ? { pollLight } : {})
      };
      const pollResp = await tryAllEndpoints(pollPayload);
      if (pollResp && Array.isArray(pollResp.commands) && pollResp.commands.length) {
        await applyCommands(pollResp.commands);
      }
      // Retry contínuo de perfis pendentes de recycle de gateway.
      const queueTickBatch = Math.max(1, Math.min(20, Number(process.env.GATEWAY_RECYCLE_QUEUE_TICK_BATCH || 3) || 3));
      try { await processGatewayRecycleQueue({ maxProfiles: queueTickBatch }); } catch {}
      try { await flushPendingAcks({ limit: 40 }); } catch {}
      return;
    }

    // Rotação automática dos JSONL críticos para evitar crescimento infinito em disco.
    // Retenção por idade (default 48h), sem depender de comando manual.
    try { maybeAutoRotateCriticalJsonl(); } catch {}
    // Tentativa de drenar ACKs pendentes antes do ciclo normal.
    try { await flushPendingAcks({ limit: 40 }); } catch {}
    // ===== ALTERAÇÃO: obter [status, hostId] e atualizar hostIdCache =====
    const [status, hostId] = await Promise.all([readAggregatedStatus(), getOrCreateHostId()]);
    hostIdCache = hostId;
    // ===== FIM ======
    if (process.env.DASHBOARD_DEBUG === '1') {
      logger.info(`[DASH][TICK] got status in ${Date.now() - start}ms`);
    }

    const quick = buildQuickSnapshot(status);
    try {
      status.virtusMetrics = getVirtusMetricsCached(status);
    } catch {}

    // Verifica se precisa solicitar config (ctBaseUrl ou logIngestSecret ausentes)
    const cfg = readCtConfig();
    const needsConfig = !cfg.ctBaseUrl || !cfg.logIngestSecret;
    // Verifica se precisa solicitar config Groq (API key/model ausentes OU modelo divergente do esperado)
    // Importante: sem segredos no report — apenas boolean/modelo/metadata.
    const groqCfg = readGroqConfig(); // usado em runtime (OCR)
    const groqMeta = readGroqConfigMeta(); // telemetria segura
    // Modelo esperado (enterprise): default global acordado (pode ser sobrescrito por env no host)
    const expectedGroqModel = String(process.env.GROQ_MODEL || 'meta-llama/llama-4-maverick-17b-128e-instruct').trim();
    const needsGroqConfig =
      !(groqMeta && groqMeta.effectiveApiKeyPresent) ||
      !(groqMeta && groqMeta.effectiveModelPresent) ||
      (!!expectedGroqModel && !!(groqMeta && groqMeta.effectiveModel) && String(groqMeta.effectiveModel) !== String(expectedGroqModel));

    const gatewayNeeds = gatewayProxy.getNeedsFlags();
    const gatewayRuntime = gatewayProxy.getRuntimeSummary();
    const payload = {
      hostname: quick.system.hostname,
      hostId,
      sentAt: now(),
      needsConfig: needsConfig, // Flag para CT saber que precisa enviar set_ct_config
      needsGroqConfig: needsGroqConfig, // Flag para CT saber que precisa enviar set_groq_config
      needsGatewayInventory: !!gatewayNeeds.needsGatewayInventory,
      needsGatewayProxyTrafficCreds: !!gatewayNeeds.needsGatewayProxyTrafficCreds,
      groq: {
        expectedModel: String(expectedGroqModel || '').slice(0, 140),
        effectiveSource: groqMeta && groqMeta.effectiveSource ? String(groqMeta.effectiveSource) : 'unknown',
        effectiveModel: groqMeta && groqMeta.effectiveModel ? String(groqMeta.effectiveModel).slice(0, 140) : '',
        effectiveApiKeyPresent: !!(groqMeta && groqMeta.effectiveApiKeyPresent),
        fileUpdatedAt: (groqMeta && groqMeta.file && groqMeta.file.updatedAt) ? groqMeta.file.updatedAt : null
      },
      host: {
        // RAM total do servidor (para capacidade no notificador)
        totalMemGB: (quick && quick.system && typeof quick.system.totalMB === 'number')
          ? Math.max(1, Math.round(quick.system.totalMB / 1024))
          : Math.max(1, Math.round(os.totalmem() / (1024 * 1024 * 1024)))
      },
      status: {
        ...status,
        gateway: gatewayRuntime,
        _dashboard: quick
      }
    };
    try {
      const raw = JSON.stringify(payload);
      const bytes = Buffer.byteLength(raw, 'utf8');
      payload._telemetry = {
        payloadBytes: bytes,
        intervalMs: FULL_REPORT_INTERVAL_MS,
        perfisCount: Array.isArray(status && status.perfis) ? status.perfis.length : 0
      };
    } catch {}

    const resp = await tryAllEndpoints(payload);
    if (resp && Array.isArray(resp.commands) && resp.commands.length) {
      await applyCommands(resp.commands);
    }
    // Retry contínuo de perfis pendentes de recycle de gateway.
    const queueTickBatch = Math.max(1, Math.min(20, Number(process.env.GATEWAY_RECYCLE_QUEUE_TICK_BATCH || 3) || 3));
    try { await processGatewayRecycleQueue({ maxProfiles: queueTickBatch }); } catch {}
    // Nova drenagem após executar comandos (captura ACKs recém-encolados por falha transitória).
    try { await flushPendingAcks({ limit: 40 }); } catch {}
    lastFullReportAt = Date.now();
    if (process.env.DASHBOARD_DEBUG === '1') {
      logger.info(`[DASH][TICK] post finish in ${Date.now() - start}ms`);
    }

  } catch (e) {
    const m = e && e.message ? e.message : String(e);
    debounceWarn('Falha ao enviar status: ' + m);
  } finally {
    inFlight = false;
    lastTickDoneAt = Date.now();
  }
}

function startDashboardMonitor() {
  // DESATIVADO POR DIRETRIZ (TACADA 1): extinção do polling/loop automático.
  // Este módulo agora deve ser acionado por gatilho HTTP stateless (command-bus).
  return;
}

const COMMAND_HANDLERS = Object.freeze({
  close_all: execCloseAll,
  open_all_24h: execOpenAll24h,
  robes_pause_24h_all: execRobePauseAll,
  robes_release_all: execRobeReleaseAll,
  robe_v2_recalc: execRobeV2Recalc,
  delete_perfis: execDeletePerfis,
  migrate_profiles: execMigrateProfiles,
  stock_provision: execStockProvision,
  login_remediate: execLoginRemediate,
  profiles_cleanup: execProfilesCleanup,
  provision_unlock: execProvisionUnlock,
  stock_export_profiles: execStockExportProfiles,
  stock_push_account_update: execStockPushAccountUpdate,
  backup_restore_probe: execBackupRestoreProbe,
  backup_restore_merge: execBackupRestoreMerge,
  backups_manifest: execBackupsManifest,
  profiles_fs_audit: execProfilesFsAudit,
  profiles_purge_dirs: execProfilesPurgeDirs,
  profiles_manifest_probe: execProfilesManifestProbe,
  profiles_relink_orphans: execProfilesRelinkOrphans,
  repair_perfis_json: execRepairPerfisJson,
  profiles_backfill_labels: execProfilesBackfillLabels,
  fetch_logs: execFetchLogs,
  fetch_logs_query: execFetchLogsQuery,
  delta_force_city_collect: execDeltaForceCityCollect,
  logs_manifest: execLogsManifest,
  health_bundle: execHealthBundle,
  set_ct_config: execSetCtConfig,
  set_groq_config: execSetGroqConfig,
  reseed_host_id: execReseedHostId,
  gateway_set_proxies: execGatewaySetProxies,
  gateway_reconcile: execGatewaySetProxies,
  rotate_logs: execRotateLogs,
  self_update: execSelfUpdate,
  infra_ping: async () => ({ ok: true, pong: true, ts: Date.now() })
});

module.exports = {
  // polling morto (mantido apenas por compat, mas não inicia timers)
  startDashboardMonitor,
  // barramento novo: processamento direto
  applyCommands,
  COMMAND_HANDLERS
};
