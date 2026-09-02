"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const kit = path.join(root, "porteiro", "kit", "manutencao.ps1");
const installKit = path.join(root, "porteiro", "kit", "install.ps1");
const instPorteiro = path.join(root, "instalar_porteiro.ps1");
const instConv = path.join(root, "instalar_conveniente.ps1");
const syncJs = path.join(root, "scripts", "porteiroSync.js");
const ensurePs1 = path.join(root, "scripts", "porteiroEnsure.ps1");
const iniciarPs1 = path.join(root, "scripts", "iniciarSistema.ps1");
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
const ensureTxt = fs.readFileSync(ensurePs1, "utf8");
const iniciarTxt = fs.readFileSync(iniciarPs1, "utf8");
const indexTxt = fs.readFileSync(indexJs, "utf8");
const sweepTxt = fs.readFileSync(sweepJs, "utf8");
const sync = require("../scripts/porteiroSync.js");

check("kit_exists", fs.existsSync(kit));
check("kit_version", /v5\.2\.0-nomem/.test(kitTxt));
check("kit_no_invoke_soft", !/Invoke-SoftMemClean/.test(kitTxt));
check("kit_no_start_process_diskclean", !/Start-Process[\s\S]{0,240}DiskClean\.exe/i.test(kitTxt));
check("kit_no_standbylist_arglist", !/ArgumentList\s+['"]\/StandbyList['"]/.test(kitTxt));
check("kit_no_mem_soft", !/\bmem_soft\b/.test(kitTxt));
check("kit_status_mem_off", /MemClean=OFF/.test(kitTxt));
check("kit_loop_mem_off", /mem_off/.test(kitTxt));
check("kit_diskclean_task", /ConvenienteDiskClean/.test(kitTxt) && /function Ensure-DiskCleanTask/.test(kitTxt));
check("kit_diskclean_task_system", /UserId 'SYSTEM'/.test(kitTxt) && /ensure_diskclean/.test(kitTxt));
check("kit_loop_ensures_task", /Ensure-DiskCleanTask/.test(kitTxt.split("function Do-Loop")[1] || ""));
check("kit_loop_does_not_run_task", !/Start-ScheduledTask/.test(kitTxt) && !/schtasks\.exe \/Run/.test(kitTxt));
check("kit_reboot_04", /\$RebootHour\s*=\s*4/.test(kitTxt) && /Invoke-DailyReboot/.test(kitTxt));
check("kit_lixeira_or_temp", /Lixeira|Recycle|TEMP/i.test(kitTxt));
check("kit_auto_boot", /AUTO_BOOT/.test(kitTxt) && /Do-Start/.test(kitTxt));
check("kit_do_stop_exists", /function Do-Stop/.test(kitTxt));
check("kit_sourceIsNomem", sync.sourceIsNomem(kitTxt) === true);

check("install_kit_version", /v5\.2\.0-nomem/.test(instKitTxt));
check("install_kit_no_diskclean_exe", !/DiskClean\.exe/i.test(instKitTxt));
check("install_calls_ensure_diskclean", /ensure_diskclean/.test(instKitTxt));
check("install_does_not_do_stop", !/Do-Stop|-Action stop/.test(instKitTxt));

check("instalar_porteiro_exists", fs.existsSync(instPorteiro));
check("instalar_porteiro_refuses_mem", /Invoke-SoftMemClean/.test(instPTxt) && /exit 2/.test(instPTxt));
check("instalar_porteiro_calls_install", /porteiro\\kit\\install\.ps1/.test(instPTxt));
check("instalar_conveniente_calls_porteiro", /instalar_porteiro\.ps1/.test(instCTxt));
check("instalar_conveniente_iniciar_vbs", /INICIAR_SISTEMA\.vbs/.test(instCTxt) && /wscript\.exe/.test(instCTxt));
check("instalar_porteiro_uac_cancel_exits", /Admin recusado/.test(instPTxt) && /exit 3/.test(instPTxt));

check("ensure_script_exists", fs.existsSync(ensurePs1));
check("ensure_waits_uac", /Verb RunAs/.test(ensureTxt) && /-Wait/.test(ensureTxt));
check("ensure_installer_no_self_elevate", /NoSelfElevate/.test(ensureTxt));
check("installer_no_self_elevate_exits_3", /\$NoSelfElevate/.test(instPTxt) && /Precisa de administrador/.test(instPTxt));
check("iniciar_no_uac_no_ok", !/AlreadyElevated/.test(iniciarTxt) && !/MessageBox/.test(iniciarTxt) && !/Verb RunAs/.test(iniciarTxt) && !/porteiroEnsure\.ps1/.test(iniciarTxt));
check("iniciar_starts_node_direct", /title Conveniente_Node/.test(iniciarTxt) && /Start-Process cmd\.exe/.test(iniciarTxt));
check("iniciar_silent_copy", /Copy-KitSilent/.test(iniciarTxt) && /Copy-Item/.test(iniciarTxt));
check("iniciar_loop_silent", /Start-LoopSilent/.test(iniciarTxt) && /WindowStyle Hidden/.test(iniciarTxt));
check("ensure_uac_same_process", /param\(\[switch\]\$ReturnOnly\)/.test(ensureTxt) && /function Invoke-PorteiroEnsureMain/.test(ensureTxt));
check("ensure_inprocess_if_admin", /Test-IsAdmin/.test(ensureTxt) && /inprocess_admin/.test(ensureTxt));
check("ensure_ready_needs_tasks_and_loop", /ConvenientePorteiro/.test(ensureTxt) && /ConvenienteNetBoot/.test(ensureTxt) && /Test-LoopAlive/.test(ensureTxt) && /Test-HashMatch/.test(ensureTxt));
check("ensure_task_checks_action", /Test-TaskLoopOk/.test(ensureTxt) && /-Action loop/.test(ensureTxt) && /-Action netboot/.test(ensureTxt) && /Settings\.Enabled/.test(ensureTxt));
check("ensure_arms_loop_without_uac", /Test-FilesAndTasksOk/.test(ensureTxt) && /Start-PorteiroLoopNow/.test(ensureTxt) && /schtasks\.exe \/Run/.test(ensureTxt) && /loop_armed_no_uac/.test(ensureTxt));
check("ensure_install_exit_10", /OK installed_ready/.test(ensureTxt) && /OK loop_armed_no_uac/.test(ensureTxt) && (ensureTxt.match(/return 10/g) || []).length >= 2);
check("ensure_does_not_kill_node", !/taskkill/i.test(ensureTxt) && !/-Action stop/.test(ensureTxt));
check("iniciar_script_exists", fs.existsSync(iniciarPs1));
check("iniciar_already_up_skips", /already_up/.test(iniciarTxt) && /Test-ConvenienteUp/.test(iniciarTxt));
check("install_exits_if_tasks_fail", /if \(-not \$okTask -or -not \$okNet\) \{ exit 1 \}/.test(instKitTxt) && /exit 0/.test(instKitTxt));
const iniciarVbs = path.join(root, "porteiro", "INICIAR_SISTEMA.vbs");
check("iniciar_vbs_exists", fs.existsSync(iniciarVbs));
check("iniciar_vbs_hidden", /WindowStyle Hidden/.test(fs.readFileSync(iniciarVbs, "utf8")) && /iniciarSistema\.ps1/.test(fs.readFileSync(iniciarVbs, "utf8")));
check("iniciar_bat_removed", !fs.existsSync(path.join(root, "porteiro", "INICIAR_SISTEMA.bat")));
check("install_kit_iniciar_uses_vbs", /INICIAR_SISTEMA\.vbs/.test(instKitTxt) && /wscript\.exe/.test(instKitTxt));
const doStartBody = (kitTxt.split("function Do-Start")[1] || "").split("function Do-Status")[0];
check("kit_do_start_no_ensure", !/Invoke-PorteiroEnsure/.test(doStartBody) && !/porteiroEnsure\.ps1/.test(doStartBody));
check("kit_ensure_function_gone", !/function Invoke-PorteiroEnsure/.test(kitTxt));
check("kit_ensure_not_in_auto", !/Invoke-PorteiroEnsure/.test((kitTxt.split("function Do-Loop")[1] || "").split("function ")[0]));

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
check("contrato_iniciar_silencio", /Clique INICIAR/.test(contratoTxt) && /Sem admin/.test(contratoTxt) && /sem OK/.test(contratoTxt));
check("sync_loop_via_start_process", /start_process/.test(syncTxt));

check("sweep_still_owns_standby", /\/StandbyList/.test(sweepTxt) && /DiskClean\.exe/.test(sweepTxt) && /ConvenienteDiskClean/.test(sweepTxt) && /runViaScheduledTask/.test(sweepTxt));
check("sweep_prod_asks_windows", /function runStandbySweep[\s\S]{0,220}runViaScheduledTask/.test(sweepTxt));
check("sync_no_kill_diskclean", !/\^DiskClean/.test(syncTxt) && !/CommandLine -match '\/StandbyList'/.test(syncTxt));

check("sync_sourceIsNomem_rejects_old", sync.sourceIsNomem("Invoke-SoftMemClean DiskClean.exe /StandbyList mem_soft") === false);
check("destLooksLikeOld", sync.destLooksLikeOldMemClean("return 'mem_soft'") === true);
check("destLooksLikeOld_kit_is_new", sync.destLooksLikeOldMemClean(kitTxt) === false);

const fresh = sync.planEnsure({ destExists: false, destOld: false, hashEqual: false, taskRunning: false, tasksOk: false });
check("plan_fresh_copies", fresh.copy === true && fresh.restartLoop === true && fresh.installTasks === true);

const maeOld = sync.planEnsure({ destExists: true, destOld: true, hashEqual: false, taskRunning: true, tasksOk: true });
check("plan_mae_old_no_uac", maeOld.copy === true && maeOld.restartLoop === true && maeOld.installTasks === false);

const ok = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, taskRunning: true, tasksOk: true, runningNomem: true });
check("plan_already_ok_idle", ok.copy === false && ok.restartLoop === false && ok.installTasks === false);

const staleMem = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, taskRunning: true, tasksOk: true, runningNomem: false });
check("plan_stale_inmemory_restarts", staleMem.copy === false && staleMem.restartLoop === true && staleMem.installTasks === false);

const dead = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, taskRunning: false, tasksOk: true, runningNomem: false });
check("plan_loop_dead_restarts", dead.copy === false && dead.restartLoop === true && dead.installTasks === false);

const unknownLog = sync.planEnsure({ destExists: true, destOld: false, hashEqual: true, taskRunning: true, tasksOk: true, runningNomem: null });
check("plan_unknown_log_does_not_kill_alive", unknownLog.copy === false && unknownLog.restartLoop === false && unknownLog.installTasks === false);

check("sync_windows_owns_loop", /schtasks\.exe/.test(syncTxt) && /\/Run/.test(syncTxt));
check("sync_ends_task_before_run", /\/End/.test(syncTxt) && /ConvenientePorteiro/.test(syncTxt));
check("sync_deletes_old_limpeza_task", /LimpezaAutomaticaConveniente/.test(syncTxt));
check("sync_kills_old_kit", /porteiro_loop/.test(syncTxt) && /limpeza_memoria/.test(syncTxt) && /vigia\.bat/.test(syncTxt));
check("kit_rival_kill", /function Stop-RivalVigia/.test(kitTxt) && /rival_kill/.test(kitTxt));
check("kit_no_exit_if_lock_held", !/exit 0/.test(kitTxt.split("function Do-Loop")[1] || ""));
check("sync_no_always_restart_on_index_boot", !/index_boot['\"]\) plan\.restartLoop = true/.test(syncTxt) && !/always recicla o loop/.test(syncTxt));
check("last_boot_nomem_true", sync.lastBootLineIsNomem("2026-08-31 18:00:00 [X][v5.2.0-nomem] BOOT v5.2.0-nomem reboot=04:00") === true);
check("last_boot_old_false", sync.lastBootLineIsNomem("2026-08-31 17:42:31 [X][v5.1.13-reboot] BOOT v5.1.13-reboot reboot=04:00") === false);
check("last_boot_empty_unknown", sync.lastBootLineIsNomem("") === null);

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
