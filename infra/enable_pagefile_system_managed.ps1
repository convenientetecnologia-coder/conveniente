# enable_pagefile_system_managed.ps1
# Executar como ADMIN. Requer REBOOT para efeito total.

Write-Host "Habilitando Pagefile (System Managed)..." -ForegroundColor Cyan

$cs = Get-CimInstance Win32_ComputerSystem
Write-Host ("Antes: AutomaticManagedPagefile=" + $cs.AutomaticManagedPagefile)

# Habilitar gerenciamento automático
wmic computersystem where name="%computername%" set AutomaticManagedPagefile=True | Out-Null

$cs2 = Get-CimInstance Win32_ComputerSystem
Write-Host ("Depois: AutomaticManagedPagefile=" + $cs2.AutomaticManagedPagefile)

$os = Get-CimInstance Win32_OperatingSystem
$freePhysMB = [math]::Round(($os.FreePhysicalMemory / 1024))
$totalPhysMB = [math]::Round(($os.TotalVisibleMemorySize / 1024))
$freeVirtMB = [math]::Round(($os.FreeVirtualMemory / 1024))
$totalVirtMB = [math]::Round(($os.TotalVirtualMemorySize / 1024))
$pagefileMB = $totalVirtMB - $totalPhysMB

Write-Host ("Mem Fisica:  total=" + $totalPhysMB + "MB free=" + $freePhysMB + "MB")
Write-Host ("Mem Virtual: total=" + $totalVirtMB + "MB free=" + $freeVirtMB + "MB pagefile~=" + $pagefileMB + "MB")

Write-Host "OK. Reinicie o Windows para aplicar completamente." -ForegroundColor Yellow

