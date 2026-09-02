# Clique Iniciar: sobe o Conveniente. Arma o loop em silencio se faltar.
# Sem admin. Sem OK. Sem PowerShell visivel. Uma janela: Conveniente_Node.
# Armado = dest nomem + loop vivo. Hash/NetBoot NAO bloqueiam o clique.

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
    if ($t -notmatch 'v5\.2\.0-nomem') { return $false }
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
    Start-Sleep -Milliseconds 800
    if (Test-LoopAlive) {
        Write-StartLog 'loop_via_schtasks'
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
    $arg = "/c title Conveniente_Node & `"$node`" `"$indexJs`""
    Start-Process cmd.exe -ArgumentList $arg -WorkingDirectory 'C:\conveniente' -WindowStyle Minimized | Out-Null
    Write-StartLog 'started_node'
    return 0
}

Write-StartLog 'click'
$copied = $false
try { $copied = [bool](Copy-KitSilent) } catch { $copied = $false }
Ensure-LogonTaskSilent
if ($copied) {
    Write-StartLog 'version_swap'
    Stop-LoopOnly
    Start-Sleep -Milliseconds 400
}
Start-LoopSilent
$code = Start-ConvenienteNode
exit $code
