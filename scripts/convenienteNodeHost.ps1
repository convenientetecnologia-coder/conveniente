# Janela visivel. O node NAO mora nesta janela.
# Fechar o X nao mata o index.
# Ctrl+C: para o index e a arvore (mesmo gesto de antanho no node index.js).
$ErrorActionPreference = 'Continue'
try {
    $Host.UI.RawUI.WindowTitle = 'Conveniente_Node'
    [Console]::Title = 'Conveniente_Node'
} catch {}
$node = $null
try { $node = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$idx = 'C:\conveniente\index.js'
$work = 'C:\conveniente'
if (-not (Test-Path -LiteralPath $node)) { throw "node_missing: $node" }
if (-not (Test-Path -LiteralPath $idx)) { throw "index_missing: $idx" }

try {
    Write-Host 'Conveniente no ar.'
    Write-Host 'Ctrl+C para o sistema. Fechar o X nao para.'
} catch {}

$p = Start-Process -FilePath $node -ArgumentList $idx -WorkingDirectory $work -WindowStyle Hidden -PassThru
if (-not $p) { throw 'node_start_failed' }

function Stop-ConvenienteNodeTree([int]$PidToKill) {
    if ($PidToKill -le 0) { return }
    try { & taskkill.exe /F /T /PID $PidToKill 2>$null | Out-Null } catch {}
}

$treatOk = $false
try {
    [Console]::TreatControlCAsInput = $true
    $treatOk = $true
} catch {}

if ($treatOk) {
    while ($p -and -not $p.HasExited) {
        Start-Sleep -Milliseconds 250
        try { $p.Refresh() } catch {}
        if ($p.HasExited) { break }
        $hit = $false
        try { $hit = [Console]::KeyAvailable } catch { $hit = $false }
        if (-not $hit) { continue }
        $k = $null
        try { $k = [Console]::ReadKey($true) } catch { $k = $null }
        if (-not $k) { continue }
        $isCtrlC = ($k.Key -eq 'C' -and (($k.Modifiers -band [ConsoleModifiers]::Control) -eq [ConsoleModifiers]::Control))
        if ($isCtrlC) {
            try { Write-Host 'Ctrl+C: parando o Conveniente...' } catch {}
            Stop-ConvenienteNodeTree ([int]$p.Id)
            break
        }
    }
} else {
    try { Wait-Process -Id $p.Id } catch {}
}

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
