# Host visivel do index. Usa apenas o Node pinado do projeto.
# Se o node morrer e esta janela ficar, grava o codigo.
# Se a janela sumir junto, nao grava — morte da arvore (X / sessao / taskkill).
param(
    [string]$NodeExe = '',
    [string]$IndexPath = 'C:\conveniente\index.js',
    [string]$WorkDir = 'C:\conveniente',
    [string]$BootSource = ''
)

$ErrorActionPreference = 'Continue'
try {
    $Host.UI.RawUI.WindowTitle = 'Conveniente_Node'
    [Console]::Title = 'Conveniente_Node'
} catch {}

$nodeRuntimePs1 = 'C:\conveniente\scripts\nodeRuntime.ps1'
try {
    if (Test-Path -LiteralPath $nodeRuntimePs1) {
        . $nodeRuntimePs1
    }
} catch {}

$node = [string]$NodeExe
if ([string]::IsNullOrWhiteSpace($node)) {
    if (-not (Get-Command Ensure-ConvenienteNodeRuntime -ErrorAction SilentlyContinue)) {
        try { Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_fail' -Data @{ Error = 'node_runtime_helper_missing'; Helper = $nodeRuntimePs1 } } catch {}
        throw "node_runtime_helper_missing: $nodeRuntimePs1"
    }
    $rt = Ensure-ConvenienteNodeRuntime
    if (-not $rt -or -not $rt.Ok) {
        try { Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_fail' -Data @{ Error = [string]$rt.Error; Helper = $nodeRuntimePs1 } } catch {}
        throw ("node_runtime_fail: " + [string]$rt.Error)
    }
    $node = [string]$rt.NodeExe
}

$idx = [string]$IndexPath
$wd = [string]$WorkDir
if (-not (Test-Path -LiteralPath $node)) {
    try { Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_fail' -Data @{ Error = 'node_missing'; NodeExe = $node; IndexPath = $idx } } catch {}
    throw "node_missing: $node"
}
if (-not (Test-Path -LiteralPath $idx)) {
    try { Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_fail' -Data @{ Error = 'index_missing'; NodeExe = $node; IndexPath = $idx } } catch {}
    throw "index_missing: $idx"
}
$ver = ''
try {
    $ver = [string](@(& $node -v 2>$null)[0])
    $ver = $ver.Trim()
} catch {
    $ver = ''
}
if ($ver -ne 'v20.20.2') {
    try { Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_fail' -Data @{ Error = 'node_version_unexpected'; NodeExe = $node; Version = $ver; WantedTag = 'v20.20.2'; IndexPath = $idx } } catch {}
    throw "node_version_unexpected: $ver wanted=v20.20.2 path=$node"
}
if (Get-Command Ensure-ConvenienteNpmModules -ErrorAction SilentlyContinue) {
    $mods = Ensure-ConvenienteNpmModules
    if (-not $mods -or -not $mods.Ok) {
        $why = [string]$mods.Error
        try { Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_fail' -Data @{ Error = 'npm_modules_fail'; Detail = $why; NodeExe = $node; IndexPath = $idx } } catch {}
        throw ("npm_modules_fail: " + $why)
    }
}
try {
    Write-ConvenienteNodeRuntimeEvent -Event 'node_runtime_host_launch' -Data @{ NodeExe = $node; Version = $ver; IndexPath = $idx; WorkDir = $wd }
} catch {}
if ([string]::IsNullOrWhiteSpace($BootSource)) {
    $env:CONVENIENTE_BOOT_SOURCE = 'porteiro'
} else {
    $env:CONVENIENTE_BOOT_SOURCE = [string]$BootSource
}
Write-Host ''
Write-Host 'Painel: http://localhost:8088/index.html'
Write-Host ''

$logDir = 'C:\conveniente\dados\logs'
try { New-Item -ItemType Directory -Path $logDir -Force | Out-Null } catch {}
$errLog = Join-Path $logDir 'crash_nativo_index.log'
$outLog = Join-Path $logDir 'crash_nativo_index.out.log'
$errPrev = Join-Path $logDir 'crash_nativo_index.prev.log'
$outPrev = Join-Path $logDir 'crash_nativo_index.out.prev.log'

function Move-NativeLogAside([string]$cur, [string]$prev) {
    if (-not (Test-Path -LiteralPath $cur)) { return }
    if (Test-Path -LiteralPath $prev) {
        $arch = Join-Path $logDir ((Split-Path -Leaf $cur) + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        try { Move-Item -LiteralPath $prev -Destination $arch -Force } catch {}
    }
    try { Move-Item -LiteralPath $cur -Destination $prev -Force } catch {}
}

function Format-ExitHex([int]$code) {
    try {
        $bytes = [BitConverter]::GetBytes([int32]$code)
        $u = [BitConverter]::ToUInt32($bytes, 0)
        return ('0x' + $u.ToString('X8'))
    } catch {
        return 'na'
    }
}

function Format-ExitName([int]$code) {
    $h = Format-ExitHex $code
    if ($h -eq '0xC0000409') { return 'FASTFAIL' }
    if ($h -eq '0xC0000374') { return 'HEAP_CORRUPT' }
    if ($h -eq '0xC000012D') { return 'COMMIT_LIMIT' }
    if ($h -eq '0xC00000FD') { return 'STACK_OVERFLOW' }
    if ($h -eq '0x80000003') { return 'WAIT_ABANDONED' }
    if ($code -eq 134) { return 'ABORT' }
    if ($code -eq 0) { return 'OK' }
    return 'OTHER'
}

try { Move-NativeLogAside $errLog $errPrev } catch {}
try { Move-NativeLogAside $outLog $outPrev } catch {}

Push-Location $wd
try {
    # PS 5.1 2>> no nativo vira NativeCommandError. cmd /c grava o stderr cru (Zone/heap/stack).
    # V8: --max-old-space-size=8192 no maestro. Sem isso a trava em index.js recusa o boot.
    # Janela do host continua visivel; a autopcia e o arquivo.
    cmd.exe /c "`"$node`" --max-old-space-size=8192 `"$idx`" 1>> `"$outLog`" 2>> `"$errLog`""
} finally {
    Pop-Location
}
$ec = 0
try { $ec = [int]$LASTEXITCODE } catch { $ec = -1 }
$hex = Format-ExitHex $ec
$codeName = Format-ExitName $ec
try {
    Write-Host ''
    Write-Host ('--- crash_nativo_index exit code=' + $ec + ' hex=' + $hex + ' name=' + $codeName + ' ---')
    if (Test-Path -LiteralPath $errLog) {
        Get-Content -LiteralPath $errLog -Tail 40 | ForEach-Object { Write-Host $_ }
    }
} catch {}
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$iso = (Get-Date).ToUniversalTime().ToString('o')
$line = '{"ts":' + $ts + ',"iso":"' + $iso + '","event":"index_host_exit","role":"index_host","code":' + $ec + ',"hex":"' + $hex + '","codeName":"' + $codeName + '"}'
try {
    $dir = 'C:\conveniente\dados'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'index_host_exit.jsonl') -Value $line -Encoding UTF8
    Add-Content -LiteralPath (Join-Path $dir 'index_lifecycle.jsonl') -Value $line -Encoding UTF8
} catch {}
