# Sobe o index Hidden. Sem janela. Sem texto de Ctrl+C.
# Fechar qualquer X nao mata o node: ele nao mora nesta janela.
# Parar: porteiro PARAR / update (taskkill no node).
$ErrorActionPreference = 'Continue'
$node = $null
try { $node = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$idx = 'C:\conveniente\index.js'
$work = 'C:\conveniente'
if (-not (Test-Path -LiteralPath $node)) { throw "node_missing: $node" }
if (-not (Test-Path -LiteralPath $idx)) { throw "index_missing: $idx" }

$p = Start-Process -FilePath $node -ArgumentList $idx -WorkingDirectory $work -WindowStyle Hidden -PassThru
if (-not $p) { throw 'node_start_failed' }
try { Wait-Process -Id $p.Id } catch {}

try { $p.Refresh() } catch {}
$ec = 0
try { $ec = [int]$p.ExitCode } catch { $ec = -1 }
$hex = 'na'
try { $hex = '0x' + ([uint32]($ec -band 0xffffffff)).ToString('X') } catch {}
$line = '{"ts":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + ',"iso":"' + (Get-Date).ToUniversalTime().ToString('o') + '","event":"index_host_exit","code":' + $ec + ',"hex":"' + $hex + '"}'
try {
    $dir = 'C:\conveniente\dados'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Add-Content -LiteralPath (Join-Path $dir 'index_host_exit.jsonl') -Value $line -Encoding UTF8
} catch {}
