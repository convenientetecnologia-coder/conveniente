# Clique Iniciar: sobe o Conveniente. Arma o loop em silencio se faltar.
# Sem admin. Sem OK. Launcher some. Uma janela visivel: Conveniente_Node (powershell nativo).
# Armado = dest nomem v5.2.1-clean-cpu + loop vivo. Hash/NetBoot NAO bloqueiam o clique.
# Recusa kit com Get-CpuAvg / Win32_Processor.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# Tuning do host: dispara e segue. Sem Wait. Sem RunAs. Nao atrasa o Node.
try {
    $tune = 'C:\conveniente\scripts\winTuningMaster.ps1'
    if (Test-Path -LiteralPath $tune) {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -WindowStyle Hidden -ArgumentList @(
            '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', $tune, '-Boot'
        ) | Out-Null
    }
} catch {}

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

function Invoke-ConvenienteCellCli([string]$Arg) {
    $node = Resolve-ConvenienteNodeExe
    if (-not $node) { return $null }
    $life = 'C:\conveniente\scripts\cellLifecycle.js'
    if (-not (Test-Path -LiteralPath $life)) { return $null }
    try {
        $out = & $node $life $Arg
        return [string]$out
    } catch {
        return $null
    }
}

function Test-ConvenienteCellsStale {
    $v = Invoke-ConvenienteCellCli 'stale'
    return ($v -eq '1')
}

function Test-ConvenienteTopologyStale {
    $v = Invoke-ConvenienteCellCli 'topo-stale'
    return ($v -eq '1')
}

function Stop-ConvenienteCells([string]$Reason = 'iniciar') {
    Write-StartLog ('cells_stop ' + $Reason)
    Write-ConvenienteHumanHold ('stop_workers:' + $Reason)
    [void](Invoke-ConvenienteCellCli 'stop')
}

function Test-ConvenienteUp {
    try {
        $c = @(Get-NetTCPConnection -LocalPort 8088 -State Listen -ErrorAction SilentlyContinue)
        if ($c.Count -gt 0) { return $true }
    } catch {}
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        $cmd = [string]$p.CommandLine
        if ($cmd -and ($cmd -match 'index\.js')) { return $true }
    }
    return $false
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
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        $c = [string]$p.CommandLine
        if ($c -and ($c -match 'manutencao\.ps1') -and ($c -match '-Action loop')) {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
}

function Start-LoopSilent {
    if (Test-LoopAlive) {
        Write-StartLog 'loop_alive'
        return
    }
    & schtasks.exe /Run /TN 'ConvenientePorteiro' 1>$null 2>$null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
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
        return
    }
    $tr = "$ps -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action loop"
    & schtasks.exe /create /tn ConvenientePorteiro /tr $tr /sc onlogon /f 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { Write-StartLog 'task_loop_created' } else { Write-StartLog 'task_loop_create_skip' }
}

function Test-IsConvenienteNodeHost([string]$CommandLine) {
    $c = [string]$CommandLine
    if ([string]::IsNullOrWhiteSpace($c)) { return $false }
    if ($c -match 'manutencao\.ps1|iniciarSistema\.ps1|porteiroEnsure\.ps1|winTuningMaster\.ps1|windowsForensicDeep|crashHammer\.ps1|-Action loop') { return $false }
    return ($c -match 'Conveniente_Node' -or $c -match 'conveniente\\index\.js')
}

function Stop-ConvenienteConsoleHosts {
    $killed = 0
    foreach ($name in @('powershell.exe', 'cmd.exe')) {
        foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction SilentlyContinue)) {
            if (-not (Test-IsConvenienteNodeHost ([string]$p.CommandLine))) { continue }
            try { & taskkill.exe /F /PID $p.ProcessId /T 2>$null | Out-Null } catch {}
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

function Wait-ConvenienteUp([int]$TimeoutSec = 4) {
    $deadline = (Get-Date).AddSeconds([math]::Max(1, $TimeoutSec))
    while ((Get-Date) -lt $deadline) {
        if (Test-ConvenienteUp) {
            Write-StartLog 'wait_up_ok'
            return $true
        }
        Start-Sleep -Milliseconds 200
    }
    Write-StartLog 'wait_up_timeout'
    return $false
}

function Stop-ConvenienteMaestro {
    [void](Stop-ConvenienteConsoleHosts)
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        $cmd = [string]$p.CommandLine
        if (-not $cmd) { continue }
        if ($cmd -notmatch 'index\.js') { continue }
        if ($cmd -match 'cellEntry\.js') { continue }
        try { & taskkill.exe /F /PID $p.ProcessId 2>$null | Out-Null } catch {}
    }
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ConvenienteUp)) { return }
        Start-Sleep -Milliseconds 250
    }
}

function Start-ConvenienteNode {
    $cellsAlive = $false
    try { $cellsAlive = [bool](Test-ConvenienteCellsAlive) } catch { $cellsAlive = $false }
    $cellsStale = $false
    try { $cellsStale = [bool](Test-ConvenienteCellsStale) } catch { $cellsStale = $false }
    $topoStale = $false
    try { $topoStale = [bool](Test-ConvenienteTopologyStale) } catch { $topoStale = $false }

    if (Test-ConvenienteUp) {
        if ($cellsAlive -and -not $cellsStale -and -not $topoStale) {
            Write-StartLog 'already_up'
            return 0
        }
        if ($cellsStale) {
            Write-StartLog 'already_up_stale restart_maestro'
            Write-Host ''
            Write-Host 'Codigo novo no disco (git pull). Reciclando index e celulas. Navegadores nascem fechados.'
            Write-Host ''
            if ($cellsAlive) { Stop-ConvenienteCells 'iniciar_already_up_stale' }
        } elseif (-not $cellsAlive) {
            Write-StartLog 'already_up_cells_dead restart_maestro'
            Write-Host ''
            Write-Host 'Index esta up, mas os workers estao mortos (Encerrar workers). Reiniciando o maestro para subir workers de novo, com navegador fechado.'
            Write-Host ''
        } elseif ($topoStale) {
            Write-StartLog 'already_up_topology restart_maestro'
            Write-Host ''
            Write-Host 'Divisor/topologia nova. Reciclando o index; as celulas passam para o numero novo neste boot.'
            Write-Host ''
        }
        Stop-ConvenienteMaestro
        $cellsAlive = $false
        try { $cellsAlive = [bool](Test-ConvenienteCellsAlive) } catch { $cellsAlive = $false }
        $cellsStale = $false
        try { $cellsStale = [bool](Test-ConvenienteCellsStale) } catch { $cellsStale = $false }
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
    $cellsAlive = $false
    try { $cellsAlive = [bool](Test-ConvenienteCellsAlive) } catch { $cellsAlive = $false }
    $cellsStale = $false
    try { $cellsStale = [bool](Test-ConvenienteCellsStale) } catch { $cellsStale = $false }
    if ($cellsAlive -and $cellsStale) {
        Write-StartLog 'cells_stale recycle'
        Write-Host ''
        Write-Host 'Codigo novo no disco (git pull). Encerrando celulas antigas para o worker novo valer.'
        Write-Host ''
        Stop-ConvenienteCells 'iniciar_stamp_stale'
        $cellsAlive = $false
        try { $cellsAlive = [bool](Test-ConvenienteCellsAlive) } catch { $cellsAlive = $false }
    }
    if ($cellsAlive) {
        Write-StartLog 'adopt_cells skip_chrome_kill skip_motor_boot'
        Write-Host ''
        Write-Host 'Células vivas detectadas. Subindo só o maestro (index). Chromes seguem.'
        Write-Host ''
    } else {
    Write-StartLog 'motores_begin'
    try {
        $hwndShow = [Native.Win]::GetConsoleWindow()
        if ($hwndShow -ne [IntPtr]::Zero) { [void][Native.Win]::ShowWindow($hwndShow, 1) }
    } catch {}
    Write-Host ''
    Write-Host 'CONVENIENTE — Chrome unico'
    Write-Host 'Fechando chrome.exe orfao e conferindo o Chrome oficial do Windows.'
    Write-Host 'Um chrome.exe para todos os workers. Sem clone em C:\conveniente\motores.'
    Write-Host 'Se o Chrome oficial nao existir, o index NAO sobe.'
    Write-Host ''
    & taskkill.exe /F /IM chrome.exe 1>$null 2>$null
    & taskkill.exe /F /IM crashpad_handler.exe 1>$null 2>$null
    Start-Sleep -Milliseconds 2500
    $mot = Start-Process -FilePath $node -ArgumentList @('C:\conveniente\scripts\chromeMotores.js', '--boot') -WorkingDirectory 'C:\conveniente' -Wait -PassThru -NoNewWindow
    if (-not $mot -or $mot.ExitCode -ne 0) {
        Write-StartLog ('motores_fatal exit=' + $(if ($mot) { $mot.ExitCode } else { 'null' }))
        Write-Host ''
        Write-Host 'CHROME_OFFICIAL_MISSING: Chrome do Windows ausente. Sistema NAO iniciou.' -ForegroundColor Red
        return 1
    }
    Write-StartLog 'motores_ok'
    Write-Host ''
    Write-Host 'Chrome unico ok. Subindo o Conveniente.'
    try {
        $hwndHide = [Native.Win]::GetConsoleWindow()
        if ($hwndHide -ne [IntPtr]::Zero) { [void][Native.Win]::ShowWindow($hwndHide, 0) }
    } catch {}
    }
    [void](Start-ConvenienteNodeHost -NodeExe $node -IndexPath $indexJs -WorkDir 'C:\conveniente')
    Write-StartLog 'started_node'
    return 0
}

Write-StartLog 'click'
$copied = $false
try { $copied = [bool](Copy-KitSilent) } catch { $copied = $false }
Ensure-LogonTaskSilent
# Node primeiro. Se o porteiro reciclar agora, o AUTO_BOOT ve already_up e nao abre 2a janela.
$code = Start-ConvenienteNode
[void](Wait-ConvenienteUp 4)
if ($copied) {
    Write-StartLog 'version_swap'
    Stop-LoopOnly
    Start-Sleep -Milliseconds 400
}
Start-LoopSilent
exit $code
