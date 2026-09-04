# Host Windows do Conveniente. Nao mexe em Robe/Virtus/frota.
# Sem UAC. Sem Wait no Iniciar. Falha local nunca impede o Node.
# WerSvc fica Manual: Disabled apaga dump de FastFail 0xC0000409 (WER reporta, nao causa).
# Chrome/node so do caminho C:\conveniente. Poll 5s (1ms queima CPU).

param(
    [switch]$Boot,
    [switch]$Apply,
    [switch]$Watch,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

if ($Boot) { $Apply = $true; $Watch = $true }
if (-not $Apply -and -not $Watch) { $Apply = $true; $Watch = $true }

$Root = 'C:\conveniente'
$LogDir = Join-Path $Root 'dados\logs'
$LogFile = Join-Path $LogDir 'windows_tuning.log'
$StateFile = Join-Path $LogDir 'windows_tuning.state.json'
$HeapBak = Join-Path $LogDir 'windows_subsystem_windows.bak'
$MutexName = 'Local\ConvenienteWinTuningWatch'
$PollSec = 5
$InteractiveHeapMinKb = 30720
$InteractiveHeapMaxKb = 65536
$UltimateGuid = 'e9a42b02-d5df-448d-aa00-03f14749eb61'
$HighPerfGuid = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'

function Test-IsAdmin {
    try {
        $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Write-TuneLog([string]$Line) {
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) {
            New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        }
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $LogFile -Value "$ts $Line" -Encoding ASCII
        $item = Get-Item -LiteralPath $LogFile -ErrorAction SilentlyContinue
        if ($item -and $item.Length -gt 1500000) {
            $bak = Join-Path $LogDir 'windows_tuning.prev.log'
            Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $LogFile -Destination $bak -Force
        }
    } catch {}
}

function Save-TuneState($Obj) {
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) {
            New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        }
        ($Obj | ConvertTo-Json -Compress) | Set-Content -LiteralPath $StateFile -Encoding UTF8
    } catch {}
}

function Get-ActiveSchemeGuid {
    try {
        $raw = (& powercfg.exe /getactivescheme 2>$null | Out-String)
        if ($raw -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
            return $Matches[1]
        }
    } catch {}
    return $null
}

function Invoke-Step([string]$Name, [scriptblock]$Body) {
    $row = [ordered]@{ name = $Name; ok = $false; skipped = $false; detail = '' }
    try {
        $r = & $Body
        if ($r -is [hashtable]) {
            foreach ($k in $r.Keys) { $row[$k] = $r[$k] }
        } elseif ($null -ne $r) {
            $row.detail = [string]$r
            $row.ok = $true
        } else {
            $row.ok = $true
        }
    } catch {
        $row.ok = $false
        $row.detail = [string]$_.Exception.Message
    }
    if (-not $row.detail) { $row.detail = '' }
    Write-TuneLog ('STEP ' + $row.name + ' ok=' + $row.ok + ' skip=' + $row.skipped + ' ' + $row.detail)
    return [pscustomobject]$row
}

function Set-HostServiceMitigated([string]$Name, [ValidateSet('Disabled','Manual')]$Startup) {
    if ($DryRun) { return @{ ok = $true; skipped = $true; detail = 'dryrun' } }
    $svc = Get-Service -Name $Name -ErrorAction Stop
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
    }
    Set-Service -Name $Name -StartupType $Startup -ErrorAction Stop
    $after = Get-Service -Name $Name -ErrorAction Stop
    return @{
        ok = ($after.StartType.ToString() -eq $Startup)
        detail = ('state=' + $after.Status + ' start=' + $after.StartType)
    }
}

function Set-PowerPlanMax {
    if ($DryRun) { return @{ ok = $true; skipped = $true; detail = 'dryrun' } }
    & powercfg.exe -duplicatescheme $UltimateGuid 1>$null 2>$null
    & powercfg.exe /setactive $UltimateGuid 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        & powercfg.exe /setactive $HighPerfGuid 1>$null 2>$null
    }
    $guid = Get-ActiveSchemeGuid
    if (-not $guid) { return @{ ok = $false; detail = 'scheme_unknown' } }
    foreach ($pair in @(
        @('/change', 'monitor-timeout-ac', '0'),
        @('/change', 'monitor-timeout-dc', '0'),
        @('/change', 'disk-timeout-ac', '0'),
        @('/change', 'disk-timeout-dc', '0'),
        @('/change', 'standby-timeout-ac', '0'),
        @('/change', 'standby-timeout-dc', '0'),
        @('/change', 'hibernate-timeout-ac', '0'),
        @('/change', 'hibernate-timeout-dc', '0')
    )) {
        & powercfg.exe @pair 1>$null 2>$null
    }
    & powercfg.exe /hibernate off 1>$null 2>$null
    & powercfg.exe /setacvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMIN 100 1>$null 2>$null
    & powercfg.exe /setacvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMAX 100 1>$null 2>$null
    & powercfg.exe /setdcvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMIN 100 1>$null 2>$null
    & powercfg.exe /setdcvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMAX 100 1>$null 2>$null
    & powercfg.exe /setactive $guid 1>$null 2>$null
    return @{ ok = $true; detail = ('scheme=' + $guid) }
}

function Set-DesktopHeapIfNeeded {
    $key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\SubSystems'
    $raw = [string](Get-ItemProperty -LiteralPath $key -Name Windows -ErrorAction Stop).Windows
    if ([string]::IsNullOrWhiteSpace($raw)) { return @{ ok = $false; detail = 'windows_value_empty' } }
    if ($raw -notmatch 'SharedSection=(\d+),(\d+),(\d+)') {
        return @{ ok = $false; skipped = $true; detail = 'sharedsection_pattern_absent' }
    }
    $a = [int]$Matches[1]
    $b = [int]$Matches[2]
    $c = [int]$Matches[3]
    $targetB = $b
    if ($targetB -lt $InteractiveHeapMinKb) { $targetB = $InteractiveHeapMinKb }
    if ($targetB -gt $InteractiveHeapMaxKb) { $targetB = $InteractiveHeapMaxKb }
    if ($b -ge $targetB) {
        return @{ ok = $true; skipped = $true; detail = ('already=' + $a + ',' + $b + ',' + $c) }
    }
    if ($DryRun) { return @{ ok = $true; skipped = $true; detail = ('dryrun ' + $b + '->' + $targetB) } }
    if (-not (Test-Path -LiteralPath $HeapBak)) {
        Set-Content -LiteralPath $HeapBak -Value $raw -Encoding Unicode
    }
    $new = [regex]::Replace($raw, 'SharedSection=\d+,\d+,\d+', ('SharedSection=' + $a + ',' + $targetB + ',' + $c), 1)
    if ($new -eq $raw -or $new -notmatch 'csrss\.exe' -or $new -notmatch 'SharedSection=') {
        return @{ ok = $false; detail = 'replace_refused' }
    }
    Set-ItemProperty -LiteralPath $key -Name Windows -Value $new -ErrorAction Stop
    $read = [string](Get-ItemProperty -LiteralPath $key -Name Windows -ErrorAction Stop).Windows
    $ok = $read -match ('SharedSection=' + $a + ',' + $targetB + ',' + $c)
    return @{
        ok = [bool]$ok
        detail = ('heap ' + $b + '->' + $targetB + ' reboot_required=1')
    }
}

function Test-ConvenienteNodeCmd([string]$Cmd) {
    $c = [string]$Cmd
    if ([string]::IsNullOrWhiteSpace($c)) { return $false }
    if ($c -match 'winTuningMaster\.ps1|iniciarSistema\.ps1|manutencao\.ps1|porteiroEnsure\.ps1|sitechatbot') { return $false }
    $low = $c.ToLowerInvariant()
    if ($low -notmatch 'conveniente') { return $false }
    return ($low -match 'index\.js' -or $low -match 'scripts\\worker\.js')
}

function Test-ConvenienteChromeCmd([string]$Cmd) {
    $c = [string]$Cmd
    if ([string]::IsNullOrWhiteSpace($c)) { return $false }
    $low = $c.ToLowerInvariant()
    return ($low -match 'c:\\conveniente')
}

function Set-ProcPriority([int]$ProcId, [string]$Class) {
    if ($ProcId -le 0) { return $false }
    if ($DryRun) { return $true }
    $p = Get-Process -Id $ProcId -ErrorAction Stop
    $want = [System.Diagnostics.ProcessPriorityClass]::$Class
    if ($p.PriorityClass -eq $want) { return $true }
    $p.PriorityClass = $want
    return $true
}

function Apply-ImagePriorities {
    $nNode = 0
    $nChrome = 0
    $nRdp = 0
    foreach ($row in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        try {
            if (-not (Test-ConvenienteNodeCmd ([string]$row.CommandLine))) { continue }
            if (Set-ProcPriority ([int]$row.ProcessId) 'High') { $nNode++ }
        } catch {}
    }
    foreach ($row in @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue)) {
        try {
            if (-not (Test-ConvenienteChromeCmd ([string]$row.CommandLine))) { continue }
            if (Set-ProcPriority ([int]$row.ProcessId) 'High') { $nChrome++ }
        } catch {}
    }
    foreach ($name in @('mstsc.exe', 'rdpclip.exe')) {
        $filter = "Name='$name'"
        foreach ($row in @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue)) {
            try {
                if (Set-ProcPriority ([int]$row.ProcessId) 'High') { $nRdp++ }
            } catch {}
        }
    }
    try {
        $term = Get-CimInstance Win32_Service -Filter "Name='TermService'" -ErrorAction SilentlyContinue
        if ($term -and [int]$term.ProcessId -gt 0) {
            if (Set-ProcPriority ([int]$term.ProcessId) 'High') { $nRdp++ }
        }
    } catch {}
    return @{
        ok = $true
        detail = ('node=' + $nNode + ' chrome=' + $nChrome + ' rdp=' + $nRdp)
        node = $nNode
        chrome = $nChrome
        rdp = $nRdp
    }
}

function Start-WatchLoop {
    $created = $false
    $mutex = $null
    try {
        $mutex = New-Object System.Threading.Mutex($false, $MutexName)
        if (-not $mutex.WaitOne(0, $false)) {
            Write-TuneLog 'WATCH already_running'
            return
        }
        $created = $true
        Write-TuneLog ('WATCH start pollSec=' + $PollSec)
        while ($true) {
            try { [void](Apply-ImagePriorities) } catch {}
            Start-Sleep -Seconds $PollSec
        }
    } catch {
        Write-TuneLog ('WATCH fail ' + $_.Exception.Message)
    } finally {
        if ($created -and $mutex) {
            try { $mutex.ReleaseMutex() | Out-Null } catch {}
        }
        if ($mutex) { try { $mutex.Dispose() } catch {} }
    }
}

$admin = Test-IsAdmin
Write-TuneLog ('BEGIN boot=' + [int][bool]$Boot + ' apply=' + [int][bool]$Apply + ' watch=' + [int][bool]$Watch + ' dry=' + [int][bool]$DryRun + ' admin=' + [int]$admin + ' host=' + $env:COMPUTERNAME)

$steps = @()
if ($Apply) {
    if ($admin) {
        $steps += Invoke-Step 'diagtrack' { Set-HostServiceMitigated 'DiagTrack' 'Disabled' }
        $steps += Invoke-Step 'sysmain' { Set-HostServiceMitigated 'SysMain' 'Disabled' }
        $steps += Invoke-Step 'wersvc' { Set-HostServiceMitigated 'WerSvc' 'Manual' }
        $steps += Invoke-Step 'power' { Set-PowerPlanMax }
        $steps += Invoke-Step 'desktop_heap' { Set-DesktopHeapIfNeeded }
    } else {
        $steps += Invoke-Step 'admin_gate' { @{ ok = $true; skipped = $true; detail = 'sem_admin servicos/energia/heap adiados' } }
        $steps += Invoke-Step 'power_best_effort' { Set-PowerPlanMax }
    }
    $steps += Invoke-Step 'priority_once' { Apply-ImagePriorities }
}

$fail = @($steps | Where-Object { $_.ok -ne $true -and $_.skipped -ne $true }).Count
$okStamp = ($fail -eq 0)
$stamp = if ($okStamp) { '[TUNING_OK]' } else { '[TUNING_PARTIAL]' }
$heapNote = ''
try {
    $h = @($steps | Where-Object { $_.name -eq 'desktop_heap' } | Select-Object -First 1)
    if ($h -and $h.detail) { $heapNote = [string]$h.detail }
} catch {}
Write-TuneLog ($stamp + ' Windows host tuning. DiagTrack/SysMain mitigados se admin. WerSvc=Manual (dump FastFail preservado). Energia High/Ultimate + disco/hibernar 0. ' + $heapNote + ' Prioridade High: RDP + node Conveniente + chrome Conveniente.')

Save-TuneState @{
    ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    iso = [DateTime]::UtcNow.ToString('o')
    host = $env:COMPUTERNAME
    admin = $admin
    dryRun = [bool]$DryRun
    stamp = $stamp
    steps = $steps
}

if ($Watch -and -not $DryRun) {
    Start-WatchLoop
}

if ($DryRun) { exit 0 }
exit 0
