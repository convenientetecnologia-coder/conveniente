#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");

const ROOT = path.resolve(__dirname, "..");
const BR_CATALOG_FILE = path.join(ROOT, "dados", "localizacoes.json");
const US_CATALOG_FILE = path.join(ROOT, "dados", "localizacoesEUA.json");
const OVERRIDES_FILE = path.join(ROOT, "dados", "locationNeighborhoodOverrides.json");
const GROUPS_BR_FILE = "C:/notificador/gruposids.json";
const GROUPS_US_FILE = "C:/notificador/gruposidsEua.json";
const BETTER_SQLITE3_PATH = "C:/sitechatbot/node_modules/better-sqlite3";
const IBGE_GPKG_URL = "https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022/Agregados_por_Setores_Censitarios/malha_com_atributos/bairros/gpkg/BR/BR_bairros_CD2022.gpkg";
const IBGE_GPKG_CACHE = path.join(os.tmpdir(), "BR_bairros_CD2022.gpkg");
const UF_CODE_TO_SIGLA = Object.freeze({
  "11": "RO",
  "12": "AC",
  "13": "AM",
  "14": "RR",
  "15": "PA",
  "16": "AP",
  "17": "TO",
  "21": "MA",
  "22": "PI",
  "23": "CE",
  "24": "RN",
  "25": "PB",
  "26": "PE",
  "27": "AL",
  "28": "SE",
  "29": "BA",
  "31": "MG",
  "32": "ES",
  "33": "RJ",
  "35": "SP",
  "41": "PR",
  "42": "SC",
  "43": "RS",
  "50": "MS",
  "51": "MT",
  "52": "GO",
  "53": "DF"
});
const GENERIC_TAIL_TOKENS = new Set([
  "ac", "al", "am", "ana", "anap", "ara", "ba", "bah", "belo", "br", "brazil",
  "camp", "cam", "cas", "cata", "ce", "con", "es", "for", "go", "gra", "ita",
  "jan", "ma", "mg", "min", "nov", "pa", "par", "pb", "pe", "piaui", "pr",
  "rec", "ri", "rio", "ro", "rr", "s", "sa", "san", "sao", "sc", "se", "sergi",
  "sp", "sul", "v", "velho"
]);

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
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

function normalizeMatcher(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[()]/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function safeReadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function dedupeExactLocations(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw == null ? "" : raw).replace(/\r/g, "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function preserveFlatLocations(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw == null ? "" : raw).replace(/\r/g, "");
    if (!text) continue;
    out.push(text);
  }
  return out;
}

function parseGroupsObject(raw0) {
  return (raw0 && typeof raw0 === "object" && Array.isArray(raw0.groups))
    ? Object.fromEntries(
        raw0.groups
          .map((g) => [String(g.groupId || "").trim(), Array.isArray(g.cities) ? g.cities : []])
          .filter(([k]) => !!k)
      )
    : (raw0 || {});
}

function parseCityUfLabel(label) {
  const raw = String(label || "").trim();
  const m = raw.match(/^(.*?)(?:\s*\(([A-Z]{2})\))?$/i);
  const city = String((m && m[1]) || raw).trim();
  const uf = String((m && m[2]) || "").trim().toUpperCase();
  return { raw, city, uf };
}

function normalizeUfValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^[A-Z]{2}$/i.test(raw)) return raw.toUpperCase();
  const digits = raw.replace(/\D/g, "");
  if (digits && UF_CODE_TO_SIGLA[digits]) return UF_CODE_TO_SIGLA[digits];
  return raw.toUpperCase();
}

function loadPrimaryGroups(file) {
  const raw = parseGroupsObject(safeReadJson(file, {}));
  const out = new Map();
  for (const arrRaw of Object.values(raw)) {
    const arr = Array.isArray(arrRaw) ? arrRaw.map((row) => String(row || "").trim()).filter(Boolean) : [];
    if (!arr.length) continue;
    const primary = parseCityUfLabel(arr[0]);
    if (!primary.city) continue;
    out.set(normalizeKey(primary.city), {
      primary: arr[0],
      members: arr
    });
  }
  return out;
}

async function ensureIbgeGpkg() {
  if (fs.existsSync(IBGE_GPKG_CACHE) && fs.statSync(IBGE_GPKG_CACHE).size > 1024 * 1024) {
    return IBGE_GPKG_CACHE;
  }
  const res = await fetch(IBGE_GPKG_URL);
  if (!res.ok || !res.body) {
    throw new Error(`ibge_download_failed:${res.status}`);
  }
  const tmpFile = `${IBGE_GPKG_CACHE}.tmp-${Date.now()}`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpFile));
  fs.renameSync(tmpFile, IBGE_GPKG_CACHE);
  return IBGE_GPKG_CACHE;
}

function quoteIdent(name) {
  return `"${String(name || "").replace(/"/g, "\"\"")}"`;
}

function pickColumn(cols, candidates) {
  const byNorm = new Map(
    cols.map((row) => [normalizeKey(row.name || row.column || row.column_name || ""), String(row.name || "")])
  );
  for (const candidate of candidates) {
    const want = normalizeKey(candidate);
    if (byNorm.has(want)) return byNorm.get(want);
  }
  for (const row of cols) {
    const key = normalizeKey(row.name || "");
    if (candidates.some((candidate) => key.includes(normalizeKey(candidate)))) {
      return String(row.name || "");
    }
  }
  return "";
}

function loadIbgeNeighborhoodIndex(gpkgPath) {
  const Database = require(BETTER_SQLITE3_PATH);
  const db = new Database(gpkgPath, { readonly: true });
  const tableRow = db
    .prepare("select table_name, data_type from gpkg_contents order by table_name")
    .all()
    .find((row) => String(row.data_type || "").trim().toLowerCase() === "features")
    || db.prepare("select table_name from gpkg_contents order by table_name limit 1").get();
  if (!tableRow || !tableRow.table_name) throw new Error("ibge_table_missing");
  const tableName = String(tableRow.table_name);
  const cols = db.prepare(`pragma table_info(${quoteIdent(tableName)})`).all();
  const bairroCol = pickColumn(cols, ["NM_BAIRRO", "BAIRRO"]);
  const municipioCol = pickColumn(cols, ["NM_MUN", "MUNICIPIO", "NOME_MUNICIPIO"]);
  const ufCol = pickColumn(cols, ["SIGLA_UF", "SG_UF", "CD_UF", "UF"]);
  if (!bairroCol || !municipioCol || !ufCol) {
    throw new Error(`ibge_columns_missing:${JSON.stringify({ bairroCol, municipioCol, ufCol })}`);
  }
  const sql = [
    `select ${quoteIdent(bairroCol)} as bairro,`,
    `${quoteIdent(municipioCol)} as municipio,`,
    `${quoteIdent(ufCol)} as uf`,
    `from ${quoteIdent(tableName)}`,
    `where ${quoteIdent(bairroCol)} is not null and trim(${quoteIdent(bairroCol)}) <> ''`,
    `and ${quoteIdent(municipioCol)} is not null and trim(${quoteIdent(municipioCol)}) <> ''`,
    `and ${quoteIdent(ufCol)} is not null and trim(${quoteIdent(ufCol)}) <> ''`
  ].join(" ");
  const rows = db.prepare(sql).all();
  const out = new Map();
  for (const row of rows) {
    const city = String(row.municipio || "").trim();
    const uf = normalizeUfValue(row.uf);
    const bairro = String(row.bairro || "").trim();
    if (!city || !uf || !bairro) continue;
    const key = `${normalizeKey(city)}|${uf}`;
    if (!out.has(key)) out.set(key, new Map());
    const bucket = out.get(key);
    const bairroKey = normalizeKey(bairro);
    if (!bairroKey || bucket.has(bairroKey)) continue;
    bucket.set(bairroKey, bairro);
  }
  return out;
}

function readCatalogEntries(file) {
  if (String(process.env.USE_HEAD_BASE || "").trim() === "1") {
    try {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const raw = cp.execSync(`git show HEAD:${rel}`, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const raw = safeReadJson(file, []);
  return Array.isArray(raw) ? raw : [];
}

function readOverrides() {
  const raw = safeReadJson(OVERRIDES_FILE, { br: {}, us: {} });
  return {
    br: raw && typeof raw.br === "object" && raw.br ? raw.br : {},
    us: raw && typeof raw.us === "object" && raw.us ? raw.us : {}
  };
}

function getLocationOverrideMap(cityOverrides) {
  if (!cityOverrides || typeof cityOverrides !== "object") return {};
  if (cityOverrides.locations && typeof cityOverrides.locations === "object") return cityOverrides.locations;
  return cityOverrides;
}

function existingNeighborhoodRows(entry) {
  return Array.isArray(entry && entry.bairros)
    ? entry.bairros.map((row) => ({
        id: normalizeNeighborhoodId(row && (row.id || row.slug || row.nome || row.name)),
        nome: String(row && (row.nome || row.name || row.bairro || row.label || row.id || row.slug) || "").trim(),
        localizacoes: dedupeExactLocations(row && (row.localizacoes || row.locations)),
        sourceCity: String(row && (row.sourceCity || row.source_city || "") || "").trim() || null,
        baseName: String(row && (row.baseName || row.base_name || row.nome || row.name || "") || "").trim() || null,
        kind: String(row && (row.kind || "") || "").trim() || null
      })).filter((row) => row.id && row.nome)
    : [];
}

function isCenterLikeName(value) {
  const key = normalizeMatcher(value);
  return key === "centro" || key === "centro historico" || key.startsWith("centro ");
}

function buildBrGeneratedNeighborhoods(entry, groupsByPrimary, ibgeIndex) {
  const primaryKey = normalizeKey(entry && entry.cidade);
  const group = groupsByPrimary.get(primaryKey);
  const members = group && Array.isArray(group.members) ? group.members : [];
  const out = [];
  const seenCities = new Set();
  for (const memberLabel of members) {
    const parsed = parseCityUfLabel(memberLabel);
    if (!parsed.city || !parsed.uf) continue;
    const memberKey = `${normalizeKey(parsed.city)}|${parsed.uf}`;
    if (seenCities.has(memberKey)) continue;
    seenCities.add(memberKey);
    const bucket = ibgeIndex.get(memberKey);
    if (!bucket) continue;
    const isPrimaryCity = normalizeKey(parsed.city) === primaryKey;
    for (const bairro of bucket.values()) {
      const nome = isPrimaryCity ? bairro : `${bairro} (${parsed.city})`;
      const id = normalizeNeighborhoodId(isPrimaryCity ? bairro : `${bairro} ${parsed.city}`);
      if (!id || !nome) continue;
      out.push({
        id,
        nome,
        localizacoes: [],
        sourceCity: parsed.city,
        baseName: bairro,
        kind: "neighborhood"
      });
    }
  }
  return out;
}

function buildBrCityGeneralRows(entry, groupsByPrimary, generatedRows) {
  const primaryKey = normalizeKey(entry && entry.cidade);
  const group = groupsByPrimary.get(primaryKey);
  const members = group && Array.isArray(group.members) ? group.members : [];
  const out = [];
  const seen = new Set();
  for (const memberLabel of members) {
    const parsed = parseCityUfLabel(memberLabel);
    if (!parsed.city) continue;
    const cityKey = normalizeKey(parsed.city);
    if (seen.has(cityKey)) continue;
    seen.add(cityKey);
    const rowsForCity = generatedRows.filter((row) => normalizeKey(row.sourceCity || "") === cityKey);
    const explicitCenter = rowsForCity.find((row) => {
      const base = normalizeKey(row.baseName || row.nome);
      return base === "centro" || base === "centro historico";
    });
    if (explicitCenter) continue;
    const isPrimaryCity = cityKey === primaryKey;
    const id = normalizeNeighborhoodId(isPrimaryCity ? "centro" : `centro ${parsed.city}`);
    if (!id) continue;
    out.push({
      id,
      nome: isPrimaryCity ? "Centro" : `Centro (${parsed.city})`,
      localizacoes: [],
      sourceCity: parsed.city,
      baseName: "Centro",
      kind: "city_center"
    });
  }
  return out;
}

function buildUsGeneratedNeighborhoods(entry, groupsByPrimary) {
  const primaryKey = normalizeKey(entry && entry.cidade);
  const group = groupsByPrimary.get(primaryKey);
  const members = group && Array.isArray(group.members) ? group.members : [];
  const out = [];
  const seen = new Set();
  for (let i = 1; i < members.length; i += 1) {
    const parsed = parseCityUfLabel(members[i]);
    const city = parsed.city;
    if (!city) continue;
    const nome = parsed.uf ? `${city} (${parsed.uf})` : city;
    const id = normalizeNeighborhoodId(nome);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      nome,
      localizacoes: [],
      sourceCity: city,
      baseName: city,
      kind: "city_or_neighborhood"
    });
  }
  return out;
}

function mergeNeighborhoods(existingRows, generatedRows) {
  const out = [];
  const byId = new Map();
  const upsert = (row, preferExistingName) => {
    if (!row || !row.id || !row.nome) return;
    if (byId.has(row.id)) {
      const prev = byId.get(row.id);
      prev.localizacoes = dedupeExactLocations(prev.localizacoes.concat(row.localizacoes || []));
      if (!preferExistingName && row.nome) prev.nome = row.nome;
      if (!prev.sourceCity && row.sourceCity) prev.sourceCity = row.sourceCity;
      if (!prev.baseName && row.baseName) prev.baseName = row.baseName;
      if (!prev.kind && row.kind) prev.kind = row.kind;
      return;
    }
    const next = {
      id: row.id,
      nome: row.nome,
      localizacoes: dedupeExactLocations(row.localizacoes || []),
      sourceCity: row.sourceCity || null,
      baseName: row.baseName || row.nome,
      kind: row.kind || null
    };
    byId.set(next.id, next);
    out.push(next);
  };
  for (const row of existingRows) upsert(row, true);
  for (const row of generatedRows) upsert(row, false);
  return out;
}

function buildNeighborhoodCandidateKeys(row, primaryCity) {
  const baseName = String(row.baseName || row.nome || "").trim();
  const sourceCity = String(row.sourceCity || "").trim();
  const out = new Set([
    normalizeMatcher(baseName),
    normalizeMatcher(row.nome),
    normalizeMatcher(`${baseName} ${sourceCity}`),
    normalizeMatcher(`${baseName}, ${sourceCity}`),
    normalizeMatcher(`${baseName} ${primaryCity}`)
  ]);
  if ((row.kind === "city_center" || isCenterLikeName(baseName)) && sourceCity) {
    out.add(normalizeMatcher(sourceCity));
  }
  return Array.from(out).filter(Boolean);
}

function buildLocationMatchKeys(location) {
  const raw = String(location || "").trim();
  const beforeComma = raw.split(",")[0] ? String(raw.split(",")[0]).trim() : "";
  const withoutParens = raw.replace(/\([^)]*\)/g, " ").trim();
  const keys = new Set();
  [raw, beforeComma, withoutParens].forEach((candidate) => {
    const key = normalizeMatcher(candidate);
    if (!key) return;
    keys.add(key);
    const toks = key.split(" ").filter(Boolean);
    while (toks.length > 1 && toks[toks.length - 1].length <= 5) {
      toks.pop();
      const trimmed = toks.join(" ");
      if (trimmed) keys.add(trimmed);
    }
  });
  return Array.from(keys);
}

function tokenPrefixMatch(sampleKey, candidateKey) {
  const a = String(sampleKey || "").split(" ").filter(Boolean);
  const b = String(candidateKey || "").split(" ").filter(Boolean);
  if (!a.length || a.length !== b.length) return false;
  return a.every((token, idx) => token.length >= 3 && b[idx].startsWith(token));
}

function wholePrefixMatch(sampleKey, candidateKey) {
  const sample = String(sampleKey || "").trim();
  const candidate = String(candidateKey || "").trim();
  if (!sample || !candidate || sample.length < 6) return false;
  return candidate.startsWith(sample);
}

function isGeneralCityLocation(location, cityName) {
  const cityKey = normalizeMatcher(cityName);
  if (!cityKey) return false;
  return buildLocationMatchKeys(location).some((sample) => sample === cityKey || tokenPrefixMatch(sample, cityKey));
}

function toDisplayTitle(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function deriveSyntheticNeighborhoodName(location) {
  const raw = String(location || "").replace(/\r/g, "").trim();
  if (!raw) return "";
  const beforeComma = raw.includes(",") ? String(raw.split(",")[0] || "").trim() : "";
  if (beforeComma) return beforeComma;
  const tokens = raw.split(/\s+/).filter(Boolean);
  while (tokens.length > 1) {
    const last = normalizeKey(tokens[tokens.length - 1]);
    if (last.length <= 5 || GENERIC_TAIL_TOKENS.has(last)) {
      tokens.pop();
      continue;
    }
    break;
  }
  const candidate = tokens.join(" ").trim();
  return toDisplayTitle(candidate || raw);
}

function assignRemainingLocationsByDerivedName(flatLocations, rows, primaryCity) {
  const mappedKeys = new Set();
  for (const row of rows) {
    for (const loc of Array.isArray(row.localizacoes) ? row.localizacoes : []) {
      mappedKeys.add(normalizeKey(loc));
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byName = new Map(rows.map((row) => [normalizeKey(row.nome), row]));
  for (const loc of flatLocations) {
    if (mappedKeys.has(normalizeKey(loc))) continue;
    const derivedName = deriveSyntheticNeighborhoodName(loc);
    if (!derivedName) continue;
    const existing = byName.get(normalizeKey(derivedName));
    if (existing) {
      if (!existing.localizacoes.includes(loc)) existing.localizacoes.push(loc);
      mappedKeys.add(normalizeKey(loc));
      continue;
    }
    const id = normalizeNeighborhoodId(derivedName);
    if (!id) continue;
    const row = {
      id,
      nome: derivedName,
      localizacoes: [loc],
      sourceCity: primaryCity,
      baseName: derivedName,
      kind: "derived_location"
    };
    if (!byId.has(id)) {
      rows.push(row);
      byId.set(id, row);
      byName.set(normalizeKey(row.nome), row);
      mappedKeys.add(normalizeKey(loc));
      continue;
    }
    const hit = byId.get(id);
    if (hit && !hit.localizacoes.includes(loc)) {
      hit.localizacoes.push(loc);
      mappedKeys.add(normalizeKey(loc));
    }
  }
}

function moveCityLevelLocationsToCenter(flatLocations, rows, primaryCity, groupsByPrimary) {
  const primaryKey = normalizeKey(primaryCity);
  const group = groupsByPrimary.get(primaryKey);
  const members = group && Array.isArray(group.members) ? group.members : [];
  const targets = new Map();
  for (const memberLabel of members) {
    const parsed = parseCityUfLabel(memberLabel);
    if (!parsed.city) continue;
    const cityKey = normalizeKey(parsed.city);
    if (targets.has(cityKey)) continue;
    const row = rows.find((item) => {
      if (normalizeKey(item.sourceCity || "") !== cityKey) return false;
      const base = normalizeKey(item.baseName || item.nome || "");
      return item.kind === "city_center" || base === "centro" || base === "centro historico";
    });
    if (row) targets.set(cityKey, row);
  }
  if (!targets.size) return;

  for (const loc of flatLocations) {
    let pickedRow = null;
    for (const memberLabel of members) {
      const parsed = parseCityUfLabel(memberLabel);
      if (!parsed.city) continue;
      const cityKey = normalizeKey(parsed.city);
      const targetRow = targets.get(cityKey);
      if (!targetRow) continue;
      if (isGeneralCityLocation(loc, parsed.city)) {
        pickedRow = targetRow;
        break;
      }
    }
    if (!pickedRow) continue;
    for (const row of rows) {
      if (!Array.isArray(row.localizacoes)) continue;
      row.localizacoes = row.localizacoes.filter((item) => item !== loc);
    }
    if (!pickedRow.localizacoes.includes(loc)) pickedRow.localizacoes.push(loc);
  }
}

function collapseDirectionalNeighborhoods(rows, primaryCity) {
  const directionalSuffixes = new Map([
    ["norte", "Norte"],
    ["sul", "Sul"],
    ["leste", "Leste"],
    ["oeste", "Oeste"],
    ["centro", "Centro"],
    ["central", "Central"],
    ["i", "I"],
    ["ii", "II"],
    ["iii", "III"],
    ["iv", "IV"],
    ["v", "V"],
    ["vi", "VI"],
    ["vii", "VII"],
    ["viii", "VIII"],
    ["ix", "IX"],
    ["x", "X"]
  ]);
  const groups = new Map();
  for (const row of rows) {
    const rawName = String(row.nome || "").trim();
    const sourceCity = String(row.sourceCity || primaryCity || "").trim();
    const nameNorm = normalizeMatcher(rawName);
    for (const suffixKey of directionalSuffixes.keys()) {
      const tail = ` ${suffixKey}`;
      if (!nameNorm.endsWith(tail)) continue;
      const baseNorm = nameNorm.slice(0, -tail.length).trim();
      if (!baseNorm) continue;
      const baseName = rawName.slice(0, rawName.length - directionalSuffixes.get(suffixKey).length).trim().replace(/\s+$/g, "");
      const groupKey = `${normalizeKey(sourceCity)}|${baseNorm}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ row, suffixKey, baseNorm, baseName, sourceCity });
      break;
    }
  }

  for (const bucket of groups.values()) {
    if (!Array.isArray(bucket) || !bucket.length) continue;
    const sourceCity = String(bucket[0].sourceCity || "").trim();
    const isPrimaryCity = normalizeKey(sourceCity || primaryCity) === normalizeKey(primaryCity);
    const preferredBaseName = String(bucket[0].baseName || "").trim();
    const parentName = isPrimaryCity ? preferredBaseName : `${preferredBaseName} (${sourceCity})`;
    const parentId = normalizeNeighborhoodId(isPrimaryCity ? preferredBaseName : `${preferredBaseName} ${sourceCity}`);
    if (!parentId || !parentName) continue;
    let parent = rows.find((row) => row.id === parentId || normalizeKey(row.nome) === normalizeKey(parentName)) || null;
    if (!parent && bucket.length < 2) continue;
    if (!parent) {
      parent = {
        id: parentId,
        nome: parentName,
        localizacoes: [],
        sourceCity,
        baseName: preferredBaseName,
        kind: "collapsed_directional"
      };
      rows.push(parent);
    }
    for (const item of bucket) {
      parent.localizacoes = dedupeExactLocations(parent.localizacoes.concat(item.row.localizacoes || []));
    }
    const removeIds = new Set(bucket.map((item) => item.row.id).filter((id) => id && id !== parent.id));
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (removeIds.has(rows[i].id)) rows.splice(i, 1);
    }
  }
}

function collapseFinalDirectionalRows(rows) {
  const suffixes = ["Norte", "Sul", "Leste", "Oeste", "Centro", "Central", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  const out = rows.slice();
  const removeIds = new Set();
  const parseRow = (row) => {
    const rawName = String(row && row.nome || "").trim();
    const paren = rawName.match(/^(.*)\s+\(([^)]+)\)$/);
    const core = String((paren && paren[1]) || rawName).trim();
    const citySuffix = String((paren && paren[2]) || "").trim();
    for (const suffix of suffixes) {
      if (!core.endsWith(` ${suffix}`)) continue;
      const baseCore = core.slice(0, -suffix.length).trim();
      if (!baseCore) continue;
      const parentName = citySuffix ? `${baseCore} (${citySuffix})` : baseCore;
      return { parentName };
    }
    return null;
  };

  for (const row of out) {
    const parsed = parseRow(row);
    if (!parsed) continue;
    const parent = out.find((candidate) => normalizeKey(candidate.nome) === normalizeKey(parsed.parentName));
    if (!parent || parent.id === row.id) continue;
    parent.localizacoes = dedupeExactLocations((parent.localizacoes || []).concat(row.localizacoes || []));
    removeIds.add(row.id);
  }
  return out.filter((row) => !removeIds.has(row.id));
}

function normalizeFinalRowsToCenter(rows, flatLocations, primaryCity, groupsByPrimary) {
  const primaryKey = normalizeKey(primaryCity);
  const group = groupsByPrimary.get(primaryKey);
  const members = group && Array.isArray(group.members) ? group.members : [];
  if (!members.length) return rows;

  const out = rows.slice();
  const ensureRow = (name, sourceCity) => {
    let row = out.find((item) => normalizeKey(item.nome) === normalizeKey(name));
    if (!row) {
      row = {
        id: normalizeNeighborhoodId(sourceCity && normalizeKey(sourceCity) !== primaryKey ? `centro ${sourceCity}` : "centro"),
        nome: name,
        localizacoes: [],
        sourceCity: sourceCity || primaryCity,
        baseName: "Centro",
        kind: "city_center"
      };
      out.push(row);
    }
    return row;
  };

  const centerTargets = new Map();
  for (const memberLabel of members) {
    const parsed = parseCityUfLabel(memberLabel);
    if (!parsed.city) continue;
    const isPrimary = normalizeKey(parsed.city) === primaryKey;
    const targetName = isPrimary ? "Centro" : `Centro (${parsed.city})`;
    centerTargets.set(normalizeKey(parsed.city), ensureRow(targetName, parsed.city));
  }

  for (const loc of flatLocations) {
    for (const memberLabel of members) {
      const parsed = parseCityUfLabel(memberLabel);
      if (!parsed.city) continue;
      if (!isGeneralCityLocation(loc, parsed.city)) continue;
      const target = centerTargets.get(normalizeKey(parsed.city));
      if (!target) break;
      for (const row of out) {
        if (!Array.isArray(row.localizacoes)) continue;
        row.localizacoes = row.localizacoes.filter((item) => item !== loc);
      }
      if (!target.localizacoes.includes(loc)) target.localizacoes.push(loc);
      break;
    }
  }

  const rawLocationNames = new Set(flatLocations.map((loc) => normalizeKey(String(loc || ""))));
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const row = out[i];
    if (!Array.isArray(row.localizacoes) || row.localizacoes.length > 0) continue;
    if (!rawLocationNames.has(normalizeKey(row.nome))) continue;
    const base = normalizeKey(row.baseName || row.nome || "");
    if (base === "centro" || base === "centro historico") continue;
    out.splice(i, 1);
  }
  return out;
}

function assignLocationsToNeighborhoods(flatLocations, rows, primaryCity) {
  const preparedRows = rows.map((row) => ({
    row,
    matchKeys: buildNeighborhoodCandidateKeys(row, primaryCity)
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const exactMatchers = new Map();
  const addExact = (key, id) => {
    if (!key) return;
    if (!exactMatchers.has(key)) exactMatchers.set(key, new Set());
    exactMatchers.get(key).add(id);
  };
  for (const prep of preparedRows) {
    for (const key of prep.matchKeys) addExact(key, prep.row.id);
  }
  const resolveUnique = (predicate) => {
    const hits = new Set();
    for (const prep of preparedRows) {
      if (prep.matchKeys.some(predicate)) hits.add(prep.row.id);
    }
    return hits.size === 1 ? Array.from(hits)[0] : null;
  };
  for (const loc of flatLocations) {
    const samples = buildLocationMatchKeys(loc);
    let id = null;
    for (const key of samples) {
      const ids = exactMatchers.get(key);
      if (ids && ids.size === 1) {
        id = Array.from(ids)[0];
        break;
      }
    }
    if (!id) {
      for (const key of samples) {
        id = resolveUnique((candidateKey) => tokenPrefixMatch(key, candidateKey));
        if (id) break;
      }
    }
    if (!id) {
      for (const key of samples) {
        id = resolveUnique((candidateKey) => wholePrefixMatch(key, candidateKey));
        if (id) break;
      }
    }
    if (!id) continue;
    const row = byId.get(id);
    if (!row) continue;
    if (!row.localizacoes.includes(loc)) row.localizacoes.push(loc);
  }
}

function finalizeNeighborhoodRows(rows, primaryCity) {
  const collator = new Intl.Collator("pt-BR", { sensitivity: "base" });
  return rows
    .map((row) => ({
      id: row.id,
      nome: row.nome,
      localizacoes: dedupeExactLocations(row.localizacoes || []),
      sourceCity: row.sourceCity || null,
      baseName: row.baseName || row.nome
    }))
    .sort((a, b) => {
      const aPrimary = normalizeKey(a.sourceCity || primaryCity) === normalizeKey(primaryCity) ? 0 : 1;
      const bPrimary = normalizeKey(b.sourceCity || primaryCity) === normalizeKey(primaryCity) ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return collator.compare(a.nome, b.nome);
    });
}

function applyOverrides({ countryId, city, rows, flatLocations, overridesByCountry } = {}) {
  const countryOverrides = overridesByCountry && typeof overridesByCountry === "object"
    ? overridesByCountry
    : {};
  const cityOverrides = countryOverrides[city];
  if (!cityOverrides || typeof cityOverrides !== "object") return rows;
  const out = rows.slice();
  const byId = new Map(out.map((row) => [row.id, row]));
  const byNameKey = new Map(out.map((row) => [normalizeKey(row.nome), row]));
  const locationOverrideMap = getLocationOverrideMap(cityOverrides);
  for (const [rawLocation, rawTarget] of Object.entries(locationOverrideMap)) {
    const location = String(rawLocation || "");
    if (!flatLocations.includes(location)) continue;
    const target = (typeof rawTarget === "string")
      ? { id: String(rawTarget || "").trim() }
      : (rawTarget && typeof rawTarget === "object" ? rawTarget : null);
    if (!target) continue;
    const targetId = normalizeNeighborhoodId(target.id || target.nome || target.name || "");
    const targetName = String(target.nome || target.name || "").trim();
    let row = targetId ? byId.get(targetId) : null;
    if (!row && targetName) row = byNameKey.get(normalizeKey(targetName)) || null;
    if (!row) {
      if (!targetId || !targetName) continue;
      row = {
        id: targetId,
        nome: targetName,
        localizacoes: [],
        sourceCity: city,
        baseName: targetName,
        kind: "manual_override"
      };
      out.push(row);
      byId.set(row.id, row);
      byNameKey.set(normalizeKey(row.nome), row);
    }
    if (!row.localizacoes.includes(location)) row.localizacoes.push(location);
  }
  return out;
}

function applyFinalRowOverrides({ city, rows, overridesByCountry } = {}) {
  const countryOverrides = overridesByCountry && typeof overridesByCountry === "object"
    ? overridesByCountry
    : {};
  const cityOverrides = countryOverrides[city];
  if (!cityOverrides || typeof cityOverrides !== "object") return rows;
  const out = rows.slice();
  const byId = new Map(out.map((row) => [String(row.id || ""), row]));
  const byName = new Map(out.map((row) => [normalizeKey(row.nome), row]));
  const resolveRow = (value) => {
    const text = String(value || "").trim();
    if (!text) return null;
    const idKey = normalizeNeighborhoodId(text);
    if (idKey && byId.has(idKey)) return byId.get(idKey);
    return byName.get(normalizeKey(text)) || null;
  };
  const upsertTarget = (target) => {
    const spec = (typeof target === "string")
      ? { nome: String(target || "").trim() }
      : (target && typeof target === "object" ? target : null);
    if (!spec) return null;
    const targetName = String(spec.nome || spec.name || spec.label || "").trim();
    const targetId = normalizeNeighborhoodId(spec.id || targetName);
    if (!targetName || !targetId) return null;
    let row = resolveRow(targetId) || resolveRow(targetName);
    if (row) return row;
    row = {
      id: targetId,
      nome: targetName,
      localizacoes: []
    };
    out.push(row);
    byId.set(row.id, row);
    byName.set(normalizeKey(row.nome), row);
    return row;
  };

  const renames = cityOverrides.renames && typeof cityOverrides.renames === "object" ? cityOverrides.renames : {};
  for (const [fromName, toSpec] of Object.entries(renames)) {
    const row = resolveRow(fromName);
    if (!row) continue;
    const target = (typeof toSpec === "string")
      ? { nome: String(toSpec || "").trim() }
      : (toSpec && typeof toSpec === "object" ? toSpec : null);
    if (!target) continue;
    const nextName = String(target.nome || target.name || target.label || "").trim();
    const nextId = normalizeNeighborhoodId(target.id || nextName);
    if (!nextName || !nextId) continue;
    byName.delete(normalizeKey(row.nome));
    byId.delete(String(row.id || ""));
    row.id = nextId;
    row.nome = nextName;
    byId.set(row.id, row);
    byName.set(normalizeKey(row.nome), row);
  }

  const merges = cityOverrides.merges && typeof cityOverrides.merges === "object" ? cityOverrides.merges : {};
  for (const [fromName, toSpec] of Object.entries(merges)) {
    const child = resolveRow(fromName);
    const parent = upsertTarget(toSpec);
    if (!child || !parent || child === parent) continue;
    parent.localizacoes = dedupeExactLocations((parent.localizacoes || []).concat(child.localizacoes || []));
    child.localizacoes = [];
    if (child.id !== parent.id) {
      const idx = out.findIndex((row) => row === child);
      if (idx >= 0) out.splice(idx, 1);
      byId.delete(String(child.id || ""));
      byName.delete(normalizeKey(child.nome));
    }
  }

  const drops = Array.isArray(cityOverrides.drops) ? cityOverrides.drops : [];
  for (const raw of drops) {
    const row = resolveRow(raw);
    if (!row) continue;
    const idx = out.findIndex((item) => item === row);
    if (idx >= 0) out.splice(idx, 1);
    byId.delete(String(row.id || ""));
    byName.delete(normalizeKey(row.nome));
  }

  return out;
}

function enrichCatalogEntries(entries, { countryId, groupsByPrimary, ibgeIndex } = {}) {
  const overrides = readOverrides();
  const overridesByCountry = countryId === "us" ? overrides.us : overrides.br;
  return entries.map((entryRaw) => {
    const entry = entryRaw && typeof entryRaw === "object" ? { ...entryRaw } : {};
    const city = String(entry.cidade || entry.nome || "").trim();
    const flatLocations = preserveFlatLocations(entry.localizacoes || entry.locations);
    const existingRows = existingNeighborhoodRows(entry);
    const generatedRowsBase = (countryId === "br")
      ? buildBrGeneratedNeighborhoods(entry, groupsByPrimary, ibgeIndex)
      : buildUsGeneratedNeighborhoods(entry, groupsByPrimary);
    const generatedRows = (countryId === "br")
      ? generatedRowsBase.concat(buildBrCityGeneralRows(entry, groupsByPrimary, generatedRowsBase))
      : generatedRowsBase;
    const merged = mergeNeighborhoods(existingRows, generatedRows);
    assignLocationsToNeighborhoods(flatLocations, merged, city);
    const withOverrides = applyOverrides({
      countryId,
      city,
      rows: merged,
      flatLocations,
      overridesByCountry
    });
    assignRemainingLocationsByDerivedName(flatLocations, withOverrides, city);
    if (countryId === "br") moveCityLevelLocationsToCenter(flatLocations, withOverrides, city, groupsByPrimary);
    collapseDirectionalNeighborhoods(withOverrides, city);
    for (let i = withOverrides.length - 1; i >= 0; i -= 1) {
      if (withOverrides[i].kind === "derived_location" && (!Array.isArray(withOverrides[i].localizacoes) || !withOverrides[i].localizacoes.length)) {
        withOverrides.splice(i, 1);
      }
    }
    let finalRows = finalizeNeighborhoodRows(withOverrides, city);
    if (countryId === "br") {
      finalRows = normalizeFinalRowsToCenter(finalRows, flatLocations, city, groupsByPrimary);
      finalRows = finalizeNeighborhoodRows(finalRows, city);
    }
    finalRows = collapseFinalDirectionalRows(finalRows);
    finalRows = finalizeNeighborhoodRows(finalRows, city);
    finalRows = applyFinalRowOverrides({
      city,
      rows: finalRows,
      overridesByCountry
    });
    finalRows = finalizeNeighborhoodRows(finalRows, city);
    return {
      ...entry,
      cidade: city,
      localizacoes: flatLocations,
      bairros: finalRows.map((row) => ({
        id: row.id,
        nome: row.nome,
        localizacoes: row.localizacoes.slice()
      }))
    };
  });
}

async function main() {
  const brEntries = readCatalogEntries(BR_CATALOG_FILE);
  const usEntries = readCatalogEntries(US_CATALOG_FILE);
  const brGroups = loadPrimaryGroups(GROUPS_BR_FILE);
  const usGroups = loadPrimaryGroups(GROUPS_US_FILE);

  const gpkgPath = await ensureIbgeGpkg();
  const ibgeIndex = loadIbgeNeighborhoodIndex(gpkgPath);

  const nextBr = enrichCatalogEntries(brEntries, {
    countryId: "br",
    groupsByPrimary: brGroups,
    ibgeIndex
  });
  const nextUs = enrichCatalogEntries(usEntries, {
    countryId: "us",
    groupsByPrimary: usGroups,
    ibgeIndex: null
  });

  writeJson(BR_CATALOG_FILE, nextBr);
  writeJson(US_CATALOG_FILE, nextUs);

  const countNeighborhoods = (arr) => arr.reduce((sum, row) => sum + (Array.isArray(row && row.bairros) ? row.bairros.length : 0), 0);
  console.log(JSON.stringify({
    ok: true,
    brCities: nextBr.length,
    brNeighborhoods: countNeighborhoods(nextBr),
    usCities: nextUs.length,
    usNeighborhoods: countNeighborhoods(nextUs),
    gpkgPath
  }, null, 2));
}

main().catch((err) => {
  console.error(err && err.stack || String(err));
  process.exit(1);
});
