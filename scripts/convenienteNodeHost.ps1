# Host visivel do index. Se o node morrer e esta janela ficar, grava o codigo.
# Se a janela sumir junto, nao grava — morte da arvore (X / sessao / taskkill).
param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$IndexPath
)
$ErrorActionPreference = 'Continue'
try {
    $Host.UI.RawUI.WindowTitle = 'Conveniente_Node'
    [Console]::Title = 'Conveniente_Node'
} catch {}
& $NodeExe $IndexPath
$ec = 0
try { $ec = [int]$LASTEXITCODE } catch { $ec = -1 }
$hex = 'na'
try { $hex = '0x' + ([uint32]($ec -band 0xffffffff)).ToString('X') } catch {}
$line = '{"ts":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"iso":"' + (Get-Date).ToUniversalTime().ToString('o') + '","event":"index_host_exit","code":' + $ec + ',"hex":"' + $hex + '"}'
try {
    $dir = 'C:\conveniente\dados'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'index_host_exit.jsonl') -Value $line -Encoding UTF8
} catch {}
