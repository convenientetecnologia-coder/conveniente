// scripts/locais.js
'use strict';

const fs = require('fs');
const path = require('path');
const utils = require('./utils.js');

// Arquivos de dados
const DADOS_DIR = path.join(__dirname, '..', 'dados');
const CYCLE_FILE = path.join(DADOS_DIR, 'locais_ciclo.json');
const LOCALIZACOES_FILE = path.join(DADOS_DIR, 'localizacoes.json');

// Serialização simples para evitar corridas entre chamadas
let _queue = Promise.resolve();
function _serialize(fn) {
  const next = _queue.then(() => fn());
  _queue = next.catch(() => {}); // não interrompe cadeia
  return next;
}

// IO helpers
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    try { fs.unlinkSync(file); } catch {}
    try { fs.renameSync(tmp, file); }
    catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch {}
    }
    return true;
  } catch { return false; }
}
function ensureCycleFile() {
  if (!fs.existsSync(CYCLE_FILE)) writeJsonAtomic(CYCLE_FILE, {});
}
function loadCycle() {
  ensureCycleFile();
  const idx = readJsonSafe(CYCLE_FILE, {});
  // Sanitize
  for (const k of Object.keys(idx)) {
    const rec = idx[k];
    if (!rec || typeof rec !== 'object') { delete idx[k]; continue; }
    if (!Array.isArray(rec.order)) rec.order = [];
    if (!Array.isArray(rec.used)) rec.used = [];
    if (!rec.invalid || typeof rec.invalid !== 'object') rec.invalid = {};
  }
  return idx;
}
function saveCycle(idx) {
  return writeJsonAtomic(CYCLE_FILE, idx);
}

// Carrega lista de localizações da cidade a partir de dados/localizacoes.json
function listLocsFromSource(cidade) {
  const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  try {
    const raw = readJsonSafe(LOCALIZACOES_FILE, null);
    if (!raw) return [];

    // Formato array de objetos: [{cidade, localizacoes:[...]}]
    if (Array.isArray(raw)) {
      const hit = raw.find(ent =>
        norm(ent?.cidade) === norm(cidade) ||
        norm(ent?.nome) === norm(cidade) ||
        norm(ent?.id) === norm(cidade)
      );
      if (!hit || !Array.isArray(hit.localizacoes)) return [];
      const dedup = [];
      const seen = new Set();
      for (const loc of hit.localizacoes) {
        const key = norm(loc);
        if (!seen.has(key) && String(loc || '').trim()) {
          seen.add(key);
          dedup.push(String(loc));
        }
      }
      return dedup;
    }

    // Formato mapa { "Cidade": [locs], ... }
    const key = Object.keys(raw).find(k => norm(k) === norm(cidade));
    const arr = key ? raw[key] : null;
    if (!Array.isArray(arr)) return [];
    const dedup = [];
    const seen = new Set();
    for (const loc of arr) {
      const kk = norm(loc);
      if (!seen.has(kk) && String(loc || '').trim()) {
        seen.add(kk);
        dedup.push(String(loc));
      }
    }
    return dedup;

  } catch {
    return [];
  }
}

// Embaralha array (Fisher-Yates)
function shuffle(arr) {
  const a = arr.slice(0);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// IMPORTANTE: ao reconstruir o ciclo, reincluímos TODAS as localizações e ZERAMOS invalid.
// Ou seja, inválidas só valem para o ciclo corrente; no próximo ciclo elas voltam a ser tentadas.
function rebuildCycleForCity(idx, cityKey, allLocs) {
  const order = shuffle(allLocs);
  idx[cityKey] = {
    order,
    used: [],
    invalid: {} // zera as inválidas a cada novo ciclo
  };
  return idx[cityKey];
}

/**
  Sugere a PRÓXIMA localização para a cidade (não avança o ciclo ainda).
  Garante que todas sejam percorridas 1x antes de repetir (ordem aleatória a cada ciclo).
  Localizações marcadas como inválidas são excluídas apenas no ciclo atual.
  @param {string} cidade
  @returns {Promise<{ok:true, cidadeKey:string, location:string}|{ok:false,error:string}>}
*/
async function nextLocationForCity(cidade) {
  return _serialize(async () => {
    const cityKey = utils.slugify(cidade || '');
    if (!cityKey) return { ok: false, error: 'cidade_invalida' };

    const cycle = loadCycle();
    let rec = cycle[cityKey] || { order: [], used: [], invalid: {} };

    // Lista oficial da cidade
    const sourceLocs = listLocsFromSource(cidade);
    if (!sourceLocs.length) return { ok: false, error: 'sem_localizacoes_na_fonte' };

    // Necessita reconstruir?
    const currentSet = new Set(rec.order || []);
    const expectedSet = new Set(sourceLocs);
    const needRebuild = (
      rec.order.length === 0 ||
      rec.used.length >= rec.order.length ||
      expectedSet.size !== currentSet.size ||
      [...expectedSet].some(l => !currentSet.has(l))
    );

    if (needRebuild) {
      rec = rebuildCycleForCity(cycle, cityKey, sourceLocs);
      saveCycle(cycle);
    } else {
      // Sanitize usados que não estão no order atual
      rec.used = (rec.used || []).filter(u => rec.order.includes(u));
      cycle[cityKey] = rec;
      saveCycle(cycle);
    }

    // Remove da lista de candidatos as que foram invalidadas neste ciclo
    const invalidSet = new Set(Object.keys(rec.invalid || {}));
    const candidates = rec.order.filter(l => !rec.used.includes(l) && !invalidSet.has(l));

    if (!candidates.length) {
      // Nada disponível (tudo usado/inválido neste ciclo) -> inicia novo ciclo incluindo todas
      rec = rebuildCycleForCity(cycle, cityKey, sourceLocs);
      saveCycle(cycle);
      if (!rec.order.length) return { ok: false, error: 'sem_localizacoes_usaveis' };
      return { ok: true, cidadeKey: cityKey, location: rec.order[0] };
    }

    return { ok: true, cidadeKey: cityKey, location: candidates[0] };
  });
}

/**
  Marca a localização como utilizada (avança 1 passo no ciclo).
  Se todas foram usadas, prepara ordem nova (embaralhada) para o próximo ciclo (reinclui inválidas).
  @param {string} cidade
  @param {string} location
*/
async function confirmUsed(cidade, location) {
  return _serialize(async () => {
    const cityKey = utils.slugify(cidade || '');
    if (!cityKey || !location) return { ok: false, error: 'args_invalidos' };

    const cycle = loadCycle();
    let rec = cycle[cityKey] || { order: [], used: [], invalid: {} };

    const sourceLocs = listLocsFromSource(cidade);
    if (!sourceLocs.length) return { ok: false, error: 'sem_localizacoes_na_fonte' };

    // Se a ordem está vazia ou mudou a fonte, reconstrói
    const currentSet = new Set(rec.order || []);
    const expectedSet = new Set(sourceLocs);
    if (rec.order.length === 0 || expectedSet.size !== currentSet.size || [...expectedSet].some(l => !currentSet.has(l))) {
      rec = rebuildCycleForCity(cycle, cityKey, sourceLocs);
    }

    if (!Array.isArray(rec.used)) rec.used = [];
    if (rec.order.includes(location) && !rec.used.includes(location)) rec.used.push(location);

    // Final do ciclo? Inicia novo ciclo (reinclui todas, zera invalid)
    const allUsed = rec.used.length >= rec.order.length;
    if (allUsed) {
      rec = rebuildCycleForCity(cycle, cityKey, sourceLocs);
    }

    cycle[cityKey] = rec;
    saveCycle(cycle);
    return { ok: true };
  });
}

/**
  Marca uma localização como inválida (remove somente do ciclo atual).
  Útil quando o FB não encontra nada para aquele termo/nome.
  @param {string} cidade
  @param {string} location
  @param {string} [reason]
*/
async function reportInvalid(cidade, location, reason) {
  return _serialize(async () => {
    const cityKey = utils.slugify(cidade || '');
    if (!cityKey || !location) return { ok: false, error: 'args_invalidos' };

    const cycle = loadCycle();
    const rec = cycle[cityKey] || { order: [], used: [], invalid: {} };
    rec.invalid = rec.invalid || {};
    rec.invalid[location] = { reason: reason || 'not_valid', when: Date.now() };

    // Remove da ordem/used se estiver — invalida só neste ciclo
    rec.order = (rec.order || []).filter(l => l !== location);
    rec.used = (rec.used || []).filter(l => l !== location);

    cycle[cityKey] = rec;
    saveCycle(cycle);
    return { ok: true };
  });
}

/**
  Snapshot para depuração/monitoramento.
*/
async function snapshot(cidade) {
  return _serialize(async () => {
    const cityKey = utils.slugify(cidade || '');
    const cycle = loadCycle();
    if (!cityKey) return { ok: true, all: cycle };
    return { ok: true, cityKey, data: cycle[cityKey] || null };
  });
}

module.exports = {
  nextLocationForCity,
  confirmUsed,
  reportInvalid,
  snapshot
};