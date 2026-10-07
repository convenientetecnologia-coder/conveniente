# Prova o cinto sem subir o Conveniente e sem matar processo de producao.
$ErrorActionPreference = 'Stop'
$kit = 'C:\conveniente\porteiro\kit\manutencao.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($kit, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count -gt 0) { throw 'parse_fail' }

function Get-FuncText([string]$Name) {
    $found = $ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name
    }, $true) | Select-Object -First 1
    if (-not $found) { throw ('missing_' + $Name) }
    return $found.Extent.Text
}

$script:estadoJson = '{}'
$script:logs = New-Object System.Collections.Generic.List[string]
$script:stopped = 0
$script:stopOk = $true
$script:started = ''
$script:owner = $null
$script:hb = $null
$script:failed = 0

function Get-Estado {
    try { return ($script:estadoJson | ConvertFrom-Json) } catch { return $null }
}
function Save-EstadoFields([hashtable]$Fields) {
    $st = Get-Estado
    if (-not $st) { $st = [pscustomobject]@{} }
    foreach ($k in $Fields.Keys) {
        $st | Add-Member -NotePropertyName $k -NotePropertyValue $Fields[$k] -Force
    }
    $script:estadoJson = ($st | ConvertTo-Json -Compress)
}
function Write-Log([string]$Line) { [void]$script:logs.Add($Line) }
Invoke-Expression (Get-FuncText 'Get-EstadoProp')

$IndexStallAgeSec = 150
$IndexStallBootGraceSec = 240
$IndexStallCooldownSec = 900
$IndexStallMaxKills = 3
$IndexStallWindowSec = 21600
$IndexStallBootSkewMs = 120000
$IndexStallAbsurdAgeSec = 43200

function Read-IndexHeartbeat { return $script:hb }
function Test-IndexHeartbeatOwner($hb) { return $script:owner }
function Stop-StalledIndex([int]$IndexPid) {
    $script:stopped = $IndexPid
    return [bool]$script:stopOk
}
function Do-Start {
    param([string]$Reason = 'MANUAL')
    $script:started = $Reason
}

Invoke-Expression (Get-FuncText 'Get-StallKillEpochs')
Invoke-Expression (Get-FuncText 'Invoke-IndexStallGuard')

function Reset-Case {
    $script:estadoJson = '{}'
    $script:logs.Clear()
    $script:stopped = 0
    $script:stopOk = $true
    $script:started = ''
    $script:owner = [pscustomobject]@{ Pid = 4242; UptimeSec = 5000 }
}
function Set-HbAge([int]$AgeSec) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $script:hb = [pscustomobject]@{
        ts = [int64]($now - ([int64]$AgeSec * 1000))
        role = 'index'
        indexMain = $true
        pid = 4242
        bootTs = [int64]1700000000000
    }
}
function Assert-Case([string]$Name, [bool]$Ok) {
    if ($Ok) { Write-Output ('OK  ' + $Name) }
    else {
        $script:failed++
        Write-Output ('FAIL ' + $Name)
    }
}

Reset-Case
Set-HbAge 10
$r = Invoke-IndexStallGuard
Assert-Case 'fresh_no_kill' (($null -eq $r) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge 60
$r = Invoke-IndexStallGuard
Assert-Case 'slow_60s_no_kill' (($null -eq $r) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge 160
$r1 = Invoke-IndexStallGuard
$savedTs = [int64](Get-EstadoProp (Get-Estado) 'stallSuspectHbTs')
$hbTs = [int64]$script:hb.ts
$r2 = Invoke-IndexStallGuard
Assert-Case 'two_strikes_then_restart' (($r1 -eq 'stall_suspect') -and ($savedTs -eq $hbTs) -and ($r2 -eq 'stall_restart') -and ($script:stopped -eq 4242) -and ($script:started -eq 'STALL'))

Reset-Case
Set-HbAge 160
[void](Invoke-IndexStallGuard)
Set-HbAge 10
$r = Invoke-IndexStallGuard
$strikes = 0
try { $strikes = [int](Get-EstadoProp (Get-Estado) 'stallStrikes') } catch { $strikes = 0 }
Assert-Case 'recover_clears_strike' (($null -eq $r) -and ($strikes -eq 0) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge 200
$script:owner = [pscustomobject]@{ Pid = 4242; UptimeSec = 100 }
$r = Invoke-IndexStallGuard
Assert-Case 'boot_grace_no_kill' (($null -eq $r) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge 200
$script:owner = $null
$r = Invoke-IndexStallGuard
Assert-Case 'bad_identity_no_kill' (($null -eq $r) -and ($script:stopped -eq 0) -and ($script:logs -contains 'stall_guard_identity age=200'))

Reset-Case
Set-HbAge 50000
$r = Invoke-IndexStallGuard
Assert-Case 'absurd_age_no_kill' (($null -eq $r) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge -30
$r = Invoke-IndexStallGuard
Assert-Case 'clock_back_no_kill' (($null -eq $r) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge 400
[void](Invoke-IndexStallGuard)
[void](Invoke-IndexStallGuard)
$firstKill = $script:stopped
$script:stopped = 0
$script:started = ''
Set-HbAge 400
[void](Invoke-IndexStallGuard)
$r = Invoke-IndexStallGuard
Assert-Case 'cooldown_blocks_second' (($firstKill -eq 4242) -and ($null -eq $r) -and ($script:stopped -eq 0) -and ($script:started -eq ''))

Reset-Case
$nowSec = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$old = @(($nowSec - 20000), ($nowSec - 19000), ($nowSec - 18000)) -join ','
$script:estadoJson = (@{ stallKillEpochs = $old } | ConvertTo-Json -Compress)
Set-HbAge 400
[void](Invoke-IndexStallGuard)
$r = Invoke-IndexStallGuard
Assert-Case 'budget_blocks_fourth' (($null -eq $r) -and ($script:stopped -eq 0))

Reset-Case
Set-HbAge 400
$script:stopOk = $false
[void](Invoke-IndexStallGuard)
$r = Invoke-IndexStallGuard
$again = 0
Set-HbAge 400
[void](Invoke-IndexStallGuard)
$r2 = Invoke-IndexStallGuard
Assert-Case 'failed_kill_does_not_loop' (($r -eq 'stall_kill_incomplete') -and ($null -eq $r2) -and ($script:started -eq ''))

if ($script:failed -gt 0) { Write-Output ('FAILED ' + $script:failed); exit 1 }
Write-Output 'DECISION_OK'

$tmp = Join-Path $env:TEMP ('idxskew-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$js = Join-Path $tmp 'stay.js'
@'
const life = require("C:/conveniente/scripts/indexLifecycle.js");
life.install({ role: "index" });
const hb = life.readHeartbeat();
process.stdout.write(JSON.stringify({
  pid: process.pid,
  bootTs: hb.bootTs,
  ts: hb.ts,
  role: hb.role,
  indexMain: hb.indexMain === true
}) + "\n");
setInterval(() => {}, 1000);
'@ | Set-Content -LiteralPath $js -Encoding ASCII
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = '"' + $js + '"'
$psi.WorkingDirectory = $tmp
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables['CONVENIENTE_DADOS_DIR'] = $tmp
$proc = [System.Diagnostics.Process]::Start($psi)
$line = $proc.StandardOutput.ReadLine()
$info = $line | ConvertFrom-Json
$live = Get-Process -Id $proc.Id -ErrorAction Stop
$utc = $live.StartTime.ToUniversalTime()
$dto = New-Object System.DateTimeOffset $utc
$startMs = $dto.ToUnixTimeMilliseconds()
$skew = [math]::Abs($startMs - [int64]$info.bootTs)
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
if (-not $info.indexMain) { Write-Output 'FAIL skew_index_main'; exit 1 }
if ([string]$info.role -ne 'index') { Write-Output 'FAIL skew_role'; exit 1 }
if ($skew -gt 120000) { Write-Output ('FAIL skew_ms=' + $skew); exit 1 }
Write-Output ('OK  boot_skew_ms=' + $skew)
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Output 'SKEW_OK'
