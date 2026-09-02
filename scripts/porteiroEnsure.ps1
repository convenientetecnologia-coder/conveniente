# Garante o Porteiro 100% no clique HUMANO de Iniciar.
# Nao e dono do Conveniente. Nao mata Node. Nao limpa RAM.
# Pronto = kit git v5.2.0-nomem (hash) + tarefas Windows CERTAS + loop vivo.
# Se o kit/tarefas ja estao certos e so o loop morreu: religa SEM admin.
# Se faltar kit ou tarefa: pede admin UMA vez (UAC -Wait) e confere de novo.
# Exit 0 = ja estava pronto (ou loop religado sem install).
# Exit 10 = acabou de instalar/armar (o loop vai AUTO_BOOT o Conveniente).
# Exit 1/2/3 = falhou. Nao finja. Nao suba o Conveniente.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$KitSrc = 'C:\conveniente\porteiro\kit\manutencao.ps1'
$DestPs1 = 'C:\auto_vigia\manutencao.ps1'
$Installer = 'C:\conveniente\instalar_porteiro.ps1'
$LogFile = 'C:\auto_vigia\logs\porteiro_ensure.log'
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TaskLoop = 'ConvenientePorteiro'
$TaskNet = 'ConvenienteNetBoot'

function Write-EnsureLog([string]$Line) {
    try {
        New-Item -ItemType Directory -Path (Split-Path $LogFile) -Force | Out-Null
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $LogFile -Value "$ts $Line" -Encoding ASCII
    } catch {}
}

function Test-NomemFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $t = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($t)) { return $false }
    if ($t -match 'Invoke-SoftMemClean') { return $false }
    if ($t -match '\bmem_soft\b') { return $false }
    if ($t -match "ArgumentList '/StandbyList'") { return $false }
    if ($t -match 'Start-Process[\s\S]{0,240}DiskClean\.exe') { return $false }
    if ($t -notmatch 'v5\.2\.0-nomem') { return $false }
    if ($t -notmatch 'MemClean=OFF') { return $false }
    if ($t -notmatch 'ConvenienteDiskClean') { return $false }
    if ($t -notmatch 'function Ensure-DiskCleanTask') { return $false }
    return $true
}

function Test-HashMatch {
    if (-not (Test-Path -LiteralPath $KitSrc)) { return $false }
    if (-not (Test-Path -LiteralPath $DestPs1)) { return $false }
    try {
        $a = (Get-FileHash -LiteralPath $KitSrc -Algorithm MD5).Hash
        $b = (Get-FileHash -LiteralPath $DestPs1 -Algorithm MD5).Hash
        return ($a -eq $b)
    } catch {
        return $false
    }
}

function Get-TaskRunInfo([string]$Name) {
    $info = [pscustomobject]@{ Exists = $false; Enabled = $false; Arguments = '' }
    try {
        $t = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
        $info.Exists = $true
        $info.Enabled = [bool]$t.Settings.Enabled
        try { $info.Arguments = [string](@($t.Actions)[0].Arguments) } catch { $info.Arguments = '' }
        return $info
    } catch {}
    & schtasks.exe /Query /TN $Name 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { return $info }
    $info.Exists = $true
    $info.Enabled = $true
    try {
        $raw = (& schtasks.exe /Query /TN $Name /FO LIST /V 2>$null | Out-String)
        if ($raw -match '(?im)^\s*Scheduled Task State\s*:\s*Disabled\s*$') { $info.Enabled = $false }
        if ($raw -match '(?im)^\s*Task To Run\s*:\s*(.+)$') { $info.Arguments = $Matches[1].Trim() }
    } catch {}
    return $info
}

function Test-TaskLoopOk {
    $i = Get-TaskRunInfo $TaskLoop
    if (-not $i.Exists) { return $false }
    if (-not $i.Enabled) { return $false }
    if ($i.Arguments -notmatch 'manutencao\.ps1') { return $false }
    if ($i.Arguments -notmatch '-Action loop') { return $false }
    return $true
}

function Test-TaskNetOk {
    $i = Get-TaskRunInfo $TaskNet
    if (-not $i.Exists) { return $false }
    if (-not $i.Enabled) { return $false }
    if ($i.Arguments -notmatch 'manutencao\.ps1') { return $false }
    if ($i.Arguments -notmatch '-Action netboot') { return $false }
    return $true
}

function Test-LoopAlive {
    $lock = 'C:\auto_vigia\porteiro.lock'
    if (Test-Path -LiteralPath $lock) {
        try {
            $id = [int]((Get-Content -LiteralPath $lock -Raw).Trim())
            if ($id -gt 0) {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
                if ($cim -and $cim.CommandLine -and ($cim.CommandLine -match 'manutencao\.ps1') -and ($cim.CommandLine -match '-Action loop')) {
                    return $true
                }
            }
        } catch {}
    }
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        $c = [string]$p.CommandLine
        if ($c -and ($c -match 'manutencao\.ps1') -and ($c -match '-Action loop')) {
            return $true
        }
    }
    return $false
}

function Get-PorteiroSnapshot {
    return [pscustomobject]@{
        kitExists     = [bool](Test-Path -LiteralPath $KitSrc)
        destExists    = [bool](Test-Path -LiteralPath $DestPs1)
        destNomem     = [bool](Test-NomemFile $DestPs1)
        hashMatch     = [bool](Test-HashMatch)
        taskPorteiro  = [bool](Test-TaskLoopOk)
        taskNetBoot   = [bool](Test-TaskNetOk)
        loopAlive     = [bool](Test-LoopAlive)
    }
}

function Test-FilesAndTasksOk {
    $s = Get-PorteiroSnapshot
    return ($s.kitExists -and $s.destExists -and $s.destNomem -and $s.hashMatch -and $s.taskPorteiro -and $s.taskNetBoot)
}

function Test-PorteiroReady {
    $s = Get-PorteiroSnapshot
    return ($s.kitExists -and $s.destExists -and $s.destNomem -and $s.hashMatch -and $s.taskPorteiro -and $s.taskNetBoot -and $s.loopAlive)
}

function Write-Snapshot([string]$Prefix, $s) {
    $line = ("{0} kit={1} dest={2} nomem={3} hash={4} task={5} net={6} loop={7}" -f `
        $Prefix, $s.kitExists, $s.destExists, $s.destNomem, $s.hashMatch, $s.taskPorteiro, $s.taskNetBoot, $s.loopAlive)
    Write-Host $line
    Write-EnsureLog $line
}

function Wait-PorteiroReady([int]$Tries) {
    for ($i = 0; $i -lt $Tries; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-PorteiroReady) { return $true }
    }
    return $false
}

function Start-PorteiroLoopNow {
    & schtasks.exe /Run /TN $TaskLoop 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { return 'schtasks' }
    Start-Process -FilePath $PsExe -WindowStyle Hidden -ArgumentList (
        '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$DestPs1,'-Action','loop'
    ) | Out-Null
    return 'start_process'
}

$before = Get-PorteiroSnapshot
Write-Snapshot 'ANTES' $before

if (Test-PorteiroReady) {
    Write-Host 'Porteiro 100%: kit certo, tarefas Windows certas, loop vivo. Nao mexe. Sobe o Conveniente.'
    Write-EnsureLog 'READY skip_install'
    exit 0
}

if (Test-FilesAndTasksOk) {
    Write-Host 'Porteiro certo, loop morto. Religa o loop (sem admin).'
    $via = Start-PorteiroLoopNow
    Write-EnsureLog ("ARM_LOOP via=" + $via)
    if (Wait-PorteiroReady 25) {
        Write-Snapshot 'DEPOIS' (Get-PorteiroSnapshot)
        Write-Host 'Loop do Porteiro religado.'
        Write-EnsureLog 'OK loop_armed_no_uac'
        exit 10
    }
    Write-EnsureLog 'ARM_LOOP failed_still_dead'
}

if (-not (Test-Path -LiteralPath $Installer)) {
    Write-Host '[ERRO] C:\conveniente\instalar_porteiro.ps1 ausente. Dê git pull no Conveniente.'
    Write-EnsureLog 'FAIL installer_missing'
    exit 1
}
if (-not (Test-Path -LiteralPath $KitSrc)) {
    Write-Host '[ERRO] Kit do Porteiro ausente em C:\conveniente\porteiro\kit\manutencao.ps1'
    Write-EnsureLog 'FAIL kit_missing'
    exit 1
}

Write-Host 'Porteiro incompleto. Windows vai pedir administrador UMA vez. Aceite.'
Write-EnsureLog 'NEED_INSTALL asking_uac'

$p = $null
try {
    $p = Start-Process -FilePath $PsExe -Verb RunAs -Wait -PassThru -ArgumentList (
        "-NoProfile -ExecutionPolicy Bypass -File `"$Installer`""
    )
} catch {
    Write-Host '[ERRO] Admin recusado ou UAC cancelado. Clique Iniciar de novo e aceite.'
    Write-EnsureLog ("FAIL uac_exception " + $_.Exception.Message)
    exit 3
}

if ($null -eq $p) {
    Write-Host '[ERRO] Admin recusado. Clique Iniciar de novo e aceite o UAC.'
    Write-EnsureLog 'FAIL uac_null'
    exit 3
}
if ($p.ExitCode -ne 0) {
    Write-Host ("[ERRO] Instalacao do Porteiro falhou exit=" + $p.ExitCode)
    Write-EnsureLog ("FAIL installer_exit=" + $p.ExitCode)
    exit 2
}

if (-not (Wait-PorteiroReady 25)) {
    Write-Snapshot 'DEPOIS' (Get-PorteiroSnapshot)
    Write-Host '[ERRO] Porteiro ainda nao esta 100% depois do admin. Nao vou fingir.'
    Write-EnsureLog 'FAIL still_not_ready'
    exit 2
}

Write-Snapshot 'DEPOIS' (Get-PorteiroSnapshot)
Write-Host 'Porteiro instalado e armado (v5.2.0-nomem).'
Write-EnsureLog 'OK installed_ready'
exit 10
