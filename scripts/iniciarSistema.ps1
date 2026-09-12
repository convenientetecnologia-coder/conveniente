# Clique Iniciar: sobe o Conveniente. Arma o loop em silencio se faltar.
# Sem admin. Sem OK. Launcher some. Uma janela visivel: Conveniente_Node (powershell nativo).
# Armado = dest nomem v5.2.1-clean-cpu + loop vivo. Hash/NetBoot NAO bloqueiam o clique.
# Recusa kit com Get-CpuAvg / Win32_Processor.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

try {
    Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -ErrorAction SilentlyContinue
    $hwnd = [Native.Win]::GetConsoleWindow()
    if ($hwnd -ne [IntPtr]::Zero) { [void][Native.Win]::ShowWindow($hwnd, 0) }
} catch {}

$kitSrc = 'C:\conveniente\porteiro\kit\manutencao.ps1'
$destDir = 'C:\auto_vigia'
$destPs1 = Join-Path $destDir 'manutencao.ps1'
$pauseFlag = Join-Path $destDir 'PAUSED.flag'
$logFile = Join-Path $destDir 'logs\porteiro_ensure.log'
$indexJs = 'C:\conveniente\index.js'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$nodeRuntimePs1 = 'C:\conveniente\scripts\nodeRuntime.ps1'

try {
    if (Test-Path -LiteralPath $nodeRuntimePs1) {
        . $nodeRuntimePs1
    }
} catch {}

function Write-StartLog([string]$Line) {
    try {
        New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $logFile -Value "$ts INICIAR $Line" -Encoding ASCII
    } catch {}
}

function Resolve-ConvenienteNodeExe {
    if (-not (Get-Command Ensure-ConvenienteNodeRuntime -ErrorAction SilentlyContinue)) {
        Write-StartLog 'node_runtime_helper_missing'
        return $null
    }
    try {
        $rt = Ensure-ConvenienteNodeRuntime
        if ($rt -and $rt.Ok -and $rt.NodeExe) {
            Write-StartLog ('node_runtime_ok ' + [string]$rt.WantedTag + ' ' + [string]$rt.Source)
            return [string]$rt.NodeExe
        }
        Write-StartLog ('node_runtime_fail ' + [string]$rt.Error)
    } catch {
        Write-StartLog ('node_runtime_exception ' + $_.Exception.Message)
    }
    return $null
}

function Test-ConvenienteCellsAlive {
    $regPath = 'C:\conveniente\dados\cells\registry.json'
    if (-not (Test-Path -LiteralPath $regPath)) { return $false }
    try {
        $reg = Get-Content -LiteralPath $regPath -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($c in @($reg.cells)) {
            $id = 0
            try { $id = [int]$c.pid } catch { $id = 0 }
            if ($id -le 0) { continue }
            $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
            if ($proc) { return $true }
        }
    } catch {}
    return $false
}

function Invoke-ConvenienteCellCli([string]$Arg, [string]$Extra = '') {
    $node = Resolve-ConvenienteNodeExe
    if (-not $node) { return $null }
    $life = 'C:\conveniente\scripts\cellLifecycle.js'
    if (-not (Test-Path -LiteralPath $life)) { return $null }
    try {
        $out = if ($Extra) { & $node $life $Arg $Extra } else { & $node $life $Arg }
        return [string]$out
    } catch {
        return $null
    }
}

function Test-ConvenienteNeedRestart {
    $v = Invoke-ConvenienteCellCli 'need-restart'
    return ($v -eq '1')
}

function Stop-ConvenienteCells([string]$Reason = 'iniciar') {
    Write-StartLog ('cells_stop ' + $Reason)
    if ($Reason -notmatch 'iniciar_stamp') {
        Write-ConvenienteHumanHold ('stop_workers:' + $Reason)
    }
    [void](Invoke-ConvenienteCellCli 'stop' $Reason)
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

function Test-ConvenienteUp {
    return ((Get-ListenPid 8088) -gt 0)
}

function Test-NomemFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $t = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
    if ([string]::IsNullOrEmpty($t)) { return $false }
    if ($t -match 'Invoke-SoftMemClean') { return $false }
    if ($t -match '\bmem_soft\b') { return $false }
    if ($t -match "ArgumentList '/StandbyList'") { return $false }
    if ($t -match 'Start-Process[\s\S]{0,240}DiskClean\.exe') { return $false }
    if ($t -match 'function Get-CpuAvg') { return $false }
    if ($t -match 'Get-CimInstance[\s\S]{0,80}Win32_Processor') { return $false }
    if ($t -notmatch 'v5\.2\.1-clean-cpu') { return $false }
    if ($t -notmatch '\$cpu\s*=\s*0') { return $false }
    if ($t -notmatch 'MemClean=OFF') { return $false }
    if ($t -notmatch 'ConvenienteDiskClean') { return $false }
    if ($t -notmatch 'function Ensure-DiskCleanTask') { return $false }
    return $true
}

function Test-LoopAlive {
    $lock = Join-Path $destDir 'porteiro.lock'
    if (-not (Test-Path -LiteralPath $lock)) { return $false }
    try {
        $id = [int]((Get-Content -LiteralPath $lock -Raw).Trim())
        if ($id -le 0) { return $false }
        $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $proc) { return $false }
        $name = [string]$proc.ProcessName
        if ($name -notmatch '^(powershell|pwsh)$') { return $false }
        return $true
    } catch {}
    return $false
}

function Get-PorteiroBeatAgeSec {
    $beat = Join-Path $destDir 'porteiro.beat'
    if (-not (Test-Path -LiteralPath $beat)) { return [int]::MaxValue }
    try {
        return [int][math]::Round(((Get-Date) - (Get-Item -LiteralPath $beat).LastWriteTime).TotalSeconds)
    } catch {
        return [int]::MaxValue
    }
}

function Test-PorteiroLoopFresh {
    return ((Get-PorteiroBeatAgeSec) -le 90)
}

function Copy-KitSilent {
    if (-not (Test-Path -LiteralPath $kitSrc)) {
        Write-StartLog 'kit_missing'
        return
    }
    if (-not (Test-NomemFile $kitSrc)) {
        Write-StartLog 'kit_not_nomem'
        return
    }
    try {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $destDir 'logs') -Force | Out-Null
        $need = $true
        if (Test-Path -LiteralPath $destPs1) {
            try {
                $a = (Get-FileHash -LiteralPath $kitSrc -Algorithm MD5).Hash
                $b = (Get-FileHash -LiteralPath $destPs1 -Algorithm MD5).Hash
                if ($a -eq $b) { $need = $false }
            } catch {}
        }
        if ($need) {
            Copy-Item -LiteralPath $kitSrc -Destination $destPs1 -Force
            Write-StartLog 'copied_dest'
            return $true
        }
        Write-StartLog 'dest_already_kit'
        return $false
    } catch {
        Write-StartLog ('copy_fail ' + $_.Exception.Message)
        return $false
    }
}

function Stop-LoopOnly {
    & schtasks.exe /End /TN 'ConvenientePorteiro' 1>$null 2>$null
    $lock = Join-Path $destDir 'porteiro.lock'
    if (Test-Path -LiteralPath $lock) {
        try {
            $id = [int]((Get-Content -LiteralPath $lock -Raw).Trim())
            if ($id -gt 0) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        } catch {}
        Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
    }
}

function Start-LoopSilent {
    $alive = [bool](Test-LoopAlive)
    $fresh = [bool](Test-PorteiroLoopFresh)
    if ($alive -and $fresh) {
        Write-StartLog 'loop_alive'
        return
    }
    if ($alive -and -not $fresh) {
        Write-StartLog ('loop_stale_restart age=' + [string](Get-PorteiroBeatAgeSec))
        Stop-LoopOnly
    }
    & schtasks.exe /Run /TN 'ConvenientePorteiro' 1>$null 2>$null
    for ($i = 0; $i -lt 3; $i++) {
        Start-Sleep -Milliseconds 200
        if (Test-LoopAlive) {
            Write-StartLog 'loop_via_schtasks'
            return
        }
    }
    & schtasks.exe /Query /TN 'ConvenientePorteiro' 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-StartLog 'loop_wait_schtasks'
        return
    }
    if (-not (Test-Path -LiteralPath $destPs1)) {
        Write-StartLog 'loop_no_dest'
        return
    }
    Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $destPs1, '-Action', 'loop'
    ) | Out-Null
    Start-Sleep -Milliseconds 800
    if (Test-LoopAlive) { Write-StartLog 'loop_via_start_process' } else { Write-StartLog 'loop_start_attempted' }
}

function Ensure-LogonTaskSilent {
    & schtasks.exe /Query /TN 'ConvenientePorteiro' 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-StartLog 'task_loop_exists'
    } else {
        $tr = "$ps -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action loop"
        & schtasks.exe /create /tn ConvenientePorteiro /tr $tr /sc onlogon /f 1>$null 2>$null
        if ($LASTEXITCODE -eq 0) { Write-StartLog 'task_loop_created' } else { Write-StartLog 'task_loop_create_skip' }
    }
    if (Test-Path -LiteralPath $destPs1) {
        $destTxt = ''
        try { $destTxt = [string](Get-Content -LiteralPath $destPs1 -Raw -ErrorAction SilentlyContinue) } catch {}
        if ($destTxt -match 'function Do-Pulse') { Ensure-PulseTaskSilent }
    }
}

function Ensure-PulseTaskSilent {
    & schtasks.exe /Query /TN 'ConvenientePorteiroPulse' 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-StartLog 'task_pulse_exists'
        return
    }
    $tr = "$ps -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action pulse"
    & schtasks.exe /create /tn ConvenientePorteiroPulse /tr $tr /sc minute /mo 2 /f 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { Write-StartLog 'task_pulse_created' } else { Write-StartLog 'task_pulse_create_skip' }
}

function Test-IsConvenienteNodeHost([string]$CommandLine) {
    $c = [string]$CommandLine
    if ([string]::IsNullOrWhiteSpace($c)) { return $false }
    if ($c -match 'manutencao\.ps1|iniciarSistema\.ps1|porteiroEnsure\.ps1|winTuningMaster\.ps1|windowsForensicDeep|crashHammer\.ps1|-Action loop') { return $false }
    return ($c -match 'Conveniente_Node' -or $c -match 'conveniente\\index\.js')
}

function Stop-ConvenienteConsoleHosts {
    $killed = 0
    foreach ($name in @('powershell', 'pwsh', 'cmd')) {
        foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $title = ''
            try { $title = [string]$p.MainWindowTitle } catch { $title = '' }
            if ($title -ne 'Conveniente_Node') { continue }
            try { & taskkill.exe /F /PID $p.Id /T 2>$null | Out-Null } catch {}
            $killed++
        }
    }
    return $killed
}

function Write-ConvenienteHumanHold([string]$Reason) {
    $fp = 'C:\conveniente\dados\human_boot_hold.json'
    try {
        $dir = Split-Path -Parent $fp
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $obj = @{
            version = 1
            active  = $true
            reason  = [string]$Reason
            by      = 'iniciar_sistema'
            at      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        ($obj | ConvertTo-Json -Compress) | Set-Content -LiteralPath $fp -Encoding UTF8
        Write-StartLog ('human_hold ' + $Reason)
    } catch {
        Write-StartLog ('human_hold_fail ' + $_.Exception.Message)
    }
}

function Start-ConvenienteNodeHost {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$IndexPath,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $hostPs1 = 'C:\conveniente\scripts\convenienteNodeHost.ps1'
    return Start-Process -FilePath $ps -ArgumentList @(
        '-NoExit',
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $hostPs1,
        '-NodeExe', $NodeExe,
        '-IndexPath', $IndexPath,
        '-WorkDir', $WorkDir,
        '-BootSource', 'iniciar'
    ) -WorkingDirectory $WorkDir -WindowStyle Normal -PassThru
}

function Wait-ConvenienteUp([int]$TimeoutSec = 1) {
    $deadline = (Get-Date).AddSeconds([math]::Max(1, $TimeoutSec))
    while ((Get-Date) -lt $deadline) {
        if (Test-ConvenienteUp) {
            Write-StartLog 'wait_up_ok'
            return $true
        }
        Start-Sleep -Milliseconds 150
    }
    Write-StartLog 'wait_up_timeout'
    return $false
}

function Stop-ConvenienteMaestro {
    [void](Stop-ConvenienteConsoleHosts)
    $listenPid = Get-ListenPid 8088
    if ($listenPid -gt 0) {
        try { & taskkill.exe /F /PID $listenPid 2>$null | Out-Null } catch {}
    }
    $deadline = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ConvenienteUp)) { return }
        Start-Sleep -Milliseconds 150
    }
}

function Start-ConvenienteNode {
    if (Test-ConvenienteUp) {
        $need = $true
        try { $need = [bool](Test-ConvenienteNeedRestart) } catch { $need = $true }
        if (-not $need) {
            Write-StartLog 'already_up'
            return 0
        }
        Write-StartLog 'already_up_recycle restart_maestro'
        Write-ConvenienteHumanHold 'iniciar_recycle'
        Stop-ConvenienteMaestro
    }
    try {
        if (Test-Path -LiteralPath $pauseFlag) { Remove-Item -LiteralPath $pauseFlag -Force -ErrorAction SilentlyContinue }
    } catch {}
    if (-not (Test-Path -LiteralPath $indexJs)) {
        Write-StartLog 'index_missing'
        return 1
    }
    $node = Resolve-ConvenienteNodeExe
    if (-not $node) {
        Write-StartLog 'node_missing'
        return 1
    }
    [void](Stop-ConvenienteConsoleHosts)
    try {
        $needCells = $false
        try { $needCells = [bool](Test-ConvenienteNeedRestart) } catch { $needCells = $false }
        if ($needCells -and (Test-ConvenienteCellsAlive)) {
            Write-StartLog 'cells_hard_stop before_launch'
            Stop-ConvenienteCells 'iniciar_stamp'
        }
    } catch {}
    Write-StartLog 'launch_host'
    [void](Start-ConvenienteNodeHost -NodeExe $node -IndexPath $indexJs -WorkDir 'C:\conveniente')
    Write-StartLog 'started_node'
    return 0
}

Write-StartLog 'click'
# Janela do Node primeiro. Kit/loop/tuning depois, sem esconder o clique.
$code = Start-ConvenienteNode
try {
    $tune = 'C:\conveniente\scripts\winTuningMaster.ps1'
    if (Test-Path -LiteralPath $tune) {
        Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $tune, '-Boot'
        ) | Out-Null
    }
} catch {}
$copied = $false
try { $copied = [bool](Copy-KitSilent) } catch { $copied = $false }
Ensure-LogonTaskSilent
[void](Wait-ConvenienteUp 1)
if ($copied) {
    Write-StartLog 'version_swap'
    Stop-LoopOnly
    Start-Sleep -Milliseconds 200
}
Start-LoopSilent
exit $code
