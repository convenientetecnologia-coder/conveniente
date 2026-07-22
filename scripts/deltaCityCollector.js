const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

let puppeteer = null;
try {
  const pExtra = require("puppeteer-extra");
  const StealthPlugin = require("puppeteer-extra-plugin-stealth");
  pExtra.use(StealthPlugin());
  puppeteer = pExtra;
} catch (_) {
  puppeteer = require("puppeteer");
}

const LOG_ENABLED = String(process.env.VIRTUS_DELTA_CITY_COLLECTOR_LOG || "1").trim() === "1";
function log(...args) {
  if (!LOG_ENABLED) return;
  try { console.log("[deltaCityCollector]", ...args); } catch (_) {}
}

const FORENSIC_TRIAGEM_LOG_PATH = path.join(__dirname, "..", "dados", "forensic_triagem.log");
const FORENSIC_TRIAGEM_ROTATE_MAX_BYTES = 10 * 1024 * 1024;

/** Append circular em forensic_triagem.log (RAM constante). */
function appendForensicTriagemLine(obj) {
  try {
    const fp = FORENSIC_TRIAGEM_LOG_PATH;
    const line = JSON.stringify(obj && typeof obj === "object" ? obj : { ts: Date.now(), msg: "invalid" }) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");
    try { fs.mkdirSync(path.dirname(fp), { recursive: true }); } catch (_) {}

    let currentSize = 0;
    try {
      if (fs.existsSync(fp)) currentSize = Number(fs.statSync(fp).size || 0) || 0;
    } catch (_) {}

    if ((currentSize + lineBytes) > FORENSIC_TRIAGEM_ROTATE_MAX_BYTES) {
      const keepBytes = Math.max(0, FORENSIC_TRIAGEM_ROTATE_MAX_BYTES - lineBytes);
      let tail = "";
      if (keepBytes > 0 && currentSize > 0) {
        let fd = null;
        try {
          fd = fs.openSync(fp, "r");
          const start = Math.max(0, currentSize - keepBytes);
          const toRead = Math.max(0, currentSize - start);
          if (toRead > 0) {
            const buf = Buffer.allocUnsafe(toRead);
            const got = fs.readSync(fd, buf, 0, toRead, start);
            tail = buf.slice(0, Math.max(0, got)).toString("utf8");
          }
        } catch (_) {
          tail = "";
        } finally {
          try { if (fd) fs.closeSync(fd); } catch (_) {}
        }
      }
      fs.writeFileSync(fp, tail + line, "utf8");
      return;
    }
    fs.appendFileSync(fp, line, "utf8");
  } catch (_) {}
}

function logTriagemDomCityCommunion(ctx = {}) {
  appendForensicTriagemLine({
    ts: Date.now(),
    tag: "TRIAGEM_DOM",
    msg: "city_communion_processed",
    ctx: {
      account_login: String((ctx && ctx.account_login) || "").slice(0, 80) || null,
      thread_key: String((ctx && ctx.thread_key) || "").slice(0, 80) || null,
      item_link: String((ctx && ctx.item_link) || "").slice(0, 300) || null,
      block_a: String((ctx && ctx.block_a) || "").slice(0, 400),
      block_b: String((ctx && ctx.block_b) || "").slice(0, 400),
      final_extracted: (ctx && ctx.final_extracted) || null,
    },
  });
}

function logTriagemCityCollectFailed(ctx = {}) {
  appendForensicTriagemLine({
    ts: Date.now(),
    tag: "TRIAGEM_DOM",
    msg: "city_collect_failed",
    ctx: {
      account_login: String((ctx && ctx.account_login) || "").slice(0, 80) || null,
      thread_key: String((ctx && ctx.thread_key) || "").slice(0, 80) || null,
      item_link: String((ctx && ctx.item_link) || "").slice(0, 300) || null,
      error: String((ctx && ctx.error) || "").slice(0, 120) || null,
      login_wall: !!(ctx && ctx.login_wall),
      has_localizacao: !!(ctx && ctx.has_localizacao),
      has_anunciado: !!(ctx && ctx.has_anunciado),
      candidates_count: Number((ctx && ctx.candidates_count) || 0) || 0,
      attempts: Number((ctx && ctx.attempts) || 0) || 0,
      last_nav_error: String((ctx && ctx.last_nav_error) || "").slice(0, 200) || null,
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Fila limitada. Para o city collector o contrato soberano e SEMPRE limit=1
 * DENTRO do processo: 1 browser + 1 page + 1 userDataDir por worker.
 * Host multi-worker: N workers => N userDataDir (city-collector-shards/wN).
 * Concorrencia >1 no MESMO perfil = Chromium Code 21.
 */
function createLimitedQueue(maxConcurrent = 1) {
  const limit = Math.max(1, Number(maxConcurrent || 1) || 1);
  const queue = [];
  let inFlight = 0;
  const runNext = () => {
    if (inFlight >= limit) return;
    const next = queue.shift();
    if (!next) return;
    inFlight += 1;
    Promise.resolve()
      .then(() => next.fn())
      .then((out) => next.resolve(out))
      .catch((err) => next.reject(err))
      .finally(() => {
        inFlight = Math.max(0, inFlight - 1);
        runNext();
      });
  };
  const enqueue = (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
  enqueue.getDepth = () => queue.length + inFlight;
  enqueue.getInFlight = () => inFlight;
  enqueue.getWaiting = () => queue.length;
  return enqueue;
}

function isChromiumLaunchFailure(err) {
  const msg = String((err && err.message) || err || "");
  if (!msg) return false;
  return (
    /Failed to launch the browser process/i.test(msg) ||
    /Code:\s*21\b/i.test(msg) ||
    /SingletonLock/i.test(msg) ||
    /The browser is already running/i.test(msg) ||
    /user data directory is already in use/i.test(msg) ||
    /browser has disconnected/i.test(msg) ||
    /Target closed/i.test(msg) ||
    /Session closed/i.test(msg)
  );
}

function taskkillPidTreeWin(pid) {
  const n = Number(pid || 0) || 0;
  if (!(n > 0) || process.platform !== "win32") return false;
  try {
    execFileSync("taskkill", ["/PID", String(n), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lista PIDs chrome.exe cujo CommandLine aponta para este userDataDir.
 * Soberania: so mata o perfil do collector — nunca chrome das contas Messenger.
 * Boundary-safe: "...\w1" nao casa "...\w12"; "...\collector" nao casa "...\collector-w2".
 */
function listChromePidsForUserDataDirWin(userDataDir) {
  if (process.platform !== "win32") return [];
  const dir = String(userDataDir || "").trim();
  if (!dir) return [];
  const needle = dir.replace(/\//g, "\\").replace(/\\+$/g, "");
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$needle = ${JSON.stringify(needle)}`,
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" |",
    "  Where-Object {",
    "    if (-not $_.CommandLine) { return $false }",
    "    $cl = [string]$_.CommandLine",
    "    $i = $cl.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase)",
    "    if ($i -lt 0) { return $false }",
    "    $after = $i + $needle.Length",
    "    if ($after -ge $cl.Length) { return $true }",
    "    $ch = $cl[$after]",
    "    # Fim de path / aspas / espaco — nao sufixo alfanumerico nem '-' (siblings).",
    "    return ($ch -eq [char]'\\' -or $ch -eq [char]'/' -or $ch -eq [char]'\"' -or [char]::IsWhiteSpace($ch))",
    "  } |",
    "  Select-Object -ExpandProperty ProcessId",
  ].join(" ");
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 }
    );
    return String(out || "")
      .split(/\r?\n/)
      .map((x) => Number(String(x).trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/** Mata zumbis Chrome do perfil do collector (Code 21 / SingletonLock). */
function killZombieChromeForUserDataDir(userDataDir) {
  const dir = String(userDataDir || "").trim();
  if (!dir) return { killed: 0, pids: [] };
  const pids = [];
  // Preferencia: helper enterprise do host (mesma arma das contas).
  try {
    const bh = require("./browser.js");
    if (typeof bh.getChromeProfilePids === "function") {
      const listed = bh.getChromeProfilePids(dir) || [];
      for (const pid of listed) {
        const n = Number(pid || 0) || 0;
        if (n > 0) pids.push(n);
      }
    }
    if (typeof bh.killChromeProfileProcesses === "function") {
      bh.killChromeProfileProcesses(dir);
    }
  } catch (_) {}
  // Fallback soberano Windows (nao depende do browser.js).
  if (process.platform === "win32") {
    try {
      for (const pid of listChromePidsForUserDataDirWin(dir)) {
        if (!pids.includes(pid)) pids.push(pid);
      }
    } catch (_) {}
    let killed = 0;
    for (const pid of pids) {
      if (taskkillPidTreeWin(pid)) killed += 1;
    }
    // Segunda passada: ainda sobrou?
    try {
      const still = listChromePidsForUserDataDirWin(dir);
      for (const pid of still) {
        if (taskkillPidTreeWin(pid)) killed += 1;
        if (!pids.includes(pid)) pids.push(pid);
      }
    } catch (_) {}
    return { killed, pids };
  }
  return { killed: pids.length ? 1 : 0, pids };
}

/**
 * Remove locks orfaos do perfil unico do collector
 * (Chrome morto deixou Singleton* / DevToolsActivePort).
 */
function clearOrphanChromeProfileLocks(userDataDir) {
  const base = String(userDataDir || "").trim();
  if (!base) return { cleared: [] };
  const cleared = [];
  const names = [
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
    "lockfile",
  ];
  for (const name of names) {
    const fp = path.join(base, name);
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        cleared.push(name);
      }
    } catch (_) {}
  }
  // Symlink/junction SingletonLock no Windows as vezes e reparse point
  try {
    const lockPath = path.join(base, "SingletonLock");
    if (fs.existsSync(lockPath)) {
      try { fs.lstatSync(lockPath); fs.unlinkSync(lockPath); cleared.push("SingletonLock_retry"); } catch (_) {}
    }
  } catch (_) {}
  return { cleared };
}

function logTriagemCollectorReclaim(ctx = {}) {
  appendForensicTriagemLine({
    ts: Date.now(),
    tag: "TRIAGEM_DOM",
    msg: "city_collector_profile_reclaim",
    ctx: {
      mode: String((ctx && ctx.mode) || "").slice(0, 40) || null,
      killed: Number((ctx && ctx.killed) || 0) || 0,
      locks: Array.isArray(ctx && ctx.locks) ? ctx.locks.slice(0, 12) : [],
      reason: String((ctx && ctx.reason) || "").slice(0, 120) || null,
      launch_generation: Number((ctx && ctx.launch_generation) || 0) || 0,
    },
  });
}

function extractMarketplaceItemId(pathname) {
  const m = String(pathname || "").match(/\/marketplace\/item\/([0-9A-Za-z_-]+)/i);
  return m && m[1] ? String(m[1]).trim() : "";
}

function normalizeItemLink(raw) {
  const input = String(raw || "").replace(/&amp;/gi, "&").trim();
  if (!input) return "";
  // Nunca aceitar sentinel / hub / login genérico como "link de anúncio".
  if (/link\s*n[aã]o\s*coletado/i.test(input)) return "";
  try {
    const parsed = input.startsWith("http")
      ? new URL(input)
      : input.startsWith("/")
        ? new URL(input, "https://www.facebook.com")
        : null;
    if (!parsed) return "";
    const host = String(parsed.hostname || "").toLowerCase();
    if (host && !(host.includes("facebook.com") || host.includes("fb.com") || host.includes("messenger.com"))) {
      return "";
    }

    let itemId = extractMarketplaceItemId(parsed.pathname);
    // login/?next=%2Fmarketplace%2Fitem%2F123 → recupera o item; next=/marketplace/ sozinho → lixo.
    if (!itemId && /\/login\b/i.test(parsed.pathname)) {
      const nextRaw = String(parsed.searchParams.get("next") || "").trim();
      if (nextRaw) {
        let decoded = nextRaw;
        try {
          decoded = decodeURIComponent(nextRaw);
        } catch (_) {}
        try {
          const nextUrl = decoded.startsWith("http")
            ? new URL(decoded)
            : new URL(decoded.startsWith("/") ? decoded : `/${decoded}`, "https://www.facebook.com");
          itemId = extractMarketplaceItemId(nextUrl.pathname);
        } catch (_) {}
      }
    }
    if (!itemId) return "";
    return `https://www.facebook.com/marketplace/item/${itemId}/`;
  } catch {
    return "";
  }
}

/**
 * Depois do goto: Facebook pode hard-redirect pra login/?next=/marketplace/
 * (sem item) — aí NÃO existe DOM do anúncio atrás do modal. Detecta e falha cedo.
 */
function classifyListingNavUrl(href, expectedItemId) {
  const raw = String(href || "").trim();
  const expectId = String(expectedItemId || "").trim();
  if (!raw) return { ok: false, kind: "empty_url", error: "city_collector_nav_url_empty" };
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, kind: "invalid_url", error: "city_collector_nav_url_invalid" };
  }
  const path = String(parsed.pathname || "");
  const onItemId = extractMarketplaceItemId(path);
  if (onItemId) {
    if (expectId && onItemId !== expectId) {
      return {
        ok: false,
        kind: "wrong_item",
        error: "city_collector_nav_wrong_item",
        item_id: onItemId,
        href: raw.slice(0, 300),
      };
    }
    return { ok: true, kind: "item_page", item_id: onItemId, href: raw.slice(0, 300) };
  }

  if (/\/login\b/i.test(path)) {
    const nextRaw = String(parsed.searchParams.get("next") || "").trim();
    let decoded = nextRaw;
    try {
      decoded = decodeURIComponent(nextRaw);
    } catch (_) {}
    let nextItemId = "";
    try {
      if (decoded) {
        const nextUrl = decoded.startsWith("http")
          ? new URL(decoded)
          : new URL(decoded.startsWith("/") ? decoded : `/${decoded}`, "https://www.facebook.com");
        nextItemId = extractMarketplaceItemId(nextUrl.pathname);
      }
    } catch (_) {}
    if (nextItemId && (!expectId || nextItemId === expectId)) {
      // Interstitial de login ainda apontando pro item — dá pra tentar ler DOM atrás.
      return {
        ok: true,
        kind: "login_interstitial_with_item",
        item_id: nextItemId,
        href: raw.slice(0, 300),
        soft_login: true,
      };
    }
    // Caso forense: login/?next=%2Fmarketplace%2F — página morta pra cidade.
    return {
      ok: false,
      kind: "hard_login_redirect",
      error: "city_collector_hard_login_redirect",
      href: raw.slice(0, 300),
      next: decoded ? String(decoded).slice(0, 180) : null,
    };
  }

  if (/\/marketplace\/?$/i.test(path) || /\/marketplace\/?$/i.test(path.replace(/\/+$/, ""))) {
    return {
      ok: false,
      kind: "marketplace_hub",
      error: "city_collector_nav_marketplace_hub",
      href: raw.slice(0, 300),
    };
  }

  return {
    ok: false,
    kind: "unexpected_page",
    error: "city_collector_nav_not_item_page",
    href: raw.slice(0, 300),
  };
}

function sanitizeCity(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[:\-]\s*/, "")
    .trim()
    .slice(0, 80);
}

function toTitleCaseCityName(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (["de", "da", "do", "das", "dos", "e"].includes(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(" ")
    .trim();
}

const STATE_NAME_TO_UF = new Map([
  ["acre", "AC"],
  ["alagoas", "AL"],
  ["amapa", "AP"],
  ["amazonas", "AM"],
  ["bahia", "BA"],
  ["ceara", "CE"],
  ["distrito federal", "DF"],
  ["espirito santo", "ES"],
  ["goias", "GO"],
  ["maranhao", "MA"],
  ["mato grosso", "MT"],
  ["mato grosso do sul", "MS"],
  ["minas gerais", "MG"],
  ["para", "PA"],
  ["paraiba", "PB"],
  ["parana", "PR"],
  ["pernambuco", "PE"],
  ["piaui", "PI"],
  ["rio de janeiro", "RJ"],
  ["rio grande do norte", "RN"],
  ["rio grande do sul", "RS"],
  ["rondonia", "RO"],
  ["roraima", "RR"],
  ["santa catarina", "SC"],
  ["sao paulo", "SP"],
  ["sergipe", "SE"],
  ["tocantins", "TO"],
]);
const BR_VALID_UF = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA",
  "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN",
  "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

function normalizeStateKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const CITY_NOISE_RE = /\b(enviar|mensagem|message|save|share|anunciado|listed|detalhe|detalhes|condi[cç][aã]o|condi[cç][oõ]es|razo[aá]veis|selec[cç][oõ]es|hoje|mini?atura|ver mais|facebook|localiza[cç][aã]o|location|aproximada|approximate|dias?|hours?|horas?|minutos?|weeks?|semanas?|months?|meses?|ago|classificado|usado|nova?)\b/i;

const GEO_COMMA_RE = /\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{2,50})\s*,\s*([A-Za-z]{2})\b/gi;
const GEO_PAREN_RE = /\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{2,50})\s*\(\s*([A-Za-z]{2})\s*\)/gi;

/**
 * Limpa so ruido de rotulo "condicoes" colado no DOM.
 * NAO remove Novo/Seminovo/Usado — existem cidades (Novo Hamburgo) e a comunhao dual
 * resolve poluicao por identidade nos dois blocos, nao por strip.
 */
function stripMarketplaceConditionNoise(raw) {
  return String(raw || "")
    .replace(/condi[cç][oõ]es?\s*razo[aá]veis/gi, " ")
    .replace(/boas?\s*condi[cç][oõ]es?/gi, " ")
    .replace(/condi[cç][aã]o\s*[:\-–]?\s*/gi, " ")
    .replace(/usado\s*[—\-–]\s*em\s*boas?\s*condi[cç][oõ]es?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normCityUfKey(built) {
  return String(built || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normLooseText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Fragmento canonico "cidade, uf" / "cidade (uf)" para bater identidade nos dois blocos. */
function cityFragmentVariants(cityRaw, ufRaw) {
  const city = String(cityRaw || "").replace(/\s+/g, " ").trim();
  const uf = String(ufRaw || "").trim().toUpperCase();
  if (!city || !/^[A-Z]{2}$/.test(uf)) return [];
  return [
    `${city}, ${uf}`,
    `${city} (${uf})`,
    `${city},${uf}`,
  ];
}

/** True se o fragmento da cidade aparece de forma contigúa no blob (identidade literal). */
function blobContainsCityFragment(blob, cityRaw, ufRaw) {
  const hay = normLooseText(blob);
  if (!hay) return false;
  for (const frag of cityFragmentVariants(cityRaw, ufRaw)) {
    const needle = normLooseText(frag);
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}

/**
 * Extrai so os hits do padrao Anunciado/Listed: "em|in Cidade, UF".
 * Esse e o texto geografico limpo do Marketplace — a cidade que se repete nos dois lugares.
 */
function collectEmInGeoHitsFromBlob(raw) {
  const chunk = String(raw || "").replace(/\s+/g, " ").trim();
  const hits = [];
  if (!chunk) return hits;

  const emCities = chunk.matchAll(
    /\b(?:em|in)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,50}?(?:,\s*[A-Za-z]{2}|\s*\(\s*[A-Za-z]{2}\s*\)))/gi
  );
  for (const em of emCities) {
    const token = String(em[1] || "").trim();
    let cityRaw = "";
    let ufRaw = "";
    const mComma = token.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,50}?)\s*,\s*([A-Za-z]{2})$/i);
    if (mComma) {
      cityRaw = mComma[1];
      ufRaw = mComma[2];
    } else {
      const mParen = token.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,50}?)\s*\(\s*([A-Za-z]{2})\s*\)$/i);
      if (mParen) {
        cityRaw = mParen[1];
        ufRaw = mParen[2];
      }
    }
    const built = buildCityUf(cityRaw, ufRaw);
    if (!built) continue;
    hits.push({
      built,
      norm: normCityUfKey(built),
      cityRaw: String(cityRaw || "").replace(/\s+/g, " ").trim(),
      ufRaw: String(ufRaw || "").trim().toUpperCase(),
      from_em_in: true,
    });
  }
  return hits;
}

/** Extrai todos os Cidade (UF) plausiveis de um blob (sufixos da direita). Sem strip de Novo/Seminovo. */
function collectGeoHitsFromBlob(raw) {
  const chunk = String(raw || "").replace(/\s+/g, " ").trim();
  const hits = [];
  if (!chunk) return hits;

  const pushHit = (cityRaw, ufRaw, extra = {}) => {
    const built = buildCityUf(cityRaw, ufRaw);
    if (!built) return;
    hits.push({
      built,
      norm: normCityUfKey(built),
      cityRaw: String(cityRaw || "").replace(/\s+/g, " ").trim(),
      ufRaw: String(ufRaw || "").trim().toUpperCase(),
      fragment: `${String(cityRaw || "").replace(/\s+/g, " ").trim()}, ${String(ufRaw || "").trim().toUpperCase()}`,
      ...extra,
    });
  };

  const markRe = /,\s*([A-Za-z]{2})\b|\(\s*([A-Za-z]{2})\s*\)/g;
  let um;
  while ((um = markRe.exec(chunk)) !== null) {
    const uf = String(um[1] || um[2] || "").toUpperCase();
    if (!BR_VALID_UF.has(uf)) continue;
    const before = chunk.slice(0, um.index).trim();
    const tail = before.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*){0,6})\s*$/);
    if (!tail || !tail[1]) continue;
    const words = tail[1].split(/\s+/).filter(Boolean);
    for (let n = 1; n <= Math.min(5, words.length); n += 1) {
      pushHit(words.slice(-n).join(" "), uf);
    }
  }

  for (const hit of collectEmInGeoHitsFromBlob(chunk)) {
    pushHit(hit.cityRaw, hit.ufRaw, { from_em_in: true });
  }

  return hits;
}

/**
 * Comunhao identica Anunciado (A) ∩ Localizacao (B):
 * pega a cidade do "em|in Cidade, UF" do Anunciado e exige o MESMO fragmento
 * contigúo no bloco Loc. Nao usa "mais longo", nao stripa Novo/Seminovo.
 *
 * Ex: A="... em Novo Hamburgo, RS" + B="seminovo Novo Hamburgo, RS"
 *     → identico = Novo Hamburgo (RS)
 * Ex: A="... em Rio Branco, AC ... seminovo Rio Branco, AC" + B=igual
 *     → identico = Rio Branco (AC) (vem do em/in, nao do seminovo*)
 */
function resolveDualIntersectionCommunion(candidates, forensicCtx = null) {
  const list = Array.isArray(candidates) ? candidates : [];
  const blockA = list.filter((c) => /^anunciado_/i.test(String((c && c.source) || "")));
  const blockB = list.filter((c) => /^loc_/i.test(String((c && c.source) || "")));
  if (!blockA.length || !blockB.length) return null;

  const blockAText = blockA.map((c) => String((c && c.value) || "").trim()).filter(Boolean).join(" | ");
  const blockBText = blockB.map((c) => String((c && c.value) || "").trim()).filter(Boolean).join(" | ");
  const forensic = forensicCtx && typeof forensicCtx === "object" ? forensicCtx : {};

  let finalExtracted = null;

  // 1) Vitoria: cidade do "em|in" do Anunciado, identica (substring) no bloco Loc
  const emHits = [];
  const seenEm = new Set();
  for (const c of blockA) {
    for (const hit of collectEmInGeoHitsFromBlob(c && c.value)) {
      if (seenEm.has(hit.norm)) continue;
      seenEm.add(hit.norm);
      emHits.push(hit);
    }
  }
  for (const hit of emHits) {
    if (!blobContainsCityFragment(blockBText, hit.cityRaw, hit.ufRaw)) continue;
    // tambem precisa existir no proprio A (sempre verdade pro em/in, mas fecha o contrato)
    if (!blobContainsCityFragment(blockAText, hit.cityRaw, hit.ufRaw)) continue;
    finalExtracted = hit.built;
    break;
  }

  // 2) Fallback sem "em|in": fragmento Cidade,UF que aparece identico nos DOIS textos.
  //    Se A contem B e B contem A (ex: Rio Branco ⊂ Seminovo Rio Branco), fica o que
  //    NAO e extensao poluida: preferimos o hit cujo fragmento e substring propria
  //    de outro comum (o nucleo identico), nao o superstring.
  if (!finalExtracted) {
    const commons = [];
    const seen = new Set();
    for (const c of blockA) {
      for (const hit of collectGeoHitsFromBlob(c && c.value)) {
        if (!blobContainsCityFragment(blockAText, hit.cityRaw, hit.ufRaw)) continue;
        if (!blobContainsCityFragment(blockBText, hit.cityRaw, hit.ufRaw)) continue;
        if (seen.has(hit.norm)) continue;
        seen.add(hit.norm);
        commons.push(hit);
      }
    }
    if (commons.length) {
      // Nucleo identico: entre commons, preferir o que e substring de outro comum
      // (Rio Branco dentro de Seminovo Rio Branco) — NUNCA o mais longo.
      const scored = commons.map((hit) => {
        const frag = normLooseText(`${hit.cityRaw}, ${hit.ufRaw}`);
        let containedInOthers = 0;
        for (const other of commons) {
          if (other.norm === hit.norm) continue;
          const otherFrag = normLooseText(`${other.cityRaw}, ${other.ufRaw}`);
          if (otherFrag.includes(frag)) containedInOthers += 1;
        }
        return { hit, containedInOthers, len: frag.length };
      });
      scored.sort((a, b) => {
        if (b.containedInOthers !== a.containedInOthers) return b.containedInOthers - a.containedInOthers;
        return a.len - b.len; // empate: menor fragmento (nucleo), nao o mais longo
      });
      finalExtracted = scored[0].hit.built;
    }
  }

  try {
    logTriagemDomCityCommunion({
      account_login: forensic.account_login || null,
      thread_key: forensic.thread_key || null,
      item_link: forensic.item_link || null,
      block_a: blockAText,
      block_b: blockBText,
      final_extracted: finalExtracted,
    });
  } catch (_) {}

  if (!finalExtracted) return null;
  return {
    cidade: finalExtracted,
    city_source: "dual_intersection_communion",
    block_a: blockAText,
    block_b: blockBText,
  };
}

function isPlausibleCityName(cityRaw) {
  const city = String(cityRaw || "").replace(/\s+/g, " ").trim();
  if (!city) return false;
  if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{0,80}$/.test(city)) return false;
  const cityKey = city
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (CITY_NOISE_RE.test(cityKey)) return false;
  if (/\b(em|in|ha|ago)\b/.test(cityKey)) return false;
  // Colado tipo "razoaveisjuazeiro" / "condicoesjuazeiro"
  if (/razoaveis|condicoes|boascond/i.test(cityKey.replace(/\s+/g, ""))) return false;
  const words = city.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;
  // Fragmentos tipo "do Norte" / "da Serra" sem cidade completa
  const first = String(words[0] || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (/^(do|da|de|dos|das|e|o|a|os|as)$/.test(first) && words.length <= 2) return false;
  return true;
}

/** Resolve Cidade+UF a partir do miolo capturado: sufixos da direita no DOM. */
function resolveCityUfCapture(cityRaw, ufRaw) {
  const uf = String(ufRaw || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf) || !BR_VALID_UF.has(uf)) return "";
  const words = String(cityRaw || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "";

  const firstKey = String(words[0] || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  // Fragmento incompleto ("do Norte") — descartar
  if (/^(do|da|de|dos|das)$/.test(firstKey) && words.length <= 2) return "";

  let best = "";
  for (let n = 1; n <= Math.min(5, words.length); n += 1) {
    const built = buildCityUf(words.slice(-n).join(" "), uf);
    if (built) best = built;
  }
  return best;
}

function buildCityUf(cityRaw, ufRaw) {
  const city = toTitleCaseCityName(String(cityRaw || "").trim());
  const uf = String(ufRaw || "").trim().toUpperCase();
  if (!isPlausibleCityName(city)) return "";
  if (!/^[A-Z]{2}$/.test(uf) || !BR_VALID_UF.has(uf)) return "";
  return `${city} (${uf})`.slice(0, 80);
}

/**
 * LEI 1+2: ancora incondicional em "localizacao" / "localizacao e aproximada".
 * Nao depende do caractere medio (·). Pega ate 80 chars ANTES do marcador e aplica regex geografica.
 */
function extractCityFromLocationAnchorText(bodyText) {
  const body = String(bodyText || "").replace(/\s+/g, " ").trim();
  if (!body) return "";

  const markers = [
    /localiza[cç][aã]o\s*é\s*aproximada/gi,
    /approximate\s+location/gi,
    /a\s+localiza[cç][aã]o\b/gi,
    /localiza[cç][aã]o\b/gi,
  ];

  const tryChunk = (chunk0) => {
    const chunk = stripMarketplaceConditionNoise(chunk0);
    if (!chunk) return "";

    // LEI 2: ancora no ultimo terminal ", UF" / "(UF)" do bloco (perto do marcador)
    const ufMarks = [];
    const markRe = /,\s*([A-Za-z]{2})\b|\(\s*([A-Za-z]{2})\s*\)/g;
    let um;
    while ((um = markRe.exec(chunk)) !== null) {
      const uf = String(um[1] || um[2] || "").toUpperCase();
      if (!BR_VALID_UF.has(uf)) continue;
      ufMarks.push({ index: um.index, uf });
    }
    for (let i = ufMarks.length - 1; i >= 0; i -= 1) {
      const mark = ufMarks[i];
      const before = chunk.slice(0, mark.index).trim();
      const tail = before.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*){0,6})\s*$/);
      if (!tail || !tail[1]) continue;
      const built = resolveCityUfCapture(tail[1], mark.uf);
      if (built) return built;
    }

    // Regex geografica no chunk
    GEO_COMMA_RE.lastIndex = 0;
    let m;
    let lastComma = null;
    while ((m = GEO_COMMA_RE.exec(chunk)) !== null) lastComma = m;
    if (lastComma) {
      const built = resolveCityUfCapture(lastComma[1], lastComma[2]);
      if (built) return built;
    }
    GEO_PAREN_RE.lastIndex = 0;
    let lastParen = null;
    while ((m = GEO_PAREN_RE.exec(chunk)) !== null) lastParen = m;
    if (lastParen) {
      const built = resolveCityUfCapture(lastParen[1], lastParen[2]);
      if (built) return built;
    }

    return "";
  };

  for (const re of markers) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const chunk = body.slice(Math.max(0, m.index - 80), m.index);
      const hit = tryChunk(chunk);
      if (hit) return hit;
    }
  }
  return "";
}

/** Extrai Cidade (UF) de qualquer blob — nao exige match da string inteira nem do ·. */
function normalizeCityUfLabel(raw) {
  const s0 = stripMarketplaceConditionNoise(String(raw || "").replace(/\s+/g, " ").trim());
  if (!s0) return "";

  // 1) Ancora por palavra localizacao (sem depender de ·)
  const fromAnchor = extractCityFromLocationAnchorText(s0);
  if (fromAnchor) return fromAnchor;

  // 2) Anunciado <miolo livre> em Cidade, UF — ultimo em/in
  if (/\banunciado\b/i.test(s0) || /\blisted\b/i.test(s0)) {
    const emCities = Array.from(s0.matchAll(
      /\b(?:em|in)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,50}?(?:,\s*[A-Za-z]{2}|\s*\(\s*[A-Za-z]{2}\s*\)))/gi
    ));
    for (let i = emCities.length - 1; i >= 0; i -= 1) {
      const token = String(emCities[i][1] || "").trim();
      const mComma = token.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,50}?)\s*,\s*([A-Za-z]{2})$/i);
      if (mComma) {
        const built = buildCityUf(mComma[1], mComma[2]);
        if (built) return built;
      }
      const mParen = token.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\- ]{1,50}?)\s*\(\s*([A-Za-z]{2})\s*\)$/i);
      if (mParen) {
        const built = buildCityUf(mParen[1], mParen[2]);
        if (built) return built;
      }
    }
  }

  // 3) Scan ", UF" / "(UF)" com walk-back de palavras no DOM
  const ufRe = /,\s*([A-Za-z]{2})\b|\(\s*([A-Za-z]{2})\s*\)/g;
  let m;
  let best = "";
  while ((m = ufRe.exec(s0)) !== null) {
    const uf = String(m[1] || m[2] || "").toUpperCase();
    if (!BR_VALID_UF.has(uf)) continue;
    const before = stripMarketplaceConditionNoise(s0.slice(Math.max(0, m.index - 70), m.index));
    const tail = before.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’.\-]*){0,6})\s*$/);
    if (!tail || !tail[1]) continue;
    const built = resolveCityUfCapture(tail[1], uf);
    if (built) best = built;
  }
  return best || "";
}

function candidateSourcePriority(source) {
  const s = String(source || "").toLowerCase();
  if (s.startsWith("loc_")) return 0;
  if (s.startsWith("anunciado_")) return 1;
  if (s.startsWith("map_")) return 2;
  if (s.startsWith("marketplace_city_link")) return 3;
  if (s.startsWith("body_")) return 4;
  if (s.startsWith("semantic_")) return 5;
  return 9;
}

async function extractCityFromListingPage(page, {
  maxAttempts = 12,
  retryIntervalMs = 250,
  scanLimit = 320,
  thread_key = null,
  account_login = null,
  item_link = null,
} = {}) {
  if (!page) return { cidade: null, error: "city_page_missing" };
  const attempts = Math.max(1, Math.min(20, Number(maxAttempts || 12) || 12));
  const intervalMs = Math.max(80, Math.min(700, Number(retryIntervalMs || 250) || 250));
  const nodeLimit = Math.max(80, Math.min(500, Number(scanLimit || 320) || 320));
  const forensic = {
    thread_key: String(thread_key || "").slice(0, 80) || null,
    account_login: String(account_login || "").slice(0, 80) || null,
    item_link: String(item_link || "").slice(0, 300) || null,
  };
  let lastDiag = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const out = await page.evaluate((maxNodes) => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const bodyText = clean(document.body && document.body.innerText ? document.body.innerText : "");
      const candidates = [];
      const loginWall = !!(
        document.querySelector("#login_popup_cta_form")
        || document.querySelector('form[action*="/login/"]')
        || /ver mais no facebook/i.test(bodyText)
      );

      const push = (v, source) => {
        const c = clean(v);
        if (!c || c.length > 200) return;
        candidates.push({ value: c, source });
      };

      // LEI 1: fatias de 80 chars ANTES de cada marcador de localizacao (sem depender de ·)
      const markerRes = [
        /localiza[cç][aã]o\s*é\s*aproximada/gi,
        /approximate\s+location/gi,
        /a\s+localiza[cç][aã]o\b/gi,
        /localiza[cç][aã]o\b/gi,
      ];
      for (const re of markerRes) {
        re.lastIndex = 0;
        let lm;
        while ((lm = re.exec(bodyText)) !== null) {
          const slice = bodyText.slice(Math.max(0, lm.index - 80), lm.index);
          push(slice, "loc_anchor_80");
        }
      }

      // Anunciado/Listed (Bloco A): janela apos a palavra
      {
        const reAn = /\b(?:anunciado|listed)\b/gi;
        let am;
        while ((am = reAn.exec(bodyText)) !== null) {
          push(bodyText.slice(am.index, am.index + 140), "anunciado_window");
        }
      }

      // Mapa / aria-label
      const mapBlocks = Array.from(document.querySelectorAll(
        '[aria-label*="localiza"], [aria-label*="Localiza"], [aria-label*="location"], [aria-label*="Location"]'
      )).slice(0, 40);
      for (const el of mapBlocks) {
        push(el.textContent || "", "map_text");
        try { push(el.getAttribute("aria-label") || "", "map_aria"); } catch (_) {}
      }

      // Links curtos marketplace (nao cards com R$)
      const cityLinks = Array.from(document.querySelectorAll('a[href*="/marketplace/"][role="link"]'))
        .slice(0, Math.max(1, Number(maxNodes || 320) || 320));
      for (const el of cityLinks) {
        const t = clean(el.textContent || "");
        if (!t || t.length > 60) continue;
        if (/R\$|classificado\s+\d+/i.test(t)) continue;
        if (!/,\s*[A-Za-z]{2}\s*$/.test(t) && !/\(\s*[A-Za-z]{2}\s*\)\s*$/.test(t)) continue;
        push(t, "marketplace_city_link");
      }

      // Body inteiro por ultimo (ancora no Node usa isso)
      push(bodyText.slice(0, 4000), "body_head");

      return {
        bodyText,
        candidates,
        loginWall,
        hasLocalizacao: /localiza/i.test(bodyText),
        hasAnunciado: /\banunciado\b/i.test(bodyText),
      };
    }, nodeLimit).catch(() => ({ bodyText: "", candidates: [], loginWall: false }));

    const payload = out && typeof out === "object" ? out : { bodyText: "", candidates: [] };
    const candidates = Array.isArray(payload.candidates) ? payload.candidates.slice() : [];

    // 1) Intersecao de comunhao identica Anunciado (A) ∩ Localizacao (B)
    const communion = resolveDualIntersectionCommunion(candidates, forensic);
    if (communion && communion.cidade) {
      try {
        log(
          `comunhao dual cidade="${communion.cidade}" attempt=${attempt}` +
          ` login_wall=${payload.loginWall ? "sim" : "nao"}` +
          ` thread=${forensic.thread_key || "n/a"}`
        );
      } catch (_) {}
      return {
        cidade: communion.cidade,
        city_source: "dual_intersection_communion",
        attempt,
        login_wall: !!payload.loginWall,
      };
    }

    // 2) Via unica: ancora laser em localizacao no body (sem strip Novo/Seminovo)
    const fromBodyAnchor = extractCityFromLocationAnchorText(payload.bodyText || "");
    if (fromBodyAnchor) {
      try {
        logTriagemDomCityCommunion({
          ...forensic,
          block_a: "",
          block_b: String(payload.bodyText || "").slice(0, 400),
          final_extracted: fromBodyAnchor,
        });
      } catch (_) {}
      return {
        cidade: fromBodyAnchor,
        city_source: "loc_anchor_body",
        attempt,
        login_wall: !!payload.loginWall,
      };
    }

    // 3) Demais candidatos (prioridade loc > anunciado > mapa > link)
    candidates.sort((a, b) => candidateSourcePriority(a && a.source) - candidateSourcePriority(b && b.source));

    for (const cand of candidates) {
      const v = normalizeCityUfLabel(cand && cand.value);
      if (!v) continue;
      if (payload.loginWall) {
        try {
          log(`cidade lida atras do login wall source=${cand.source || "?"} cidade="${v}" attempt=${attempt}`);
        } catch (_) {}
      }
      try {
        logTriagemDomCityCommunion({
          ...forensic,
          block_a: /^anunciado_/i.test(String((cand && cand.source) || "")) ? String(cand.value || "") : "",
          block_b: /^loc_/i.test(String((cand && cand.source) || "")) ? String(cand.value || "") : String(cand.value || ""),
          final_extracted: v,
        });
      } catch (_) {}
      return {
        cidade: v,
        city_source: String((cand && cand.source) || "collector_unknown"),
        attempt,
        login_wall: !!payload.loginWall,
      };
    }
    lastDiag = {
      login_wall: !!payload.loginWall,
      has_localizacao: !!payload.hasLocalizacao,
      has_anunciado: !!payload.hasAnunciado,
      candidates_count: candidates.length,
      attempt,
    };
    if (attempt < attempts) {
      await sleep(intervalMs);
    }
  }
  return {
    cidade: null,
    error: "city_not_found_in_dom",
    login_wall: !!(lastDiag && lastDiag.login_wall),
    has_localizacao: !!(lastDiag && lastDiag.has_localizacao),
    has_anunciado: !!(lastDiag && lastDiag.has_anunciado),
    candidates_count: Number((lastDiag && lastDiag.candidates_count) || 0) || 0,
    attempt: Number((lastDiag && lastDiag.attempt) || attempts) || attempts,
  };
}

async function dismissLoginOverlay(page) {
  if (!page) return { closed: false, escaped: false };
  let closed = false;
  try {
    closed = await page.evaluate(() => {
      const isVisible = (el) => {
        try {
          if (!el) return false;
          const st = window.getComputedStyle(el);
          if (!st) return false;
          if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity || "1") === 0) return false;
          const r = el.getBoundingClientRect();
          return !!(r && r.width > 4 && r.height > 4);
        } catch (_) {
          return false;
        }
      };
      const tryClick = (el) => {
        if (!el || !isVisible(el)) return false;
        try {
          el.click();
          return true;
        } catch (_) {
          try {
            el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            return true;
          } catch (_) {
            return false;
          }
        }
      };

      // Prioriza o modal "Ver mais no Facebook" / login_popup_cta_form
      const loginForm = document.querySelector("#login_popup_cta_form")
        || document.querySelector('form[action*="/login/"]');
      if (loginForm) {
        const dialog = loginForm.closest('[role="dialog"], [aria-modal="true"]') || loginForm.parentElement;
        if (dialog) {
          const closeInDialog = dialog.querySelector(
            '[aria-label="Fechar"], [aria-label="Close"], [aria-label="fechar"], [aria-label="close"]'
          );
          if (tryClick(closeInDialog)) return true;
        }
      }

      const selectors = [
        '[role="dialog"] [aria-label="Fechar"]',
        '[role="dialog"] [aria-label="Close"]',
        '[aria-modal="true"] [aria-label="Fechar"]',
        '[aria-modal="true"] [aria-label="Close"]',
        'div[aria-label="Fechar"][role="button"]',
        'div[aria-label="Close"][role="button"]',
        '[aria-label="Fechar"][role="button"]',
        '[aria-label="Close"][role="button"]',
      ];
      const nodes = [];
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) nodes.push(el);
        } catch (_) {}
      }
      for (const el of nodes) {
        if (tryClick(el)) return true;
      }
      return false;
    }).catch(() => false);
  } catch (_) {
    closed = false;
  }

  // Sempre tenta Esc: no DOM real o X às vezes não fecha de primeira.
  let escaped = false;
  try {
    await page.keyboard.press("Escape");
    escaped = true;
  } catch (_) {}

  if (closed || escaped) {
    await sleep(randomBetween(350, 750));
  }
  return { closed, escaped };
}

async function dismissLoginOverlayPatient(page, { rounds = 3 } = {}) {
  if (!page) return { closed: false, escaped: false, rounds: 0 };
  const maxRounds = Math.max(1, Math.min(5, Number(rounds || 3) || 3));
  let closed = false;
  let escaped = false;
  for (let i = 0; i < maxRounds; i += 1) {
    const out = await dismissLoginOverlay(page);
    if (out && out.closed) closed = true;
    if (out && out.escaped) escaped = true;
    // Apos Esc/X, espera a pagina estabilizar antes da proxima rodada/scrape.
    await sleep(randomBetween(800, 1500));
  }
  return { closed, escaped, rounds: maxRounds };
}

async function waitForListingHints(page, timeoutMs) {
  if (!page) return;
  const timeout = Math.max(400, Number(timeoutMs || 0) || 1500);
  try {
    await page.waitForFunction(() => {
      const body = String((document.body && document.body.innerText) || "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (!body) return false;
      // Âncoras estáveis (miolo do tempo muda; estas palavras não)
      if (body.includes("localiza")) return true;
      if (body.includes("anunciado") || body.includes("listed")) return true;
      if (body.includes("approximate location")) return true;
      return Boolean(
        document.querySelector(
          'a[href*="/marketplace/"][role="link"] span, [aria-label*="localiza"], [aria-label*="location"], #login_popup_cta_form'
        )
      );
    }, { timeout });
  } catch (_) {}
}

/**
 * Resolve userDataDir do Chrome de raspagem de cidade.
 * - Env explicita ganha.
 * - Worker filho: city-collector-shards/wN (1 browser estavel por shard).
 * - Master / processo unico: city-collector-shards/master.
 */
function resolveCityCollectorUserDataDir() {
  const explicit = String(process.env.VIRTUS_DELTA_CITY_COLLECTOR_USER_DATA_DIR || "").trim();
  if (explicit) return explicit;
  const shardsRoot = path.join(__dirname, "..", "dados", "city-collector-shards");
  const isChild = String(process.env.IS_WORKER_CHILD || "").trim() === "1";
  const shardIdxRaw = String(process.env.WORKER_SHARD_INDEX || "").trim();
  if (isChild && /^\d+$/.test(shardIdxRaw)) {
    return path.join(shardsRoot, `w${Number(shardIdxRaw) + 1}`);
  }
  const statusName = String(process.env.STATUS_FILE_NAME || "").trim();
  const m = statusName.match(/status_node_(\d+)\.json/i);
  if (isChild && m) {
    return path.join(shardsRoot, `w${m[1]}`);
  }
  return path.join(shardsRoot, "master");
}

async function createCollectorRuntime() {
  const userDataDir = resolveCityCollectorUserDataDir();
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
  } catch (_) {}
  const executablePath =
    process.env.CHROME_PATH ||
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe");

  // Default VISÍVEL (headed): dá pra ver o Chrome de raspagem no servidor.
  // Headless só sob demanda: VIRTUS_DELTA_CITY_COLLECTOR_HEADLESS=1
  const headlessEnabled = String(process.env.VIRTUS_DELTA_CITY_COLLECTOR_HEADLESS || "0").trim() === "1";
  const launchTimeoutMs = Math.max(
    8_000,
    Math.min(60_000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_LAUNCH_TIMEOUT_MS || 25_000) || 25_000)
  );
  // 75s default: fila serial + launch + nav sob pressão não pode virar pending cedo demais.
  const jobTimeoutMs = Math.max(
    15_000,
    Math.min(120_000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_JOB_TIMEOUT_MS || 75_000) || 75_000)
  );

  let browser = null;
  let page = null;
  let browserPid = null;
  // LEI: 1 browser por worker (userDataDir isolado). Fila serial in-process.
  // Env antiga (MAX_CONCURRENCY=2) e ignorada de proposito — serial e soberano.
  const enqueue = createLimitedQueue(1);
  let launchPromise = null; // mutex de launch/relaunch
  let launchGeneration = 0;
  let reclaimCount = 0;
  let lastReclaimAt = 0;
  let lastLaunchError = null;
  try {
    log(
      `collector runtime boot userDataDir=${userDataDir}` +
      ` shard=${String(process.env.WORKER_SHARD_INDEX || "master")} pid=${process.pid}`
    );
  } catch (_) {}
  try {
    logTriagemCollectorReclaim({
      mode: "boot",
      killed: 0,
      locks: [],
      reason: "runtime_boot_path",
      launch_generation: 0,
      user_data_dir: userDataDir,
      worker_shard_index: process.env.WORKER_SHARD_INDEX || null,
      pid: process.pid,
    });
  } catch (_) {}
  const cityCacheByItem = new Map(); // itemId -> { cidade, city_source, at }
  const cityCacheTtlMs = Math.max(
    5 * 60 * 1000,
    Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_CACHE_TTL_MS || (2 * 60 * 60 * 1000)) || (2 * 60 * 60 * 1000)
  );
  const cityCacheMax = Math.max(
    200,
    Math.min(5000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_CACHE_MAX || 1200) || 1200)
  );
  let tabGuardAttached = false;
  const launchMaxAttempts = Math.max(
    2,
    Math.min(5, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_LAUNCH_ATTEMPTS || 3) || 3)
  );

  const cityCacheGet = (itemId) => {
    const key = String(itemId || "").trim();
    if (!key) return null;
    const rec = cityCacheByItem.get(key);
    if (!rec) return null;
    const ageMs = Date.now() - (Number(rec.at || 0) || 0);
    if (ageMs > cityCacheTtlMs) {
      cityCacheByItem.delete(key);
      return null;
    }
    return rec;
  };
  const cityCacheSet = (itemId, cidade, city_source) => {
    const key = String(itemId || "").trim();
    const city = String(cidade || "").trim();
    if (!key || !city) return;
    cityCacheByItem.set(key, {
      cidade: city,
      city_source: String(city_source || "collector_cache"),
      at: Date.now()
    });
    if (cityCacheByItem.size > cityCacheMax) {
      const entries = [...cityCacheByItem.entries()]
        .sort((a, b) => (Number(a[1] && a[1].at || 0) || 0) - (Number(b[1] && b[1].at || 0) || 0));
      const toDelete = Math.max(1, cityCacheByItem.size - cityCacheMax);
      for (let i = 0; i < toDelete; i += 1) {
        const oldKey = String(entries[i] && entries[i][0] || "").trim();
        if (oldKey) cityCacheByItem.delete(oldKey);
      }
    }
  };

  async function applySessionCookies(pageRef, sessionCookies) {
    try {
      const p = pageRef;
      if (!p || !Array.isArray(sessionCookies) || !sessionCookies.length) return { applied: 0 };
      const safeCookies = sessionCookies
        .filter((ck) => ck && typeof ck === "object")
        .map((ck) => ({
          name: String(ck.name || "").trim(),
          value: String(ck.value || ""),
          domain: String(ck.domain || "").trim() || ".facebook.com",
          path: String(ck.path || "/"),
          expires: Number(ck.expires || 0) || undefined,
          httpOnly: !!ck.httpOnly,
          secure: ck.secure !== false,
          sameSite: (String(ck.sameSite || "").trim() || undefined),
        }))
        .filter((ck) => !!ck.name);
      if (!safeCookies.length) return { applied: 0 };
      await p.setCookie(...safeCookies);
      return { applied: safeCookies.length };
    } catch {
      return { applied: 0 };
    }
  }

  async function pruneCollectorTabs() {
    try {
      if (!browser || !browser.isConnected || !browser.isConnected()) return;
      const pages = await browser.pages().catch(() => []);
      if (!Array.isArray(pages) || !pages.length) return;
      const primary = page && !page.isClosed() ? page : pages[0];
      page = primary;
      for (const p of pages) {
        if (!p || p === primary) continue;
        try { await p.close({ runBeforeUnload: false }); } catch (_) {}
      }
    } catch (_) {}
  }

  async function pageIsHealthy(pageRef) {
    const p = pageRef;
    if (!p) return false;
    try {
      if (p.isClosed && p.isClosed()) return false;
    } catch {
      return false;
    }
    try {
      const ok = await Promise.race([
        p.evaluate(() => 1).then((v) => v === 1),
        sleep(2_000).then(() => false),
      ]);
      return !!ok;
    } catch {
      return false;
    }
  }

  /**
   * Reclaim soberano do perfil DESTE worker/collector:
   * 1) mata chrome zumbi desse userDataDir (boundary-safe)
   * 2) apaga SingletonLock / DevToolsActivePort
   * 3) settle antes de relaunch
   */
  async function reclaimCollectorProfile({ mode = "soft", reason = "" } = {}) {
    const hard = String(mode || "soft").toLowerCase() === "hard";
    const why = String(reason || "").slice(0, 120);
    let killed = 0;
    let locks = [];
    try {
      const killOut = killZombieChromeForUserDataDir(userDataDir);
      killed = Number(killOut && killOut.killed || 0) || 0;
    } catch (_) {}
    try {
      locks = clearOrphanChromeProfileLocks(userDataDir).cleared || [];
    } catch (_) {
      locks = [];
    }
    reclaimCount += 1;
    lastReclaimAt = Date.now();
    const settleMs = hard
      ? Math.max(1_200, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_HARD_RECLAIM_MS || 1_800) || 1_800)
      : Math.max(400, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_SOFT_RECLAIM_MS || 700) || 700);
    await sleep(settleMs);
    log(
      `collector reclaim mode=${hard ? "hard" : "soft"}` +
      ` killed=${killed} locks=${locks.length ? locks.join(",") : "none"}` +
      ` reason=${why || "n/a"} gen=${launchGeneration}`
    );
    try {
      logTriagemCollectorReclaim({
        mode: hard ? "hard" : "soft",
        killed,
        locks,
        reason: why,
        launch_generation: launchGeneration,
        user_data_dir: userDataDir,
        worker_shard_index: process.env.WORKER_SHARD_INDEX || null,
        pid: process.pid,
      });
    } catch (_) {}
    return { killed, locks, mode: hard ? "hard" : "soft" };
  }

  async function invalidateBrowser(reason, { reclaim = false, reclaimMode = "soft" } = {}) {
    const why = String(reason || "invalidate").slice(0, 120);
    const pidToKill = Number(browserPid || 0) || 0;
    try {
      if (browser) {
        try {
          await Promise.race([
            browser.close().catch(() => {}),
            sleep(2_500),
          ]);
        } catch (_) {}
      }
    } catch (_) {}
    // Puppeteer close as vezes deixa o process vivo — mata a arvore do PID.
    if (pidToKill > 0) {
      try { taskkillPidTreeWin(pidToKill); } catch (_) {}
    }
    browser = null;
    page = null;
    browserPid = null;
    tabGuardAttached = false;
    launchGeneration += 1;
    log(`collector browser invalidado reason=${why} gen=${launchGeneration}`);
    if (reclaim) {
      try {
        await reclaimCollectorProfile({
          mode: reclaimMode,
          reason: `invalidate:${why}`,
        });
      } catch (_) {}
    }
  }

  async function launchBrowserFresh({ reclaimMode = "soft" } = {}) {
    try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}
    // SEMPRE reclaim antes de launch: Code 21 nasce de zumbi/lock orfao.
    await reclaimCollectorProfile({
      mode: reclaimMode,
      reason: `pre_launch_${reclaimMode}`,
    });

    let launched = null;
    try {
      launched = await Promise.race([
        puppeteer.launch({
          headless: headlessEnabled ? "new" : false,
          executablePath,
          userDataDir,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-background-networking",
            "--disable-client-side-phishing-detection",
            "--disable-sync",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-popup-blocking",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
          ],
          defaultViewport: { width: 1366, height: 900 },
        }),
        sleep(launchTimeoutMs).then(() => {
          throw new Error(`city_collector_launch_timeout_${launchTimeoutMs}ms`);
        }),
      ]);
    } catch (e) {
      lastLaunchError = (e && e.message) ? String(e.message) : String(e);
      // Timeout/fail: mata qualquer chrome do perfil pra nao deixar zumbi.
      try { killZombieChromeForUserDataDir(userDataDir); } catch (_) {}
      try { clearOrphanChromeProfileLocks(userDataDir); } catch (_) {}
      browser = null;
      page = null;
      browserPid = null;
      throw e;
    }

    browser = launched;
    try {
      const proc = browser.process && browser.process();
      browserPid = proc && proc.pid ? Number(proc.pid) || null : null;
    } catch {
      browserPid = null;
    }
    const pages = await browser.pages().catch(() => []);
    page = pages[0] || (await browser.newPage());
    await page.setDefaultTimeout(
      Math.max(10_000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000)
    );
    try {
      await page.setDefaultNavigationTimeout(
        Math.max(10_000, Number(process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000)
      );
    } catch (_) {}

    try {
      browser.on("disconnected", () => {
        try {
          log(`collector browser disconnected gen=${launchGeneration} pid=${browserPid || "n/a"}`);
        } catch (_) {}
        browser = null;
        page = null;
        browserPid = null;
        tabGuardAttached = false;
      });
    } catch (_) {}

    if (!tabGuardAttached) {
      tabGuardAttached = true;
      browser.on("targetcreated", async (target) => {
        try {
          if (!target || target.type() !== "page") return;
          const newPage = await target.page().catch(() => null);
          if (!newPage || newPage === page) return;
          await pruneCollectorTabs();
        } catch (_) {}
      });
    }
    await pruneCollectorTabs();
    // Smoke health: se page ja veio zumbi, falha e deixa ensurePage relaunchar.
    if (!(await pageIsHealthy(page))) {
      throw new Error("city_collector_page_unhealthy_after_launch");
    }
    lastLaunchError = null;
    log(
      `collector iniciado headless=${headlessEnabled ? "sim" : "nao"}` +
      ` concurrency=1 pid=${browserPid || "n/a"}` +
      ` userDataDir=${userDataDir} gen=${launchGeneration}`
    );
    return page;
  }

  /**
   * Garante 1 page viva. Launch serializado por mutex.
   * Code 21 => reclaim hard (kill zumbis + locks) e relaunch ate N tentativas.
   */
  async function ensurePage({ forceRelaunch = false } = {}) {
    if (!forceRelaunch) {
      try {
        if (
          browser &&
          browser.isConnected &&
          browser.isConnected() &&
          page &&
          !(page.isClosed && page.isClosed())
        ) {
          if (await pageIsHealthy(page)) {
            await pruneCollectorTabs();
            return page;
          }
          await invalidateBrowser("unhealthy_page", { reclaim: true, reclaimMode: "soft" });
        }
      } catch (_) {}

      try {
        if (browser && browser.isConnected && browser.isConnected()) {
          const pages = await browser.pages().catch(() => []);
          page = pages[0] || (await browser.newPage());
          if (await pageIsHealthy(page)) {
            await pruneCollectorTabs();
            return page;
          }
          await invalidateBrowser("unhealthy_recovered_page", { reclaim: true, reclaimMode: "soft" });
        }
      } catch (_) {}
    } else {
      await invalidateBrowser("force_relaunch", { reclaim: true, reclaimMode: "hard" });
    }

    if (launchPromise) return launchPromise;

    launchPromise = (async () => {
      let lastErr = null;
      for (let launchAttempt = 1; launchAttempt <= launchMaxAttempts; launchAttempt += 1) {
        const mode = launchAttempt === 1 ? "soft" : "hard";
        try {
          return await launchBrowserFresh({ reclaimMode: mode });
        } catch (e) {
          lastErr = e;
          lastLaunchError = (e && e.message) ? String(e.message) : String(e);
          const launchFail = isChromiumLaunchFailure(e);
          log(
            `collector launch falhou attempt=${launchAttempt}/${launchMaxAttempts}` +
            ` code21=${launchFail ? "sim" : "nao"}` +
            ` error=${lastLaunchError}`
          );
          await invalidateBrowser(launchFail ? "launch_code21" : "launch_failed", {
            reclaim: true,
            reclaimMode: "hard",
          });
          if (launchAttempt < launchMaxAttempts) {
            await sleep(launchFail ? (1_400 + launchAttempt * 400) : 700);
          }
        }
      }
      throw lastErr || new Error("city_collector_browser_launch_failed");
    })().finally(() => {
      launchPromise = null;
    });

    return launchPromise;
  }

  async function collectCityFromItemLink({
    item_link,
    thread_key,
    account_login,
    timeoutMs,
    attempts,
    session_cookies,
  } = {}) {
    const waitingBefore = typeof enqueue.getWaiting === "function" ? enqueue.getWaiting() : 0;
    if (waitingBefore > 0) {
      try {
        log(
          `collector fila waiting=${waitingBefore}` +
          ` depth=${typeof enqueue.getDepth === "function" ? enqueue.getDepth() : "?"}` +
          ` thread=${String(thread_key || "").trim() || "n/a"}`
        );
      } catch (_) {}
    }

    return enqueue(async () => {
      let jobTimedOut = false;
      const runJob = async () => {
      const itemLink = normalizeItemLink(item_link);
      const tk = String(thread_key || "").trim();
      const account = String(account_login || "").trim();
      const itemId = (() => {
        try {
          if (!itemLink) return "";
          const u = new URL(itemLink);
          return extractMarketplaceItemId(u.pathname);
        } catch {
          return "";
        }
      })();
      const maxAttempts = Math.max(1, Number(attempts || 3) || 3);
      const navTimeoutMs = Math.max(8_000, Number(timeoutMs || process.env.VIRTUS_DELTA_CITY_COLLECTOR_TIMEOUT_MS || 20_000) || 20_000);

      if (!itemLink) {
        try {
          logTriagemCityCollectFailed({
            account_login: account,
            thread_key: tk,
            item_link: "",
            error: "city_collector_item_link_missing",
            attempts: 0,
          });
        } catch (_) {}
        return { ok: false, error: "city_collector_item_link_missing" };
      }
      if (itemId) {
        const cached = cityCacheGet(itemId);
        if (cached && cached.cidade) {
          return {
            ok: true,
            cidade: String(cached.cidade),
            city_source: String(cached.city_source || "collector_cache"),
            cached: true,
          };
        }
      }

      let lastExtracted = null;
      let lastNavError = null;
      let sawLaunchFailure = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Code 21 / page morta => force relaunch com reclaim hard (zumbis+locks).
          const p = await ensurePage({ forceRelaunch: sawLaunchFailure });
          sawLaunchFailure = false;
          await applySessionCookies(p, session_cookies);
          await p.goto(itemLink, { waitUntil: "domcontentloaded", timeout: navTimeoutMs });
          await sleep(randomBetween(500, 1100));

          // Guarda soberana: se o FB jogou pra login/?next=/marketplace/ (sem item),
          // não adianta varrer DOM — não é o anúncio.
          let navHref = "";
          try {
            navHref = String((typeof p.url === "function" ? p.url() : "") || "").trim();
          } catch (_) {
            navHref = "";
          }
          const navClass = classifyListingNavUrl(navHref, itemId);
          if (!navClass.ok) {
            try {
              log(
                `nav rejeitada account=${account || "n/a"} thread=${tk || "n/a"}` +
                ` kind=${navClass.kind || "?"} href=${String(navClass.href || navHref || "").slice(0, 160)}`
              );
            } catch (_) {}
            lastNavError = String(navClass.error || "city_collector_nav_not_item_page");
            lastExtracted = {
              cidade: null,
              error: lastNavError,
              login_wall: navClass.kind === "hard_login_redirect",
              has_localizacao: false,
              has_anunciado: false,
              candidates_count: 0,
              nav_kind: navClass.kind || null,
              nav_href: String(navClass.href || navHref || "").slice(0, 300) || null,
            };
            // Hard login / hub: não queima attempts lentas — sai do loop.
            if (
              navClass.kind === "hard_login_redirect" ||
              navClass.kind === "marketplace_hub" ||
              navClass.kind === "wrong_item"
            ) {
              break;
            }
            continue;
          }

          await waitForListingHints(p, Math.min(4000, Math.max(1800, Math.floor(navTimeoutMs / 4))));

          // Lê a cidade mesmo com o modal de login na frente (DOM do anúncio fica atrás).
          const listingForensic = {
            thread_key: tk,
            account_login: account,
            item_link: itemLink,
          };
          let extracted = await extractCityFromListingPage(p, {
            maxAttempts: 4,
            retryIntervalMs: 350,
            scanLimit: 320,
            ...listingForensic,
          });

          if (!extracted || !extracted.cidade) {
            await dismissLoginOverlayPatient(p, { rounds: 3 });
            await waitForListingHints(p, Math.min(5000, Math.max(2500, Math.floor(navTimeoutMs / 3))));
            extracted = await extractCityFromListingPage(p, {
              maxAttempts: 12,
              retryIntervalMs: 500,
              scanLimit: 320,
              ...listingForensic,
            });
          }
          if (!extracted || !extracted.cidade) {
            // Segunda passada: fecha pop-up de novo, espera hidratar e relê o DOM.
            await dismissLoginOverlayPatient(p, { rounds: 2 });
            await waitForListingHints(p, 3000);
            extracted = await extractCityFromListingPage(p, {
              maxAttempts: 8,
              retryIntervalMs: 400,
              scanLimit: 320,
              ...listingForensic,
            });
          }
          lastExtracted = extracted;
          if (extracted && extracted.cidade) {
            if (itemId) {
              cityCacheSet(itemId, extracted.cidade, extracted.city_source || "collector_dom");
            }
            // Mantem browser vivo, mas pagina limpa (anti-vazamento de DOM/tabs).
            try {
              await Promise.race([
                p.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => {}),
                sleep(5_000),
              ]);
            } catch (_) {}
            try { await pruneCollectorTabs(); } catch (_) {}
            log(`cidade coletada account=${account || "n/a"} thread=${tk || "n/a"} cidade="${extracted.cidade}" attempt=${attempt}`);
            return {
              ok: true,
              cidade: extracted.cidade,
              city_source: extracted.city_source || "collector_dom",
              login_wall: !!extracted.login_wall,
            };
          }
        } catch (e) {
          lastNavError = (e && e.message) ? String(e.message) : String(e);
          sawLaunchFailure = isChromiumLaunchFailure(e);
          log(
            `tentativa falhou account=${account || "n/a"} thread=${tk || "n/a"}` +
            ` attempt=${attempt} code21=${sawLaunchFailure ? "sim" : "nao"}` +
            ` error=${lastNavError}`
          );
          if (sawLaunchFailure) {
            try {
              await invalidateBrowser("collect_code21", { reclaim: true, reclaimMode: "hard" });
            } catch (_) {}
          } else {
            // Nav/target closed: invalida soft pra nao reusar page podre.
            try {
              if (/Target closed|Session closed|browser has disconnected|Navigation failed/i.test(lastNavError)) {
                await invalidateBrowser("collect_nav_dead", { reclaim: true, reclaimMode: "soft" });
                sawLaunchFailure = true;
              }
            } catch (_) {}
          }
        }
        if (attempt < maxAttempts) {
          await sleep(sawLaunchFailure ? randomBetween(1400, 2400) : randomBetween(700, 1500));
        }
      }

      const navHardError =
        lastExtracted &&
        typeof lastExtracted.error === "string" &&
        /^city_collector_(hard_login_redirect|nav_marketplace_hub|nav_wrong_item|nav_not_item_page)/.test(
          lastExtracted.error
        )
          ? String(lastExtracted.error)
          : null;
      const failError = navHardError
        ? navHardError
        : lastNavError && !lastExtracted
          ? (isChromiumLaunchFailure(lastNavError)
            ? "city_collector_browser_launch_failed"
            : (/^city_collector_/.test(String(lastNavError || ""))
              ? String(lastNavError)
              : "city_collector_navigation_failed"))
          : "city_not_found_in_listing_page";
      try {
        logTriagemCityCollectFailed({
          account_login: account,
          thread_key: tk,
          item_link: itemLink,
          error: failError,
          login_wall: !!(lastExtracted && lastExtracted.login_wall),
          has_localizacao: !!(lastExtracted && lastExtracted.has_localizacao),
          has_anunciado: !!(lastExtracted && lastExtracted.has_anunciado),
          candidates_count: Number((lastExtracted && lastExtracted.candidates_count) || 0) || 0,
          attempts: maxAttempts,
          last_nav_error: lastNavError,
          nav_kind: (lastExtracted && lastExtracted.nav_kind) || null,
          nav_href: (lastExtracted && lastExtracted.nav_href) || null,
        });
      } catch (_) {}
      return {
        ok: false,
        error: failError,
        login_wall: !!(lastExtracted && lastExtracted.login_wall),
        has_localizacao: !!(lastExtracted && lastExtracted.has_localizacao),
        has_anunciado: !!(lastExtracted && lastExtracted.has_anunciado),
        candidates_count: Number((lastExtracted && lastExtracted.candidates_count) || 0) || 0,
        last_nav_error: lastNavError || null,
        nav_kind: (lastExtracted && lastExtracted.nav_kind) || null,
        nav_href: (lastExtracted && lastExtracted.nav_href) || null,
        queue_serial: true,
      };
      };

      // Hard cap: nunca deixa a fila serial (concurrency=1) eternamente travada
      // se o Chrome headed/headless pendurar no launch/nav.
      try {
        const out = await Promise.race([
          runJob(),
          sleep(jobTimeoutMs).then(() => {
            jobTimedOut = true;
            return {
              ok: false,
              error: `city_collector_job_timeout_${jobTimeoutMs}ms`,
              queue_serial: true,
            };
          }),
        ]);
        if (jobTimedOut) {
          try {
            await invalidateBrowser("job_timeout", { reclaim: true, reclaimMode: "soft" });
          } catch (_) {}
          try {
            log(`collector job timeout ${jobTimeoutMs}ms — fila liberada`);
          } catch (_) {}
        }
        return out;
      } catch (e) {
        return {
          ok: false,
          error: String((e && e.message) || e || "city_collector_job_exception").slice(0, 220),
          queue_serial: true,
        };
      }
    });
  }

  // Boot: limpa zumbis/locks deixados por crash anterior do worker.
  try {
    await reclaimCollectorProfile({ mode: "hard", reason: "runtime_boot" });
  } catch (_) {}

  return {
    ok: true,
    collectCityFromItemLink,
    getQueueMeta: () => ({
      concurrency: 1,
      depth: typeof enqueue.getDepth === "function" ? enqueue.getDepth() : null,
      waiting: typeof enqueue.getWaiting === "function" ? enqueue.getWaiting() : null,
      in_flight: typeof enqueue.getInFlight === "function" ? enqueue.getInFlight() : null,
      launch_generation: launchGeneration,
      browser_pid: browserPid,
      reclaim_count: reclaimCount,
      last_reclaim_at: lastReclaimAt || null,
      last_launch_error: lastLaunchError ? String(lastLaunchError).slice(0, 220) : null,
      user_data_dir: userDataDir,
    }),
    shutdown: async () => {
      try {
        await invalidateBrowser("shutdown", { reclaim: true, reclaimMode: "hard" });
      } catch (_) {
        browser = null;
        page = null;
        browserPid = null;
      }
    },
  };
}

async function getDeltaCityCollector() {
  if (!global.__deltaCityCollectorRuntimePromise) {
    global.__deltaCityCollectorRuntimePromise = createCollectorRuntime().catch((err) => {
      global.__deltaCityCollectorRuntimePromise = null;
      throw err;
    });
  }
  return global.__deltaCityCollectorRuntimePromise;
}

module.exports = {
  getDeltaCityCollector,
  resolveCityCollectorUserDataDir,
  extractCityFromLocationAnchorText,
  normalizeCityUfLabel,
  buildCityUf,
  stripMarketplaceConditionNoise,
  resolveDualIntersectionCommunion,
  collectGeoHitsFromBlob,
};
