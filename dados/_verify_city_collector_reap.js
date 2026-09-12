"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const reaper = require(path.join(ROOT, "scripts", "orphanReaper.js"));
const citySrc = fs.readFileSync(path.join(ROOT, "scripts", "deltaCityCollector.js"), "utf8");
const workerSrc = fs.readFileSync(path.join(ROOT, "scripts", "worker.js"), "utf8");
const lifeSrc = fs.readFileSync(path.join(ROOT, "scripts", "cellLifecycle.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
const iniciarSrc = fs.readFileSync(path.join(ROOT, "scripts", "iniciarSistema.ps1"), "utf8");
const reaperSrc = fs.readFileSync(path.join(ROOT, "scripts", "orphanReaper.js"), "utf8");

assert.strictEqual(typeof reaper.isCityCollectorCmd, "function");
assert.strictEqual(typeof reaper.isConvenienteChromeCmd, "function");
assert.strictEqual(typeof reaper.writeCityCollectorPid, "function");
assert.strictEqual(typeof reaper.reapCityCollectorChrome, "function");
assert.strictEqual(reaper.CITY_COLLECTOR_CHROME_FLAG, "--conveniente-city-collector");
assert.strictEqual(reaper.CITY_COLLECTOR_PID_BASENAME, "conveniente-collector.pid");

assert.strictEqual(
  reaper.isCityCollectorCmd('chrome.exe --user-data-dir=C:\\conveniente\\dados\\city-collector-shards\\w2 --flag'),
  true,
  "path do shard precisa identificar o coletor"
);
assert.strictEqual(
  reaper.isCityCollectorCmd("chrome.exe --conveniente-city-collector --no-sandbox"),
  true,
  "flag curta precisa identificar o coletor mesmo sem path"
);
assert.strictEqual(
  reaper.isCityCollectorCmd('chrome.exe --user-data-dir=C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data'),
  false,
  "Chrome pessoal não é coletor"
);
assert.strictEqual(
  reaper.isConvenienteChromeCmd('chrome.exe --user-data-dir=C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data\\Conveniente\\joao'),
  true,
  "conta Conveniente continua no reap geral"
);
assert.strictEqual(
  reaper.isConvenienteChromeCmd('chrome.exe --user-data-dir=C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data'),
  false,
  "Chrome pessoal não entra no reap geral"
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "city-collector-reap-"));
try {
  assert.strictEqual(reaper.writeCityCollectorPid(tmp, 4242), true);
  assert.strictEqual(reaper.readCityCollectorPid(tmp), 4242);
  assert.ok(fs.existsSync(path.join(tmp, reaper.CITY_COLLECTOR_PID_BASENAME)));
  assert.strictEqual(reaper.clearCityCollectorPid(tmp), true);
  assert.strictEqual(reaper.readCityCollectorPid(tmp), 0);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

assert.ok(citySrc.includes("--conveniente-city-collector"), "launch do coletor carimba flag curta");
assert.ok(citySrc.includes("writeCityCollectorPid"), "launch grava PID do Chrome de cidade");
assert.ok(citySrc.includes("function shutdownDeltaCityCollector"), "collector precisa de shutdown exportado");
assert.ok(
  workerSrc.includes("global.__deltaCityCollectorRuntimePromise") &&
    workerSrc.includes("shutdownDeltaCityCollector"),
  "worker fecha o coletor no gracefulShutdown só se o runtime existiu"
);
assert.ok(!/reapCityCollectorChrome\(\s*['"]worker_shutdown/.test(workerSrc), "shutdown de um worker não pode matar coletor das outras células");
assert.ok(lifeSrc.includes("reap-chrome") && lifeSrc.includes("reapAllConvenienteChrome"), "CLI stop/reap cobre Chrome leftover");
assert.ok(lifeSrc.includes("Stop-Conveniente") === false, "cellLifecycle é Node, não PowerShell");
assert.ok(
  /reapAllConvenienteChrome\('index_boot_start_closed'\)/.test(indexSrc) &&
    !/convenieteChrome > 0/.test(indexSrc),
  "boot start-closed sempre tenta reap, não depende da contagem por command line"
);
assert.ok(iniciarSrc.includes("Stop-ConvenienteCityCollectorChrome"), "Iniciar tem rede de segurança em PowerShell");
assert.ok(iniciarSrc.includes("orphan_chrome before_launch"), "célula morta ainda reapha Chrome de cidade");
assert.ok(iniciarSrc.includes("city-collector-shards") && iniciarSrc.includes("conveniente-city-collector"), "PS mata pelos dois sinais");
assert.ok(reaperSrc.includes("collectCityCollectorJournalPids"), "reap geral lê journal de PID");
assert.ok(reaperSrc.includes("function reapCityCollectorChrome"), "reap dedicado do coletor existe");
assert.ok(reaperSrc.includes("killChromeMatchingDirs(dirs)"), "reap geral também mata por pasta do shard");
assert.ok(/for \(const pid of toKill\)/.test(reaperSrc) === false, "Chrome leftover morre em lote, não PID a PID");

console.log("ALL_OK");
process.exit(0);
