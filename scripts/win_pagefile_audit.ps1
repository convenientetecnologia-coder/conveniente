param(
  [switch]$EnableSystemManaged
)

Write-Host ""
Write-Host "==============================="
Write-Host " PAGEFILE / COMMIT AUDIT (WIN10)"
Write-Host "==============================="
Write-Host ""

try {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
} catch {
  Write-Host "ERRO: Não foi possível ler Win32_OperatingSystem/ComputerSystem: $($_.Exception.Message)"
  exit 1
}

$freePhysMB  = [math]::Round(($os.FreePhysicalMemory / 1024))
$totalPhysMB = [math]::Round(($os.TotalVisibleMemorySize / 1024))
$freeVirtMB  = [math]::Round(($os.FreeVirtualMemory / 1024))
$totalVirtMB = [math]::Round(($os.TotalVirtualMemorySize / 1024))
$pagefileMB = $totalVirtMB - $totalPhysMB
$hasPagefile = ($pagefileMB -gt 256)

Write-Host ("ComputerName: " + $env:COMPUTERNAME)
Write-Host ("AutomaticManagedPagefile: " + $cs.AutomaticManagedPagefile)
Write-Host ("TotalPhysMB: {0} | FreePhysMB: {1}" -f $totalPhysMB, $freePhysMB)
Write-Host ("CommitLimitMB(totalVirt): {0} | CommitFreeMB(freeVirt): {1}" -f $totalVirtMB, $freeVirtMB)
Write-Host ("PagefileMB(approx): {0} | HasPagefile: {1}" -f $pagefileMB, $hasPagefile)
Write-Host ""

try {
  $pfs = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue
  if ($pfs) {
    Write-Host "Win32_PageFileSetting:"
    $pfs | Format-List *
    Write-Host ""
  } else {
    Write-Host "Win32_PageFileSetting: (nenhum)"
    Write-Host ""
  }
} catch {}

try {
  $pfu = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue
  if ($pfu) {
    Write-Host "Win32_PageFileUsage:"
    $pfu | Format-List *
    Write-Host ""
  } else {
    Write-Host "Win32_PageFileUsage: (nenhum)"
    Write-Host ""
  }
} catch {}

if ($EnableSystemManaged) {
  Write-Host ">>> AÇÃO: Habilitando PAGEFILE System Managed..."
  try {
    # WMIC ainda funciona no Windows 10 (apesar de deprecated)
    wmic computersystem where name="%computername%" set AutomaticManagedPagefile=True | Out-Host
    Write-Host ""
    Write-Host "OK. REBOOT OBRIGATÓRIO PARA APLICAR."
  } catch {
    Write-Host "ERRO ao habilitar AutomaticManagedPagefile via WMIC: $($_.Exception.Message)"
    exit 2
  }
}

