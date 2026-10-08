#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BR_CATALOG_FILE = path.join(ROOT, "dados", "localizacoes.json");
const US_CATALOG_FILE = path.join(ROOT, "dados", "localizacoesEUA.json");
const OVERRIDES_FILE = path.join(ROOT, "dados", "locationNeighborhoodOverrides.json");

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

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = String(raw == null ? "" : raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function getLocationOverrideMap(cityOverrides) {
  if (!cityOverrides || typeof cityOverrides !== "object") return {};
  if (cityOverrides.locations && typeof cityOverrides.locations === "object") return cityOverrides.locations;
  if (cityOverrides.merges || cityOverrides.renames || cityOverrides.drops) return {};
  return cityOverrides;
}

function resolveRow(rows, ref) {
  const text = String(ref || "").trim();
  if (!text) return null;
  const id = normalizeNeighborhoodId(text);
  return rows.find((row) => String(row && row.id || "") === id)
    || rows.find((row) => normalizeKey(row && row.nome || "") === normalizeKey(text))
    || null;
}

function ensureTargetRow(rows, target) {
  const spec = (typeof target === "string")
    ? { nome: String(target || "").trim() }
    : (target && typeof target === "object" ? target : null);
  if (!spec) return null;
  const nome = String(spec.nome || spec.name || spec.label || "").trim();
  const id = normalizeNeighborhoodId(spec.id || nome);
  if (!nome || !id) return null;
  let row = rows.find((item) => String(item && item.id || "") === id)
    || rows.find((item) => normalizeKey(item && item.nome || "") === normalizeKey(nome));
  if (row) return row;
  row = { id, nome, localizacoes: [] };
  rows.push(row);
  return row;
}

function applyCityOverrides(entry, cityOverrides) {
  if (!entry || !cityOverrides || typeof cityOverrides !== "object") return entry;
  const rows = Array.isArray(entry.bairros) ? entry.bairros.map((row) => ({
    id: String(row && row.id || "").trim(),
    nome: String(row && row.nome || "").trim(),
    localizacoes: dedupe(row && row.localizacoes)
  })) : [];

  const locationMap = getLocationOverrideMap(cityOverrides);
  for (const [rawLoc, rawTarget] of Object.entries(locationMap)) {
    const loc = String(rawLoc || "");
    if (!Array.isArray(entry.localizacoes) || !entry.localizacoes.includes(loc)) continue;
    const targetRow = ensureTargetRow(rows, rawTarget);
    if (!targetRow) continue;
    const flat = new Set(Array.isArray(entry.localizacoes) ? entry.localizacoes : []);
    for (const row of rows) {
      row.localizacoes = (row.localizacoes || []).filter((item) => {
        if (item === loc) return false;
        // Cópia interna que perdeu só espaço não é outra localização.
        if (String(item).trim() === loc.trim() && !flat.has(item)) return false;
        return true;
      });
    }
    if (!targetRow.localizacoes.includes(loc)) targetRow.localizacoes.push(loc);
  }

  const renames = cityOverrides.renames && typeof cityOverrides.renames === "object" ? cityOverrides.renames : {};
  for (const [fromName, toSpec] of Object.entries(renames)) {
    const row = resolveRow(rows, fromName);
    if (!row) continue;
    const target = (typeof toSpec === "string")
      ? { nome: String(toSpec || "").trim() }
      : (toSpec && typeof toSpec === "object" ? toSpec : null);
    if (!target) continue;
    const nome = String(target.nome || target.name || target.label || "").trim();
    const id = normalizeNeighborhoodId(target.id || nome);
    if (!nome || !id) continue;
    row.id = id;
    row.nome = nome;
  }

  const merges = cityOverrides.merges && typeof cityOverrides.merges === "object" ? cityOverrides.merges : {};
  for (const [fromName, toSpec] of Object.entries(merges)) {
    const child = resolveRow(rows, fromName);
    const parent = ensureTargetRow(rows, toSpec);
    if (!child || !parent || child === parent) continue;
    parent.localizacoes = dedupe((parent.localizacoes || []).concat(child.localizacoes || []));
    const idx = rows.findIndex((row) => row === child);
    if (idx >= 0) rows.splice(idx, 1);
  }

  const drops = Array.isArray(cityOverrides.drops) ? cityOverrides.drops : [];
  for (const raw of drops) {
    const row = resolveRow(rows, raw);
    if (!row) continue;
    const idx = rows.findIndex((item) => item === row);
    if (idx >= 0) rows.splice(idx, 1);
  }

  for (const row of rows) {
    row.localizacoes = dedupe(row.localizacoes || []);
  }

  const collapsed = [];
  const byId = new Map();
  for (const row of rows) {
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      collapsed.push(row);
      continue;
    }
    prev.localizacoes = dedupe((prev.localizacoes || []).concat(row.localizacoes || []));
  }

  collapsed.sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR", { sensitivity: "base" }));
  entry.bairros = collapsed;
  return entry;
}

function processCatalog(file, countryOverrides) {
  const arr = readJson(file, []);
  const out = (Array.isArray(arr) ? arr : []).map((entry) => {
    const city = String(entry && entry.cidade || "").trim();
    const cityOverrides = countryOverrides && typeof countryOverrides === "object" ? countryOverrides[city] : null;
    if (!cityOverrides) return entry;
    return applyCityOverrides({ ...entry }, cityOverrides);
  });
  writeJson(file, out);
}

function main() {
  const overrides = readJson(OVERRIDES_FILE, { br: {}, us: {} });
  if (process.env.US_ONLY !== "1") processCatalog(BR_CATALOG_FILE, overrides.br || {});
  if (process.env.BR_ONLY !== "1") processCatalog(US_CATALOG_FILE, overrides.us || {});
  console.log(JSON.stringify({
    ok: true,
    wroteBr: process.env.US_ONLY !== "1",
    wroteUs: process.env.BR_ONLY !== "1",
    brCitiesWithOverrides: Object.keys(overrides.br || {}).length,
    usCitiesWithOverrides: Object.keys(overrides.us || {}).length
  }, null, 2));
}

main();
