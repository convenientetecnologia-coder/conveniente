# Host visivel do index. Resolve o node sozinho (Program Files tem espaco).
# Se o node morrer e esta janela ficar, grava o codigo.
# Se a janela sumir junto, nao grava — morte da arvore (X / sessao / taskkill).
$ErrorActionPreference = 'Continue'
try {
    $Host.UI.RawUI.WindowTitle = 'Conveniente_Node'
    [Console]::Title = 'Conveniente_Node'
} catch {}
$node = $null
try { $node = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$idx = 'C:\conveniente\index.js'
if (-not (Test-Path -LiteralPath $node)) { throw "node_missing: $node" }
if (-not (Test-Path -LiteralPath $idx)) { throw "index_missing: $idx" }
& $node $idx
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
