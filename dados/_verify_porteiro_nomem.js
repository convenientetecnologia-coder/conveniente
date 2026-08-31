"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const kit = path.join(root, "porteiro", "kit", "manutencao.ps1");
const installKit = path.join(root, "porteiro", "kit", "install.ps1");
const instPorteiro = path.join(root, "instalar_porteiro.ps1");
const instConv = path.join(root, "instalar_conveniente.ps1");
const syncJs = path.join(root, "scripts", "porteiroSync.js");
const indexJs = path.join(root, "index.js");
const sweepJs = path.join(root, "scripts", "chromeMemorySweep.js");

let failed = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log("OK  " + name);
  } else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

const kitTxt = fs.readFileSync(kit, "utf8");
const instKitTxt = fs.readFileSync(installKit, "utf8");
const instPTxt = fs.readFileSync(instPorteiro, "utf8");
const instCTxt = fs.readFileSync(instConv, "utf8");
const syncTxt = fs.readFileSync(syncJs, "utf8");
const indexTxt = fs.readFileSync(indexJs, "utf8");
const sweepTxt = fs.readFileSync(sweepJs, "utf8");
const sync = require("../scripts/porteiroSync.js");

check("kit_exists", fs.existsSync(kit));
check("kit_version", /v5\.2\.0-nomem/.test(kitTxt));
check("kit_no_invoke_soft", !/Invoke-SoftMemClean/.test(kitTxt));
check("kit_no_diskclean_exe", !/DiskClean\.exe/i.test(kitTxt));
check("kit_no_standbylist_arg", !/ArgumentList\s+['"]\/StandbyList['"]/.test(kitTxt));
check("kit_no_mem_soft", !/\bmem_soft\b/.test(kitTxt));
check("kit_status_mem_off", /MemClean=OFF/.test(kitTxt));
check("kit_loop_mem_off", /mem_off/.test(kitTxt));
check("kit_reboot_04", /\$RebootHour\s*=\s*4/.test(kitTxt) && /Invoke-DailyReboot/.test(kitTxt));
check("kit_lixeira_or_temp", /Lixeira|Recycle|TEMP/i.test(kitTxt));
check("kit_auto_boot", /AUTO_BOOT/.test(kitTxt) && /Do-Start/.test(kitTxt));
check("kit_do_stop_exists", /function Do-Stop/.test(kitTxt));
check("kit_sourceIsNomem", sync.sourceIsNomem(kitTxt) === true);

check("install_kit_version", /v5\.2\.0-nomem/.test(instKitTxt));
check("install_kit_no_diskclean", !/DiskClean\.exe/i.test(instKitTxt));
check("install_does_not_do_stop", !/Do-Stop|-Action stop/.test(instKitTxt));

check("instalar_porteiro_exists", fs.existsSync(instPorteiro));
check("instalar_porteiro_refuses_mem", /Invoke-SoftMemClean/.test(instPTxt) && /exit 2/.test(instPTxt));
check("instalar_porteiro_calls_install", /porteiro\\kit\\install\.ps1/.test(instPTxt));
check("instalar_conveniente_calls_porteiro", /instalar_porteiro\.ps1/.test(instCTxt));

check("sync_no_taskkill_node", !/taskkill/i.test(syncTxt));
check("sync_no_do_stop", !/-Action\s+stop/.test(syncTxt) && !/taskkill/i.test(syncTxt));
check("sync_refuses_dirty_src", /src_has_memclean_refused/.test(syncTxt));
check("sync_installs_when_absent", /installed_fresh/.test(syncTxt) && /ensureDirs/.test(syncTxt));
check("sync_no_skip_dest_absent", !/skipped dest_absent/.test(syncTxt));
check("sync_asks_uac_only_if_tasks_missing", /installTasks/.test(syncTxt) && /requestTaskInstall/.test(syncTxt));
check("index_wires_sync", /porteiroSync\.js/.test(indexTxt));
const leiaTxt = fs.readFileSync(path.join(root, "porteiro", "LEIA-ME.txt"), "utf8");
const contratoTxt = fs.readFileSync(path.join(root, "porteiro", "CONTRATO.txt"), "utf8");
check("leia_index_not_owner", !/Dono: o index\.js/.test(leiaTxt));
check("leia_windows_owns", /tarefa ConvenientePorteiro/.test(leiaTxt) && /so CORRIGE/.test(leiaTxt));
check("contrato_index_not_owner", /NAO e o dono/.test(contratoTxt) && /sistema a parte/.test(contratoTxt));

check("sweep_still_owns_standby", /\/StandbyList/.test(sweepTxt) && /DiskClean\.exe/.test(sweepTxt));

check("sync_sourceIsNomem_rejects_old", sync.sourceIsNomem("Invoke-SoftMemClean DiskClean.exe /StandbyList mem_soft") === false);
check("destLooksLikeOld", sync.destLooksLikeOldMemClean("return 'mem_soft'") === true);

const fresh = sync.planEnsure({ destExists: false, destOld: false, hashEqual: false, loopAlive: false, tasksOk: false });
check("plan_fresh_copies", fresh.copy === true && fresh.restartLoop === true && fresh.installTasks === true);

const maeOld = sync.planEnsure({ destExists: true, destOld: true, hashEqual: false, loopAlive: true, tasksOk: true });
check("plan_mae_old_no_uac", maeOld.copy === true && maeOld.restartLoop === true && maeOld.installTasks === false);

const ok = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, loopAlive: true, tasksOk: true, runningNomem: true });
check("plan_already_ok_idle", ok.copy === false && ok.restartLoop === false && ok.installTasks === false);

const staleMem = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, loopAlive: true, tasksOk: true, runningNomem: false });
check("plan_stale_inmemory_restarts", staleMem.copy === false && staleMem.restartLoop === true && staleMem.installTasks === false);

const dead = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, loopAlive: false, tasksOk: true, runningNomem: false });
check("plan_loop_dead_restarts", dead.copy === false && dead.restartLoop === true && dead.installTasks === false);

const unknownLog = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, loopAlive: true, tasksOk: true, runningNomem: null });
check("plan_unknown_log_does_not_kill_alive", unknownLog.copy === false && unknownLog.restartLoop === false && unknownLog.installTasks === false);

check("sync_windows_owns_loop", /schtasks\.exe/.test(syncTxt) && /\/Run/.test(syncTxt));
check("sync_no_always_restart_on_index_boot", !/index_boot['\"]\) plan\.restartLoop = true/.test(syncTxt) && !/always recicla o loop/.test(syncTxt));
check("last_boot_nomem_true", sync.lastBootLineIsNomem("2026-08-31 18:00:00 [X][v5.2.0-nomem] BOOT v5.2.0-nomem reboot=04:00") === true);
check("last_boot_old_false", sync.lastBootLineIsNomem("2026-08-31 17:42:31 [X][v5.1.13-reboot] BOOT v5.1.13-reboot reboot=04:00") === false);
check("last_boot_empty_unknown", sync.lastBootLineIsNomem("") === null);

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
