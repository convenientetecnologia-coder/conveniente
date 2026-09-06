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

function Write-StartLog([string]$Line) {
    try {
        New-Item -ItemType Directory -Path (Split-Path $logFile) -Force | Out-Null
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $logFile -Value "$ts INICIAR $Line" -Encoding ASCII
    } catch {}
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
    for ($i = 0; $i -lt 8; $i++) {
        Start-Sleep -Milliseconds 400
        if (Test-LoopAlive) {
            Write-StartLog 'loop_via_schtasks'
            return
        }
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

function Start-ConvenienteNodeHost {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExe,
        [Parameter(Mandatory = $true)][string]$IndexPath,
        [Parameter(Mandatory = $true)][string]$WorkDir
    )
    $hostPs1 = 'C:\conveniente\scripts\convenienteNodeHost.ps1'
    $arg = '-NoExit -NoProfile -ExecutionPolicy Bypass -File "' + $hostPs1 + '"'
    return Start-Process -FilePath $ps -ArgumentList $arg -WorkingDirectory $WorkDir -WindowStyle Normal -PassThru
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

function Start-ConvenienteNode {
    if (Test-ConvenienteUp) {
        Write-StartLog 'already_up'
        return 0
    }
    try {
        if (Test-Path -LiteralPath $pauseFlag) { Remove-Item -LiteralPath $pauseFlag -Force -ErrorAction SilentlyContinue }
    } catch {}
    if (-not (Test-Path -LiteralPath $indexJs)) {
        Write-StartLog 'index_missing'
        return 1
    }
    $node = $null
    try { $node = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}
    if (-not $node) {
        Write-StartLog 'node_missing'
        return 1
    }
    [void](Stop-ConvenienteConsoleHosts)
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
