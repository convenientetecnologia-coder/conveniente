"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const pfPath = path.join(root, "scripts", "winPagefileCommit.ps1");
const iniciar = fs.readFileSync(path.join(root, "scripts", "iniciarSistema.ps1"), "utf8");
const kit = fs.readFileSync(path.join(root, "porteiro", "kit", "manutencao.ps1"), "utf8");
const install = fs.readFileSync(path.join(root, "porteiro", "kit", "install.ps1"), "utf8");
const pf = fs.readFileSync(pfPath, "utf8");

let failed = 0;
function check(name, ok, extra) {
  if (ok) console.log("OK  " + name);
  else {
    failed += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

check("script_exists", fs.existsSync(pfPath) && pf.length > 800);
check("no_robe_virtus", !/virtusDelta/.test(pf) && !/worker\.js/.test(pf) && !/scripts\\robe/.test(pf));
check("no_uac", !/Verb RunAs/.test(pf) && !/MessageBox/.test(pf));
check("exit_codes", /exit 2/.test(pf) && /exit 3/.test(pf) && /if \(\$out\.Ok\) \{ exit 0 \}/.test(pf));
check("disk_signed_delta", /\$delta = \[int64\]\$wantBytes - \[int64\]\$currentPfBytes/.test(pf) && /30GB/.test(pf));
check("usage_slack", /-le 64/.test(pf));
check("keep_other_lines", /if \(\$raw -and \(\$raw -notmatch/.test(pf));
check("throttle_ok_log", /6 \* 60 \* 60 \* 1000/.test(pf) && /\[INFRA_BLINDAGEM_OK\]/.test(pf));
check("iniciar_copy_before_pagefile", iniciar.indexOf("copiedEarly") < iniciar.indexOf("pagefile_check") && iniciar.indexOf("pagefile_check") < iniciar.indexOf("$code = Start-ConvenienteNode"));
check("iniciar_abort_stops_loop", /Stop-LoopOnly[\s\S]{0,180}pagefile_abort_reboot/.test(iniciar));
check("iniciar_continue_on_skip", /pagefile_exit/.test(iniciar) && /pagefileCode -eq 2/.test(iniciar));
check("kit_quiet_only_start", /winPagefileCommit\.ps1/.test(kit.split("function Do-Start")[1] || "") && /-Quiet/.test((kit.split("function Do-Start")[1] || "").split("function Do-Status")[0]));
check("kit_no_wmi", !/Get-CimInstance/.test(kit) && !/Get-WmiObject/.test(kit) && !/Win32_/.test(kit));
check("install_no_false_ok", /pagefile skip exit=/.test(install) && /LASTEXITCODE -eq 0/.test(install));
check("install_skip_loop_on_reboot", /if \(\$pagefileReboot\)/.test(install));

const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const parsed = spawnSync(ps, ["-NoProfile", "-Command", "$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + pfPath.replace(/'/g, "''") + "', [ref]$t, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }; 'PARSE_OK'"], { encoding: "utf8" });
check("ps1_parses", parsed.status === 0 && /PARSE_OK/.test(parsed.stdout || ""), parsed.stdout || parsed.stderr);

const chk = spawnSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", pfPath, "-Check"], { encoding: "utf8" });
let report = null;
try { report = JSON.parse(String(chk.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop()); } catch {}
check("check_exit0", chk.status === 0);
check("check_json", !!(report && report.RamOk === true && Number(report.RamGb) >= 1 && Number(report.WantMb) === Number(report.RamGb) * 1024), JSON.stringify(report && { ram: report.RamGb, want: report.WantMb, disk: report.DiskOk, admin: report.Admin, live: report.Live }));
check("check_no_abort_fields", !!(report && typeof report.DiskOk === "boolean" && typeof report.Admin === "boolean" && typeof report.Configured === "boolean"));

const dry = spawnSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", pfPath, "-Apply", "-DryRun", "-Quiet"], { encoding: "utf8" });
const dryCode = dry.status === null ? 99 : dry.status;
check("dryrun_does_not_abort", dryCode !== 2, "exit=" + dryCode);
check("dryrun_skip_or_ok", dryCode === 0 || dryCode === 3, "exit=" + dryCode);

if (failed) {
  console.log("FAILED " + failed);
  process.exit(1);
}
console.log("ALL_OK");
