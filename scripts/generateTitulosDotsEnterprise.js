const fs = require("fs");
const path = require("path");

const TITULOS_PATH = path.join(__dirname, "..", "dados", "titulos.json");
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const BORDOES_BASE = [
  "pequeno, médio e grande",
  "economia garantida",
  "preço imbatível",
  "promoção especial",
  "disponibilidade imediata",
  "menor preço garantido",
  "super promoção hoje",
  "barato e imediato",
  "oferta relâmpago",
  "valor justo e acessível",
  "atendemos sua região",
  "disponível na sua região",
  "trabalhamos na sua região",
  "na promoção",
  "preço baixo na região"
];

function makeRng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalizeVisible(text) {
  return String(text || "")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normKey(text) {
  return normalizeVisible(text)
    .replace(/\s+/g, " ")
    .trim();
}

function dotVariants(word) {
  const chars = Array.from(word);
  const gaps = chars.length - 1;
  const out = new Set();
  const maxMask = 1 << Math.max(0, gaps);

  for (let mask = 0; mask < maxMask; mask += 1) {
    let s = chars[0] || "";
    for (let i = 0; i < gaps; i += 1) {
      if (((mask >> i) & 1) === 1) s += ".";
      s += chars[i + 1];
    }
    out.add(s);
  }
  return Array.from(out);
}

function extractBordoes() {
  const keys = new Set();
  const out = [];
  for (const b of BORDOES_BASE) {
    const clean = normalizeVisible(b);
    const key = normKey(clean);
    if (!clean || !key || keys.has(key)) continue;
    keys.add(key);
    out.push(clean);
  }
  return out;
}

function uniquePush(out, seen, text) {
  const clean = normalizeVisible(text);
  if (!clean) return false;
  const key = normKey(clean);
  if (!key || seen.has(key)) return false;
  seen.add(key);
  out.push(clean);
  return true;
}

function buildTitlesForBucket(tokens, bordoes) {
  const out = [];
  for (const token of tokens) {
    for (const bordao of bordoes) {
      out.push(`${token} ${bordao}`);
    }
  }
  return out;
}

function sampleDistinct(source, targetCount, rng, seen, out) {
  const shuffled = shuffle(source, rng);
  for (const item of shuffled) {
    if (out.length >= targetCount) break;
    uniquePush(out, seen, item);
  }
}

function main() {
  const rng = makeRng(2026042101);
  const bordoes = extractBordoes();

  const freteBase = ["frete", "fretes", "Frete", "Fretes"];
  const mudancaBase = ["mudança", "mudanças", "Mudança", "Mudanças"];
  const carretoBase = ["carreto", "carretos", "Carreto", "Carretos"];

  const freteTokens = freteBase.flatMap((w) => dotVariants(w));
  const mudancaTokens = mudancaBase.flatMap((w) => dotVariants(w));
  const carretoTokens = carretoBase.flatMap((w) => dotVariants(w));

  const fretePool = buildTitlesForBucket(freteTokens, bordoes);
  const mudancaPool = buildTitlesForBucket(mudancaTokens, bordoes);
  const carretoPool = buildTitlesForBucket(carretoTokens, bordoes);

  const freteCount = fretePool.length;
  const baseTotal = Math.ceil(freteCount / 0.8);
  const mudancaTarget = Math.round(baseTotal * 0.15);
  const carretoTarget = Math.max(0, baseTotal - freteCount - mudancaTarget);
  const trioTarget = Math.ceil(baseTotal * 0.2);

  const seen = new Set();
  const freteTitles = [];
  const mudancaTitles = [];
  const carretoTitles = [];
  const trioTitles = [];

  for (const t of fretePool) uniquePush(freteTitles, seen, t);
  sampleDistinct(mudancaPool, mudancaTarget, rng, seen, mudancaTitles);
  sampleDistinct(carretoPool, carretoTarget, rng, seen, carretoTitles);

  let attempts = 0;
  const maxAttempts = Math.max(10000, trioTarget * 200);
  while (trioTitles.length < trioTarget && attempts < maxAttempts) {
    attempts += 1;
    const f = freteTokens[Math.floor(rng() * freteTokens.length)];
    const m = mudancaTokens[Math.floor(rng() * mudancaTokens.length)];
    const c = carretoTokens[Math.floor(rng() * carretoTokens.length)];
    const b = bordoes[Math.floor(rng() * bordoes.length)];
    const candidate = `${f}, ${m}, ${c} ${b}`;
    uniquePush(trioTitles, seen, candidate);
  }

  const baseTitles = [...freteTitles, ...mudancaTitles, ...carretoTitles, ...trioTitles];

  const prefixes = ["Faço", "Vendo", "Vendo-se", "Vende", "Vende-se"];
  const finalSeen = new Set();
  const finalTitles = [];
  for (const t of baseTitles) uniquePush(finalTitles, finalSeen, t);
  for (const prefix of prefixes) {
    for (const t of baseTitles) {
      uniquePush(finalTitles, finalSeen, `${prefix} ${t}`);
    }
  }

  const shuffledFinal = shuffle(finalTitles, rng);
  fs.writeFileSync(TITULOS_PATH, JSON.stringify(shuffledFinal, null, 2) + "\n", "utf8");

  console.log(
    JSON.stringify(
      {
        bordoes: bordoes.length,
        freteTokens: freteTokens.length,
        mudancaTokens: mudancaTokens.length,
        carretoTokens: carretoTokens.length,
        baseTotal,
        freteCount: freteTitles.length,
        mudancaCount: mudancaTitles.length,
        carretoCount: carretoTitles.length,
        trioCount: trioTitles.length,
        finalTotal: shuffledFinal.length
      },
      null,
      2
    )
  );
}

main();
