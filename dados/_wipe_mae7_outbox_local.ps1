# Rode NA MAE7 com o node PARADO (Ctrl+C no terminal do index.js).
# Arquiva outbox.jsonl gordo, zera cursor, puxa o fix e sobe de novo.
$ErrorActionPreference = "Stop"
$root = "C:\conveniente"
$dir = Join-Path $root "dados\edge_delta_reply"
$ts = Get-Date -Format "yyyyMMdd_HHmmss"

if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$outbox = Join-Path $dir "outbox.jsonl"
$cursor = Join-Path $dir "cursor.json"
if (Test-Path $outbox) {
  $size = (Get-Item $outbox).Length
  Write-Host "outbox size_bytes=$size"
  Move-Item -Force $outbox (Join-Path $dir "outbox.BAK_$ts.jsonl")
} else {
  Write-Host "outbox ausente"
}
Set-Content -Path $outbox -Value "" -NoNewline -Encoding utf8
Set-Content -Path $cursor -Value '{"offset":0}' -NoNewline -Encoding utf8
Write-Host "outbox+cursor zerados"

Set-Location $root
git pull --ff-only
Write-Host "OK. Agora: node index.js  -> abra so ponta_grossa -> espere HANDS no thread 2233419924155897 e log 🟢"
