"use strict";

/**
 * Reaper de órfãos: Chrome do perfil Conveniente + cloudflared deste exe.
 * Não mexe em Chrome pessoal, nem no shard vivo do outro worker, nem em desired/pedido/Robe.
 * Escape: CONVENIENTE_ORPHAN_REAP=0
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const fileStore = require("./fileStore.js");
const logger = require("./logger.js");
const provisionAudit = require("./provisionAudit.js");

const DADOS = path.join(__dirname, "..", "dados");

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

function listChromeProcessesWin() {
  if (process.platform !== "win32") return [];
  try {
    const ps = `
      $names = @('chrome.exe','chromium.exe');
      $all = @();
      foreach ($n in $names) {
        try {
          $all += Get-CimInstance Win32_Process -Filter ("Name='" + $n + "'") |
            Select-Object ProcessId, Name, CommandLine;
        } catch {}
      }
      $all | ConvertTo-Json -Compress -Depth 3
    `;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 12000 }
    ).trim();
    if (!out) return [];
    const json = JSON.parse(out);
    const arr = Array.isArray(json) ? json : (json ? [json] : []);
    return arr.map((p) => ({
      pid: Number(p.ProcessId),
      cmd: String(p.CommandLine || "")
    })).filter((p) => Number.isFinite(p.pid) && p.pid > 0);
  } catch {
    return [];
  }
}

function taskkillPid(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000 });
    return true;
  } catch {
    return false;
  }
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
  let killed = 0;
  for (const pid of toKill) {
    if (taskkillPid(pid)) killed += 1;
  }
  return { matched: toKill.size, killed, listed: procs.length };
}

function convenienteCloudflaredExeHints() {
  return [
    path.join(DADOS, "bin", "cloudflared.exe"),
    "C:\\portas\\bin\\cloudflared.exe",
    path.join(__dirname, "..", "dados", "bin", "cloudflared.exe")
  ].map((p) => normalizePathForCompare(p));
}

function listCloudflaredWin() {
  if (process.platform !== "win32") return [];
  try {
    const ps = `
      Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
        Select-Object ProcessId, ParentProcessId, CommandLine |
        ConvertTo-Json -Compress -Depth 3
    `;
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 10000 }
    ).trim();
    if (!out) return [];
    const json = JSON.parse(out);
    const arr = Array.isArray(json) ? json : (json ? [json] : []);
    return arr.map((p) => ({
      pid: Number(p.ProcessId),
      ppid: Number(p.ParentProcessId) || 0,
      cmd: String(p.CommandLine || "")
    })).filter((p) => Number.isFinite(p.pid) && p.pid > 0);
  } catch {
    return [];
  }
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

function reapCloudflaredOrphans({ keepPid = null, reason = "boot" } = {}) {
  if (!reapEnabled()) return { listed: 0, ours: 0, killed: 0, skipped: true };
  const keep = Number(keepPid) || 0;
  const listed = listCloudflaredWin();
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
  try {
    provisionAudit.append({
      event: "orphan_reap_cloudflared",
      reason: clip(reason, 48),
      listed: listed.length,
      ours: ours.length,
      killed,
      keepPid: keep || null,
      pids: pids.slice(0, 16)
    });
  } catch {}
  life("orphan_reap_cloudflared", { reason: clip(reason, 48), killed, ours: ours.length, keepPid: keep || null });
  try {
    if (killed > 0) logger.warn("[ORPHAN] cloudflared zumbi removido", { reason, killed, keepPid: keep || null });
  } catch {}
  return { listed: listed.length, ours: ours.length, killed };
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
  if (city) dirs.push(city);
  return reapChromeDirs(dirs, reason || "worker_drop");
}

function reapAllConvenienteChrome(reason) {
  return reapChromeDirs(collectAllProfileDirs(), reason || "index_boot_start_closed");
}

function reapOnIndexBoot({ startClosed = true } = {}) {
  const cloudflared = reapCloudflaredOrphans({ reason: "index_boot" });
  const chrome = startClosed
    ? reapAllConvenienteChrome("index_boot_start_closed")
    : { matched: 0, killed: 0, skipped: true };
  return { cloudflared, chrome };
}

module.exports = {
  reapShard,
  reapOnIndexBoot,
  reapCloudflaredOrphans,
  reapAllConvenienteChrome,
  resolveUserDataDir
};
