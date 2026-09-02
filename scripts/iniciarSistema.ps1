# Clique Iniciar: arma o Porteiro se faltar, depois sobe o Conveniente.
# Fonte no git (nao depende do C:\auto_vigia estar atualizado).
# Ensure no MESMO processo do clique: senao o Windows engole o UAC.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ensure = Join-Path $here 'porteiroEnsure.ps1'
$destStart = 'C:\auto_vigia\manutencao.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

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

if (-not (Test-Path -LiteralPath $ensure)) {
    Write-Host '[ERRO] scripts\porteiroEnsure.ps1 ausente. Dê git pull em C:\conveniente.'
    exit 1
}

$ensureCode = & $ensure -ReturnOnly
if ($ensureCode -is [Array]) { $ensureCode = $ensureCode[-1] }
if ($null -eq $ensureCode) { $ensureCode = 0 }
$ensureCode = [int]$ensureCode

if (($ensureCode -ne 0) -and ($ensureCode -ne 10)) {
    Write-Host ''
    Write-Host 'Porteiro nao ficou 100%. Aceite o administrador e clique Iniciar de novo.'
    exit $ensureCode
}

if ($ensureCode -eq 10) {
    Write-Host 'Porteiro recem-armado. Esperando o Conveniente (AUTO_BOOT) pra nao abrir dois.'
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 1
        if (Test-ConvenienteUp) { break }
    }
}

if (-not (Test-Path -LiteralPath $destStart)) {
    Write-Host '[ERRO] C:\auto_vigia\manutencao.ps1 ausente apos o ensure.'
    exit 1
}

& $ps -NoProfile -ExecutionPolicy Bypass -File $destStart -Action start
$st = $LASTEXITCODE
if ($null -eq $st) { $st = 0 }
exit [int]$st
