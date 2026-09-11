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
Push-Location $wd
try {
    & $node $idx
} finally {
    Pop-Location
}
$ec = 0
try { $ec = [int]$LASTEXITCODE } catch { $ec = -1 }
$hex = 'na'
try { $hex = '0x' + ([uint32]($ec -band 0xffffffff)).ToString('X') } catch {}
$ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$iso = (Get-Date).ToUniversalTime().ToString('o')
$line = '{"ts":' + $ts + ',"iso":"' + $iso + '","event":"index_host_exit","role":"index_host","code":' + $ec + ',"hex":"' + $hex + '"}'
try {
    $dir = 'C:\conveniente\dados'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'index_host_exit.jsonl') -Value $line -Encoding UTF8
    Add-Content -LiteralPath (Join-Path $dir 'index_lifecycle.jsonl') -Value $line -Encoding UTF8
} catch {}
