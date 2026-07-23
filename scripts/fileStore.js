// scripts/fileStore.js

// Centraliza TODO o acesso seguro a arquivos de perfis, desired, status, manifests, paths, renomeio, locks leves de migração, etc.
// Exporta funções para server.js, apis, worker etc (NÃO separar arquivos!).
// Só use funções DENTRO DESTE SCRIPT para acessar/mexer em arquivos dessas estruturas!

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const utils = require('./utils.js'); // slugify, etc.

//// Constantes de caminhos globais ////
const dadosDir    = path.join(__dirname, '../dados');
const perfisPath  = path.join(dadosDir, 'perfis.json');
const perfisDir   = path.join(dadosDir, 'perfis');
const presetsPath = path.join(dadosDir, 'ua_presets.json');
const presetsPolicyPath = path.join(dadosDir, 'ua_presets_policy.json');
const desiredPath = path.join(dadosDir, 'desired.json');
const statusPath  = path.join(dadosDir, 'status.json');
const tombstonesDir = path.join(dadosDir, 'tombstones');

// ManifestStore import para setPerfilFrozenUntil
// const manifestStore = require('./manifestStore.js');

//// (opcional) Locks locais por perfil (adicione se/quando precisar) ////
// const profileLocks = {};

//// HELPERs DE IO atômicos e seguros ////

/** Lê arquivo JSON, fallback se ausente ou inválido */
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function _safeUnlink(p) { try { fs.unlinkSync(p); } catch {} }

function _sha256Hex(s) {
  try { return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex'); }
  catch { return null; }
}

// Leitura com preferência por backups (evita fallback destrutivo em cenários de crash/IO).
// - Se `file` falhar, tenta `file.old` e `file.bak_last`.
// - `validate` (opcional) permite exigir shape (ex.: Array para perfis.json).
function readJsonPrefer(file, fallback, { validate = null, retries = 4, delayMs = 25 } = {}) {
  const primary = String(file || '');
  const candidates = [primary, primary + '.old', primary + '.bak_last'];
  let lastErr = null;
  for (let attempt = 1; attempt <= Math.max(1, Number(retries) || 1); attempt++) {
    for (const fp of candidates) {
      try {
        if (!fp) continue;
        if (!fs.existsSync(fp)) continue;
        const raw = fs.readFileSync(fp, 'utf8');
        const val = JSON.parse(raw);
        if (validate && !validate(val)) throw new Error('invalid_shape');
        return { ok: true, value: val, source: fp, sha256: _sha256Hex(raw) };
      } catch (e) {
        lastErr = (e && e.message) ? String(e.message) : String(e);
      }
    }
    // Pequeno backoff: tolerante a janela de troca/IO (processo legado fora do lock).
    try { sleepMsSync(Math.max(0, Number(delayMs) || 0)); } catch {}
  }
  return { ok: false, value: fallback, source: null, sha256: null, error: lastErr || 'read_failed' };
}

function ledgerAppend(obj) {
  try {
    const p = path.join(dadosDir, 'perfis_ledger.jsonl');
    fs.appendFileSync(p, JSON.stringify({ ts: Date.now(), ...(obj || {}) }) + '\n', 'utf8');
  } catch {}
}

// H2 guard mode:
// - production (default): bypass flags are ignored
// - maintenance: bypass flags can be honored (with explicit env flag)
function getPerfisGuardMode() {
  const v = String(process.env.PERFIS_GUARD_MODE || '').trim().toLowerCase();
  return (v === 'maintenance') ? 'maintenance' : 'production';
}
function isPerfisMaintenanceMode() {
  return getPerfisGuardMode() === 'maintenance';
}
function shouldAllowPerfisBypass(flagName) {
  const mode = getPerfisGuardMode();
  const flagOn = String(process.env[String(flagName) || '']).trim() === '1';
  if (mode !== 'maintenance') {
    if (flagOn) ledgerAppend({ event: 'perfis_bypass_blocked_production', flag: String(flagName || ''), mode });
    return false;
  }
  if (!flagOn) return false;
  ledgerAppend({ event: 'perfis_bypass_allowed_maintenance', flag: String(flagName || ''), mode });
  return true;
}

/** Grava JSON atômico (Windows-safe), sem janela "unlink → missing" */
function writeJsonAtomic(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // tmp único evita colisão entre escritores concorrentes no mesmo arquivo.
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
    const old = file + '.old';
    const bakLast = file + '.bak_last';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2), 'utf8');
      fs.fsyncSync(fd); // obrigatoriedade militar: flush a disco agora!
    } finally {
      fs.closeSync(fd);
    }
    // Sempre manter um backup rápido do último "bom" (best-effort)
    try { if (fs.existsSync(file)) fs.copyFileSync(file, bakLast); } catch {}
    // Evita conflito no rename (Windows não sobrescreve destino)
    _safeUnlink(old);
    let movedToOld = false;
    try {
      if (fs.existsSync(file)) { fs.renameSync(file, old); movedToOld = true; }
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        // fallback: copy (ex.: cross-device). Ainda assim NÃO deixa buraco.
        fs.copyFileSync(tmp, file);
        _safeUnlink(tmp);
      }
      // Sucesso: limpa o antigo (já existe bak_last)
      if (movedToOld) _safeUnlink(old);
      return true;
    } catch (e) {
      // Rollback best-effort: se movemos o original para .old e falhamos, tentar restaurar.
      try {
        if (movedToOld && !fs.existsSync(file) && fs.existsSync(old)) {
          fs.renameSync(old, file);
        }
      } catch {}
      throw e;
    }
  } catch { return false; }
}

/** Garante desired.json (perfis) existe */
function ensureDesired() {
  try {
    if (fs.existsSync(desiredPath)) return;
    const old = desiredPath + '.old';
    const bak = desiredPath + '.bak_last';
    try {
      if (fs.existsSync(old)) { fs.copyFileSync(old, desiredPath); return; }
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, desiredPath); return; }
    } catch {}
    writeJsonAtomic(desiredPath, {
      perfis: {},
      _autoMode: { engine: 'delta' },
      autoMode: { engine: 'delta' },
      engine: 'delta'
    });
  } catch {}
}
/** Garante perfis.json existe */
function ensurePerfisJson() {
  try {
    if (fs.existsSync(perfisPath)) return;
    // Se houve crash durante troca, preferir restaurar de .old / .bak_last
    const old = perfisPath + '.old';
    const bak = perfisPath + '.bak_last';
    try {
      if (fs.existsSync(old)) { fs.copyFileSync(old, perfisPath); return; }
      if (fs.existsSync(bak)) { fs.copyFileSync(bak, perfisPath); return; }
    } catch {}
    // REBUILD é poderoso, mas pode ressuscitar legado (ex.: pastas antigas em dados/perfis).
    // Por padrão, DESLIGADO. Só habilita com flag explícita.
    if (shouldAllowPerfisBypass('PERFIS_ALLOW_REBUILD_FROM_RECORDS')) {
      // Rebuild best-effort: se houver registros por perfil, reconstruir o array (sem segredos).
      try {
        const rebuilt = loadPerfisFromRecordsBestEffort(10_000);
        if (rebuilt && rebuilt.length > 0) {
          writeJsonAtomic(perfisPath, rebuilt);
          ledgerAppend({ event: 'perfis_rebuild_from_records', ok: true, count: rebuilt.length });
          return;
        }
      } catch {}
    } else {
      ledgerAppend({ event: 'perfis_rebuild_skipped_flag_off', ok: true });
    }
    // Primeiro boot “zerado” (sem histórico): cria vazio (único caso permitido).
    writeJsonAtomic(perfisPath, []);
    ledgerAppend({ event: 'perfis_init_empty_created', ok: true });
  } catch {}
}

//// PERFIS: carregar e salvar array principal ////
function loadPerfisJson() {
  const r = readJsonPrefer(perfisPath, [], { validate: Array.isArray });
  if (r && r.ok && r.source && r.source !== perfisPath) {
    ledgerAppend({ event: 'perfis_read_fallback_used', source: r.source });
  }
  return (r && r.ok) ? r.value : [];
}
function savePerfisJson(arr) {
  // Guardrail militar: nunca permitir gravar [] por acidente (wipe total).
  // Para permitir explicitamente (caso extremo), setar PERFIS_ALLOW_EMPTY=1.
  const next = Array.isArray(arr) ? arr : (arr ? [arr] : []);
  if (next.length === 0 && !shouldAllowPerfisBypass('PERFIS_ALLOW_EMPTY')) {
    try {
      // mantém o arquivo atual e só loga (evita "sumiu tudo" pós-deploy/crash)
      console.error('[GUARD][perfis.json] tentativa de gravar array vazio BLOQUEADA (PERFIS_ALLOW_EMPTY!=1)');
    } catch {}
    return false;
  }
  try {
    // Backup rápido best-effort antes de sobrescrever (para recuperação manual).
    if (fs.existsSync(perfisPath)) {
      try { fs.copyFileSync(perfisPath, perfisPath + '.bak_last'); } catch {}
    }
  } catch {}
  return writeJsonAtomic(perfisPath, next);
}

function extractChromeMajorFromUa(uaString) {
  const s = String(uaString || '');
  const m = s.match(/Chrome\/(\d+)\./);
  return m ? (Number(m[1]) || 0) : 0;
}

function buildDefaultUaPolicy(presets) {
  const list = Array.isArray(presets) ? presets : [];
  let maxMajor = 0;
  for (const p of list) {
    const m = extractChromeMajorFromUa(p && p.uaString);
    if (m > maxMajor) maxMajor = m;
  }
  const tiersByPresetId = {};
  for (const p of list) {
    const id = String(p && p.id || '').trim();
    if (!id) continue;
    const major = extractChromeMajorFromUa(p && p.uaString);
    const delta = Math.max(0, maxMajor - major);
    let tier = 'aprovado';
    // Regra padrão enterprise: manter diversidade sem saturar presets muito antigos.
    if (delta > 16) tier = 'retirar';
    else if (delta > 6) tier = 'ajustar';
    const weight = tier === 'aprovado' ? 1.0 : (tier === 'ajustar' ? 0.45 : 0.08);
    tiersByPresetId[id] = {
      tier,
      major,
      delta,
      weight,
      enabledForNewProfiles: true
    };
  }
  return {
    version: 1,
    generatedAt: Date.now(),
    criteria: { approvedDeltaMax: 6, adjustDeltaMax: 16, maxMajor },
    tiersByPresetId
  };
}

function loadUaPolicy(presets) {
  try {
    const raw = readJsonSafe(presetsPolicyPath, null);
    if (!raw || typeof raw !== 'object') return buildDefaultUaPolicy(presets);
    const tiers = (raw.tiersByPresetId && typeof raw.tiersByPresetId === 'object') ? raw.tiersByPresetId : {};
    return {
      version: Number(raw.version || 1) || 1,
      generatedAt: Number(raw.generatedAt || Date.now()) || Date.now(),
      criteria: raw.criteria || {},
      tiersByPresetId: tiers
    };
  } catch {
    return buildDefaultUaPolicy(presets);
  }
}

//// UA PRESET: balanceado/ponderado para criar novos perfis ////
function pickUaPreset() {
  try {
    const presets = readJsonSafe(presetsPath, []);
    const perfis = loadPerfisJson();
    if (!Array.isArray(presets) || presets.length === 0) return null;
    const policy = loadUaPolicy(presets);

    const count = {};
    for (const p of presets) count[p.id] = 0;
    for (const pf of perfis) {
      if (pf && pf.uaPresetId) count[pf.uaPresetId] = (count[pf.uaPresetId] || 0) + 1;
    }

    let bestScore = Number.POSITIVE_INFINITY;
    let candidates = [];
    for (const p of presets) {
      const id = String(p && p.id || '').trim();
      if (!id) continue;
      const row = policy && policy.tiersByPresetId ? policy.tiersByPresetId[id] : null;
      const enabled = !(row && row.enabledForNewProfiles === false);
      if (!enabled) continue;
      const w = Number(row && row.weight || 1) || 1;
      const weight = Math.max(0.01, w);
      const usage = Number(count[id] || 0) || 0;
      const score = usage / weight;
      if (score < bestScore - 1e-9) {
        bestScore = score;
        candidates = [p];
      } else if (Math.abs(score - bestScore) <= 1e-9) {
        candidates.push(p);
      }
    }
    if (!candidates.length) return null;
    candidates.sort(() => Math.random() - 0.5);
    return candidates[0] || null;
  } catch { return null; }
}

// === lock helpers (owner-safe) ===
const _sleepBuf = new SharedArrayBuffer(4);
const _sleepI32 = new Int32Array(_sleepBuf);
function sleepMsSync(ms) {
  // Preferir não gastar CPU. Ainda é blocking (sync), mas evita busy-wait.
  try { Atomics.wait(_sleepI32, 0, 0, ms); }
  catch {
    const start = Date.now();
    while ((Date.now() - start) < ms) { /* fallback */ }
  }
}
function writeLockMetaBestEffort(fd, lockPath) {
  try {
    const meta = { pid: process.pid, ts: Date.now(), token: crypto.randomUUID() };
    fs.writeFileSync(fd, JSON.stringify(meta), 'utf8');
    try { fs.fsyncSync(fd); } catch {}
  } catch {}
  try { fs.fsyncSync(fd); } catch {}
}
function tryRecoverStaleLockBestEffort(lockPath, staleMs) {
  if (!staleMs || staleMs <= 0) return false;
  try {
    const st = fs.statSync(lockPath);
    const ageMs = Date.now() - Number(st.mtimeMs || 0);
    if (ageMs > staleMs) {
      try { fs.unlinkSync(lockPath); return true; } catch {}
    }
  } catch {}
  return false;
}

// === FILE LOCK HELPERS FOR desired.json ===
const desiredLockPath = desiredPath + '.lock';
function acquireDesiredLockFile({ retries = 120, delayMs = 20, staleMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function attempt(){
      tries++;
      try {
        const fd = fs.openSync(desiredLockPath, 'wx');
        writeLockMetaBestEffort(fd, desiredLockPath);
        return resolve(fd);
      } catch {
        // Best-effort: se o lock ficou “morto” (crash), tenta recuperar.
        tryRecoverStaleLockBestEffort(desiredLockPath, staleMs);
        if (tries >= retries) return reject(new Error('desired_lock_timeout'));
        setTimeout(attempt, delayMs);
      }
    })();
  });
}
function releaseDesiredLockFile(fd) {
  const acquired = (typeof fd === 'number');
  try { if (acquired) fs.closeSync(fd); } catch {}
  // CRÍTICO (P0): só remover lock se este processo adquiriu.
  if (acquired) {
    try { fs.unlinkSync(desiredLockPath); } catch {}
  }
}

// === Fase 2a: nurse wake (open-intent) ===
// Espelha o kick do ingest Delta, mas NÃO apaga no consume:
// cada worker/shard precisa acordar (nurse é sharded).
const NURSE_WAKE_KICK_PATH = path.join(dadosDir, 'desired.nurse.kick');
let _nurseWakeSuppressCheck = null; // () => boolean (setado pelo worker)

function setNurseWakeSuppressCheck(fn) {
  _nurseWakeSuppressCheck = (typeof fn === 'function') ? fn : null;
}

function snapshotDesiredOpenIntent(desired) {
  const d = (desired && typeof desired === 'object') ? desired : {};
  const openAll = !!(d._openAll && d._openAll.active === true);
  const autoOpen = !!(d._autoOpen && d._autoOpen.enabled === true);
  const actives = [];
  const perfis = (d.perfis && typeof d.perfis === 'object') ? d.perfis : {};
  for (const n of Object.keys(perfis)) {
    if (perfis[n] && perfis[n].active === true) actives.push(String(n));
  }
  actives.sort();
  return { openAll, autoOpen, actives };
}

function desiredOpenIntentIncreased(beforeIntent, afterIntent) {
  const a = beforeIntent || { openAll: false, autoOpen: false, actives: [] };
  const b = afterIntent || { openAll: false, autoOpen: false, actives: [] };
  if (!a.openAll && b.openAll) return { yes: true, reason: 'open_all_active' };
  if (!a.autoOpen && b.autoOpen) return { yes: true, reason: 'auto_open_enabled' };
  const beforeSet = new Set(Array.isArray(a.actives) ? a.actives : []);
  for (const n of (Array.isArray(b.actives) ? b.actives : [])) {
    if (!beforeSet.has(n)) return { yes: true, reason: 'active_true', nome: n };
  }
  return { yes: false, reason: '' };
}

function signalNurseWake(reason = 'desired_open_intent', meta = null) {
  try {
    if (_nurseWakeSuppressCheck && _nurseWakeSuppressCheck()) return false;
  } catch {}
  try {
    if (!fs.existsSync(dadosDir)) fs.mkdirSync(dadosDir, { recursive: true });
    // ts monotônico: evita 2 kicks no mesmo Date.now() serem ignorados (ts > lastSeen).
    let ts = Date.now();
    try {
      if (fs.existsSync(NURSE_WAKE_KICK_PATH)) {
        const raw = fs.readFileSync(NURSE_WAKE_KICK_PATH, 'utf8');
        const prev = JSON.parse(String(raw || '').split(/\r?\n/)[0] || '{}');
        const prevTs = Number(prev && prev.ts || 0) || 0;
        if (prevTs >= ts) ts = prevTs + 1;
      }
    } catch {}
    const payload = {
      ts,
      pid: process.pid,
      reason: String(reason || 'desired_open_intent').slice(0, 80),
      ...(meta && typeof meta === 'object' ? { meta } : {})
    };
    fs.writeFileSync(NURSE_WAKE_KICK_PATH, JSON.stringify(payload) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function maybeSignalNurseWakeFromDesiredChange(beforeIntent, afterIntent, opts = null) {
  try {
    if (opts && opts.nurseWake === false) return false;
    const hit = desiredOpenIntentIncreased(beforeIntent, afterIntent);
    if (!hit || !hit.yes) return false;
    return signalNurseWake(hit.reason, hit.nome ? { nome: hit.nome } : null);
  } catch {
    return false;
  }
}

/**
 * Atualização atômica de desired.json.
 * @param {(desired:object)=>any} mutator
 * @param {{ nurseWake?: boolean }} [opts] nurseWake:false desliga kick mesmo com open-intent
 */
async function withDesiredFileLockUpdate(mutator, opts = null) {
  let fd = null;
  try {
    fd = await acquireDesiredLockFile();
    // CRÍTICO: desired.json não pode ser "zerado" por parse error.
    // - Se o arquivo estiver ausente (primeiro boot), começamos do default.
    // - Se existir mas estiver inválido, tentamos .old/.bak_last; se falhar, aborta a escrita.
    let desired = null;
    if (!fs.existsSync(desiredPath)) {
      desired = { perfis: {} };
    } else {
      const r = readJsonPrefer(desiredPath, null, {
        validate: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
        retries: 6,
        delayMs: 35
      });
      if (!r || r.ok !== true) {
        ledgerAppend({ event: 'desired_write_blocked_unreadable', ok: false, error: (r && r.error) ? String(r.error) : 'unreadable' });
        throw new Error('desired_unreadable');
      }
      desired = r.value || { perfis: {} };
    }
    desired.perfis = desired.perfis || {};
    // Snapshot ANTES do mutator (mutator costuma mutar in-place).
    const beforeIntent = snapshotDesiredOpenIntent(desired);
    const next = await Promise.resolve(mutator(desired)) || desired;
    const okWrite = writeJsonAtomic(desiredPath, next);
    if (!okWrite) throw new Error('desired_write_failed');
    try {
      maybeSignalNurseWakeFromDesiredChange(beforeIntent, snapshotDesiredOpenIntent(next), opts);
    } catch {}
    return next;
  } finally {
    releaseDesiredLockFile(fd);
  }
}

// === FILE LOCK HELPERS FOR perfis.json (cluster-safe) ===
const perfisLockPath = perfisPath + '.lock';
function acquirePerfisLockFile({ retries = 240, delayMs = 25, staleMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    (function attempt(){
      tries++;
      try {
        const fd = fs.openSync(perfisLockPath, 'wx');
        writeLockMetaBestEffort(fd, perfisLockPath);
        return resolve(fd);
      } catch {
        tryRecoverStaleLockBestEffort(perfisLockPath, staleMs);
        if (tries >= retries) return reject(new Error('perfis_lock_timeout'));
        setTimeout(attempt, delayMs);
      }
    })();
  });
}
function releasePerfisLockFile(fd) {
  const acquired = (typeof fd === 'number');
  try { if (acquired) fs.closeSync(fd); } catch {}
  // CRÍTICO (P0): só remover lock se este processo adquiriu.
  if (acquired) {
    try { fs.unlinkSync(perfisLockPath); } catch {}
  }
}

/**
 * Atualização atômica e serializada do perfis.json.
 * Usado por api_perfis/cluster para evitar corridas (ex.: provision + UI + nurse).
 *
 * @param {(arr:any)=>any} mutator: recebe array atual, retorna próximo array
 * @param {object|null} meta: { caller?, reason? } (apenas para debug)
 * @returns {{ok:boolean, beforeLen?:number, afterLen?:number, error?:string}}
 */
function withPerfisFileLockUpdate(mutator, meta = null) {
  // Nota: API é síncrona de propósito (código atual chama sem await).
  let fd = null;
  try {
    // lock com backoff (sync)
    const retries = 240;
    const delayMs = 25;
    const staleMs = 120_000;
    let ok = false;
    for (let i = 0; i < retries; i++) {
      try {
        fd = fs.openSync(perfisLockPath, 'wx');
        writeLockMetaBestEffort(fd, perfisLockPath);
        ok = true;
        break;
      } catch {
        tryRecoverStaleLockBestEffort(perfisLockPath, staleMs);
        sleepMsSync(delayMs);
      }
    }
    if (!ok) return { ok: false, error: 'perfis_lock_timeout' };

    // CRÍTICO: nunca permitir que um erro de leitura/parse vire "[]".
    // Se perfis.json estiver inválido/ausente, tentar fallback (.old/.bak_last). Se não houver, abortar write.
    const r0 = readJsonPrefer(perfisPath, null, { validate: Array.isArray, retries: 6, delayMs: 35 });
    if (!r0 || r0.ok !== true) {
      ledgerAppend({ event: 'perfis_write_blocked_unreadable', ok: false, error: (r0 && r0.error) ? String(r0.error) : 'unreadable', meta: meta || null });
      return { ok: false, error: 'perfis_unreadable' };
    }
    const before = r0.value;
    const beforeLen = before.length;
    const next = mutator ? (mutator(before) ?? before) : before;
    const arr = Array.isArray(next) ? next : before;
    const afterLen = arr.length;

    // Guardrails militares:
    // (1) nunca gravar vazio por acidente
    if (afterLen === 0 && !shouldAllowPerfisBypass('PERFIS_ALLOW_EMPTY')) {
      ledgerAppend({ event: 'perfis_write_blocked_empty', ok: false, beforeLen, afterLen, meta: meta || null });
      return { ok: false, error: 'perfis_guard_blocked_empty' };
    }
    // (2) bloquear "wipe para 1/2 perfis" quando antes era grande (sinal forte de fallback/IO)
    if (beforeLen >= 10 && afterLen <= 2 && !shouldAllowPerfisBypass('PERFIS_ALLOW_TINY_AFTER')) {
      ledgerAppend({ event: 'perfis_write_blocked_tiny_after', ok: false, beforeLen, afterLen, meta: meta || null });
      return { ok: false, error: 'perfis_guard_blocked_tiny_after' };
    }

    const wrote = writeJsonAtomic(perfisPath, arr);
    if (!wrote) return { ok: false, error: 'perfis_write_failed' };
    ledgerAppend({
      event: 'perfis_write_ok',
      ok: true,
      beforeLen,
      afterLen,
      beforeSha256: r0.sha256 || null,
      afterSha256: _sha256Hex(JSON.stringify(arr)) || null,
      meta: meta || null
    });
    return { ok: true, beforeLen, afterLen };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message) : String(e) };
  } finally {
    releasePerfisLockFile(fd);
  }
}

// ===== Registro redundante por perfil (dados/perfis/<nome>/perfil.json) =====
function loadPerfisFromRecordsBestEffort(limit = 5000) {
  const base = perfisDir; // dados/perfis/<nome>/
  const out = [];
  try {
    if (!fs.existsSync(base)) return out;
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent || !ent.isDirectory()) continue;
      const nome = String(ent.name || '').trim();
      if (!nome) continue;
      if (isTombstoned(nome)) continue; // não ressuscitar perfil já tombstonado
      const fp = path.join(base, nome, 'perfil.json');
      if (!fs.existsSync(fp)) continue;
      const rec = readJsonSafe(fp, null);
      if (!rec || !rec.nome || !rec.cidade || !rec.userDataDir) continue;
      out.push({
        nome: String(rec.nome),
        cidade: String(rec.cidade),
        uaPresetId: rec.uaPresetId || 'default',
        uaString: rec.uaString,
        uaCh: rec.uaCh || {},
        fp: rec.fp || {},
        cookies: [], // nunca reconstruir cookies via records
        robeCooldownUntil: 0,
        configuredAt: null,
        userDataDir: String(rec.userDataDir),
        label: rec.label || null
      });
      if (out.length >= limit) break;
    }
  } catch {}
  return out;
}

function writePerfilRecord(perfilObj, { caller = 'unknown' } = {}) {
  try {
    const p = perfilObj && typeof perfilObj === 'object' ? perfilObj : null;
    const nome = p && p.nome ? String(p.nome) : '';
    if (!nome) return false;
    const dir = path.join(perfisDir, nome);
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {}
    const fp = path.join(dir, 'perfil.json');
    const rec = {
      nome,
      cidade: p && p.cidade ? String(p.cidade) : null,
      label: p && p.label ? String(p.label) : null,
      userDataDir: p && p.userDataDir ? String(p.userDataDir) : null,
      uaPresetId: p && p.uaPresetId ? String(p.uaPresetId) : 'default',
      uaString: p && p.uaString ? String(p.uaString) : null,
      uaCh: (p && p.uaCh && typeof p.uaCh === 'object') ? p.uaCh : {},
      fp: (p && p.fp && typeof p.fp === 'object') ? p.fp : {},
      createdAt: p && typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
      updatedAt: Date.now(),
      caller: String(caller || '').slice(0, 120)
    };
    const ok = writeJsonAtomic(fp, rec);
    ledgerAppend({ event: 'perfil_record_write', ok: !!ok, nome, caller: rec.caller });
    return !!ok;
  } catch {
    return false;
  }
}

function writeTombstone(nome, meta = {}) {
  try {
    const n = String(nome || '').trim();
    if (!n) return false;
    try { if (!fs.existsSync(tombstonesDir)) fs.mkdirSync(tombstonesDir, { recursive: true }); } catch {}
    const fp = path.join(tombstonesDir, `${n}.json`);
    const prev = readJsonSafe(fp, null) || {};
    const next = {
      nome: n,
      deletedAt: Number(meta && meta.deletedAt) || Date.now(),
      reason: meta && meta.reason ? String(meta.reason).slice(0, 160) : (prev.reason || 'delete'),
      by: meta && meta.by ? String(meta.by).slice(0, 120) : (prev.by || 'unknown'),
      stage: meta && meta.stage ? String(meta.stage).slice(0, 80) : (prev.stage || 'done'),
      updatedAt: Date.now()
    };
    const ok = writeJsonAtomic(fp, next);
    ledgerAppend({ event: 'perfis_tombstone_write', ok: !!ok, nome: n, stage: next.stage });
    return !!ok;
  } catch {
    return false;
  }
}

function isTombstoned(nome) {
  try {
    const n = String(nome || '').trim();
    if (!n) return false;
    const fp = path.join(tombstonesDir, `${n}.json`);
    if (!fs.existsSync(fp)) return false;
    const t = readJsonSafe(fp, null);
    if (!t || String(t.nome || '').trim() !== n) return false;
    return true;
  } catch {
    return false;
  }
}

//// PATCH DESIRED PERFIL ////
// PATCH DESIRED PERFIL // Lock atômico físico
async function patchDesired(nome, patch) {
  return withDesiredFileLockUpdate(desired => {
    desired.perfis = desired.perfis || {};
    desired.perfis[nome] = { ...(desired.perfis[nome] || {}), ...(patch || {}) };
    return desired;
  });
}

// Remove uma entrada completamente do desired.json (lock atômico)
async function removeDesired(nome) {
  return withDesiredFileLockUpdate(desired => {
    desired.perfis = desired.perfis || {};
    if (desired.perfis[nome]) delete desired.perfis[nome];
    return desired;
  });
}

//// STATUS SNAPSHOT: fallback a perfis.json se status.json ausente/inválido ////
function getStatusSnapshot() {
  // Militar: snapshot status unificado, null-safe, sem corridas, todos campos para painel
  // Carrega o snapshot do status.json, incluindo campos militares de RAM, CPU, robeMeta, cooldown, frozen etc.
  const st = readJsonSafe(statusPath, null);
  if (st && Array.isArray(st.perfis)) return st;
  // Fallback: cria estrutura básica a partir do perfis.json, SEM inventar campos ausentes
  const perfisArr = readJsonSafe(perfisPath, []);
  // PATCH: persistir e expor freezer detalhado no status (retrocompatível)
  const perfis = perfisArr.map(p => {
    let frozenReason = null, frozenAt = null, frozenSetBy = null, robeFrozenUntil = null;
    try {
      if (p.userDataDir) {
        const manifestPath = path.join(p.userDataDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const man = readJsonSafe(manifestPath, {});
          robeFrozenUntil = (typeof man.frozenUntil === 'number') ? man.frozenUntil : null;
          frozenReason = man.frozenReason || null;
          frozenAt    = man.frozenAt    || null;
          frozenSetBy = man.frozenSetBy || null;
        }
      }
    } catch {}
    return {
      nome: p.nome,
      label: p.label || null,
      cidade: p.cidade,
      uaPresetId: p.uaPresetId,
      active: false,
      trabalhando: false,
      configurando: false,
      // Militar: RAM desconhecida/null, nunca fake zero
      ramMB: null,
      // Militar: CPU desconhecida/null, nunca fake zero
      cpuPercent: null,
      // Militar: numPages desconhecido/null
      numPages: null,
      // Militar: robeFrozenUntil
      robeFrozenUntil,
      // PATCH: campos detalhados do freezer
      frozenReason,
      frozenAt,
      frozenSetBy,
      problem: false // <<< ADICIONE ESTA LINHA ao objeto retornado de cada perfil
      // Adicione outros campos health militar que o painel consome, sempre iniciando com null se não disponível.
    };
  });
  // Não inventa campos militares se não existem snapshot
  return { perfis, robes: {}, robeQueue: [], ts: Date.now() };
}

// Função para gravar (persistir) o snapshot do status
function writeStatusSnapshot(obj) {
  // Militar: snapshot status unificado, null-safe, sem corridas, todos campos para painel
  // NÃO inventa/zera nada: salva exatamente o objeto recebido
  return writeJsonAtomic(statusPath, obj);
}

// Função: Leitura de campo militar granular por perfil
function getStatusField(nome, campo) {
  const snapshot = getStatusSnapshot();
  const ent = (snapshot.perfis||[]).find(p => p && p.nome === nome);
  if (!ent) return undefined;
  // Militar: RAM desconhecida/null, nunca fake zero
  if (
    ['ramMB', 'cpuPercent', 'numPages', 'robeFrozenUntil'].includes(campo)
  ) {
    return (typeof ent[campo] === 'number' ? ent[campo] : (ent[campo] !== undefined ? ent[campo] : null));
  }
  // PATCH: freezer detalhado (não inventar valores fake, null retrocompatível)
  if (
    ['frozenReason','frozenAt','frozenSetBy'].includes(campo)
  ) {
    return (ent[campo] !== undefined ? ent[campo] : null);
  }
  return ent[campo];
}

// Função: Atualização/patch granular de campo militar por perfil
function writeStatusField(nome, campo, valor) {
  const snapshot = getStatusSnapshot();
  const arr = Array.isArray(snapshot.perfis) ? snapshot.perfis : [];
  const idx = arr.findIndex(p => p && p.nome === nome);
  if (idx < 0) return false;
  // Militar: RAM desconhecida/null, nunca fake zero
  if(
    ['ramMB', 'cpuPercent', 'numPages', 'robeFrozenUntil'].includes(campo)
  ) {
    arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
  }
  // PATCH: freezer detalhado (não inventar valores fake, sempre null se desconhecido)
  else if (
    ['frozenReason','frozenAt','frozenSetBy'].includes(campo)
  ) {
    arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
  } else {
    arr[idx][campo] = valor;
  }
  writeJsonAtomic(statusPath, snapshot);
  return true;
}

// Função: PATCH múltiplos campos militares por perfil
function patchStatusField(nome, patchObj) {
  const snapshot = getStatusSnapshot();
  const arr = Array.isArray(snapshot.perfis) ? snapshot.perfis : [];
  const idx = arr.findIndex(p => p && p.nome === nome);
  if (idx < 0) return false;
  // Garantir null para RAM/cpu/numPages/frozen se não disponíveis!
  Object.entries(patchObj || {}).forEach(([campo, valor]) => {
    if (
      ['ramMB', 'cpuPercent', 'numPages', 'robeFrozenUntil'].includes(campo)
    ) {
      // Militar: RAM desconhecida/null, nunca fake zero
      arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
    }
    // PATCH: freezer detalhado (não inventar valores fake, sempre null se desconhecido)
    else if (
      ['frozenReason','frozenAt','frozenSetBy'].includes(campo)
    ) {
      arr[idx][campo] = (valor !== undefined && valor !== null) ? valor : null;
    } else {
      arr[idx][campo] = valor;
    }
  });
  writeJsonAtomic(statusPath, snapshot);
  return true;
}

// ******** REMOVIDA updateManyStatusFields(obj) ********

// Função militar completa para ler TUDO (RAM, robeMeta, cooldowns etc.)
function getFullStatusSnapshot() {
  // Sempre retorna o último snapshot físico gravado (nunca inventar/popular campos virtuais)
  return getStatusSnapshot(); // já retorna tudo do status.json conforme últimas gravações
}

// Função militar granular para update (nome, campo, valor)
function updateStatusField(nome, campo, valor) {
  return writeStatusField(nome, campo, valor);
}

// --------- CAMPOS MILITARIZADOS/ROBÔ ---------//
// Campo RAM por perfil: usado pelo painel militar e para circuit breaker de auto-reboot
// Campo robeFrozenUntil: antiflood militar, jamais re-enfileirar conta durante congelamento

// Exporta também patchStatusField e updateManyStatusFields para uso tanto pelo monitor RAM quanto circuito militar

//// VALIDADORES DE PATH ////
function existsDir(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
}
function existsFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

//// REMOVE/COPIA/MOVE DIRs (rimraf, copy, move atomic) ////
function rimrafSync(target) {
  try {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
  } catch (e) {
    // Fallback manual old node
    try {
      if (fs.existsSync(target)) {
        const entries = fs.readdirSync(target, { withFileTypes: true });
        for (const ent of entries) {
          const cur = path.join(target, ent.name);
          if (ent.isDirectory()) rimrafSync(cur);
          else { try { fs.unlinkSync(cur); } catch {} }
        }
        try { fs.rmdirSync(target); } catch {}
      }
    } catch {}
  }
}
function copyDirSync(src, dst) {
  if (!existsDir(src)) throw new Error('src dir inexistente: ' + src);
  if (!existsDir(dst)) fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else {
      const data = fs.readFileSync(s);
      fs.writeFileSync(d, data);
    }
  }
}
function moveDirAtomicSync(src, dst) {
  if (!existsDir(src)) throw new Error('src dir inexistente: ' + src);
  try {
    fs.renameSync(src, dst);
    return true;
  } catch {
    copyDirSync(src, dst);
    rimrafSync(src);
    return true;
  }
}

//// MANIPULADORES: LABEL, SLUG RENAME etc ////
function updatePerfilLabel(nome, novoLabel) {
  const perfisArr = loadPerfisJson();
  const idx = perfisArr.findIndex(p => p && p.nome === nome);
  if (idx < 0) throw new Error('Perfil não encontrado');
  perfisArr[idx].label = String(novoLabel || '').trim();
  // Manifest também
  // NOVO TRECHO ATUALIZADO PARA userDataDir
  const perfil = perfisArr.find(p => p && p.nome === nome);
  if (perfil && perfil.userDataDir) {
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    if (existsFile(manifestPath)) {
      const man = readJsonSafe(manifestPath, {});
      man.label = String(novoLabel || '').trim();
      writeJsonAtomic(manifestPath, man);
    }
  }
  savePerfisJson(perfisArr);
  return true;
}
function renamePerfilSlug(nomeAntigo, nomeNovoDesejado) {
  // ATUALIZADO: desired e manifest proteção por lock/store
  const novoSlug = utils.slugify(nomeNovoDesejado || '');
  if (!novoSlug) throw new Error('novo nome inválido');
  if (nomeAntigo === novoSlug) return { ok: true, renamed: false, nome: nomeAntigo };
  const perfisArr = loadPerfisJson();
  const idx = perfisArr.findIndex(p => p && p.nome === nomeAntigo);
  if (idx < 0) throw new Error('Perfil não encontrado');
  if (perfisArr.some(p => p && p.nome === novoSlug)) throw new Error('Já existe uma conta com esse nome');
  // --- INÍCIO DO NOVO BLOCO: mover apenas userDataDir apontado ----
  const pOld = perfisArr[idx];
  const oldDir = pOld.userDataDir;
  const newDirParent = path.dirname(oldDir);
  const newDir = path.join(newDirParent, novoSlug);
  if (!existsDir(oldDir)) throw new Error('Diretório do perfil ausente');
  moveDirAtomicSync(oldDir, newDir);
  pOld.nome = novoSlug;
  pOld.userDataDir = newDir;
  savePerfisJson(perfisArr);
  // Manifest
  const manifestPath = path.join(newDir, 'manifest.json');
  const man = readJsonSafe(manifestPath, {});
  man.nome = novoSlug;
  man.userDataDir = newDir;
  writeJsonAtomic(manifestPath, man);
  // --- FIM DO NOVO BLOCO ---
  // desired.json (usando lock)
  withDesiredFileLockUpdate(desired => {
    if (desired.perfis && desired.perfis[nomeAntigo]) {
      desired.perfis[novoSlug] = { ...(desired.perfis[novoSlug] || {}), ...(desired.perfis[nomeAntigo]) };
      delete desired.perfis[nomeAntigo];
      return desired;
    }
    return desired;
  });
  // status.json (opcional)
  try {
    const st = readJsonSafe(statusPath, null);
    if (st && Array.isArray(st.perfis)) {
      st.perfis.forEach(ent => { if (ent && ent.nome === nomeAntigo) ent.nome = novoSlug; });
      writeJsonAtomic(statusPath, st);
    }
  } catch {}
  return { ok: true, renamed: true, nome: novoSlug };
}

//// CHECAGEM ATIVO ////
function isPerfilAtivo(nome) {
  try {
    const st = readJsonSafe(statusPath, null);
    if (!st || !Array.isArray(st.perfis)) return false;
    const p = st.perfis.find(x => x && x.nome === nome);
    return !!(p && p.active);
  } catch { return false; }
}

//// RESETAR desired TODOS OFF ao boot ////
async function resetDesiredAllOffOnBoot({ reason = 'boot_start_closed' } = {}) {
  // Importante: precisa ser awaited no boot para não haver corrida com workers lendo desired.json.
  // Também não deve estourar unhandled rejection (lock timeout) => try/catch.
  try {
    const perfisArr = loadPerfisJson();
    const r = await withDesiredFileLockUpdate((desired) => {
      ensureDesired();
      desired = desired || {};
      desired.perfis = desired.perfis || {};
      let changed = 0;
      for (const p of (perfisArr || [])) {
        if (!p || !p.nome) continue;
        const nome = p.nome;
        const cur = desired.perfis[nome] || {};
        const next = {
          ...cur,
          active: false,
          virtus: 'off',
          configureOnce: false,
          robePlay: false,
          invokeHuman: false
        };
        desired.perfis[nome] = next;
        if (cur.active !== false || String(cur.virtus || '') !== 'off') changed++;
      }
      // Cancela open_all pendente (política: nunca auto-abrir após restart).
      try {
        if (desired._openAll && desired._openAll.active === true) {
          desired._openAll = { ...(desired._openAll || {}), active: false, doneAt: Date.now(), lastError: 'boot_reset' };
        }
      } catch {}
      desired._boot = { ...(desired._boot || {}), ts: Date.now(), reason: String(reason || '').slice(0, 120) };
      desired._bootStartClosed = true;
      desired._bootStartClosedAt = Date.now();
      desired._bootStartClosedReason = String(reason || '').slice(0, 160);
      return Object.assign(desired, { _bootStartClosedChanged: changed });
    });
    return { ok: true, changed: Number(r && r._bootStartClosedChanged || 0) || 0 };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

//// MÉTRICAS DO SISTEMA (RAM, CPU%) ////
// PATCH MILITAR: cpu.percent (global, para painel) é soma dos cpuPercent de todos perfis/Chrome do snapshot status.json dividido por cores.
// No Windows, loadavg==0, por isso não use loadavg! 
function getSysMetricsSnapshot() {
  const os = require('os');
  const totalBytes = os.totalmem();
  const freeBytes  = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const toMB = (b) => Math.round(b / (1024*1024));
  const toGB = (b) => Math.round(b / (1024*1024*10)) / 100; // duas casas

  const robeMetaStatus = (() => {
    try {
      const st = readJsonSafe(statusPath, null);
      if (st && st.robes) return st.robes;
    } catch {} return null;
  })();

  let cpuApprox = null;
  if (robeMetaStatus) {
    let cpuChrome = 0, count = 0;
    for (const nome in robeMetaStatus) {
      const v = robeMetaStatus[nome]?.cpuPercent;
      if (typeof v === 'number') { cpuChrome += v; count++; }
    }
    const coresQ = (os.cpus()||[]).length || 1;
    cpuApprox = count ? Math.min(100, Math.round(cpuChrome / coresQ)) : null;
  }

  return {
    ok: true,
    mem: {
      totalBytes,
      freeBytes,
      usedBytes,
      totalMB: toMB(totalBytes),
      freeMB:  toMB(freeBytes),
      usedMB:  toMB(usedBytes),
      totalGB: toGB(totalBytes),
      freeGB:  toGB(freeBytes),
      usedGB:  toGB(usedBytes),
      minFreeRequiredMB: parseInt(process.env.MIN_FREE_RAM_MB || '1536', 10)
    },
    cpu: {
      percent: cpuApprox // <= ISSO É O QUE O PAINEL CONSOME!
    },
    ts: Date.now()
  };
}

// ******** REMOVIDA getAggregateHealthMetrics() ********

/**
 * Persiste o frozenUntil DE UM PERFIL no seu manifest (para robustez do freeze, P0).
 */
async function setPerfilFrozenUntil(nome, frozenUntil) {
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) return false;
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    const man = readJsonSafe(manifestPath, {}) || {};
    man.frozenUntil = frozenUntil;
    return writeJsonAtomic(manifestPath, man);
  } catch { return false; }
}

/**
 * Lê o frozenUntil de um manifest de perfil, caso exista.
 */
function getPerfilFrozenUntil(nome) {
  try {
    const perfisArr = loadPerfisJson();
    const perfil = perfisArr.find(p => p && p.nome === nome);
    if (!perfil || !perfil.userDataDir) return null;
    const manifestPath = path.join(perfil.userDataDir, 'manifest.json');
    if (existsFile(manifestPath)) {
      const man = readJsonSafe(manifestPath, {});
      if (man && typeof man.frozenUntil === 'number' && man.frozenUntil > Date.now()) {
        return man.frozenUntil;
      }
    }
  } catch {}
  return null;
}

// === Helpers de validação de nome/slug e de existência de perfil ===
function isValidSlug(s) {
  return typeof s === 'string' && /^[a-z0-9_-]+$/.test(s);
}
function assertPerfilExists(fileStore, nome) {
  if (!isValidSlug(nome)) throw new Error('nome invalido');
  const perfis = fileStore.loadPerfisJson();
  if (!perfis.find(p => p && p.nome === nome)) throw new Error('perfil inexistente');
}

// EXPORTAÇÃO EXPANDIDA PARA FUNÇÕES MILITARES
module.exports = {
  dadosDir, perfisPath, perfisDir, presetsPath, desiredPath, statusPath,
  readJsonSafe, writeJsonAtomic, ensureDesired, ensurePerfisJson,
  patchDesired, // agora async/lock
  loadPerfisJson, savePerfisJson, pickUaPreset, getStatusSnapshot, isPerfilAtivo,
  rimrafSync, copyDirSync, moveDirAtomicSync, updatePerfilLabel, renamePerfilSlug,
  resetDesiredAllOffOnBoot, getSysMetricsSnapshot, existsFile, existsDir,
  // Militares:
  writeStatusSnapshot,
  getStatusField, writeStatusField, patchStatusField,
  getFullStatusSnapshot, updateStatusField,
  setPerfilFrozenUntil,
  getPerfilFrozenUntil,
  // Novos helpers (APIs):
  isValidSlug,
  assertPerfilExists,
  // Lock helper export
  withDesiredFileLockUpdate,
  removeDesired, // <<--------- NOVO EXPORT
  withPerfisFileLockUpdate,
  // Fase 2a — nurse wake (open-intent kick)
  NURSE_WAKE_KICK_PATH,
  signalNurseWake,
  setNurseWakeSuppressCheck,
  snapshotDesiredOpenIntent,
  desiredOpenIntentIncreased,
  // Redundância/forense:
  writePerfilRecord,
  loadPerfisFromRecordsBestEffort,
  writeTombstone,
  isTombstoned,
};