# C:\auto_vigia\manutencao.ps1  (fonte: kit\manutencao.ps1)
# TUDO-EM-UM: porteiro + start/stop/status
# Nao altera C:\conveniente
# Regra: se JA estiver ligado, NUNCA sobe de novo.
# RAM (StandbyList) NAO vive neste loop (v5.2.0-nomem).
# Este script so GARANTE a tarefa SYSTEM ConvenienteDiskClean (on-demand).
# Quem cronometra 15 min e pede o Run e o Conveniente (chromeMemorySweep.js).

param(
    [ValidateSet('loop','start','stop','status','install','netboot','ensure_diskclean')]
    [string]$Action = 'status'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

$Root        = 'C:\auto_vigia'
$Conveniente = 'C:\conveniente'
$IndexJs     = Join-Path $Conveniente 'index.js'
$PauseFlag   = Join-Path $Root 'PAUSED.flag'
$NoRebootFlag = Join-Path $Root 'NO_REBOOT.flag'
$LockFile    = Join-Path $Root 'porteiro.lock'
$LogFile     = Join-Path $Root 'logs\porteiro.log'
$PidFile     = Join-Path $Root 'master.pid'
$PanelPort   = 8088
$Version     = 'v5.2.0-nomem'

# Reboot diario (1x/dia): limpeza TEMP+Lixeira e reinicia. Producao = 04:00.
# So dispara DENTRO da janela (ex.: 04:00-04:20). Nunca "atrasado" ao instalar de tarde.
$RebootHour      = 4
$RebootMinute    = 0
$RebootWindowMin = 20
# Em TODO boot: espera N min, confirma sem net de verdade, 1 reboot extra max/dia.
$NetCheckWaitMin   = 4
$NetConfirmTries   = 4
$NetConfirmGapSec  = 15
# So para laboratorio: forca 1 falha de rede apos o 1o reboot. Em uso normal: $false.
$TestForceNetFailOnce = $false

# ---------------- helpers ----------------
function Ensure-Dirs {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $Root 'logs') -Force | Out-Null
}

function Write-Log([string]$Line) {
    try {
        Ensure-Dirs
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        $hostName = $env:COMPUTERNAME
        Add-Content -LiteralPath $LogFile -Value "$ts [$hostName][$Version] $Line" -Encoding ASCII
        $item = Get-Item -LiteralPath $LogFile -ErrorAction SilentlyContinue
        if ($item -and $item.Length -gt 1500000) {
            $bak = Join-Path (Split-Path $LogFile) 'porteiro.prev.log'
            Remove-Item $bak -Force -ErrorAction SilentlyContinue
            Move-Item $LogFile $bak -Force
        }
    } catch {}
}

function Set-MaxPerf {
    foreach ($g in @(
        '808ffb3b-6e1f-4fb0-910c-53827e1f97ca',
        '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
        'e9a42b02-d5df-448d-aa00-03f14749eb61'
    )) {
        & powercfg.exe /setactive $g 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
    }
}

function Test-Paused { Test-Path -LiteralPath $PauseFlag }
function Test-NoReboot { Test-Path -LiteralPath $NoRebootFlag }

function Set-PausedFlag([bool]$On) {
    if ($On) { '1' | Set-Content $PauseFlag -Encoding ASCII }
    else { Remove-Item $PauseFlag -Force -ErrorAction SilentlyContinue }
}

function Test-Port8088 {
    try {
        $c = @(Get-NetTCPConnection -LocalPort $PanelPort -State Listen -ErrorAction SilentlyContinue)
        if ($c.Count -gt 0) { return $true }
    } catch {}
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $ar = $tcp.BeginConnect('127.0.0.1', $PanelPort, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(250, $false)
        if ($ok -and $tcp.Connected) { $tcp.Close(); return $true }
        $tcp.Close()
    } catch {}
    return $false
}

function Get-NodeCount { @(Get-Process -Name node -ErrorAction SilentlyContinue).Count }
function Get-ChromeCount {
    # Roda DENTRO da VM: conta processos chrome.exe locais (mesmo metodo do STATUS)
    @(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count
}

function Get-MasterIndexPids {
    $pids = @()
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
        $cmd = [string]$p.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { continue }
        $c = $cmd.ToLowerInvariant()
        if ($c -match 'index\.js') { $pids += [int]$p.ProcessId }
    }
    return $pids
}

function Get-SystemState {
    # Qualquer sinal REAL = LIGADO (nao sobe de novo)
    $masters = @(Get-MasterIndexPids)
    $nodes   = Get-NodeCount
    $port    = Test-Port8088

    # pid file so conta se o processo ainda existe E ainda ha node OU porta
    # (evita fantasma: pid reaproveitado / arquivo velho com Nodes=0)
    $pidOk = $false
    if (Test-Path $PidFile) {
        try {
            $id = [int]((Get-Content $PidFile -Raw).Trim())
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc -and ($nodes -gt 0 -or $port -or $masters.Count -gt 0)) {
                $pidOk = $true
            } elseif (-not $proc -or ($nodes -eq 0 -and -not $port -and $masters.Count -eq 0)) {
                Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
            }
        } catch {
            Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        }
    }

    $up = ($masters.Count -gt 0) -or $port -or ($nodes -gt 0)
    $why = if ($masters.Count -gt 0) { 'master' }
           elseif ($port) { 'port' }
           elseif ($nodes -gt 0) { 'node' }
           else { 'down' }

    return [pscustomobject]@{
        Up = $up; Why = $why
        Masters = $masters.Count; Nodes = $nodes
        Port = $port; Chrome = (Get-ChromeCount)
        Paused = (Test-Paused)
    }
}

function Get-DiskFreeGB {
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    if (-not $d) { return $null }
    [math]::Round($d.FreeSpace / 1GB, 2)
}

function Get-CpuAvg {
    $vals = @()
    for ($i = 0; $i -lt 2; $i++) {
        $a = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
        if ($null -ne $a) { $vals += [double]$a }
        if ($i -lt 1) { Start-Sleep -Seconds 1 }
    }
    if ($vals.Count -eq 0) { return 100 }
    [math]::Round(($vals | Measure-Object -Average).Average, 1)
}

function Get-EstadoPath { Join-Path $Root 'estado.json' }

function Get-Estado {
    $path = Get-EstadoPath
    if (-not (Test-Path $path)) { return $null }
    try { return Get-Content $path -Raw | ConvertFrom-Json } catch { return $null }
}

# StrictMode quebra se acessar propriedade inexistente no estado.json antigo
function Get-EstadoProp($st, [string]$Name) {
    if (-not $st) { return $null }
    $p = $st.PSObject.Properties[$Name]
    if ($p) { return $p.Value }
    return $null
}

function Save-EstadoFields([hashtable]$Fields) {
    $path = Get-EstadoPath
    $st = Get-Estado
    if (-not $st) { $st = [pscustomobject]@{} }
    foreach ($k in $Fields.Keys) { $st | Add-Member -NotePropertyName $k -NotePropertyValue $Fields[$k] -Force }
    try { ($st | ConvertTo-Json -Compress) | Set-Content $path -Encoding UTF8 } catch {}
}

function Get-DiskDailyOffsetMin {
    # Cada VM ganha um horario fixo diferente (04:30 + 0..89 min), gravado na 1a vez
    $st = Get-Estado
    $existing = Get-EstadoProp $st 'diskDailyOffsetMin'
    if ($null -ne $existing -and "$existing" -ne '') { return [int]$existing }
    $h = 0
    foreach ($ch in $env:COMPUTERNAME.ToCharArray()) { $h = ($h * 31 + [int][char]$ch) % 100000 }
    $off = $h % 90
    Save-EstadoFields @{ diskDailyOffsetMin = $off }
    return $off
}

function Get-DiskDailyScheduleToday {
    $off = Get-DiskDailyOffsetMin
    $today = Get-Date -Hour 0 -Minute 0 -Second 0
    $start = $today.AddHours(4).AddMinutes(30)
    $end = $today.AddHours(6)
    $runAt = $start.AddMinutes($off)
    [pscustomobject]@{ Start = $start; End = $end; RunAt = $runAt; OffsetMin = $off }
}

function Test-DiskDailyDue {
    # 1x/dia na janela; horario por VM ja e espalhado (offset 0..89)
    # Nao exige Chrome fechado (madrugada costuma estar livre)
    $now = Get-Date
    $sch = Get-DiskDailyScheduleToday
    if ($now -lt $sch.Start -or $now -ge $sch.End) { return $false }
    if ($now -lt $sch.RunAt) { return $false }
    $st = Get-Estado
    $todayKey = $now.ToString('yyyy-MM-dd')
    $lastDay = Get-EstadoProp $st 'lastDiskDailyDate'
    if ($lastDay -eq $todayKey) { return $false }
    return $true
}

function Invoke-DiskTempClean {
    # Limpeza sutil: so TEMP + Lixeira. Nao mata Chrome. Nao mexe em C:\conveniente.
    foreach ($t in @($env:TEMP, 'C:\Windows\Temp')) {
        if (-not (Test-Path $t)) { continue }
        Get-ChildItem $t -Force -File -ErrorAction SilentlyContinue | Select-Object -First 800 | ForEach-Object {
            if ($_.FullName -match '(?i)\\conveniente\\') { return }
            try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {}
        }
    }
    try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}
}

function Invoke-DiskDailyClean {
    # Grava ANTES: anti-loop na janela da madrugada (nao repete a cada 3 min)
    $sch = Get-DiskDailyScheduleToday
    Save-EstadoFields @{
        lastDiskDailyDate = (Get-Date).ToString('yyyy-MM-dd')
        lastDiskDailyUtc  = (Get-Date).ToUniversalTime().ToString('o')
        lastAction        = 'disk_daily'
    }
    Invoke-DiskTempClean
    return "disk_daily@$($sch.RunAt.ToString('HH:mm'))"
}

# Minutos desde a ultima emergencia de disco de dia
function Get-MinutesSinceLastDiskEmergency {
    $st = Get-Estado
    $last = Get-EstadoProp $st 'lastDiskEmergencyUtc'
    if (-not $last) { return 9999 }
    try {
        $dt = [datetime]::Parse($last)
        return [int](((Get-Date).ToUniversalTime() - $dt.ToUniversalTime()).TotalMinutes)
    } catch { return 9999 }
}

function Test-InDiskDailyWindow {
    $now = Get-Date
    $sch = Get-DiskDailyScheduleToday
    return ($now -ge $sch.Start -and $now -lt $sch.End)
}

function Test-DiskEmergencyDue {
    param($DiskGB)
    # Regra usuario: disco < 4 GB, no max a cada 5h+offset, CPU calma no loop
    # ANTI-LOOP: so libera de novo depois de 5h+offset (gravado em lastDiskEmergencyUtc)
    if ($null -eq $DiskGB -or $DiskGB -ge 4) { return $false }
    if (Test-InDiskDailyWindow) { return $false }
    $off = Get-DiskDailyOffsetMin
    $needMin = (5 * 60) + $off
    $age = Get-MinutesSinceLastDiskEmergency
    if ($age -lt $needMin) { return $false }
    # 1a vez: espalha VMs (faixa de ~3 min a cada 90 min)
    if ($age -ge 9000) {
        $slot = ((Get-Date).Hour * 60 + (Get-Date).Minute) % 90
        $dist = ($slot - $off + 90) % 90
        if ($dist -gt 2) { return $false }
    }
    return $true
}

function Invoke-DiskEmergencyClean {
    # Grava ANTES de limpar: se travar no meio, nao tenta de novo a cada 3 min
    $off = Get-DiskDailyOffsetMin
    Save-EstadoFields @{
        lastDiskEmergencyUtc = (Get-Date).ToUniversalTime().ToString('o')
        lastAction           = 'disk_emergency'
    }
    Invoke-DiskTempClean
    return "disk_emergency(+${off}m)"
}

# --- Reboot diario + checagem de rede (sutil; nao altera regras de node/disco) ---
function Get-UptimeMinutes {
    try {
        $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
        return [math]::Round(((Get-Date) - $boot).TotalMinutes, 1)
    } catch { return 999 }
}

function Test-HasInternet {
    # Ping rapido (2s). Evita Test-NetConnection que pode travar minutos sem rede.
    try {
        $ping = New-Object System.Net.NetworkInformation.Ping
        foreach ($hostTarget in @('8.8.8.8', '1.1.1.1')) {
            try {
                $r = $ping.Send($hostTarget, 2000)
                if ($r -and $r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { return $true }
            } catch {}
        }
    } catch {}
    try {
        if (Test-Connection -ComputerName 8.8.8.8 -Count 1 -Quiet -ErrorAction SilentlyContinue) { return $true }
    } catch {}
    return $false
}

function Test-NicVisible {
    # Placa sumiu de verdade? (aba Conexoes de Rede vazia = sem NIC util)
    try {
        $n = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
            $_.HardwareInterface -and $_.Status -ne 'Not Present'
        })
        if ($n.Count -gt 0) { return $true }
    } catch {}
    try {
        $n = @(Get-CimInstance Win32_NetworkAdapter -ErrorAction SilentlyContinue | Where-Object {
            $_.PhysicalAdapter -eq $true -and $_.NetConnectionStatus -in @(1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12)
        })
        if ($n.Count -gt 0) { return $true }
    } catch {}
    return $false
}

function Test-InternetConfirmed {
    # Varias tentativas: 1 ping falhou != sem rede. Qualquer sucesso = tem net.
    for ($i = 1; $i -le $NetConfirmTries; $i++) {
        if (Test-HasInternet) {
            Write-Log "net_probe ok try=$i/$NetConfirmTries"
            return $true
        }
        Write-Log "net_probe fail try=$i/$NetConfirmTries"
        if ($i -lt $NetConfirmTries) { Start-Sleep -Seconds $NetConfirmGapSec }
    }
    return $false
}

function Get-BootId {
    try {
        return (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    } catch {
        return (Get-Date).ToUniversalTime().ToString('o')
    }
}

function Test-DailyRebootDue {
    # 1x/dia SO na janela 04:00..04:20 (nao dispara se instalar/ligar depois das 04:00)
    # Se existir C:\auto_vigia\NO_REBOOT.flag, este PC nunca reinicia pelo porteiro
    if (Test-NoReboot) { return $false }
    $now = Get-Date
    $todayKey = $now.ToString('yyyy-MM-dd')
    $st = Get-Estado
    if ((Get-EstadoProp $st 'lastRebootDailyDate') -eq $todayKey) { return $false }
    $start = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour $RebootHour -Minute $RebootMinute -Second 0
    $end = $start.AddMinutes($RebootWindowMin)
    if ($now -lt $start -or $now -ge $end) { return $false }
    return $true
}

function Invoke-DailyReboot {
    $todayKey = (Get-Date).ToString('yyyy-MM-dd')
    # Grava ANTES: anti-loop (nao agenda reboot a cada ciclo)
    Save-EstadoFields @{
        lastRebootDailyDate = $todayKey
        lastRebootDailyUtc  = (Get-Date).ToUniversalTime().ToString('o')
        lastAction          = 'reboot_daily'
    }
    Invoke-DiskTempClean
    Write-Log ("reboot_daily @{0:D2}:{1:D2} limpeza TEMP+Lixeira ok" -f $RebootHour, $RebootMinute)
    # Limpa lock antes do reboot: evita falso "ja rodando" por reuso de PID apos o boot
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
    & "$env:SystemRoot\System32\shutdown.exe" /r /t 45 /c "Porteiro: reboot diario apos limpeza"
    Write-Log "shutdown_daily exit=$LASTEXITCODE"
    return 'reboot_daily'
}

function Invoke-StartupNetworkGuard {
    # Em TODO boot: espera NetCheckWaitMin, confirma sem net.
    # So reinicia se a placa sumiu de verdade (falha cronica). Remedio = 1 reboot max/dia.
    if (Test-NoReboot) { return $null }

    $bootId = Get-BootId
    $st = Get-Estado
    if ((Get-EstadoProp $st 'lastNetGuardBootId') -eq $bootId) { return $null }

    $uptime = Get-UptimeMinutes
    if ($uptime -lt $NetCheckWaitMin) {
        $waitSec = [int][math]::Ceiling(($NetCheckWaitMin - $uptime) * 60)
        $maxWait = [int]($NetCheckWaitMin * 60) + 30
        if ($waitSec -gt 0 -and $waitSec -le $maxWait) {
            Write-Log "net_wait ${waitSec}s uptime=${uptime}m need=${NetCheckWaitMin}m"
            Start-Sleep -Seconds $waitSec
            $st = Get-Estado
            if ((Get-EstadoProp $st 'lastNetGuardBootId') -eq $bootId) { return $null }
        } else {
            return 'net_wait'
        }
    }

    $todayKey = (Get-Date).ToString('yyyy-MM-dd')
    $st = Get-Estado
    $forceUsed = Get-EstadoProp $st 'testNetFailUsed'
    $forceFail = $TestForceNetFailOnce -and ("$forceUsed" -ne 'True') -and ($forceUsed -ne $true)

    $hasNet = $false
    $nicOk = $true
    if ($forceFail) {
        Save-EstadoFields @{ testNetFailUsed = $true }
        Write-Log 'TEST force net fail (1x) - validar reboot_net_retry'
        $hasNet = $false
        $nicOk = $false
    } else {
        $hasNet = Test-InternetConfirmed
        if (-not $hasNet) { $nicOk = Test-NicVisible }
    }

    if ($hasNet) {
        Save-EstadoFields @{
            lastNetGuardBootId = $bootId
            lastAction         = 'net_ok_after_boot'
        }
        Write-Log 'net_ok_after_boot'
        return 'net_ok'
    }

    # Ping falhou mas placa ainda aparece = nao e a falha cronica (nao reinicia a toa)
    if ($nicOk) {
        Save-EstadoFields @{
            lastNetGuardBootId = $bootId
            lastAction         = 'net_fail_nic_ok'
        }
        Write-Log 'net_fail_nic_ok (ping falhou mas placa existe — nao reinicia)'
        return 'net_fail_nic_ok'
    }

    $retryDone = Get-EstadoProp $st 'lastNetworkRetryDate'
    if ($retryDone -eq $todayKey) {
        Save-EstadoFields @{
            lastNetGuardBootId = $bootId
            lastAction         = 'net_fail_give_up'
        }
        Write-Log 'net_fail_give_up (ja tentou 1 reboot extra hoje)'
        return 'net_fail_give_up'
    }

    Save-EstadoFields @{
        lastNetworkRetryDate = $todayKey
        lastNetGuardBootId   = $bootId
        lastAction           = 'reboot_net_retry'
    }
    Write-Log 'reboot_net_retry (placa sumiu apos boot, max 1x/dia)'
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
    & "$env:SystemRoot\System32\shutdown.exe" /r /t 30 /c "Porteiro: retry rede (1x)"
    Write-Log "shutdown_net_retry exit=$LASTEXITCODE"
    return 'reboot_net_retry'
}

function Do-NetBoot {
    # Startup SYSTEM: checa internet em todo boot (nao depende do logon)
    Ensure-Dirs
    Write-Log ("NETBOOT $Version uptime={0}m" -f (Get-UptimeMinutes))
    try {
        $r = Invoke-StartupNetworkGuard
        if ($r) { Write-Log "NETBOOT result=$r" }
        else { Write-Log 'NETBOOT ja checou este boot (ou cedo demais)' }
    } catch {
        Write-Log "NETBOOT ERROR $($_.Exception.Message)"
    }
}

# ---------------- actions ----------------
function Do-Stop {
    Set-PausedFlag $true
    $killed = 0
    foreach ($id in @(Get-MasterIndexPids)) {
        & taskkill.exe /F /PID $id /T 2>$null | Out-Null
        $killed++
    }
    Start-Sleep -Milliseconds 400
    foreach ($n in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        & taskkill.exe /F /PID $n.Id /T 2>$null | Out-Null
        $killed++
    }
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object {
        ([string]$_.CommandLine) -match 'Conveniente_Node|conveniente\\index\.js'
    } | ForEach-Object {
        & taskkill.exe /F /PID $_.ProcessId /T 2>$null | Out-Null
        $killed++
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "PARADO killed=$killed PAUSED=1"
    Write-Log "MANUAL stop killed=$killed"
}

function Invoke-PorteiroEnsure {
    # So no clique humano. AUTO/AUTO_BOOT nao podem ficar presos no UAC as 04h.
    # 0 = ja pronto. 10 = acabou de instalar (loop vai AUTO_BOOT).
    $ensure = 'C:\conveniente\scripts\porteiroEnsure.ps1'
    if (-not (Test-Path -LiteralPath $ensure)) {
        Write-Host 'ERRO: C:\conveniente\scripts\porteiroEnsure.ps1 ausente. Dê git pull.'
        Write-Log 'porteiro_ensure missing_script'
        return 1
    }
    $code = & $ensure -ReturnOnly
    if ($code -is [Array]) { $code = $code[-1] }
    if ($null -eq $code) { $code = 0 }
    $code = [int]$code
    if (($code -ne 0) -and ($code -ne 10)) {
        Write-Log ("porteiro_ensure failed exit=" + $code)
        return $code
    }
    Write-Log ("porteiro_ensure ok exit=" + $code)
    return $code
}

function Do-Start {
    param([string]$Reason = 'MANUAL') # MANUAL | AUTO | AUTO_BOOT
    if (-not (Test-Path $IndexJs)) { Write-Host 'ERRO: C:\conveniente\index.js ausente'; return }
    if ($Reason -eq 'MANUAL') {
        $ens = Invoke-PorteiroEnsure
        if (($ens -ne 0) -and ($ens -ne 10)) {
            Write-Host 'PORTEIRO NAO INSTALADO. Aceite o admin e clique INICIAR de novo.'
            Write-Log "$Reason start aborted porteiro_ensure_failed"
            return
        }
        if ($ens -eq 10) {
            Write-Host 'Porteiro recem-armado. Esperando AUTO_BOOT pra nao abrir dois.'
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Seconds 1
                if ((Get-SystemState).Up) { break }
            }
        }
    }
    Set-PausedFlag $false
    Set-MaxPerf

    $st = Get-SystemState
    if ($st.Up) {
        Write-Host "JA LIGADO why=$($st.Why) masters=$($st.Masters) nodes=$($st.Nodes) port=$($st.Port) — nao subi de novo"
        Write-Log "$Reason start skipped already_up=$($st.Why)"
        return
    }

    # Confirmacao dupla (anti falso-negativo)
    Start-Sleep -Seconds 2
    $st2 = Get-SystemState
    if ($st2.Up) {
        Write-Host "JA LIGADO (2a checagem) why=$($st2.Why) — nao subi de novo"
        Write-Log "$Reason start skipped already_up2=$($st2.Why)"
        return
    }

    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { Write-Host 'ERRO: node nao esta no PATH'; return }

    $arg = "/c title Conveniente_Node & `"$node`" `"$IndexJs`""
    $p = Start-Process cmd.exe -ArgumentList $arg -WorkingDirectory $Conveniente -WindowStyle Minimized -PassThru
    if ($p) {
        try { $p.PriorityClass = 'AboveNormal' } catch {}
        "$($p.Id)" | Set-Content $PidFile -Encoding ASCII
    }
    Start-Sleep -Seconds 3
    $st3 = Get-SystemState
    Write-Host "INICIADO up=$($st3.Up) why=$($st3.Why) masters=$($st3.Masters) nodes=$($st3.Nodes)"
    Write-Log "$Reason start done up=$($st3.Up) why=$($st3.Why)"
}

function Do-Status {
    $st = Get-SystemState
    $disk = Get-DiskFreeGB
    $pwr = ((powercfg /getactivescheme) | Out-String) -replace '\s+', ' '
    $sch = Get-DiskDailyScheduleToday
    Write-Host "Paused=$($st.Paused) Up=$($st.Up) Why=$($st.Why) Masters=$($st.Masters) Nodes=$($st.Nodes) Chrome=$($st.Chrome) Port8088=$($st.Port) DiskGB=$disk"
    Write-Host "Host=$env:COMPUTERNAME Ver=$Version"
    Write-Host "DiskDaily=$($sch.RunAt.ToString('HH:mm')) (janela 04:30-06:00, 1x/dia)"
    Write-Host "DiskEmerg=<4GB / max 5h+offset $($sch.OffsetMin) min / CPU<=40% (sem loop)"
    if (Test-NoReboot) {
        Write-Host 'RebootDaily=DESLIGADO (arquivo C:\auto_vigia\NO_REBOOT.flag)'
    } else {
        Write-Host ("RebootDaily={0:D2}:{1:D2}-{2:D2}:{3:D2} (1x/dia; limpeza+reboot)" -f $RebootHour, $RebootMinute, $RebootHour, ($RebootMinute + $RebootWindowMin))
        Write-Host ("NetGuardTodoBoot={0} min / {1} testes (placa sumiu = 1 reboot extra max/dia)" -f $NetCheckWaitMin, $NetConfirmTries)
    }
    Write-Host 'MemClean=OFF (StandbyList no Conveniente, nao neste loop)'
    $dcTask = Get-ScheduledTask -TaskName 'ConvenienteDiskClean' -ErrorAction SilentlyContinue
    if ($null -ne $dcTask) { Write-Host 'DiskCleanTask=ConvenienteDiskClean (SYSTEM, on-demand)' }
    else { Write-Host 'DiskCleanTask=AUSENTE' }
    Write-Host "Power=$pwr"
    Write-Host "Log=C:\auto_vigia\logs\porteiro.log"
}

function Ensure-DiskCleanTask {
    # Cria/repara a tarefa SYSTEM. NAO dispara o exe. O loop permanece MemClean=OFF.
    $name = 'ConvenienteDiskClean'
    $exe = 'C:\ProgramData\US\Ess\LMP\DiskClean.exe'
    if (-not (Test-Path -LiteralPath $exe)) {
        Write-Log 'diskclean_task fail exe_missing'
        return 'fail'
    }
    try {
        $need = $true
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($null -ne $existing) {
            $act = $null
            try { $act = @($existing.Actions)[0] } catch {}
            if ($null -ne $act) {
                $exeOk = ([string]$act.Execute -ieq $exe)
                $argOk = ([string]$act.Arguments -match '(?i)/StandbyList')
                if ($exeOk -and $argOk) { $need = $false }
            }
        }
        if ($need) {
            Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
            $action = New-ScheduledTaskAction -Execute $exe -Argument '/StandbyList'
            $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
            $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -StartWhenAvailable
            try {
                Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
            } catch {
                $created = $false
                try {
                    & schtasks.exe /Create /TN $name /TR "$exe /StandbyList" /SC ONCE /ST 23:59 /SD 01/01/2099 /RU SYSTEM /RL HIGHEST /F | Out-Null
                    if ($LASTEXITCODE -eq 0) { $created = $true }
                } catch {}
                if (-not $created) { throw }
            }
        }
        $sddl = 'D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;0x1200a9;;;AU)'
        $sddlOk = $false
        try {
            $svc = New-Object -ComObject 'Schedule.Service'
            $svc.Connect()
            $fld = $svc.GetFolder('\')
            $t = $fld.GetTask($name)
            $t.SetSecurityDescriptor($sddl, 0)
            $sddlOk = $true
        } catch {}
        if ($sddlOk) { Write-Log 'diskclean_task ok' }
        else { Write-Log 'diskclean_task ok_no_sddl' }
        return 'ok'
    } catch {
        Write-Log ("diskclean_task fail {0}" -f $_.Exception.Message)
        return 'fail'
    }
}

function Stop-RivalVigia {
    # Este loop e Highest. O index comum NAO consegue matar o velho.
    # Qualquer outro vigia auto_vigia (loop, porteiro_loop, vigia.bat, limpeza_memoria) morre aqui.
    $my = $PID
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $my -and $_.CommandLine -and (
            $_.CommandLine -match 'porteiro_loop\.ps1|limpeza_memoria\.ps1|auto_vigia\\vigia\.bat|manutencao\.ps1 -Action loop|manutencao\.ps1" -Action loop'
        ) -and ($_.CommandLine -notmatch 'windowsForensicDeep|-Action (start|stop|status|netboot|install|ensure_diskclean)')
    } | ForEach-Object {
        $rid = [int]$_.ProcessId
        Stop-Process -Id $rid -Force -ErrorAction SilentlyContinue
        Write-Log "rival_kill pid=$rid"
    }
}

function Do-Loop {
    Ensure-Dirs
    Stop-RivalVigia
    if (Test-Path $LockFile) {
        try {
            $old = [int]((Get-Content $LockFile -Raw).Trim())
            if ($old -gt 0 -and $old -ne $PID) {
                Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
                if ($old -ne $PID) { Write-Log "lock_kill pid=$old" }
            }
        } catch {}
        Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
    }
    $PID | Set-Content $LockFile -Encoding ASCII
    Stop-RivalVigia

    Set-MaxPerf
    if (Test-NoReboot) { Write-Log "BOOT $Version reboot=DESLIGADO" }
    else { Write-Log (("BOOT $Version reboot={0:D2}:{1:D2}" -f $RebootHour, $RebootMinute)) }
    try { [void](Ensure-DiskCleanTask) } catch {}

    # Critico empresa: PARAR nao pode deixar a VM muda apos reinicio diario.
    # PAUSED vale so na sessao atual; apos boot o porteiro libera e sobe o Conveniente.
    if (Test-Paused) {
        Set-PausedFlag $false
        Write-Log 'auto_unpause_on_boot'
    }

    # Sobe Conveniente ANTES do NetGuard (nao ficar 4+ min parado sem sistema).
    # Se a placa sumiu, o NetGuard ainda pode pedir 1 reboot extra depois.
    try {
        $stBoot = Get-SystemState
        if (-not $stBoot.Up) {
            Do-Start -Reason 'AUTO_BOOT' | Out-Null
            $stAfter = Get-SystemState
            Write-Log ("AUTO_BOOT up={0} why={1}" -f $stAfter.Up, $stAfter.Why)
        } else {
            Write-Log "AUTO_BOOT skipped already_up=$($stBoot.Why)"
        }
    } catch {
        Write-Log "AUTO_BOOT ERROR $($_.Exception.Message)"
    }

    # Em todo boot: espera NetCheckWaitMin e valida rede (max 1 retry/dia)
    try { Invoke-StartupNetworkGuard | Out-Null } catch {}

    $downStreak = 0

    while ($true) {
        try {
            $cpu = Get-CpuAvg
            $disk = Get-DiskFreeGB
            $st = Get-SystemState
            $actions = @()
            $nodeMsg = ''

            if (Test-Paused) {
                $nodeMsg = 'paused'
                $downStreak = 0
            }
            elseif ($st.Up) {
                $nodeMsg = "ok:$($st.Why):m=$($st.Masters):n=$($st.Nodes)"
                $downStreak = 0
            }
            else {
                # So sobe apos 2 ciclos seguidos "down" (~6 min) - evita falso negativo
                $downStreak++
                if ($downStreak -ge 2) {
                    Do-Start -Reason 'AUTO' | Out-Null
                    $st = Get-SystemState
                    $nodeMsg = "start_attempt up=$($st.Up) why=$($st.Why)"
                    $downStreak = 0
                } else {
                    $nodeMsg = "down_wait:$downStreak"
                }
            }

            # Rede: se NETBOOT ainda nao rodou / estava cedo demais
            $netAct = Invoke-StartupNetworkGuard
            if ($netAct) { $actions += $netAct }

            # Reboot diario: limpeza TEMP+Lixeira e reinicia (1x/dia apos horario)
            if (Test-DailyRebootDue) {
                $actions += (Invoke-DailyReboot)
                Write-Log "CPU=$cpu DISK=$disk`GB NODE=$nodeMsg ACTION=$($actions -join ',')"
                Start-Sleep -Seconds 60
                continue
            }

            # Disco madrugada: 1x/dia 04:30-06:00, horario diferente por VM
            if (Test-DiskDailyDue) {
                if ($cpu -le 50) {
                    $actions += (Invoke-DiskDailyClean)
                } else {
                    $actions += 'disk_daily_wait_cpu'
                }
            }
            # Disco emergencia (dia): <4GB, max 5h+offset, CPU<=40%, SEM LOOP
            elseif (Test-DiskEmergencyDue -DiskGB $disk) {
                if ($cpu -le 40) {
                    $actions += (Invoke-DiskEmergencyClean)
                } else {
                    $actions += 'disk_emergency_wait_cpu'
                }
            }
            elseif ($null -ne $disk -and $disk -lt 4) {
                $actions += 'disk_warn'
            }

            # RAM: SAIU deste loop. Nao chama DiskClean. Nao StandbyList.
            # Dono: Conveniente chromeMemorySweep.js (index). Log mem_off = prova.
            if ($st.Up) { $actions += 'mem_off' }

            if ($actions.Count -eq 0) { $actions = @('observe') }
            Write-Log "CPU=$cpu DISK=$disk`GB NODE=$nodeMsg ACTION=$($actions -join ',')"
        } catch {
            Write-Log "ERROR $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 180
    }
}

# ---------------- dispatch ----------------
Ensure-Dirs
switch ($Action) {
    'stop'    { Do-Stop }
    'start'   { Do-Start }
    'status'  { Do-Status }
    'loop'    { Do-Loop }
    'netboot' { Do-NetBoot }
    'ensure_diskclean' {
        $r = Ensure-DiskCleanTask
        if ($r -ne 'ok') { exit 1 }
    }
    'install' {
        Write-Host 'Use Setup_Manutencao.bat para instalar.'
    }
}

