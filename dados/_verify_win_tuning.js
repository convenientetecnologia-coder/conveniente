"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const tune = fs.readFileSync(path.join(root, "scripts", "winTuningMaster.ps1"), "utf8");
const iniciar = fs.readFileSync(path.join(root, "scripts", "iniciarSistema.ps1"), "utf8");
const kit = fs.readFileSync(path.join(root, "porteiro", "kit", "manutencao.ps1"), "utf8");
const sentinel = fs.readFileSync(path.join(root, "scripts", "forensicSentinel.ps1"), "utf8");

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

check("tune_exists", tune.length > 400);
check("tune_no_runas", !/Verb RunAs/.test(tune) && !/Start-Process[\s\S]{0,120}RunAs/.test(tune));
check("tune_no_messagebox", !/MessageBox/.test(tune));
check("tune_try_step", /function Invoke-Step/.test(tune) && /try \{/.test(tune));
check("tune_log_path", /dados\\logs/.test(tune) && /windows_tuning\.log/.test(tune));
check("tune_wersvc_manual", /Set-HostServiceMitigated 'WerSvc' 'Manual'/.test(tune));
check("tune_wersvc_not_disabled", !/Set-HostServiceMitigated 'WerSvc' 'Disabled'/.test(tune) && !/WerSvc' 'Disabled'/.test(tune));
check("tune_diagtrack_disabled", /Set-HostServiceMitigated 'DiagTrack' 'Disabled'/.test(tune));
check("tune_sysmain_disabled", /Set-HostServiceMitigated 'SysMain' 'Disabled'/.test(tune));
check("tune_admin_gate", /sem_admin/.test(tune) && /Test-IsAdmin/.test(tune));
check("tune_power_ultimate", /e9a42b02-d5df-448d-aa00-03f14749eb61/.test(tune) && /PROCTHROTTLEMIN 100/.test(tune) && /disk-timeout-ac/.test(tune));
check("tune_heap_backup", /windows_subsystem_windows\.bak/.test(tune) && /SharedSection=/.test(tune) && /replace_refused/.test(tune));
check("tune_heap_never_shrink", /if \(\$targetB -lt \$InteractiveHeapMinKb\)/.test(tune) && /if \(\$b -ge \$targetB\)/.test(tune));
check("tune_node_scoped", /Test-ConvenienteNodeCmd/.test(tune) && /scripts\\\\worker\\.js/.test(tune));
check("tune_chrome_scoped", /Test-ConvenienteChromeCmd/.test(tune) && /c:\\\\conveniente/.test(tune));
check("tune_excludes_other_node", /sitechatbot/.test(tune) && /winTuningMaster/.test(tune));
check("tune_rdp_images", /mstsc\.exe/.test(tune) && /rdpclip\.exe/.test(tune) && /TermService/.test(tune));
check("tune_watch_mutex", /Local\\ConvenienteWinTuningWatch/.test(tune) && /\$PollSec = 5/.test(tune));
check("tune_no_1ms_spin", !/Start-Sleep -Milliseconds 1/.test(tune) && !/Start-Sleep -Seconds 0/.test(tune));
check("tune_stamp", /\[TUNING_OK\]/.test(tune) && /\[TUNING_PARTIAL\]/.test(tune));
check("tune_no_fastfail_lie", !/elimina o FastFail/.test(tune) && !/saca o erro crônico/.test(tune));
check("tune_dryrun", /\$DryRun/.test(tune));
check("tune_exit_zero", /exit 0/.test(tune));
check("sentinel_still_wants_wersvc_manual", /Set-Service -Name WerSvc -StartupType Manual/.test(sentinel));
check("iniciar_fires_boot", /winTuningMaster\.ps1/.test(iniciar) && /'-Boot'/.test(iniciar) && !/Start-Process[\s\S]{0,400}-Wait/.test(iniciar));
check("kit_fires_boot", /Invoke-WinTuningSilent/.test(kit) && /-Boot/.test(kit));
const install = fs.readFileSync(path.join(root, "porteiro", "kit", "install.ps1"), "utf8");
check("install_apply_not_watch", /winTuningMaster\.ps1/.test(install) && /-Apply/.test(install) && !/-Boot/.test(install) && !/-Watch/.test(install));

check("tune_adendo_visualfx", /VisualFXSetting/.test(tune) && /VisualEffects/.test(tune) && /Want 2/.test(tune));
check("tune_adendo_minanimate", /MinAnimate/.test(tune) && /WindowMetrics/.test(tune) && /Want '0'/.test(tune) && /Type String/.test(tune));
check("tune_adendo_win32pri", /Win32PrioritySeparation/.test(tune) && /Want 24/.test(tune) && /0x18/.test(tune) && /NeedAdmin/.test(tune));
check("tune_adendo_stamp", /\[TUNING_ADENDO_OK\] Efeitos visuais mitigados e Prioridade de Background injetada via Registro com sucesso\./.test(tune));
check("tune_adendo_trycatch", /Invoke-Step 'reg_visualfx'/.test(tune) && /Invoke-Step 'reg_minanimate'/.test(tune) && /Invoke-Step 'reg_win32priority'/.test(tune));
check("tune_forensic_jsonl", /windows_tuning\.forensic\.jsonl/.test(tune) && /function Write-Forensic/.test(tune) && /event = 'begin'/.test(tune) && /event = 'adendo'/.test(tune));
check("tune_forensic_before_after", /before=/.test(tune) && /Write-Forensic/.test(tune) && /priority_backup/.test(tune));
check("tune_no_explorer_kill", !/Stop-Process.*explorer/i.test(tune) && !/taskkill.*explorer/i.test(tune));

const dash = fs.readFileSync(path.join(root, "scripts", "dashboard.js"), "utf8");
check("dash_tune_allowlist", /windows_tuning:/.test(dash) && /windows_tuning_forensic:/.test(dash) && /windows_tuning_state:/.test(dash));

const olhos = fs.readFileSync(path.join(root, "scripts", "diag_olhos_deus.js"), "utf8");
check("olhos_tune_section", /windows_tuning\.forensic\.jsonl/.test(olhos) && /windowsTuning/.test(olhos));

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
