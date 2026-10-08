#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function auditFile(file) {
  const arr = readJson(file);
  let totalCities = 0;
  let totalLocs = 0;
  let totalMapped = 0;
  let totalUnmapped = 0;
  const rows = [];
  for (const entry of arr) {
    totalCities += 1;
    const city = String(entry && entry.cidade || "").trim();
    const locs = Array.isArray(entry && entry.localizacoes) ? entry.localizacoes : [];
    const bairros = Array.isArray(entry && entry.bairros) ? entry.bairros : [];
    const mapped = new Set();
    for (const bairro of bairros) {
      for (const loc of (Array.isArray(bairro && bairro.localizacoes) ? bairro.localizacoes : [])) {
        mapped.add(normalizeKey(loc));
      }
    }
    const unmapped = locs.filter((loc) => !mapped.has(normalizeKey(loc)));
    totalLocs += locs.length;
    totalMapped += (locs.length - unmapped.length);
    totalUnmapped += unmapped.length;
    if (unmapped.length) {
      rows.push({
        cidade: city,
        total: locs.length,
        mapped: locs.length - unmapped.length,
        unmapped: unmapped.length,
        sample: unmapped.slice(0, 12)
      });
    }
  }
  rows.sort((a, b) => b.unmapped - a.unmapped || a.cidade.localeCompare(b.cidade, "pt-BR", { sensitivity: "base" }));
  return {
    totalCities,
    totalLocs,
    totalMapped,
    totalUnmapped,
    citiesWithUnmapped: rows.length,
    top: rows.slice(0, 20)
  };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const br = auditFile(path.join(root, "dados", "localizacoes.json"));
  const us = auditFile(path.join(root, "dados", "localizacoesEUA.json"));
  console.log(JSON.stringify({ brSummary: br, usSummary: us }, null, 2));
}

main();
