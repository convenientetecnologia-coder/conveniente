# Clique Iniciar: arma o Porteiro se faltar, depois sobe o Conveniente.
# Se faltar admin: relanca ESTE script com UAC ANTES do check lento.
# O .bat/CMD come o "clique"; um OK na cara restaura o direito de pedir SIM.
param(
    [switch]$AlreadyElevated
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ensure = Join-Path $here 'porteiroEnsure.ps1'
$destStart = 'C:\auto_vigia\manutencao.ps1'
$kitSrc = 'C:\conveniente\porteiro\kit\manutencao.ps1'
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

function Test-NeedAdminFast {
    if (-not (Test-Path -LiteralPath $kitSrc)) { return $true }
    if (-not (Test-Path -LiteralPath $destStart)) { return $true }
    try {
        $a = (Get-FileHash -LiteralPath $kitSrc -Algorithm MD5).Hash
        $b = (Get-FileHash -LiteralPath $destStart -Algorithm MD5).Hash
        if ($a -ne $b) { return $true }
    } catch {
        return $true
    }
    & schtasks.exe /Query /TN 'ConvenienteNetBoot' 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { return $true }
    & schtasks.exe /Query /TN 'ConvenientePorteiro' 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { return $true }
    return $false
}

function Request-AdminRelaunch {
    Write-Host 'Porteiro incompleto. Clique OK, depois SIM na janela do Windows.'
    try {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        [void][System.Windows.Forms.MessageBox]::Show(
            'Clique OK. Na proxima tela o Windows pede administrador. Clique SIM.',
            'Porteiro',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
    } catch {
        Start-Sleep -Milliseconds 200
    }
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -AlreadyElevated"
    try {
        $p = Start-Process -FilePath $ps -Verb RunAs -Wait -PassThru -WindowStyle Normal -WorkingDirectory $env:SystemRoot -ArgumentList $arg
    } catch {
        Write-Host '[ERRO] Admin recusado. Clique Iniciar de novo e aceite.'
        return 3
    }
    if ($null -eq $p) { return 3 }
    return [int]$p.ExitCode
}

if (-not $AlreadyElevated) {
    if (Test-NeedAdminFast) {
        $rc = Request-AdminRelaunch
        exit $rc
    }
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

& $destStart -Action start
$st = $LASTEXITCODE
if ($null -eq $st) { $st = 0 }
exit [int]$st
