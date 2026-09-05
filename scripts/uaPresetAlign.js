'use strict';

// Realinha conta cujo uaPresetId saiu do poço, ou cujo viewport ainda é gordo.
// Não inventa UA. Não mexe em uaString/uaCh. Só viewport/DPR/HW + id novo.

const fileStore = require('./fileStore.js');
const manifestStore = require('./manifestStore.js');

const HEAVY_MIN_WIDTH = 2560;
const HEAVY_MIN_HEIGHT = 2160;
const HEAVY_MIN_DPR = 1.5;

function num(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function loadPresets() {
  const list = fileStore.readJsonSafe(fileStore.presetsPath, []);
  return Array.isArray(list) ? list : [];
}

function loadPolicy() {
  const raw = fileStore.readJsonSafe(fileStore.presetsPolicyPath, null);
  if (!raw || typeof raw !== 'object') {
    return { retiredByPresetId: {}, tiersByPresetId: {} };
  }
  const retired = (raw.retiredByPresetId && typeof raw.retiredByPresetId === 'object')
    ? raw.retiredByPresetId
    : {};
  const tiers = (raw.tiersByPresetId && typeof raw.tiersByPresetId === 'object')
    ? raw.tiersByPresetId
    : {};
  return { retiredByPresetId: retired, tiersByPresetId: tiers };
}

function presetEnabled(policy, id) {
  const row = policy && policy.tiersByPresetId ? policy.tiersByPresetId[id] : null;
  return !(row && row.enabledForNewProfiles === false);
}

function readViewport(obj) {
  const vp = (obj && obj.viewport && typeof obj.viewport === 'object')
    ? obj.viewport
    : (obj && obj.fp && obj.fp.viewport && typeof obj.fp.viewport === 'object')
      ? obj.fp.viewport
      : {};
  const dprSrc = (obj && obj.dpr != null) ? obj.dpr
    : (obj && obj.fp && obj.fp.dpr != null) ? obj.fp.dpr
    : 1;
  return {
    width: num(vp.width, 0),
    height: num(vp.height, 0),
    dpr: num(dprSrc, 1)
  };
}

function fpLooksHeavy(fp) {
  const v = readViewport({ fp: fp || {} });
  if (v.width >= HEAVY_MIN_WIDTH) return true;
  if (v.height >= HEAVY_MIN_HEIGHT) return true;
  if (v.dpr >= HEAVY_MIN_DPR) return true;
  return false;
}

function presetLooksHeavy(preset) {
  const v = readViewport(preset || {});
  if (v.width >= HEAVY_MIN_WIDTH) return true;
  if (v.height >= HEAVY_MIN_HEIGHT) return true;
  if (v.dpr >= HEAVY_MIN_DPR) return true;
  return false;
}

function isLightEnough(preset) {
  return !!(preset && preset.id && !presetLooksHeavy(preset));
}

function indexPresets(list) {
  const byId = new Map();
  for (const p of list) {
    const id = String(p && p.id || '').trim();
    if (!id) continue;
    byId.set(id, p);
  }
  return byId;
}

function usageCounts(perfis, presets) {
  const count = {};
  for (const p of presets) {
    const id = String(p && p.id || '').trim();
    if (id) count[id] = 0;
  }
  for (const pf of (perfis || [])) {
    const id = pf && pf.uaPresetId ? String(pf.uaPresetId).trim() : '';
    if (!id) continue;
    count[id] = (count[id] || 0) + 1;
  }
  return count;
}

function pickLeastUsed(candidates, counts) {
  if (!candidates.length) return null;
  let best = Number.POSITIVE_INFINITY;
  const bag = [];
  for (const p of candidates) {
    const id = String(p.id);
    const n = Number(counts[id] || 0) || 0;
    if (n < best) {
      best = n;
      bag.length = 0;
      bag.push(p);
    } else if (n === best) {
      bag.push(p);
    }
  }
  if (!bag.length) return null;
  return bag[Math.floor(Math.random() * bag.length)] || bag[0];
}

function pickReplacement(account, presets, policy, counts) {
  const oldId = String(account && account.uaPresetId || '').trim();
  const byId = indexPresets(presets);
  const retired = policy && policy.retiredByPresetId && oldId
    ? policy.retiredByPresetId[oldId]
    : null;
  const siblingId = retired && retired.replacedBy ? String(retired.replacedBy).trim() : '';
  if (siblingId && byId.has(siblingId) && isLightEnough(byId.get(siblingId))) {
    return { preset: byId.get(siblingId), reason: 'retired_sibling' };
  }

  const light = presets.filter((p) => {
    const id = String(p && p.id || '').trim();
    if (!id) return false;
    if (!presetEnabled(policy, id)) return false;
    return isLightEnough(p);
  });
  if (!light.length) return { preset: null, reason: 'no_light_preset' };

  const major = fileStore.extractChromeMajorFromUa(account && account.uaString);
  if (major > 0) {
    const sameMajor = light.filter((p) => fileStore.extractChromeMajorFromUa(p.uaString) === major);
    const pickedSame = pickLeastUsed(sameMajor, counts);
    if (pickedSame) return { preset: pickedSame, reason: 'same_major_light' };
  }

  const picked = pickLeastUsed(light, counts);
  if (!picked) return { preset: null, reason: 'no_light_preset' };
  return { preset: picked, reason: 'least_used_light' };
}

function needsRealign(account, byId) {
  const id = String(account && account.uaPresetId || '').trim();
  if (!id || id === 'default') return { yes: true, reason: 'preset_missing' };
  if (!byId.has(id)) return { yes: true, reason: 'preset_retired' };
  if (fpLooksHeavy(account && account.fp)) return { yes: true, reason: 'viewport_heavy' };
  return { yes: false, reason: 'ok' };
}

function applyViewportOntoRecord(rec, preset) {
  const next = Object.assign({}, rec || {});
  next.uaPresetId = String(preset.id);
  const fp = Object.assign({}, (rec && rec.fp && typeof rec.fp === 'object') ? rec.fp : {});
  fp.viewport = {
    width: Math.floor(num(preset.viewport && preset.viewport.width, 1366)),
    height: Math.floor(num(preset.viewport && preset.viewport.height, 768))
  };
  fp.dpr = num(preset.dpr, 1);
  fp.hardwareConcurrency = Math.max(2, Math.floor(num(preset.hardwareConcurrency, 8)));
  next.fp = fp;
  return next;
}

async function readAccount(nome) {
  const n = String(nome || '').trim();
  let man = null;
  try { man = await manifestStore.read(n); } catch {}
  const perfis = fileStore.loadPerfisJson() || [];
  const row = perfis.find((p) => p && p.nome === n) || null;
  if (!row && !man) return { nome: n, man: null, row: null, base: null };
  const base = Object.assign({}, row || {}, man || {});
  if (man && man.uaPresetId != null) base.uaPresetId = man.uaPresetId;
  if (man && man.fp && typeof man.fp === 'object') base.fp = man.fp;
  if (man && man.uaString) base.uaString = man.uaString;
  if (man && man.uaCh) base.uaCh = man.uaCh;
  base.nome = n;
  return { nome: n, man, row, base };
}

async function persistAccount(nome, patched, source) {
  const n = String(nome || '').trim();
  const manNext = await manifestStore.update(n, (cur) => {
    const m = applyViewportOntoRecord(cur || {}, {
      id: patched.uaPresetId,
      viewport: patched.fp.viewport,
      dpr: patched.fp.dpr,
      hardwareConcurrency: patched.fp.hardwareConcurrency
    });
    return m;
  });
  let perfisOk = false;
  const lockRes = fileStore.withPerfisFileLockUpdate((arr) => {
    const i = arr.findIndex((p) => p && p.nome === n);
    if (i < 0) return arr;
    arr[i] = applyViewportOntoRecord(arr[i], {
      id: patched.uaPresetId,
      viewport: patched.fp.viewport,
      dpr: patched.fp.dpr,
      hardwareConcurrency: patched.fp.hardwareConcurrency
    });
    return arr;
  }, { caller: 'uaPresetAlign', reason: String(source || 'align').slice(0, 80) });
  perfisOk = !!(lockRes && lockRes.ok);
  try {
    const latest = (fileStore.loadPerfisJson() || []).find((p) => p && p.nome === n);
    if (latest) fileStore.writePerfilRecord(latest, { caller: 'uaPresetAlign' });
  } catch {}
  return { manifest: manNext, perfisOk };
}

async function alignAccount(nome, { persist = true, source = 'align' } = {}) {
  const got = await readAccount(nome);
  if (!got.base) return { ok: false, error: 'not_found', nome: String(nome || '') };
  const presets = loadPresets();
  const policy = loadPolicy();
  const byId = indexPresets(presets);
  const need = needsRealign(got.base, byId);
  if (!need.yes) {
    return {
      ok: true,
      changed: false,
      nome: got.nome,
      reason: need.reason,
      fromId: String(got.base.uaPresetId || ''),
      toId: String(got.base.uaPresetId || ''),
      manifest: got.man || got.base
    };
  }
  const counts = usageCounts(fileStore.loadPerfisJson() || [], presets);
  const picked = pickReplacement(got.base, presets, policy, counts);
  if (!picked.preset) {
    return {
      ok: false,
      needsRealign: true,
      error: picked.reason || 'no_replacement',
      nome: got.nome,
      fromId: String(got.base.uaPresetId || ''),
      reason: need.reason
    };
  }
  const patched = applyViewportOntoRecord(got.base, picked.preset);
  if (persist) {
    try {
      const wrote = await persistAccount(got.nome, patched, source);
      return {
        ok: true,
        changed: true,
        nome: got.nome,
        reason: need.reason,
        pickReason: picked.reason,
        fromId: String(got.base.uaPresetId || ''),
        toId: String(picked.preset.id),
        viewport: patched.fp.viewport,
        dpr: patched.fp.dpr,
        hardwareConcurrency: patched.fp.hardwareConcurrency,
        uaKept: true,
        manifest: wrote.manifest || patched,
        perfisOk: wrote.perfisOk
      };
    } catch (e) {
      return {
        ok: false,
        needsRealign: true,
        error: (e && e.message) || String(e),
        nome: got.nome,
        fromId: String(got.base.uaPresetId || ''),
        reason: need.reason
      };
    }
  }
  return {
    ok: true,
    changed: true,
    dryRun: true,
    nome: got.nome,
    reason: need.reason,
    pickReason: picked.reason,
    fromId: String(got.base.uaPresetId || ''),
    toId: String(picked.preset.id),
    viewport: patched.fp.viewport,
    dpr: patched.fp.dpr,
    hardwareConcurrency: patched.fp.hardwareConcurrency,
    uaKept: true,
    manifest: patched
  };
}

async function alignAll({ inShard = null, persist = true, source = 'command', operator = '' } = {}) {
  const perfis = fileStore.loadPerfisJson() || [];
  const out = {
    ok: true,
    scanned: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    persist: persist === true,
    source: String(source || 'command').slice(0, 80),
    operator: String(operator || '').slice(0, 120) || null,
    changes: [],
    failures: []
  };
  for (const p of perfis) {
    const nome = p && p.nome ? String(p.nome).trim() : '';
    if (!nome) continue;
    if (typeof inShard === 'function' && !inShard(nome)) continue;
    out.scanned += 1;
    try {
      const r = await alignAccount(nome, { persist, source });
      if (r && r.ok && r.changed) {
        out.changed += 1;
        out.changes.push({
          nome,
          fromId: r.fromId || null,
          toId: r.toId || null,
          reason: r.reason || null,
          pickReason: r.pickReason || null
        });
      } else if (r && r.ok) {
        out.skipped += 1;
      } else {
        out.failed += 1;
        out.failures.push({ nome, error: (r && r.error) || 'align_failed' });
        out.ok = false;
      }
    } catch (e) {
      out.failed += 1;
      out.ok = false;
      out.failures.push({ nome, error: (e && e.message) || String(e) });
    }
  }
  if (out.failed > 0) out.error = 'partial_fail';
  return out;
}

async function mainCli() {
  const apply = process.argv.includes('--apply');
  const persist = apply;
  const r = await alignAll({ persist, source: apply ? 'cli_apply' : 'cli_dry_run' });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}

if (require.main === module) {
  mainCli().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = {
  HEAVY_MIN_WIDTH,
  HEAVY_MIN_HEIGHT,
  HEAVY_MIN_DPR,
  fpLooksHeavy,
  presetLooksHeavy,
  needsRealign,
  pickReplacement,
  alignAccount,
  alignAll,
  loadPresets,
  loadPolicy
};
