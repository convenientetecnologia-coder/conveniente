# Martelo da queda: Windows + modulo + commit + WER + dump.
# Nao mata processo. Nao puxa Security. Nao mede CPU. Roda rapido.
param(
    [string]$Reason = 'manual',
    [string]$DropsCsv = '',
    [int]$Minutes = 20
)

$ErrorActionPreference = 'SilentlyContinue'
if ($Minutes -lt 2) { $Minutes = 2 }
if ($Minutes -gt 180) { $Minutes = 180 }

$Dados = 'C:\conveniente\dados'
$DumpDir = Join-Path $Dados 'crash_dumps'
$Jsonl = Join-Path $Dados 'crash_hammer.jsonl'
$Last = Join-Path $Dados 'crash_hammer_last.json'
$since = (Get-Date).AddMinutes(-$Minutes)

function As-Array($list) {
    if ($null -eq $list) { return @() }
    try { return @($list.ToArray()) } catch {}
    $out = @()
    foreach ($x in $list) { $out += $x }
    return ,$out
}

function Clip-Text([string]$s, [int]$n) {
    if (-not $s) { return '' }
    if ($s.Length -le $n) { return $s }
    return $s.Substring(0, $n)
}

function Hex-U32([string]$raw) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    $t = $raw.Trim()
    try {
        if ($t -match '^0x') { return ('0x' + ([uint32]$t).ToString('X8')) }
        $n = 0
        if ([uint32]::TryParse($t, [ref]$n)) { return ('0x' + $n.ToString('X8')) }
    } catch {}
    return $t
}

try { New-Item -ItemType Directory -Path $Dados -Force | Out-Null } catch {}
try { New-Item -ItemType Directory -Path $DumpDir -Force | Out-Null } catch {}

$os = $null
$mem = [ordered]@{
    freeMB = $null; totalMB = $null; freePct = $null
    commitUsedMB = $null; commitLimitMB = $null; commitPct = $null
}
try {
    $os = Get-CimInstance Win32_OperatingSystem
    if ($os) {
        $tot = [double]$os.TotalVisibleMemorySize
        $free = [double]$os.FreePhysicalMemory
        $vTot = [double]$os.TotalVirtualMemorySize
        $vFree = [double]$os.FreeVirtualMemory
        $mem.totalMB = [int][math]::Round($tot / 1024)
        $mem.freeMB = [int][math]::Round($free / 1024)
        if ($tot -gt 0) { $mem.freePct = [math]::Round(100.0 * $free / $tot, 1) }
        $mem.commitLimitMB = [int][math]::Round($vTot / 1024)
        $mem.commitUsedMB = [int][math]::Round(($vTot - $vFree) / 1024)
        if ($vTot -gt 0) { $mem.commitPct = [math]::Round(100.0 * ($vTot - $vFree) / $vTot, 1) }
    }
} catch {}

$procs = [ordered]@{ node = 0; chrome = 0; chromeWsMB = 0; nodeWsMB = 0; powershell = 0 }
try {
    Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
        $name = [string]$_.ProcessName
        $ws = 0
        try { $ws = [int]($_.WorkingSet64 / 1MB) } catch {}
        if ($name -match '(?i)^chrome') { $procs.chrome++; $procs.chromeWsMB += $ws }
        elseif ($name -match '(?i)^node') { $procs.node++; $procs.nodeWsMB += $ws }
        elseif ($name -match '(?i)^powershell') { $procs.powershell++ }
    }
} catch {}

$crashes = New-Object System.Collections.Generic.List[object]
try {
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000; StartTime = $since } -MaxEvents 40 -ErrorAction SilentlyContinue | ForEach-Object {
        $p = @($_.Properties)
        $app = if ($p.Count -gt 0) { [string]$p[0].Value } else { '' }
        $mod = if ($p.Count -gt 3) { [string]$p[3].Value } else { '' }
        $ex = if ($p.Count -gt 6) { Hex-U32 ([string]$p[6].Value) } else { $null }
        $off = if ($p.Count -gt 7) { [string]$p[7].Value } else { $null }
        $pidHex = if ($p.Count -gt 8) { [string]$p[8].Value } else { $null }
        $appPath = if ($p.Count -gt 10) { [string]$p[10].Value } else { '' }
        $modPath = if ($p.Count -gt 11) { [string]$p[11].Value } else { '' }
        $msg = [string]$_.Message
        if (-not $mod) {
            $m = [regex]::Match($msg, '(?i)m[oó]dulo com falha[:\s]+([^\s\r\n]+)')
            if ($m.Success) { $mod = $m.Groups[1].Value }
        }
        if (-not $app) {
            $m = [regex]::Match($msg, '(?i)aplicativo com falha[:\s]+([^\s\r\n]+)')
            if ($m.Success) { $app = $m.Groups[1].Value }
        }
        $hay = ($app + ' ' + $mod + ' ' + $appPath + ' ' + $modPath + ' ' + $msg)
        if ($hay -notmatch '(?i)node\.exe|chrome\.exe|chrome_elf|conveniente') { return }
        $crashes.Add([pscustomobject]@{
            kind = 'app_error_1000'
            time = $_.TimeCreated.ToString('o')
            app = (Clip-Text $app 80)
            module = (Clip-Text $mod 80)
            exception = $ex
            faultOffset = (Clip-Text $off 24)
            pid = (Clip-Text $pidHex 20)
            appPath = (Clip-Text $appPath 200)
            modulePath = (Clip-Text $modPath 200)
            message = (Clip-Text $msg 360)
        }) | Out-Null
    }
} catch {}

$werEvents = New-Object System.Collections.Generic.List[object]
try {
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1001; StartTime = $since } -MaxEvents 30 -ErrorAction SilentlyContinue | ForEach-Object {
        $msg = [string]$_.Message
        if ($msg -notmatch '(?i)node\.exe|chrome\.exe|PowerShell|conveniente|0xC0000409|0xC00000FD|C0000409|C00000FD') { return }
        $werEvents.Add([pscustomobject]@{
            kind = 'wer_1001'
            time = $_.TimeCreated.ToString('o')
            message = (Clip-Text $msg 500)
        }) | Out-Null
    }
} catch {}

function Read-WerReport([string]$file) {
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    $raw = ''
    try { $raw = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue } catch { return $null }
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    if ($raw -notmatch '(?i)node\.exe|chrome\.exe|chrome_elf|ntdll') { return $null }
    $map = @{}
    foreach ($line in $raw -split "`n") {
        $l = $line.Trim()
        if ($l -match '^(?i)EventType=(.+)$') { $map.EventType = $Matches[1].Trim() }
        if ($l -match '^(?i)Sig\[\d+\]\.Name=(.+)$') { $script:sigName = $Matches[1].Trim() }
        if ($l -match '^(?i)Sig\[\d+\]\.Value=(.+)$') {
            if ($script:sigName) { $map[$script:sigName] = $Matches[1].Trim() }
        }
        if ($l -match '^(?i)P(\d+)=(.+)$') { $map[('P' + $Matches[1])] = $Matches[2].Trim() }
    }
    $app = ''
    foreach ($k in @('Application Name', 'P1', 'AppName')) { if ($map[$k]) { $app = $map[$k]; break } }
    $mod = ''
    foreach ($k in @('Fault Module Name', 'P4', 'P3', 'ModuleName')) { if ($map[$k]) { $mod = $map[$k]; break } }
    $ex = ''
    foreach ($k in @('Exception Code', 'P6', 'ExceptionCode')) { if ($map[$k]) { $ex = $map[$k]; break } }
    return [pscustomobject]@{
        file = (Clip-Text $file 220)
        mtime = (Get-Item -LiteralPath $file).LastWriteTime.ToString('o')
        eventType = (Clip-Text ([string]$map.EventType) 40)
        app = (Clip-Text $app 80)
        module = (Clip-Text $mod 80)
        exception = (Clip-Text $ex 24)
        eventTypeRaw = (Clip-Text ([string]$map.EventType) 40)
    }
}

$werReports = New-Object System.Collections.Generic.List[object]
foreach ($rootWer in @(
    'C:\ProgramData\Microsoft\Windows\WER\ReportArchive',
    'C:\ProgramData\Microsoft\Windows\WER\ReportQueue',
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue')
)) {
    if (-not (Test-Path -LiteralPath $rootWer)) { continue }
    try {
        Get-ChildItem -LiteralPath $rootWer -Recurse -Filter 'Report.wer' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 12 |
            ForEach-Object {
                if ($_.LastWriteTime -lt $since) { return }
                $r = Read-WerReport $_.FullName
                if ($r) { $werReports.Add($r) | Out-Null }
            }
    } catch {}
}

$dumps = @()
try {
    Get-ChildItem -LiteralPath $DumpDir -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 12 |
        ForEach-Object {
            $dumps += [pscustomobject]@{
                name = $_.Name
                mb = [math]::Round($_.Length / 1MB, 2)
                mtime = $_.LastWriteTime.ToString('o')
            }
        }
} catch {}

$exhaust = New-Object System.Collections.Generic.List[object]
try {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 2004; StartTime = $since } -MaxEvents 8 -ErrorAction SilentlyContinue | ForEach-Object {
        $msg = [string]$_.Message
        $exhaust.Add([pscustomobject]@{
            kind = 'resource_exhaustion_2004'
            time = $_.TimeCreated.ToString('o')
            provider = (Clip-Text ([string]$_.ProviderName) 80)
            message = (Clip-Text $msg 500)
        }) | Out-Null
    }
} catch {}

$kernelPower = New-Object System.Collections.Generic.List[object]
try {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41; StartTime = $since } -MaxEvents 4 -ErrorAction SilentlyContinue | ForEach-Object {
        $kernelPower.Add([pscustomobject]@{
            kind = 'kernel_power_41'
            time = $_.TimeCreated.ToString('o')
            message = (Clip-Text ([string]$_.Message) 360)
        }) | Out-Null
    }
} catch {}

$localDumpsKey = $null
try {
    $k = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\node.exe' -ErrorAction SilentlyContinue
    if ($k) {
        $localDumpsKey = [pscustomobject]@{
            armed = $true
            dumpFolder = [string]$k.DumpFolder
            dumpType = [int]$k.DumpType
            dumpCount = [int]$k.DumpCount
        }
    } else {
        $localDumpsKey = [pscustomobject]@{ armed = $false }
    }
} catch {
    $localDumpsKey = [pscustomobject]@{ armed = $false; error = (Clip-Text $_.Exception.Message 120) }
}

$werSvc = $null
try {
    $s = Get-Service -Name WerSvc -ErrorAction SilentlyContinue
    if ($s) { $werSvc = [pscustomobject]@{ status = [string]$s.Status; startType = [string]$s.StartType } }
} catch {}

$boot = $null
$uptimeMin = $null
try {
    if ($os) {
        $boot = $os.LastBootUpTime.ToUniversalTime().ToString('o')
        $uptimeMin = [int](((Get-Date) - $os.LastBootUpTime).TotalMinutes)
    }
} catch {}

$drops = @()
if (-not [string]::IsNullOrWhiteSpace($DropsCsv)) {
    foreach ($part in ($DropsCsv -split ',')) {
        $bits = $part.Trim() -split ':'
        if (-not $bits[0]) { continue }
        $drops += [pscustomobject]@{
            idx = $bits[0]
            code = $(if ($bits.Count -gt 1) { $bits[1] } else { '' })
            pid = $(if ($bits.Count -gt 2) { $bits[2] } else { '' })
        }
    }
}

$topCrash = $null
if ($crashes.Count -gt 0) { $topCrash = $crashes[0] }
elseif ($werReports.Count -gt 0) { $topCrash = $werReports[0] }

$house = 'unknown'
$furniture = $null
$utensil = $null
if ($topCrash) {
    $mod = [string]($topCrash.module)
    $app = [string]($topCrash.app)
    $ex = [string]($topCrash.exception)
    $furniture = $mod
    $utensil = $ex
    if ($mod -match '(?i)chrome') { $house = 'chrome' }
    elseif ($app -match '(?i)chrome') { $house = 'chrome' }
    elseif ($mod -match '(?i)ntdll|kernelbase|ucrtbase') { $house = 'windows-native' }
    elseif ($app -match '(?i)node' -or $mod -match '(?i)node') { $house = 'node-native' }
}
if ($exhaust.Count -gt 0) {
    $house = 'windows-commit'
    if (-not $furniture) { $furniture = 'resource_exhaustion_2004' }
}
elseif ($mem.commitPct -ne $null -and [double]$mem.commitPct -ge 95) {
    if ($house -eq 'unknown') { $house = 'windows-commit' }
    if (-not $furniture) { $furniture = 'commit_alto' }
}
if (-not $furniture -and $DropsCsv -match '3221226505|C0000409') {
    $house = 'windows-native'
    $utensil = '0xC0000409'
    $furniture = 'sem_evento_1000_ainda'
}
if (-not $furniture -and $DropsCsv -match 'C00000FD') {
    $house = 'windows-native'
    $utensil = '0xC00000FD'
    $furniture = 'sem_evento_1000_ainda'
}

$tsMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$dumpNote = 'dumps_unknown'
try {
    if ($localDumpsKey -and $localDumpsKey.armed) { $dumpNote = 'dumps_armed' }
    else { $dumpNote = 'dumps_unarmed_sem_admin' }
} catch { $dumpNote = 'dumps_unknown' }

$rec = @{
    ok = $true
    kind = 'crash_hammer'
    ts = [int64]$tsMs
    iso = (Get-Date).ToUniversalTime().ToString('o')
    hostname = [string]$env:COMPUTERNAME
    reason = [string]$Reason
    drops = @($drops)
    verdict = @{
        house = [string]$house
        furniture = [string]$furniture
        utensil = [string]$utensil
        note = [string]$dumpNote
    }
    mem = @{
        freeMB = $mem.freeMB
        totalMB = $mem.totalMB
        freePct = $mem.freePct
        commitUsedMB = $mem.commitUsedMB
        commitLimitMB = $mem.commitLimitMB
        commitPct = $mem.commitPct
    }
    procs = @{
        node = $procs.node
        chrome = $procs.chrome
        chromeWsMB = $procs.chromeWsMB
        nodeWsMB = $procs.nodeWsMB
        powershell = $procs.powershell
    }
    crashes = As-Array $crashes
    werEvents = As-Array $werEvents
    werReports = As-Array $werReports
    resourceExhaustion = As-Array $exhaust
    kernelPower41 = As-Array $kernelPower
    dumps = @($dumps)
    localDumps = $localDumpsKey
    werSvc = $werSvc
    lastBootUtc = $boot
    uptimeMin = $uptimeMin
}

$json = $null
$jsonErr = ''
try { $json = $rec | ConvertTo-Json -Compress -Depth 6 } catch { $jsonErr = $_.Exception.Message }
if ([string]::IsNullOrWhiteSpace($json)) {
    $json = ('{{"ok":false,"kind":"crash_hammer","reason":"{0}","err":"{1}"}}' -f (Clip-Text $Reason 40), (Clip-Text $(if ($jsonErr) { $jsonErr } else { 'json_empty' }) 200))
}
try { Add-Content -LiteralPath $Jsonl -Value $json -Encoding UTF8 } catch {}
try { Set-Content -LiteralPath $Last -Value $json -Encoding UTF8 } catch {}
Write-Output $json
