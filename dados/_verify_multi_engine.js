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
check("root_motores", /C:\\\\conveniente\\\\motores/.test(mot) || /C:\\conveniente\\motores/.test(mot));
check("taskkill_modulo", /taskkill/.test(mot) && /chrome\.exe/.test(mot));
check("sem_fallback_modulo", /Sem fallback/.test(mot) && /MULTI_ENGINE_FATAL/.test(mot));
check("log_ok", /MULTI_ENGINE_OK/.test(mot) && /multi_engine\.log/.test(mot));
check("progresso_clone", /criando clone/.test(mot));
check("userdatadir_intacto_modulo", /User Data\\\\Conveniente/.test(mot) || /Conveniente\\<nome>/.test(mot));
check("browser_usa_motor", /chromeMotores\.resolveLaunchExeOrFatal/.test(browser));
check("browser_launch_nao_usa_stable", !/const executablePath = findChromeStable\(\)/.test(browser));
check("city_usa_motor", /chromeMotores\.resolveLaunchExeOrFatal/.test(cityLaunch));
check("city_sem_programfiles_fallback", !/PROGRAMFILES[\s\S]{0,80}chrome\.exe/.test(cityLaunch.slice(0, 2500)));
check("cluster_ensure_boot", /hardwareNodes/.test(cluster) && /ensureWorkers\(motorCapacity, \{ purge: true \}\)/.test(cluster));
check("cluster_ensure_grow", /purge: false/.test(cluster) && /hardwareNodes/.test(cluster));
check("boot_cli_teto", /hardwareNodes/.test(mot) && /ensureWorkers\(capacity, \{ purge: true \}\)/.test(mot));
check("grow_nao_apaga_em_uso", /if \(!purge && exists\)/.test(mot) || /em uso, troca de versao so no proximo Iniciar/.test(mot));
check("cluster_env_motor", /CHROME_MOTOR_EXE/.test(cluster) && /CHROME_PATH = motorExe/.test(cluster));
check("iniciar_taskkill", /taskkill\.exe \/F \/IM chrome\.exe/.test(iniciar));
check("iniciar_boot_js", /chromeMotores\.js/.test(iniciar) && /--boot/.test(iniciar));
check("iniciar_abort", /motores_fatal/.test(iniciar) && /NAO iniciou/.test(iniciar));
check("index_exit_fatal", /process\.exit\(1\)/.test(indexJs) && /Sem fallback ao Chrome unificado/.test(indexJs));
check("dash_allowlist", /multi_engine_last:/.test(dash) && /multi_engine_log:/.test(dash));
check("iniciar_mostra_copia", /motores do Chrome/.test(iniciar) && /ForegroundColor Red/.test(iniciar));
check("gitignore_motores", /motores\//.test(gitignore));
check("gitignore_last", /multi_engine_last\.json/.test(gitignore));
check("tp_index_set_antes_require", /UV_THREADPOOL_SIZE\s*=\s*['"]64['"]/.test(indexBeforeRequire));
check("tp_index_trava_exit", /process\.exit\(1\)/.test(indexBeforeRequire) && /UV_THREADPOOL_SIZE/.test(indexBeforeRequire));
check("tp_cell_set_antes_require", /UV_THREADPOOL_SIZE\s*=\s*['"]64['"]/.test(cellBeforeRequire));
check("tp_cell_trava_exit", /process\.exit\(1\)/.test(cellBeforeRequire));
check("tp_worker_trava_antes_require", /UV_THREADPOOL_SIZE/.test(workerBeforeRequire) && /process\.exit\(1\)/.test(workerBeforeRequire));
check("tp_worker_nao_seta_se_modulo", /require\.main === module/.test(workerBeforeRequire));
check("tp_spawn_env_64", /env\.UV_THREADPOOL_SIZE\s*=\s*['"]64['"]/.test(cluster));
check("tp_carimbo_ok", /THREADPOOL_TUNED_OK/.test(indexJs));
check("userdatadir_browser_intacto", /User Data\\Conveniente/.test(read("scripts/browser.js")) || /Conveniente', manifest\.nome/.test(browser));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
