"use strict";

const fs = require("fs");
const path = require("path");

const DADOS_DIR = path.join(__dirname, "..", "dados");
const COUNTRY_ID_DEFAULT = "br";

const COUNTRY_DATA = Object.freeze({
  br: Object.freeze({
    id: "br",
    citiesFile: "cidades.json",
    coordsFile: "cidades_coords.json",
    locationsFile: "localizacoes.json",
    allowVehicles: true
  }),
  us: Object.freeze({
    id: "us",
    citiesFile: "cidadesEUA.json",
    coordsFile: "cidadesEUA_coords.json",
    locationsFile: "localizacoesEUA.json",
    allowVehicles: false
  })
});

function normalizeCountryId(id) {
  try {
    const sc = require("./serverConfig.js");
    if (typeof sc.normalizeCountryId === "function") return sc.normalizeCountryId(id);
  } catch {}
  const key = String(id || "").trim().toLowerCase();
  if (key === "eua" || key === "usa" || key === "us") return "us";
  return COUNTRY_ID_DEFAULT;
}

function effectiveCountryId(explicit) {
  if (explicit != null && String(explicit).trim()) return normalizeCountryId(explicit);
  try {
    const sc = require("./serverConfig.js");
    const pack = typeof sc.readCountryPackEffective === "function"
      ? sc.readCountryPackEffective()
      : null;
    return normalizeCountryId(pack && pack.id);
  } catch {
    return COUNTRY_ID_DEFAULT;
  }
}

function resolveDataPack(explicit) {
  const id = effectiveCountryId(explicit);
  return COUNTRY_DATA[id] || COUNTRY_DATA[COUNTRY_ID_DEFAULT];
}

function safeDadosFile(fileName, fallbackName) {
  const base = path.basename(String(fileName || "").trim());
  if (!base || base !== String(fileName || "").trim() || base.indexOf("..") >= 0) {
    return path.join(DADOS_DIR, fallbackName);
  }
  return path.join(DADOS_DIR, base);
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function cityNormKey(value) {
  let s = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  s = s.replace(/\s*\([a-z]{2}\)\s*$/i, "").trim();
  return s;
}

function cityLookupKeys(value) {
  const raw = String(value || "").trim();
  const bare = raw.replace(/\s*\([a-z]{2}\)\s*$/i, "").trim();
  const out = [];
  const seen = new Set();
  for (const candidate of [raw, bare]) {
    const key = cityNormKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function parseCityNames(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const name = typeof row === "string"
      ? row.trim()
      : (row && typeof row === "object")
        ? String(row.nome || row.label || row.id || "").trim()
        : "";
    if (!name) continue;
    const key = cityNormKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function listCities({ countryId } = {}) {
  const pack = resolveDataPack(countryId);
  const file = safeDadosFile(pack.citiesFile, COUNTRY_DATA[COUNTRY_ID_DEFAULT].citiesFile);
  return parseCityNames(readJsonSafe(file, []));
}

function findCanonicalCity(cidade, { countryId } = {}) {
  const want = cityNormKey(cidade);
  if (!want) return "";
  const cities = listCities({ countryId });
  for (const name of cities) {
    if (cityNormKey(name) === want) return name;
  }
  return "";
}

function isKnownCity(cidade, { countryId } = {}) {
  return !!findCanonicalCity(cidade, { countryId });
}

function getCoords(cidade, { countryId } = {}) {
  try {
    const want = cityNormKey(cidade);
    if (!want) return null;
    const pack = resolveDataPack(countryId);
    const file = safeDadosFile(pack.coordsFile, COUNTRY_DATA[COUNTRY_ID_DEFAULT].coordsFile);
    const arr = readJsonSafe(file, []);
    if (!Array.isArray(arr)) return null;
    for (const ent of arr) {
      if (!ent || typeof ent !== "object") continue;
      const nome = cityNormKey(ent.nome || ent.label || ent.id);
      if (nome !== want) continue;
      const latitude = Number(ent.lat || ent.latitude);
      const longitude = Number(ent.lon || ent.lng || ent.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      if (latitude === 0 && longitude === 0) return null;
      return {
        latitude,
        longitude,
        accuracy: Number(ent.accuracy || 30) || 30
      };
    }
    return null;
  } catch {
    return null;
  }
}

function dedupeLocations(arr, { exact = false } = {}) {
  const dedup = [];
  const seen = new Set();
  for (const loc of (Array.isArray(arr) ? arr : [])) {
    const text = String(loc == null ? "" : loc).replace(/\r/g, "").trim();
    if (!text) continue;
    const key = exact ? text : cityNormKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(text);
  }
  return dedup;
}

function normalizeNeighborhoodId(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseNeighborhoods(entries, { exact = false } = {}) {
  const out = [];
  const byId = new Map();
  for (const raw of (Array.isArray(entries) ? entries : [])) {
    if (!raw || typeof raw !== "object") continue;
    const name = String(raw.nome || raw.name || raw.bairro || raw.label || raw.id || raw.slug || "").trim();
    const id = normalizeNeighborhoodId(raw.id || raw.slug || raw.key || name);
    const locations = dedupeLocations(raw.localizacoes || raw.locations, { exact });
    if (!name || !id) continue;
    if (byId.has(id)) {
      const prev = byId.get(id);
      prev.locations = dedupeLocations(prev.locations.concat(locations), { exact });
      continue;
    }
    const row = { id, name, locations };
    byId.set(id, row);
    out.push(row);
  }
  return out;
}

function normalizeLocationCatalogEntry(rawEntry, fallbackCity, { exact = false } = {}) {
  const city = String(
    (rawEntry && (rawEntry.cidade || rawEntry.nome || rawEntry.name || rawEntry.label || rawEntry.id))
      || fallbackCity
      || ""
  ).trim();
  if (!city) return null;
  const neighborhoods = parseNeighborhoods(rawEntry && (rawEntry.bairros || rawEntry.neighborhoods), { exact });
  let locations = dedupeLocations(rawEntry && (rawEntry.localizacoes || rawEntry.locations), { exact });
  if (neighborhoods.length) {
    locations = dedupeLocations(locations.concat(neighborhoods.flatMap((row) => row.locations)), { exact });
  }
  const mappedKeys = new Set();
  for (const row of neighborhoods) {
    for (const loc of row.locations) mappedKeys.add(exact ? String(loc) : cityNormKey(loc));
  }
  const universalLocations = locations.filter((loc) => !mappedKeys.has(exact ? String(loc) : cityNormKey(loc)));
  const mappedNeighborhoodsCount = neighborhoods.reduce((sum, row) => sum + (row.locations.length > 0 ? 1 : 0), 0);
  const emptyNeighborhoodsCount = Math.max(0, neighborhoods.length - mappedNeighborhoodsCount);
  return {
    city,
    locations,
    neighborhoods,
    universalLocations,
    mappedNeighborhoodsCount,
    emptyNeighborhoodsCount,
    mappedLocationsCount: Math.max(0, locations.length - universalLocations.length),
    unmappedLocationsCount: universalLocations.length
  };
}

function getLocationCatalogEntry(cidade, { countryId } = {}) {
  const wantKeys = cityLookupKeys(cidade);
  if (!wantKeys.length) return null;
  const pack = resolveDataPack(countryId);
  const file = safeDadosFile(pack.locationsFile, COUNTRY_DATA[COUNTRY_ID_DEFAULT].locationsFile);
  const raw = readJsonSafe(file, null);
  if (!raw) return null;
  const exactUs = String(pack && pack.id || "") === "us";
  if (Array.isArray(raw)) {
    const hit = raw.find((ent) => wantKeys.includes(cityNormKey(ent && (ent.cidade || ent.nome || ent.name || ent.id))));
    return hit ? normalizeLocationCatalogEntry(hit, "", { exact: exactUs }) : null;
  }
  if (raw && typeof raw === "object") {
    const key = Object.keys(raw).find((entryKey) => {
      const keyNorm = cityNormKey(entryKey);
      if (wantKeys.includes(keyNorm)) return true;
      const value = raw[entryKey];
      if (value && typeof value === "object") {
        const cityLabel = cityNormKey(value.cidade || value.nome || value.name || value.label || value.id);
        if (wantKeys.includes(cityLabel)) return true;
      }
      return false;
    });
    if (!key) return null;
    const value = raw[key];
    return Array.isArray(value)
      ? normalizeLocationCatalogEntry({ cidade: key, localizacoes: value }, key, { exact: exactUs })
      : normalizeLocationCatalogEntry({ cidade: key, ...(value && typeof value === "object" ? value : {}) }, key, { exact: exactUs });
  }
  return null;
}

function listLocations(cidade, { countryId } = {}) {
  const entry = getLocationCatalogEntry(cidade, { countryId });
  return entry && Array.isArray(entry.locations) ? entry.locations.slice() : [];
}

function listNeighborhoods(cidade, { countryId } = {}) {
  const entry = getLocationCatalogEntry(cidade, { countryId });
  return entry && Array.isArray(entry.neighborhoods)
    ? entry.neighborhoods.map((row) => ({
        id: row.id,
        name: row.name,
        locations: Array.isArray(row.locations) ? row.locations.slice() : []
      }))
    : [];
}

function listLocationsByNeighborhood(cidade, neighborhoodId, { countryId } = {}) {
  const entry = getLocationCatalogEntry(cidade, { countryId });
  if (!entry || !Array.isArray(entry.neighborhoods)) return [];
  const want = normalizeNeighborhoodId(neighborhoodId);
  if (!want) return [];
  const hit = entry.neighborhoods.find((row) => normalizeNeighborhoodId(row.id) === want);
  return hit && Array.isArray(hit.locations) ? hit.locations.slice() : [];
}

function countCitiesInUse(cities, perfis, extraTaken) {
  const counts = new Map();
  for (const name of cities) counts.set(cityNormKey(name), 0);
  const bump = (cidade) => {
    const key = cityNormKey(cidade);
    if (!counts.has(key)) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  for (const row of (Array.isArray(perfis) ? perfis : [])) {
    bump(row && row.cidade);
  }
  for (const row of (Array.isArray(extraTaken) ? extraTaken : [])) {
    bump(typeof row === "string" ? row : (row && row.cidade));
  }
  return counts;
}

function pickLeastUsedFromList(cities, { perfis, extraTaken } = {}) {
  const pool = [];
  const seen = new Set();
  for (const raw of (Array.isArray(cities) ? cities : [])) {
    const name = String(raw || "").trim();
    const key = cityNormKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    pool.push(name);
  }
  if (!pool.length) return "";
  const counts = countCitiesInUse(pool, perfis, extraTaken);
  let best = pool[0];
  let bestCount = Number(counts.get(cityNormKey(best)) || 0);
  for (const name of pool) {
    const n = Number(counts.get(cityNormKey(name)) || 0);
    if (n < bestCount) {
      best = name;
      bestCount = n;
    }
  }
  return best;
}

function pickLeastUsedCity({ countryId, cities, perfis, extraTaken } = {}) {
  const pool = Array.isArray(cities) ? cities : listCities({ countryId });
  return pickLeastUsedFromList(pool, { perfis, extraTaken });
}

function sanitizeWorkingCities(list, countryId) {
  const id = effectiveCountryId(countryId);
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const canonical = findCanonicalCity(raw, { countryId: id });
    if (!canonical) continue;
    const coords = getCoords(canonical, { countryId: id });
    if (!coords || !coords.latitude || !coords.longitude) continue;
    const key = cityNormKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

function listWorkingCitiesFromPersistedConfig({ countryId } = {}) {
  const id = effectiveCountryId(countryId);
  let raw = null;
  try {
    const sc = require("./serverConfig.js");
    raw = typeof sc.readServerConfigRaw === "function" ? sc.readServerConfigRaw() : null;
  } catch {
    raw = null;
  }
  if (!raw || typeof raw !== "object") return [];
  const extras = raw.robe && raw.robe.cidadesExtrasGlobais;
  return sanitizeWorkingCities(extras, id);
}

function resolveCityForNewAccount(cidadeHint, { countryId, perfis, extras } = {}) {
  const id = effectiveCountryId(countryId);
  const hint = String(cidadeHint || "").trim();
  const working = extras !== undefined
    ? sanitizeWorkingCities(extras, id)
    : listWorkingCitiesFromPersistedConfig({ countryId: id });
  if (!working.length) {
    return {
      ok: false,
      error: "servidor_sem_cidades_de_trabalho",
      country: id,
      from: hint || null,
      ignoredHint: true
    };
  }
  const picked = pickLeastUsedFromList(working, { perfis });
  if (!picked) {
    return {
      ok: false,
      error: "servidor_sem_cidades_de_trabalho",
      country: id,
      from: hint || null,
      ignoredHint: true
    };
  }
  const coords = getCoords(picked, { countryId: id });
  if (!coords || !coords.latitude || !coords.longitude) {
    return {
      ok: false,
      error: "cidade_sem_coordenadas",
      cidade: picked,
      country: id,
      from: hint || null,
      ignoredHint: true
    };
  }
  return {
    ok: true,
    cidade: picked,
    remapped: true,
    from: hint || null,
    ignoredHint: !hint || cityNormKey(hint) !== cityNormKey(picked),
    country: id,
    pool: working.slice()
  };
}

function allowsVehicles({ countryId } = {}) {
  return resolveDataPack(countryId).allowVehicles === true;
}

function describeDataPack({ countryId } = {}) {
  const pack = resolveDataPack(countryId);
  return {
    id: pack.id,
    citiesFile: pack.citiesFile,
    coordsFile: pack.coordsFile,
    locationsFile: pack.locationsFile,
    allowVehicles: pack.allowVehicles === true
  };
}

module.exports = {
  COUNTRY_DATA,
  normalizeCountryId,
  effectiveCountryId,
  resolveDataPack,
  cityNormKey,
  normalizeNeighborhoodId,
  listCities,
  findCanonicalCity,
  isKnownCity,
  getCoords,
  getLocationCatalogEntry,
  listLocations,
  listNeighborhoods,
  listLocationsByNeighborhood,
  pickLeastUsedFromList,
  pickLeastUsedCity,
  sanitizeWorkingCities,
  listWorkingCitiesFromPersistedConfig,
  resolveCityForNewAccount,
  allowsVehicles,
  describeDataPack
};
