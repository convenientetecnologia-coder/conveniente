"use strict";

const countryGeo = require("./countryGeo.js");
const robe = require("./robe.js");

function fail(msg) {
  console.error("FALHOU:", msg);
  process.exit(1);
}

function requireNeighborhood(list, id, label) {
  const hit = (Array.isArray(list) ? list : []).find((row) => String(row && row.id || "") === id);
  if (!hit) fail(`bairro ausente: ${label} (${id})`);
  return hit;
}

const floripaNeighborhoods = countryGeo.listNeighborhoods("Florianópolis");
if (!Array.isArray(floripaNeighborhoods) || !floripaNeighborhoods.length) {
  fail("Florianópolis sem bairros no catalogo");
}
const barreiros = requireNeighborhood(floripaNeighborhoods, "barreiros-sao-jose", "Barreiros (São José)");
const forquilhinhas = requireNeighborhood(floripaNeighborhoods, "forquilhinhas-sao-jose", "Forquilhinhas (São José)");
const campinasSaoJose = requireNeighborhood(floripaNeighborhoods, "campinas-sao-jose", "Campinas (São José)");
if (!Array.isArray(barreiros.locations) || !barreiros.locations.includes("Barreiros, São José")) {
  fail("Barreiros (São José) nao preservou a localizacao real");
}
if (!Array.isArray(forquilhinhas.locations) || !forquilhinhas.locations.includes("Forquilhinhas")) {
  fail("Forquilhinhas (São José) nao mapeou a localizacao operacional");
}
if (!Array.isArray(campinasSaoJose.locations) || campinasSaoJose.locations.length !== 0) {
  fail("Campinas (São José) deveria existir sem localizacoes proprias");
}

const floripaPlan = robe.buildRobeV4CityPlan({
  city: "Florianópolis",
  target: 20,
  countryId: "br",
  directedPercent: 90,
  exactPercent: 50,
  statsEntry: {
    motoristas: 2,
    pmg: { p: 1, m: 0, g: 0, fixo: 1 },
    coverage: [
      {
        coverage_mode: "selected",
        coverage_neighborhood_ids: ["barreiros-sao-jose", "forquilhinhas-sao-jose"],
        p: true
      },
      {
        coverage_mode: "selected",
        coverage_neighborhood_ids: ["campinas-sao-jose"],
        fixo: true
      }
    ]
  }
});
if (!floripaPlan || floripaPlan.ok !== true || floripaPlan.mode !== "v4_bairros") {
  fail("plano v4 de Florianópolis nao foi montado");
}
if (!(Number(floripaPlan.summary.coveredExactNeighborhoodsCount || 0) >= 1)) {
  fail("Florianópolis deveria ter ao menos um bairro exato coberto");
}
if (!(Number(floripaPlan.summary.coveredFallbackNeighborhoodsCount || 0) >= 1)) {
  fail("Florianópolis deveria ter bairros cobrindo via fallback dinamico");
}
if (!(Number(floripaPlan.summary.directedExactTarget || 0) > 0)) {
  fail("Florianópolis deveria reservar vagas para bairros exatos");
}
if (!(Number(floripaPlan.summary.directedFallbackTarget || 0) > 0)) {
  fail("Florianópolis deveria reservar vagas para fallback dirigido");
}
const floripaReservedIds = new Set(["barreiros-sao-jose", "forquilhinhas-sao-jose", "campinas-sao-jose"]);
const floripaReservedLocs = new Set(["Barreiros, São José", "Forquilhinhas"]);
const floripaFallbackBuckets = (floripaPlan.slotBuckets || []).filter((row) => {
  const slot = row && row.slot;
  return slot && slot.scope === "directed" && Array.isArray(slot.locationPool) && slot.locationPool.length > 0;
});
if (!floripaFallbackBuckets.length) {
  fail("Florianópolis deveria gerar bucket directed com locationPool de fallback");
}
for (const row of floripaPlan.slotBuckets || []) {
  const slot = row && row.slot;
  if (!slot || (slot.scope !== "universal" && !(slot.scope === "directed" && Array.isArray(slot.locationPool)))) continue;
  if (floripaReservedIds.has(String(slot.neighborhoodId || ""))) {
    fail(`spillover de Florianópolis usou bairro ja selecionado: ${slot.neighborhoodId}`);
  }
  for (const loc of slot.locationPool || []) {
    if (floripaReservedLocs.has(loc)) fail(`spillover de Florianópolis reutilizou localizacao reservada: ${loc}`);
  }
}

const anapolisNeighborhoods = countryGeo.listNeighborhoods("Anápolis");
const adrianaParque = requireNeighborhood(anapolisNeighborhoods, "adriana-parque", "Adriana Parque");
if (!Array.isArray(adrianaParque.locations) || !adrianaParque.locations.includes("Adriana Parque")) {
  fail("Anápolis deveria aproveitar a propria localizacao como bairro sintetico seguro");
}

const anapolisCatalog = countryGeo.getLocationCatalogEntry("Anápolis");
if (!anapolisCatalog || Number(anapolisCatalog.unmappedLocationsCount || 0) !== 0) {
  fail("Anápolis deveria estar com 0 localizacoes sem bairro");
}

const caruaruCatalog = countryGeo.getLocationCatalogEntry("Caruaru");
if (!caruaruCatalog || Number(caruaruCatalog.unmappedLocationsCount || 0) !== 0) {
  fail("Caruaru deveria estar com 0 localizacoes sem bairro");
}

const nyNeighborhoods = countryGeo.listNeighborhoods("Nova York", { countryId: "us" });
const brooklyn = requireNeighborhood(nyNeighborhoods, "brooklyn-ny", "Brooklyn (NY)");
const hoboken = requireNeighborhood(nyNeighborhoods, "hoboken-nj", "Hoboken (NJ)");
if (!Array.isArray(brooklyn.locations) || !brooklyn.locations.includes("brooklyn, nov")) {
  fail("Brooklyn (NY) nao preservou a localizacao operacional");
}
if (!Array.isArray(hoboken.locations)) {
  fail("Hoboken (NJ) deveria existir no catalogo EUA");
}

const chester = requireNeighborhood(nyNeighborhoods, "chester-hill-park-ny", "Chester Hill Park (NY)");
const albertson = requireNeighborhood(nyNeighborhoods, "albertson-ny", "Albertson (NY)");
if (!Array.isArray(chester.locations) || chester.locations.length !== 1 || chester.locations[0] !== "Chester Hill Park") {
  fail("Chester Hill Park (NY) deveria ter só a localizacao Chester Hill Park");
}
if (!Array.isArray(albertson.locations) || albertson.locations.length !== 0) {
  fail("Albertson (NY) deveria existir sem localizacao propria");
}
const nyPlan = robe.buildRobeV4CityPlan({
  city: "Nova York",
  target: 100,
  countryId: "us",
  directedPercent: 90,
  exactPercent: 50,
  statsEntry: {
    motoristas: 1,
    pmg: { p: 0, m: 0, g: 1, fixo: 0 },
    coverage: [
      {
        coverage_mode: "selected",
        coverage_neighborhood_ids: ["chester-hill-park-ny", "albertson-ny"],
        g: true
      }
    ]
  }
});
if (!nyPlan || nyPlan.ok !== true || nyPlan.mode !== "v4_bairros") fail("plano v4 de Nova York nao foi montado");
if (!(Number(nyPlan.summary.directedExactTarget || 0) > 0)) fail("Nova York deveria reservar vagas exatas para Chester");
if (!(Number(nyPlan.summary.directedFallbackTarget || 0) > 0)) fail("Nova York deveria reservar fallback para outros bairros");
if (!(Number(nyPlan.summary.universalTarget || 0) > 0)) fail("Nova York deveria reservar universal para outros bairros");
const nyReserved = new Set(["chester-hill-park-ny", "albertson-ny"]);
let nyExact = 0;
let nyFallback = 0;
let nyUniversal = 0;
for (const row of nyPlan.slotBuckets || []) {
  const slot = row && row.slot;
  const count = Math.max(0, Number(row && row.count || 0) || 0);
  if (!slot || !count) continue;
  const pool = Array.isArray(slot.locationPool) ? slot.locationPool : [];
  if (pool.includes("Chester Hill Park") && slot.neighborhoodId !== "chester-hill-park-ny") {
    fail("localizacao de Chester Hill Park vazou para outro bairro");
  }
  if (slot.scope === "directed" && !pool.length) {
    if (slot.neighborhoodId !== "chester-hill-park-ny") fail(`vaga exata foi para ${slot.neighborhoodId}`);
    nyExact += count;
    continue;
  }
  if (nyReserved.has(String(slot.neighborhoodId || ""))) {
    fail(`spillover de Nova York usou bairro da conta: ${slot.neighborhoodName || slot.neighborhoodId}`);
  }
  if (!pool.length) fail(`spillover sem localizacoes: ${slot.neighborhoodId}`);
  if (slot.scope === "universal") nyUniversal += count;
  else nyFallback += count;
}
if (nyExact !== Number(nyPlan.summary.directedExactTarget || 0)) fail("contagem exata de Nova York divergiu");
if (nyFallback !== Number(nyPlan.summary.directedFallbackTarget || 0)) fail("contagem fallback de Nova York divergiu");
if (nyUniversal !== Number(nyPlan.summary.universalTarget || 0)) fail("contagem universal de Nova York divergiu");

console.log("ok", {
  floripaNeighborhoods: floripaNeighborhoods.length,
  floripaExact: floripaPlan.summary.coveredExactNeighborhoodsCount,
  floripaFallback: floripaPlan.summary.coveredFallbackNeighborhoodsCount,
  anapolisNeighborhoods: anapolisNeighborhoods.length,
  nyNeighborhoods: nyNeighborhoods.length,
  nyExact,
  nyFallback,
  nyUniversal,
  nyDirected: nyPlan.summary.directedTarget,
  nyExactTarget: nyPlan.summary.directedExactTarget,
  nyFallbackTarget: nyPlan.summary.directedFallbackTarget,
  nyUniversalTarget: nyPlan.summary.universalTarget
});
