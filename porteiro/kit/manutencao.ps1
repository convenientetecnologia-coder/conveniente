# C:\auto_vigia\manutencao.ps1  (fonte: kit\manutencao.ps1)
# TUDO-EM-UM: porteiro + start/stop/status
# Nao altera C:\conveniente
# Regra: 8088 em LISTEN = index no ar. Nao sobe outro por cima.
# Host sem 8088 por 3 min = zumbi: ai sim mata e sobe um.
# Excecao: pulso index_heartbeat.json parado, duas leituras, pid confirmado,
# folga de boot, no maximo 3 reinicios em 6h. Ai mata a janela e sobe um.
# RAM (StandbyList) NAO vive neste loop (v5.2.1-clean-cpu).
# Este script so GARANTE a tarefa SYSTEM ConvenienteDiskClean (on-demand).
# Quem cronometra 15 min e pede o Run e o Conveniente (chromeMemorySweep.js).
# CPU: o Conveniente opera em 90-100%. Este script NAO mede carga de hardware.

param(
    [ValidateSet('loop','start','stop','status','install','netboot','ensure_diskclean','arm','pulse')]
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
$BeatFile    = Join-Path $Root 'porteiro.beat'
$IndexStartLock = Join-Path $Root 'index_start.lock'
$LogFile     = Join-Path $Root 'logs\porteiro.log'
$KitSrc      = Join-Path $Conveniente 'porteiro\kit\manutencao.ps1'
$PidFile     = Join-Path $Root 'master.pid'
$PanelPort   = 8088
$Version     = 'v5.2.1-clean-cpu'
$IndexStartGraceSec = 180
# Travamento do index: a porta continua em LISTEN, o event loop nao.
# 150s e maior que o POST lento (15-60s). Duas leituras do loop (30s).
# Boot < 4 min nao conta. 15 min entre reinicios. 3 em 6h, depois so loga.
$IndexStallAgeSec = 150
$IndexStallBootGraceSec = 240
$IndexStallCooldownSec = 900
$IndexStallMaxKills = 3
$IndexStallWindowSec = 21600
$IndexStallBootSkewMs = 120000
$IndexStallAbsurdAgeSec = 43200
$NodeRuntimePs1 = Join-Path $Conveniente 'scripts\nodeRuntime.ps1'

try {
    if (Test-Path -LiteralPath $NodeRuntimePs1) {
        . $NodeRuntimePs1
    }
} catch {}

# Reboot diario (1x/dia): limpeza TEMP+Lixeira e reinicia. Producao = 04:00.
# So dispara DENTRO da janela (ex.: 04:00-04:20). Nunca "atrasado" ao instalar de tarde.
$RebootHour      = 4
$RebootMinute    = 0
$RebootWindowMin = 20
# Watchdog de WAN o dia inteiro (nao 1x por boot). Placa visivel nao livra.
# Sem internet = reboot. Queda curta (rotacao de IP 1-5 min) NAO reboota:
# so dispara depois de NetDownConfirmMin seguidos sem WAN. Ate 3 extra/dia.
$NetCheckWaitMin   = 4
$NetDownConfirmMin = 8
$NetConfirmTries   = 4
$NetConfirmGapSec  = 15
$NetRetryMax       = 3
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

function Resolve-ConvenienteNodeExe {
    if (-not (Get-Command Ensure-ConvenienteNodeRuntime -ErrorAction SilentlyContinue)) {
        Write-Log 'node_runtime_helper_missing'
        return $null
    }
    try {
        $rt = Ensure-ConvenienteNodeRuntime
        if ($rt -and $rt.Ok -and $rt.NodeExe) {
            Write-Log ("node_runtime_ok wanted=" + [string]$rt.WantedTag + " source=" + [string]$rt.Source)
            return [string]$rt.NodeExe
        }
        Write-Log ("node_runtime_fail error=" + [string]$rt.Error)
    } catch {
        Write-Log ("node_runtime_exception error=" + $_.Exception.Message)
    }
    return $null
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

function Get-ListenPid([int]$Port) {
    $portTok = ':' + [string]$Port + ' '
    try {
        foreach ($line in @(& netstat.exe -ano -p TCP 2>$null)) {
            $t = [string]$line
            if ($t -notmatch 'LISTENING|OUVINDO|ESCUTA') { continue }
            if ($t.IndexOf($portTok) -lt 0) { continue }
            if ($t -match '\s(\d+)\s*$') { return [int]$Matches[1] }
        }
    } catch {}
    return 0
}

function Test-Port8088 {
    # Index vivo = so LISTEN na 8088. Sem WMI. Celula nao conta.
    return ((Get-ListenPid $PanelPort) -gt 0)
}

function Get-NodeCount { @(Get-Process -Name node -ErrorAction SilentlyContinue).Count }
function Get-ChromeCount {
    # Roda DENTRO da VM: conta processos chrome.exe locais (mesmo metodo do STATUS)
    @(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count
}

function Get-SystemState {
    param([switch]$Lite)
    # PRETO NO BRANCO: index ligado = 8088 em LISTEN. Ponto.
    # Celula viva, chrome aberto, node.exe sobrando - nao sao o index.
    # Lite: sem contar chrome (loop a cada 30s; 90+ chrome trava a VM).
    $port = Test-Port8088
    $nodes = Get-NodeCount
    if ((Test-Path $PidFile) -and -not $port) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    $up = [bool]$port
    $why = if ($port) { 'index_8088' } else { 'index_down' }
    $chrome = 0
    if (-not $Lite) { $chrome = Get-ChromeCount }
    return [pscustomobject]@{
        Up = $up; Why = $why
        Masters = $(if ($port) { 1 } else { 0 }); Nodes = $nodes
        Port = $port; Chrome = $chrome
        Paused = (Test-Paused)
    }
}

function Get-DiskFreeGB {
    try {
        $d = New-Object -TypeName System.IO.DriveInfo -ArgumentList 'C'
        if (-not $d -or -not $d.IsReady) { return $null }
        return [math]::Round($d.AvailableFreeSpace / 1GB, 2)
    } catch { return $null }
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
    # Regra usuario: disco < 4 GB, no max a cada 5h+offset. Sem gate de CPU.
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
        $ms = [int64][Environment]::TickCount
        if ($ms -lt 0) { $ms = $ms + 4294967296 }
        return [math]::Round($ms / 60000.0, 1)
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
    try {
        $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
        foreach ($n in @($nics)) {
            if ($n.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
            if ($n.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up) { return $true }
        }
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
        $sys = Get-Process -Id 4 -ErrorAction Stop
        return $sys.StartTime.ToUniversalTime().ToString('o')
    } catch {
        return ('tick:' + [string][Environment]::TickCount)
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

function Get-NetRetryCountToday {
    $todayKey = (Get-Date).ToString('yyyy-MM-dd')
    $st = Get-Estado
    $date = [string](Get-EstadoProp $st 'lastNetworkRetryDate')
    if ($date -ne $todayKey) { return 0 }
    $raw = Get-EstadoProp $st 'lastNetworkRetryCount'
    if ($null -eq $raw -or "$raw" -eq '') { return 1 }
    try { return [math]::Max(0, [int]$raw) } catch { return 1 }
}

function Get-NetworkDownElapsedMin {
    $st = Get-Estado
    $raw = Get-EstadoProp $st 'lastNetworkDownSinceUtc'
    if ($null -eq $raw -or "$raw" -eq '') { return $null }
    try {
        $dt = [datetime]::Parse([string]$raw)
        $mins = [double](((Get-Date).ToUniversalTime() - $dt.ToUniversalTime()).TotalMinutes)
        if ($mins -lt 0) { return 0 }
        return [math]::Round($mins, 1)
    } catch { return 0 }
}

function Open-NetGuardLock {
    $path = Join-Path $Root 'netguard.lock'
    try {
        return [System.IO.File]::Open(
            $path,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        return $null
    }
}

function Invoke-StartupNetworkGuard {
    # Watchdog diurno. NAO usa lastNetGuardBootId como skip (Get-BootId no Win10
    # cai em tick:TickCount e nunca trava — 4 falhas x 15s virava reboot as 14h).
    # Sem internet = reboot so depois de NetDownConfirmMin seguidos sem WAN.
    # Rotacao de IP (1-5 min) reseta o relogio quando a WAN volta. Placa nao livra.
    # Max NetRetryMax extras/dia. Lock: NetBoot + loop nao decidem juntos.
    if (Test-NoReboot) { return $null }

    $lock = Open-NetGuardLock
    if (-not $lock) {
        Write-Log 'net_guard_busy (outro processo ja checa este boot)'
        return 'net_busy'
    }
    try {
        $uptime = Get-UptimeMinutes
        if ($uptime -lt $NetCheckWaitMin) {
            Write-Log "net_wait later uptime=${uptime}m need=${NetCheckWaitMin}m"
            return 'net_wait'
        }

        $todayKey = (Get-Date).ToString('yyyy-MM-dd')
        $st = Get-Estado
        $forceUsed = Get-EstadoProp $st 'testNetFailUsed'
        $forceFail = $TestForceNetFailOnce -and ("$forceUsed" -ne 'True') -and ($forceUsed -ne $true)

        $hasNet = $false
        $nicOk = $true
        if ($forceFail) {
            $ago = (Get-Date).ToUniversalTime().AddMinutes(-($NetDownConfirmMin + 1)).ToString('o')
            Save-EstadoFields @{
                testNetFailUsed         = $true
                lastNetworkDownSinceUtc = $ago
            }
            Write-Log 'TEST force net fail (1x) - validar reboot_net_retry'
            $hasNet = $false
            $nicOk = $false
        } else {
            $hasNet = Test-HasInternet
            $nicOk = Test-NicVisible
        }

        $nicTxt = if ($nicOk) { 'nic_ok' } else { 'nic_missing' }
        $used = Get-NetRetryCountToday
        $bootId = Get-BootId

        if ($hasNet) {
            $stOk = Get-Estado
            $wasDown = Get-EstadoProp $stOk 'lastNetworkDownSinceUtc'
            $hadOk = Get-EstadoProp $stOk 'lastNetworkOkUtc'
            $elapsedOk = Get-NetworkDownElapsedMin
            Save-EstadoFields @{
                lastNetworkDownSinceUtc = ''
                lastAction              = 'net_ok'
                lastNetworkOkUtc        = (Get-Date).ToUniversalTime().ToString('o')
            }
            if ($null -ne $wasDown -and "$wasDown" -ne '') {
                Write-Log ("net_ok recovered after {0}m $nicTxt retryUsed=$used/$NetRetryMax" -f $elapsedOk)
                return 'net_ok'
            }
            if ($null -eq $hadOk -or "$hadOk" -eq '') {
                Write-Log "net_ok_after_boot $nicTxt retryUsed=$used/$NetRetryMax"
                return 'net_ok'
            }
            return $null
        }

        if ($used -ge $NetRetryMax) {
            $stGu = Get-Estado
            $already = [string](Get-EstadoProp $stGu 'lastAction')
            if ($already -eq 'net_fail_give_up') { return $null }
            Save-EstadoFields @{
                lastNetGuardBootId = $bootId
                lastAction         = 'net_fail_give_up'
            }
            Write-Log "net_fail_give_up (sem internet, ja tentou $used reboot extra hoje, max=$NetRetryMax) $nicTxt"
            return 'net_fail_give_up'
        }

        $elapsed = Get-NetworkDownElapsedMin
        if ($null -eq $elapsed) {
            Save-EstadoFields @{
                lastNetworkDownSinceUtc = (Get-Date).ToUniversalTime().ToString('o')
                lastAction              = 'net_fail_wait'
            }
            Write-Log "net_fail_wait start $nicTxt need=${NetDownConfirmMin}m (rotacao curta nao reboota)"
            return 'net_fail_wait'
        }

        if ($elapsed -lt $NetDownConfirmMin) {
            Write-Log "net_fail_wait elapsed=${elapsed}m need=${NetDownConfirmMin}m $nicTxt"
            return 'net_fail_wait'
        }

        if (-not $forceFail) {
            if (Test-InternetConfirmed) {
                Save-EstadoFields @{
                    lastNetworkDownSinceUtc = ''
                    lastAction              = 'net_ok'
                    lastNetworkOkUtc        = (Get-Date).ToUniversalTime().ToString('o')
                }
                Write-Log "net_ok recovered at_confirm after ${elapsed}m $nicTxt"
                return 'net_ok'
            }
        }

        $next = $used + 1
        Save-EstadoFields @{
            lastNetworkRetryDate    = $todayKey
            lastNetworkRetryCount   = $next
            lastNetGuardBootId      = $bootId
            lastAction              = 'reboot_net_retry'
            lastNetworkDownSinceUtc = ''
        }
        Write-Log "reboot_net_retry (sem internet $nicTxt down=${elapsed}m/${NetDownConfirmMin}m, reboot $next/$NetRetryMax)"
        Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
        & "$env:SystemRoot\System32\shutdown.exe" /r /t 30 /c "Porteiro: sem internet (retry $next/$NetRetryMax)"
        Write-Log "shutdown_net_retry exit=$LASTEXITCODE n=$next"
        return 'reboot_net_retry'
    } finally {
        try { if ($lock) { $lock.Close(); $lock.Dispose() } } catch {}
    }
}

function Test-IsAdmin {
    try {
        $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
        return [bool]$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Ensure-WerSvc {
    # Dump do FastFail some se o WerSvc estiver parado. Manual, mas LIGADO. Nunca Disabled. Nunca Stop.
    # Sem SYSTEM/admin so tira foto. Nao grita fail. Nao tenta Set-Service.
    $s = $null
    try { $s = Get-Service -Name WerSvc -ErrorAction Stop } catch {}
    if ($null -eq $s) {
        Write-Log 'wersvc ausente'
        return 'fail'
    }
    if (-not (Test-IsAdmin)) {
        Write-Log ("wersvc foto {0}/{1} sem_admin" -f $s.Status, $s.StartType)
        if ($s.Status -eq 'Running') { return 'ok' }
        return 'skip'
    }
    try {
        Set-Service -Name WerSvc -StartupType Manual -ErrorAction Stop
        if ((Get-Service -Name WerSvc).Status -ne 'Running') { Start-Service -Name WerSvc -ErrorAction Stop }
        $s2 = Get-Service -Name WerSvc -ErrorAction Stop
        Write-Log ("wersvc {0}/{1}" -f $s2.Status, $s2.StartType)
        return 'ok'
    } catch {
        $s3 = $null
        try { $s3 = Get-Service -Name WerSvc -ErrorAction SilentlyContinue } catch {}
        Write-Log ("wersvc fail {0} foto {1}/{2}" -f $_.Exception.Message, $(if ($s3) { $s3.Status } else { '?' }), $(if ($s3) { $s3.StartType } else { '?' }))
        return 'fail'
    }
}

function Ensure-NodeCrashDumps {
    # Mini-dump do node.exe. Precisa SYSTEM/admin (NetBoot). Sem isso o FastFail some sem corpo.
    $folder = 'C:\conveniente\dados\crash_dumps'
    try { New-Item -ItemType Directory -Path $folder -Force | Out-Null } catch {}
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe'
    try {
        if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
        New-ItemProperty -Path $key -Name DumpFolder -Value $folder -PropertyType ExpandString -Force | Out-Null
        New-ItemProperty -Path $key -Name DumpType -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name DumpCount -Value 8 -PropertyType DWord -Force | Out-Null
        Write-Log 'crash_dumps armed'
        return 'ok'
    } catch {
        Write-Log ("crash_dumps unarmed {0}" -f $_.Exception.Message)
        return 'fail'
    }
}

function Invoke-CrashHammer {
    param([string]$Reason = 'porteiro_down')
    $ps1 = 'C:\conveniente\scripts\crashHammer.ps1'
    if (-not (Test-Path -LiteralPath $ps1)) { return }
    try {
        $psExe = Get-ConvenientePsHost
        Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
            '-File', $ps1, '-Reason', $Reason, '-Minutes', '20'
        ) | Out-Null
        Write-Log ("crash_hammer {0}" -f $Reason)
    } catch {
        Write-Log ("crash_hammer fail {0}" -f $_.Exception.Message)
    }
}

function Do-NetBoot {
    # Startup SYSTEM: checa internet em todo boot (nao depende do logon)
    Ensure-Dirs
    try { [void](Ensure-NodeCrashDumps) } catch {}
    try { [void](Ensure-WerSvc) } catch {}
    $pagefileNow = $false
    $flagPf = Join-Path $Root 'PAGEFILE_NOW.flag'
    $flagPf2 = Join-Path $Conveniente 'dados\logs\PAGEFILE_NOW.flag'
    if (Test-Path -LiteralPath $flagPf) {
        $pagefileNow = $true
        try { Remove-Item -LiteralPath $flagPf -Force -ErrorAction SilentlyContinue } catch {}
    }
    if (Test-Path -LiteralPath $flagPf2) {
        $pagefileNow = $true
        try { Remove-Item -LiteralPath $flagPf2 -Force -ErrorAction SilentlyContinue } catch {}
    }
    $pagefilePs1 = Join-Path $Conveniente 'scripts\winPagefileCommit.ps1'
    if (Test-Path -LiteralPath $pagefilePs1) {
        try {
            $psExePf = Get-ConvenientePsHost
            & $psExePf -NoProfile -ExecutionPolicy Bypass -File $pagefilePs1 -Apply -Quiet
            $pfCode = 0
            try { $pfCode = [int]$LASTEXITCODE } catch { $pfCode = 0 }
            Write-Log ("NETBOOT pagefile_exit=$pfCode now=$pagefileNow")
        } catch {
            Write-Log ("NETBOOT pagefile_exception $($_.Exception.Message)")
        }
    }
    if ($pagefileNow) {
        Write-Log 'NETBOOT pagefile_only skip_net_guard'
        return
    }
    Write-Log ("NETBOOT $Version uptime={0}m" -f (Get-UptimeMinutes))
    try {
        $r = Invoke-StartupNetworkGuard
        if ($r) { Write-Log "NETBOOT result=$r" }
        else { Write-Log 'NETBOOT sem acao (net ok ou cedo demais)' }
    } catch {
        Write-Log "NETBOOT ERROR $($_.Exception.Message)"
    }
}

# ---------------- console host (powershell nativo; cmd.exe so no leftover do PARAR) ----------------
function Get-ConvenientePsHost {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $psExe) { return $psExe }
    return 'powershell.exe'
}

function Test-IsConvenienteNodeHost([string]$CommandLine) {
    $c = [string]$CommandLine
    if ([string]::IsNullOrWhiteSpace($c)) { return $false }
    if ($c -match 'manutencao\.ps1|iniciarSistema\.ps1|porteiroEnsure\.ps1|winTuningMaster\.ps1|winPagefileCommit\.ps1|windowsForensicDeep|crashHammer\.ps1|-Action loop') { return $false }
    return ($c -match 'Conveniente_Node' -or $c -match 'conveniente\\index\.js')
}

function Count-ConvenienteNodeHosts {
    $n = 0
    foreach ($name in @('powershell', 'pwsh')) {
        foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $title = ''
            try { $title = [string]$p.MainWindowTitle } catch { $title = '' }
            if ($title -eq 'Conveniente_Node') { $n++ }
        }
    }
    return $n
}

function Test-IndexStartInflight {
    if (-not (Test-Path -LiteralPath $IndexStartLock)) { return $false }
    try {
        $age = [int][math]::Round(((Get-Date) - (Get-Item -LiteralPath $IndexStartLock).LastWriteTime).TotalSeconds)
        return ($age -ge 0 -and $age -le $IndexStartGraceSec)
    } catch {
        return $false
    }
}

function Write-IndexStartLock {
    try {
        [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() | Set-Content -LiteralPath $IndexStartLock -Encoding ASCII
    } catch {}
}

function Clear-IndexStartLock {
    Remove-Item -LiteralPath $IndexStartLock -Force -ErrorAction SilentlyContinue
}

function Stop-ConvenienteConsoleHosts {
    $killed = 0
    foreach ($name in @('powershell', 'pwsh', 'cmd')) {
        foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $title = ''
            try { $title = [string]$p.MainWindowTitle } catch { $title = '' }
            if ($title -ne 'Conveniente_Node') { continue }
            & taskkill.exe /F /PID $p.Id /T 2>$null | Out-Null
            $killed++
        }
    }
    return $killed
}

function Start-ConvenienteNodeHost {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$IndexPath,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $psExe = Get-ConvenientePsHost
    $hostPs1 = 'C:\conveniente\scripts\convenienteNodeHost.ps1'
    return Start-Process -FilePath $psExe -ArgumentList @(
        '-NoExit',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $hostPs1,
        '-NodeExe', $NodeExe,
        '-IndexPath', $IndexPath,
        '-WorkDir', $WorkDir,
        '-BootSource', 'porteiro'
    ) -WorkingDirectory $WorkDir -WindowStyle Normal -PassThru
}

# ---------------- actions ----------------
function Do-Stop {
    Set-PausedFlag $true
    $killed = 0
    $killed += [int](Stop-ConvenienteConsoleHosts)
    Start-Sleep -Milliseconds 400
    $listenPid = Get-ListenPid $PanelPort
    if ($listenPid -gt 0) {
        & taskkill.exe /F /PID $listenPid /T 2>$null | Out-Null
        $killed++
    }
    foreach ($n in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        & taskkill.exe /F /PID $n.Id /T 2>$null | Out-Null
        $killed++
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "PARADO killed=$killed PAUSED=1"
    Write-Log "MANUAL stop killed=$killed"
}

function Invoke-WinTuningSilent {
    $tune = Join-Path $Conveniente 'scripts\winTuningMaster.ps1'
    if (-not (Test-Path -LiteralPath $tune)) { return }
    try {
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $tune, '-Boot'
        ) | Out-Null
    } catch {}
}

function Do-Start {
    param([string]$Reason = 'MANUAL') # MANUAL | AUTO | AUTO_BOOT
    if (-not (Test-Path $IndexJs)) { Write-Host 'ERRO: C:\conveniente\index.js ausente'; return }
    Set-PausedFlag $false
    Set-MaxPerf

    $st = $null
    $st2 = $null
    $st3 = $null
    $st = Get-SystemState -Lite
    if ($st -and $st.Up) {
        Clear-IndexStartLock
        Write-Host "JA LIGADO why=$($st.Why) port8088=$($st.Port) - nao subi de novo (celula nao conta)"
        Write-Log "$Reason start skipped already_up=$($st.Why) index_only"
        return
    }

    $hosts = [int](Count-ConvenienteNodeHosts)
    if ($hosts -gt 0) {
        Write-Host "JA TEM JANELA Conveniente_Node n=$hosts - nao mato, nao subi de novo"
        Write-Log "$Reason start skipped host_alive n=$hosts"
        return
    }
    if (Test-IndexStartInflight) {
        Write-Log "$Reason start skipped start_inflight"
        return
    }

    Start-Sleep -Milliseconds 300
    $st2 = Get-SystemState -Lite
    if ($st2 -and $st2.Up) {
        Clear-IndexStartLock
        Write-Host "JA LIGADO (2a checagem) why=$($st2.Why) - nao subi de novo (celula nao conta)"
        Write-Log "$Reason start skipped already_up2=$($st2.Why) index_only"
        return
    }
    if ((Count-ConvenienteNodeHosts) -gt 0) {
        Write-Log "$Reason start skipped host_alive2"
        return
    }

    $pagefilePs1 = Join-Path $Conveniente 'scripts\winPagefileCommit.ps1'
    if (Test-Path -LiteralPath $pagefilePs1) {
        try {
            $psExePf = Get-ConvenientePsHost
            & $psExePf -NoProfile -ExecutionPolicy Bypass -File $pagefilePs1 -Apply -Quiet
            $pfCode = 0
            try { $pfCode = [int]$LASTEXITCODE } catch { $pfCode = 0 }
            Write-Log "$Reason pagefile_exit=$pfCode"
            if ($pfCode -eq 2) {
                Write-Host '[AVISO_FATAL_REBOOT] Pagefile 1:1 gravado. REINICIE O SERVIDOR AGORA. Conveniente nao sobe antes do reboot.'
                Write-Log "$Reason start aborted pagefile_reboot"
                return
            }
        } catch {
            Write-Log "$Reason pagefile_exception $($_.Exception.Message)"
        }
    }

    Write-IndexStartLock

    $node = Resolve-ConvenienteNodeExe
    if (-not $node) { Write-Host 'ERRO: runtime Node pinado indisponivel'; return }

    $p = Start-ConvenienteNodeHost -NodeExe $node -IndexPath $IndexJs -WorkDir $Conveniente
    if ($p) {
        try { $p.PriorityClass = 'AboveNormal' } catch {}
        "$($p.Id)" | Set-Content $PidFile -Encoding ASCII
    }
    Start-Sleep -Seconds 3
    $st3 = Get-SystemState -Lite
    $up3 = $false
    $why3 = 'down'
    $masters3 = 0
    $nodes3 = 0
    if ($st3) {
        $up3 = [bool]$st3.Up
        $why3 = [string]$st3.Why
        $masters3 = [int]$st3.Masters
        $nodes3 = [int]$st3.Nodes
    }
    Write-Host "INICIADO up=$up3 why=$why3 masters=$masters3 nodes=$nodes3"
    Write-Log "$Reason start done up=$up3 why=$why3"
}

function Do-Status {
    $st = Get-SystemState
    $disk = Get-DiskFreeGB
    $pwr = ((powercfg /getactivescheme) | Out-String) -replace '\s+', ' '
    $sch = Get-DiskDailyScheduleToday
    Write-Host "Paused=$($st.Paused) Up=$($st.Up) Why=$($st.Why) Masters=$($st.Masters) Nodes=$($st.Nodes) Chrome=$($st.Chrome) Port8088=$($st.Port) DiskGB=$disk"
    Write-Host "Host=$env:COMPUTERNAME Ver=$Version"
    Write-Host "DiskDaily=$($sch.RunAt.ToString('HH:mm')) (janela 04:30-06:00, 1x/dia)"
    Write-Host "DiskEmerg=<4GB / max 5h+offset $($sch.OffsetMin) min (sem gate de CPU)"
    if (Test-NoReboot) {
        Write-Host 'RebootDaily=DESLIGADO (arquivo C:\auto_vigia\NO_REBOOT.flag)'
    } else {
        Write-Host ("RebootDaily={0:D2}:{1:D2}-{2:D2}:{3:D2} (1x/dia; limpeza+reboot)" -f $RebootHour, $RebootMinute, $RebootHour, ($RebootMinute + $RebootWindowMin))
        Write-Host ("NetGuard wait={0}min down={1}min extra={2}/dia (placa nao livra; queda curta nao reboota)" -f $NetCheckWaitMin, $NetDownConfirmMin, $NetRetryMax)
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
    # Sem WMI. O lock e o dono do loop. PID velho no arquivo morre aqui.
    $my = $PID
    if (-not (Test-Path -LiteralPath $LockFile)) { return }
    try {
        $old = [int]((Get-Content -LiteralPath $LockFile -Raw).Trim())
        if ($old -gt 0 -and $old -ne $my) {
            Stop-Process -Id $old -Force -ErrorAction SilentlyContinue
            Write-Log "rival_kill pid=$old"
        }
    } catch {}
}

function Test-LoopLockAlive {
    if (-not (Test-Path -LiteralPath $LockFile)) { return $false }
    try {
        $id = [int]((Get-Content -LiteralPath $LockFile -Raw).Trim())
        if ($id -le 0) { return $false }
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $proc) { return $false }
        $name = [string]$proc.ProcessName
        return ($name -match '^(powershell|pwsh)$')
    } catch {}
    return $false
}

function Write-LoopBeat {
    try {
        [string][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() | Set-Content -LiteralPath $BeatFile -Encoding ASCII
    } catch {}
}

function Get-LoopBeatAgeSec {
    if (-not (Test-Path -LiteralPath $BeatFile)) { return [int]::MaxValue }
    try {
        return [int][math]::Round(((Get-Date) - (Get-Item -LiteralPath $BeatFile).LastWriteTime).TotalSeconds)
    } catch {
        return [int]::MaxValue
    }
}

function Test-LoopBeatFresh([int]$MaxAgeSec = 90) {
    return ((Get-LoopBeatAgeSec) -le $MaxAgeSec)
}

function Test-KitSrcNomem([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $t = ''
    try { $t = [string](Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue) } catch { return $false }
    if ($t.Contains(('Invoke-Soft' + 'MemClean'))) { return $false }
    if ($t.Contains(('mem_' + 'soft'))) { return $false }
    if ($t.Contains(('Get-Cpu' + 'Avg'))) { return $false }
    if ($t -notmatch 'v5\.2\.1-clean-cpu') { return $false }
    if ($t -notmatch 'MemClean=OFF') { return $false }
    return $true
}

function Copy-KitIfChanged {
    if (-not (Test-Path -LiteralPath $KitSrc)) { return $false }
    if (-not (Test-KitSrcNomem $KitSrc)) { return $false }
    $dest = Join-Path $Root 'manutencao.ps1'
    $need = $true
    if (Test-Path -LiteralPath $dest) {
        try {
            $a = (Get-FileHash -LiteralPath $KitSrc -Algorithm MD5).Hash
            $b = (Get-FileHash -LiteralPath $dest -Algorithm MD5).Hash
            if ($a -eq $b) { $need = $false }
        } catch {}
    }
    if (-not $need) { return $false }
    Copy-Item -LiteralPath $KitSrc -Destination $dest -Force
    return $true
}

function Repair-PulseTaskHidden {
    $vbs = Join-Path $Root 'pulse_hidden.vbs'
    if (-not (Test-Path -LiteralPath $vbs)) { return $false }
    $raw = ''
    try { $raw = [string]((& schtasks.exe /Query /TN ConvenientePorteiroPulse /FO LIST /V 2>$null | Out-String)) } catch { $raw = '' }
    if ($raw -match 'pulse_hidden\.vbs') { return $false }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $tr = "`"$wscript`" //B //Nologo C:\auto_vigia\pulse_hidden.vbs"
    & schtasks.exe /create /tn ConvenientePorteiroPulse /tr $tr /sc minute /mo 2 /f 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Copy-PulseHiddenIfChanged {
    $src = Join-Path $Conveniente 'porteiro\kit\pulse_hidden.vbs'
    $dst = Join-Path $Root 'pulse_hidden.vbs'
    if (-not (Test-Path -LiteralPath $src)) { return $false }
    $need = $true
    if (Test-Path -LiteralPath $dst) {
        try {
            $a = (Get-FileHash -LiteralPath $src -Algorithm MD5).Hash
            $b = (Get-FileHash -LiteralPath $dst -Algorithm MD5).Hash
            if ($a -eq $b) { $need = $false }
        } catch {}
    }
    if (-not $need) { return $false }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    return $true
}

function Start-LoopArmSidecar {
    # Dump/WerSvc fora do olho. Se travar, o loop ainda liga o index.
    try {
        $psExe = Get-ConvenientePsHost
        $self = Join-Path $Root 'manutencao.ps1'
        if (-not (Test-Path -LiteralPath $self)) { $self = $PSCommandPath }
        Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
            '-File', $self, '-Action', 'arm'
        ) | Out-Null
    } catch {}
}

function Do-Arm {
    Ensure-Dirs
    try { [void](Ensure-NodeCrashDumps) } catch {}
    try { [void](Ensure-WerSvc) } catch {}
}

function Stop-LoopLock {
    if (-not (Test-Path -LiteralPath $LockFile)) { return }
    try {
        $id = [int]((Get-Content -LiteralPath $LockFile -Raw).Trim())
        if ($id -gt 0 -and $id -ne $PID) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    } catch {}
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}

function Start-LoopProcess {
    $psExe = Get-ConvenientePsHost
    $self = Join-Path $Root 'manutencao.ps1'
    if (-not (Test-Path -LiteralPath $self)) { $self = $PSCommandPath }
    Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', $self, '-Action', 'loop'
    ) | Out-Null
}

function Do-Pulse {
    # Windows. Sem index. Sem ler porteiro.log.
    # Kit mudou -> copia, mata, nasce. Processo morto/preso -> nasce.
    Ensure-Dirs
    try { [void](Copy-PulseHiddenIfChanged) } catch {}
    try { [void](Repair-PulseTaskHidden) } catch {}
    $swapped = $false
    try { $swapped = [bool](Copy-KitIfChanged) } catch { $swapped = $false }
    $alive = [bool](Test-LoopLockAlive)
    $fresh = [bool](Test-LoopBeatFresh 90)
    if ($swapped) {
        Write-Log 'pulse_kit_swap'
        Stop-LoopLock
        Start-LoopProcess
        return
    }
    if ($alive -and $fresh) { return }
    if ($alive) {
        Write-Log ('pulse_hung age=' + [string](Get-LoopBeatAgeSec))
        Stop-LoopLock
    } else {
        Write-Log 'pulse_dead'
    }
    Start-LoopProcess
}

function Read-IndexHeartbeat {
    $path = Join-Path $Conveniente 'dados\index_heartbeat.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-StallKillEpochs {
    $raw = [string](Get-EstadoProp (Get-Estado) 'stallKillEpochs')
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $cut = $now - [int64]$IndexStallWindowSec
    $out = New-Object System.Collections.Generic.List[int64]
    foreach ($part in ($raw -split ',')) {
        $txt = ([string]$part).Trim()
        if (-not $txt) { continue }
        try {
            $n = [int64]$txt
            if ($n -gt $cut) { [void]$out.Add($n) }
        } catch {}
    }
    return ,$out
}

# Pid do arquivo + node.exe + bootTs bate com o StartTime.
# Worker nao escreve esse arquivo. Pid reaproveitado nao passa no bootTs.
function Test-IndexHeartbeatOwner($hb) {
    $procId = 0
    try { $procId = [int](Get-EstadoProp $hb 'pid') } catch { return $null }
    if ($procId -le 0) { return $null }
    if ([string](Get-EstadoProp $hb 'role') -ne 'index') { return $null }
    if ((Get-EstadoProp $hb 'indexMain') -ne $true) { return $null }
    $boot = 0L
    try { $boot = [int64](Get-EstadoProp $hb 'bootTs') } catch { return $null }
    if ($boot -le 0) { return $null }
    $proc = $null
    try { $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue } catch { $proc = $null }
    if (-not $proc) { return $null }
    if ([string]$proc.ProcessName -ne 'node') { return $null }
    try {
        $utc = $proc.StartTime.ToUniversalTime()
        $dto = New-Object System.DateTimeOffset $utc
        $startMs = $dto.ToUnixTimeMilliseconds()
        $skew = [math]::Abs($startMs - $boot)
        if ($skew -gt $IndexStallBootSkewMs) { return $null }
        $uptime = [int][math]::Floor(((Get-Date) - $proc.StartTime).TotalSeconds)
        if ($uptime -lt 0) { return $null }
        return [pscustomobject]@{ Pid = $procId; UptimeSec = $uptime }
    } catch {
        return $null
    }
}

function Stop-StalledIndex([int]$IndexPid) {
    try { [void](Stop-ConvenienteConsoleHosts) } catch {}
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $up = $false
        $hosts = 0
        try { $up = [bool](Test-Port8088) } catch { $up = $true }
        try { $hosts = [int](Count-ConvenienteNodeHosts) } catch { $hosts = 1 }
        if (-not $up -and $hosts -le 0) { return $true }
        Start-Sleep -Seconds 1
    }
    $listen = 0
    try { $listen = [int](Get-ListenPid $PanelPort) } catch { $listen = 0 }
    if ($listen -gt 0 -and $listen -eq $IndexPid) {
        & taskkill.exe /F /PID $listen 2>$null | Out-Null
        Start-Sleep -Seconds 2
    }
    $up2 = $true
    $hosts2 = 1
    try { $up2 = [bool](Test-Port8088) } catch { $up2 = $true }
    try { $hosts2 = [int](Count-ConvenienteNodeHosts) } catch { $hosts2 = 1 }
    return (-not $up2 -and $hosts2 -le 0)
}

# So roda com a porta no ar. Nao mexe em celula, chrome nem worker solto.
function Invoke-IndexStallGuard {
    $hb = Read-IndexHeartbeat
    if (-not $hb) { return $null }
    $hbTs = 0L
    try { $hbTs = [int64](Get-EstadoProp $hb 'ts') } catch { return $null }
    if ($hbTs -le 0) { return $null }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $age = [int](($nowMs - $hbTs) / 1000)
    if ($age -lt 0 -or $age -lt $IndexStallAgeSec) {
        $prevStrikes = 0
        try { $prevStrikes = [int](Get-EstadoProp (Get-Estado) 'stallStrikes') } catch { $prevStrikes = 0 }
        if ($prevStrikes -gt 0) {
            Save-EstadoFields @{ stallSuspectPid = 0; stallSuspectHbTs = 0; stallStrikes = 0 }
        }
        return $null
    }
    if ($age -gt $IndexStallAbsurdAgeSec) {
        $logged = [string](Get-EstadoProp (Get-Estado) 'stallAbsurdHbTs')
        if ($logged -ne [string]$hbTs) {
            Save-EstadoFields @{ stallAbsurdHbTs = [string]$hbTs }
            Write-Log "stall_guard_age_absurd age=$age"
        }
        return $null
    }
    $owner = Test-IndexHeartbeatOwner $hb
    if (-not $owner) {
        $loggedId = [string](Get-EstadoProp (Get-Estado) 'stallIdentityHbTs')
        if ($loggedId -ne [string]$hbTs) {
            Save-EstadoFields @{ stallIdentityHbTs = [string]$hbTs; stallSuspectPid = 0; stallSuspectHbTs = 0; stallStrikes = 0 }
            Write-Log "stall_guard_identity age=$age"
        }
        return $null
    }
    if ([int]$owner.UptimeSec -lt $IndexStallBootGraceSec) { return $null }

    $est = Get-Estado
    $strikes = 0
    $prevPid = 0
    $prevTs = 0L
    try { $strikes = [int](Get-EstadoProp $est 'stallStrikes') } catch { $strikes = 0 }
    try { $prevPid = [int](Get-EstadoProp $est 'stallSuspectPid') } catch { $prevPid = 0 }
    try { $prevTs = [int64](Get-EstadoProp $est 'stallSuspectHbTs') } catch { $prevTs = 0 }
    if ($prevPid -eq [int]$owner.Pid -and $prevTs -eq $hbTs) { $strikes = $strikes + 1 }
    else { $strikes = 1 }
    Save-EstadoFields @{
        stallSuspectPid = [int]$owner.Pid
        stallSuspectHbTs = $hbTs
        stallStrikes = $strikes
    }
    if ($strikes -lt 2) {
        Write-Log ("stall_guard_suspect pid=$($owner.Pid) age=$age uptime=$($owner.UptimeSec) strike=$strikes")
        return 'stall_suspect'
    }

    $epochs = Get-StallKillEpochs
    $nowSec = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $lastKill = 0L
    if ($epochs -and $epochs.Count -gt 0) { $lastKill = [int64]$epochs[$epochs.Count - 1] }
    $sinceKill = [int64]($nowSec - $lastKill)
    if ($lastKill -gt 0 -and $sinceKill -ge 0 -and $sinceKill -lt $IndexStallCooldownSec) {
        $loggedCd = [string](Get-EstadoProp (Get-Estado) 'stallCooldownHbTs')
        if ($loggedCd -ne [string]$hbTs) {
            Save-EstadoFields @{ stallCooldownHbTs = [string]$hbTs }
            Write-Log "stall_guard_cooldown pid=$($owner.Pid) age=$age since=$sinceKill"
        }
        return $null
    }
    if ($epochs -and $epochs.Count -ge $IndexStallMaxKills) {
        $loggedB = [string](Get-EstadoProp (Get-Estado) 'stallBudgetHbTs')
        if ($loggedB -ne [string]$hbTs) {
            Save-EstadoFields @{ stallBudgetHbTs = [string]$hbTs }
            Write-Log "stall_guard_budget pid=$($owner.Pid) age=$age kills=$($epochs.Count)"
        }
        return $null
    }

    if ($null -eq $epochs) { $epochs = New-Object System.Collections.Generic.List[int64] }
    [void]$epochs.Add($nowSec)
    Save-EstadoFields @{
        stallKillEpochs = ($epochs -join ',')
        stallLastKillUtc = (Get-Date).ToUniversalTime().ToString('o')
        stallSuspectPid = 0
        stallSuspectHbTs = 0
        stallStrikes = 0
    }
    Write-Log ("stall_guard_kill pid=$($owner.Pid) age=$age uptime=$($owner.UptimeSec) kills=$($epochs.Count)")
    $down = $false
    try { $down = [bool](Stop-StalledIndex -IndexPid ([int]$owner.Pid)) } catch { $down = $false }
    if (-not $down) {
        Write-Log "stall_guard_kill_incomplete pid=$($owner.Pid)"
        return 'stall_kill_incomplete'
    }
    try { Do-Start -Reason 'STALL' | Out-Null } catch {
        Write-Log "stall_guard_start_fail $($_.Exception.Message)"
        return 'stall_start_fail'
    }
    return 'stall_restart'
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
    Write-LoopBeat
    Stop-RivalVigia

    Set-MaxPerf
    Start-LoopArmSidecar
    if (Test-NoReboot) { Write-Log "BOOT $Version reboot=DESLIGADO" }
    else { Write-Log (("BOOT $Version reboot={0:D2}:{1:D2}" -f $RebootHour, $RebootMinute)) }
    try { [void](Ensure-DiskCleanTask) } catch {}

    # Critico empresa: PARAR nao pode deixar a VM muda apos reinicio diario.
    # PAUSED vale so na sessao atual; apos boot o porteiro libera e sobe o Conveniente.
    if (Test-Paused) {
        Set-PausedFlag $false
        Write-Log 'auto_unpause_on_boot'
    }

    # Index caiu: espera 3 min (git pull). Nao sobe na hora.
    $IndexDownSince = $null
    try {
        $stBoot = Get-SystemState -Lite
        if ($stBoot -and $stBoot.Up) {
            Write-Log "AUTO_BOOT skipped already_up=$($stBoot.Why)"
        } else {
            $IndexDownSince = Get-Date
            Write-Log ("AUTO_BOOT wait_index {0}s" -f $IndexStartGraceSec)
        }
    } catch {
        $IndexDownSince = Get-Date
        Write-Log "AUTO_BOOT wait_index"
    }

    $downStreak = 0
    $hammeredThisDown = $false

    while ($true) {
        try {
            Write-LoopBeat
            $cpu = 0
            $st = Get-SystemState -Lite
            $hosts = [int](Count-ConvenienteNodeHosts)
            $disk = Get-DiskFreeGB
            $actions = @()
            $nodeMsg = ''

            if ($st -and $st.Up) { Clear-IndexStartLock }

            if (Test-Paused) {
                $nodeMsg = 'paused'
                $downStreak = 0
                $IndexDownSince = $null
                $hammeredThisDown = $false
            }
            elseif ($st.Up) {
                $nodeMsg = "ok:$($st.Why):m=$($st.Masters):n=$($st.Nodes)"
                $downStreak = 0
                $IndexDownSince = $null
                $hammeredThisDown = $false
                $stallAct = $null
                try { $stallAct = Invoke-IndexStallGuard } catch { $stallAct = $null }
                if ($stallAct) { $actions += [string]$stallAct }
            }
            elseif ($hosts -gt 0) {
                if (-not $IndexDownSince) { $IndexDownSince = Get-Date }
                $downSec = [int]((Get-Date) - $IndexDownSince).TotalSeconds
                if ($downSec -lt $IndexStartGraceSec) {
                    $nodeMsg = "wait_host n=$hosts ${downSec}s/$IndexStartGraceSec"
                } else {
                    Write-Log "host_zombie n=$hosts down=${downSec}s"
                    [void](Stop-ConvenienteConsoleHosts)
                    Clear-IndexStartLock
                    $IndexDownSince = $null
                    if (-not $hammeredThisDown) {
                        Invoke-CrashHammer -Reason 'porteiro_down'
                        $actions += 'crash_hammer'
                        $hammeredThisDown = $true
                    }
                    Do-Start -Reason 'AUTO' | Out-Null
                    $st = Get-SystemState -Lite
                    $nodeMsg = "start_attempt zombie up=$($st.Up) why=$($st.Why)"
                    $downStreak = 0
                }
            }
            elseif (Test-IndexStartInflight) {
                $nodeMsg = 'wait_host inflight'
            }
            else {
                $downStreak++
                if (-not $IndexDownSince) { $IndexDownSince = Get-Date }
                $downSec = [int]((Get-Date) - $IndexDownSince).TotalSeconds
                if ($downSec -lt $IndexStartGraceSec) {
                    $nodeMsg = "wait_index ${downSec}s/$IndexStartGraceSec"
                } else {
                    if (-not $hammeredThisDown) {
                        Invoke-CrashHammer -Reason 'porteiro_down'
                        $actions += 'crash_hammer'
                        $hammeredThisDown = $true
                    }
                    Do-Start -Reason 'AUTO' | Out-Null
                    $st = Get-SystemState -Lite
                    $nodeMsg = "start_attempt up=$($st.Up) why=$($st.Why)"
                    $downStreak = 0
                    $IndexDownSince = $null
                }
            }

            # Rede: watchdog WAN. Reboot so apos NetDownConfirmMin sem internet.
            $netAct = Invoke-StartupNetworkGuard
            if ($netAct) { $actions += $netAct }

            # Reboot diario: limpeza TEMP+Lixeira e reinicia (1x/dia apos horario)
            if (Test-DailyRebootDue) {
                $actions += (Invoke-DailyReboot)
                Write-Log "CPU=$cpu DISK=$disk`GB NODE=$nodeMsg ACTION=$($actions -join ',')"
                Start-Sleep -Seconds 60
                continue
            }

            # Disco madrugada: 1x/dia 04:30-06:00, horario diferente por VM. Sem gate de CPU.
            if (Test-DiskDailyDue) {
                $actions += (Invoke-DiskDailyClean)
            }
            # Disco emergencia (dia): <4GB, max 5h+offset. Sem gate de CPU.
            elseif (Test-DiskEmergencyDue -DiskGB $disk) {
                $actions += (Invoke-DiskEmergencyClean)
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
            Write-LoopBeat
        }
        Start-Sleep -Seconds 30
    }
}

# ---------------- dispatch ----------------
Ensure-Dirs
switch ($Action) {
    'stop'    { Do-Stop }
    'start'   { Do-Start }
    'status'  { Do-Status }
    'loop'    { Do-Loop }
    'arm'     { Do-Arm }
    'pulse'   { Do-Pulse }
    'netboot' { Do-NetBoot }
    'ensure_diskclean' {
        $r = Ensure-DiskCleanTask
        if ($r -ne 'ok') { exit 1 }
    }
    'install' {
        Write-Host 'Use Setup_Manutencao.bat para instalar.'
    }
}

