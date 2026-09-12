"use strict";

/**
 * Reaper de órfãos: Chrome do perfil Conveniente + cloudflared deste exe.
 * Não mexe em Chrome pessoal, nem no shard vivo do outro worker, nem em desired/pedido/Robe.
 * Escape: CONVENIENTE_ORPHAN_REAP=0
 */

const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fileStore = require("./fileStore.js");
const logger = require("./logger.js");
const provisionAudit = require("./provisionAudit.js");

const DADOS = path.join(__dirname, "..", "dados");
const CITY_COLLECTOR_CHROME_FLAG = "--conveniente-city-collector";
const CITY_COLLECTOR_PID_BASENAME = "conveniente-collector.pid";
const ORPHAN_REAP_CLOUDFLARED_MIN_MS = Math.max(
  10_000,
  Math.min(10 * 60 * 1000, Number(process.env.CONVENIENTE_ORPHAN_REAP_CLOUDFLARED_MIN_MS || 60_000) || 60_000)
);
let __cloudflaredReapInFlight = null;
let __cloudflaredReapLastAt = 0;
let __cloudflaredReapLastResult = { listed: 0, ours: 0, killed: 0, skipped: true, reason: "never" };

function clip(v, n) {
  const s = v == null ? "" : String(v);
  return s.length <= n ? s : s.slice(0, n);
}

function reapEnabled() {
  return String(process.env.CONVENIENTE_ORPHAN_REAP || "1").trim() !== "0";
}

function normalizePathForCompare(p) {
  return String(p || "").replace(/\\/g, "/").toLowerCase();
}

function extractUserDataDirFromCmd(cmd) {
  try {
    const m = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(String(cmd || ""));
    return m ? (m[1] || m[2] || m[3] || null) : null;
  } catch {
    return null;
  }
}

/** Evita falso positivo: .../Conveniente/joao NÃO casa .../Conveniente/joao2 */
function pathOccursAsDir(haystack, dirNorm) {
  const h = String(haystack || "");
  const d = String(dirNorm || "");
  if (!h || !d || d.length < 12) return false;
  let from = 0;
  while (from <= h.length) {
    const i = h.indexOf(d, from);
    if (i < 0) return false;
    const after = h[i + d.length] || "";
    if (!after || /[\s"'\\/]/.test(after)) return true;
    from = i + d.length;
  }
  return false;
}

function cmdHasConvenienteSlug(cmdN, slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s || s.length < 2) return false;
  return pathOccursAsDir(cmdN, "/conveniente/" + s) || pathOccursAsDir(cmdN, "\\conveniente\\" + s);
}

function chromeUserDataRoot() {
  if (process.platform !== "win32") return "";
  const la = process.env.LOCALAPPDATA;
  return la
    ? path.join(la, "Google", "Chrome", "User Data")
    : path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
}

function resolveUserDataDir(nome) {
  const n = String(nome || "").trim();
  if (!n) return "";
  try {
    const arr = fileStore.loadPerfisJson() || [];
    const rec = Array.isArray(arr) ? arr.find((p) => p && p.nome === n) : null;
    if (rec && rec.userDataDir) return String(rec.userDataDir);
  } catch {}
  const root = chromeUserDataRoot();
  return root ? path.join(root, "Conveniente", n) : "";
}

let __chromeCache = { at: 0, images: [], rows: [] };
const CHROME_LIST_TTL_MS = 500;

function silentExec(file, args, timeoutMs) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(800, Number(timeoutMs) || 2500),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    return String((e && e.stdout) || "");
  }
}

function invalidateChromeListCache() {
  __chromeCache = { at: 0, images: [], rows: [] };
}

function parseWmicProcessList(raw) {
  const out = [];
  let cmd = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      cmd = "";
      continue;
    }
    if (/^CommandLine=/i.test(t)) {
      cmd = t.slice(t.indexOf("=") + 1);
      continue;
    }
    if (/^ProcessId=/i.test(t)) {
      const pid = Math.floor(Number(t.slice(t.indexOf("=") + 1)) || 0);
      if (pid > 0) out.push({ pid, cmd: cmd || "" });
      cmd = "";
    }
  }
  return out;
}

function fillChromeCache() {
  if (process.platform !== "win32") {
    __chromeCache = { at: Date.now(), images: [], rows: [] };
    return __chromeCache;
  }
  const now = Date.now();
  if (__chromeCache.at && (now - __chromeCache.at) < CHROME_LIST_TTL_MS) return __chromeCache;
  const images = [];
  for (const name of ["chrome.exe", "chromium.exe"]) {
    const listed = silentExec("tasklist.exe", ["/FI", "IMAGENAME eq " + name, "/NH"], 2500);
    if (new RegExp(name.replace(".", "\\."), "i").test(String(listed || ""))) images.push(name);
  }
  let rows = [];
  for (const name of images) {
    rows.push.apply(rows, parseWmicProcessList(silentExec("wmic.exe", [
      "process",
      "where",
      "name='" + name + "'",
      "get",
      "ProcessId,CommandLine",
      "/FORMAT:LIST"
    ], 3000)));
  }
  const missingCmd = !rows.length || rows.every((r) => !r.cmd);
  const someMissingCmd = rows.some((r) => !r.cmd);
  if ((missingCmd || someMissingCmd) && process.platform === "win32" && images.length) {
    const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const filter = images.map((n) => "Name='" + String(n).replace(/'/g, "") + "'").join(" or ");
    const raw = silentExec(ps, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"" + filter + "\" -ErrorAction SilentlyContinue | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], 8000);
    const parsed = [];
    try {
      const json = JSON.parse(String(raw || "").trim() || "[]");
      const arr = Array.isArray(json) ? json : (json ? [json] : []);
      for (const p of arr) {
        const pid = Math.floor(Number(p && p.ProcessId) || 0);
        if (pid > 0) parsed.push({ pid, cmd: String((p && p.CommandLine) || "") });
      }
    } catch {}
    if (parsed.length) {
      if (missingCmd) {
        rows = parsed;
      } else {
        const byPid = new Map();
        for (const r of rows) byPid.set(r.pid, r);
        for (const r of parsed) {
          const prev = byPid.get(r.pid);
          if (!prev || (r.cmd && (!prev.cmd || r.cmd.length > prev.cmd.length))) byPid.set(r.pid, r);
        }
        rows = Array.from(byPid.values());
      }
    }
  }
  __chromeCache = { at: Date.now(), images, rows };
  return __chromeCache;
}

function chromeImagesRunning() {
  return fillChromeCache().images.slice();
}

function anyChromeImage() {
  return fillChromeCache().images.length > 0;
}

function listChromeProcessesWin() {
  return fillChromeCache().rows.slice();
}

function taskkillPid(pid) {
  return taskkillPids([pid]);
}

function taskkillPids(pids) {
  const list = [];
  const seen = new Set();
  for (const raw of (Array.isArray(pids) ? pids : [pids])) {
    const n = Math.floor(Number(raw) || 0);
    if (!(n > 4) || n === process.pid || seen.has(n)) continue;
    seen.add(n);
    list.push(n);
  }
  if (!list.length) return false;
  invalidateChromeListCache();
  const args = ["/F", "/T"];
  for (const n of list) {
    args.push("/PID", String(n));
  }
  try {
    execFileSync("taskkill", args, {
      windowsHide: true,
      timeout: 8000,
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {}
  return true;
}

function killChromeMatchingDirs(userDataDirs) {
  const dirs = [];
  const slugs = [];
  const seen = new Set();
  for (const raw of (Array.isArray(userDataDirs) ? userDataDirs : [])) {
    const rawS = String(raw || "").trim();
    const n = normalizePathForCompare(rawS).replace(/\/+$/g, "");
    if (!n || seen.has(n)) continue;
    seen.add(n);
    dirs.push(n);
    try {
      const slug = path.basename(rawS.replace(/[\\/]+$/g, ""));
      if (slug && slug.length >= 2 && /(?:^|[\\/])conveniente[\\/]/i.test(rawS)) {
        slugs.push(slug.toLowerCase());
      }
    } catch {}
  }
  if (!dirs.length) return { matched: 0, killed: 0, listed: 0 };
  const toKill = new Set();
  const procs = listChromeProcessesWin();
  for (const pr of procs) {
    const ud = extractUserDataDirFromCmd(pr.cmd);
    const udN = ud ? normalizePathForCompare(ud).replace(/\/+$/g, "") : "";
    const cmdN = normalizePathForCompare(pr.cmd || "");
    let hit = false;
    for (const expected of dirs) {
      if (udN && udN === expected) { hit = true; break; }
      if (pathOccursAsDir(cmdN, expected)) { hit = true; break; }
    }
    if (!hit && udN) {
      for (const slug of slugs) {
        if (cmdHasConvenienteSlug(udN, slug) || cmdHasConvenienteSlug(cmdN, slug)) { hit = true; break; }
      }
    } else if (!hit) {
      for (const slug of slugs) {
        if (cmdHasConvenienteSlug(cmdN, slug)) { hit = true; break; }
      }
    }
    if (hit) toKill.add(pr.pid);
  }
  const pidList = Array.from(toKill);
  const ok = taskkillPids(pidList);
  return { matched: toKill.size, killed: ok ? toKill.size : 0, listed: procs.length };
}

function convenienteCloudflaredExeHints() {
  return [
    path.join(DADOS, "bin", "cloudflared.exe"),
    "C:\\portas\\bin\\cloudflared.exe",
    path.join(__dirname, "..", "dados", "bin", "cloudflared.exe")
  ].map((p) => normalizePathForCompare(p));
}

function execPsJsonAsync(psScript, { timeoutMs = 10000, maxBuffer = 512 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", String(psScript || "")],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: Math.max(64 * 1024, Number(maxBuffer || 0) || 0),
        timeout: Math.max(1000, Number(timeoutMs || 0) || 0)
      },
      (error, stdout) => {
        if (error) return resolve([]);
        const out = String(stdout || "").trim();
        if (!out) return resolve([]);
        try {
          const json = JSON.parse(out);
          const arr = Array.isArray(json) ? json : (json ? [json] : []);
          return resolve(arr);
        } catch {
          return resolve([]);
        }
      }
    );
  });
}

async function listCloudflaredWinAsync() {
  if (process.platform !== "win32") return [];
  const ps = [
    "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" |",
    "Select-Object ProcessId, ParentProcessId, CommandLine |",
    "ConvertTo-Json -Compress -Depth 3"
  ].join(" ");
  const rows = await execPsJsonAsync(ps, { timeoutMs: 10000, maxBuffer: 512 * 1024 });
  return rows.map((p) => ({
    pid: Number(p.ProcessId),
    ppid: Number(p.ParentProcessId) || 0,
    cmd: String(p.CommandLine || "")
  })).filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

function isOurCloudflaredCmd(cmd) {
  const n = normalizePathForCompare(cmd || "");
  if (!n) return false;
  for (const hint of convenienteCloudflaredExeHints()) {
    if (hint && n.includes(hint)) return true;
  }
  return n.includes("/conveniente/dados/bin/cloudflared")
    || n.includes("\\conveniente\\dados\\bin\\cloudflared");
}

function life(event, patch) {
  try { require("./indexLifecycle.js").append(event, patch); } catch {}
}

async function reapCloudflaredOrphans({ keepPid = null, reason = "boot" } = {}) {
  if (!reapEnabled()) return { listed: 0, ours: 0, killed: 0, skipped: true };
  const reasonTag = clip(reason, 48);
  const now = Date.now();
  if (__cloudflaredReapInFlight) {
    try { life("orphan_reap_cloudflared_skipped", { reason: reasonTag, skipReason: "in_flight" }); } catch {}
    return __cloudflaredReapInFlight;
  }
  if (__cloudflaredReapLastAt > 0 && (now - __cloudflaredReapLastAt) < ORPHAN_REAP_CLOUDFLARED_MIN_MS) {
    const waitMs = Math.max(0, ORPHAN_REAP_CLOUDFLARED_MIN_MS - (now - __cloudflaredReapLastAt));
    try { life("orphan_reap_cloudflared_skipped", { reason: reasonTag, skipReason: "rate_limit", waitMs }); } catch {}
    return { ...(__cloudflaredReapLastResult || {}), skipped: true, rateLimited: true, waitMs };
  }
  const keep = Number(keepPid) || 0;
  __cloudflaredReapLastAt = now;
  const job = (async () => {
    const listed = await listCloudflaredWinAsync();
    const ours = listed.filter((p) => isOurCloudflaredCmd(p.cmd));
    const victims = ours.filter((p) => p.pid !== keep && p.pid !== process.pid);
    let killed = 0;
    const pids = [];
    for (const p of victims) {
      if (taskkillPid(p.pid)) {
        killed += 1;
        pids.push(p.pid);
      }
    }
    const result = { listed: listed.length, ours: ours.length, killed, keepPid: keep || null, pids: pids.slice(0, 16) };
    __cloudflaredReapLastResult = { ...result, skipped: false, reason: reasonTag };
    try {
      provisionAudit.append({
        event: "orphan_reap_cloudflared",
        reason: reasonTag,
        listed: listed.length,
        ours: ours.length,
        killed,
        keepPid: keep || null,
        pids: pids.slice(0, 16)
      });
    } catch {}
    life("orphan_reap_cloudflared", { reason: reasonTag, killed, ours: ours.length, keepPid: keep || null });
    try {
      if (killed > 0) logger.warn("[ORPHAN] cloudflared zumbi removido", { reason, killed, keepPid: keep || null });
    } catch {}
    return result;
  })();
  __cloudflaredReapInFlight = job;
  try {
    return await job;
  } finally {
    if (__cloudflaredReapInFlight === job) __cloudflaredReapInFlight = null;
  }
}

function collectDirsForNames(names) {
  const dirs = [];
  for (const nome of (Array.isArray(names) ? names : [])) {
    const d = resolveUserDataDir(nome);
    if (d) dirs.push(d);
  }
  return dirs;
}

function collectCityCollectorDir(shardIdx) {
  const i = Number(shardIdx);
  if (!Number.isFinite(i) || i < 0) return "";
  return path.join(DADOS, "city-collector-shards", "w" + String(i + 1));
}

function isCityCollectorCmd(cmd) {
  const n = normalizePathForCompare(cmd);
  if (!n) return false;
  return n.indexOf("city-collector-shards") >= 0
    || n.indexOf("conveniente-city-collector") >= 0;
}

function isConvenienteChromeCmd(cmd) {
  const n = normalizePathForCompare(cmd);
  if (!n) return false;
  return n.indexOf("user data/conveniente") >= 0 || isCityCollectorCmd(n);
}

function cityCollectorPidPath(userDataDir) {
  const dir = String(userDataDir || "").trim();
  if (!dir) return "";
  return path.join(dir, CITY_COLLECTOR_PID_BASENAME);
}

function writeCityCollectorPid(userDataDir, pid) {
  const fp = cityCollectorPidPath(userDataDir);
  const n = Math.floor(Number(pid) || 0);
  if (!fp || !(n > 4)) return false;
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(n), "utf8");
    return true;
  } catch {
    return false;
  }
}

function readCityCollectorPid(userDataDir) {
  const fp = cityCollectorPidPath(userDataDir);
  if (!fp) return 0;
  try {
    const n = Math.floor(Number(String(fs.readFileSync(fp, "utf8") || "").replace(/^\uFEFF/, "").trim()) || 0);
    return n > 4 ? n : 0;
  } catch {
    return 0;
  }
}

function clearCityCollectorPid(userDataDir) {
  const fp = cityCollectorPidPath(userDataDir);
  if (!fp) return false;
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}

function listCityCollectorDirs() {
  const dirs = [];
  const seen = new Set();
  function add(dir) {
    const d = String(dir || "").trim();
    if (!d) return;
    const key = normalizePathForCompare(d).replace(/\/+$/g, "");
    if (!key || seen.has(key)) return;
    seen.add(key);
    dirs.push(d);
  }
  add(path.join(DADOS, "city-collector-shards", "master"));
  for (let i = 0; i < 16; i += 1) add(collectCityCollectorDir(i));
  try {
    const shards = path.join(DADOS, "city-collector-shards");
    if (fs.existsSync(shards)) {
      for (const ent of fs.readdirSync(shards, { withFileTypes: true })) {
        if (ent && ent.isDirectory()) add(path.join(shards, ent.name));
      }
    }
  } catch {}
  return dirs;
}

function collectCityCollectorJournalPids() {
  const pids = [];
  const seen = new Set();
  for (const dir of listCityCollectorDirs()) {
    const n = readCityCollectorPid(dir);
    if (n > 4 && !seen.has(n)) {
      seen.add(n);
      pids.push(n);
    }
  }
  return pids;
}

function collectAllProfileDirs() {
  const dirs = collectDirsForNames((fileStore.loadPerfisJson() || []).map((p) => p && p.nome).filter(Boolean));
  try {
    const root = path.join(chromeUserDataRoot(), "Conveniente");
    if (fs.existsSync(root)) {
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (ent && ent.isDirectory()) dirs.push(path.join(root, ent.name));
      }
    }
  } catch {}
  try {
    const shards = path.join(DADOS, "city-collector-shards");
    if (fs.existsSync(shards)) {
      for (const ent of fs.readdirSync(shards, { withFileTypes: true })) {
        if (ent && ent.isDirectory()) dirs.push(path.join(shards, ent.name));
      }
    }
  } catch {}
  return dirs;
}

function reapChromeDirs(dirs, reason) {
  if (!reapEnabled()) return { matched: 0, killed: 0, listed: 0, skipped: true };
  const r = killChromeMatchingDirs(dirs);
  try {
    provisionAudit.append({
      event: "orphan_reap_chrome",
      reason: clip(reason, 48),
      dirs: Array.isArray(dirs) ? dirs.length : 0,
      matched: r.matched,
      killed: r.killed,
      listed: r.listed
    });
  } catch {}
  life("orphan_reap_chrome", { reason: clip(reason, 48), killed: r.killed, matched: r.matched });
  try {
    if (r.killed > 0) logger.warn("[ORPHAN] Chrome de perfil removido", { reason, killed: r.killed, matched: r.matched });
  } catch {}
  return r;
}

function reapShard({ names, shardIdx, reason }) {
  if (!reapEnabled()) return { matched: 0, killed: 0, skipped: true };
  const dirs = collectDirsForNames(names);
  const city = collectCityCollectorDir(shardIdx);
  if (city) {
    dirs.push(city);
    const journalPid = readCityCollectorPid(city);
    if (journalPid > 4) taskkillPids([journalPid]);
    try { clearCityCollectorPid(city); } catch {}
  }
  return reapChromeDirs(dirs, reason || "worker_drop");
}

function countConvenienteChrome() {
  try {
    let n = 0;
    for (const pr of listChromeProcessesWin()) {
      if (isConvenienteChromeCmd(pr.cmd)) n += 1;
    }
    return n;
  } catch {
    return -1;
  }
}

function killChromeByConvenienteHint() {
  const procs = listChromeProcessesWin();
  const toKill = new Set();
  for (const pr of procs) {
    if (isConvenienteChromeCmd(pr.cmd)) toKill.add(pr.pid);
  }
  const pidList = Array.from(toKill);
  const ok = taskkillPids(pidList);
  return { matched: toKill.size, killed: ok ? toKill.size : 0, listed: procs.length };
}

function reapCityCollectorChrome(reason) {
  if (!reapEnabled()) return { matched: 0, killed: 0, listed: 0, skipped: true };
  const journalPids = collectCityCollectorJournalPids();
  if (journalPids.length) taskkillPids(journalPids);
  const dirs = listCityCollectorDirs();
  const byDir = killChromeMatchingDirs(dirs);
  invalidateChromeListCache();
  const hintPids = [];
  for (const pr of listChromeProcessesWin()) {
    if (isCityCollectorCmd(pr.cmd)) hintPids.push(pr.pid);
  }
  if (hintPids.length) taskkillPids(hintPids);
  for (const dir of dirs) {
    try { clearCityCollectorPid(dir); } catch {}
  }
  const matched = (journalPids.length || 0) + (byDir.matched || 0) + hintPids.length;
  const killed = (journalPids.length || 0) + (byDir.killed || 0) + hintPids.length;
  try {
    provisionAudit.append({
      event: "orphan_reap_city_collector",
      reason: clip(reason, 48),
      dirs: dirs.length,
      journal: journalPids.length,
      matched,
      killed
    });
  } catch {}
  life("orphan_reap_city_collector", { reason: clip(reason, 48), killed, matched, journal: journalPids.length });
  try {
    if (killed > 0) logger.warn("[ORPHAN] Chrome de coleta de cidade removido", { reason, killed, matched, journal: journalPids.length });
  } catch {}
  return { matched, killed, listed: byDir.listed || 0, journal: journalPids.length, skipped: false };
}

function reapAllConvenienteChrome(reason) {
  const why = clip(reason || "index_boot_start_closed", 48);
  const city = reapCityCollectorChrome(why);
  const dirs = collectAllProfileDirs();
  const byDir = reapEnabled() ? killChromeMatchingDirs(dirs) : { matched: 0, killed: 0, listed: 0, skipped: true };
  invalidateChromeListCache();
  const loose = killChromeByConvenienteHint();
  const matched = (city.matched || 0) + (byDir.matched || 0) + (loose.matched || 0);
  const killed = (city.killed || 0) + (byDir.killed || 0) + (loose.killed || 0);
  const listed = Math.max(city.listed || 0, byDir.listed || 0, loose.listed || 0);
  life("orphan_reap_chrome", { reason: why, killed, matched, city: city.killed || 0 });
  try {
    provisionAudit.append({
      event: "orphan_reap_chrome",
      reason: why,
      dirs: Array.isArray(dirs) ? dirs.length : 0,
      matched,
      killed,
      listed,
      cityKilled: city.killed || 0
    });
  } catch {}
  return {
    matched,
    killed,
    listed,
    cityKilled: city.killed || 0,
    skipped: false
  };
}

function reapOnIndexBoot({ startClosed = true } = {}) {
  const cloudflared = reapCloudflaredOrphans({ reason: "index_boot" });
  const chrome = startClosed
    ? reapAllConvenienteChrome("index_boot_start_closed")
    : { matched: 0, killed: 0, skipped: true };
  return { cloudflared, chrome };
}

module.exports = {
  CITY_COLLECTOR_CHROME_FLAG,
  CITY_COLLECTOR_PID_BASENAME,
  reapShard,
  reapOnIndexBoot,
  reapCloudflaredOrphans,
  reapAllConvenienteChrome,
  reapCityCollectorChrome,
  countConvenienteChrome,
  anyChromeImage,
  resolveUserDataDir,
  isCityCollectorCmd,
  isConvenienteChromeCmd,
  writeCityCollectorPid,
  readCityCollectorPid,
  clearCityCollectorPid,
  listCityCollectorDirs,
  collectCityCollectorJournalPids
};

if (require.main === module) {
  const arg = String(process.argv[2] || "").trim();
  if (arg === "reap-all" || arg === "reap-chrome") {
    const r = reapAllConvenienteChrome(String(process.argv[3] || "cli"));
    process.stdout.write(JSON.stringify(r));
    process.exit(0);
  }
  process.stderr.write("usage: orphanReaper.js reap-all [reason]\n");
  process.exit(2);
}
