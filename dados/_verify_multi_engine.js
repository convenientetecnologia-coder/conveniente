"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const mot = read("scripts/chromeMotores.js");
const browser = read("scripts/browser.js");
const city = read("scripts/deltaCityCollector.js");
const cluster = read("scripts/clusterMaster.js");
const iniciar = read("scripts/iniciarSistema.ps1");
const dash = read("scripts/dashboard.js");
const gitignore = read(".gitignore");
const indexJs = read("index.js");
const cellEntry = read("scripts/cellEntry.js");
const workerJs = read("scripts/worker.js");

const indexBeforeRequire = indexJs.split("require(")[0] || "";
const cellBeforeRequire = cellEntry.split("require(")[0] || "";
const workerBeforeRequire = workerJs.split("require(")[0] || "";

const launchBlock = (browser.split("GUARDA: Chrome Stable only")[1] || browser.split("Motor isolado do worker")[1] || "")
  .slice(0, 400);
const cityLaunch = city.split("createCollectorRuntime")[1] || "";

check("modulo_existe", fs.existsSync(path.join(root, "scripts", "chromeMotores.js")));
check("taskkill_modulo", /taskkill/.test(mot) && /chrome\.exe/.test(mot));
check("chrome_unico", /single_engine/.test(mot) && /findMasterChromeExe/.test(mot));
check("log_ok", /MULTI_ENGINE_OK/.test(mot) && /multi_engine\.log/.test(mot));
check("nao_clona_no_ensure", /kind: 'single_engine'/.test(mot) && !/criando clone do Chrome mestre/.test(mot.split("function ensureWorkers")[1] || ""));
check("userdatadir_intacto_modulo", /User Data\\\\Conveniente/.test(mot) || /Conveniente\\<nome>/.test(mot));
check("browser_usa_motor", /chromeMotores\.resolveLaunchExeOrFatal/.test(browser));
check("city_usa_motor", /chromeMotores\.resolveLaunchExeOrFatal/.test(cityLaunch));
check("cluster_ensure_boot", /hardwareNodes/.test(cluster) && /ensureWorkers\(motorCapacity/.test(cluster));
check("cluster_ensure_grow", /purge: false/.test(cluster) && /hardwareNodes/.test(cluster));
check("boot_cli_sem_purge", /ensureWorkers\(capacity, \{ purge: false \}\)/.test(mot));
check("cluster_env_chrome_oficial", /findMasterChromeExe/.test(cluster) && /CHROME_PATH = motorExe/.test(cluster));
check("iniciar_sem_taskkill_chrome", !/taskkill\.exe \/F \/IM chrome\.exe/.test(iniciar));
check("iniciar_sem_boot_wait", !/--boot/.test(iniciar) && !/chromeMotores\.js/.test(iniciar));
check("iniciar_uma_janela", /Start-ConvenienteNodeHost/.test(iniciar) && /launch_host/.test(iniciar) && !/Chrome unico/.test(iniciar));
check("cluster_spawn_paralelo", /Promise\.all/.test(cluster) && /BOOT_MS/.test(cluster));
check("dash_allowlist", /multi_engine_last:/.test(dash) && /multi_engine_log:/.test(dash));
check("gitignore_motores", /motores\//.test(gitignore));
check("gitignore_last", /multi_engine_last\.json/.test(gitignore));
check("tp_index_sem_64", !/UV_THREADPOOL_SIZE\s*=\s*['"]64['"]/.test(indexBeforeRequire));
check("tp_cell_sem_64", !/UV_THREADPOOL_SIZE\s*=\s*['"]64['"]/.test(cellBeforeRequire));
check("tp_worker_sem_trava", !/UV_THREADPOOL_SIZE/.test(workerBeforeRequire));
check("tp_spawn_sem_64", !/env\.UV_THREADPOOL_SIZE\s*=\s*['"]64['"]/.test(cluster));
check("tp_sem_carimbo_64", !/THREADPOOL_TUNED_OK/.test(indexJs));
check("userdatadir_browser_intacto", /User Data\\Conveniente/.test(read("scripts/browser.js")) || /Conveniente', manifest\.nome/.test(browser));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
