// scripts/autoBackupWorker.js
// Worker de snapshot (roda em processo separado para não travar o main).
//
// Uso (interno pelo index.js):
//   node scripts/autoBackupWorker.js --root <dir> --keep <N>
//
// Observação: este script pode usar IO síncrono sem impactar o main,
// pois roda em processo separado.

"use strict";

const fs = require("fs");
const path = require("path");

function pad2(n) { return String(n).padStart(2, "0"); }
function tsTag() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = String(argv[i] || "");
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = (i + 1 < argv.length && !String(argv[i + 1]).startsWith("--")) ? String(argv[i + 1]) : "1";
      out[k] = v;
      if (v !== "1") i++;
    }
  }
  return out;
}

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch {}
}

function copyFileRetry(src, dst) {
  try {
    ensureDir(path.dirname(dst));
    for (let i = 0; i < 8; i++) {
      try { fs.copyFileSync(src, dst); return true; }
      catch (e) {
        const code = String(e && e.code || "");
        if (code === "EPERM" || code === "EBUSY" || code === "EACCES") { sleepSync(30 + i * 50); continue; }
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function copyDirFlat(ROOT, curOutDir, relDir, { exts = [".js"], maxFiles = 400 } = {}) {
  try {
    const srcDir = path.join(ROOT, relDir);
    const st = safeStat(srcDir);
    if (!st || !st.isDirectory()) return 0;
    const files = fs.readdirSync(srcDir).slice(0, maxFiles);
    let c = 0;
    for (const name of files) {
      const low = String(name).toLowerCase();
      if (exts && exts.length) {
        const ok = exts.some(e => low.endsWith(String(e).toLowerCase()));
        if (!ok) continue;
      }
      const fp = path.join(srcDir, name);
      const fst = safeStat(fp);
      if (!fst || !fst.isFile()) continue;
      const dst = path.join(curOutDir, relDir, name);
      if (copyFileRetry(fp, dst)) c++;
    }
    return c;
  } catch {
    return 0;
  }
}

function acquireRunLock(baseDir, { staleMs = 15 * 60 * 1000 } = {}) {
  // Impede snapshots concorrentes (P1).
  // Se existir e estiver velho, tenta recuperar.
  const lockPath = path.join(baseDir, "_snapshot_running.lock");
  ensureDir(baseDir);
  try {
    const fd = fs.openSync(lockPath, "wx");
    try {
      const meta = { pid: process.pid, ts: Date.now() };
      try { fs.writeFileSync(fd, JSON.stringify(meta), "utf8"); } catch {}
      try { fs.fsyncSync(fd); } catch {}
    } catch {}
    return { ok: true, lockPath, fd };
  } catch {
    // stale recovery best-effort
    try {
      const st = safeStat(lockPath);
      const ageMs = st ? (Date.now() - Number(st.mtimeMs || 0)) : 0;
      if (st && staleMs > 0 && ageMs > staleMs) {
        try { fs.unlinkSync(lockPath); } catch {}
        const fd2 = fs.openSync(lockPath, "wx");
        try {
          const meta = { pid: process.pid, ts: Date.now(), recovered: true };
          try { fs.writeFileSync(fd2, JSON.stringify(meta), "utf8"); } catch {}
          try { fs.fsyncSync(fd2); } catch {}
        } catch {}
        return { ok: true, lockPath, fd: fd2, recovered: true };
      }
    } catch {}
    return { ok: false, lockPath, error: "already_running" };
  }
}

function releaseRunLock(lock) {
  try { if (lock && typeof lock.fd === "number") fs.closeSync(lock.fd); } catch {}
  try { if (lock && lock.lockPath) fs.unlinkSync(lock.lockPath); } catch {}
}

function runOnce({ ROOT, keep }) {
  const baseDir = path.join(ROOT, "_backup_auto");
  const lock = acquireRunLock(baseDir, { staleMs: Math.max(60_000, Number(process.env.CONVENIENTE_AUTO_BACKUP_LOCK_STALE_MS || 900_000) || 900_000) });
  if (!lock || lock.ok !== true) {
    return { ok: false, skipped: true, reason: "snapshot_already_running" };
  }
  try {
    const tag = tsTag();
    const curOutDir = path.join(baseDir, tag);
    ensureDir(curOutDir);

    // Arquivos raiz importantes
    const files = [
      "index.js",
      "package.json",
      "package-lock.json",
      "instalar_conveniente.ps1",
      "PainelConta.bat"
    ];

    let copied = 0;
    for (const rel of files) {
      const src = path.join(ROOT, rel);
      if (!safeStat(src)) continue;
      if (copyFileRetry(src, path.join(curOutDir, rel))) copied++;
    }

    // Código (sem node_modules)
    copied += copyDirFlat(ROOT, curOutDir, "scripts", { exts: [".js"], maxFiles: 600 });
    copied += copyDirFlat(ROOT, curOutDir, "public", { exts: [".html", ".js", ".css"], maxFiles: 120 });

    // Config/estado crítico (pequeno)
    const dadosFiles = [
      path.join("dados", "desired.json"),
      path.join("dados", "perfis.json"),
      path.join("dados", "status.json"),
      path.join("dados", "supervisor_state.json"),
      path.join("dados", "ct_config.json"),
      path.join("dados", "cidades.json"),
      path.join("dados", "cidades_coords.json"),
      path.join("dados", "ua_presets.json"),
      path.join("dados", "localizacoes.json"),
      path.join("dados", "atendimento.json")
    ];
    for (const rel of dadosFiles) {
      const src = path.join(ROOT, rel);
      if (!safeStat(src)) continue;
      if (copyFileRetry(src, path.join(curOutDir, rel))) copied++;
    }

    // Issues do sistema (se existir)
    try {
      const iss = path.join(ROOT, "dados", "perfis", "system", "issues.json");
      if (safeStat(iss) && copyFileRetry(iss, path.join(curOutDir, "dados", "perfis", "system", "issues.json"))) copied++;
    } catch {}

    // Retenção (mantém os mais recentes)
    try {
      ensureDir(baseDir);
      const dirs = fs.readdirSync(baseDir)
        .map(n => ({ n, p: path.join(baseDir, n) }))
        .filter(x => safeStat(x.p) && safeStat(x.p).isDirectory())
        .sort((a, b) => String(b.n).localeCompare(String(a.n)));
      for (const d of dirs.slice(keep)) {
        try { fs.rmSync(d.p, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); } catch {}
      }
    } catch {}

    try {
      fs.appendFileSync(path.join(baseDir, "_snapshots.log"),
        JSON.stringify({ ts: Date.now(), tag, copied, mode: "subprocess" }) + "\n");
    } catch {}

    return { ok: true, tag, copied };
  } finally {
    try { releaseRunLock(lock); } catch {}
  }
}

function main() {
  const args = parseArgs(process.argv);
  const ROOT = String(args.root || "").trim() || path.join(__dirname, "..");
  const keep = Math.max(10, Math.min(500, Number(args.keep || 96) || 96));

  // Permitir uso manual em emergências sem travar prompt.
  try {
    const r = runOnce({ ROOT, keep });
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exit(0);
  } catch (e) {
    const msg = (e && e.message) ? String(e.message) : String(e);
    process.stderr.write(JSON.stringify({ ok: false, error: msg }) + "\n");
    process.exit(1);
  }
}

main();

