/**
 * Gera dados/titulos.json: mix de títulos curtos (busca) + longos existentes.
 * Proporção alvo ~60% Frete / 35% Mudança / 5% Carreto (184 itens).
 * Bucket = primeira ocorrência da palavra frete | mudança | carreto no texto.
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "dados", "titulos.json");
const MUD = "mudança";

function tokenize(s) {
  return norm(s)
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zà-ú0-9]/gi, ""))
    .filter(Boolean);
}

function bucket(s) {
  for (const w of tokenize(s)) {
    if (w === "frete") return "f";
    if (w === MUD) return "m";
    if (w === "carreto") return "c";
  }
  return null;
}

function norm(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeRng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

const freteShorts = [
  "Frete",
  "Frete aqui",
  "Frete agora",
  "Frete hoje",
  "Faço frete",
  "Vendo frete",
  "Melhor frete",
  "Frete barato",
  "Frete econômico",
  "Pequeno frete",
  "Vendo pequeno frete",
  "Frete pequeno",
  "Frete rápido",
  "Frete local",
  "Frete na região",
  "Preciso de frete",
  "Contrato frete",
  "Orçamento de frete",
  "Frete e mudança",
  "Frete e carreto",
  "Frete para mudança",
  "Frete residencial",
  "Frete comercial",
  "Frete com ajudante",
  "Frete 24 horas",
  "Frete no mesmo dia",
  "Frete urgente",
  "Frete confiável",
  "Frete com qualidade",
  "Faço frete residencial",
  "Faço frete comercial",
  "Frete para casa",
  "Frete para apartamento",
  "Frete para empresa",
  "Frete imediato",
  "Frete pontual",
  "Frete no bairro",
  "Frete capixaba",
  "Frete WhatsApp",
  "Frete indicado",
  "Frete procurado",
  "Frete caminhão",
  "Frete mudança",
  "Frete express",
  "Frete bom e barato",
  "Frete é só chamar",
  "Frete com hora marcada",
  "Frete para hoje",
];

const mudShorts = [
  "Mudança",
  "Mudança aqui",
  "Mudança agora",
  "Mudança hoje",
  "Faço mudança",
  "Vendo mudança",
  "Melhor mudança",
  "Mudança barata",
  "Mudança econômica",
  "Pequena mudança",
  "Vendo mudança barata",
  "Mudança e frete",
  "Mudança e carreto",
  "Preciso de mudança",
  "Mudança rápida",
  "Mudança segura",
  "Mudança organizada",
  "Mudança residencial",
  "Mudança comercial",
  "Faço mudança residencial",
  "Contrato mudança",
  "Mudança com Frete",
  "Mudança com carreto",
  "Orçamento mudança",
  "Mudança local",
  "Mudança na região",
  "Mudança com ajudante",
  "Faço mudança comercial",
];

const carShorts = [
  "Carreto",
  "Vendo carreto",
  "Faço carreto",
  "Carreto barato",
  "Pequeno carreto",
  "Vendo pequeno carreto",
  "Carreto e mudança",
  "Carreto e frete",
];

const TARGET = { f: 111, m: 64, c: 9 };

function main() {
  const prevPath = OUT;
  const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));

  const long = { f: [], m: [], c: [] };
  for (const s of prev) {
    const b = bucket(s);
    if (b) long[b].push(s);
  }

  const rand = makeRng(202603261);
  long.f = shuffle(long.f, rand);
  long.m = shuffle(long.m, rand);
  long.c = shuffle(long.c, rand);

  const seen = new Set();
  const out = [];

  function tryAdd(s) {
    const n = norm(s);
    if (seen.has(n)) return false;
    const b = bucket(s);
    if (!b) return false;
    seen.add(n);
    out.push(s);
    return true;
  }

  for (const s of freteShorts) tryAdd(s);
  for (const s of mudShorts) tryAdd(s);
  for (const s of carShorts) tryAdd(s);

  function countBuckets() {
    const c = { f: 0, m: 0, c: 0 };
    for (const s of out) {
      c[bucket(s)]++;
    }
    return c;
  }

  function pullFromPool(key, pool) {
    for (const s of pool) {
      const c = countBuckets();
      if (c[key] >= TARGET[key]) return;
      if (tryAdd(s)) {
        /* ok */
      }
    }
  }

  pullFromPool("f", long.f);
  pullFromPool("m", long.m);
  pullFromPool("c", long.c);

  let cb = countBuckets();
  if (cb.f < TARGET.f) pullFromPool("f", long.f);
  if (cb.m < TARGET.m) pullFromPool("m", long.m);
  if (cb.c < TARGET.c) pullFromPool("c", long.c);

  cb = countBuckets();
  for (const k of ["f", "m", "c"]) {
    if (cb[k] < TARGET[k]) {
      console.error("Faltou título no bucket", k, cb[k], TARGET[k]);
      process.exit(1);
    }
  }

  if (out.length !== 184) {
    console.error("Tamanho inesperado:", out.length, "esperado 184");
    process.exit(1);
  }

  cb = countBuckets();
  if (cb.f !== TARGET.f || cb.m !== TARGET.m || cb.c !== TARGET.c) {
    console.error("Contagem bucket errada:", cb, TARGET);
    process.exit(1);
  }

  const mixed = shuffle(out, rand);
  fs.writeFileSync(OUT, JSON.stringify(mixed, null, 2) + "\n", "utf8");
  console.log("OK", OUT, cb);
}

main();
