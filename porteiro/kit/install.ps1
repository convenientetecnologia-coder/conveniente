# install.ps1 - plug and play v5.2.0-nomem (MemClean=OFF)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$Kit = $PSScriptRoot
$Dest = 'C:\auto_vigia'
$Task = 'ConvenientePorteiro'
$TaskNet = 'ConvenienteNetBoot'
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

Write-Host '=== SETUP v5.2.0-nomem ==='

if (-not (Test-Path 'C:\conveniente\index.js')) {
    Write-Host '[ERRO] C:\conveniente\index.js nao encontrado'
    exit 1
}

New-Item -ItemType Directory -Path $Dest -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Dest 'logs') -Force | Out-Null

Write-Host '[1] Limpando processos antigos...'
if (Test-Path (Join-Path $Dest 'porteiro.lock')) {
    try {
        $old = [int]((Get-Content (Join-Path $Dest 'porteiro.lock') -Raw).Trim())
        if ($old -gt 0) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue }
    } catch {}
    Remove-Item (Join-Path $Dest 'porteiro.lock') -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and ($_.CommandLine -match 'porteiro_loop\.ps1|manutencao\.ps1 -Action loop|manutencao\.ps1" -Action loop|manutencao\.ps1 -Action netboot|auto_vigia\\vigia\.bat')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

@(
    'vigia.bat','porteiro_loop.ps1','node_control.ps1','node_control_cli.ps1',
    'lib_metrics.ps1','lib_system.ps1','limpeza_disco.ps1','limpeza_memoria.ps1',
    'iniciar_sistema.bat','parar_sistema.bat','status_sistema.bat','aplicar_agora.ps1'
) | ForEach-Object {
    $p = Join-Path $Dest $_
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

Write-Host '[2] Instalando C:\auto_vigia\manutencao.ps1 ...'
Copy-Item (Join-Path $Kit 'manutencao.ps1') (Join-Path $Dest 'manutencao.ps1') -Force
$hash = (Get-FileHash (Join-Path $Dest 'manutencao.ps1') -Algorithm MD5).Hash.Substring(0,8)
Write-Host "  OK hash=$hash"

# Se instalar FORA da janela 04:00-04:20, marca o dia como ja tratado
# (evita reboot surpresa no Setup de tarde/noite)
try {
    $now = Get-Date
    $winStart = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 4 -Minute 0 -Second 0
    $winEnd = $winStart.AddMinutes(20)
    if ($now -lt $winStart -or $now -ge $winEnd) {
        $estPath = Join-Path $Dest 'estado.json'
        $st = $null
        if (Test-Path $estPath) { try { $st = Get-Content $estPath -Raw | ConvertFrom-Json } catch {} }
        if (-not $st) { $st = [pscustomobject]@{} }
        $st | Add-Member -NotePropertyName lastRebootDailyDate -NotePropertyValue $now.ToString('yyyy-MM-dd') -Force
        $st | Add-Member -NotePropertyName pendingNetworkCheck -NotePropertyValue $false -Force
        $st | Add-Member -NotePropertyName lastAction -NotePropertyValue 'install_skip_reboot_fora_janela' -Force
        ($st | ConvertTo-Json -Compress) | Set-Content $estPath -Encoding UTF8
        Write-Host '  OK: fora da janela 04:00 - sem reboot no Setup'
    }
} catch {}

@(
    @{ n = 'PARAR.bat'; a = 'stop' },
    @{ n = 'INICIAR.bat'; a = 'start' },
    @{ n = 'STATUS.bat'; a = 'status' }
) | ForEach-Object {
    "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action $($_.a)`r`npause`r`n" |
        Set-Content (Join-Path $Dest $_.n) -Encoding ASCII
}

Write-Host '[3] Desempenho Maximo...'
foreach ($g in @('808ffb3b-6e1f-4fb0-910c-53827e1f97ca','8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c')) {
    & powercfg /setactive $g 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  power OK"; break }
}

Write-Host '[4] Tarefas (logon + netboot no startup)...'
Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
Unregister-ScheduledTask -TaskName $TaskNet -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
& schtasks.exe /delete /tn LimpezaAutomaticaConveniente /f 2>$null | Out-Null
& schtasks.exe /delete /tn $TaskNet /f 2>$null | Out-Null

$okTask = $false
$okNet = $false
try {
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action loop"
    $action = New-ScheduledTaskAction -Execute $PsExe -Argument $arg
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -DontStopOnIdleEnd -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    $okTask = $true
    Write-Host "  OK $Task (ao logon)"
} catch {
    $tr = "$PsExe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action loop"
    & schtasks.exe /create /tn $Task /tr $tr /sc onlogon /rl highest /f 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $okTask = $true
        Write-Host "  OK $Task (schtasks)"
    } else {
        Write-Host '  [!] Rode o Setup como ADMIN para gravar a tarefa ao logon'
    }
}

# NetBoot: sobe no STARTUP como SYSTEM — checa rede em TODO boot (nao so apos reboot diario)
try {
    $argNet = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action netboot"
    $actionNet = New-ScheduledTaskAction -Execute $PsExe -Argument $argNet
    $triggerNet = New-ScheduledTaskTrigger -AtStartup
    $triggerNet.Delay = 'PT1M'
    $principalNet = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settingsNet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskNet -Action $actionNet -Trigger $triggerNet -Principal $principalNet -Settings $settingsNet -Force -ErrorAction Stop | Out-Null
    $okNet = $true
    Write-Host "  OK $TaskNet (startup SYSTEM - retry rede)"
} catch {
    $trNet = "$PsExe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action netboot"
    & schtasks.exe /create /tn $TaskNet /tr $trNet /sc onstart /ru SYSTEM /rl highest /delay 0001:00 /f 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $okNet = $true
        Write-Host "  OK $TaskNet (schtasks)"
    } else {
        Write-Host '  [!] Nao criou ConvenienteNetBoot - rode Setup como ADMIN'
    }
}

Write-Host '[4b] Tarefa ConvenienteDiskClean (SYSTEM, on-demand)...'
& $PsExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dest 'manutencao.ps1') -Action ensure_diskclean
if ($LASTEXITCODE -eq 0) { Write-Host '  OK ConvenienteDiskClean' }
else { Write-Host '  [!] ConvenienteDiskClean pode precisar de Setup como Admin' }

Write-Host '[5] Atalhos Desktop...'
$desk = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
foreach ($x in @(
    @{ n = 'PARAR_SISTEMA.lnk'; a = 'stop' },
    @{ n = 'INICIAR_SISTEMA.lnk'; a = 'start' },
    @{ n = 'STATUS_SISTEMA.lnk'; a = 'status' }
)) {
    $sc = $sh.CreateShortcut((Join-Path $desk $x.n))
    $sc.TargetPath = $PsExe
    $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action $($x.a)"
    $sc.WorkingDirectory = $Dest
    $sc.Save()
    Write-Host "  $($x.n)"
}
foreach ($old in @('PORTEIRO_REDECOLAR.lnk','REDECOLAR_SISTEMA.lnk')) {
    $p = Join-Path $desk $old
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

Write-Host '[6] Iniciando porteiro v5.2.0-nomem...'
Start-Process $PsExe -ArgumentList '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File','C:\auto_vigia\manutencao.ps1','-Action','loop' -WindowStyle Hidden
Start-Sleep 2

Write-Host ''
Write-Host '=== PRONTO ==='
Write-Host 'STATUS: Ver=v5.2.0-nomem | MemClean=OFF | RebootDaily=04:00-04:20 | NetGuard=4min+4testes | NetBoot=ConvenienteNetBoot | AutoStartAposBoot=SIM'
Write-Host 'So isso: PARAR / INICIAR / STATUS'
Write-Host 'Arquivo unico: C:\auto_vigia\manutencao.ps1'
& $PsExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dest 'manutencao.ps1') -Action status
if (-not $okTask) { Write-Host '[AVISO] Tarefa ao logon pode precisar de Setup como Admin' }
if (-not $okNet) { Write-Host '[AVISO] ConvenienteNetBoot pode precisar de Setup como Admin' }
