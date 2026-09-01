# Instala / atualiza o Porteiro em C:\auto_vigia SEM limpador de RAM no loop.
# Fonte: C:\conveniente\porteiro\kit\
# Reboot 04:00, TEMP+Lixeira, AUTO_BOOT, NetGuard: mantidos.
# StandbyList: tarefa SYSTEM ConvenienteDiskClean (o loop NAO dispara).
# Dono do relogio: Conveniente chromeMemorySweep.js
#
# Uso (admin via UAC):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\conveniente\instalar_porteiro.ps1
#
# NAO mata o Node do Conveniente (nao chama Do-Stop). So recicla o loop do porteiro.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$install = Join-Path $here 'porteiro\kit\install.ps1'

if (-not (Test-Path -LiteralPath $install)) {
    Write-Host "[ERRO] kit ausente: $install"
    exit 1
}
if (-not (Test-Path -LiteralPath 'C:\conveniente\index.js')) {
    Write-Host '[ERRO] C:\conveniente\index.js nao encontrado. Clone o Conveniente primeiro.'
    exit 1
}

$kitPs1 = Join-Path $here 'porteiro\kit\manutencao.ps1'
$kitTxt = Get-Content -LiteralPath $kitPs1 -Raw -ErrorAction Stop
if ($kitTxt -match 'Invoke-SoftMemClean' -or $kitTxt -match '\bmem_soft\b' -or $kitTxt -match "ArgumentList '/StandbyList'") {
    Write-Host '[ERRO] kit ainda tem limpador de RAM no loop. Recuse instalar. Avise o agente.'
    exit 2
}
if ($kitTxt -match 'Start-Process[\s\S]{0,240}DiskClean\.exe') {
    Write-Host '[ERRO] kit ainda spawna DiskClean no loop. Recuse instalar. Avise o agente.'
    exit 2
}
if ($kitTxt -notmatch 'v5\.2\.0-nomem') {
    Write-Host '[ERRO] kit sem versao v5.2.0-nomem. Recuse instalar.'
    exit 2
}
if ($kitTxt -notmatch 'ConvenienteDiskClean' -or $kitTxt -notmatch 'function Ensure-DiskCleanTask') {
    Write-Host '[ERRO] kit sem tarefa ConvenienteDiskClean. Recuse instalar.'
    exit 2
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
    Write-Host '[ADMIN] Pedindo administrador para gravar tarefas ConvenientePorteiro / ConvenienteNetBoot...'
    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
        -Verb RunAs -Wait -PassThru `
        -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    if ($p -and $p.ExitCode -ne 0) { exit $p.ExitCode }
    exit 0
}

Write-Host '=== instalar_porteiro.ps1 (v5.2.0-nomem, MemClean=OFF) ==='
& $install
exit $LASTEXITCODE
